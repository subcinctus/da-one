"""Transports and the HTTP client for WebDriverAgent (WDA) on the iPhone.

The client speaks HTTP/1.1 directly over a usbmux tunnel to device port 8100 (or
over loopback TCP when a test or the user configures a URL). Its rules protect the
phone from accidental repeats:

* reads are retried once, within the original deadline;
* mutations are never retried;
* a failure before any request byte left the Mac is ``service_unreachable`` with
  ``uncertain: false``, even for a mutation;
* a mutation whose answer was lost is ``action_uncertain`` (``uncertain: true``).
"""

import collections
import http.client
import json
import os
import re
import socket
import time
from typing import Optional
from urllib.parse import urlsplit

import usbmux
from errors import ToolError
from privstate import config_int
from usbmux import UsbmuxError

DEFAULT_TIMEOUT = 15.0
SESSION_TIMEOUT = 30.0
MAX_RESPONSE_BYTES = 24 * 1024 * 1024
DEFAULT_DEVICE_PORT = 8100
DEFAULT_MJPEG_PORT = 9100
WDA_URL_ENV = "IPHONE_USE_WDA_URL"
SID_RE = re.compile(r"[A-Za-z0-9-]{1,128}")
SESSION_CAPABILITIES = {"capabilities": {"alwaysMatch": {
    "shouldWaitForQuiescence": False, "shouldTerminateApp": False,
    "waitForIdleTimeout": 0, "maxTypingFrequency": 30}}}
SESSION_SETTINGS = {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0,
                    "shouldUseCompactResponses": False,
                    "elementResponseAttributes": "type,label,rect,enabled,attribute/name,attribute/value"}

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
LOOPBACK_URL_MESSAGE = "WDA URL must be http://127.0.0.1:<port> (loopback only)."
NOT_CONFIGURED_MESSAGE = "iPhone Use is not set up yet; no iPhone is configured."
WDA_MESSAGE_LIMIT = 1500
READ_CHUNK = 65536

ELEMENT_LOOKUP_RE = re.compile(r"/element(?:s|/[^/]+/elements?)?")
METHOD_RE = re.compile(r"[A-Z]{1,16}")


# --- loopback URLs -----------------------------------------------------------------------------------


def validate_loopback_url(url) -> tuple:
    """Return (host, port) for http://127.0.0.1|localhost|[::1][:port][/]; ValueError otherwise."""
    if not isinstance(url, str) or not url or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in url):
        raise ValueError(LOOPBACK_URL_MESSAGE)
    if "?" in url or "#" in url or "@" in url:
        raise ValueError(LOOPBACK_URL_MESSAGE)
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        raise ValueError(LOOPBACK_URL_MESSAGE) from None
    if parts.scheme != "http" or host not in LOOPBACK_HOSTS or parts.path not in ("", "/"):
        raise ValueError(LOOPBACK_URL_MESSAGE)
    netloc = parts.netloc
    if netloc.startswith("["):
        closing = netloc.find("]")
        rest = netloc[closing + 1:] if closing >= 0 else None
    else:
        _, colon, port_text = netloc.partition(":")
        rest = (colon + port_text) if colon else ""
    if rest is None:
        raise ValueError(LOOPBACK_URL_MESSAGE)
    if rest == "":
        return host, 80
    if not re.fullmatch(r":[0-9]{1,5}", rest):
        raise ValueError(LOOPBACK_URL_MESSAGE)
    port = int(rest[1:])
    if not 1 <= port <= 65535:
        raise ValueError(LOOPBACK_URL_MESSAGE)
    return host, port


# --- HTTP connections --------------------------------------------------------------------------------


class UsbmuxHTTPConnection(http.client.HTTPConnection):
    """HTTP connection whose socket is a usbmux tunnel to a device port."""

    auto_open = 0  # never connect implicitly inside send(); connects are explicit

    def __init__(self, udid, device_port, timeout, env=None):
        super().__init__("127.0.0.1", device_port, timeout=timeout)  # Host header is irrelevant to WDA
        self.udid = udid
        self.device_port = device_port
        self.env = env

    def connect(self):
        self.sock = usbmux.connect(self.udid, self.device_port, timeout=self.timeout, env=self.env)


class TcpHTTPConnection(http.client.HTTPConnection):
    """Loopback TCP connection with Nagle's algorithm off."""

    auto_open = 0

    def connect(self):
        super().connect()
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass


class _UnconfiguredConnection(http.client.HTTPConnection):
    auto_open = 0

    def __init__(self, timeout):
        super().__init__("127.0.0.1", 9, timeout=timeout)

    def connect(self):
        raise UsbmuxError("not_configured", NOT_CONFIGURED_MESSAGE)


# --- transports --------------------------------------------------------------------------------------


class Transport:
    """How the Mac reaches the iPhone's WDA ports."""

    kind = "none"
    identity = "none"

    def new_connection(self, timeout) -> http.client.HTTPConnection:
        raise NotImplementedError

    def open_socket(self, port=None, timeout=5.0) -> socket.socket:
        raise NotImplementedError

    def describe(self) -> dict:
        return {"kind": self.kind}


class UsbmuxTransport(Transport):
    """usbmux tunnels to one configured iPhone (never any other device)."""

    kind = "usbmux"

    def __init__(self, udid, device_port=DEFAULT_DEVICE_PORT, env=None):
        if not isinstance(udid, str) or not usbmux.UDID_RE.fullmatch(udid):
            raise ValueError("The iPhone UDID must be 8-64 letters, digits or dashes.")
        if not isinstance(device_port, int) or isinstance(device_port, bool) or not 1 <= device_port <= 65535:
            raise ValueError("The iPhone port must be an integer between 1 and 65535.")
        self.udid = udid
        self.device_port = device_port
        self.env = env
        self.identity = "usbmux:%s:%d" % (udid, device_port)

    def new_connection(self, timeout):
        return UsbmuxHTTPConnection(self.udid, self.device_port, timeout, self.env)

    def open_socket(self, port=None, timeout=5.0):
        return usbmux.connect(self.udid, port or self.device_port, timeout=timeout, env=self.env)

    def describe(self):
        return {"kind": self.kind, "udid": self.udid, "device_port": self.device_port}


class TcpTransport(Transport):
    """Plain TCP to a loopback WDA URL (tests, or a user-supplied forwarder)."""

    kind = "tcp"

    def __init__(self, url):
        self.host, self.port = validate_loopback_url(url)
        shown_host = "[%s]" % self.host if ":" in self.host else self.host
        self.url = "http://%s:%d" % (shown_host, self.port)
        self.identity = "tcp:%s:%d" % (self.host, self.port)

    def new_connection(self, timeout):
        return TcpHTTPConnection(self.host, self.port, timeout=timeout)

    def open_socket(self, port=None, timeout=5.0):
        target_port = port or self.port
        if not isinstance(target_port, int) or isinstance(target_port, bool) or not 1 <= target_port <= 65535:
            raise ValueError("The port must be an integer between 1 and 65535.")
        sock = socket.create_connection((self.host, target_port), timeout)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        return sock

    def describe(self):
        return {"kind": self.kind, "url": self.url}


class UnconfiguredTransport(Transport):
    """No iPhone configured: every connection attempt fails before anything is sent."""

    kind = "none"
    identity = "none"

    def new_connection(self, timeout):
        return _UnconfiguredConnection(timeout)

    def open_socket(self, port=None, timeout=5.0):
        raise UsbmuxError("not_configured", NOT_CONFIGURED_MESSAGE)


def resolve_transport(config, env=None, explicit_url=None) -> Transport:
    """Pick the transport: explicit URL > $IPHONE_USE_WDA_URL > config wda_url > config udid > none.

    A bad URL raises ValueError (callers report it as config_invalid).
    """
    environ = os.environ if env is None else env
    config = config if isinstance(config, dict) else {}
    if explicit_url:
        return TcpTransport(explicit_url)
    env_url = environ.get(WDA_URL_ENV)
    if isinstance(env_url, str) and env_url.strip():
        return TcpTransport(env_url.strip())
    if config.get("wda_url"):
        return TcpTransport(config["wda_url"])
    udid = config.get("udid")
    if isinstance(udid, str) and usbmux.UDID_RE.fullmatch(udid):
        return UsbmuxTransport(udid, config_int(config, "device_port", DEFAULT_DEVICE_PORT), env=env)
    return UnconfiguredTransport()


# --- helpers -----------------------------------------------------------------------------------------


def _route(path) -> str:
    """Path without query string and without a leading /session/<id>; "" becomes "/"."""
    route = str(path).split("?", 1)[0]
    if route.startswith("/session/"):
        rest = route[len("/session/"):]
        slash = rest.find("/")
        route = rest[slash:] if slash >= 0 else ""
    return route or "/"


def normalize_endpoint(path) -> str:
    """Metrics key for a path: session and element ids become ":id"; the query is dropped."""
    parts = str(path).split("?", 1)[0].split("/")
    for index in range(len(parts) - 1):
        if index == 1 and parts[index] == "session":
            parts[index + 1] = ":id"
        elif parts[index] == "element" and parts[index + 1] not in ("", "active"):
            parts[index + 1] = ":id"
    return "/".join(parts)


def _validate_request_line(method, path):
    if not isinstance(method, str) or not METHOD_RE.fullmatch(method):
        raise ValueError("The HTTP method must be an upper-case token.")
    if not isinstance(path, str) or not path.startswith("/") or any(
            ord(ch) <= 32 or ord(ch) >= 127 for ch in path):
        raise ValueError("The WDA path must start with / and contain only visible ASCII characters.")


def _socket_dropped(sock) -> bool:
    """True when an idle keep-alive socket was closed by the peer (or has stray bytes)."""
    try:
        previous = sock.gettimeout()
    except OSError:
        return True
    try:
        sock.setblocking(False)
        sock.recv(1, socket.MSG_PEEK)
    except (BlockingIOError, InterruptedError):
        return False  # nothing to read: the connection is idle and alive
    except (OSError, ValueError):
        return True
    finally:
        try:
            sock.settimeout(previous)
        except OSError:
            pass
    # recv returned: either b"" (the peer closed it) or unsolicited bytes that would corrupt the
    # next response. Neither connection may be reused.
    return True


_UNREACHABLE_READ = "The iPhone service connection failed or timed out; no phone action was executed."
_UNCERTAIN = ("The connection to the iPhone failed or timed out after the action was sent. "
              "Read the current screen before deciding whether to repeat it.")


# --- the client --------------------------------------------------------------------------------------


class WDAClient:
    """HTTP/1.1 keep-alive client for WDA with read/mutation safety rules.

    Not thread-safe for concurrent requests; ``close()`` may be called from any thread.
    """

    def __init__(self, transport, timeout=DEFAULT_TIMEOUT):
        if isinstance(transport, str):
            transport = TcpTransport(transport)
        self.transport = transport
        self.timeout = DEFAULT_TIMEOUT if timeout is None else float(timeout)
        self.session_id = None  # type: Optional[str]
        self.records = collections.deque(maxlen=2000)
        self._connection = None
        self._settings_sid = None

    # -- classification --

    @staticmethod
    def is_read(method, path) -> bool:
        """True for requests that cannot change the phone (safe to retry once)."""
        route = _route(path)
        verb = str(method).upper()
        if verb == "GET":
            # WDA presses Home in /wda/healthcheck. Compare case-insensitively (WDA routes are).
            return route.lower().rstrip("/") != "/wda/healthcheck"
        if verb == "POST":
            return bool(ELEMENT_LOOKUP_RE.fullmatch(route))
        return False

    # -- connection management --

    def close(self) -> None:
        """Close the keep-alive connection; the session id is kept."""
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except Exception:  # closing must never fail the caller
                pass

    def _reusable_connection(self):
        connection = self._connection
        if connection is None:
            return None
        sock = connection.sock
        if sock is None or _socket_dropped(sock):
            self.close()
            return None
        return connection

    def _connect(self, budget):
        connection = None
        try:
            connection = self.transport.new_connection(budget)
            connection.connect()
        except UsbmuxError as exc:
            reason = exc.reason
        except ConnectionRefusedError:
            reason = "connection_refused"
        except (OSError, http.client.HTTPException, ValueError):
            reason = "connection_failed"
        else:
            self._connection = connection
            return connection
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        raise ToolError("service_unreachable", "Could not reach the iPhone service; nothing was sent.",
                        details={"phase": "connect", "reason": reason})

    # -- requests --

    def request(self, method, path, payload=None, timeout=None) -> dict:
        """Send one request and return the whole parsed JSON object.

        Reads get two attempts within one deadline; mutations get exactly one.
        Bad arguments (method, path, a payload that is not JSON) raise ValueError or
        TypeError before anything is sent.
        """
        if isinstance(method, str):
            method = method.upper()
        _validate_request_line(method, path)
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        budget = self.timeout if timeout is None else float(timeout)
        deadline = time.monotonic() + budget
        read = self.is_read(method, path)
        attempts = 2 if read else 1
        for attempt in range(attempts):
            try:
                return self._request_once(method, path, body, deadline, read)
            except ToolError as exc:
                retry = (read and attempt + 1 < attempts and exc.code == "service_unreachable"
                         and time.monotonic() < deadline)
                if not retry:
                    raise
        raise AssertionError("unreachable")  # pragma: no cover

    def _request_once(self, method, path, body, deadline, read) -> dict:
        started = time.monotonic()
        record = {"status": None, "error": None, "bytes": 0}
        try:
            return self._exchange(method, path, body, deadline, read, record)
        except ToolError as exc:
            record["error"] = exc.code
            raise
        finally:
            self.records.append({
                "method": method,
                "endpoint": normalize_endpoint(path),
                "seconds": round(time.monotonic() - started, 4),
                "status": record["status"],
                "error": record["error"],
                "bytes": record["bytes"],
            })

    def _exchange(self, method, path, body, deadline, read, record) -> dict:
        budget = deadline - time.monotonic()
        if budget <= 0:
            raise ToolError("service_unreachable", "The iPhone service did not answer in time; nothing was sent.",
                            details={"phase": "deadline"})
        connection = self._reusable_connection()
        if connection is None:
            connection = self._connect(budget)
        sock = connection.sock
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ToolError("service_unreachable", "The iPhone service did not answer in time; nothing was sent.",
                            details={"phase": "deadline"})
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        cap = MAX_RESPONSE_BYTES
        try:
            sock.settimeout(remaining)
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            record["status"] = response.status
            raw = self._read_body(response, sock, deadline, cap)
            response.close()  # Python 3.9: read1 leaves the response open; close it to reuse the connection
            if response.will_close:
                self.close()
        except (OSError, http.client.HTTPException):
            self.close()
            if read:
                raise ToolError("service_unreachable", _UNREACHABLE_READ, details={"phase": "read"}) from None
            raise ToolError("action_uncertain", _UNCERTAIN, uncertain=True, details={"phase": "response"}) from None
        record["bytes"] = len(raw)
        return self._interpret(response.status, raw, read, cap)

    @staticmethod
    def _read_body(response, sock, deadline, cap) -> bytes:
        chunks = []
        size = 0
        limit = cap + 1
        while size < limit and not response.isclosed():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("WDA response deadline expired")
            sock.settimeout(remaining)
            chunk = response.read1(min(READ_CHUNK, limit - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b"".join(chunks)

    def _interpret(self, status, raw, read, cap) -> dict:
        uncertain = not read
        if len(raw) > cap:
            self.close()
            raise ToolError("response_too_large", "The iPhone service answer is larger than 24 MiB.",
                            uncertain=uncertain)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            parsed = None
        if not isinstance(parsed, dict):
            if uncertain:
                self.close()
            raise ToolError("invalid_response", "The iPhone service returned an unreadable answer.",
                            uncertain=uncertain)
        value = parsed.get("value")
        if isinstance(value, dict) and isinstance(value.get("error"), str) and value["error"]:
            code = value["error"]
            message = value.get("message")
            if not isinstance(message, str) or not message:
                message = code
            raise ToolError(code, message[:WDA_MESSAGE_LIMIT])
        if status >= 400:
            if uncertain:
                self.close()
            raise ToolError("http_error", "The iPhone service returned HTTP %d." % status,
                            uncertain=uncertain, details={"http_status": status})
        return parsed

    # -- sessions --

    def _remaining(self, deadline) -> float:
        return deadline - time.monotonic()

    def _create_session(self, deadline) -> str:
        try:
            result = self.request("POST", "/session", SESSION_CAPABILITIES, timeout=self._remaining(deadline))
        except ToolError as exc:
            raise self._setup_failure(exc, "create_session") from None
        value = result.get("value")
        sid = result.get("sessionId")
        if not sid and isinstance(value, dict):
            sid = value.get("sessionId")
        if not isinstance(sid, str) or not SID_RE.fullmatch(sid):
            raise ToolError("invalid_response", "The iPhone service did not return a session ID.",
                            details={"operation": "create_session"})
        return sid

    def _apply_settings(self, sid, deadline) -> None:
        self.request("POST", "/session/%s/appium/settings" % sid, {"settings": dict(SESSION_SETTINGS)},
                     timeout=self._remaining(deadline))

    @staticmethod
    def _setup_failure(exc, operation) -> ToolError:
        """Session creation and settings are not phone actions: never report them as uncertain."""
        if exc.code == "action_uncertain":
            return ToolError("service_unreachable",
                             "The iPhone service did not finish setting up a session; nothing on the phone was "
                             "changed.", details={"operation": operation, "phase": "response"})
        exc.uncertain = False
        exc.details.setdefault("operation", operation)
        return exc

    def ensure_session(self, timeout=None) -> str:
        """Return a usable session id, creating the session and applying settings when needed.

        Settings go once per session id. An adopted id that WDA no longer knows is
        replaced by one fresh session within the same deadline.
        """
        deadline = time.monotonic() + (SESSION_TIMEOUT if timeout is None else float(timeout))
        if self.session_id is not None and not (
                isinstance(self.session_id, str) and SID_RE.fullmatch(self.session_id)):
            self.session_id = None
        may_replace = True
        while True:
            created = False
            if not self.session_id:
                self._settings_sid = None
                self.session_id = self._create_session(deadline)
                created = True
            sid = self.session_id
            if self._settings_sid == sid:
                return sid
            try:
                self._apply_settings(sid, deadline)
            except ToolError as exc:
                if exc.code == "invalid session id":
                    self.session_id = None
                    self._settings_sid = None
                    if not created and may_replace:
                        may_replace = False
                        continue
                failure = self._setup_failure(exc, "session_settings")
                failure.details.update({"operation": "session_settings", "settings_applied": False})
                raise failure from None
            self._settings_sid = sid
            return sid

    def session(self, method, path, payload=None, timeout=None):
        """Run a request inside the session (/session/{sid}{path}) and return its "value"."""
        deadline = time.monotonic() + (self.timeout if timeout is None else float(timeout))
        for attempt in (0, 1):
            try:
                sid = self.ensure_session(self._remaining(deadline))
                result = self.request(method, "/session/" + sid + path, payload, self._remaining(deadline))
                return result.get("value")
            except ToolError as exc:
                if exc.code != "invalid session id":
                    raise
                self.session_id = None
                self._settings_sid = None
                # Element ids never cross sessions, and mutations are never replayed.
                if attempt == 0 and self.is_read(method, path) and not path.startswith("/element/"):
                    continue
                raise
        raise AssertionError("unreachable")  # pragma: no cover

    def reapply_settings(self) -> None:
        """Forget that settings were applied, so the next ensure_session sends them again."""
        self._settings_sid = None

    # -- metrics --

    def metrics(self) -> dict:
        records = list(self.records)
        endpoints = {}
        for record in records:
            entry = endpoints.setdefault(record["endpoint"],
                                         {"count": 0, "seconds": 0.0, "max_seconds": 0.0, "bytes": 0})
            entry["count"] += 1
            entry["seconds"] += record["seconds"]
            entry["max_seconds"] = max(entry["max_seconds"], record["seconds"])
            entry["bytes"] += record["bytes"]
        for entry in endpoints.values():
            entry["seconds"] = round(entry["seconds"], 4)
        return {
            "requests": len(records),
            "http_seconds": round(sum(r["seconds"] for r in records), 4),
            "http_bytes": sum(r["bytes"] for r in records),
            "errors": sum(1 for r in records if r["error"]),
            "endpoints": endpoints,
        }

    def clear_metrics(self) -> None:
        self.records.clear()
