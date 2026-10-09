"""Runtime: wires every iPhone Use component together and runs one tool call at a time.

`Runtime.execute(name, args)` is the single entry point used by the MCP server and the
command-line fallback. It validates the arguments once (before any device I/O), takes the
cross-process `operation.lock` for phone operations, shares the WDA session with other
processes through `session.json`, records every phone action in `actions.json` so another
process's text continuation ends, checks that the phone is unlocked before any mutation,
and turns every outcome into the result envelope (`{"ok": true, ...}` or
`{"ok": false, "error": {...}}`).

It also implements `iphone_ready` (the readiness probe and its bounded recovery),
`iphone_screen` (the live preview page), the preview toolbar actions and the metrics.
"""

import base64
import binascii
import collections
import http.client
import json
import math
import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import mcp_schemas
import privstate
import wda_image
from errors import ToolError
from screen_hub import ScreenHub, open_mjpeg_socket
from viewer_server import DEFAULT_PREVIEW_PORT, PreviewManager, copy_png_to_clipboard, open_in_browser
from wda_apps import AppCatalog
from wda_client import SID_RE, WDA_URL_ENV, UnconfiguredTransport, WDAClient, resolve_transport, \
    validate_loopback_url
from wda_controller import PhoneController
from wda_setup import SetupManager

VIEWER_DIR = Path(__file__).resolve().parents[1] / "viewer"
SETTLE_SECONDS = 0.8
LOCKED_OPS = {"ready", "observe", "find", "wait", "tap", "swipe", "type_text", "press_button", "launch_app",
              "batch", "scroll_find", "collect_list"}
MUTATING_OPS = {"tap", "swipe", "type_text", "launch_app", "press_button", "batch", "scroll_find", "collect_list"}
READ_OPS = {"doctor", "observe", "find", "wait", "metrics", "apps"}
READY_PENDING_CODES = {"service_unreachable", "not_ready", "invalid session id", "foreground_unavailable",
                       "stale element reference", "unknown error", "invalid argument"}
SETUP_RESET_ACTIONS = ("start", "stop", "configure")

SESSION_FILE = "session.json"
ACTIONS_FILE = "actions.json"
DEVICE_FILE = "device.json"
OPERATION_LOCK = "operation.lock"
STATUS_TIMEOUT = 5.0
PROBE_TIMEOUT = 2.0
TOOLBAR_TIMEOUT = 8.0
RECORD_LIMIT = 500
MODEL_LIMIT = 60
THREAD_JOIN_SECONDS = 0.5
REMOTE_STATE_TIMEOUT = 0.5
REMOTE_STATE_BYTES = 64 * 1024

# Environment knobs (DESIGN.md section 3): name -> (default, low, high, integer)
KNOBS = {
    "IPHONE_USE_SETTLE_SECONDS": (SETTLE_SECONDS, 0.0, 2.0, False),
    "IPHONE_USE_CALL_BUDGET_SECONDS": (60.0, 5.0, 90.0, False),
    "IPHONE_USE_TYPING_FREQUENCY": (30, 5, 120, True),
    "IPHONE_USE_KEEP_SCREENSHOTS": (40, 5, 200, True),
    "IPHONE_USE_JPEG_QUALITY": (80, 40, 95, True),
}
IMAGE_ENV = "IPHONE_USE_IMAGE"
PREVIEW_PORT_ENV = "IPHONE_USE_PREVIEW_PORT"
NO_BROWSER_ENV = "IPHONE_USE_NO_BROWSER"

# --- model-facing texts ------------------------------------------------------------------------------

BUSY_MESSAGE = ("Another iPhone Use step is running (perhaps in another Claude Code window). Wait for it to finish; "
                "nothing was done.")
LOCKED_MESSAGE = ("The iPhone is locked. Ask the user to unlock it, then look at the screen again; nothing was "
                  "done.")
READY_LOCKED_MESSAGE = ("The iPhone is locked. Ask the user to unlock it and keep it awake, then run iphone_ready "
                        "again.")
NOT_READY_MESSAGE = "The iPhone service is not accepting commands yet."
MIRRORING_MESSAGE = ("iPhone Mirroring on this Mac is holding the iPhone and the screen is empty. Ask the user to "
                     "quit iPhone Mirroring (and unlock the iPhone if needed), then run iphone_ready again.")
CHANNEL_STEP = ("The iPhone automation channel needs a refresh: run iphone_ready, then continue from what the screen "
                "shows. Do not repeat the failed action blindly.")
SETUP_STEP = ("The iPhone service is not running yet: this is a setup step, not a failed task. Check "
              "iphone_setup(action=\"status\"), reuse a running job or start once, then run iphone_ready again. "
              "Respect any instruction not to start or restart.")
RECOVERING_MESSAGE = ("The iPhone service is restarting in the background. Poll the setup job; when it reports "
                      "phase=serving, run iphone_ready again. Do not repeat the failed action.")
RECOVERY_DISABLED_MESSAGE = ("The iPhone automation channel needs a restart, but this call disabled restarts "
                             "(recover=false). Nothing was restarted.")
RECOVERY_PERMISSION_NOTE = "Respect any user instruction that forbids restarts."
NOT_STARTED_DEFAULT = "the running service could not be proven to belong to this plugin."
UNKNOWN_TOOL_MESSAGE = "Unknown iPhone tool."
ARGUMENTS_MESSAGE = "Tool arguments must be a JSON object."
INTERNAL_MESSAGE = ("The iPhone tool failed unexpectedly. Check iphone_setup(action=\"status\") before "
                    "continuing.")
HANDLER_ARGUMENT_MESSAGE = "The iPhone tool could not use these arguments; nothing more was done."
PARTIAL_VERIFICATION = ("At least one phone action was accepted before the error. Look at the current screen; do "
                        "not automatically repeat the operation.")
CONFIG_URL_MESSAGE = ("The iPhone service address must be http://127.0.0.1:<port> (loopback only), so nothing was "
                      "sent.")
CONFIG_URL_STEP = ("Fix the iPhone service address (the --url option, IPHONE_USE_WDA_URL or wda_url in the saved "
                   "configuration), then run iphone_ready again.")
PREVIEW_NOTE = "The live preview runs inside Claude Code; open it from there."
PREVIEW_PAUSED_MESSAGE = ("The preview is paused while the user signs in on the iPhone; nothing was done.")
TOOLBAR_BUSY_MESSAGE = "The iPhone is busy with another step. Try again in a moment; nothing was sent."
TOOLBAR_UNKNOWN_MESSAGE = "Unknown preview action."
SCREENSHOT_DECODE_MESSAGE = "The iPhone screenshot could not be decoded."
SCREENSHOT_PNG_MESSAGE = "The iPhone screenshot is not a PNG image."


def _knob(env, name, default, low, high, integer=False):
    """An environment number inside [low, high]; anything else keeps the default."""
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip()) if integer else float(str(raw).strip())
    except ValueError:
        return default
    if not math.isfinite(value) or not low <= value <= high:
        return default
    return value


def preview_port(env) -> int:
    """IPHONE_USE_PREVIEW_PORT: 0 (ephemeral) or 1024..65535; otherwise the default 18200."""
    raw = env.get(PREVIEW_PORT_ENV)
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_PREVIEW_PORT
    return value if value == 0 or 1024 <= value <= 65535 else DEFAULT_PREVIEW_PORT


def _safe(function, *args, **kwargs):
    """Run a telemetry/preview call; its failure must never change a phone operation."""
    try:
        return function(*args, **kwargs)
    except Exception:  # noqa: BLE001 - display state never breaks tools
        return None


def _stderr_failure(exc):
    try:
        sys.stderr.write("iphone-use tool failure: %s\n" % type(exc).__name__)
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


class Runtime:
    """One process's iPhone Use components plus the rules around every tool call."""

    def __init__(self, state_dir=None, wda_url=None, env=None, runner=None, serve_preview=True):
        self.env = dict(os.environ if env is None else env)
        self.runner = runner
        self.platform = sys.platform
        self._url_invalid = False
        if wda_url:
            # Every consumer (WDA client, preview stream, setup probes, workers) resolves the same
            # endpoint from the environment. An invalid explicit URL stays in it so all of them fail
            # closed instead of silently reaching another address.
            try:
                validate_loopback_url(wda_url)
            except ValueError:
                self._url_invalid = True
            self.env[WDA_URL_ENV] = wda_url
        self.state_dir = privstate.prepare_state_dir(privstate.state_directory(state_dir, self.env))
        self._closed = False
        self._records_lock = threading.Lock()
        self._tool_records = collections.deque(maxlen=RECORD_LIMIT)
        self._responses = collections.deque(maxlen=RECORD_LIMIT)
        self._threads = []
        self._lookup_lock = threading.Lock()
        self._looked_up = set()
        self._instance_id = os.urandom(8).hex()
        self._actions_seen = None
        self._config_error = False
        self.transport = self._resolve_transport()
        self.client = WDAClient(self.transport)
        env_for_stream = self.env
        state_for_stream = self.state_dir
        self.screen = ScreenHub(self.state_dir,
                                opener=lambda: open_mjpeg_socket(privstate.read_config(state_for_stream),
                                                                 env_for_stream))
        self.phone = PhoneController(self.client, self.state_dir, self.screen, runner)
        self._apply_knobs()
        self.setup = SetupManager(self.state_dir, runner=runner, env=self.env)
        self.apps = AppCatalog(self.state_dir, runner=runner)
        self.preview = PreviewManager(self.state_dir, self.screen, VIEWER_DIR, self.toolbar_action,
                                      preview_port(self.env), allow_start=serve_preview)

    # --- construction helpers -----------------------------------------------------------------------

    def _resolve_transport(self):
        """The configured transport; a bad URL gives UnconfiguredTransport plus a remembered config error."""
        try:
            transport = resolve_transport(privstate.read_config(self.state_dir), self.env)
        except ValueError:
            self._config_error = True
            return UnconfiguredTransport()
        self._config_error = self._url_invalid
        return transport

    def _apply_knobs(self):
        phone = self.phone
        values = {name: _knob(self.env, name, *spec) for name, spec in KNOBS.items()}
        phone.settle_seconds = float(values["IPHONE_USE_SETTLE_SECONDS"])
        phone.call_budget = float(values["IPHONE_USE_CALL_BUDGET_SECONDS"])
        phone.typing_frequency = int(values["IPHONE_USE_TYPING_FREQUENCY"])
        phone.keep_artifacts = int(values["IPHONE_USE_KEEP_SCREENSHOTS"])
        phone.jpeg_quality = int(values["IPHONE_USE_JPEG_QUALITY"])
        phone.image_original = str(self.env.get(IMAGE_ENV, "")).strip() == "original"

    def _config_failure(self):
        return ToolError("config_invalid", CONFIG_URL_MESSAGE,
                         details={"action_executed": False, "ready": False, "field": "wda_url",
                                  "next_steps": [CONFIG_URL_STEP]})

    def _spawn(self, function):
        """Run function in a daemon thread (tests may replace this method)."""
        def run():
            try:
                function()
            except Exception:  # noqa: BLE001 - background helpers never surface errors
                pass

        thread = threading.Thread(target=run, name="iphone-use-helper", daemon=True)
        self._threads = [item for item in self._threads if item.is_alive()]
        self._threads.append(thread)
        thread.start()
        return thread

    # --- the public entry points ----------------------------------------------------------------------

    def execute(self, name, args) -> dict:
        """The result envelope of one tool call; never raises."""
        try:
            result = self.call(name, args)
        except ToolError as exc:
            return {"ok": False, "error": exc.as_dict()}
        except Exception as exc:  # noqa: BLE001 - the envelope must always be produced
            _stderr_failure(exc)
            return {"ok": False, "error": {"code": "internal_error", "message": INTERNAL_MESSAGE, "uncertain": True}}
        if not isinstance(result, dict):
            result = {"result": result}
        ok = not (name == "iphone_batch" and isinstance(result.get("error"), dict))
        envelope = {"ok": ok}
        envelope.update((key, value) for key, value in result.items() if key != "ok")
        return envelope

    def call(self, name, args) -> dict:
        """The raw result of one tool call (no "ok" key); raises ToolError."""
        started = time.monotonic()
        error_code = None
        tool = name if isinstance(name, str) else "unknown"
        try:
            return self._dispatch(name, args)
        except ToolError as exc:
            error_code = exc.code
            if mcp_schemas.op_name(tool) in READ_OPS:
                exc.details.setdefault("action_executed", False)
            raise
        except Exception:
            error_code = "internal_error"
            raise
        finally:
            record = {"tool": tool if tool in mcp_schemas.SCHEMAS else "unknown",
                      "seconds": round(time.monotonic() - started, 4), "error": error_code}
            with self._records_lock:
                self._tool_records.append(record)

    def _dispatch(self, name, args):
        if not isinstance(name, str) or name not in mcp_schemas.SCHEMAS:
            raise ToolError("unknown_tool", UNKNOWN_TOOL_MESSAGE, details={"action_executed": False})
        if not isinstance(args, dict):
            raise ToolError("invalid_argument", ARGUMENTS_MESSAGE,
                            details={"action_executed": False, "argument_path": "arguments"})
        mcp_schemas.check_arguments(name, args)
        op = mcp_schemas.op_name(name)
        if op == "screen":
            return self.screen_tool(**args)
        if op == "doctor":
            return self.setup.doctor()
        if op == "setup":
            return self._setup(args)
        if op == "apps":
            return self.apps.lookup(**args)
        if op == "metrics":
            return self.metrics(**args)
        return self._locked(op, args)

    # --- setup ----------------------------------------------------------------------------------------

    def _setup(self, args):
        result = self.setup.setup(**args)
        if args.get("action") in SETUP_RESET_ACTIONS:
            self._reset_session()
            if args.get("action") == "configure":
                self._refresh_transport()
        return result

    def _refresh_transport(self):
        """Follow config.json, which this or another process (window, CLI, Terminal) may have changed.

        A new transport identity gets a new client: the old session, observations and focus are gone.
        Runs only on the tool-call thread (never from a preview toolbar thread).
        """
        transport = self._resolve_transport()
        if transport.identity == self.transport.identity and transport.kind == self.transport.kind:
            return
        old = self.client
        client = WDAClient(transport)
        client.records.extend(old.records)
        self.transport = transport
        self.client = client
        self.phone.client = client
        self.phone.reset()
        _safe(old.close)

    def _current_transport(self):
        """The configured transport right now, for the preview toolbar (which never swaps the shared client)."""
        try:
            if self._url_invalid:
                return UnconfiguredTransport()
            return resolve_transport(privstate.read_config(self.state_dir), self.env)
        except ValueError:
            return UnconfiguredTransport()

    def _reset_session(self):
        """Forget the WDA session and everything tied to it (snapshots, focus, continuation)."""
        _safe(self.client.close)
        self.client.session_id = None
        self.phone.reset()

    # --- the operation lock and the shared session ----------------------------------------------------

    def _locked(self, op, args):
        self._refresh_transport()  # another window or the CLI may have configured (or re-configured) the iPhone
        if self._config_error:
            raise self._config_failure()
        lock = privstate.FileLock(self.state_dir / OPERATION_LOCK, blocking=False)
        try:
            lock.acquire()
        except BlockingIOError:
            raise ToolError("device_busy", BUSY_MESSAGE, details={"action_executed": False}) from None
        try:
            self._adopt_session()
            self._sync_shared_actions()
            try:
                return self._call(op, args)
            finally:
                self._store_session()
                if op in MUTATING_OPS:
                    self._note_shared_action()
        finally:
            lock.release()

    def _shared_actions(self):
        """(seq, writer) of the last phone action sent by any process on this Mac, or None."""
        saved = privstate.read_json(self.state_dir / ACTIONS_FILE, None)
        if isinstance(saved, dict) and type(saved.get("seq")) is int and isinstance(saved.get("writer"), str):
            return saved["seq"], saved["writer"]
        return None

    def _sync_shared_actions(self):
        """Under operation.lock: another window or the CLI acted on the phone since our last call, so our
        focus, geometry and any text continuation are stale (DESIGN.md 7.15)."""
        current = self._shared_actions()
        if current != self._actions_seen:
            self._actions_seen = current
            self.phone.external_action()

    def _note_shared_action(self):
        """Under operation.lock, after a phone action (sent or attempted): tell the other processes."""
        current = self._shared_actions()
        seq = current[0] + 1 if current is not None else 1
        try:
            privstate.write_json_private(self.state_dir / ACTIONS_FILE, {"seq": seq, "writer": self._instance_id})
        except OSError:
            self._actions_seen = None  # unknown: the next call treats the phone as changed
            return
        self._actions_seen = (seq, self._instance_id)

    def _adopt_session(self):
        """Reuse the session another process (or an earlier call) recorded for this transport."""
        saved = privstate.read_json(self.state_dir / SESSION_FILE, None)
        if not isinstance(saved, dict) or saved.get("transport") != self.transport.identity:
            return
        sid = saved.get("session_id")
        if not isinstance(sid, str) or not SID_RE.fullmatch(sid):
            return
        current = self.client.session_id
        if current == sid:
            return
        if current:
            # Another process replaced our session: our observations and focus belong to the old one.
            self.phone.reset()
        self.client.session_id = sid

    def _store_session(self):
        path = self.state_dir / SESSION_FILE
        sid = self.client.session_id
        try:
            if sid:
                privstate.write_json_private(path, {"transport": self.transport.identity, "session_id": sid})
            else:
                path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass

    # --- one locked operation -------------------------------------------------------------------------

    def _call(self, op, args):
        token = _safe(self.screen.begin, op)
        before = self.phone.accepted_actions
        try:
            if op == "ready":
                return self.ready(**args)
            if op in MUTATING_OPS:
                self._check_unlocked()
            result = getattr(self.phone, op)(**args)
            if op == "batch" and isinstance(result, dict):
                self._annotate_batch(result)
            return result
        except ToolError as exc:
            self._annotate_error(op, exc)
            raise
        except (ValueError, TypeError) as exc:
            details = {"action_executed": False}
            if self.phone.accepted_actions > before:
                details.update(action_executed=True, action_complete=False,
                               verification_required=PARTIAL_VERIFICATION)
            message = str(exc).strip() or HANDLER_ARGUMENT_MESSAGE
            raise ToolError("invalid_argument", message[:300], details=details) from None
        finally:
            _safe(self.screen.end, token)

    def _check_unlocked(self):
        """GET /wda/locked must say exactly false before any mutation (no session needed)."""
        try:
            value = self.client.request("GET", "/wda/locked").get("value")
        except ToolError as exc:
            exc.details.setdefault("action_executed", False)
            raise
        if value is not False:
            raise ToolError("phone_locked", LOCKED_MESSAGE, details={"action_executed": False})

    def _channel_recovery(self):
        return {"next_tool": "iphone_ready", "next_arguments": {}, "replay_action": False, "next_step": CHANNEL_STEP}

    def _annotate_error(self, op, exc):
        if exc.code == "phone_locked":
            _safe(self.screen.set_paused, True, "device_locked")
        elif exc.code == "not_editable" and exc.details.get("secure_field"):
            _safe(self.screen.set_paused, True, "authentication")
        if op in READ_OPS or op == "ready":
            exc.details.setdefault("action_executed", False)  # READY never acts on the phone
        if op != "ready" and self.channel_fault(exc):
            exc.details.update(category="channel_runtime", recovery=self._channel_recovery())

    def _annotate_batch(self, result):
        """A stopped batch carries its step error as data; apply the same rules as for a raised error."""
        error = result.get("error")
        if not isinstance(error, dict):
            return
        if error.get("code") == "not_editable" and error.get("secure_field"):
            _safe(self.screen.set_paused, True, "authentication")
        if error.get("code") == "phone_locked":
            _safe(self.screen.set_paused, True, "device_locked")
        if self.channel_fault(ToolError(error.get("code", ""), error.get("message", ""))):
            error.update(category="channel_runtime", recovery=self._channel_recovery())

    @staticmethod
    def channel_fault(error) -> Optional[str]:
        """"xctest_authorization" | "foreground_unavailable" | None for a ToolError."""
        code = getattr(error, "code", "")
        text = str(getattr(error, "message", "") or "").lower()
        if "not authorized for performing ui testing actions" in text or (
                "xctdaemonerrordomain" in text and "code=41" in text):
            return "xctest_authorization"
        if code == "foreground_unavailable" or (code == "stale element reference" and "local.pid." in text):
            return "foreground_unavailable"
        return None

    # --- iphone_ready ---------------------------------------------------------------------------------

    def ready(self, screenshot=False, recover=True) -> dict:
        """Prove the phone can be operated now, or say exactly what is needed (DESIGN.md 11.5 READY)."""
        if self._config_error:
            raise self._config_failure()
        pending = self._pending_recovery()
        if pending is not None:
            return self._recovering(pending, screenshot, recover)
        retried = False
        try:
            return self._ready_once(screenshot)
        except ToolError as exc:
            original = exc
        fault = self.channel_fault(original)
        if fault == "foreground_unavailable":
            self._reset_session()
            retried = True
            try:
                result = self._ready_once(screenshot)
            except ToolError as exc:
                original = exc
                fault = self.channel_fault(original)
            else:
                result["recovery"] = {"state": "read_recovered", "session_recreated": True,
                                      "replayed_action": False}
                return result
        if original.code == "phone_locked":
            raise original
        pending = self._pending_recovery()
        if pending is not None and original.code in READY_PENDING_CODES:
            return self._recovering(pending, screenshot, recover, retried, original)
        if fault and recover:
            recovery = self.setup.recover()
        elif fault:
            return {"ready": False, "state": "recovery_required", "reason": "recovery_disabled",
                    "message": RECOVERY_DISABLED_MESSAGE, "action_executed": False, "category": "channel_runtime",
                    "session_read_retried": retried, "cause": original.as_dict(),
                    "recovery": {"state": "disabled", "next_tool": "iphone_ready",
                                 "next_arguments": {"screenshot": screenshot, "recover": True},
                                 "permission_note": RECOVERY_PERMISSION_NOTE, "replay_action": False}}
        elif original.code in ("service_unreachable", "not_ready"):
            original.details.update(ready=False, action_executed=False, initialization_required=True,
                                    recovery={"next_tool": "iphone_setup", "next_arguments": {"action": "status"},
                                              "replay_action": False, "next_step": SETUP_STEP})
            raise original
        else:
            raise original
        recovery = recovery if isinstance(recovery, dict) else {}
        info = dict(recovery.get("recovery") or {})
        job_id = recovery.get("job_id") or info.get("job_id")
        if recovery.get("ok") and job_id:
            info["job_id"] = job_id
            return self._recovering(info, screenshot, recover, retried, original)
        reason = recovery.get("error") if isinstance(recovery.get("error"), str) and recovery.get("error") \
            else NOT_STARTED_DEFAULT
        info.update(next_steps=list(recovery.get("next_steps") or []), replay_action=False)
        raise ToolError("recovery_not_started", "Automatic restart was not started: " + reason,
                        details={"ready": False, "action_executed": False, "category": "channel_runtime",
                                 "session_read_retried": retried, "cause": original.as_dict(), "recovery": info})

    def _pending_recovery(self):
        pending = _safe(self.setup.pending_recovery)
        if isinstance(pending, dict) and pending.get("job_id"):
            return pending
        return None

    def _ready_once(self, screenshot):
        lock_pause = _safe(self.screen.locked_pause_id)
        status = self.client.request("GET", "/status", timeout=STATUS_TIMEOUT)
        value = status.get("value") if isinstance(status, dict) else None
        if not isinstance(value, dict) or value.get("ready") is not True:
            raise ToolError("not_ready", NOT_READY_MESSAGE)
        if self.client.request("GET", "/wda/locked").get("value") is not False:
            raise ToolError("phone_locked", READY_LOCKED_MESSAGE)
        sid = self.client.ensure_session()
        observation = self.phone.observe("both" if screenshot else "tree")
        if observation.get("total_nodes") == 0 and self.setup.mirroring_running():
            raise ToolError("mirroring_conflict", MIRRORING_MESSAGE)
        build = value.get("build") if isinstance(value.get("build"), dict) else {}
        version = build.get("version") if isinstance(build.get("version"), str) else None
        result = {"ready": True, "state": "ready",
                  "proof": {"status_ready": True, "phone_unlocked": True, "session_usable": bool(sid),
                            "foreground_resolved": True, "source_readable": True, "viewport_readable": True,
                            "screenshot_readable": bool(screenshot), "wda_version": version},
                  "observation": observation}
        if lock_pause is not None:
            _safe(self.screen.resume_after_unlock, lock_pause)
        info = _safe(self.preview.ensure)
        if info is not None:
            preview = {"url": info.url}
            preview.update(_safe(self.screen.pause_status) or {"paused": False, "pause_reason": None})
            result["preview"] = preview
        _safe(self._start_device_lookup)
        return result

    def _recovering(self, info, screenshot, recover, retried=False, cause=None):
        self._reset_session()
        recovery = dict(info)
        job_id = recovery.get("job_id")
        recovery.update(status_tool="iphone_setup",
                        status_arguments={"action": "status", "job_id": job_id, "wait_seconds": 20},
                        next_tool="iphone_ready", next_arguments={"screenshot": screenshot, "recover": recover},
                        retry_after_seconds=1, replay_action=False)
        result = {"ready": False, "state": "recovering", "message": RECOVERING_MESSAGE, "action_executed": False,
                  "category": "channel_runtime", "session_read_retried": retried, "recovery": recovery}
        if cause is not None:
            result["cause"] = cause.as_dict()
        return result

    # --- device model for the preview header ---------------------------------------------------------

    def _start_device_lookup(self):
        """Look the marketing model up once (per configured iPhone), never on the calling thread."""
        udid = privstate.read_config(self.state_dir).get("udid")
        if not isinstance(udid, str) or not udid:
            return
        with self._lookup_lock:
            if udid in self._looked_up:
                return
            self._looked_up.add(udid)
        self._spawn(lambda: self._lookup_device(udid))

    def _lookup_device(self, udid):
        path = self.state_dir / DEVICE_FILE
        cached = privstate.read_json(path, None)
        model = None
        if isinstance(cached, dict) and cached.get("udid") == udid and isinstance(cached.get("model"), str):
            model = cached["model"].strip()[:MODEL_LIMIT]
        if not model:
            found = self.setup.device_model(udid)
            if not isinstance(found, str) or not found.strip():
                return
            model = found.strip()[:MODEL_LIMIT]
            privstate.write_json_private(path, {"udid": udid, "model": model})
        self.screen.device = {"model": model}

    # --- iphone_screen --------------------------------------------------------------------------------

    def screen_tool(self, action="open", open_browser=True) -> dict:
        """The user's live preview page: open, pause, resume or status. Never touches WDA or the lock."""
        if action == "open":
            info = self.preview.ensure()
            if info is None:
                return {"url": None, "note": PREVIEW_NOTE}
            _safe(self._start_device_lookup)
            opened = False
            if (open_browser and self.platform == "darwin" and str(self.env.get(NO_BROWSER_ENV, "")).strip() != "1"
                    and info.viewers == 0):
                url = info.url
                self._spawn(lambda: open_in_browser(url, self.runner))
                opened = True
            result = {"url": info.url, "opened": opened, "already_viewing": info.viewers > 0}
            result.update(self.screen.pause_status())
            return result
        if action == "pause":
            self.screen.set_paused(True, "authentication")
            result = self.screen.pause_status()
            result["url"] = self._current_url()
            return result
        if action == "resume":
            self.screen.set_paused(False)
            result = self.screen.pause_status()
            result["url"] = self._current_url()
            return result
        info = self.preview.current()
        result = {"url": info.url if info else None, "running": info is not None}
        result.update(self.screen.pause_status())
        result["viewers"] = info.viewers if info else 0
        if info is not None and not info.owner:
            result["frame_available"] = self._remote_frame_available(info)
        else:
            result["frame_available"] = bool(self.screen.state().get("frame_available"))
        return result

    def _current_url(self):
        info = _safe(self.preview.current)
        return info.url if info is not None else None

    @staticmethod
    def _remote_frame_available(info) -> Optional[bool]:
        """frame_available of the preview another process serves (its /api/state), or None if unknown."""
        connection = http.client.HTTPConnection("127.0.0.1", info.port, timeout=REMOTE_STATE_TIMEOUT)
        try:
            connection.request("GET", "/%s/api/state" % info.token, headers={"Accept": "application/json"})
            response = connection.getresponse()
            body = response.read(REMOTE_STATE_BYTES + 1)
            if response.status != 200 or len(body) > REMOTE_STATE_BYTES:
                return None
            state = json.loads(body.decode("utf-8"))
        except (OSError, http.client.HTTPException, ValueError):
            return None
        finally:
            connection.close()
        return bool(state.get("frame_available")) if isinstance(state, dict) else None

    # --- preview toolbar (the user's own clicks) ------------------------------------------------------

    def toolbar_action(self, action) -> dict:
        """Envelope for a preview toolbar button; never raises."""
        try:
            if action == "refresh":
                return self._toolbar_refresh()
            if action not in ("home", "screenshot"):
                raise ToolError("invalid_argument", TOOLBAR_UNKNOWN_MESSAGE, details={"action_executed": False})
            if self.screen.paused():
                raise ToolError("preview_paused", PREVIEW_PAUSED_MESSAGE, details={"action_executed": False})
            if action == "home":
                return self._toolbar_home()
            return self._toolbar_screenshot()
        except ToolError as exc:
            return {"ok": False, "error": exc.as_dict()}
        except Exception as exc:  # noqa: BLE001 - the page always gets an envelope
            _stderr_failure(exc)
            return {"ok": False, "error": {"code": "internal_error", "message": INTERNAL_MESSAGE, "uncertain": True}}

    def _toolbar_refresh(self):
        pause_id = self.screen.reconnect_pause_id()
        self.screen.restart()
        service_ready = False
        probe = WDAClient(self._current_transport(), timeout=PROBE_TIMEOUT)
        try:
            status = probe.request("GET", "/status")
            value = status.get("value") if isinstance(status, dict) else None
            if isinstance(value, dict) and value.get("ready") is True:
                locked = probe.request("GET", "/wda/locked").get("value")
                service_ready = True
                if locked is False:
                    self.screen.resume_after_unlock(pause_id, explicit=True)
                else:
                    self.screen.set_paused(True, "device_locked")
        except ToolError:
            service_ready = False
        finally:
            probe.close()
        result = {"ok": True, "action": "refresh", "service_ready": service_ready}
        result.update(self.screen.pause_status())
        return result

    def _toolbar_home(self):
        lock = privstate.FileLock(self.state_dir / OPERATION_LOCK, blocking=False)
        try:
            lock.acquire()
        except BlockingIOError:
            raise ToolError("device_busy", TOOLBAR_BUSY_MESSAGE, details={"action_executed": False}) from None
        try:
            client = WDAClient(self._current_transport(), timeout=TOOLBAR_TIMEOUT)
            sent = False
            try:
                client.request("POST", "/wda/homescreen", {})
                sent = True
            except ToolError as exc:
                sent = exc.code == "action_uncertain"
                raise
            finally:
                client.close()
                if sent:
                    # The user changed the screen: earlier focus, geometry and continuations are gone.
                    self.phone.external_action()
                    _safe(self.screen.note_external_action)
                    _safe(self._note_shared_action)
        finally:
            lock.release()
        return {"ok": True, "action": "home"}

    def _toolbar_screenshot(self):
        client = WDAClient(self._current_transport(), timeout=TOOLBAR_TIMEOUT)
        try:
            reply = client.request("GET", "/screenshot")
        finally:
            client.close()
        value = reply.get("value") if isinstance(reply, dict) else None
        try:
            data = base64.b64decode(value, validate=True)
        except (TypeError, ValueError, binascii.Error):
            raise ToolError("invalid_response", SCREENSHOT_DECODE_MESSAGE,
                            details={"action_executed": False}) from None
        size = wda_image.png_size(data[:32])
        if size is None:
            raise ToolError("invalid_response", SCREENSHOT_PNG_MESSAGE, details={"action_executed": False})
        copy_png_to_clipboard(self.state_dir, data, self.runner)
        return {"ok": True, "action": "screenshot", "copied": True, "width": size[0], "height": size[1]}

    # --- metrics --------------------------------------------------------------------------------------

    def metrics(self, reset=False) -> dict:
        """Totals for this window: WDA requests, tool calls and response sizes (no content)."""
        with self._records_lock:
            tools = list(self._tool_records)
            responses = list(self._responses)
        by_tool = {}
        for record in tools:
            entry = by_tool.setdefault(record["tool"], {"count": 0, "seconds": 0.0, "errors": 0})
            entry["count"] += 1
            entry["seconds"] += record["seconds"]
            entry["errors"] += 1 if record["error"] else 0
        for entry in by_tool.values():
            entry["seconds"] = round(entry["seconds"], 4)
        result = {
            "http": self.client.metrics(),
            "tools": {"count": len(tools), "seconds": round(sum(r["seconds"] for r in tools), 4),
                      "errors": sum(1 for r in tools if r["error"]), "by_tool": by_tool},
            "responses": {"count": len(responses), "text_bytes": sum(r["text_bytes"] for r in responses),
                          "image_bytes": sum(r["image_bytes"] for r in responses)},
        }
        if reset:
            self.client.clear_metrics()
            with self._records_lock:
                self._tool_records.clear()
                self._responses.clear()
        return result

    def note_response(self, name, text_bytes, image_bytes) -> None:
        """Remember the size of one model-facing response (sizes only)."""
        record = {"tool": name if name in mcp_schemas.SCHEMAS else "unknown", "text_bytes": int(text_bytes),
                  "image_bytes": int(image_bytes)}
        with self._records_lock:
            self._responses.append(record)

    # --- shutdown -------------------------------------------------------------------------------------

    def close(self) -> None:
        """Stop the preview, the capture and the WDA connection (idempotent)."""
        if self._closed:
            return
        self._closed = True
        _safe(self.preview.stop)
        _safe(self.screen.close)
        _safe(self.client.close)
        deadline = time.monotonic() + THREAD_JOIN_SECONDS
        for thread in list(self._threads):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(remaining)
