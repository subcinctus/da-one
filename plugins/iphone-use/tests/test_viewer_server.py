import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import errno  # noqa: E402
import http.client  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import viewer_server  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import short_tmpdir  # noqa: E402
from fake_wda import TINY_JPEG, FakeWDA  # noqa: E402
from fakes_cmd import FakeRunner  # noqa: E402
from screen_hub import ScreenHub  # noqa: E402
from viewer_server import PreviewManager, PreviewServer, copy_png_to_clipboard, open_in_browser  # noqa: E402

VIEWER = os.path.join(os.path.dirname(HERE), "viewer")
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
SECURITY = {"cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
            "referrer-policy": "no-referrer", "content-security-policy": CSP}
HEX32 = re.compile(r"[0-9a-f]{32}")
PART_HEAD = re.compile(rb"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ([0-9]+)\r\n\r\n")


def eventually(predicate, timeout=2.0, message="condition not reached"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


def request(port, method, path, body=None, headers=None, host="default"):
    """One HTTP request with full control of Host; returns (status, lower-case headers, body)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if host == "default":
            host = "127.0.0.1:%d" % port
        if host is not None:
            for value in (host if isinstance(host, list) else [host]):
                connection.putheader("Host", value)
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        if body is not None:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        data = response.read() if method != "HEAD" else b""
        return response.status, {name.lower(): value for name, value in response.getheaders()}, data
    finally:
        connection.close()


def raw_exchange(port, data, timeout=5):
    """Send raw bytes, return everything the server answers until it closes."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(data)
        chunks = []
        while True:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)


class StreamClient:
    """A raw streaming GET (MJPEG or SSE) that the test reads incrementally."""

    def __init__(self, port, path):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n" % (path, port)).encode())
        self.buffer = b""
        self.closed = False
        while b"\r\n\r\n" not in self.buffer:
            if not self._fill(5):
                break
        head, _, self.buffer = self.buffer.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        self.status = int(lines[0].split()[1])
        self.headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            self.headers[name.strip().lower()] = value.strip()

    def _fill(self, timeout):
        self.sock.settimeout(max(0.01, timeout))
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            return False
        except OSError:
            chunk = b""
        if not chunk:
            self.closed = True
            return False
        self.buffer += chunk
        return True

    def read_part(self, timeout=2.0):
        """The next MJPEG part's JPEG (strict format), or None."""
        deadline = time.monotonic() + timeout
        while True:
            match = PART_HEAD.match(self.buffer)
            if match:
                length = int(match.group(1))
                end = match.end() + length + 2
                if len(self.buffer) >= end:
                    jpeg = self.buffer[match.end():match.end() + length]
                    assert self.buffer[end - 2:end] == b"\r\n", "part must end with CRLF"
                    self.buffer = self.buffer[end:]
                    return jpeg
            elif len(self.buffer) >= 9 and not self.buffer.startswith(b"--frame\r\n"):
                raise AssertionError("unexpected stream bytes: %r" % self.buffer[:40])
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.closed or not self._fill(remaining):
                if self.closed or remaining <= 0:
                    return None

    def read_sse(self, timeout=2.0):
        """The next SSE block (text up to a blank line), or None."""
        deadline = time.monotonic() + timeout
        while b"\n\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.closed:
                return None
            self._fill(remaining)
        block, _, self.buffer = self.buffer.partition(b"\n\n")
        return block.decode("utf-8")

    def read_state(self, timeout=2.0):
        """The data of the next `event: state` block (skipping keepalives), or None."""
        deadline = time.monotonic() + timeout
        while True:
            block = self.read_sse(max(0.0, deadline - time.monotonic()))
            if block is None:
                return None
            if block.startswith("event: state\ndata: "):
                return json.loads(block[len("event: state\ndata: "):])

    def wait_closed(self, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not self.closed and time.monotonic() < deadline:
            self._fill(deadline - time.monotonic())
        return self.closed

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Actions:
    """on_action stand-in recording every call."""

    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def __call__(self, action):
        self.calls.append(action)
        if self.error is not None:
            raise self.error
        return self.result if self.result is not None else {"ok": True, "action": action}


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state_dir = os.path.join(self.root, "state")
        os.mkdir(self.state_dir, 0o700)

    def make_hub(self, opener=None):
        hub = ScreenHub(self.state_dir, opener=opener)
        self.addCleanup(hub.close)
        return hub

    def make_server(self, hub=None, actions=None, **kwargs):
        hub = hub or self.make_hub()
        actions = actions or Actions()
        server = PreviewServer(hub, VIEWER, actions, port=kwargs.pop("port", 0), **kwargs)
        server.start()
        self.addCleanup(server.stop)
        return server, hub, actions

    def wda_hub(self, mode="normal", frames=None):
        fake = FakeWDA(mjpeg=True, mjpeg_fps=20, mjpeg_mode=mode).start()
        self.addCleanup(fake.stop)
        if frames:
            fake.mjpeg_frames = frames
        hub = self.make_hub(lambda: socket.create_connection(("127.0.0.1", fake.mjpeg_port), timeout=5))
        return hub, fake

    def stream_client(self, server, path):
        client = StreamClient(server.port, "/%s/%s" % (server.token, path))
        self.addCleanup(client.close)
        return client

    def assert_security_headers(self, headers, label=""):
        for name, value in SECURITY.items():
            self.assertEqual(headers.get(name), value, "%s %s" % (label, name))
        self.assertEqual(headers.get("server"), "iphone-use", label)
        self.assertFalse([name for name in headers if name.startswith("access-control-")], label)


class RouteTests(ServerCase):
    def test_index_and_assets(self):
        server, _, _ = self.make_server()
        for path, filename, content_type in (("", "index.html", "text/html; charset=utf-8"),
                                             ("app.js", "app.js", "text/javascript; charset=utf-8"),
                                             ("style.css", "style.css", "text/css; charset=utf-8")):
            status, headers, body = request(server.port, "GET", "/%s/%s" % (server.token, path))
            with open(os.path.join(VIEWER, filename), "rb") as handle:
                expected = handle.read()
            self.assertEqual((status, headers["content-type"], body), (200, content_type, expected))
            self.assert_security_headers(headers, path)
            status, headers, body = request(server.port, "HEAD", "/%s/%s" % (server.token, path))
            self.assertEqual((status, headers["content-length"], body), (200, str(len(expected)), b""))

    def test_query_strings_are_ignored_on_assets(self):
        server, _, _ = self.make_server()
        status, _, _ = request(server.port, "GET", "/%s/app.js?v=3" % server.token)
        self.assertEqual(status, 200)

    def test_token_without_slash_redirects(self):
        server, _, _ = self.make_server()
        for method in ("GET", "HEAD"):
            status, headers, body = request(server.port, method, "/" + server.token)
            self.assertEqual((status, headers["location"], body), (308, "/%s/" % server.token, b""))
            self.assert_security_headers(headers, "308")

    def test_wrong_or_missing_token_is_404_and_reveals_nothing(self):
        server, _, _ = self.make_server()
        token = server.token
        for path in ("/", "/app.js", "/index.html", "/api/health", "/x/api/health", "/%s/" % ("0" * 32),
                     "/%sx/" % token, "/%s/" % token.upper(), "/%s/" % token[:-1], "/%s%%2f" % token,
                     "/%%2f%s/" % token, "http://127.0.0.1/%s/" % token):
            for method in ("GET", "POST"):
                status, headers, body = request(server.port, method, path, body=b"" if method == "POST" else None)
                self.assertEqual(status, 404, path)
                self.assertNotIn(token.encode(), body)
                self.assert_security_headers(headers, path)

    def test_no_path_traversal(self):
        server, _, _ = self.make_server()
        with open(os.path.join(self.state_dir, "config.json"), "w") as handle:
            handle.write('{"team_id": "SECRET1234"}')
        token = server.token
        for rest in ("../config.json", "%2e%2e/config.json", "..%2fconfig.json", "%2E%2E%2Fconfig.json",
                     "./app.js", "/app.js", "app.js/", "APP.JS", "index.html", "viewer/app.js",
                     "../../server/screen_hub.py", "%2fetc%2fpasswd", "..\\app.js", "app.js%00",
                     "stream.mjpeg/../app.js", "api/../app.js", "api/state/", "api", "events/"):
            status, _, body = request(server.port, "GET", "/%s/%s" % (token, rest))
            self.assertEqual(status, 404, rest)
            self.assertNotIn(b"SECRET1234", body)
            self.assertNotIn(b"import ", body)

    def test_host_header_is_checked(self):
        server, _, _ = self.make_server()
        path = "/%s/" % server.token
        port = server.port
        for host in ("evil.example:%d" % port, "evil.example", "127.0.0.1:%d" % (port + 1), "127.0.0.1",
                     "localhost", "[::1]:%d" % port, "0.0.0.0:%d" % port, None,
                     ["127.0.0.1:%d" % port, "evil.example"]):
            status, headers, _ = request(port, "GET", path, host=host)
            self.assertEqual(status, 403, host)
            self.assert_security_headers(headers, "403")
        for host in ("localhost:%d" % port, "LOCALHOST:%d" % port, "127.0.0.1:%d" % port):
            self.assertEqual(request(port, "GET", path, host=host)[0], 200, host)

    def test_other_methods_are_405_without_cors(self):
        server, _, actions = self.make_server()
        for method in ("PUT", "DELETE", "OPTIONS", "PATCH", "TRACE", "PROPFIND"):
            for rest in ("", "api/action", "api/state"):
                status, headers, _ = request(server.port, method, "/%s/%s" % (server.token, rest),
                                             headers={"Origin": "http://evil.example",
                                                      "Access-Control-Request-Method": "POST"})
                self.assertEqual(status, 405, (method, rest))
                self.assertEqual(headers.get("allow"), "GET, HEAD, POST")
                self.assert_security_headers(headers, method)
        self.assertEqual(actions.calls, [])

    def test_wrong_method_on_known_routes(self):
        server, _, actions = self.make_server()
        token = server.token
        for method, rest in (("GET", "api/action"), ("HEAD", "api/action"), ("POST", ""), ("POST", "app.js"),
                             ("POST", "stream.mjpeg"), ("HEAD", "stream.mjpeg"), ("HEAD", "events"),
                             ("POST", "events"), ("POST", "api/state"), ("POST", "api/health")):
            body = b'{"action": "home"}' if method == "POST" else None
            headers = {"Content-Type": "application/json"} if method == "POST" else None
            status, _, _ = request(server.port, method, "/%s/%s" % (token, rest), body=body, headers=headers)
            self.assertEqual(status, 405, (method, rest))
        self.assertEqual(actions.calls, [])

    def test_malformed_requests_get_security_headers(self):
        server, _, _ = self.make_server()
        for data in (b"GARBAGE\r\n\r\n", b"GET /x HTTP/9.9\r\n\r\n", b"GET " + b"a" * 70000 + b" HTTP/1.1\r\n\r\n"):
            answer = raw_exchange(server.port, data)
            head = answer.split(b"\r\n\r\n", 1)[0].decode("latin-1").lower()
            self.assertRegex(head.split("\r\n")[0], r"^http/1\.[01] (400|414|505) ", data[:20])
            self.assertIn("content-security-policy: " + CSP.lower(), head)
            self.assertIn("x-frame-options: deny", head)

    def test_keep_alive_serves_several_requests(self):
        server, _, _ = self.make_server()
        connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
        try:
            for _ in range(3):
                connection.request("GET", "/%s/api/health" % server.token)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["name"], "iphone-use")
        finally:
            connection.close()

    def test_api_health(self):
        server, hub, _ = self.make_server()
        status, headers, body = request(server.port, "GET", "/%s/api/health" % server.token)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {"ok": True, "name": "iphone-use", "version": "0.1.0", "viewers": 0})
        viewer = hub.attach_viewer()
        self.assertEqual(json.loads(request(server.port, "GET", "/%s/api/health" % server.token)[2])["viewers"], 1)
        hub.detach_viewer(viewer)
        self.assert_security_headers(headers)

    def test_api_state(self):
        server, hub, _ = self.make_server()
        hub.set_viewport({"width": 390, "height": 844})
        hub.gesture("tap", point={"x": 10, "y": 20})
        hub.gesture("tap", point={"x": 30, "y": 40})
        status, headers, body = request(server.port, "GET", "/%s/api/state" % server.token)
        self.assertEqual(status, 200)
        self.assert_security_headers(headers)
        state = json.loads(body)
        expected = hub.state()
        for key in ("server_time",):
            state.pop(key)
            expected.pop(key)
        self.assertEqual(state, expected)
        self.assertEqual(len(state["events"]), 2)
        filtered = json.loads(request(server.port, "GET", "/%s/api/state?last_event_id=1" % server.token)[2])
        self.assertEqual([event["id"] for event in filtered["events"]], [2])
        self.assertNotIn("pause_id", body.decode())
        big = json.loads(request(server.port, "GET", "/%s/api/state?last_event_id=%d" % (server.token, 2 ** 53))[2])
        self.assertEqual(big["events"], [])

    def test_api_state_rejects_bad_event_ids(self):
        server, _, _ = self.make_server()
        for query in ("last_event_id=-1", "last_event_id=abc", "last_event_id=1.5", "last_event_id=",
                      "last_event_id=%d" % (2 ** 53 + 1), "last_event_id=1&last_event_id=2",
                      "last_event_id=%2B1", "last_event_id=99999999999999999"):
            status, headers, body = request(server.port, "GET", "/%s/api/state?%s" % (server.token, query))
            self.assertEqual(status, 400, query)
            self.assertEqual(json.loads(body)["error"]["code"], "invalid_argument")
            self.assert_security_headers(headers)

    def test_binds_loopback_only(self):
        server, _, _ = self.make_server()
        self.assertEqual(server._server.server_address[0], "127.0.0.1")
        self.assertEqual(server.url, "http://127.0.0.1:%d/%s/" % (server.port, server.token))
        self.assertTrue(server.running)


class ActionTests(ServerCase):
    def post(self, server, body, headers=None, content_type="application/json"):
        all_headers = {}
        if content_type is not None:
            all_headers["Content-Type"] = content_type
        all_headers.update(headers or {})
        return request(server.port, "POST", "/%s/api/action" % server.token, body=body, headers=all_headers)

    def test_valid_actions_call_on_action_once(self):
        server, _, actions = self.make_server()
        for action in ("refresh", "home", "screenshot"):
            status, headers, body = self.post(server, json.dumps({"action": action}).encode())
            self.assertEqual((status, json.loads(body)), (200, {"ok": True, "action": action}))
            self.assert_security_headers(headers)
        self.assertEqual(actions.calls, ["refresh", "home", "screenshot"])

    def test_same_origin_browser_headers_are_accepted(self):
        server, _, actions = self.make_server()
        port = server.port
        for origin in ("http://127.0.0.1:%d" % port, "http://localhost:%d" % port):
            status, _, _ = self.post(server, b'{"action":"home"}', {"Origin": origin, "Sec-Fetch-Site": "same-origin"},
                                     content_type="application/json; charset=utf-8")
            self.assertEqual(status, 200)
        self.assertEqual(actions.calls, ["home", "home"])

    def test_post_matrix_never_calls_on_action(self):
        server, _, actions = self.make_server()
        port = server.port
        good = b'{"action": "home"}'
        cases = [
            (403, good, None, {}),
            (403, good, "text/plain", {}),
            (403, good, "application/x-www-form-urlencoded", {}),
            (403, good, "multipart/form-data; boundary=x", {}),
            (403, good, "application/json", {"Origin": "http://evil.example"}),
            (403, good, "application/json", {"Origin": "null"}),
            (403, good, "application/json", {"Origin": "http://127.0.0.1:%d" % (port + 1)}),
            (403, good, "application/json", {"Origin": "https://127.0.0.1:%d" % port}),
            (403, good, "application/json", {"Sec-Fetch-Site": "cross-site"}),
            (403, good, "application/json", {"Sec-Fetch-Site": "same-site"}),
            (403, good, "application/json", {"Sec-Fetch-Site": "none"}),
            (400, b'{"action": "home", "pad": "' + b"x" * 1100 + b'"}', "application/json", {}),
            (400, b"", "application/json", {}),
            (400, b"{not json", "application/json", {}),
            (400, b"[\"home\"]", "application/json", {}),
            (400, b'"home"', "application/json", {}),
            (400, b'{"action": "home", "extra": 1}', "application/json", {}),
            (400, b'{"action": "reboot"}', "application/json", {}),
            (400, b'{"action": "HOME"}', "application/json", {}),
            (400, b'{"action": ["home"]}', "application/json", {}),
            (400, b'{"action": "home", "action": "refresh"}', "application/json", {}),
            (400, b'{"action": NaN}', "application/json", {}),
            (400, b"\xff\xfe{}", "application/json", {}),
            (400, b"{}", "application/json", {}),
        ]
        for status, body, content_type, headers in cases:
            answer, answer_headers, answer_body = self.post(server, body, headers, content_type)
            self.assertEqual(answer, status, (body[:40], content_type, headers))
            self.assertFalse(json.loads(answer_body)["ok"])
            self.assert_security_headers(answer_headers)
        self.assertEqual(actions.calls, [])

    def test_chunked_and_missing_length_bodies_are_refused(self):
        server, _, actions = self.make_server()
        head = "POST /%s/api/action HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\n" % (
            server.token, server.port)
        chunked = (head + "Transfer-Encoding: chunked\r\n\r\n").encode() + b"11\r\n{\"action\":\"home\"}\r\n0\r\n\r\n"
        self.assertTrue(raw_exchange(server.port, chunked).startswith(b"HTTP/1.1 400 "))
        no_length = (head + "Connection: close\r\n\r\n").encode()
        self.assertTrue(raw_exchange(server.port, no_length).startswith(b"HTTP/1.1 400 "))
        self.assertEqual(actions.calls, [])

    def test_tool_errors_and_failures_become_envelopes(self):
        cases = [
            (Actions(error=ToolError("device_busy", "The iPhone is busy.", details={"action_executed": False})),
             {"ok": False, "error": {"code": "device_busy", "message": "The iPhone is busy.", "uncertain": False,
                                     "action_executed": False}}),
            (Actions(error=RuntimeError("boom with secret")), viewer_server.INTERNAL_ERROR),
            (Actions(result=["not", "a", "dict"]), viewer_server.INTERNAL_ERROR),
            (Actions(result={"ok": True, "value": float("nan")}), viewer_server.INTERNAL_ERROR),
            (Actions(result={"ok": False, "error": {"code": "preview_paused", "message": "Paused."}}),
             {"ok": False, "error": {"code": "preview_paused", "message": "Paused."}}),
        ]
        for actions, expected in cases:
            server, _, _ = self.make_server(actions=actions)
            status, _, body = self.post(server, b'{"action": "screenshot"}')
            self.assertEqual((status, json.loads(body)), (200, expected))
            self.assertNotIn(b"secret", body)
            server.stop()

    def test_internal_error_envelope(self):
        self.assertEqual(viewer_server.INTERNAL_ERROR["error"]["code"], "internal_error")
        self.assertTrue(viewer_server.INTERNAL_ERROR["error"]["uncertain"])


class StreamTests(ServerCase):
    def test_stream_sends_multipart_parts(self):
        first = TINY_JPEG
        second = TINY_JPEG[:-2] + b"\x00\xff\xd9"
        hub, _ = self.wda_hub(frames=[first, second])
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg?g=1")
        self.assertEqual(client.status, 200)
        self.assertEqual(client.headers["content-type"], "multipart/x-mixed-replace; boundary=frame")
        self.assertEqual(client.headers["connection"], "close")
        self.assert_security_headers(client.headers, "stream")
        parts = [client.read_part() for _ in range(4)]
        self.assertTrue(all(part in (first, second) for part in parts), parts)
        self.assertEqual(hub.viewer_count(), 1)

    def test_relay_is_paced_to_four_frames_per_second(self):
        hub, _ = self.wda_hub()
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg")
        self.assertIsNotNone(client.read_part())
        started = time.monotonic()
        count = 0
        while time.monotonic() - started < 0.75:
            if client.read_part(timeout=1.0) is not None:
                count += 1
        self.assertLessEqual(count, 4)              # 20 fps from WDA, at most 4 parts per second relayed
        self.assertGreaterEqual(count, 2)

    def test_a_still_frame_is_sent_again(self):
        hub, _ = self.wda_hub("stall_after:1")
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg")
        started = time.monotonic()
        parts = []
        while len(parts) < 3 and time.monotonic() - started < 1.5:
            part = client.read_part(timeout=1.0)
            if part is not None:
                parts.append(part)
        self.assertEqual(parts, [TINY_JPEG] * 3)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_closed_clients_free_their_slots(self):
        hub, _ = self.wda_hub("stall_after:1")
        server, _, _ = self.make_server(hub)
        clients = [self.stream_client(server, "stream.mjpeg") for _ in range(viewer_server.MAX_STREAMS)]
        for client in clients:
            self.assertEqual(client.status, 200)
            self.assertIsNotNone(client.read_part())
        refused = self.stream_client(server, "stream.mjpeg")
        self.assertEqual(refused.status, 503)
        self.assertEqual(refused.headers.get("retry-after"), "2")
        self.assert_security_headers(refused.headers, "503")
        self.assertEqual(hub.viewer_count(), viewer_server.MAX_STREAMS)
        for client in clients:
            client.close()
        started = time.monotonic()
        eventually(lambda: hub.viewer_count() == 0, timeout=0.5, message="viewers were not detached")
        self.assertLess(time.monotonic() - started, 0.5)
        accepted = self.stream_client(server, "stream.mjpeg")
        self.assertEqual(accepted.status, 200)
        self.assertEqual(accepted.read_part(), TINY_JPEG)

    def test_stream_ends_on_pause_and_is_refused_while_paused(self):
        hub, _ = self.wda_hub()
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg")
        self.assertIsNotNone(client.read_part())
        hub.set_paused(True)
        while client.read_part(timeout=1.0) is not None:
            pass
        self.assertTrue(client.wait_closed(1.0))
        eventually(lambda: hub.viewer_count() == 0)
        refused = self.stream_client(server, "stream.mjpeg")
        self.assertEqual(refused.status, 503)
        self.assertIsNone(hub.latest_frame())

    def test_stream_ends_on_restart(self):
        hub, _ = self.wda_hub()
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg")
        self.assertIsNotNone(client.read_part())
        hub.restart()
        self.assertTrue(client.wait_closed(1.5))

    def test_stream_ends_on_server_stop(self):
        hub, _ = self.wda_hub()
        server, _, _ = self.make_server(hub)
        client = self.stream_client(server, "stream.mjpeg")
        self.assertIsNotNone(client.read_part())
        started = time.monotonic()
        server.stop()
        self.assertTrue(client.wait_closed(1.5))
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertFalse(server.running)
        eventually(lambda: hub.viewer_count() == 0)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", server.port), timeout=1).close()


class EventTests(ServerCase):
    def test_first_event_and_change_pushes(self):
        server, hub, _ = self.make_server()
        client = self.stream_client(server, "events")
        self.assertEqual(client.status, 200)
        self.assertEqual(client.headers["content-type"], "text/event-stream; charset=utf-8")
        self.assert_security_headers(client.headers, "events")
        self.assertEqual(client.read_sse(), "retry: 2000")
        first = client.read_state()
        self.assertEqual(first["paused"], False)
        self.assertEqual(first["stream_id"], hub.stream_id)
        hub.set_paused(True, "device_locked")
        paused = client.read_state()
        self.assertEqual((paused["paused"], paused["pause_reason"]), (True, "device_locked"))
        self.assertNotIn("pause_id", paused)
        hub.set_paused(False)
        self.assertFalse(client.read_state()["paused"])
        hub.gesture("tap", point={"x": 5, "y": 6})
        with_event = client.read_state()
        self.assertEqual([(event["id"], event["kind"]) for event in with_event["events"]], [(1, "tap")])
        hub.set_viewport({"width": 390, "height": 844})
        after = client.read_state()
        self.assertEqual(after["viewport"], {"width": 390, "height": 844})
        self.assertEqual(after["events"], [])                      # event ids are never sent twice
        hub.gesture("tap", point={"x": 7, "y": 8})
        self.assertEqual([event["id"] for event in client.read_state()["events"]], [2])

    def test_frame_sequence_changes_do_not_push(self):
        hub, _ = self.wda_hub()
        server, _, _ = self.make_server(hub)
        viewer = self.stream_client(server, "stream.mjpeg")
        self.assertIsNotNone(viewer.read_part())
        self.assertIsNotNone(viewer.read_part())
        client = self.stream_client(server, "events")
        self.assertEqual(client.read_sse(), "retry: 2000")
        first = client.read_state()
        self.assertTrue(first["frame_available"])
        self.assertIsNone(client.read_state(timeout=0.6))
        self.assertGreater(hub.state()["seq"], 0)

    def test_keepalive(self):
        server, _, _ = self.make_server()
        with mock.patch.object(viewer_server, "SSE_KEEPALIVE", 0.3):
            client = self.stream_client(server, "events")
            self.assertEqual(client.read_sse(), "retry: 2000")
            self.assertIsNotNone(client.read_state())
            self.assertEqual(client.read_sse(timeout=1.5), ": keepalive")

    def test_event_stream_limit_and_release(self):
        server, _, _ = self.make_server()
        clients = [self.stream_client(server, "events") for _ in range(viewer_server.MAX_EVENT_STREAMS)]
        for client in clients:
            self.assertEqual(client.status, 200)
            self.assertEqual(client.read_sse(), "retry: 2000")
        refused = self.stream_client(server, "events")
        self.assertEqual(refused.status, 503)
        clients[0].close()
        eventually(lambda: self.stream_client(server, "events").status == 200, timeout=1.5)

    def test_server_stop_ends_event_streams(self):
        server, _, _ = self.make_server()
        client = self.stream_client(server, "events")
        self.assertIsNotNone(client.read_state())
        server.stop()
        self.assertTrue(client.wait_closed(1.5))


class LifecycleTests(ServerCase):
    def test_busy_port_falls_back_to_an_ephemeral_port(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(blocker.close)
        blocker.bind(("127.0.0.1", 0))
        blocker.listen(1)
        busy = blocker.getsockname()[1]
        hub = self.make_hub()
        server = PreviewServer(hub, VIEWER, Actions(), port=busy)
        server.start()
        self.addCleanup(server.stop)
        self.assertNotEqual(server.port, busy)
        self.assertEqual(request(server.port, "GET", "/%s/api/health" % server.token)[0], 200)
        strict = PreviewServer(hub, VIEWER, Actions(), port=busy)
        with self.assertRaises(OSError) as caught:
            strict.start(fallback_ephemeral=False)
        self.assertEqual(caught.exception.errno, errno.EADDRINUSE)
        self.assertFalse(strict.running)

    def test_tokens_are_random_per_start(self):
        hub = self.make_hub()
        first, _, _ = self.make_server(hub)
        second, _, _ = self.make_server(hub)
        self.assertTrue(HEX32.fullmatch(first.token))
        self.assertTrue(HEX32.fullmatch(second.token))
        self.assertNotEqual(first.token, second.token)
        self.assertEqual(request(first.port, "GET", "/%s/" % second.token)[0], 404)
        fixed, _, _ = self.make_server(hub, token="ab" * 16)
        self.assertEqual(fixed.token, "ab" * 16)
        for bad in ("short", "AB" * 16, "zz" * 16, 5):
            with self.assertRaises(ValueError):
                PreviewServer(hub, VIEWER, Actions(), token=bad)

    def test_start_twice_and_stop_twice(self):
        server, _, _ = self.make_server()
        self.assertEqual(server.start(), server.url)
        server.stop()
        server.stop()
        self.assertFalse(server.running)


class ManagerTests(ServerCase):
    def manager(self, hub=None, allow_start=True, port=0):
        manager = PreviewManager(self.state_dir, hub or self.make_hub(), VIEWER, Actions(), preferred_port=port,
                                 allow_start=allow_start)
        self.addCleanup(manager.stop)
        return manager

    def record(self):
        with open(os.path.join(self.state_dir, "preview.json")) as handle:
            return json.load(handle)

    def write_record(self, pid, port, token):
        with open(os.path.join(self.state_dir, "preview.json"), "w") as handle:
            json.dump({"pid": pid, "port": port, "token": token, "url": "http://127.0.0.1:%d/%s/" % (port, token),
                       "started_at": "2026-10-08T12:00:00+00:00", "version": "0.1.0"}, handle)

    def sleeper(self):
        child = subprocess.Popen(["sleep", "30"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)

        def reap():
            child.kill()
            child.wait(5)
        self.addCleanup(reap)
        return child

    def test_starts_its_own_server_and_records_it(self):
        manager = self.manager()
        info = manager.ensure()
        self.assertTrue(info.owner)
        self.assertEqual(info.url, "http://127.0.0.1:%d/%s/" % (info.port, info.token))
        self.assertEqual(info.viewers, 0)
        record = self.record()
        self.assertEqual(set(record), {"pid", "port", "token", "url", "started_at", "version"})
        self.assertEqual((record["pid"], record["port"], record["token"], record["url"], record["version"]),
                         (os.getpid(), info.port, info.token, info.url, "0.1.0"))
        self.assertEqual(os.stat(os.path.join(self.state_dir, "preview.json")).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(os.path.join(self.state_dir, ".preview.lock")).st_mode & 0o777, 0o600)
        self.assertEqual(manager.ensure(), info)
        self.assertEqual(manager.current(), info)
        self.assertEqual(request(info.port, "GET", "/%s/api/health" % info.token)[0], 200)

    def test_stop_deletes_its_own_record(self):
        manager = self.manager()
        info = manager.ensure()
        manager.stop()
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "preview.json")))
        self.assertIsNone(manager.current())
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", info.port), timeout=1).close()

    def test_stop_keeps_a_record_of_another_process(self):
        manager = self.manager()
        manager.ensure()
        self.write_record(1, 9, "cd" * 16)
        manager.stop()
        self.assertEqual(self.record()["token"], "cd" * 16)

    def test_reuses_another_live_owner(self):
        other_hub = ScreenHub(self.state_dir)
        self.addCleanup(other_hub.close)
        other = PreviewServer(other_hub, VIEWER, Actions(), port=0)
        other.start()
        self.addCleanup(other.stop)
        viewer = other_hub.attach_viewer()
        child = self.sleeper()
        self.write_record(child.pid, other.port, other.token)
        manager = self.manager()
        info = manager.ensure()
        self.assertFalse(info.owner)
        self.assertEqual((info.url, info.port, info.token, info.viewers), (other.url, other.port, other.token, 1))
        self.assertIsNone(manager._server)
        self.assertEqual(manager.current(), info)
        self.assertEqual(self.record()["pid"], child.pid)
        other_hub.detach_viewer(viewer)

    def test_starts_its_own_when_the_recorded_pid_is_dead(self):
        other_hub = ScreenHub(self.state_dir)
        self.addCleanup(other_hub.close)
        other = PreviewServer(other_hub, VIEWER, Actions(), port=0)
        other.start()
        self.addCleanup(other.stop)
        child = subprocess.Popen(["true"])
        child.wait(5)
        self.write_record(child.pid, other.port, other.token)
        info = self.manager().ensure()
        self.assertTrue(info.owner)
        self.assertNotEqual(info.token, other.token)
        self.assertEqual((self.record()["pid"], self.record()["token"]), (os.getpid(), info.token))

    def test_starts_its_own_when_the_recorded_server_does_not_answer(self):
        child = self.sleeper()
        unused = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(unused.close)
        unused.bind(("127.0.0.1", 0))          # bound but not listening: connection refused
        self.write_record(child.pid, unused.getsockname()[1], "ef" * 16)
        info = self.manager().ensure()
        self.assertTrue(info.owner)
        self.assertEqual(self.record()["token"], info.token)

    def test_ignores_a_record_whose_token_is_wrong(self):
        other_hub = ScreenHub(self.state_dir)
        self.addCleanup(other_hub.close)
        other = PreviewServer(other_hub, VIEWER, Actions(), port=0)
        other.start()
        self.addCleanup(other.stop)
        child = self.sleeper()
        self.write_record(child.pid, other.port, "01" * 16)
        self.assertTrue(self.manager().ensure().owner)

    def test_ignores_malformed_records(self):
        for content in ("{not json", "[]", json.dumps({"pid": True, "port": 1, "token": "ab" * 16}),
                        json.dumps({"pid": 1, "port": 70000, "token": "ab" * 16}),
                        json.dumps({"pid": 1, "port": 80, "token": "../etc"})):
            with open(os.path.join(self.state_dir, "preview.json"), "w") as handle:
                handle.write(content)
            manager = self.manager()
            self.assertTrue(manager.ensure().owner, content)
            manager.stop()

    def test_allow_start_false(self):
        manager = self.manager(allow_start=False)
        self.assertIsNone(manager.ensure())
        self.assertIsNone(manager.current())
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "preview.json")))
        other_hub = ScreenHub(self.state_dir)
        self.addCleanup(other_hub.close)
        other = PreviewServer(other_hub, VIEWER, Actions(), port=0)
        other.start()
        self.addCleanup(other.stop)
        child = self.sleeper()
        self.write_record(child.pid, other.port, other.token)
        info = manager.ensure()
        self.assertFalse(info.owner)
        self.assertEqual(info.url, other.url)

    def test_preferred_port_busy_falls_back(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(blocker.close)
        blocker.bind(("127.0.0.1", 0))
        blocker.listen(1)
        info = self.manager(port=blocker.getsockname()[1]).ensure()
        self.assertNotEqual(info.port, blocker.getsockname()[1])
        self.assertTrue(info.owner)

    def test_a_second_manager_in_another_window_reuses_the_first(self):
        first = self.manager()
        info = first.ensure()
        second = self.manager(hub=ScreenHub(self.state_dir))
        self.addCleanup(second.hub.close)
        reused = second.ensure()
        self.assertFalse(reused.owner)
        self.assertEqual(reused.url, info.url)


class DesktopHelperTests(ServerCase):
    def test_copy_png_exact_argv_and_private_temp_file(self):
        seen = {}

        def effect(argv, cwd, env, input_text):
            path = argv[-1]
            seen["path"] = path
            seen["mode"] = os.stat(path).st_mode & 0o777
            with open(path, "rb") as handle:
                seen["data"] = handle.read()
            return None

        runner = FakeRunner().on("osascript", effect=effect)
        data = b"\x89PNG\r\n\x1a\nnot-really-a-png"
        copy_png_to_clipboard(self.state_dir, data, runner)
        self.assertEqual(len(runner.calls), 1)
        call = runner.calls[0]
        self.assertEqual(call.argv[:-1], ["/usr/bin/osascript", "-e", "on run argv", "-e",
                                          "set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)",
                                          "-e", "end run"])
        self.assertEqual(call.timeout, 8)
        self.assertFalse(any(self.state_dir in part for part in call.argv[:-1]))
        self.assertEqual(os.path.dirname(seen["path"]), self.state_dir)
        self.assertTrue(os.path.basename(seen["path"]).startswith(".clipboard-"))
        self.assertTrue(seen["path"].endswith(".png"))
        self.assertEqual((seen["mode"], seen["data"]), (0o600, data))
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertEqual([name for name in os.listdir(self.state_dir) if name.startswith(".clipboard-")], [])

    def test_copy_png_failures_are_clipboard_unavailable(self):
        def raising(argv, timeout=12.0, cwd=None, env=None, input_text=None):
            raise OSError("no osascript")

        for runner, message in ((FakeRunner().on("osascript", returncode=1, stderr="denied"),
                                 "The screenshot was captured but macOS did not accept it on the clipboard."),
                                (FakeRunner(), "The screenshot was captured but macOS did not accept it on the clipboard."),
                                (raising, "The screenshot could not be copied to the clipboard.")):
            with self.assertRaises(ToolError) as caught:
                copy_png_to_clipboard(self.state_dir, b"\x89PNG\r\n\x1a\n", runner)
            self.assertEqual((caught.exception.code, caught.exception.message), ("clipboard_unavailable", message))
            self.assertEqual(caught.exception.details.get("action_executed"), False)
            self.assertEqual([name for name in os.listdir(self.state_dir) if name.startswith(".clipboard-")], [])

    def test_open_in_browser(self):
        url = "http://127.0.0.1:18200/%s/" % ("ab" * 16)
        runner = FakeRunner().on("open")
        self.assertTrue(open_in_browser(url, runner))
        self.assertEqual(runner.calls[0].argv, ["/usr/bin/open", url])
        self.assertEqual(runner.calls[0].timeout, 10)
        self.assertFalse(open_in_browser(url, FakeRunner().on("open", returncode=1)))
        refusing = FakeRunner().on("open")
        for bad in ("https://evil.example/", "http://evil.example:80/", "-a Calculator", "file:///etc/passwd",
                    "http://127.0.0.1:18200/x y", "http://127.0.0.1:18200/'; rm -rf ~", None):
            self.assertFalse(open_in_browser(bad, refusing))
        self.assertEqual(refusing.calls, [])


if __name__ == "__main__":
    unittest.main()
