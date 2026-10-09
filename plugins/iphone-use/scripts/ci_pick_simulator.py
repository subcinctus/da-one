#!/usr/bin/env python3
"""Choose the iPhone simulator for the CI smoke test (macOS runner; stdlib only).

    xcrun simctl list devices available -j > devices.json
    python3 scripts/ci_pick_simulator.py devices.json >> "$GITHUB_ENV"

Picks an available iPhone on the newest iOS runtime that has one: an already booted iPhone first, then a plain
"iPhone <number>" model, the highest number first. Prints SIM_UDID, SIM_NAME, SIM_RUNTIME and SIM_OS lines
(the $GITHUB_ENV format) on stdout and what it chose on stderr. Exits 1 when no iPhone simulator is available.
"""

import argparse
import json
import re
import sys
from typing import Optional

RUNTIME_RE = re.compile(r"\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$")
MODEL_RE = re.compile(r"iPhone (\d+)")
PLAIN_MODEL_RE = re.compile(r"iPhone \d+")
UDID_RE = re.compile(r"[0-9A-Fa-f-]{8,64}")


class NoSimulator(Exception):
    """No available iPhone simulator was listed."""


def ios_version(runtime) -> Optional[tuple]:
    """(major, minor, patch) of an iOS runtime identifier, or None for other platforms."""
    match = RUNTIME_RE.search(str(runtime))
    if match is None:
        return None
    return tuple(int(part or 0) for part in match.groups())


def _usable_iphone(device) -> bool:
    return (isinstance(device, dict) and device.get("isAvailable", True) is not False
            and str(device.get("name", "")).startswith("iPhone")
            and bool(UDID_RE.fullmatch(str(device.get("udid", "")))))


def _preference(device) -> tuple:
    """Sort key: booted first, then plain "iPhone <n>" models, then the highest model number."""
    name = device["name"]
    model = MODEL_RE.match(name)
    return (device.get("state") != "Booted", not PLAIN_MODEL_RE.fullmatch(name),
            -(int(model.group(1)) if model else 0), name)


def pick(document) -> dict:
    """{udid, name, runtime, os} of the chosen simulator; NoSimulator when there is none."""
    runtimes = document.get("devices") if isinstance(document, dict) else None
    if not isinstance(runtimes, dict):
        raise NoSimulator("The simctl listing has no devices object.")
    best = None
    for runtime, devices in runtimes.items():
        version = ios_version(runtime)
        iphones = [device for device in devices or [] if _usable_iphone(device)] if version else []
        if iphones and (best is None or version > best[0]):
            best = (version, runtime, sorted(iphones, key=_preference)[0])
    if best is None:
        raise NoSimulator("No available iPhone simulator is listed; runtimes: %s."
                          % (", ".join(sorted(runtimes)) or "none"))
    version, runtime, device = best
    shown = "%d.%d" % version[:2] + (".%d" % version[2] if version[2] else "")
    return {"udid": device["udid"], "name": device["name"], "runtime": runtime, "os": shown}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Choose the iPhone simulator for the iPhone Use smoke test.")
    parser.add_argument("listing", help="output of `xcrun simctl list devices available -j`")
    args = parser.parse_args(argv)
    try:
        with open(args.listing, encoding="utf-8") as handle:
            chosen = pick(json.load(handle))
    except (OSError, ValueError, NoSimulator) as exc:
        print("ci_pick_simulator: %s" % exc, file=sys.stderr)
        return 1
    print("Chose %s (iOS %s, %s)." % (chosen["name"], chosen["os"], chosen["udid"]), file=sys.stderr)
    for key in ("udid", "name", "runtime", "os"):
        print("SIM_%s=%s" % (key.upper(), chosen[key]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
