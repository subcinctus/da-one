"""The private loopback web page that shows the user their iPhone screen.

PreviewServer serves viewer/index.html, app.js and style.css, an MJPEG relay of the
ScreenHub's latest frame, a server-sent-events feed of the preview state and the three
toolbar actions. It listens on 127.0.0.1 only, under a random token in the path that is
new for every server start, and checks the Host header (DNS rebinding) plus Content-Type,
Origin and Sec-Fetch-Site on the one POST route (cross-site requests).

PreviewManager makes one Mac run one preview even when several Claude Code windows (MCP
processes) are open: the first process serves it and records itself in preview.json; the
others reuse that page while its process is alive and answers.

Desktop helpers: copy a PNG to the macOS clipboard and open a URL in the default browser,
both through the injectable command runner.
"""

import collections
import copy
import errno
import hmac
import http.client
import http.server
import json
import os
import pathlib
import re
import secrets
import select
import socket
import socketserver
import tempfile
import threading
import time
import urllib.parse
from typing import Optional

import privstate
from cmdrunner import run_command
from errors import ToolError
from version import PRODUCT, VERSION

DEFAULT_PREVIEW_PORT = 18200
STATIC_FILES = {"": ("index.html", "text/html; charset=utf-8"),
                "app.js": ("app.js", "text/javascript; charset=utf-8"),
                "style.css": ("style.css", "text/css; charset=utf-8")}
MAX_STREAMS = 4
MAX_EVENT_STREAMS = 8
FRAME_INTERVAL = 0.25
SSE_INTERVAL = 0.25
SSE_KEEPALIVE = 15.0
MAX_ACTION_BODY = 1024
RELAY_TICK = 0.05               # how often a waiting stream checks for a closed tab, pause or restart
POLL_INTERVAL = 0.05            # serve_forever poll: how quickly stop() takes effect

ACTIONS = ("refresh", "home", "screenshot")
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
SECURITY_HEADERS = (("Cache-Control", "no-store"),
                    ("X-Content-Type-Options", "nosniff"),
                    ("X-Frame-Options", "DENY"),
                    ("Referrer-Policy", "no-referrer"),
                    ("Content-Security-Policy", CSP))
JSON_TYPE = "application/json; charset=utf-8"
STREAM_TYPE = "multipart/x-mixed-replace; boundary=frame"
EVENTS_TYPE = "text/event-stream; charset=utf-8"
ALLOWED_METHODS = "GET, HEAD, POST"
HTTP_THREAD_NAME = "iphone-preview-http"
REQUEST_TIMEOUT = 15.0          # per-connection socket timeout (idle keep-alive, slow clients)
STOP_WAIT_SECONDS = 2.0
MAX_STATE_EVENT_ID = 2 ** 53
STATE_EVENT_ID_RE = re.compile(r"[0-9]{1,16}")
TOKEN_RE = re.compile(r"[0-9a-f]{32}")

PREVIEW_FILE = "preview.json"
PREVIEW_LOCK = ".preview.lock"
HEALTH_TIMEOUT = 0.5
MAX_HEALTH_BYTES = 4096

OSASCRIPT_PATH = "/usr/bin/osascript"
OPEN_PATH = "/usr/bin/open"
CLIPBOARD_TIMEOUT = 8
BROWSER_TIMEOUT = 10
CLIPBOARD_SCRIPT = ("on run argv",
                    "set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)",
                    "end run")

INTERNAL_ERROR = {"ok": False, "error": {"code": "internal_error",
                                         "message": "The preview action failed unexpectedly. Try again in a moment.",
                                         "uncertain": True}}
_STATUS_CODES = {400: "bad_request", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
                 408: "request_timeout", 413: "too_large", 414: "too_large", 431: "too_large",
                 503: "unavailable", 505: "bad_request"}
_STATUS_MESSAGES = {400: "The request was not understood.",
                    403: "This page answers only its own local address.",
                    404: "Not found.",
                    405: "This method is not allowed here.",
                    503: "The preview cannot take another connection right now."}


# ---------------------------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------------------------


def _same_secret(given, expected) -> bool:
    """Constant-time comparison of two path segments (bytes, so any character is safe)."""
    return hmac.compare_digest(given.encode("utf-8", "surrogateescape"),
                               expected.encode("utf-8", "surrogateescape"))


def _reject_constant(name):
    raise ValueError("JSON constant %s is not allowed" % name)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _state_signature(state) -> str:
    """The parts of a hub state whose change should be pushed (frame seq and clock excluded)."""
    stable = {key: value for key, value in state.items() if key not in ("server_time", "seq", "events")}
    return json.dumps(stable, sort_keys=True, ensure_ascii=False, allow_nan=False)


class _HTTPServer(http.server.ThreadingHTTPServer):
    """Threaded HTTP server bound to 127.0.0.1 that can cut every open connection on stop."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, preview):
        self.preview = preview
        self._connections = set()
        self._connections_lock = threading.Lock()
        super().__init__(address, _Handler)

    def server_bind(self):
        # HTTPServer.server_bind would call socket.getfqdn(), a DNS lookup that can hang.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    def get_request(self):
        connection, address = super().get_request()
        with self._connections_lock:
            self._connections.add(connection)
        return connection, address

    def shutdown_request(self, request):
        with self._connections_lock:
            self._connections.discard(request)
            super().shutdown_request(request)

    def close_connections(self):
        """Shut down every open client connection so blocked handlers finish now."""
        with self._connections_lock:
            for connection in list(self._connections):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def handle_error(self, request, client_address):
        """Never print tracebacks: stdout belongs to the MCP protocol and stderr stays quiet."""


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = PRODUCT
    sys_version = ""
    timeout = REQUEST_TIMEOUT

    # --- plumbing -------------------------------------------------------------------------

    def version_string(self):
        return PRODUCT

    def log_message(self, format, *args):  # noqa: A002 - signature of the base class
        """Silent: requests are never logged (the token is in every path)."""

    def send_error(self, code, message=None, explain=None):
        """Errors found while parsing a request (bad syntax, unknown method, huge headers)."""
        code = int(code)
        if code == 501:
            code = 405
        if self.request_version == "HTTP/0.9":
            # http.server would answer a request it could not parse with a bare body;
            # always send a status line and the security headers instead.
            self.request_version = "HTTP/1.1"
        try:
            self._reject(code, close=True)
        except OSError:
            self.close_connection = True

    def _send(self, status, body, content_type, headers=(), close=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        for name, value in headers:
            self.send_header(name, value)
        if close or self._unread_body():
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, value, headers=(), close=False):
        self._send(status, _json_bytes(value), JSON_TYPE, headers, close)

    def _reject(self, status, message=None, code=None, headers=(), close=False):
        error = {"code": code or _STATUS_CODES.get(status, "bad_request"),
                 "message": message or _STATUS_MESSAGES.get(status, "The request was not understood."),
                 "uncertain": False}
        if status == 400:
            error["action_executed"] = False
        if status == 405:
            headers = tuple(headers) + (("Allow", ALLOWED_METHODS),)
        self._json(status, {"ok": False, "error": error}, headers, close)

    def _unread_body(self) -> bool:
        """True when the request carries a body this handler did not read."""
        if getattr(self, "_body_consumed", False):
            return False
        headers = getattr(self, "headers", None)
        if headers is None:
            return False
        if headers.get("Transfer-Encoding") is not None:
            return True
        length = headers.get("Content-Length")
        return length is not None and length.strip() not in ("", "0")

    def _client_gone(self) -> bool:
        """True when the browser closed its side (it sends nothing while it watches)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    # --- dispatch -------------------------------------------------------------------------

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_OPTIONS(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def do_TRACE(self):
        self._dispatch()

    def do_CONNECT(self):
        self._dispatch()

    def _host_ok(self) -> bool:
        values = self.headers.get_all("Host") or []
        if len(values) != 1:
            return False
        port = self.server.server_address[1]
        return values[0].strip().lower() in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def _dispatch(self):
        self._body_consumed = False
        preview = self.server.preview
        method = self.command
        if self.request_version not in ("HTTP/1.0", "HTTP/1.1"):
            self.request_version = "HTTP/1.1"
            return self._reject(400, close=True)
        if not self._host_ok():
            return self._reject(403)
        if method not in ("GET", "HEAD", "POST"):
            return self._reject(405)
        path, _, query = self.path.partition("?")
        if not path.startswith("/"):
            return self._reject(404)
        segment, slash, rest = path[1:].partition("/")
        token = preview.token
        if not token or not _same_secret(segment, token):
            return self._reject(404)
        if not slash:
            if method == "POST":
                return self._reject(404)
            return self._send(308, b"", "text/plain; charset=utf-8", (("Location", "/%s/" % token),))
        if rest in STATIC_FILES:
            return self._static(rest) if method != "POST" else self._reject(405)
        if rest == "stream.mjpeg":
            return self._stream() if method == "GET" else self._reject(405)
        if rest == "events":
            return self._events() if method == "GET" else self._reject(405)
        if rest == "api/state":
            return self._api_state(query) if method != "POST" else self._reject(405)
        if rest == "api/health":
            return self._json(200, preview.health()) if method != "POST" else self._reject(405)
        if rest == "api/action":
            return self._action() if method == "POST" else self._reject(405)
        return self._reject(404)

    # --- routes ---------------------------------------------------------------------------

    def _static(self, name):
        filename, content_type = STATIC_FILES[name]
        try:
            body = (self.server.preview.static_dir / filename).read_bytes()
        except OSError:
            return self._reject(404)
        return self._send(200, body, content_type)

    def _api_state(self, query):
        values = urllib.parse.parse_qs(query, keep_blank_values=True).get("last_event_id")
        last_event_id = 0
        if values is not None:
            if len(values) != 1 or not STATE_EVENT_ID_RE.fullmatch(values[0]):
                return self._reject(400, "last_event_id must be a whole number from 0 to 2^53.",
                                    code="invalid_argument")
            last_event_id = int(values[0])
            if last_event_id > MAX_STATE_EVENT_ID:
                return self._reject(400, "last_event_id must be a whole number from 0 to 2^53.",
                                    code="invalid_argument")
        return self._json(200, self.server.preview.hub.state(last_event_id))

    def _action(self):
        preview = self.server.preview
        port = self.server.server_address[1]
        content_type = (self.headers.get("Content-Type") or "").strip().lower()
        if not content_type.startswith("application/json"):
            return self._reject(403, "Send the action as application/json from the preview page.")
        origin = self.headers.get("Origin")
        if origin is not None and origin.strip() not in ("http://127.0.0.1:%d" % port, "http://localhost:%d" % port):
            return self._reject(403)
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if fetch_site is not None and fetch_site.strip().lower() != "same-origin":
            return self._reject(403)
        if self.headers.get("Transfer-Encoding") is not None:
            return self._reject(400, "Send the action with a Content-Length.", code="invalid_argument")
        length_text = (self.headers.get("Content-Length") or "").strip()
        if not length_text.isdigit() or not 0 < int(length_text) <= MAX_ACTION_BODY:
            return self._reject(400, "The action body must be 1 to %d bytes of JSON." % MAX_ACTION_BODY,
                                code="invalid_argument")
        length = int(length_text)
        try:
            body = self.rfile.read(length)
        except OSError:
            self.close_connection = True
            return None
        if len(body) != length:
            return self._reject(400, close=True)
        self._body_consumed = True
        action = _parse_action(body)
        if action is None:
            return self._reject(400, 'Send {"action": "refresh" | "home" | "screenshot"}.', code="invalid_argument")
        return self._json(200, preview.run_action(action))

    def _stream(self):
        preview = self.server.preview
        hub = preview.hub
        if hub.paused():
            return self._reject(503, "The preview is paused.", code="preview_paused")
        if not preview.claim("stream"):
            return self._reject(503, headers=(("Retry-After", "2"),))
        viewer = None
        try:
            viewer = hub.attach_viewer()
            self._relay(preview, hub)
        except OSError:
            pass  # the browser went away
        finally:
            if viewer is not None:
                hub.detach_viewer(viewer)
            preview.release("stream")
            self.close_connection = True

    def _relay(self, preview, hub):
        stream_id = hub.stream_id
        self.send_response(200)
        self.send_header("Content-Type", STREAM_TYPE)
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        # One part every FRAME_INTERVAL (at most 4 per second), always the newest frame. A still
        # screen gets the same frame again: browsers paint a multipart part only when the
        # next part begins. Short ticks notice a closed tab, a pause or a restart quickly.
        next_part_at = time.monotonic()

        def ended():
            return preview.stopping or hub.stream_id != stream_id or hub.paused()

        while not ended():
            if self._client_gone():
                return
            now = time.monotonic()
            if now < next_part_at:
                preview.wait(min(RELAY_TICK, next_part_at - now))
                continue
            frame = hub.latest_frame() or hub.wait_frame(0, RELAY_TICK)
            if frame is None:
                preview.wait(0.01)              # never spin, even if the hub was closed meanwhile
                continue
            if ended():                         # never write a picture once a pause is set
                return
            self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                             % len(frame.jpeg) + frame.jpeg + b"\r\n")
            next_part_at = time.monotonic() + FRAME_INTERVAL

    def _events(self):
        preview = self.server.preview
        hub = preview.hub
        if not preview.claim("events"):
            return self._reject(503, headers=(("Retry-After", "2"),))
        try:
            self.send_response(200)
            self.send_header("Content-Type", EVENTS_TYPE)
            for name, value in SECURITY_HEADERS:
                self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"retry: 2000\n\n")
            last_event_id = 0
            last_signature = None
            last_write = time.monotonic()
            while not preview.stopping:
                if self._client_gone():
                    return
                state = hub.state(last_event_id)
                signature = _state_signature(state)
                events = state.get("events") or []
                now = time.monotonic()
                if signature != last_signature or events:
                    self.wfile.write(b"event: state\ndata: " + _json_bytes(state) + b"\n\n")
                    last_signature = signature
                    last_write = now
                    if events:
                        last_event_id = max([last_event_id] + [event["id"] for event in events])
                elif now - last_write >= SSE_KEEPALIVE:
                    self.wfile.write(b": keepalive\n\n")
                    last_write = now
                preview.wait(SSE_INTERVAL)
        except OSError:
            pass  # the browser went away
        finally:
            preview.release("events")
            self.close_connection = True


def _parse_action(body) -> Optional[str]:
    """The action name from a strict {"action": "<name>"} JSON body, else None."""
    try:
        value = json.loads(body.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    if not isinstance(value, dict) or set(value) != {"action"} or value["action"] not in ACTIONS:
        return None
    return value["action"]


class PreviewServer:
    """The loopback HTTP server for one preview page (see the module docstring)."""

    def __init__(self, hub, static_dir, on_action, port=DEFAULT_PREVIEW_PORT, token=None, version=VERSION):
        if token is not None and not (isinstance(token, str) and TOKEN_RE.fullmatch(token)):
            raise ValueError("The preview token must be 32 lowercase hex characters.")
        self.hub = hub
        self.static_dir = pathlib.Path(static_dir)
        self.on_action = on_action
        self.requested_port = int(port or 0)
        self.version = version
        self.token = token
        self.port = None
        self._fixed_token = token
        self._server = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._slots = {"stream": 0, "events": 0}
        self._slots_lock = threading.Lock()

    @property
    def url(self) -> Optional[str]:
        if self.port is None or not self.token:
            return None
        return "http://127.0.0.1:%d/%s/" % (self.port, self.token)

    @property
    def running(self) -> bool:
        thread = self._thread
        return self._server is not None and thread is not None and thread.is_alive()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def wait(self, seconds) -> bool:
        """Sleep up to `seconds`, waking early when the server stops (returns True then)."""
        return self._stop.wait(seconds)

    def start(self, fallback_ephemeral=True) -> str:
        """Bind 127.0.0.1:port (0 = any free port; a busy port falls back to a free one) and serve."""
        with self._lock:
            if self._server is not None:
                return self.url
            token = self._fixed_token or secrets.token_hex(16)
            port = self.requested_port
            try:
                server = _HTTPServer(("127.0.0.1", port), self)
            except OSError as exc:
                if exc.errno != errno.EADDRINUSE or not fallback_ephemeral or port == 0:
                    raise
                server = _HTTPServer(("127.0.0.1", 0), self)
            self.token = token
            self.port = server.server_address[1]
            self._stop.clear()
            self._server = server
            self._thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": POLL_INTERVAL},
                                            name=HTTP_THREAD_NAME, daemon=True)
            self._thread.start()
            return self.url

    def stop(self) -> None:
        """End every stream, stop listening and close all connections."""
        with self._lock:
            server, thread = self._server, self._thread
            self._server = None
            self._thread = None
        if server is None:
            return
        self._stop.set()
        server.shutdown()
        server.server_close()
        server.close_connections()
        deadline = time.monotonic() + STOP_WAIT_SECONDS
        while time.monotonic() < deadline:
            with self._slots_lock:
                if not any(self._slots.values()):
                    break
            time.sleep(0.01)
        if thread is not None:
            thread.join(STOP_WAIT_SECONDS)

    def claim(self, kind) -> bool:
        limit = MAX_STREAMS if kind == "stream" else MAX_EVENT_STREAMS
        with self._slots_lock:
            if self._slots[kind] >= limit:
                return False
            self._slots[kind] += 1
            return True

    def release(self, kind) -> None:
        with self._slots_lock:
            self._slots[kind] = max(0, self._slots[kind] - 1)

    def health(self) -> dict:
        return {"ok": True, "name": PRODUCT, "version": self.version, "viewers": self.hub.viewer_count()}

    def run_action(self, action) -> dict:
        """on_action(action) as a JSON-safe envelope; any failure becomes internal_error."""
        try:
            result = self.on_action(action)
        except ToolError as exc:
            result = {"ok": False, "error": exc.as_dict()}
        except Exception:  # noqa: BLE001 - the page gets an envelope, never a traceback
            return copy.deepcopy(INTERNAL_ERROR)
        if not isinstance(result, dict):
            return copy.deepcopy(INTERNAL_ERROR)
        try:
            _json_bytes(result)
        except (TypeError, ValueError, RecursionError):
            return copy.deepcopy(INTERNAL_ERROR)
        return result


# ---------------------------------------------------------------------------------------------
# Desktop helpers
# ---------------------------------------------------------------------------------------------


def copy_png_to_clipboard(state_dir, data: bytes, runner=None) -> None:
    """Put PNG bytes on the macOS clipboard via osascript; the temp file never outlives the call.

    The file path is passed as an osascript argument, never inside the script text.
    """
    runner = run_command if runner is None else runner
    fd, path = tempfile.mkstemp(prefix=".clipboard-", suffix=".png", dir=str(state_dir))
    result = None
    failed = False
    try:
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(bytes(data))
            while view:
                written = os.write(fd, view)
                view = view[written:]
        finally:
            os.close(fd)
        argv = [OSASCRIPT_PATH]
        for line in CLIPBOARD_SCRIPT:
            argv += ["-e", line]
        argv.append(path)
        result = runner(argv, timeout=CLIPBOARD_TIMEOUT)
    except Exception:  # noqa: BLE001 - an OSError or a runner failure means "not copied"
        failed = True
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if failed:
        raise ToolError("clipboard_unavailable", "The screenshot could not be copied to the clipboard.",
                        details={"action_executed": False})
    if getattr(result, "returncode", 1) != 0:
        raise ToolError("clipboard_unavailable",
                        "The screenshot was captured but macOS did not accept it on the clipboard.",
                        details={"action_executed": False})


def open_in_browser(url, runner=None) -> bool:
    """Open a preview URL (http://127.0.0.1:<port>/...) in the default browser; True on success."""
    if not isinstance(url, str) or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}/[0-9A-Za-z/._-]*", url):
        return False
    runner = run_command if runner is None else runner
    try:
        return bool(runner([OPEN_PATH, url], timeout=BROWSER_TIMEOUT).ok)
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------------------------
# PreviewManager
# ---------------------------------------------------------------------------------------------

PreviewInfo = collections.namedtuple("PreviewInfo", "url port token owner viewers")


def probe_health(port, token, timeout=HEALTH_TIMEOUT) -> Optional[dict]:
    """GET http://127.0.0.1:<port>/<token>/api/health; the parsed answer when it is ours, else None."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", "/%s/api/health" % token, headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(MAX_HEALTH_BYTES + 1)
        if response.status != 200 or len(body) > MAX_HEALTH_BYTES:
            return None
        value = json.loads(body.decode("utf-8"))
    except (OSError, http.client.HTTPException, ValueError, UnicodeDecodeError):
        return None
    finally:
        connection.close()
    if isinstance(value, dict) and value.get("ok") is True and value.get("name") == PRODUCT:
        return value
    return None


def _viewers_from(health) -> int:
    viewers = health.get("viewers")
    if isinstance(viewers, int) and not isinstance(viewers, bool) and viewers >= 0:
        return viewers
    return 0


class PreviewManager:
    """One preview per Mac, shared by every MCP process (see the module docstring)."""

    def __init__(self, state_dir, hub, static_dir, on_action, preferred_port=DEFAULT_PREVIEW_PORT,
                 allow_start=True):
        self.state_dir = pathlib.Path(state_dir)
        self.hub = hub
        self.static_dir = static_dir
        self.on_action = on_action
        self.preferred_port = preferred_port
        self.allow_start = bool(allow_start)
        self._server = None
        self._lock = threading.Lock()

    @property
    def record_path(self) -> pathlib.Path:
        return self.state_dir / PREVIEW_FILE

    def ensure(self) -> Optional[PreviewInfo]:
        """The live preview, starting ours if needed (never opens a browser).

        None only when allow_start is False and no other process serves a preview.
        """
        return self._resolve(start=self.allow_start, record=True)

    def current(self) -> Optional[PreviewInfo]:
        """The live preview without starting anything."""
        return self._resolve(start=False, record=False)

    def stop(self) -> None:
        """Stop our server; delete preview.json if it names this process and server."""
        with self._lock:
            server, self._server = self._server, None
            if server is None:
                return
            try:
                with privstate.FileLock(self.state_dir / PREVIEW_LOCK):
                    record = self._read_record()
                    if record is not None and record["pid"] == os.getpid() and record["token"] == server.token:
                        self.record_path.unlink()
            except OSError:
                pass
            server.stop()

    def _resolve(self, start, record):
        with self._lock:
            with privstate.FileLock(self.state_dir / PREVIEW_LOCK):
                saved = self._read_record()
                own = self._server if self._server is not None and self._server.running else None
                if (saved is not None and (own is None or saved["token"] != own.token)
                        and privstate.pid_alive(saved["pid"])):
                    health = probe_health(saved["port"], saved["token"])
                    if health is not None:
                        url = "http://127.0.0.1:%d/%s/" % (saved["port"], saved["token"])
                        return PreviewInfo(url, saved["port"], saved["token"], False, _viewers_from(health))
                if own is not None:
                    if record and (saved is None or saved["token"] != own.token):
                        self._write_record(own)
                    return PreviewInfo(own.url, own.port, own.token, True, self.hub.viewer_count())
                if not start:
                    return None
                if self._server is not None:     # our earlier server died; clean it up first
                    self._server.stop()
                    self._server = None
                server = PreviewServer(self.hub, self.static_dir, self.on_action, port=self.preferred_port)
                server.start()
                self._server = server
                self._write_record(server)
                return PreviewInfo(server.url, server.port, server.token, True, self.hub.viewer_count())

    def _read_record(self):
        data = privstate.read_json(self.record_path, None)
        if not isinstance(data, dict):
            return None
        pid, port, token = data.get("pid"), data.get("port"), data.get("token")
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            return None
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            return None
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            return None
        return {"pid": pid, "port": port, "token": token}

    def _write_record(self, server):
        privstate.write_json_private(self.record_path, {
            "pid": os.getpid(), "port": server.port, "token": server.token, "url": server.url,
            "started_at": privstate.iso_now(), "version": VERSION})
