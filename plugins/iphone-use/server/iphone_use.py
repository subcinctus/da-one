#!/usr/bin/env python3
"""iPhone Use MCP server: newline-delimited JSON-RPC 2.0 over stdio (server name "iphone").

The reader (the calling thread) parses every line and answers initialize, ping,
tools/list and the inline tool (iphone_screen) at once. Every other tool call goes to one
worker thread that runs calls strictly in arrival order, so a long phone operation never
delays a ping or a preview pause. stdout carries only JSON-RPC lines.

Run without flags to serve; `--doctor` / `--ready` print one envelope and exit 1 when it
is not ok (or not ready); `--version` prints the version.
"""

import argparse
import base64
import collections
import copy
import json
import signal
import sys
import threading
from pathlib import Path

import mcp_schemas
from errors import ToolError
from version import VERSION

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_LINE_BYTES = 1024 * 1024
TEXT_LIMIT = 48_000
# Claude Code cuts the text of an isError result to 10 000 characters (UTF-16 units) by dropping its middle,
# which breaks the JSON; such results are fitted below that instead.
ERROR_TEXT_LIMIT = 9_500
INLINE_TOOLS = {"iphone_screen"}
FIT_ROUNDS = 12
SERVER_INFO = {"name": "iphone-use", "title": "iPhone Use", "version": VERSION}
WORKER_NAME = "iphone-tools"
SHUTDOWN_JOIN_SECONDS = 1.0

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602

TOO_LARGE_MESSAGE = "The result was too large to return; ask for fewer nodes or pages."
TOO_LARGE_ACTED_MESSAGE = ("The result was too large to return, but the phone already acted. Do not repeat the "
                           "action or the completed steps: look at the current screen (with fewer nodes) first.")
BATCH_VERIFICATION = ("Steps of this batch already ran on the phone. Look at the current screen; do not repeat the "
                      "completed steps.")
EVIDENCE_KEYS = ("action_executed", "action_complete", "verification_required")
BATCH_KEYS = ("complete", "completed_steps", "stopped_at", "resume_at", "stop_reason", "next_step")
START_FAILURE_MESSAGE = "iPhone Use could not start because its data folder could not be prepared."


# --- result -> MCP content (DESIGN.md 11.7) ------------------------------------------------------------


def _compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _list_slots(envelope):
    """(container, key) pairs of the lists fit_text may shorten, in the documented order."""
    slots = []

    def add(container, key):
        if isinstance(container, dict) and isinstance(container.get(key), list):
            slots.append((container, key))

    add(envelope.get("observation"), "nodes")
    add(envelope, "nodes")
    add(envelope, "rows")
    add(envelope, "elements")
    add(envelope, "candidates")
    results = envelope.get("results")
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict):
                add(item.get("observation"), "nodes")
                add(item, "nodes")  # a batch observe step
    error = envelope.get("error")
    add(error, "candidates")
    add(error.get("observation") if isinstance(error, dict) else None, "nodes")
    return slots


def _too_large(envelope) -> dict:
    """The replacement for a result that cannot be fitted; it keeps the evidence of what already ran."""
    error = {"code": "response_too_large", "message": TOO_LARGE_MESSAGE, "uncertain": False}
    original_error = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
    if original_error.get("uncertain") is True:
        error["uncertain"] = True
    for key in EVIDENCE_KEYS:
        for source in (envelope, original_error):
            if key in source and key not in error:
                error[key] = source[key]
    replacement = {"ok": False, "error": error}
    results = envelope.get("results")
    if isinstance(results, list):
        # A batch: its progress, any unfinished text and whether its steps already acted on the phone.
        replacement.update((key, envelope[key]) for key in BATCH_KEYS if key in envelope)
        items = [item for item in results if isinstance(item, dict)]
        tokens = [item["continue_token"] for item in items if isinstance(item.get("continue_token"), str)]
        if tokens:
            replacement["continue_token"] = tokens[-1]
        if any(item.get("action_executed") is True for item in items) or original_error.get("action_executed") is True:
            error.update(action_executed=True, action_complete=False, verification_required=BATCH_VERIFICATION)
    if error.get("action_executed") is True:
        error["message"] = TOO_LARGE_ACTED_MESSAGE
    return replacement


def _size(text) -> int:
    """Length in UTF-16 code units, as Claude Code counts it."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _fit(envelope, limit):
    """(envelope, compact JSON text) within limit by halving the longest lists, or None if impossible."""
    text = _compact(envelope)
    if _size(text) <= limit:
        return envelope, text
    fitted = copy.deepcopy(envelope)
    for _ in range(FIT_ROUNDS):
        slots = [slot for slot in _list_slots(fitted) if slot[0][slot[1]]]
        if not slots:
            break
        container, key = max(slots, key=lambda slot: len(slot[0][slot[1]]))
        items = container[key]
        container[key] = items[:len(items) // 2]
        fitted["size_truncated"] = True
        text = _compact(fitted)
        if _size(text) <= limit:
            return fitted, text
    return None


def fit_text(envelope, limit=TEXT_LIMIT):
    """(envelope, compact JSON text) with the text at most `limit` characters."""
    fitted = _fit(envelope, limit)
    if fitted is not None:
        return fitted
    replacement = _too_large(envelope)
    return replacement, _compact(replacement)


def _image_of(envelope):
    """The one image to attach, first match wins (DESIGN.md 11.7 step 2)."""
    def get(container, *keys):
        for key in keys:
            if not isinstance(container, dict):
                return None
            container = container.get(key)
        return container

    results = envelope.get("results")
    last = results[-1] if isinstance(results, list) and results else None
    for candidate in (get(envelope, "image"), get(envelope, "observation", "image"),
                      get(envelope, "error", "observation", "image"), get(last, "image"),
                      get(last, "observation", "image")):
        if isinstance(candidate, dict) and isinstance(candidate.get("path"), str):
            return candidate
    return None


def _image_block(image):
    """The MCP image block for an image reference whose file exists, else None."""
    if image is None:
        return None
    try:
        path = Path(image["path"])
        if path.is_file():
            data = base64.b64encode(path.read_bytes()).decode("ascii")
            mime = image.get("mimeType") if isinstance(image.get("mimeType"), str) else "image/png"
            return {"type": "image", "data": data, "mimeType": mime}
    except (OSError, ValueError):
        pass
    return None


def result_content(envelope) -> dict:
    """MCP tools/call result: one compact JSON text block plus at most one image block."""
    block = _image_block(_image_of(envelope)) if isinstance(envelope, dict) else None
    try:
        fitted = None
        if isinstance(envelope, dict) and envelope.get("ok") is False and block is None:
            # isError: keep it under Claude Code's error cut; if lists cannot make it fit, the full limit (a
            # middle cut by Claude Code) still says more than response_too_large would.
            fitted = _fit(envelope, ERROR_TEXT_LIMIT)
        fitted, text = fitted if fitted is not None else fit_text(envelope)
    except (TypeError, ValueError, RecursionError) as exc:
        _stderr_failure(exc)
        fitted = {"ok": False, "error": {"code": "internal_error", "message": "The iPhone tool result could not "
                                         "be encoded.", "uncertain": True}}
        text = _compact(fitted)
    if block is not None and _image_of(fitted) is None:
        block = None  # replaced by response_too_large: no image without its result
    content = [{"type": "text", "text": text}]
    if block is not None:
        content.append(block)
    is_error = fitted.get("ok") is False and block is None
    return {"content": content, "isError": is_error}


def tool_result(runtime, params) -> dict:
    """Run one tools/call and map its envelope to MCP content."""
    name = params.get("name")
    arguments = params.get("arguments", {})
    if arguments is None:
        arguments = {}
    return result_content(runtime.execute(name, arguments))


def _sizes(result):
    text_bytes = image_bytes = 0
    for block in result.get("content", []):
        if block.get("type") == "text":
            text_bytes += len(block.get("text", "").encode("utf-8"))
        elif block.get("type") == "image":
            image_bytes += len(block.get("data", ""))
    return text_bytes, image_bytes


def _stderr_failure(exc):
    try:
        sys.stderr.write("iphone-use tool failure: %s\n" % type(exc).__name__)
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


# --- a runtime that could not be built ------------------------------------------------------------------


class FailedRuntime:
    """Stand-in when Runtime() failed: the protocol still works and every tool returns that error."""

    def __init__(self, error):
        self.error = error

    def execute(self, name, args):
        return {"ok": False, "error": self.error.as_dict()}

    def note_response(self, name, text_bytes, image_bytes):
        pass

    def close(self):
        pass


# --- the stdio protocol (DESIGN.md 11.8) ----------------------------------------------------------------


def _reject_constant(name):
    raise ValueError("non-finite number %s" % name)


def _valid_id(value) -> bool:
    return isinstance(value, (str, int)) and not isinstance(value, bool)


def _same_id(left, right) -> bool:
    return type(left) is type(right) and left == right


def _initialize_result(params):
    requested = params.get("protocolVersion")
    version = requested if isinstance(requested, str) and requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
    return {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": dict(SERVER_INFO), "instructions": mcp_schemas.INSTRUCTIONS}


class _Server:
    """State shared by the reader and the worker of one serve() call."""

    def __init__(self, runtime, stdout):
        self.runtime = runtime
        self.stdout = stdout
        self.write_lock = threading.Lock()
        self.condition = threading.Condition()
        self.queue = collections.deque()
        self.stopping = False

    # -- output --

    def send(self, message):
        try:
            data = json.dumps(message, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
        except (TypeError, ValueError) as exc:
            _stderr_failure(exc)
            if "id" not in message:
                return
            data = json.dumps({"jsonrpc": "2.0", "id": message["id"],
                               "error": {"code": -32603, "message": "Internal error"}}).encode("utf-8") + b"\n"
        with self.write_lock:
            try:
                self.stdout.write(data)
                self.stdout.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass  # the client is gone

    def reply(self, ident, result):
        self.send({"jsonrpc": "2.0", "id": ident, "result": result})

    def fail(self, ident, code, message):
        self.send({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})

    # -- tool calls --

    def run_tool(self, ident, params):
        try:
            result = tool_result(self.runtime, params)
        except Exception as exc:  # noqa: BLE001 - every request gets an answer
            _stderr_failure(exc)
            result = result_content({"ok": False, "error": {"code": "internal_error", "message": "The iPhone tool "
                                     "failed unexpectedly.", "uncertain": True}})
        try:
            name = params.get("name") if isinstance(params.get("name"), str) else "unknown"
            self.runtime.note_response(name, *_sizes(result))
        except Exception:  # noqa: BLE001 - metrics never block an answer
            pass
        self.reply(ident, result)

    def worker(self):
        while True:
            with self.condition:
                while not self.queue and not self.stopping:
                    self.condition.wait()
                if not self.queue:
                    return
                ident, params = self.queue.popleft()
            self.run_tool(ident, params)

    def enqueue(self, ident, params):
        with self.condition:
            self.queue.append((ident, params))
            self.condition.notify()

    def cancel(self, request_id):
        """Drop a queued (not yet started) call; a running call finishes normally."""
        with self.condition:
            for item in list(self.queue):
                if _same_id(item[0], request_id):
                    self.queue.remove(item)
                    return True
        return False

    def stop(self):
        """Stop taking work: queued calls are discarded, the running one finishes."""
        with self.condition:
            self.stopping = True
            self.queue.clear()
            self.condition.notify_all()

    # -- one input line --

    def handle_line(self, raw):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            self.fail(None, PARSE_ERROR, "Parse error")
            return
        if not text.strip():
            return
        try:
            message = json.loads(text, parse_constant=_reject_constant)
        except (ValueError, RecursionError):
            self.fail(None, PARSE_ERROR, "Parse error")
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(
                message.get("method"), str):
            ident = message.get("id") if isinstance(message, dict) else None
            self.fail(ident if _valid_id(ident) else None, INVALID_REQUEST, "Invalid request")
            return
        method = message["method"]
        if "id" not in message:
            self.notification(method, message.get("params"))
            return
        ident = message["id"]
        if not _valid_id(ident):
            self.fail(None, INVALID_REQUEST, "Invalid request")
            return
        params = message.get("params", {})
        if not isinstance(params, dict):
            self.fail(ident, INVALID_PARAMS, "params must be an object.")
            return
        self.request(ident, method, params)

    def notification(self, method, params):
        if method == "notifications/cancelled" and isinstance(params, dict):
            request_id = params.get("requestId")
            if _valid_id(request_id):
                self.cancel(request_id)

    def request(self, ident, method, params):
        if method == "initialize":
            self.reply(ident, _initialize_result(params))
        elif method == "ping":
            self.reply(ident, {})
        elif method == "tools/list":
            self.reply(ident, {"tools": mcp_schemas.TOOLS})
        elif method == "tools/call":
            name = params.get("name")
            if isinstance(name, str) and name in INLINE_TOOLS:
                self.run_tool(ident, params)
            else:
                self.enqueue(ident, params)
        else:
            self.fail(ident, METHOD_NOT_FOUND, "Method not found")


def _read_line(stdin):
    """One raw input line (b"" at EOF), or None when it was longer than MAX_LINE_BYTES (then skipped)."""
    line = stdin.readline(MAX_LINE_BYTES + 1)
    content = line[:-1] if line.endswith(b"\n") else line
    if len(content) <= MAX_LINE_BYTES:
        return line
    while line and not line.endswith(b"\n"):
        line = stdin.readline(65536)
    return None


def serve(runtime, stdin=None, stdout=None) -> int:
    """Serve MCP over newline-delimited JSON-RPC until stdin ends; returns the exit code (0)."""
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout.buffer if stdout is None else stdout
    server = _Server(runtime, stdout)
    worker = threading.Thread(target=server.worker, name=WORKER_NAME, daemon=True)
    worker.start()
    clean = False
    try:
        while True:
            line = _read_line(stdin)
            if line is None:
                server.fail(None, PARSE_ERROR, "Parse error")
                continue
            if not line:
                break
            try:
                server.handle_line(line)
            except Exception as exc:  # noqa: BLE001 - one bad message never stops the server
                _stderr_failure(exc)
        clean = True
    finally:
        server.stop()
        worker.join(None if clean else SHUTDOWN_JOIN_SECONDS)
        try:
            runtime.close()
        except Exception:  # noqa: BLE001
            pass
    return 0


# --- command line -----------------------------------------------------------------------------------------


def _build_runtime(state_dir, url, serve_preview):
    from runtime import Runtime  # imported here so a broken environment still lets the protocol start

    return Runtime(state_dir=state_dir, wda_url=url, serve_preview=serve_preview)


def _one_shot(tool, state_dir, url) -> int:
    runtime = None
    try:
        runtime = _build_runtime(state_dir, url, serve_preview=False)
    except ToolError as exc:
        envelope = {"ok": False, "error": exc.as_dict()}
    except Exception as exc:  # noqa: BLE001 - always print one envelope
        _stderr_failure(exc)
        envelope = {"ok": False, "error": {"code": "internal_error", "message": START_FAILURE_MESSAGE,
                                           "uncertain": False, "action_executed": False}}
    if runtime is not None:
        try:
            envelope = runtime.execute(tool, {})
        finally:
            runtime.close()
    sys.stdout.write(_compact(envelope) + "\n")
    sys.stdout.flush()
    if envelope.get("ok") is not True:
        return 1
    if tool == "iphone_ready" and envelope.get("ready") is not True:
        return 1
    return 0


def _terminate(signum, frame):
    raise SystemExit(0)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="iphone_use.py", description="iPhone Use MCP server (stdio).")
    parser.add_argument("--state-dir", help="private data folder (default ~/.local/share/iphone-use)")
    parser.add_argument("--url", help="explicit loopback WebDriverAgent URL, e.g. http://127.0.0.1:8100")
    parser.add_argument("--doctor", action="store_true", help="print the iphone_doctor result and exit")
    parser.add_argument("--ready", action="store_true", help="print the iphone_ready result and exit")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    options = parser.parse_args(argv)
    if options.version:
        sys.stdout.write("iphone-use %s\n" % VERSION)
        sys.stdout.flush()
        return 0
    if options.doctor:
        return _one_shot("iphone_doctor", options.state_dir, options.url)
    if options.ready:
        return _one_shot("iphone_ready", options.state_dir, options.url)
    try:
        runtime = _build_runtime(options.state_dir, options.url, serve_preview=True)
    except ToolError as exc:
        runtime = FailedRuntime(exc)
    except Exception as exc:  # noqa: BLE001 - keep the protocol up so the user sees the reason
        _stderr_failure(exc)
        runtime = FailedRuntime(ToolError("internal_error", START_FAILURE_MESSAGE,
                                          details={"action_executed": False}))
    try:
        signal.signal(signal.SIGTERM, _terminate)
    except (ValueError, OSError):
        pass
    return serve(runtime)


if __name__ == "__main__":
    sys.exit(main())
