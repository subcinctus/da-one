"""Setting up the iPhone service: diagnostics, discovery, configuration and background jobs.

``SetupManager`` answers the ``iphone_doctor`` and ``iphone_setup`` tools. Long work
(downloading WebDriverAgent, building it, running it on the iPhone) happens in detached
worker processes started from this same file (``wda_setup.py --job-worker STATE JOB TOKEN``).
Each worker leads its own process group and is tracked by a private job file plus a
redacted log under the state directory.

Safety rules kept here:

* only process groups whose leader provably is one of our workers are signalled, and
  only with SIGTERM (stop and recovery);
* a WebDriverAgent folder the user supplied is never modified;
* nothing runs through a shell; every command is an argv list;
* Apple IDs, tokens and passwords are redacted from logs, job errors and messages.

Run ``python3 wda_setup.py doctor`` (or ``status``, ``configure`` ...) in Terminal for
the same results as the tools, printed as one JSON envelope.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import pathlib
import plistlib
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import cmdrunner
import privstate
import usbmux
from errors import ToolError
from privstate import FileLock
from usbmux import UsbmuxError
from wda_client import (DEFAULT_DEVICE_PORT, DEFAULT_MJPEG_PORT, WDAClient, resolve_transport,
                        validate_loopback_url)

# --- pinned WebDriverAgent and job constants ---------------------------------------------------------

WDA_COMMIT = "d17782422d55ff1e5e0ceb74eb1fd509cc0c35b6"
WDA_VERSION = "16.14.0"
WDA_REPOSITORY = "https://github.com/appium/WebDriverAgent.git"
JOB_FORMAT = 2
WORKER_FLAG = "--job-worker"
ACTIVE_STATES = ("queued", "running")
PID_PUBLICATION_GRACE_SECONDS = 5.0
RECOVERY_COOLDOWN_SECONDS = 120.0
STOP_WAIT_SECONDS = 10.0
STATUS_WAIT_MAX = 25.0
KEEP_JOBS = 30
LOG_TAIL_BYTES = 12000
LOG_TAIL_LINES = 35
LOG_ERROR_LINES = 10
WORKER_ENV_KEYS = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "DEVELOPER_DIR", "USER", "LOGNAME",
                   "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy",
                   "no_proxy", "USBMUXD_SOCKET_ADDRESS", "IPHONE_USE_WDA_URL")
UDID_RE = r"[A-Za-z0-9-]{8,64}"
TEAM_RE = r"[A-Z0-9]{10}"
BUNDLE_RE = r"[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}"
MIRRORING_PATTERN = "/iPhone Mirroring.app/Contents/MacOS/iPhone Mirroring"

# The plugin's own WebDriverAgent checkout (never a source_dir the user supplied) gets two small source patches,
# one file each; PATCHES (below the patch functions) lists them.
#
# USB-only screen stream (AM-1): WebDriverAgent's MJPEG server binds every interface unless this one
# line makes it honour USE_IP like the command server.
MJPEG_PATCH_PATH = "WebDriverAgentLib/Routing/FBWebServer.m"
MJPEG_PATCH_ANCHOR = (" " * 33) + "initWithPort:(uint16_t)FBConfiguration.sharedInstance.mjpegServerPort];\n"
MJPEG_PATCH_MARKER = "iphone-use: mjpeg-bind-v2"
MJPEG_PATCH_LINE = ("  self.screenshotsBroadcaster.interface = FBConfiguration.sharedInstance.bindingIPAddress;"
                    " // " + MJPEG_PATCH_MARKER + "\n")
# The same patch removes WebDriverAgent's "any web page may read my answers" headers: web pages open on the
# iPhone itself reach its loopback address, and must not read screenshots, screen text or the session id.
CORS_HEADER_LINES = (
    '  [self.server setDefaultHeader:@"Access-Control-Allow-Origin" value:@"*"];\n',
    '  [self.server setDefaultHeader:@"Access-Control-Allow-Headers" value:@"Content-Type, X-Requested-With"];\n',
)
# The first version of the patch (screen stream only); fetch recognises it as ours and replaces it.
LEGACY_PATCH_LINES = ("  self.screenshotsBroadcaster.interface = FBConfiguration.sharedInstance.bindingIPAddress;"
                      " // iphone-use: mjpeg-bind-v1\n",)
# Browser guard: web pages open on the iPhone reach the command server's loopback address too, by plain
# cross-site requests (which carry an Origin header) or by DNS rebinding (a Host header naming the page's own
# site). The block below, inserted at the end of the header parser, answers such requests with 400 and closes
# the connection. The plugin always sends a loopback Host and never an Origin header.
GUARD_PATCH_PATH = "WebDriverAgentLib/Routing/FBHTTPServer.m"
GUARD_PATCH_ANCHOR = "  return requestHeaders;\n"  # the last line of -parsedHeaderFieldsFromLines:forClient:
GUARD_PATCH_MARKER = "iphone-use: browser-guard-v1"
GUARD_PATCH_BLOCK = (
    "  // " + GUARD_PATCH_MARKER + ". Refuse requests made by web pages (they carry Origin or Sec-Fetch-Site)\n"
    "  // or addressed to a non-loopback Host (DNS rebinding). The plugin talks over USB and sends none of these.\n"
    "  NSString *iphoneUseHost = requestHeaders[@\"host\"].lowercaseString;\n"
    "  BOOL iphoneUseLoopbackHost = nil == iphoneUseHost\n"
    "    || [iphoneUseHost isEqualToString:@\"127.0.0.1\"] || [iphoneUseHost hasPrefix:@\"127.0.0.1:\"]\n"
    "    || [iphoneUseHost isEqualToString:@\"localhost\"] || [iphoneUseHost hasPrefix:@\"localhost:\"]\n"
    "    || [iphoneUseHost isEqualToString:@\"[::1]\"] || [iphoneUseHost hasPrefix:@\"[::1]:\"];\n"
    "  if (nil != requestHeaders[@\"origin\"] || nil != requestHeaders[@\"sec-fetch-site\"] || !iphoneUseLoopbackHost) {\n"
    "    [self respondBadRequestToClient:client];\n"
    "    return nil;\n"
    "  }\n"
)

NETWORK_MODES = ("usb_only", "allow_network")
DEFAULT_COUNTRY = "in"
SERVER_URL_MARKER = "ServerURLHere->"
LOOPBACK_SERVER_MARKER = "ServerURLHere->http://127.0.0.1:"
LOOPBACK_DIAGNOSTIC_SECONDS = 30.0
BUILD_STALL_SECONDS = 60.0
STATUS_POLL_SECONDS = 0.5
STATUS_PROBE_SECONDS = 1.0
STATUS_JOB_COUNT = 6
STOP_POLL_SECONDS = 0.25
SUPERVISE_SECONDS = 0.25
PROBE_INTERVAL_SECONDS = 1.0
PID_WAIT_SECONDS = 3.0
LOG_SCAN_BYTES = 256 * 1024
COMMAND_TIMEOUT = 12.0
CLT_PREFIX = "/Library/Developer/CommandLineTools"

REQUIRED_FIELDS = ("udid", "team_id", "bundle_id")
CONFIGURE_FIELDS = ("udid", "team_id", "bundle_id", "source_dir", "device_port", "mjpeg_port",
                    "app_store_country", "network_mode")
CONFIG_KEYS = CONFIGURE_FIELDS + ("wda_url",)
SETUP_ARGUMENTS = {
    "status": ("job_id", "wait_seconds"),
    "discover": (),
    "configure": CONFIGURE_FIELDS,
    "fetch": (),
    "build": (),
    "start": (),
    "stop": ("job_id",),
}
CLI_ACTIONS = ("doctor", "discover", "status", "fetch", "build", "start", "stop", "configure")

_UDID = re.compile(UDID_RE)
_TEAM = re.compile(TEAM_RE)
_BUNDLE = re.compile(BUNDLE_RE)
_JOB_ID = re.compile(r"[a-f0-9]{32}")
_COUNTRY = re.compile(r"[A-Za-z]{2}")
_ERROR_LINE = re.compile(r"(?i)error:|failed|Error Domain=|\*\* .* FAILED \*\*")
_BUNDLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

# --- user-facing text --------------------------------------------------------------------------------

KEEP_AWAKE_STEP = "Keep the iPhone unlocked and awake while Claude uses it."
WIFI_STEP = ("While the iPhone helper runs, devices on the same Wi-Fi can reach it. Stop it when you are done "
             "(iphone_setup(action=\"stop\")).")
LOOPBACK_STEP = ("The iPhone helper started but the Mac cannot reach it over USB while it is restricted to the "
                 "iPhone. Ask the user before relaxing this. If they agree: iphone_setup(action=\"stop\"), then "
                 "iphone_setup(action=\"configure\", network_mode=\"allow_network\"), then "
                 "iphone_setup(action=\"build\"), then iphone_setup(action=\"start\"). This makes the helper "
                 "reachable from the Wi-Fi network while it runs.")
STALL_STEP = ("The build may be waiting for a macOS dialog (for example \"codesign wants to access key\"): "
              "enter your Mac password and click Always Allow.")
SIGNING_NOTE = ("A free Apple account (Personal Team) can sign only a few development apps (usually 3) and the "
                "signature lasts about 7 days; after that, ask Claude to rebuild the iPhone service. Never delete "
                "other apps to make room unless you decide to.")
INTERRUPTED_MESSAGE = ("The recorded worker no longer exists or cannot be verified. Start a new job; nothing "
                       "unrelated was signalled.")
STOP_NOTE = "Only this plugin's own background jobs were stopped. No apps were uninstalled."
MODIFIED_COPY = "The plugin's own WebDriverAgent copy was modified; it was left untouched."
UNPATCHED_COPY = ("The plugin's own WebDriverAgent copy is missing its safety settings, so it was not used. Download "
                  "it again with iphone_setup(action=\"fetch\"), which adds them.")
OUTDATED_COPY = ("The plugin's own WebDriverAgent copy has an older or incomplete version of its safety settings, so "
                 "it was not used. Download it again with iphone_setup(action=\"fetch\"), which updates them.")
NOT_CONFIGURED = ("iPhone Use is not set up yet: choose the iPhone and signing team with "
                  "iphone_setup(action=\"configure\").")
CONFIGURE_STEP = "Run iphone_doctor to see what is missing, then iphone_setup(action=\"configure\")."
FETCH_STEP = ("Run iphone_setup(action=\"fetch\") and wait for it to finish "
              "(iphone_setup(action=\"status\", wait_seconds=20)).")
BUILD_STEP = ("Run iphone_setup(action=\"build\") and wait until it succeeds "
              "(iphone_setup(action=\"status\", wait_seconds=20)), then start again.")
SOURCE_MISSING = ("The WebDriverAgent source is missing. Run iphone_setup(action=\"fetch\"), or configure "
                  "source_dir to an existing checkout of version 16.14.0.")
SOURCE_WRONG_VERSION = ("The WebDriverAgent source must be the pinned version 16.14.0 (commit "
                        + WDA_COMMIT + "). Existing folders are never changed automatically.")
SOURCE_MODIFIED = ("The WebDriverAgent source has local changes, so it was left untouched. Use "
                   "iphone_setup(action=\"fetch\") for the plugin's own clean copy.")
NEEDS_MACOS = "Building and starting the iPhone service needs macOS with full Xcode."
NEEDS_BUILD = "Build the iPhone service for this configuration first (iphone_setup(action=\"build\"))."
NOT_ON_USB = ("The iPhone is not connected over USB. Connect it with a cable, unlock it and tap Trust, then "
              "try again.")
UNREACHABLE_PORT = ("The Mac cannot reach the iPhone over USB right now. Check the cable, unlock the iPhone, "
                    "then try again.")
CONFIGURE_NEXT = ("Next: iphone_setup(action=\"fetch\") if the WebDriverAgent source is missing, then build, "
                  "then start.")
CONNECT_STEP = ("Connect the iPhone to this Mac with a cable, unlock it and tap Trust (enter the iPhone passcode "
                "if asked). Then open Xcode > Window > Devices and Simulators and wait until it has finished "
                "preparing the iPhone.")
SIGN_IN_STEP = ("Sign in to your Apple account in Xcode > Settings > Accounts (a free account works). You type "
                "the password yourself; never share it with Claude.")
DEVELOPER_MODE_STEP = ("Turn on Developer Mode on the iPhone: Settings > Privacy & Security > Developer Mode > On, "
                       "let it restart, then tap Turn On. If Developer Mode is not listed, open Xcode > Window > "
                       "Devices and Simulators with the iPhone connected and unlocked, wait until 'Preparing "
                       "iPhone' finishes, then look again.")

# --- diagnosis table: (patterns, hint) in priority order; every match is reported, at most 4 ---------

_DIAGNOSES = (
    ((r"not authorized for performing ui testing actions",
      r"\bxctdaemonerror(?:domain)?\b.{0,80}?\bcode\s*=\s*41\b"),
     "iPhone UI automation is not authorized right now, even if the service answers. Run iphone_ready (it can "
     "restart this plugin's own service). If it keeps failing, on the unlocked iPhone check Settings > Privacy & "
     "Security > Developer Mode and Settings > Developer > Enable UI Automation."),
    ((r"requires xcode, but active developer directory", r"\bcommandlinetools\b"),
     "Only the Command Line Tools are selected. Install Xcode from the App Store, open it once, then run "
     "`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` in Terminal."),
    ((r"\bagreed? to the xcode\b", r"\blicense agreements?\b", r"xcodebuild -license"),
     "Open Xcode once and click Agree to accept its license (or run `sudo xcodebuild -license accept` in "
     "Terminal), then try again."),
    ((r"\brunfirstlaunch\b", r"\bfirst launch\b"),
     "Open Xcode once and let it finish installing its components (or run `xcodebuild -runFirstLaunch` in "
     "Terminal), then try again."),
    ((r"first download and install the platform", r"is not installed\. to use with xcode"),
     "Xcode is missing its iOS component. Open Xcode > Settings > Components, click Get next to iOS, wait until "
     "it finishes, then run iphone_setup(action=\"build\") again."),
    ((r"is not supported by this version of xcode", r"\bdeveloper disk image\b", r"\bddi\b",
      r"\bplatform support\b", r"\bfailed to prepare (?:the )?device\b"),
     "The iPhone's iOS is newer than this Xcode supports. Update Xcode from the Mac App Store, open it once, then "
     "build again. If the App Store offers no newer Xcode, this Mac's macOS is too old for the iPhone's iOS; "
     "update macOS first."),
    ((r"\bunable to find a destination matching\b",),
     "Xcode cannot see the iPhone right now. Reconnect the cable, unlock the iPhone, tap Trust if asked, and wait "
     "until Xcode > Window > Devices and Simulators has finished preparing it."),
    ((r"\berrsec", r"\buser interaction is not allowed\b", r"\bcodesign wants to access\b"),
     "A macOS keychain dialog is waiting: enter your Mac password and click Always Allow."),
    ((r"\bmaximum number of apps\b", r"\bthree apps\b", r"\b3 apps\b", r"0xe8008029"),
     "A free Apple account allows only a few development apps on the iPhone (usually 3). You decide whether to "
     "remove one of your own development apps; Claude never deletes apps. A paid Apple Developer account removes "
     "this limit."),
    ((r"\bcannot be registered to your development team\b", r"\bfailed to register bundle identifier\b",
      r"\bbundle identifier\b.{0,120}\bis not available\b"),
     "This helper app ID is already taken. Choose a new one with iphone_setup(action=\"configure\", "
     "bundle_id=\"com.yourname.unique.wda\"), then build again."),
    ((r"\bno profiles?\b", r"\bprovisioning profile\b", r"\brequires a development team\b",
      r"\bsigning certificate\b"),
     "Check signing: your Apple account must be signed in to Xcode > Settings > Accounts, team_id must be your "
     "team, and bundle_id must be unique. Xcode then manages signing automatically; build again."),
    ((r"\bno accounts?\b", r"\bnot (?:logged|signed) in\b", r"\bunable to log ?in\b", r"\bsession has expired\b",
      r"\bauthentication (?:failed|failure|error|required)\b"),
     "Open Xcode > Settings > Accounts and sign in to your Apple account again. You do this yourself; never share "
     "passwords or codes with Claude."),
    ((r"\bexpired\b", r"0xe8008015", r"0xe8008018"),
     "The signing certificate or profile has probably expired (free Apple accounts last about 7 days). Rebuild "
     "with iphone_setup(action=\"build\"), then start the iPhone service again."),
    ((r"\bdeveloper ?mode",),
     "On the iPhone turn on Settings > Privacy & Security > Developer Mode, let it restart and tap Turn On. If it "
     "is not listed, open Xcode > Window > Devices and Simulators with the iPhone connected and wait until it has "
     "finished preparing the iPhone."),
    ((r"\btimed out while enabling automation mode\b", r"\benable ui automation\b"),
     "On the iPhone turn on Settings > Developer > Enable UI Automation, then try again."),
    ((r"\buntrusted\b", r"\binvalid code signature\b", r"0xe800801c", r"\bnot trusted\b"),
     "On the iPhone open Settings > General > VPN & Device Management, tap your Apple Development entry and tap "
     "Trust, then unlock the iPhone and try again."),
    ((r"\bthe request was denied by service delegate\b", r"\bsbmainworkspace\b"),
     "The iPhone is locked or the helper app is not trusted yet. Unlock the iPhone, trust the developer app in "
     "Settings > General > VPN & Device Management, then try again."),
    ((r"\bnot paired\b", r"\btrust this computer\b", r"\bpairing\b"),
     "Reconnect the cable, unlock the iPhone and tap Trust on the 'Trust This Computer?' prompt, then check Xcode "
     "> Window > Devices and Simulators."),
    ((r"\bfailed to start web server on port\b",),
     "Another copy of the iPhone service is already running on the iPhone (port 8100). Reuse it, or stop it from "
     "where it was started."),
    ((r"\bcould not resolve host\b", r"\bunable to access\b", r"\bfailed to connect to github\.com\b"),
     "The Mac could not reach GitHub to download WebDriverAgent. Check the internet connection or proxy, then "
     "fetch again."),
    ((r"\blocked\b", r"\bunlock\b", r"\bpasscode\b"),
     "Unlock the iPhone and keep it awake while the iPhone service starts. Never share the passcode."),
)
_PROBE_REASONS = {
    "not_configured": "iPhone Use is not set up yet; no iPhone is configured.",
    "connection_refused": "The iPhone service is not running (nothing answers on its port).",
    "device_not_found": "The iPhone is not connected over USB, or it has not trusted this Mac yet.",
    "usbmuxd_unavailable": "The Mac's USB device service (usbmuxd) is not reachable.",
}
_DIAGNOSIS_PATTERNS = tuple((tuple(re.compile(p) for p in patterns), hint) for patterns, hint in _DIAGNOSES)
DIAGNOSE_LIMIT = 4

_REDACTIONS = (
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[redacted email]"),
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(?:bearer|basic)\s+\S+"), r"\1[redacted]"),
    (re.compile(r"(?i)((?:password|passwd|authorization|access[_ -]?token|api[_ -]?key|secret)\s*[:=]\s*)"
                r"([^\s,;]+)"), r"\1[redacted]"),
    # Apple Accounts can be phone numbers (e.g. in India): "+91 98765 43210", and the account named by Xcode's
    # sign-in errors ("... with account '...'", "Failed to load credentials for ...") in any spelling.
    (re.compile(r"(?<![\w.+])\+\d[\d ()-]{7,}\d"), "[redacted phone]"),
    (re.compile(r"(?i)(\baccount\s+['\"]|credentials (?:in keychain )?for\s+['\"]?)(?!\[)[^'\"\s,:]+"),
     r"\1[redacted account]"),
    (re.compile(r"https?://[^/\s:@]+:[^/\s@]+@"), "https://[redacted]@"),
)


# --- small pure helpers ------------------------------------------------------------------------------


def redact(text) -> str:
    """Hide e-mail addresses (Apple IDs), credentials and URL passwords in text."""
    if text is None:
        return ""
    value = str(text)
    for pattern, replacement in _REDACTIONS:
        value = pattern.sub(replacement, value)
    return value


def diagnose(text) -> list:
    """Plain-English hints for known Xcode / device problems mentioned in text (at most 4)."""
    lowered = str(text or "").lower()
    hints = []
    for patterns, hint in _DIAGNOSIS_PATTERNS:
        if hint not in hints and any(pattern.search(lowered) for pattern in patterns):
            hints.append(hint)
            if len(hints) >= DIAGNOSE_LIMIT:
                break
    return hints


def _not_pinned_source() -> ToolError:
    return ToolError("prerequisite_missing",
                     "The WebDriverAgent source does not match the pinned version; fetch it again.",
                     details={"next_steps": [FETCH_STEP], "action_executed": False})


def apply_mjpeg_patch(text: str) -> str:
    """Remove the CORS header lines and insert MJPEG_PATCH_LINE right after the anchor line.

    Already patched text is returned unchanged.
    """
    if MJPEG_PATCH_LINE in text:
        return text
    if text.count(MJPEG_PATCH_ANCHOR) != 1 or any(text.count(line) != 1 for line in CORS_HEADER_LINES):
        raise _not_pinned_source()
    for line in CORS_HEADER_LINES:
        text = text.replace(line, "", 1)
    index = text.index(MJPEG_PATCH_ANCHOR) + len(MJPEG_PATCH_ANCHOR)
    return text[:index] + MJPEG_PATCH_LINE + text[index:]


def legacy_mjpeg_patches(text: str) -> list:
    """The committed text with an earlier version of our patch applied (to recognise and replace it)."""
    if text.count(MJPEG_PATCH_ANCHOR) != 1:
        return []
    index = text.index(MJPEG_PATCH_ANCHOR) + len(MJPEG_PATCH_ANCHOR)
    return [text[:index] + line + text[index:] for line in LEGACY_PATCH_LINES]


def apply_guard_patch(text: str) -> str:
    """Insert GUARD_PATCH_BLOCK right before the anchor line. Already patched text is returned unchanged."""
    if GUARD_PATCH_BLOCK in text:
        return text
    if text.count(GUARD_PATCH_ANCHOR) != 1:
        raise _not_pinned_source()
    index = text.index(GUARD_PATCH_ANCHOR)
    return text[:index] + GUARD_PATCH_BLOCK + text[index:]


def legacy_guard_patches(text: str) -> list:
    """Earlier versions of the browser guard: none (browser-guard-v1 is the first)."""
    return []


# (file, function that patches its committed text, marker recorded in the build fingerprint, earlier versions).
SourcePatch = collections.namedtuple("SourcePatch", "path apply marker legacy")
PATCHES = (
    SourcePatch(MJPEG_PATCH_PATH, apply_mjpeg_patch, MJPEG_PATCH_MARKER, legacy_mjpeg_patches),
    SourcePatch(GUARD_PATCH_PATH, apply_guard_patch, GUARD_PATCH_MARKER, legacy_guard_patches),
)
PATCH_PATHS = tuple(patch.path for patch in PATCHES)
PATCH_MARKERS = tuple(patch.marker for patch in PATCHES)


def xcodebuild_argv(config, state_dir, action) -> list:
    """The one xcodebuild command line; only the final action differs between build and start."""
    argv = [
        "xcodebuild",
        "-project", "%s/WebDriverAgent.xcodeproj" % config["source_dir"],
        "-scheme", "WebDriverAgentRunner",
        "-configuration", "Debug",
        "-destination", "id=%s" % config["udid"],
        "-derivedDataPath", "%s/derived_data" % state_dir,
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        "DEVELOPMENT_TEAM=%s" % config["team_id"],
        "CODE_SIGN_STYLE=Automatic",
        "CODE_SIGN_IDENTITY=Apple Development",
        "PRODUCT_BUNDLE_IDENTIFIER=%s" % config["bundle_id"],
        "USE_PORT=%d" % config["device_port"],
        "MJPEG_SERVER_PORT=%d" % config["mjpeg_port"],
    ]
    if config.get("network_mode", "usb_only") == "usb_only":
        argv.append("USE_IP=127.0.0.1")
    argv.append(action)
    return argv


def build_fingerprint(config, patched) -> str:
    """Identity of a build: a change of any of these fields (or of a patch version) needs a new build."""
    data = {
        "udid": config.get("udid"),
        "team_id": config.get("team_id"),
        "bundle_id": config.get("bundle_id"),
        "source_dir": config.get("source_dir"),
        "commit": WDA_COMMIT,
        "patched": list(PATCH_MARKERS) if patched else False,
        "network_mode": config.get("network_mode"),
        "device_port": config.get("device_port"),
        "mjpeg_port": config.get("mjpeg_port"),
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()


def _iso_now() -> str:
    """UTC ISO timestamp from this module's clock (patchable in tests)."""
    return datetime.fromtimestamp(time.time(), timezone.utc).isoformat()


def _age_seconds(text) -> Optional[float]:
    parsed = privstate.parse_iso(text)
    if parsed is None:
        return None
    return time.time() - parsed.timestamp()


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _first_dict(*values) -> dict:
    for value in values:
        if isinstance(value, dict):
            return value
    return {}


def _text_or(value, default):
    return value if isinstance(value, str) and value.strip() else default


def _matches(pattern, value) -> bool:
    return isinstance(value, str) and bool(pattern.fullmatch(value))


def _absolute_path(value) -> Optional[pathlib.Path]:
    """The resolved absolute path for a user-given folder, or None when it is not one."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value) > 4096:
        return None
    try:
        path = pathlib.Path(value.strip()).expanduser()
        return path.resolve() if path.is_absolute() else None
    except (OSError, RuntimeError, ValueError):
        return None


def _normal_udid(udid) -> str:
    return udid.upper().replace("-", "")


def _match_row(udid, rows) -> Optional[dict]:
    """The discover row for udid: exact match first, then case/dash-insensitive."""
    if not isinstance(udid, str) or not udid:
        return None
    for row in rows:
        if row.get("udid") == udid:
            return row
    wanted = _normal_udid(udid)
    for row in rows:
        if isinstance(row.get("udid"), str) and _normal_udid(row["udid"]) == wanted:
            return row
    return None


def _device_row(udid, core_device_id, name, model, ios_version, pairing_state, connection_state, transport,
                developer_mode) -> dict:
    return {"udid": udid, "core_device_id": core_device_id, "name": name, "model": model,
            "ios_version": ios_version, "pairing_state": pairing_state, "connection_state": connection_state,
            "transport": transport, "developer_mode": developer_mode, "usb_attached": False,
            "unlocked": "user_check_required"}


def parse_devices(document) -> list:
    """Physical iPhones/iPads from `devicectl list devices` JSON (current and legacy layouts)."""
    devices = _dict(_dict(document).get("result")).get("devices")
    rows = []
    for item in devices if isinstance(devices, list) else []:
        if not isinstance(item, dict):
            continue
        properties = _dict(item.get("properties"))
        hardware = _first_dict(properties.get("hardware"), item.get("hardwareProperties"))
        state = _first_dict(properties.get("state"), item.get("deviceProperties"))
        connection = _first_dict(properties.get("connection"), item.get("connectionProperties"))
        software = _first_dict(properties.get("software"), item.get("deviceProperties"))
        if hardware.get("reality") != "physical" or hardware.get("deviceType") not in ("iPhone", "iPad"):
            continue
        udid = _text_or(hardware.get("udid"), None) or _text_or(item.get("identifier"), None)
        if udid is None:
            continue
        version = software.get("osVersionNumber")
        if isinstance(version, dict):
            version = version.get("stringValue")
        if isinstance(version, (int, float)) and not isinstance(version, bool):
            version = str(version)
        developer = state.get("developerModeStatus")
        if isinstance(developer, dict):
            developer = "enabled" if "enabled" in developer else ("disabled" if "disabled" in developer else None)
        if developer not in ("enabled", "disabled"):
            developer = "unknown"
        rows.append(_device_row(
            udid=udid,
            core_device_id=_text_or(item.get("identifier"), None),
            name=_text_or(state.get("name"), "iPhone"),
            model=_text_or(hardware.get("marketingName"), None),
            ios_version=_text_or(version, "unknown"),
            pairing_state=_text_or(connection.get("pairingState"), "unknown"),
            connection_state=_text_or(connection.get("state"), None) or _text_or(connection.get("tunnelState"),
                                                                                  "unknown"),
            transport=_text_or(connection.get("transportType"), "unknown"),
            developer_mode=developer,
        ))
    return rows


def parse_xcdevice(text) -> list:
    """Physical iOS devices from `xcrun xcdevice list` (the fallback when devicectl fails)."""
    try:
        items = json.loads(text)
    except (TypeError, ValueError):
        return []
    rows = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or item.get("simulator") or item.get("platform") != "com.apple.platform.iphoneos":
            continue
        udid = _text_or(item.get("identifier"), None)
        if udid is None:
            continue
        available = item.get("available")
        connection_state = "available" if available is True else ("unavailable" if available is False else "unknown")
        rows.append(_device_row(
            udid=udid,
            core_device_id=None,
            name=_text_or(item.get("name"), "iPhone"),
            model=_text_or(item.get("modelName"), None),
            ios_version=_text_or(item.get("operatingSystemVersion"), "unknown"),
            pairing_state="unknown",
            connection_state=connection_state,
            transport=_text_or(item.get("interface"), "unknown"),
            developer_mode="unknown",
        ))
    return rows


def parse_teams(document) -> list:
    """Signing teams found anywhere in Xcode's preferences: [{"team_id", "name", "free"}], deduplicated."""
    found = {}

    def walk(node, depth):
        if depth > 16:
            return
        if isinstance(node, dict):
            team = node.get("teamID")
            if _matches(_TEAM, team):
                entry = found.setdefault(team, {"team_id": team, "name": None, "free": None})
                name = node.get("teamName")
                if entry["name"] is None and isinstance(name, str) and name.strip():
                    entry["name"] = name.strip()
                free = node.get("isFreeProvisioningTeam")
                if entry["free"] is None and isinstance(free, (bool, int)) and free in (0, 1):
                    entry["free"] = bool(free)
            for value in node.values():
                walk(value, depth + 1)
        elif isinstance(node, list):
            for value in node:
                walk(value, depth + 1)

    walk(document, 0)
    return list(found.values())


def _porcelain_entries(text) -> list:
    return [line for line in str(text or "").splitlines() if line.strip()]


def _patched_file_entries(entries) -> Optional[list]:
    """The files of `git status --porcelain` entries when each one is a modified file we patch, else None."""
    paths = []
    for entry in entries:
        if entry[:2] not in (" M", "M ", "MM") or entry[3:] not in PATCH_PATHS:
            return None
        paths.append(entry[3:])
    return paths


def _ps_path() -> str:
    return shutil.which("ps") or "/bin/ps"


def _process_command(pid) -> Optional[str]:
    """The full command line of pid (POSIX ps, same on Linux and macOS), or None."""
    try:
        result = subprocess.run([_ps_path(), "-ww", "-p", str(pid), "-o", "command="], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace",
                                timeout=3, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _group_members() -> Optional[list]:
    """[(pid, pgid, stat)] for every process, or None when ps is unavailable."""
    try:
        result = subprocess.run([_ps_path(), "-ax", "-o", "pid=,pgid=,stat="], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace",
                                timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    members = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            members.append((int(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else ""))
        except ValueError:
            continue
    return members


def _group_alive(pgid) -> bool:
    """True while any non-zombie process is in group pgid (True when ps cannot tell)."""
    members = _group_members()
    if members is None:
        return True
    return any(group == pgid and not state.startswith("Z") for _, group, state in members)


def _write_preserving_mode(path, data: bytes) -> None:
    """Atomically replace a source file, keeping its permission bits."""
    target = pathlib.Path(path)
    try:
        mode = stat.S_IMODE(os.stat(str(target)).st_mode)
    except OSError:
        mode = 0o644
    fd, temp_path = tempfile.mkstemp(dir=str(target.parent), prefix=".iphone-use-")
    try:
        try:
            os.write(fd, data)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)
        os.replace(temp_path, str(target))
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _git_show(source, path) -> Optional[str]:
    """A committed file, read directly (never through a job log relay), strict UTF-8."""
    try:
        shown = subprocess.run(["git", "-C", str(source), "show", "HEAD:" + path],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if shown.returncode != 0:
        return None
    try:
        return shown.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return None


def apply_patches(source) -> None:
    """Apply PATCHES to the committed files of a clean checkout; every file is patched in memory before any is
    written. Used by the fetch job and by scripts/ci_prepare_wda.py, so CI builds exactly what users build.

    Raises RuntimeError when a committed file cannot be read, ToolError when it is not the pinned text.
    """
    patched = []
    for patch in PATCHES:
        shown = _git_show(source, patch.path)
        if shown is None:
            raise RuntimeError("Could not read the pinned WebDriverAgent source; fetch it again.")
        patched.append((patch.path, patch.apply(shown)))
    for path, text in patched:
        _write_preserving_mode(pathlib.Path(source) / path, text.encode("utf-8"))


def _error(code, message, next_steps=None, **details) -> ToolError:
    """A setup ToolError: always carries next_steps and action_executed=False."""
    details.setdefault("next_steps", list(next_steps or []))
    details.setdefault("action_executed", False)
    return ToolError(code, message, details=details)


def _numbered(steps) -> list:
    return ["%d. %s" % (index, step) for index, step in enumerate(steps, 1)]


class _Stopped(Exception):
    """The job was stopped on request (SIGTERM or SIGINT)."""


# --- the manager -------------------------------------------------------------------------------------


class SetupManager:
    """Diagnostics, configuration and background jobs for the on-iPhone service."""

    def __init__(self, state_dir=None, runner=None, platform=None, env=None, python=None):
        self.env = dict(os.environ if env is None else env)
        if state_dir is None:
            state_dir = privstate.state_directory(None, self.env)
        self.state_dir = privstate.prepare_state_dir(state_dir)
        self.jobs_dir = privstate.private_subdir(self.state_dir, "jobs")
        self.logs_dir = privstate.private_subdir(self.state_dir, "logs")
        self.runtime_dir = privstate.private_subdir(self.state_dir, "runtime")
        self.owned_source = self.runtime_dir / "WebDriverAgent"
        self.runner = runner if runner is not None else cmdrunner.run_command
        self.platform = platform or sys.platform
        self.python = python or sys.executable
        self.entrypoint = pathlib.Path(__file__).resolve()
        self._workers = {}
        self._workers_lock = threading.Lock()

    # -- basics --

    @property
    def config(self) -> dict:
        return privstate.read_config(self.state_dir)

    def _lock(self) -> FileLock:
        return FileLock(self.state_dir / ".setup.lock")

    def _which(self, name) -> Optional[str]:
        return shutil.which(name, path=self.env.get("PATH") or os.defpath)

    def _run(self, argv, timeout=COMMAND_TIMEOUT) -> cmdrunner.CommandResult:
        """Run a macOS tool through the injected runner (with this manager's environment); never raises."""
        try:
            result = self.runner(list(argv), timeout=timeout, env=self.env)
        except Exception as exc:  # an injected runner must not break diagnostics
            return cmdrunner.CommandResult(127, "", redact(exc))
        if not isinstance(result, cmdrunner.CommandResult):
            try:
                result = cmdrunner.CommandResult(int(result[0]), str(result[1]), str(result[2]))
            except (TypeError, ValueError, IndexError):
                return cmdrunner.CommandResult(127, "", "invalid runner result")
        return result

    # -- configuration values --

    def _check_field(self, name, value):
        """Validate one configure value and return its stored form (config_invalid otherwise)."""
        if name == "udid":
            if _matches(_UDID, value):
                return value
            message = ("udid must be the iPhone's ID from iphone_setup(action=\"discover\"): 8 to 64 letters, "
                       "digits or dashes.")
        elif name == "team_id":
            if _matches(_TEAM, value):
                return value
            message = "Team IDs are 10 capital letters or digits."
        elif name == "bundle_id":
            if _matches(_BUNDLE, value) and len(value) <= 200:
                return value
            message = ("bundle_id must be a reverse-DNS ID with at least three parts, such as "
                       "com.yourname.helper.wda (letters, digits and dashes; it starts with a letter).")
        elif name == "source_dir":
            path = _absolute_path(value)
            if path is not None:
                return str(path)
            message = "source_dir must be an absolute folder path, for example /Users/you/WebDriverAgent."
        elif name in ("device_port", "mjpeg_port"):
            if isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 65535:
                return value
            message = "%s must be a whole number from 1024 to 65535." % name
        elif name == "app_store_country":
            if _matches(_COUNTRY, value):
                return value.lower()
            message = "app_store_country must be a two-letter country code such as in or us."
        elif name == "network_mode":
            if value in NETWORK_MODES:
                return value
            message = "network_mode must be usb_only or allow_network."
        elif name == "wda_url":
            if value is None or value == "":
                return None
            if isinstance(value, str):
                try:
                    validate_loopback_url(value.strip())
                    return value.strip()
                except ValueError:
                    pass
            message = "wda_url must be http://127.0.0.1:<port> (loopback only)."
        else:
            raise _error("invalid_argument", "configure does not take %s." % name)
        raise _error("config_invalid", message,
                     ["Correct %s, then call iphone_setup(action=\"configure\") again." % name], field=name)

    def _normalized(self, raw) -> dict:
        """Every config field with defaults; invalid or missing values become the default (or None)."""
        raw = _dict(raw)
        config = {
            "udid": raw.get("udid") if _matches(_UDID, raw.get("udid")) else None,
            "team_id": raw.get("team_id") if _matches(_TEAM, raw.get("team_id")) else None,
            "bundle_id": raw.get("bundle_id") if _matches(_BUNDLE, raw.get("bundle_id")) else None,
            "source_dir": str(self.owned_source),
            "device_port": privstate.config_int(raw, "device_port", DEFAULT_DEVICE_PORT),
            "mjpeg_port": privstate.config_int(raw, "mjpeg_port", DEFAULT_MJPEG_PORT),
            "app_store_country": DEFAULT_COUNTRY,
            "network_mode": raw.get("network_mode") if raw.get("network_mode") in NETWORK_MODES else "usb_only",
            "wda_url": None,
        }
        for key in ("source_dir", "app_store_country", "wda_url"):
            if raw.get(key):
                try:
                    config[key] = self._check_field(key, raw[key])
                except ToolError:
                    pass
        return config

    def _is_configured(self, raw) -> bool:
        raw = _dict(raw)
        return (_matches(_UDID, raw.get("udid")) and _matches(_TEAM, raw.get("team_id"))
                and _matches(_BUNDLE, raw.get("bundle_id")))

    @staticmethod
    def _check_ports(config) -> None:
        if config["device_port"] == config["mjpeg_port"]:
            raise _error("config_invalid", "device_port and mjpeg_port must be different.",
                         ["Choose two different ports with iphone_setup(action=\"configure\")."], field="mjpeg_port")

    def _complete_config(self, raw) -> dict:
        """The normalized config, requiring the signing fields and valid values for everything present."""
        raw = _dict(raw)
        if any(raw.get(key) in (None, "") for key in REQUIRED_FIELDS):
            raise _error("prerequisite_missing", NOT_CONFIGURED, [CONFIGURE_STEP])
        config = self._normalized(raw)
        for key in CONFIG_KEYS:
            if key in raw and raw[key] is not None and raw[key] != "":
                config[key] = self._check_field(key, raw[key])
        self._check_ports(config)
        return config

    def _public_config(self, raw) -> dict:
        config = self._normalized(raw)
        result = {key: config[key] for key in ("udid", "team_id", "bundle_id", "device_port", "mjpeg_port",
                                               "app_store_country", "source_dir", "network_mode")}
        if config["wda_url"]:
            result["wda_url"] = config["wda_url"]
        return result

    def _transport(self, raw):
        try:
            return resolve_transport(_dict(raw), self.env)
        except ValueError:
            raise _error("config_invalid", "The WebDriverAgent URL must be http://127.0.0.1:<port> (loopback only).",
                         ["Fix wda_url or IPHONE_USE_WDA_URL, then try again."], field="wda_url") from None

    def _transport_identity(self, raw) -> str:
        try:
            return resolve_transport(_dict(raw), self.env).identity
        except ValueError:
            return "invalid"

    # -- WebDriverAgent source and build marker --

    def _verify_source(self, source_dir, owned=None) -> dict:
        """Check the WebDriverAgent checkout: pinned commit and a clean (or correctly patched) tree.

        Returns {"patched": bool}: False for a clean tree, True when exactly the PATCHES files are modified and
        each one is byte-identical to its patch applied to the committed file. The patched state is accepted
        only for the plugin's own checkout. Raises prerequisite_missing; never modifies anything.
        """
        path = _absolute_path(str(source_dir))
        if path is None:
            raise _error("config_invalid", "source_dir must be an absolute folder path.", [CONFIGURE_STEP],
                         field="source_dir")
        if owned is None:
            owned = path == self.owned_source.resolve()
        if not (path / "WebDriverAgent.xcodeproj" / "project.pbxproj").is_file():
            raise _error("prerequisite_missing", SOURCE_MISSING, [FETCH_STEP])
        head = self._run(["git", "-C", str(path), "rev-parse", "HEAD"])
        if not head.ok or head.stdout.strip() != WDA_COMMIT:
            raise _error("prerequisite_missing", SOURCE_WRONG_VERSION, [FETCH_STEP])
        status = self._run(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"])
        if not status.ok:
            raise _error("prerequisite_missing", "Git could not check the WebDriverAgent source.", [FETCH_STEP])
        entries = _porcelain_entries(status.stdout)
        if not entries:
            return {"patched": False}
        ours = self._our_changes(path, entries) if owned else None
        if ours == dict.fromkeys(PATCH_PATHS, "current"):
            return {"patched": True}
        if ours is not None:  # an earlier version of our patches, or a fetch stopped while patching
            raise _error("prerequisite_missing", OUTDATED_COPY, [FETCH_STEP])
        raise _error("prerequisite_missing", MODIFIED_COPY if owned else SOURCE_MODIFIED, [FETCH_STEP])

    def _our_changes(self, path, entries) -> Optional[dict]:
        """{file: "current" | "older"} when every tracked change is one of our patches on top of HEAD, else None.

        "current" means byte-identical to the patch applied to the committed file, "older" to an earlier
        version of that patch.
        """
        changed = _patched_file_entries(entries)
        if not changed:
            return None
        versions = {}
        for patch in PATCHES:
            if patch.path not in changed:
                continue
            shown = self._run(["git", "-C", str(path), "show", "HEAD:" + patch.path])
            if not shown.ok:
                return None
            try:
                working = (pathlib.Path(path) / patch.path).read_bytes()
                if working == patch.apply(shown.stdout).encode("utf-8"):
                    versions[patch.path] = "current"
                elif working in [text.encode("utf-8") for text in patch.legacy(shown.stdout)]:
                    versions[patch.path] = "older"
                else:
                    return None
            except (ToolError, OSError):
                return None
        return versions

    def _usable_source(self, config) -> dict:
        """_verify_source, plus AM-1: in usb_only mode the plugin's own checkout must carry PATCHES.

        (A fetch interrupted between checkout and patch leaves a clean, pinned, unpatched copy whose screen
        stream would listen on Wi-Fi.) Fetching again applies the patches.
        """
        source = self._verify_source(config["source_dir"])
        if (not source["patched"] and config.get("network_mode", "usb_only") == "usb_only"
                and _absolute_path(config["source_dir"]) == self.owned_source.resolve()):
            raise _error("prerequisite_missing", UNPATCHED_COPY, [FETCH_STEP])
        return source

    def _source_state(self, config) -> dict:
        try:
            return {"ok": True, "patched": self._usable_source(config)["patched"], "error": None}
        except ToolError as exc:
            return {"ok": False, "patched": False, "error": exc.message}
        except Exception as exc:  # e.g. an unreadable folder; reported, never raised
            return {"ok": False, "patched": False, "error": redact(str(exc) or type(exc).__name__)}

    def _build_matches(self, config, patched) -> bool:
        marker = privstate.read_json(self.state_dir / "build.json", {})
        return (isinstance(marker, dict) and marker.get("commit") == WDA_COMMIT
                and marker.get("config_fingerprint") == build_fingerprint(config, patched))

    def _require_build(self, config, patched) -> None:
        if not self._build_matches(config, patched):
            raise _error("prerequisite_missing", NEEDS_BUILD, [BUILD_STEP])

    def _require_platform(self) -> None:
        if self.platform != "darwin" or not self._which("xcodebuild"):
            raise _error("prerequisite_missing", NEEDS_MACOS,
                         ["Use a Mac with Xcode installed from the Mac App Store (open it once), then try again."])

    # -- probes --

    def probe_service(self, config=None, timeout=2.0) -> dict:
        """GET /status over the configured transport (a fresh, short-lived client)."""
        raw = self.config if config is None else config
        result = {"reachable": False, "ready": False, "wda_version": None, "pinned_version": WDA_VERSION,
                  "transport": "none", "error": None}
        try:
            transport = resolve_transport(_dict(raw), self.env)
        except ValueError:
            result["error"] = "The WebDriverAgent URL must be http://127.0.0.1:<port> (loopback only)."
            return result
        result["transport"] = transport.kind
        client = WDAClient(transport, timeout=timeout)
        try:
            reply = client.request("GET", "/status", timeout=timeout)
            value = reply.get("value") if isinstance(reply, dict) else None
            value = _dict(value)
            version = _dict(value.get("build")).get("version")
            result.update(reachable=True, ready=value.get("ready") is True,
                          wda_version=version if isinstance(version, str) else None)
        except ToolError as exc:
            result["reachable"] = exc.code not in ("service_unreachable", "invalid_response", "response_too_large",
                                                   "action_uncertain")
            result["error"] = redact(_PROBE_REASONS.get(exc.details.get("reason"), exc.message))
        except Exception as exc:  # a probe never fails its caller
            result["error"] = redact(str(exc) or type(exc).__name__)
        finally:
            client.close()
        return result

    def port_state(self, config=None, timeout=2.0) -> str:
        """"open" (something listens on the service port), "refused" (nothing does) or "unreachable"."""
        raw = self.config if config is None else config
        try:
            transport = resolve_transport(_dict(raw), self.env)
        except ValueError:
            return "unreachable"
        try:
            sock = transport.open_socket(None, timeout)
        except UsbmuxError as exc:
            return "refused" if exc.reason == "connection_refused" else "unreachable"
        except ConnectionRefusedError:
            return "refused"
        except (OSError, ValueError):
            return "unreachable"
        try:
            sock.close()
        except OSError:
            pass
        return "open"

    def mirroring_running(self) -> bool:
        """True while the macOS iPhone Mirroring app runs (it can hold the iPhone)."""
        if self.platform != "darwin":
            return False
        return self._run(["pgrep", "-f", MIRRORING_PATTERN], timeout=2).ok

    def device_model(self, udid) -> Optional[str]:
        """Marketing model name of the iPhone (for the preview header), or None."""
        try:
            rows, _ = self._discover_devices()
        except Exception:
            return None
        row = _match_row(udid, rows)
        model = row.get("model") if row else None
        return model if isinstance(model, str) and model.strip() else None

    def _teams(self) -> list:
        result = self._run(["defaults", "export", "com.apple.dt.Xcode", "-"], timeout=8)
        if not result.ok or not result.stdout.strip():
            return []
        try:
            document = plistlib.loads(result.stdout.encode("utf-8"))
        except Exception:  # plistlib raises several unrelated types for bad input
            return []
        return parse_teams(document)

    @staticmethod
    def _command_warning(label, result) -> str:
        if result.returncode == 127:
            return "%s is not available; full Xcode is needed." % label
        if result.returncode == 124:
            return "%s timed out." % label
        lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        detail = redact(lines[-1])[:300] if lines else "exit code %d" % result.returncode
        return "%s failed: %s" % (label, detail)

    def _discover_devices(self):
        """(rows, warnings) from devicectl, falling back to xcdevice when it fails or finds nothing."""
        warnings = []
        fd, temp_path = tempfile.mkstemp(prefix="devices-", suffix=".json", dir=str(self.state_dir))
        os.close(fd)
        try:
            probe = self._run(["xcrun", "devicectl", "list", "devices", "--json-output", temp_path,
                               "--timeout", "8"], timeout=12)
            document = privstate.read_json(temp_path, None)
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        rows = parse_devices(document)
        if not probe.ok:
            warnings.append(self._command_warning("Xcode's device list (devicectl)", probe))
        if not probe.ok or not rows:
            fallback = self._run(["xcrun", "xcdevice", "list", "--timeout", "5"], timeout=9)
            if fallback.ok and not rows:
                rows = parse_xcdevice(fallback.stdout)
        unique, seen = [], set()
        for row in rows:
            if row["udid"] not in seen:
                seen.add(row["udid"])
                unique.append(row)
        return unique, warnings

    def _usb_devices(self) -> dict:
        """{"usbmuxd": bool, "attached": [{"udid", "connection_type"}]} straight from usbmuxd."""
        try:
            available = usbmux.daemon_available(self.env)
        except Exception:
            available = False
        attached = []
        if available:
            try:
                devices = usbmux.list_devices(2.0, self.env)
            except (OSError, ValueError):
                return {"usbmuxd": False, "attached": []}
            attached = [{"udid": device["udid"], "connection_type": device.get("connection_type") or None}
                        for device in devices]
        return {"usbmuxd": available, "attached": attached}

    @staticmethod
    def _usb_status(udid, usb) -> dict:
        device = usbmux.find_device(udid, usb["attached"]) if udid else None
        return {"usbmuxd": usb["usbmuxd"], "attached": device is not None,
                "connection_type": device.get("connection_type") if device else None}

    @staticmethod
    def _mark_usb(rows, usb) -> None:
        for row in rows:
            row["usb_attached"] = usbmux.find_device(row["udid"], usb["attached"]) is not None

    def _provisioning(self, udid) -> dict:
        products = self.state_dir / "derived_data" / "Build" / "Products"
        profiles = []
        for profile in products.glob("Debug-iphoneos/*.app/embedded.mobileprovision"):
            try:
                profiles.append((profile.stat().st_mtime, str(profile)))
            except OSError:
                continue
        if not profiles:
            return {"known": False, "note": "Nothing has been built yet, so there is no signing profile to check."}
        newest = max(profiles)[1]
        decoded = self._run(["security", "cms", "-D", "-i", newest], timeout=5)
        try:
            values = plistlib.loads(decoded.stdout.encode("utf-8"))
            expiration = values["ExpirationDate"]
            if expiration.tzinfo is None:
                expiration = expiration.replace(tzinfo=timezone.utc)
        except Exception:
            return {"known": False, "note": "Could not read the built signing profile; check signing in Xcode."}
        devices = values.get("ProvisionedDevices")
        included = None
        if udid and isinstance(devices, list):
            included = any(isinstance(item, str) and _normal_udid(item) == _normal_udid(udid) for item in devices)
        now = datetime.fromtimestamp(time.time(), timezone.utc)
        return {"known": True, "expires_at": expiration.isoformat(), "expired": expiration <= now,
                "device_included": included,
                "note": ("This checks only the profile's expiry date and device list; trusting the developer app "
                         "on the iPhone and the Xcode sign-in are checked by you.")}

    # -- jobs on disk --

    def _job_path(self, job_id) -> pathlib.Path:
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            raise _error("invalid_argument", "job_id must be the 32-character ID returned by a setup job.")
        return self.jobs_dir / (job_id + ".json")

    def _log_path(self, job_id) -> pathlib.Path:
        return self.logs_dir / (job_id + ".log")

    def _read_job(self, job_id) -> Optional[dict]:
        """A job file of ours (format 2, matching id), or None."""
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            return None
        job = privstate.read_json(self.jobs_dir / (job_id + ".json"), None)
        if not isinstance(job, dict) or job.get("format") != JOB_FORMAT or job.get("id") != job_id:
            return None
        return job

    def _jobs(self) -> list:
        """All format-2 jobs, oldest first. Files of other tools are ignored entirely."""
        self._reap_workers()
        jobs = []
        try:
            paths = list(self.jobs_dir.glob("*.json"))
        except OSError:
            paths = []
        for path in paths:
            job = self._read_job(path.stem)
            if job is not None:
                jobs.append(job)

        def order(job):
            parsed = privstate.parse_iso(job.get("created_at"))
            return (parsed.timestamp() if parsed else 0.0, str(job.get("created_at")), job["id"])

        return sorted(jobs, key=order)

    def _reap_workers(self) -> None:
        with self._workers_lock:
            for job_id, process in list(self._workers.items()):
                try:
                    finished = process.poll() is not None
                except OSError:
                    finished = True
                if finished:
                    del self._workers[job_id]

    def _owned(self, job) -> bool:
        """True only when the recorded PID is provably this job's live worker (a group leader with its marker)."""
        if not isinstance(job, dict) or job.get("format") != JOB_FORMAT:
            return False
        pid = job.get("pid")
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
            return False
        token = job.get("owner_token")
        job_id = job.get("id")
        entrypoint = job.get("worker_entrypoint")
        if not isinstance(token, str) or not token or not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            return False
        if (not isinstance(entrypoint, str) or not entrypoint or not os.path.isabs(entrypoint)
                or os.path.basename(entrypoint) != "wda_setup.py"):
            return False
        try:
            if os.getpgid(pid) != pid:
                return False
        except OSError:
            return False
        command = _process_command(pid)
        if not command:
            return False
        marker = " %s %s %s %s %s" % (entrypoint, WORKER_FLAG, self.state_dir, job_id, token)
        return command.endswith(marker) or (marker + " ") in command

    @staticmethod
    def _publishing(job) -> bool:
        """A just-created job whose PID is not written yet (only for the first 5 seconds)."""
        if job.get("state") != "queued" or job.get("pid") is not None:
            return False
        age = _age_seconds(job.get("created_at"))
        return age is not None and 0 <= age <= PID_PUBLICATION_GRACE_SECONDS

    def _effective_state(self, job) -> str:
        state = job.get("state")
        if state in ACTIVE_STATES and not (self._publishing(job) or self._owned(job)):
            return "interrupted"
        return state

    def _states(self, jobs) -> dict:
        return {job["id"]: self._effective_state(job) for job in jobs}

    def _job_matches(self, job, config, identity) -> bool:
        """The job was made for this exact configuration and transport."""
        return (job.get("config_fingerprint") == build_fingerprint(config, job.get("patched"))
                and job.get("transport") == identity)

    def _read_log(self, job_id):
        """(tail text, scan text, mtime) of the job's log; empty when missing."""
        path = self._log_path(job_id)
        try:
            with open(str(path), "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - LOG_SCAN_BYTES))
                data = handle.read()
            mtime = os.stat(str(path)).st_mtime
        except OSError:
            return "", "", None
        tail = data[-LOG_TAIL_BYTES:].decode("utf-8", "replace")
        return tail, data.decode("utf-8", "replace"), mtime

    def _job_status(self, job, state=None, service_ready=None) -> dict:
        """The job as shown to the model: no token, config, target or entrypoint; log tail and hints added."""
        state = state or self._effective_state(job)
        error = job.get("error")
        if state == "interrupted":
            error = INTERRUPTED_MESSAGE
        view = {
            "id": job.get("id"),
            "action": job.get("action"),
            "state": state,
            "phase": job.get("phase"),
            "created_at": job.get("created_at"),
            "started_at": job.get("started_at"),
            "completed_at": job.get("completed_at"),
            "error": redact(error) if error else None,
            "recovery_of": job.get("recovery_of"),
            "service_started_at": job.get("service_started_at"),
        }
        if job.get("source_dir"):
            view["source_dir"] = job["source_dir"]
        tail, scan, mtime = self._read_log(job["id"])
        tail_lines = [redact(line) for line in tail.splitlines()[-LOG_TAIL_LINES:]]
        error_lines = [redact(line) for line in scan.splitlines() if _ERROR_LINE.search(line)][-LOG_ERROR_LINES:]
        stalled = round(max(0.0, time.time() - mtime), 1) if state == "running" and mtime is not None else None
        view["log_path"] = str(self._log_path(job["id"]))
        view["log_tail"] = tail_lines
        view["log_errors"] = error_lines
        view["stalled_seconds"] = stalled
        steps = diagnose("\n".join(tail_lines + error_lines) + "\n" + (view["error"] or ""))
        if job.get("action") == "build" and state == "running" and stalled is not None and stalled > BUILD_STALL_SECONDS:
            steps.append(STALL_STEP)
        if self._loopback_diagnostic(job, state, scan, service_ready):
            steps.append(LOOPBACK_STEP)
        view["next_steps"] = steps
        return view

    @staticmethod
    def _loopback_diagnostic(job, state, log_text, service_ready) -> bool:
        """AM-1 start diagnostic: WDA bound to the iPhone's loopback but the Mac cannot reach it over USB."""
        if state != "running" or service_ready is not False:
            return False
        phase = job.get("phase")
        if not ((job.get("action") == "start" and phase == "launching")
                or (job.get("action") == "recover" and phase == "starting")):
            return False
        if _dict(job.get("config")).get("network_mode", "usb_only") != "usb_only":
            return False
        if LOOPBACK_SERVER_MARKER not in log_text:
            return False
        age = _age_seconds(job.get("started_at"))
        return age is not None and age >= LOOPBACK_DIAGNOSTIC_SECONDS

    def _network(self, jobs, states, config, patched) -> dict:
        """Whether the helper's ports are limited to USB, from the newest active start/recover job or the config."""
        mode, stream_patched = config["network_mode"], patched
        for job in reversed(jobs):
            if job.get("action") in ("start", "recover") and states.get(job["id"]) in ACTIVE_STATES:
                snapshot_mode = _dict(job.get("config")).get("network_mode")
                mode = snapshot_mode if snapshot_mode in NETWORK_MODES else "usb_only"
                stream_patched = bool(job.get("patched"))
                break
        usb_only = mode == "usb_only"
        return {"mode": mode, "control_port": "usb_only" if usb_only else "network",
                "screen_stream": "usb_only" if usb_only and stream_patched else "network"}

    @staticmethod
    def _serving(jobs, states) -> bool:
        return any(job.get("action") in ("start", "recover") and states.get(job["id"]) == "running"
                   and job.get("phase") == "serving" for job in jobs)

    def _owned_active_jobs(self) -> list:
        return [job for job in self._jobs() if job.get("state") in ACTIVE_STATES and self._owned(job)]

    def _prune(self) -> None:
        """Keep the newest KEEP_JOBS job files (and their logs); never delete active jobs."""
        jobs = self._jobs()
        excess = len(jobs) - KEEP_JOBS
        for job in jobs:
            if excess <= 0:
                break
            if job.get("state") in ACTIVE_STATES:
                continue
            for path in (self.jobs_dir / (job["id"] + ".json"), self._log_path(job["id"])):
                try:
                    path.unlink()
                except OSError:
                    pass
            excess -= 1

    def _create_job(self, action, config, patched=None, transport=None, recovery_target=None) -> dict:
        """Write a job file and spawn its detached worker. The caller holds the setup lock."""
        for job in self._jobs():
            if job.get("state") not in ACTIVE_STATES or not self._owned(job):
                continue
            if action == "recover" and recovery_target and job["id"] == recovery_target.get("id"):
                continue
            if action == "start" and job.get("action") == "start":
                return {"already_running": True, "job_id": job["id"], "job": self._job_status(job, job.get("state")),
                        "next_step": self._poll_step(job["id"])}
            raise _error("job_conflict",
                         "A %s job is already running. Check its status or stop it first." % job.get("action"),
                         ['Check it with iphone_setup(action="status", job_id="%s"), or stop it with '
                          'iphone_setup(action="stop", job_id="%s").' % (job["id"], job["id"])],
                         job_id=job["id"])
        job_id = uuid.uuid4().hex
        job = {
            "format": JOB_FORMAT,
            "id": job_id,
            "action": action,
            "state": "queued",
            "phase": "queued" if action == "recover" else None,
            "created_at": _iso_now(),
            "started_at": None,
            "completed_at": None,
            "owner_token": uuid.uuid4().hex,
            "pid": None,
            "worker_entrypoint": str(self.entrypoint),
            "config": dict(config),
            "config_fingerprint": build_fingerprint(config, patched),
            "patched": None if patched is None else bool(patched),
            "transport": transport,
            "service_started_at": None,
            "recovery_of": recovery_target.get("id") if recovery_target else None,
            "recovery_target": dict(recovery_target) if recovery_target else None,
            "source_dir": None,
            "error": None,
        }
        path = self._job_path(job_id)
        privstate.write_json_private(path, job)
        log_fd = os.open(str(self._log_path(job_id)), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            env = {key: self.env[key] for key in WORKER_ENV_KEYS if key in self.env}
            argv = [self.python, str(self.entrypoint), WORKER_FLAG, str(self.state_dir), job_id, job["owner_token"]]
            try:
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, env=env,
                                           cwd=str(self.state_dir), start_new_session=True, close_fds=True)
            except OSError as exc:
                job.update(state="failed", completed_at=_iso_now(),
                           error=redact("The background job could not be started: %s" % exc))
                privstate.write_json_private(path, job)
                raise _error("setup_failed", job["error"], ["Check iphone_doctor, then try again."],
                             job_id=job_id) from None
        finally:
            os.close(log_fd)
        job["pid"] = process.pid
        with self._workers_lock:
            self._workers[job_id] = process
        privstate.write_json_private(path, job)
        self._prune()
        return {"job_id": job_id, "job": self._job_status(job, "queued"), "next_step": self._poll_step(job_id)}

    @staticmethod
    def _poll_step(job_id) -> str:
        return ('Check progress with iphone_setup(action="status", job_id="%s", wait_seconds=20).' % job_id)

    # -- the iphone_setup tool --

    def setup(self, action, **args) -> dict:
        """Dispatch one iphone_setup action after checking its arguments."""
        if action not in SETUP_ARGUMENTS:
            raise _error("invalid_argument",
                         "Unknown setup action. Use status, discover, configure, fetch, build, start or stop.")
        given = {key: value for key, value in args.items() if value is not None}
        extra = sorted(set(given) - set(SETUP_ARGUMENTS[action]))
        if extra:
            raise _error("invalid_argument", "%s does not take %s." % (action, ", ".join(extra)))
        if action == "status":
            return self.status(**given)
        if action == "stop":
            return self.stop(**given)
        if action == "configure":
            return self.configure(**given)
        return getattr(self, action)()

    # -- doctor --

    def doctor(self) -> dict:
        """Read-only check of everything iPhone Use needs, with a numbered list of next steps. Never raises."""
        raw = self.config
        config = self._normalized(raw)
        configured = self._is_configured(raw)
        binaries = {name: self._which(name) for name in ("xcodebuild", "xcrun", "git")}
        xcode = self._run(["xcodebuild", "-version"])
        select = self._run(["xcode-select", "-p"])
        developer_dir = (select.stdout.strip() or None) if select.ok else None
        clt_only = (developer_dir or "").startswith(CLT_PREFIX) or (
            "requires xcode, but active developer directory" in xcode.stderr.lower())
        full_xcode = xcode.ok and not (developer_dir or "").startswith(CLT_PREFIX)
        devices, _ = self._safe(self._discover_devices, ([], [])) if xcode.ok else ([], [])
        usb_devices = self._safe(self._usb_devices, {"usbmuxd": False, "attached": []})
        self._mark_usb(devices, usb_devices)
        teams = self._safe(self._teams, [])
        selected = _match_row(config["udid"], devices) if configured else None
        source = self._source_state(config)
        usb = self._usb_status(config["udid"] if configured else None, usb_devices)
        service = self.probe_service(raw)
        provisioning = self._safe(lambda: self._provisioning(config["udid"]),
                                  {"known": False, "note": "Could not check the signing profile."})
        mirroring = self._safe(self.mirroring_running, False)
        built = configured and source["ok"] and self._build_matches(config, source["patched"])
        profile_valid = bool(provisioning.get("known") and not provisioning.get("expired")
                             and provisioning.get("device_included") is not False)
        jobs = self._safe(self._jobs, [])
        states = self._states([job for job in jobs if job.get("action") in ("start", "recover")])
        network = self._network(jobs, states, config, source["patched"])
        checks = {
            "macos": self.platform == "darwin",
            "full_xcode": full_xcode,
            "git": bool(binaries["git"]),
            "python": sys.version_info >= (3, 9),
            "usbmuxd": bool(usb_devices["usbmuxd"]),
            "configured": configured,
            "device_connected": selected is not None,
            "usb_attached": usb["attached"],
            "paired": bool(selected and selected.get("pairing_state") == "paired"),
            "developer_mode": bool(selected and selected.get("developer_mode") == "enabled"),
            "pinned_source": source["ok"],
            "built": built,
            "profile_valid": profile_valid,
        }
        steps = []
        if not full_xcode:
            text = ("Install Xcode from the Mac App Store, open it once, accept its license and let it install "
                    "its components.")
            if clt_only:
                text += (" Only the Command Line Tools are selected now: run `sudo xcode-select -s "
                         "/Applications/Xcode.app/Contents/Developer` in Terminal.")
            steps.append(text)
        if not teams:
            steps.append(SIGN_IN_STEP)
        if xcode.ok and ((not configured and not devices) or (configured and (selected is None or not checks["paired"]))):
            steps.append(CONNECT_STEP)
        if not configured:
            steps.append("Choose the iPhone and signing team: iphone_setup(action=\"configure\").")
        if configured and selected is not None and not checks["developer_mode"]:
            steps.append(DEVELOPER_MODE_STEP)
        if configured and selected is not None and not service["ready"]:
            steps.append("On the iPhone, turn on Settings > Developer > Enable UI Automation.")
        if not source["ok"]:
            steps.append("Download the iPhone helper (WebDriverAgent): iphone_setup(action=\"fetch\").")
        elif configured and not built:
            steps.append("Build the iPhone helper: iphone_setup(action=\"build\"). The first build can take several "
                         "minutes; if the Mac asks \"codesign wants to access key\", enter the Mac password and click "
                         "Always Allow.")
        if built and not service["ready"]:
            steps.append("Start the iPhone helper: iphone_setup(action=\"start\"), then follow it with "
                         "iphone_setup(action=\"status\", wait_seconds=20).")
        if provisioning.get("known") and provisioning.get("expired"):
            steps.append("The signing profile has expired (free Apple accounts last about 7 days). Rebuild with "
                         "iphone_setup(action=\"build\"), then start the helper again.")
        elif provisioning.get("known") and provisioning.get("device_included") is False:
            steps.append("The signing profile does not include this iPhone. Rebuild with "
                         "iphone_setup(action=\"build\") while the iPhone is connected.")
        if mirroring:
            steps.append("Quit the iPhone Mirroring app on this Mac; it holds the iPhone while it runs.")
        if "network" in (network["control_port"], network["screen_stream"]) and (
                service["ready"] or self._serving(jobs, states)):
            steps.append(WIFI_STEP)
        steps.append(KEEP_AWAKE_STEP)
        return {
            "healthy": all(checks.values()),
            "checks": checks,
            "devices": devices,
            "selected_device": selected,
            "teams": teams,
            "xcode_version": (xcode.stdout.strip() or None) if xcode.ok else None,
            "developer_dir": developer_dir,
            "binaries": binaries,
            "usb": usb,
            "service": service,
            "provisioning": provisioning,
            "source_dir": config["source_dir"],
            "wda_version": WDA_VERSION,
            "wda_commit": WDA_COMMIT,
            "state_dir": str(self.state_dir),
            "mirroring_running": mirroring,
            "network": network,
            "next_steps": _numbered(steps),
            "manual_checks": {"apple_account_signed_in": "user_check_required",
                              "developer_app_trusted": "user_check_required",
                              "phone_unlocked": "user_check_required"},
            "signing_note": SIGNING_NOTE,
        }

    @staticmethod
    def _safe(function, default):
        try:
            return function()
        except Exception:
            return default

    # -- discover and configure --

    def discover(self) -> dict:
        """Connected iPhones (Xcode + usbmuxd view) and the Apple teams signed in to Xcode."""
        devices, warnings = self._discover_devices()
        usb = self._usb_devices()
        self._mark_usb(devices, usb)
        teams = self._teams()
        raw = self.config
        selected = raw.get("udid") if _matches(_UDID, raw.get("udid")) else None
        steps = []
        if not devices:
            steps.append(CONNECT_STEP)
        elif usb["usbmuxd"] and not any(row["usb_attached"] for row in devices):
            steps.append("Xcode sees the iPhone, but not over a USB cable. Connect it with a cable; iPhone Use works "
                         "over USB.")
        if not teams:
            steps.append(SIGN_IN_STEP)
        if devices and selected is None:
            steps.append("Choose the iPhone with iphone_setup(action=\"configure\"); it fills in the only connected "
                         "iPhone and the only signing team automatically.")
        result = {"devices": devices, "selected_udid": selected, "usb": usb, "teams": teams, "next_steps": steps}
        if warnings:
            result["warnings"] = warnings
        return result

    def _auto_udid(self) -> str:
        rows, _ = self._discover_devices()
        if not rows:
            raise _error("prerequisite_missing",
                         "No iPhone is connected: connect it with a cable, unlock it and tap Trust.", [CONNECT_STEP],
                         field="udid")
        self._mark_usb(rows, self._usb_devices())
        candidates = [row for row in rows if row["usb_attached"]] or rows
        if len(candidates) == 1:
            return candidates[0]["udid"]
        raise _error("config_choice_required", "Choose which iPhone to use.",
                     ["Ask the user which iPhone to use, then call iphone_setup(action=\"configure\", "
                      "udid=\"<udid>\")."],
                     field="udid", choices=[{"udid": row["udid"], "name": row["name"], "model": row["model"]}
                                            for row in rows])

    def _auto_team(self) -> str:
        teams = self._teams()
        if len(teams) == 1:
            return teams[0]["team_id"]
        if not teams:
            raise _error("prerequisite_missing", "Sign in to your Apple account in Xcode > Settings > Accounts first.",
                         [SIGN_IN_STEP], field="team_id")
        raise _error("config_choice_required", "Choose which Apple team signs the iPhone helper.",
                     ["Ask the user which team to use (a free Personal Team works), then call "
                      "iphone_setup(action=\"configure\", team_id=\"<team_id>\")."],
                     field="team_id", choices=[dict(team) for team in teams])

    @staticmethod
    def _new_bundle_id() -> str:
        suffix = "".join(secrets.choice(_BUNDLE_ALPHABET) for _ in range(10))
        return "com.iphoneuse.%s.wda" % suffix

    def configure(self, **fields) -> dict:
        """Save the device and signing configuration; omitted values keep the current ones or are filled in."""
        unknown = sorted(set(fields) - set(CONFIG_KEYS))
        if unknown:
            raise _error("invalid_argument", "configure does not take %s." % ", ".join(unknown))
        given = {key: value for key, value in fields.items() if value is not None}
        checked = {key: self._check_field(key, given[key]) for key in CONFIG_KEYS if key in given}
        with self._lock():
            if self._owned_active_jobs():
                raise _error("job_conflict", "Stop the running setup job before changing the configuration.",
                             ['Stop it with iphone_setup(action="stop"), then configure again.'])
            raw = self.config
            current = self._normalized(raw)
            if "source_dir" in checked:
                self._verify_source(checked["source_dir"])
            generated = []
            new = {}
            for key, auto in (("udid", self._auto_udid), ("team_id", self._auto_team),
                              ("bundle_id", self._new_bundle_id)):
                if key in checked:
                    new[key] = checked[key]
                elif current[key]:
                    new[key] = current[key]
                else:
                    new[key] = auto()
                    generated.append(key)
            for key in ("source_dir", "device_port", "mjpeg_port", "app_store_country", "network_mode", "wda_url"):
                new[key] = checked[key] if key in checked else current[key]
            self._check_ports(new)
            document = {"format": 1}
            document.update(new)
            document["updated_at"] = _iso_now()
            changed = [key for key in CONFIG_KEYS if raw.get(key) != new.get(key)]
            privstate.write_json_private(self.state_dir / privstate.CONFIG_NAME, document)
        return {"config": self._public_config(document), "changed": changed, "generated": generated,
                "next_step": CONFIGURE_NEXT}

    # -- fetch, build, start --

    def fetch(self) -> dict:
        """Download the pinned WebDriverAgent into the plugin's own folder (background job)."""
        with self._lock():
            if not self._which("git"):
                raise _error("prerequisite_missing", "Git is missing. Install Xcode (it includes Git), then try again.",
                             ["Install Xcode from the Mac App Store and open it once."])
            raw = self.config
            config = self._normalized(raw)
            return self._create_job("fetch", config, None, self._transport_identity(raw))

    def build(self) -> dict:
        """Build the helper for the configured iPhone and team (background job)."""
        with self._lock():
            raw = self.config
            config = self._complete_config(raw)
            source = self._usable_source(config)
            self._require_platform()
            transport = self._transport(raw)
            return self._create_job("build", config, source["patched"], transport.identity)

    def start(self) -> dict:
        """Start the helper on the iPhone (background job that keeps running while it serves)."""
        with self._lock():
            raw = self.config
            config = self._complete_config(raw)
            source = self._usable_source(config)
            self._require_platform()
            self._require_build(config, source["patched"])
            transport = self._transport(raw)
            if transport.kind == "usbmux":
                self._require_usb(config["udid"])
            port = self.port_state(raw)
            if port == "open":
                service = self.probe_service(raw)
                if service.get("ready"):
                    return {"already_ready": True, "service": service, "note": "The iPhone service is already running.",
                            "next_step": "Run iphone_ready to check that the iPhone can be operated."}
                number = getattr(transport, "port", None) or config["device_port"]
                raise _error("prerequisite_missing",
                             "Something on the iPhone already uses port %d but is not a working iPhone service. Stop "
                             "it from where it was started, or wait a few seconds after a stop." % number,
                             ['Check iphone_setup(action="status"); if this plugin started it, stop it with '
                              'iphone_setup(action="stop").'])
            if port == "unreachable":
                raise _error("prerequisite_missing", UNREACHABLE_PORT,
                             ['Reconnect the iPhone with a cable, unlock it, then run iphone_setup(action="start") '
                              'again.'])
            return self._create_job("start", config, source["patched"], transport.identity)

    def _require_usb(self, udid) -> None:
        if not usbmux.daemon_available(self.env):
            raise _error("prerequisite_missing",
                         "The Mac's USB device service (usbmuxd) is not available. Reconnect the iPhone; restart the "
                         "Mac if this continues.", [CONNECT_STEP])
        try:
            devices = usbmux.list_devices(2.0, self.env)
        except (OSError, ValueError):
            devices = []
        if usbmux.find_device(udid, devices) is None:
            raise _error("prerequisite_missing", NOT_ON_USB, [CONNECT_STEP])

    # -- stop and status --

    def stop(self, job_id=None) -> dict:
        """SIGTERM this plugin's own active jobs (or one of them) and wait up to 10 s for them to exit."""
        if job_id is not None:
            self._job_path(job_id)
            if self._read_job(job_id) is None:
                raise _error("unknown_job", "Unknown job_id.", ['List jobs with iphone_setup(action="status").'])
        signalled, preserved = [], []
        with self._lock():
            jobs = [self._read_job(job_id)] if job_id is not None else self._jobs()
            for job in jobs:
                if job is None or job.get("state") not in ACTIVE_STATES:
                    continue
                if self._owned(job):
                    try:
                        os.killpg(job["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    signalled.append((job["id"], job["pid"]))
                else:
                    preserved.append(job["id"])
        exited = {}
        pending = dict(signalled)
        deadline = time.monotonic() + STOP_WAIT_SECONDS
        while pending:
            self._reap_workers()
            for stopped_id, pid in list(pending.items()):
                if not _group_alive(pid):
                    exited[stopped_id] = True
                    del pending[stopped_id]
            if not pending or time.monotonic() >= deadline:
                break
            time.sleep(STOP_POLL_SECONDS)
        for stopped_id in pending:
            exited[stopped_id] = False
        return {"stopped_jobs": [item[0] for item in signalled], "exited": exited,
                "unverified_jobs_preserved": preserved, "note": STOP_NOTE}

    @staticmethod
    def _check_wait(wait_seconds) -> float:
        if wait_seconds is None:
            return 0.0
        if (isinstance(wait_seconds, bool) or not isinstance(wait_seconds, (int, float))
                or not math.isfinite(wait_seconds) or not 0 <= wait_seconds <= STATUS_WAIT_MAX):
            raise _error("invalid_argument", "wait_seconds must be a number from 0 to 25.")
        return float(wait_seconds)

    def _select_jobs(self, job_id) -> list:
        if job_id is not None:
            job = self._read_job(job_id)
            return [job] if job is not None else []
        return list(reversed(self._jobs()))[:STATUS_JOB_COUNT]

    @staticmethod
    def _signature(jobs, states, service):
        return (tuple((job["id"], states.get(job["id"]), job.get("phase")) for job in jobs),
                bool(service.get("ready")))

    @staticmethod
    def _nothing_to_wait_for(jobs, states, service) -> bool:
        """Every active selected job is a start/recover job already serving a ready service."""
        active = [job for job in jobs if states.get(job["id"]) in ACTIVE_STATES]
        return bool(service.get("ready")) and bool(active) and all(
            job.get("action") in ("start", "recover") and job.get("phase") == "serving" for job in active)

    def status(self, job_id=None, wait_seconds=0) -> dict:
        """Configuration, service, USB and jobs (always an array); waits up to wait_seconds for a change."""
        wait = self._check_wait(wait_seconds)
        if job_id is not None:
            self._job_path(job_id)
            if self._read_job(job_id) is None:
                raise _error("unknown_job", "Unknown job_id.", ['List jobs with iphone_setup(action="status").'])
        started = time.monotonic()
        jobs = self._select_jobs(job_id)
        states = self._states(jobs)
        service = self.probe_service()
        last_probe = time.monotonic()
        signature = self._signature(jobs, states, service)
        while wait > 0:
            if not any(state in ACTIVE_STATES for state in states.values()):
                break
            if self._nothing_to_wait_for(jobs, states, service):
                break
            elapsed = time.monotonic() - started
            if elapsed >= wait:
                break
            time.sleep(min(STATUS_POLL_SECONDS, wait - elapsed))
            jobs = self._select_jobs(job_id)
            states = self._states(jobs)
            if time.monotonic() - last_probe >= STATUS_PROBE_SECONDS:
                service = self.probe_service()
                last_probe = time.monotonic()
            if self._signature(jobs, states, service) != signature:
                break
        waited = time.monotonic() - started
        raw = self.config
        config = self._normalized(raw)
        configured = self._is_configured(raw)
        source = self._source_state(config)
        built = configured and source["ok"] and self._build_matches(config, source["patched"])
        all_jobs = self._jobs()
        service_jobs = [job for job in all_jobs if job.get("action") in ("start", "recover")]
        service_states = dict(states)
        for job in service_jobs:
            if job["id"] not in service_states:
                service_states[job["id"]] = self._effective_state(job)
        network = self._network(service_jobs, service_states, config, source["patched"])
        usb = self._usb_status(config["udid"] if configured else None,
                               self._usb_devices() if configured else {"usbmuxd": self._daemon(), "attached": []})
        steps = []
        if not configured:
            steps.append(CONFIGURE_STEP)
        elif usb["usbmuxd"] and not usb["attached"]:
            steps.append(CONNECT_STEP)
        if "network" in (network["control_port"], network["screen_stream"]) and self._serving(service_jobs,
                                                                                               service_states):
            steps.append(WIFI_STEP)
        # Without the cable the helper cannot be reached at all; that is not a USB-only (loopback) problem.
        service_ready = service.get("ready") if usb["attached"] else None
        return {
            "configured": configured,
            "config": self._public_config(raw),
            "built": built,
            "jobs": [self._job_status(job, states.get(job["id"]), service_ready) for job in jobs],
            "service": service,
            "usb": usb,
            "network": network,
            "next_steps": steps,
            "state_dir": str(self.state_dir),
            "waited_seconds": round(max(0.0, waited), 1),
        }

    def _daemon(self) -> bool:
        try:
            return usbmux.daemon_available(self.env)
        except Exception:
            return False

    # -- recovery (used by iphone_ready) --

    def pending_recovery(self) -> Optional[dict]:
        """The restart this plugin is running for the current configuration, if any. Read-only."""
        try:
            raw = self.config
            config = self._normalized(raw)
            identity = self._transport_identity(raw)
            for job in reversed(self._jobs()):
                if (job.get("action") != "recover" or job.get("state") not in ACTIVE_STATES
                        or job.get("phase") == "serving" or not self._job_matches(job, config, identity)):
                    continue
                if self._publishing(job) or self._owned(job):
                    return {"state": job["state"], "phase": job.get("phase") or "queued", "job_id": job["id"],
                            "recovery_of": job.get("recovery_of")}
        except Exception:
            return None
        return None

    def recover(self) -> dict:
        """Queue one bounded restart of the service this plugin started. Never signals anything itself."""
        try:
            with self._lock():
                raw = self.config
                config = self._complete_config(raw)
                identity = self._transport(raw).identity
                jobs = self._jobs()
                recoveries = [job for job in jobs
                              if job.get("action") == "recover" and self._job_matches(job, config, identity)]
                for job in reversed(recoveries):
                    if (job.get("state") in ACTIVE_STATES and job.get("phase") != "serving"
                            and (self._publishing(job) or self._owned(job))):
                        return {"ok": True, "already_running": True, "job_id": job["id"],
                                "job": self._job_status(job),
                                "recovery": {"state": job["state"], "phase": job.get("phase") or "queued",
                                             "job_id": job["id"], "recovery_of": job.get("recovery_of")},
                                "next_steps": [self._poll_step(job["id"]) + " When its phase is serving, run "
                                               "iphone_ready again. Do not queue another restart."]}
                cooldown = self._cooldown(recoveries)
                if cooldown is not None:
                    return cooldown
                targets = [job for job in jobs
                           if (job.get("action") == "start"
                               or (job.get("action") == "recover" and job.get("phase") == "serving"))
                           and job.get("state") in ACTIVE_STATES and self._job_matches(job, config, identity)
                           and self._owned(job)]
                if len(targets) != 1:
                    return {"ok": False,
                            "error": "The running iPhone service was not started by this plugin, so it was not "
                                     "restarted.",
                            "recovery": {"state": "manual"},
                            "next_steps": ["Restart it from where it was started, or stop it and run "
                                           "iphone_setup(action=\"start\")."]}
                source = self._usable_source(config)
                self._require_build(config, source["patched"])
                self._require_platform()
                target = targets[0]
                snapshot = {key: target.get(key) for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                             "config_fingerprint", "transport")}
                created = self._create_job("recover", config, source["patched"], identity, recovery_target=snapshot)
                job_view = created["job"]
                return {"ok": True, "job_id": created["job_id"], "job": job_view,
                        "recovery": {"state": job_view["state"], "phase": "queued", "job_id": created["job_id"],
                                     "recovery_of": target["id"]},
                        "next_steps": [created["next_step"] + " When its phase is serving, run iphone_ready again."]}
        except ToolError as exc:
            message = redact(exc.message)
        except Exception as exc:  # recovery must report, never crash READY
            message = redact(str(exc) or type(exc).__name__)
        return {"ok": False, "error": message, "recovery": {"state": "manual"},
                "next_steps": diagnose(message) or ["Check iphone_setup(action=\"status\") and fix the reported "
                                                    "problem before restarting."]}

    def _cooldown(self, recoveries) -> Optional[dict]:
        best = None
        for job in recoveries:
            stamps = [privstate.parse_iso(job.get(key)) for key in ("created_at", "service_started_at",
                                                                     "completed_at")]
            stamps = [stamp.timestamp() for stamp in stamps if stamp is not None]
            if not stamps:
                continue
            elapsed = time.time() - max(stamps)
            if 0 <= elapsed < RECOVERY_COOLDOWN_SECONDS and (best is None or elapsed < best[1]):
                best = (job, elapsed)
        if best is None:
            return None
        job, elapsed = best
        return {"ok": False, "error": "A recent restart is still within its 2-minute cooldown.", "job_id": job["id"],
                "recovery": {"state": "cooldown", "job_id": job["id"],
                             "retry_after_seconds": max(1, int(RECOVERY_COOLDOWN_SECONDS - elapsed + 1))},
                "next_steps": ['Look at the last restart with iphone_setup(action="status", job_id="%s"). Unlock the '
                               'iPhone and check Settings > Developer > Enable UI Automation. Do not restart '
                               'repeatedly.' % job["id"]]}

    def _stop_recovery_target(self, job, stop_check=None) -> None:
        """Worker side of recovery: re-validate the target, SIGTERM its group, wait for the port to close."""
        snapshot = _dict(job.get("recovery_target"))
        target = self._read_job(snapshot.get("id"))
        raw = self.config
        current = self._normalized(raw)
        identity = self._transport_identity(raw)
        valid = (
            target is not None
            and (target.get("action") == "start"
                 or (target.get("action") == "recover" and target.get("phase") == "serving"))
            and target.get("state") in ACTIVE_STATES
            and all(target.get(key) == snapshot.get(key) for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                                     "config_fingerprint", "transport"))
            and job.get("transport") == identity
            and self._job_matches(target, current, identity)
            and self._job_matches(job, current, identity)
            and self._owned(target)
        )
        if not valid:
            raise RuntimeError("The service to restart changed or is no longer owned by this plugin; nothing was "
                               "stopped.")
        pid = target["pid"]
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + STOP_WAIT_SECONDS
        alive, port = True, None
        while True:
            if stop_check is not None:
                stop_check()
            alive = _group_alive(pid)
            if not alive:
                port = self.port_state(job.get("config"), timeout=max(0.1, min(2.0, deadline - time.monotonic())))
                if port == "refused":
                    return
            if time.monotonic() >= deadline:
                break
            time.sleep(min(STOP_POLL_SECONDS, max(0.0, deadline - time.monotonic())))
        if alive:
            raise RuntimeError("The iPhone service started by this plugin did not stop within 10 seconds; nothing "
                               "else was stopped.")
        if port == "open":
            raise RuntimeError("The iPhone port is still in use by another service; nothing else was stopped.")
        raise RuntimeError("The Mac could not confirm over USB that the old iPhone service stopped; nothing else was "
                           "stopped.")


# --- the detached worker -----------------------------------------------------------------------------


class _JobWorker:
    """Runs one job in this (detached) process; its stdout/stderr is the job's log file."""

    def __init__(self):
        self.manager = None
        self.path = None
        self.job = None
        self.children = []
        self.threads = []
        self.stopping = False
        self.output_lock = threading.Lock()
        self.server_marker = threading.Event()

    def install_signals(self) -> None:
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

    def _on_signal(self, signum, frame) -> None:
        self.stopping = True
        for child in list(self.children):
            try:
                if child.poll() is None:
                    child.terminate()
            except OSError:
                pass

    # -- output and persistence --

    def log(self, text) -> None:
        line = redact(text)
        with self.output_lock:
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except (OSError, ValueError):
                pass

    def save(self) -> None:
        privstate.write_json_private(self.path, self.job)

    def set_phase(self, phase) -> None:
        self.job["phase"] = phase
        self.save()
        self.log("Phase: " + phase)

    def check_stopping(self) -> None:
        if self.stopping:
            raise _Stopped()

    # -- commands --

    def launch(self, argv, cwd=None):
        """Start a command whose output is relayed (redacted) into the log."""
        self.check_stopping()
        self.log("Running: " + " ".join(argv))
        child = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1)
        self.children.append(child)
        if self.stopping:
            child.terminate()
        thread = threading.Thread(target=self._relay, args=(child,), name="setup-job-log", daemon=True)
        self.threads.append(thread)
        thread.start()
        return child

    def _relay(self, child) -> None:
        try:
            for line in child.stdout:
                text = line.rstrip("\r\n")
                if SERVER_URL_MARKER in text:
                    self.server_marker.set()
                self.log(text)
        except (OSError, ValueError):
            pass
        finally:
            try:
                child.stdout.close()
            except OSError:
                pass

    def run_command(self, argv, cwd=None) -> None:
        child = self.launch(argv, cwd)
        code = child.wait()
        self.check_stopping()
        if code != 0:
            raise RuntimeError("%s exited with code %d; see the log." % (os.path.basename(argv[0]), code))

    def capture(self, argv, timeout=60.0) -> cmdrunner.CommandResult:
        """A short command whose output is read, not logged."""
        self.check_stopping()
        return self.manager._run(argv, timeout=timeout)

    # -- lifecycle --

    def attach(self, manager, path, job) -> None:
        self.manager, self.path, self.job = manager, path, job

    def run(self) -> int:
        self.job.update(state="running", started_at=_iso_now(), error=None)
        self.save()
        self.log("Job %s (%s) started." % (self.job["id"], self.job.get("action")))
        try:
            action = self.job.get("action")
            if action == "fetch":
                self.fetch()
            elif action == "build":
                self.build()
            elif action == "start":
                self.start()
            elif action == "recover":
                self.recover()
            else:
                raise RuntimeError("Unsupported job action.")
            self.job["state"] = "succeeded"
        except _Stopped:
            self.job.update(state="stopped", error="Stopped on request.")
        except ToolError as exc:
            self.fail(exc.message)
        except Exception as exc:
            self.fail(str(exc) or type(exc).__name__)
        finally:
            self.cleanup()
            self.job["completed_at"] = _iso_now()
            self.save()
        self.log("Job finished: %s." % self.job["state"])
        return 0 if self.job["state"] == "succeeded" else 1

    def fail(self, message) -> None:
        self.job.update(state="failed", error=redact(message))
        self.log("Error: " + str(message))

    def cleanup(self) -> None:
        """Stop everything this worker started, including orphans left in its process group."""
        own = os.getpid()
        try:
            leader = os.getpgrp() == own
        except OSError:
            leader = False
        if leader:
            try:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                os.killpg(own, signal.SIGTERM)
            except (OSError, ValueError):
                pass
        for child in self.children:
            try:
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
            except (OSError, subprocess.SubprocessError):
                pass
        if leader:
            for pid, group, _ in _group_members() or []:
                if pid == own or group != own:
                    continue
                try:
                    if os.getpgid(pid) == own:
                        os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        for thread in self.threads:
            thread.join(1.0)

    # -- actions --

    def _snapshot(self) -> dict:
        return self.manager._complete_config(self.job.get("config"))

    def build(self) -> None:
        config = self._snapshot()
        source = self.manager._usable_source(config)
        try:
            (self.manager.state_dir / "build.json").unlink()
        except FileNotFoundError:
            pass
        self.run_command(xcodebuild_argv(config, self.manager.state_dir, "build-for-testing"), cwd=config["source_dir"])
        privstate.write_json_private(self.manager.state_dir / "build.json", {
            "config_fingerprint": build_fingerprint(config, source["patched"]),
            "commit": WDA_COMMIT,
            "built_at": _iso_now(),
        })
        self.log("Build finished; the iPhone service can be started.")

    def start(self) -> None:
        config = self._snapshot()
        source = self.manager._usable_source(config)
        self.manager._require_build(config, source["patched"])
        self.set_phase("launching")
        self.serve(config)

    def recover(self) -> None:
        config = self._snapshot()
        source = self.manager._usable_source(config)
        self.manager._require_build(config, source["patched"])
        self.set_phase("stopping")
        self.manager._stop_recovery_target(self.job, stop_check=self.check_stopping)
        self.set_phase("starting")
        self.serve(config)

    def serve(self, config) -> None:
        """Run xcodebuild test-without-building and mark the job serving once /status is ready."""
        child = self.launch(xcodebuild_argv(config, self.manager.state_dir, "test-without-building"),
                            cwd=config["source_dir"])
        next_probe = 0.0
        while not self.stopping and child.poll() is None:
            if self.job.get("phase") != "serving" and (time.monotonic() >= next_probe or self.server_marker.is_set()):
                self.server_marker.clear()
                probe = self.manager.probe_service(config, timeout=2.0)
                if probe.get("ready"):
                    self.job["service_started_at"] = _iso_now()
                    self.set_phase("serving")
                next_probe = time.monotonic() + PROBE_INTERVAL_SECONDS
            time.sleep(SUPERVISE_SECONDS)
        self.check_stopping()
        raise RuntimeError("The iPhone service stopped; see the log and start again.")

    def fetch(self) -> None:
        """Get the pinned WebDriverAgent into <state>/runtime/WebDriverAgent and apply PATCHES."""
        source = self.manager.owned_source
        src = str(source)
        if not source.exists() and not source.is_symlink():
            source.mkdir(mode=0o700)
            self.run_command(["git", "init", src])
            self.run_command(["git", "-C", src, "remote", "add", "origin", WDA_REPOSITORY])
        elif source.is_symlink() or not source.is_dir():
            raise RuntimeError(MODIFIED_COPY)
        head = self.capture(["git", "-C", src, "rev-parse", "HEAD"])
        if head.ok and head.stdout.strip() == WDA_COMMIT:
            state = self._verified(src)
            if state is not None:
                if not state["patched"]:
                    self.patch(source)
                self._require_patched(src)
                self.job["source_dir"] = src
                self.log("WebDriverAgent %s is ready in %s." % (WDA_VERSION, src))
                return
        entries = self._tracked_changes(src)
        ours = self.manager._our_changes(src, entries) if entries else None
        if ours:
            # Only our patches (this or an earlier version, or some of them when a fetch stopped while patching):
            # restore those files so the checkout below can proceed, then patch the result again.
            self.run_command(["git", "-C", src, "checkout", "--"] + list(ours))
            entries = self._tracked_changes(src)
        origin = self.capture(["git", "-C", src, "remote", "get-url", "origin"])
        if entries is None or entries or not origin.ok or origin.stdout.strip() != WDA_REPOSITORY:
            raise RuntimeError(MODIFIED_COPY)
        self.run_command(["git", "-C", src, "fetch", "--depth", "1", "origin", WDA_COMMIT])
        self.run_command(["git", "-C", src, "checkout", "--detach", "FETCH_HEAD"])
        state = self.manager._verify_source(src, owned=True)
        if not state["patched"]:
            self.patch(source)
        self._require_patched(src)
        self.job["source_dir"] = src
        self.log("WebDriverAgent %s is ready in %s." % (WDA_VERSION, src))

    def _tracked_changes(self, src) -> Optional[list]:
        status = self.capture(["git", "-C", src, "status", "--porcelain", "--untracked-files=no"])
        return _porcelain_entries(status.stdout) if status.ok else None

    def _verified(self, src) -> Optional[dict]:
        try:
            return self.manager._verify_source(src, owned=True)
        except ToolError:
            return None

    def _require_patched(self, src) -> None:
        if not self.manager._verify_source(src, owned=True)["patched"]:
            raise RuntimeError("The safety patches could not be applied to WebDriverAgent; fetch it again.")

    def patch(self, source) -> None:
        """Apply PATCHES to the clean checkout (apply_patches) and say so in the log."""
        apply_patches(source)
        self.log("Applied the safety settings (screen stream on USB only, no cross-origin access, no requests from "
                 "web pages) to " + " and ".join(PATCH_PATHS) + ".")


def worker_main(state_dir, job_id, token) -> int:
    """Entry point of a detached job worker (wda_setup.py --job-worker STATE JOB TOKEN)."""
    os.umask(0o077)
    worker = _JobWorker()
    try:
        worker.install_signals()
    except ValueError:
        pass
    if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id) or not isinstance(token, str) or not token:
        return 1
    try:
        manager = SetupManager(state_dir)
    except Exception:
        return 1
    path = manager.jobs_dir / (job_id + ".json")
    deadline = time.monotonic() + PID_WAIT_SECONDS
    job = None
    while True:
        data = privstate.read_json(path, None)
        if isinstance(data, dict) and data.get("pid") == os.getpid():
            job = data
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(0.01)
    if (job is None or job.get("format") != JOB_FORMAT or job.get("id") != job_id
            or job.get("owner_token") != token or job.get("state") != "queued"):
        return 1
    worker.attach(manager, path, job)
    return worker.run()


# --- command line ------------------------------------------------------------------------------------


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _UsageError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="wda_setup.py", description="Set up and check the iPhone Use helper (WebDriverAgent).")
    parser.add_argument("--state-dir", help="private state folder (default ~/.local/share/iphone-use)")
    parser.add_argument("action", choices=CLI_ACTIONS)
    parser.add_argument("--udid")
    parser.add_argument("--team-id")
    parser.add_argument("--bundle-id")
    parser.add_argument("--source-dir")
    parser.add_argument("--device-port", type=int)
    parser.add_argument("--mjpeg-port", type=int)
    parser.add_argument("--country", dest="app_store_country")
    parser.add_argument("--wda-url")
    parser.add_argument("--network-mode", choices=NETWORK_MODES)
    parser.add_argument("--job-id")
    parser.add_argument("--wait", dest="wait_seconds", type=float)
    return parser


def _cli_result(args) -> dict:
    manager = SetupManager(privstate.state_directory(args.state_dir, os.environ))
    fields = {key: getattr(args, key) for key in ("udid", "team_id", "bundle_id", "source_dir", "device_port",
                                                  "mjpeg_port", "app_store_country", "wda_url", "network_mode",
                                                  "job_id", "wait_seconds")
              if getattr(args, key) is not None}
    if args.action == "doctor":
        if fields:
            raise _error("invalid_argument", "doctor does not take %s." % ", ".join(sorted(fields)))
        return manager.doctor()
    if args.action == "configure":
        extra = sorted(set(fields) - set(CONFIG_KEYS))
        if extra:
            raise _error("invalid_argument", "configure does not take %s." % ", ".join(extra))
        return manager.configure(**fields)
    return manager.setup(args.action, **fields)


def main(argv=None) -> int:
    """CLI: print one JSON envelope; exit 0 iff ok. The hidden --job-worker form runs a job."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == [WORKER_FLAG]:
        if len(argv) != 4:
            return 2
        return worker_main(argv[1], argv[2], argv[3])
    try:
        args = _parser().parse_args(argv)
    except _UsageError as exc:
        envelope = {"ok": False, "error": {"code": "invalid_argument", "message": str(exc), "uncertain": False,
                                           "action_executed": False}}
        print(json.dumps(envelope, ensure_ascii=False, indent=2))
        return 2
    try:
        envelope = {"ok": True}
        envelope.update(_cli_result(args))
    except ToolError as exc:
        envelope = {"ok": False, "error": exc.as_dict()}
    except Exception as exc:
        envelope = {"ok": False, "error": {"code": "internal_error",
                                           "message": "The setup tool failed unexpectedly (%s)." % type(exc).__name__,
                                           "uncertain": False}}
    print(json.dumps(envelope, ensure_ascii=False, indent=2))
    return 0 if envelope.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
