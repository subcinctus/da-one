import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import http.client  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import wda_client  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fakes_cmd import FakeClock  # noqa: E402
from usbmux import UsbmuxError  # noqa: E402
from wda_client import (  # noqa: E402
    SESSION_CAPABILITIES, SESSION_SETTINGS, TcpTransport, UnconfiguredTransport, UsbmuxTransport, WDAClient,
    resolve_transport, validate_loopback_url)

UDID = "00008110-001A2B3C4D5E6F7A"
# The Host values the plugin's patched WebDriverAgent accepts (wda_setup browser guard); it refuses any Origin.
GUARD_HOST = re.compile(r"(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?")


class ScriptedServer:
    """A tiny HTTP/1.1 keep-alive server driven by a responder function.

    responder(method, path, payload, requests) -> (status, value_or_bytes, delay, close)
      status None   -> drop the connection without answering
      close True    -> answer with "Connection: close", then close
      close "silent"-> answer normally (keep-alive), then close the socket anyway
      close bytes   -> answer, then (a moment later) send these stray bytes and keep the connection
    """

    def __init__(self, responder):
        self.responder = responder
        self.requests = []
        self.peer_ports = []
        self.headers = []
        self.server_closed = threading.Event()
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._connections = []
        self._threads = []
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(16)
        self._listener.settimeout(0.1)
        self.port = self._listener.getsockname()[1]
        self.url = "http://127.0.0.1:%d" % self.port
        self._accept_thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._accept_thread.start()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False

    @property
    def target(self):
        return ("127.0.0.1", self.port)

    def paths(self):
        return [path for _, path, _ in self.requests]

    def close(self):
        self._stopping.set()
        self._shutdown(self._listener)  # wakes a blocked accept() on Linux
        with self._lock:
            connections = list(self._connections)
            threads = list(self._threads)
        for conn in connections:
            self._shutdown(conn)
        self._accept_thread.join(2)
        for thread in threads:
            thread.join(2)

    @staticmethod
    def _shutdown(conn):
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass

    def _accept_loop(self):
        while not self._stopping.is_set():
            try:
                conn, peer = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.settimeout(None)
            thread = threading.Thread(target=self._serve, args=(conn, peer[1]), daemon=True)
            with self._lock:
                self._connections.append(conn)
                self._threads.append(thread)
            thread.start()

    def _serve(self, conn, peer_port):
        reader = conn.makefile("rb")
        try:
            while not self._stopping.is_set():
                line = reader.readline(65537)
                if not line:
                    return
                method, path, _ = line.decode("latin-1").split(" ", 2)
                headers = {}
                while True:
                    header = reader.readline(65537)
                    if header in (b"\r\n", b"\n", b""):
                        break
                    name, _, value = header.decode("latin-1").partition(":")
                    headers[name.strip().lower()] = value.strip()
                length = int(headers.get("content-length", "0") or 0)
                body = reader.read(length) if length else b""
                payload = json.loads(body.decode("utf-8")) if body else None
                with self._lock:
                    self.requests.append((method, path, payload))
                    self.peer_ports.append(peer_port)
                    self.headers.append(headers)
                status, value, delay, close = self.responder(method, path, payload, self.requests)
                if delay:
                    time.sleep(delay)
                if status is None:
                    return
                raw = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode("utf-8")
                head = "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n" % (
                    status, http.client.responses.get(status, "Status"), len(raw))
                if close is True:
                    head += "Connection: close\r\n"
                data = head.encode("latin-1") + b"\r\n" + raw
                try:
                    conn.sendall(data)
                    if isinstance(close, bytes):
                        time.sleep(0.05)  # arrive after the response was consumed, on the idle socket
                        conn.sendall(close)
                except OSError:
                    return
                if close is True or close == "silent":
                    return
        except (OSError, ValueError):
            return
        finally:
            try:
                reader.close()
            except OSError:
                pass
            self._shutdown(conn)
            self.server_closed.set()


def ok(value=None):
    return 200, {"value": value, "sessionId": "abc"}, 0, False


def wda_error(error, message="Failed", status=500, traceback="SECRET TRACEBACK"):
    return status, {"value": {"error": error, "message": message, "traceback": traceback}}, 0, False


def refused_port(test):
    """A loopback port with nothing listening: briefly listened on, then closed, so connects are refused.

    (A bound-but-never-listening socket is refused on Linux but silently times out on macOS.)
    """
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("127.0.0.1", 0))
    holder.listen(1)
    port = holder.getsockname()[1]
    holder.close()
    return port


class ClientTestCase(unittest.TestCase):
    def serve(self, responder):
        server = ScriptedServer(responder)
        self.addCleanup(server.close)
        return server

    def client(self, server_or_transport, timeout=None):
        transport = server_or_transport
        if isinstance(server_or_transport, ScriptedServer):
            transport = TcpTransport(server_or_transport.url)
        client = WDAClient(transport) if timeout is None else WDAClient(transport, timeout=timeout)
        self.addCleanup(client.close)
        return client

    @staticmethod
    def warm_session(client, sid):
        """Model an already configured session so a test isolates command transport."""
        client.session_id = sid
        client._settings_sid = sid

    def assert_tool_error(self, call, code, uncertain=False):
        with self.assertRaises(ToolError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)
        self.assertIs(caught.exception.uncertain, uncertain)
        return caught.exception


class LoopbackUrlTests(unittest.TestCase):
    def test_accepts_loopback_urls(self):
        cases = {
            "http://127.0.0.1:8100": ("127.0.0.1", 8100),
            "http://127.0.0.1:8100/": ("127.0.0.1", 8100),
            "http://localhost:18100": ("localhost", 18100),
            "http://[::1]:8100": ("::1", 8100),
            "http://127.0.0.1": ("127.0.0.1", 80),
            "HTTP://LOCALHOST:8100": ("localhost", 8100),
            "http://127.0.0.1:1": ("127.0.0.1", 1),
            "http://127.0.0.1:65535": ("127.0.0.1", 65535),
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(validate_loopback_url(url), expected)

    def test_rejects_everything_else(self):
        for url in ("http://192.168.1.2:8100", "https://localhost:8100", "http://user@localhost",
                    "http://localhost/api", "http://localhost?token=x", "http://localhost:8100?",
                    "http://localhost:8100#frag", "http://user:pw@127.0.0.1:8100", "http://@127.0.0.1:8100",
                    "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:+80",
                    "http://127.0.0.1:80x", "http://127.0.0.1:", "http://127.0.0.2:8100", "http://0.0.0.0:8100",
                    "http://127.1:8100", "http://2130706433:8100", "http://localhost.:8100",
                    "http://127.0.0.1.nip.io:8100", "http://[::2]:8100", "http://[::ffff:127.0.0.1]:8100",
                    "http://[::1", "http://127.0.0.1:8100;params", " http://127.0.0.1:8100",
                    "http://127.0.0.1:8100\n", "http://127.0.0.1:8100/\t", "ftp://127.0.0.1:21", "127.0.0.1:8100",
                    "//127.0.0.1:8100", "", None, 8100, b"http://127.0.0.1:8100", "http://lоcalhost:8100"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError) as caught:
                    validate_loopback_url(url)
                self.assertEqual(str(caught.exception), "WDA URL must be http://127.0.0.1:<port> (loopback only).")

    def test_tcp_transport_and_client_reject_remote_urls(self):
        for url in ("http://192.168.1.2:8100", "https://localhost:8100", "http://localhost/api"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    TcpTransport(url)
                with self.assertRaises(ValueError):
                    WDAClient(url)


class TransportTests(unittest.TestCase):
    def test_resolve_transport_precedence(self):
        config = {"udid": UDID, "device_port": 8200, "wda_url": "http://127.0.0.1:7000"}
        env = {"IPHONE_USE_WDA_URL": "http://localhost:7100"}
        explicit = resolve_transport(config, env, explicit_url="http://[::1]:7200")
        self.assertEqual((explicit.kind, explicit.identity), ("tcp", "tcp:::1:7200"))
        from_env = resolve_transport(config, env)
        self.assertEqual(from_env.identity, "tcp:localhost:7100")
        from_config = resolve_transport(config, {})
        self.assertEqual(from_config.identity, "tcp:127.0.0.1:7000")
        usb = resolve_transport({"udid": UDID, "device_port": 8200, "wda_url": None}, {"IPHONE_USE_WDA_URL": " "})
        self.assertIsInstance(usb, UsbmuxTransport)
        self.assertEqual((usb.kind, usb.identity), ("usbmux", "usbmux:%s:8200" % UDID))
        default_port = resolve_transport({"udid": UDID, "device_port": True}, {})
        self.assertEqual(default_port.identity, "usbmux:%s:8100" % UDID)
        out_of_range = resolve_transport({"udid": UDID, "device_port": 80}, {})
        self.assertEqual(out_of_range.device_port, 8100)

    def test_resolve_transport_unconfigured(self):
        for config in ({}, None, {"udid": "bad udid!"}, {"udid": 12345678}, {"wda_url": ""}, []):
            with self.subTest(config=config):
                transport = resolve_transport(config, {})
                self.assertIsInstance(transport, UnconfiguredTransport)
                self.assertEqual((transport.kind, transport.identity), ("none", "none"))
                self.assertEqual(transport.describe(), {"kind": "none"})

    def test_resolve_transport_bad_urls_raise_value_error(self):
        with self.assertRaises(ValueError):
            resolve_transport({}, {"IPHONE_USE_WDA_URL": "http://10.0.0.2:8100"})
        with self.assertRaises(ValueError):
            resolve_transport({"wda_url": "http://example.com:8100", "udid": UDID}, {})
        with self.assertRaises(ValueError):
            resolve_transport({}, {}, explicit_url="https://127.0.0.1:8100")

    def test_resolve_transport_passes_env_to_usbmux(self):
        env = {"USBMUXD_SOCKET_ADDRESS": "unix:/tmp/fake.sock"}
        transport = resolve_transport({"udid": UDID}, env)
        self.assertIs(transport.env, env)

    def test_describe_never_includes_more_than_the_endpoint(self):
        self.assertEqual(TcpTransport("http://127.0.0.1:8100").describe(), {"kind": "tcp",
                                                                          "url": "http://127.0.0.1:8100"})
        self.assertEqual(TcpTransport("http://[::1]:8100/").describe(), {"kind": "tcp", "url": "http://[::1]:8100"})
        self.assertEqual(UsbmuxTransport(UDID, 8100, env={}).describe(),
                         {"kind": "usbmux", "udid": UDID, "device_port": 8100})

    def test_every_loopback_url_sends_a_host_the_browser_guard_accepts(self):
        urls = ("http://127.0.0.1:8100", "http://localhost:8101/", "http://[::1]:8102", "http://127.0.0.1",
                "http://localhost", "http://[::1]/")
        for transport in [UsbmuxTransport(UDID, 8100)] + [TcpTransport(url) for url in urls]:
            with self.subTest(transport=transport.identity):
                sent = []
                connection = transport.new_connection(1.0)
                connection.send = sent.append  # capture the request instead of connecting
                connection.request("POST", "/wda/homescreen", body=b"{}", headers={"Accept": "application/json"})
                lines = b"".join(sent).split(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")[1:]
                headers = {name.lower(): value.strip() for name, _, value in (line.partition(":") for line in lines)}
                self.assertTrue(GUARD_HOST.fullmatch(headers["host"]), headers["host"])
                self.assertNotIn("origin", headers)

    def test_usbmux_transport_validates_arguments(self):
        for udid, port in (("short", 8100), (None, 8100), (UDID, 0), (UDID, 70000), (UDID, True), (UDID, "8100")):
            with self.subTest(udid=udid, port=port):
                with self.assertRaises(ValueError):
                    UsbmuxTransport(udid, port)

    def test_unconfigured_transport_fails_before_sending(self):
        transport = UnconfiguredTransport()
        with self.assertRaises(UsbmuxError) as caught:
            transport.open_socket(9100)
        self.assertEqual(caught.exception.reason, "not_configured")
        connection = transport.new_connection(1.0)
        with self.assertRaises(UsbmuxError) as caught:
            connection.connect()
        self.assertEqual(caught.exception.reason, "not_configured")
        self.assertEqual(caught.exception.message, "iPhone Use is not set up yet; no iPhone is configured.")

    def test_tcp_open_socket(self):
        server = ScriptedServer(lambda *a: ok({"ready": True}))
        self.addCleanup(server.close)
        transport = TcpTransport(server.url)
        sock = transport.open_socket(timeout=1.0)
        self.addCleanup(sock.close)
        self.assertEqual(sock.getpeername()[1], server.port)
        # Any non-zero value means enabled (Linux reports 1, macOS reports 4).
        self.assertNotEqual(sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY), 0)
        other = transport.open_socket(server.port, timeout=1.0)
        other.close()
        with self.assertRaises(ConnectionRefusedError):
            transport.open_socket(refused_port(self), timeout=1.0)
        with self.assertRaises(ValueError):
            transport.open_socket(70000)

    def test_usbmux_open_socket_reaches_only_the_configured_device(self):
        server = ScriptedServer(lambda *a: ok())
        self.addCleanup(server.close)
        fake = FakeUsbmuxd().start()
        self.addCleanup(fake.stop)
        fake.add_device(UDID, ports={9100: server.target})
        fake.add_device("00008030-000A1B2C3D4E5F60", ports={9100: server.target})
        transport = UsbmuxTransport(UDID, 8100, env=fake.env())
        sock = transport.open_socket(9100, timeout=1.0)
        sock.close()
        self.assertEqual(fake.connects, [(UDID, 9100, 0)])
        with self.assertRaises(UsbmuxError) as caught:
            transport.open_socket(None, timeout=1.0)
        self.assertEqual(caught.exception.reason, "connection_refused")
        self.assertEqual(fake.connects[-1], (UDID, 8100, 3))


class IsReadTests(unittest.TestCase):
    def test_classification_table(self):
        table = [
            ("GET", "/status", True),
            ("GET", "/source?excluded_attributes=visible", True),
            ("GET", "/session/ABC-1/window/size", True),
            ("GET", "/session/ABC-1", True),
            ("GET", "/session/ABC-1/element/E1/rect", True),
            ("GET", "/session/ABC-1/element/active", True),
            ("GET", "/wda/healthcheck", False),
            ("GET", "/wda/healthcheck?x=1", False),
            ("GET", "/WDA/HealthCheck", False),
            ("GET", "/session/ABC/wda/healthcheck", False),
            ("get", "/status", True),
            ("POST", "/session/ABC/elements", True),
            ("POST", "/session/ABC/element", True),
            ("POST", "/elements", True),
            ("POST", "/session/ABC/element/E1/element", True),
            ("POST", "/session/ABC/element/E1/elements", True),
            ("POST", "/session/ABC/element/E1/click", False),
            ("POST", "/session/ABC/element/E1/value", False),
            ("POST", "/session/ABC/element/E1/clear", False),
            ("POST", "/session/ABC/element/E1/elements/extra", False),
            ("POST", "/session/ABC/elementsX", False),
            ("POST", "/session", False),
            ("POST", "/session/ABC/appium/settings", False),
            ("POST", "/session/ABC/wda/tap", False),
            ("POST", "/session/ABC/wda/keys", False),
            ("POST", "/session/ABC/wda/dragfromtoforduration", False),
            ("POST", "/session/ABC/wda/pressButton", False),
            ("POST", "/wda/homescreen", False),
            ("POST", "/session/ABC/wda/apps/activate", False),
            ("POST", "/wda/unlock", False),
            ("DELETE", "/session/ABC", False),
            ("PUT", "/status", False),
            ("PATCH", "/session/ABC/elements", False),
        ]
        for method, path, expected in table:
            with self.subTest(method=method, path=path):
                self.assertIs(WDAClient.is_read(method, path), expected)


class ReferenceClientTests(ClientTestCase):
    """The 22 transport and session behaviours of the reference client."""

    def test_reuses_http_connection_and_obeys_server_close(self):
        def respond(method, path, body, requests):
            return 200, {"value": {"ready": True}}, 0, path == "/close"

        server = self.serve(respond)
        client = self.client(server)
        for path in ("/status", "/status", "/close", "/status"):
            self.assertTrue(client.request("GET", path)["value"]["ready"])
        ports = server.peer_ports
        self.assertEqual(ports[:3], [ports[0]] * 3)
        self.assertNotEqual(ports[2], ports[3])
        self.assertEqual(len(server.requests), 4)

    def test_explicit_invalid_session_read_creates_one_session_and_retries_once(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "fresh"}}, 0, False
            if path == "/session/expired/window/size":
                return 404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0, False
            return 200, {"value": {"width": 390, "height": 844}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.warm_session(client, "expired")
        self.assertEqual(client.session("GET", "/window/size"), {"width": 390, "height": 844})
        self.assertEqual([(m, p) for m, p, _ in server.requests], [
            ("GET", "/session/expired/window/size"), ("POST", "/session"),
            ("POST", "/session/fresh/appium/settings"), ("GET", "/session/fresh/window/size")])
        self.assertEqual(client.session_id, "fresh")

    def test_explicit_invalid_session_mutation_is_not_replayed(self):
        server = self.serve(lambda *a: (404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0,
                                        False))
        client = self.client(server)
        self.warm_session(client, "expired")
        error = self.assert_tool_error(lambda: client.session("POST", "/wda/tap", {"x": 100, "y": 200}),
                                       "invalid session id")
        self.assertEqual(error.message, "Expired")
        self.assertIsNone(client.session_id)
        self.assertEqual(len(server.requests), 1)

    def test_expired_element_read_is_not_replayed_in_new_session(self):
        server = self.serve(lambda *a: (404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0,
                                        False))
        client = self.client(server)
        self.warm_session(client, "expired")
        self.assert_tool_error(lambda: client.session("GET", "/element/expired-element/attribute/value"),
                               "invalid session id")
        self.assertIsNone(client.session_id)
        self.assertEqual([(m, p) for m, p, _ in server.requests],
                         [("GET", "/session/expired/element/expired-element/attribute/value")])

    def test_mutation_timeout_is_uncertain_and_never_replayed(self):
        server = self.serve(lambda *a: (200, {"value": None}, 0.15, False))
        client = self.client(server, timeout=0.025)
        self.warm_session(client, "existing")
        error = self.assert_tool_error(lambda: client.session("POST", "/wda/tap", {"x": 100, "y": 200}),
                                       "action_uncertain", uncertain=True)
        self.assertEqual(error.details["phase"], "response")
        self.assertIsNone(client._connection)
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(client.records[-1]["endpoint"], "/session/:id/wda/tap")
        self.assertEqual(client.records[-1]["error"], "action_uncertain")

    def test_non_session_read_error_does_not_trigger_retry(self):
        server = self.serve(lambda *a: wda_error("unknown error", "Backend failed"))
        client = self.client(server)
        self.warm_session(client, "existing")
        self.assert_tool_error(lambda: client.session("GET", "/source"), "unknown error")
        self.assertEqual(client.session_id, "existing")
        self.assertEqual(len(server.requests), 1)

    def test_element_lookup_reconnects_once_after_disconnect(self):
        def respond(method, path, body, requests):
            if len(requests) == 1:
                return None, None, 0, True
            return 200, {"value": [{"ELEMENT": "found"}]}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.warm_session(client, "existing")
        query = {"using": "accessibility id", "value": "按钮"}
        self.assertEqual(client.session("POST", "/elements", query), [{"ELEMENT": "found"}])
        self.assertEqual(server.requests, [("POST", "/session/existing/elements", query)] * 2)
        self.assertNotEqual(server.peer_ports[0], server.peer_ports[1])
        self.assertEqual(client.records[0]["error"], "service_unreachable")

    def test_get_reconnects_once_after_disconnect(self):
        def respond(method, path, body, requests):
            return (None, None, 0, True) if len(requests) == 1 else (200, {"value": "xml"}, 0, False)

        server = self.serve(respond)
        client = self.client(server)
        self.assertEqual(client.request("GET", "/source")["value"], "xml")
        self.assertEqual(len(server.requests), 2)

    def test_element_lookup_invalid_session_recreates_and_retries_query_once(self):
        def respond(method, path, body, requests):
            if path == "/session/expired/elements":
                return 404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0, False
            if path == "/session":
                return 200, {"value": {"sessionId": "fresh"}}, 0, False
            return 200, {"value": [{"ELEMENT": "fresh-element"}]}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.warm_session(client, "expired")
        self.assertEqual(client.session("POST", "/elements", {"using": "name", "value": "A"}),
                         [{"ELEMENT": "fresh-element"}])
        self.assertEqual(server.paths(), ["/session/expired/elements", "/session", "/session/fresh/appium/settings",
                                          "/session/fresh/elements"])

    def test_invalid_session_lookup_is_retried_only_once(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "fresh"}}, 0, False
            if path.endswith("/appium/settings"):
                return 200, {"value": {}}, 0, False
            return 404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.warm_session(client, "expired")
        self.assert_tool_error(lambda: client.session("POST", "/elements", {}), "invalid session id")
        self.assertEqual(len(server.requests), 4)
        self.assertEqual(server.paths().count("/session"), 1)
        self.assertIsNone(client.session_id)

    def test_descendant_lookup_does_not_carry_old_element_across_sessions(self):
        server = self.serve(lambda *a: (404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0,
                                        False))
        client = self.client(server)
        self.warm_session(client, "expired")
        self.assert_tool_error(lambda: client.session("POST", "/element/old/elements", {}), "invalid session id")
        self.assertIsNone(client.session_id)
        self.assertEqual(len(server.requests), 1)

    def test_read_reconnect_does_not_reset_total_deadline(self):
        clock = FakeClock(100.0)
        budgets = []
        client = WDAClient(UnconfiguredTransport(), timeout=0.08)
        self.warm_session(client, "existing")

        def interrupted_read(method, path, body, deadline, read):
            self.assertTrue(read)
            budget = deadline - clock.monotonic()
            budgets.append(budget)
            clock.advance(0.025 if len(budgets) == 1 else budget)
            raise ToolError("service_unreachable", "Read connection interrupted")

        with mock.patch.object(wda_client, "time", clock), \
                mock.patch.object(client, "_request_once", side_effect=interrupted_read):
            error = self.assert_tool_error(lambda: client.session("POST", "/elements", {}), "service_unreachable")
        self.assertFalse(error.uncertain)
        self.assertEqual(len(budgets), 2)
        self.assertAlmostEqual(budgets[0], 0.08)
        self.assertAlmostEqual(budgets[1], 0.055)
        self.assertAlmostEqual(clock.monotonic() - 100.0, 0.08)

    def test_backend_and_invalid_json_query_failures_are_not_retried_or_uncertain(self):
        for response, code in (({"value": {"error": "unknown error", "message": "Failed"}}, "unknown error"),
                               (b"not json", "invalid_response"), ({}, "http_error")):
            with self.subTest(code=code):
                server = ScriptedServer(lambda *a, response=response: (500, response, 0, False))
                client = WDAClient(TcpTransport(server.url))
                try:
                    self.warm_session(client, "existing")
                    self.assert_tool_error(lambda: client.session("POST", "/elements", {}), code)
                    self.assertEqual(len(server.requests), 1)
                finally:
                    client.close()
                    server.close()

    def test_phone_mutations_never_reconnect_and_replay_after_disconnect(self):
        for path in ("/element/button/click", "/element/input/value", "/wda/keys",
                     "/wda/homescreen", "/wda/apps/activate", "/wda/dragfromtoforduration"):
            with self.subTest(path=path):
                server = ScriptedServer(lambda *a: (None, None, 0, True))
                client = WDAClient(TcpTransport(server.url))
                try:
                    self.warm_session(client, "existing")
                    error = self.assert_tool_error(lambda: client.session("POST", path, {}), "action_uncertain",
                                                   uncertain=True)
                    self.assertEqual(error.details, {"phase": "response"})
                    self.assertEqual(len(server.requests), 1)
                finally:
                    client.close()
                    server.close()

    def test_upstream_state_changing_healthcheck_is_not_replayed(self):
        server = self.serve(lambda *a: (None, None, 0, True))
        client = self.client(server)
        self.assert_tool_error(lambda: client.request("GET", "/wda/healthcheck"), "action_uncertain",
                               uncertain=True)
        self.assertEqual(len(server.requests), 1)

    def test_new_session_sets_fast_timeouts_once(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "fresh"}}, 0, False
            return 200, {"value": {}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.assertEqual(client.ensure_session(), "fresh")
        self.assertEqual(client.ensure_session(), "fresh")
        client.session("GET", "/source")
        self.assertEqual(server.paths(), ["/session", "/session/fresh/appium/settings", "/session/fresh/source"])
        self.assertEqual(server.requests[0][2]["capabilities"]["alwaysMatch"]["waitForIdleTimeout"], 0)
        self.assertEqual(server.requests[1][2], {"settings": SESSION_SETTINGS})
        self.assertEqual((SESSION_SETTINGS["waitForIdleTimeout"], SESSION_SETTINGS["animationCoolOffTimeout"]), (0, 0))
        self.assertIs(SESSION_SETTINGS["shouldUseCompactResponses"], False)
        self.assertEqual(set(SESSION_SETTINGS["elementResponseAttributes"].split(",")),
                         {"type", "label", "rect", "enabled", "attribute/name", "attribute/value"})

    def test_persisted_session_sets_fast_timeouts_once_without_session_creation(self):
        server = self.serve(lambda *a: (200, {"value": {}}, 0, False))
        client = self.client(server)
        client.session_id = "persisted"
        self.assertEqual(client.ensure_session(), "persisted")
        client.session("GET", "/source")
        client.session("GET", "/source")
        self.assertEqual(server.paths(), ["/session/persisted/appium/settings", "/session/persisted/source",
                                          "/session/persisted/source"])
        self.assertEqual(server.requests[0][2], {"settings": SESSION_SETTINGS})

    def test_persisted_expired_session_is_replaced_once_for_queries_and_mutations(self):
        # X5: an adopted sid that WDA no longer knows is replaced inside ensure_session. The
        # command itself was never sent before, so sending it once in the new session is not a replay.
        for method, path in (("POST", "/elements"), ("POST", "/wda/tap")):
            with self.subTest(method=method, path=path):
                def respond(method, path, body, requests):
                    if path == "/session/persisted/appium/settings":
                        return 404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0, False
                    if path == "/session":
                        return 200, {"value": {"sessionId": "fresh"}}, 0, False
                    return 200, {"value": []}, 0, False

                server = ScriptedServer(respond)
                client = WDAClient(TcpTransport(server.url))
                try:
                    client.session_id = "persisted"
                    self.assertEqual(client.session(method, path, {}), [])
                    self.assertEqual(server.paths(), ["/session/persisted/appium/settings", "/session",
                                                      "/session/fresh/appium/settings", "/session/fresh" + path])
                    self.assertEqual(client.session_id, "fresh")
                finally:
                    client.close()
                    server.close()

    def test_settings_failure_keeps_session_and_is_retried_on_the_next_call(self):
        # Not sticky (fixes reference quirk Q1): each ensure_session tries the settings again.
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "created"}}, 0, False
            return None, None, 0, True

        server = self.serve(respond)
        client = self.client(server)
        for _ in range(2):
            error = self.assert_tool_error(client.ensure_session, "service_unreachable")
            self.assertEqual(error.details["operation"], "session_settings")
            self.assertIs(error.details["settings_applied"], False)
            self.assertEqual(error.details["phase"], "response")
        self.assertEqual(client.session_id, "created")
        self.assertEqual(server.paths(), ["/session", "/session/created/appium/settings",
                                          "/session/created/appium/settings"])

    def test_settings_explicit_invalid_session_clears_real_session_state(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "created"}}, 0, False
            return 404, {"value": {"error": "invalid session id", "message": "Expired"}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        error = self.assert_tool_error(client.ensure_session, "invalid session id")
        self.assertEqual(error.details["operation"], "session_settings")
        self.assertIs(error.details["settings_applied"], False)
        self.assertIsNone(client.session_id)
        self.assertEqual(len(server.requests), 2)

    def test_utf8_payload_and_metrics_do_not_retain_user_content_or_ids(self):
        phrase = "你好 👋 Café 漢字"
        server = self.serve(lambda *a: (200, {"value": phrase}, 0, False))
        client = self.client(server)
        self.warm_session(client, "private-device-session")
        value = client.session("POST", "/element/private-element/value", {"text": phrase})
        self.assertEqual(value, phrase)
        self.assertEqual(server.requests[0][2]["text"], phrase)
        metrics = json.dumps(client.metrics(), ensure_ascii=False)
        for sensitive in (phrase, "private-device-session", "private-element"):
            self.assertNotIn(sensitive, metrics)
        self.assertIn("/session/:id/element/:id/value", metrics)

    def test_rejects_remote_or_decorated_urls(self):
        for url in ("http://192.168.1.2:8100", "https://localhost:8100", "http://user@localhost",
                    "http://localhost/api", "http://localhost?token=x"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                WDAClient(TcpTransport(url))


class ConnectPhaseTests(ClientTestCase):
    """No request byte left the Mac: never uncertain, even for mutations."""

    def assert_not_sent(self, client, reason):
        error = self.assert_tool_error(lambda: client.request("POST", "/wda/homescreen", {}), "service_unreachable")
        self.assertEqual(error.details, {"phase": "connect", "reason": reason})
        self.assertEqual(error.message, "Could not reach the iPhone service; nothing was sent.")
        self.assertIsNone(client._connection)
        return error

    def test_unconfigured_transport(self):
        client = self.client(UnconfiguredTransport())
        self.assert_not_sent(client, "not_configured")
        self.assertEqual(client.records[-1]["error"], "service_unreachable")
        self.assertIsNone(client.records[-1]["status"])

    def test_refused_tcp_port(self):
        client = self.client(TcpTransport("http://127.0.0.1:%d" % refused_port(self)))
        self.assert_not_sent(client, "connection_refused")
        self.assertEqual(len(client.records), 1)  # a mutation gets exactly one attempt

    def test_read_connect_failure_is_retried_once(self):
        client = self.client(TcpTransport("http://127.0.0.1:%d" % refused_port(self)))
        error = self.assert_tool_error(lambda: client.request("GET", "/status"), "service_unreachable")
        self.assertEqual(error.details["phase"], "connect")
        self.assertEqual(len(client.records), 2)

    def test_usbmux_refused_port_sends_nothing(self):
        server = self.serve(lambda *a: ok())
        fake = FakeUsbmuxd().start()
        self.addCleanup(fake.stop)
        fake.add_device(UDID, ports={8100: None, 9100: server.target})
        client = self.client(UsbmuxTransport(UDID, 8100, env=fake.env()))
        self.assert_not_sent(client, "connection_refused")
        self.assertEqual(server.requests, [])
        self.assertEqual(fake.connects, [(UDID, 8100, 3)])

    def test_usbmux_device_missing(self):
        fake = FakeUsbmuxd().start()
        self.addCleanup(fake.stop)
        client = self.client(UsbmuxTransport(UDID, 8100, env=fake.env()))
        self.assert_not_sent(client, "device_not_found")

    def test_usbmuxd_missing(self):
        missing = os.path.join(short_tmpdir(), "absent.sock")
        self.addCleanup(shutil.rmtree, os.path.dirname(missing), True)
        client = self.client(UsbmuxTransport(UDID, 8100, env={"USBMUXD_SOCKET_ADDRESS": "unix:" + missing}))
        self.assert_not_sent(client, "usbmuxd_unavailable")

    def test_session_on_unconfigured_transport_is_not_uncertain(self):
        client = self.client(UnconfiguredTransport())
        error = self.assert_tool_error(lambda: client.session("POST", "/wda/tap", {"x": 1, "y": 1}),
                                       "service_unreachable")
        self.assertEqual(error.details["operation"], "create_session")
        self.assertEqual(error.details["phase"], "connect")

    def test_deadline_used_up_before_sending(self):
        server = self.serve(lambda *a: ok())
        client = self.client(server)
        for method, path in (("GET", "/status"), ("POST", "/wda/homescreen")):
            with self.subTest(method=method):
                error = self.assert_tool_error(lambda: client.request(method, path, None, timeout=0),
                                               "service_unreachable")
                self.assertEqual(error.details, {"phase": "deadline"})
        self.assertEqual(server.requests, [])

    def test_bad_arguments_raise_before_connecting(self):
        server = self.serve(lambda *a: ok())
        client = self.client(server)
        with self.assertRaises(ValueError):
            client.request("POST", "/wda/tap", {"x": float("nan"), "y": 1})
        with self.assertRaises(TypeError):
            client.request("POST", "/wda/tap", {"x": object()})
        for method, path in (("POST", "wda/tap"), ("POST", "/wda/tap now"), ("POST", "/wda/\r\ntap"),
                             ("PO ST", "/wda/tap"), (None, "/status"), ("GET", None), ("GET", "/é")):
            with self.subTest(method=method, path=path):
                with self.assertRaises(ValueError):
                    client.request(method, path)
        self.assertEqual(server.requests, [])
        self.assertIsNone(client._connection)


class KeepAliveTests(ClientTestCase):
    def test_dropped_keep_alive_is_detected_before_a_mutation(self):
        def respond(method, path, body, requests):
            return 200, {"value": {"ready": True}}, 0, "silent" if path == "/status" else False

        server = self.serve(respond)
        client = self.client(server)
        client.request("GET", "/status")
        self.assertTrue(server.server_closed.wait(2.0))
        result = client.request("POST", "/wda/homescreen", {})
        self.assertEqual(result["value"], {"ready": True})
        self.assertEqual(server.paths(), ["/status", "/wda/homescreen"])
        self.assertNotEqual(server.peer_ports[0], server.peer_ports[1])
        self.assertEqual([r["error"] for r in client.records], [None, None])

    def test_stray_bytes_after_a_response_force_a_new_connection(self):
        def respond(method, path, body, requests):
            return 200, {"value": path}, 0, b"JUNK" if path == "/status" else False

        server = self.serve(respond)
        client = self.client(server)
        client.request("GET", "/status")
        sock = client._connection.sock
        deadline = time.monotonic() + 2.0
        arrived = False
        while not arrived and time.monotonic() < deadline:  # wait until the stray bytes have arrived
            sock.setblocking(False)
            try:
                arrived = sock.recv(4, socket.MSG_PEEK) == b"JUNK"
            except BlockingIOError:
                time.sleep(0.01)
            finally:
                sock.settimeout(None)
        self.assertTrue(arrived)
        self.assertEqual(client.request("POST", "/wda/tap", {"x": 1, "y": 2})["value"], "/wda/tap")
        self.assertNotEqual(server.peer_ports[0], server.peer_ports[1])

    def test_sequential_requests_reuse_one_connection(self):
        server = self.serve(lambda method, path, *a: (200, {"value": path}, 0, False))
        client = self.client(server)
        for method, path in (("GET", "/status"), ("POST", "/wda/homescreen"), ("GET", "/source"),
                             ("POST", "/session/s/elements"), ("POST", "/session/s/wda/tap")):
            self.assertEqual(client.request(method, path, {} if method == "POST" else None)["value"], path)
        self.assertEqual(len(set(server.peer_ports)), 1)

    def test_request_headers_and_body(self):
        server = self.serve(lambda *a: ok())
        client = self.client(server)
        client.request("POST", "/wda/keys", {"value": ["é", "\n"]})
        client.request("GET", "/status")
        post_headers, get_headers = server.headers
        self.assertEqual(post_headers["content-type"], "application/json")
        self.assertEqual(post_headers["accept"], "application/json")
        self.assertEqual(int(post_headers["content-length"]),
                         len(json.dumps({"value": ["é", "\n"]}, ensure_ascii=False).encode("utf-8")))
        self.assertNotIn("transfer-encoding", post_headers)
        self.assertEqual(server.requests[0][2], {"value": ["é", "\n"]})
        self.assertEqual(get_headers["accept"], "application/json")
        self.assertNotIn("content-type", get_headers)
        self.assertNotIn("transfer-encoding", get_headers)
        for headers in server.headers:  # what the patched WebDriverAgent's browser guard accepts
            self.assertEqual(headers["host"], "127.0.0.1:%d" % server.port)
            self.assertNotIn("origin", headers)

    def test_close_keeps_the_session_id(self):
        server = self.serve(lambda *a: ok())
        client = self.client(server)
        self.warm_session(client, "kept")
        client.session("GET", "/source")
        client.close()
        client.close()  # idempotent
        self.assertEqual(client.session_id, "kept")
        client.session("GET", "/source")
        self.assertEqual(len(set(server.peer_ports)), 2)

    def test_string_url_is_accepted_as_a_tcp_transport(self):
        server = self.serve(lambda *a: ok({"ready": True}))
        client = self.client(WDAClient(server.url).transport)
        self.assertEqual(client.transport.identity, "tcp:127.0.0.1:%d" % server.port)
        self.assertTrue(client.request("GET", "/status")["value"]["ready"])


class ResponseHandlingTests(ClientTestCase):
    def test_wda_error_passthrough(self):
        long_message = "x" * 3000
        server = self.serve(lambda *a: wda_error("no such element", long_message, status=404))
        client = self.client(server)
        for method, path in (("GET", "/status"), ("POST", "/wda/tap")):
            with self.subTest(method=method):
                error = self.assert_tool_error(lambda: client.request(method, path, {} if method == "POST" else None),
                                               "no such element")
                self.assertEqual(len(error.message), 1500)
                self.assertNotIn("traceback", error.as_dict())
                self.assertNotIn("SECRET", json.dumps(error.as_dict()))
        self.assertEqual(len(set(server.peer_ports)), 1)  # the connection was kept

    def test_wda_error_without_message_uses_the_code(self):
        server = self.serve(lambda *a: (500, {"value": {"error": "unknown error"}}, 0, False))
        client = self.client(server)
        error = self.assert_tool_error(lambda: client.request("GET", "/source"), "unknown error")
        self.assertEqual(error.message, "unknown error")

    def test_wda_error_wins_over_http_status(self):
        server = self.serve(lambda *a: (404, {"value": {"error": "invalid session id", "message": "gone"}}, 0, False))
        client = self.client(server)
        self.assert_tool_error(lambda: client.request("POST", "/session/s/wda/tap", {}), "invalid session id")

    def test_http_error(self):
        server = self.serve(lambda *a: (503, {"value": None}, 0, False))
        client = self.client(server)
        error = self.assert_tool_error(lambda: client.request("GET", "/status"), "http_error")
        self.assertEqual(error.details, {"http_status": 503})
        self.assertEqual(error.message, "The iPhone service returned HTTP 503.")
        self.assertIsNotNone(client._connection)  # a read keeps its connection
        error = self.assert_tool_error(lambda: client.request("POST", "/wda/tap", {}), "http_error", uncertain=True)
        self.assertIsNone(client._connection)  # an uncertain mutation drops it
        self.assertEqual(len(server.requests), 2)  # neither request was retried

    def test_invalid_json_and_non_object(self):
        for body in (b"not json", b"[1, 2]", b"\xff\xfe\x00", b"", b'"text"', b"null"):
            with self.subTest(body=body):
                server = ScriptedServer(lambda *a, body=body: (200, body, 0, False))
                client = WDAClient(TcpTransport(server.url))
                try:
                    error = self.assert_tool_error(lambda: client.request("GET", "/source"), "invalid_response")
                    self.assertEqual(error.message, "The iPhone service returned an unreadable answer.")
                    self.assert_tool_error(lambda: client.request("POST", "/wda/tap", {}), "invalid_response",
                                           uncertain=True)
                    self.assertIsNone(client._connection)
                    self.assertEqual(len(server.requests), 2)
                finally:
                    client.close()
                    server.close()

    def test_oversized_body(self):
        server = self.serve(lambda *a: (200, {"value": "x" * 500}, 0, False))
        client = self.client(server)
        with mock.patch.object(wda_client, "MAX_RESPONSE_BYTES", 64):
            self.assert_tool_error(lambda: client.request("GET", "/screenshot"), "response_too_large")
            self.assertIsNone(client._connection)
            self.assert_tool_error(lambda: client.request("POST", "/wda/tap", {}), "response_too_large",
                                   uncertain=True)
        self.assertEqual(len(server.requests), 2)
        self.assertEqual(client.request("GET", "/screenshot")["value"], "x" * 500)

    def test_read_timeout_is_not_uncertain(self):
        server = self.serve(lambda *a: (200, {"value": None}, 0.2, False))
        client = self.client(server, timeout=0.05)
        error = self.assert_tool_error(lambda: client.request("GET", "/source"), "service_unreachable")
        self.assertEqual(error.details, {"phase": "read"})
        self.assertEqual(error.message, "The iPhone service connection failed or timed out; no phone action was "
                                        "executed.")


class SessionTests(ClientTestCase):
    def test_capabilities_are_exact(self):
        server = self.serve(lambda method, path, *a: (200, {"value": {"sessionId": "S-1"}}, 0, False))
        client = self.client(server)
        self.assertEqual(client.ensure_session(), "S-1")
        self.assertEqual(server.requests[0], ("POST", "/session", {"capabilities": {"alwaysMatch": {
            "shouldWaitForQuiescence": False, "shouldTerminateApp": False,
            "waitForIdleTimeout": 0, "maxTypingFrequency": 30}}}))
        self.assertEqual(server.requests[0][2], SESSION_CAPABILITIES)
        self.assertEqual(server.requests[1][2], {"settings": {
            "waitForIdleTimeout": 0, "animationCoolOffTimeout": 0, "shouldUseCompactResponses": False,
            "elementResponseAttributes": "type,label,rect,enabled,attribute/name,attribute/value"}})

    def test_top_level_session_id_is_accepted(self):
        server = self.serve(lambda *a: (200, {"value": {}, "sessionId": "TOP-1"}, 0, False))
        client = self.client(server)
        self.assertEqual(client.ensure_session(), "TOP-1")

    def test_missing_or_unsafe_session_id_is_invalid_response(self):
        for value in ({"value": {}}, {"value": {"sessionId": "../escape"}}, {"value": {"sessionId": 5}},
                      {"value": None, "sessionId": ""}, {"value": {"sessionId": "x" * 129}}):
            with self.subTest(value=value):
                server = ScriptedServer(lambda *a, value=value: (200, value, 0, False))
                client = WDAClient(TcpTransport(server.url))
                try:
                    error = self.assert_tool_error(client.ensure_session, "invalid_response")
                    self.assertEqual(error.message, "The iPhone service did not return a session ID.")
                    self.assertIsNone(client.session_id)
                    self.assertEqual(len(server.requests), 1)
                finally:
                    client.close()
                    server.close()

    def test_session_creation_transport_failure_is_service_unreachable(self):
        for delay, status in ((0, None), (0.2, 200)):
            with self.subTest(delay=delay, status=status):
                server = ScriptedServer(lambda *a, delay=delay, status=status: (
                    status, {"value": {"sessionId": "late"}}, delay, False))
                client = WDAClient(TcpTransport(server.url), timeout=0.05)
                try:
                    error = self.assert_tool_error(lambda: client.ensure_session(0.05), "service_unreachable")
                    self.assertEqual(error.details, {"operation": "create_session", "phase": "response"})
                    self.assertEqual(error.message, "The iPhone service did not finish setting up a session; "
                                                    "nothing on the phone was changed.")
                    self.assertEqual(len(server.requests), 1)  # POST /session is never repeated
                    self.assertIsNone(client.session_id)
                finally:
                    client.close()
                    server.close()

    def test_session_creation_wda_error_is_passed_through_and_not_uncertain(self):
        server = self.serve(lambda *a: wda_error("session not created", "No app"))
        client = self.client(server)
        error = self.assert_tool_error(client.ensure_session, "session not created")
        self.assertEqual(error.details["operation"], "create_session")

    def test_session_creation_http_error_is_not_uncertain(self):
        server = self.serve(lambda *a: (502, {}, 0, False))
        client = self.client(server)
        error = self.assert_tool_error(client.ensure_session, "http_error")
        self.assertEqual(error.details["operation"], "create_session")

    def test_adopted_unknown_sid_is_replaced_with_one_new_session(self):
        def respond(method, path, body, requests):
            if path == "/session/old-sid/appium/settings":
                return 404, {"value": {"error": "invalid session id", "message": "gone"}}, 0, False
            if path == "/session":
                return 200, {"value": {"sessionId": "new-sid"}}, 0, False
            return 200, {"value": {}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        client.session_id = "old-sid"
        self.assertEqual(client.ensure_session(), "new-sid")
        self.assertEqual(server.paths(), ["/session/old-sid/appium/settings", "/session",
                                          "/session/new-sid/appium/settings"])
        self.assertEqual(client.ensure_session(), "new-sid")
        self.assertEqual(len(server.requests), 3)

    def test_invalid_session_on_the_fresh_session_reraises_and_clears(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "new-sid"}}, 0, False
            return 404, {"value": {"error": "invalid session id", "message": "gone"}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        client.session_id = "old-sid"
        error = self.assert_tool_error(client.ensure_session, "invalid session id")
        self.assertEqual(error.details["operation"], "session_settings")
        self.assertIs(error.details["settings_applied"], False)
        self.assertIsNone(client.session_id)
        self.assertEqual(server.paths(), ["/session/old-sid/appium/settings", "/session",
                                          "/session/new-sid/appium/settings"])

    def test_settings_wda_error_keeps_the_session_and_retries_next_time(self):
        calls = {"settings": 0}

        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "S"}}, 0, False
            if path.endswith("/appium/settings"):
                calls["settings"] += 1
                if calls["settings"] == 1:
                    return wda_error("unknown error", "busy")
            return 200, {"value": {}}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        error = self.assert_tool_error(client.ensure_session, "unknown error")
        self.assertEqual(error.details, {"operation": "session_settings", "settings_applied": False})
        self.assertEqual(client.session_id, "S")
        self.assertEqual(client.ensure_session(), "S")
        self.assertEqual(server.paths(), ["/session", "/session/S/appium/settings", "/session/S/appium/settings"])

    def test_reapply_settings_sends_them_again_once(self):
        server = self.serve(lambda *a: (200, {"value": {}}, 0, False))
        client = self.client(server)
        self.warm_session(client, "S")
        client.ensure_session()
        client.reapply_settings()
        client.ensure_session()
        client.ensure_session()
        self.assertEqual(server.paths(), ["/session/S/appium/settings"])

    def test_adopted_sid_with_unsafe_characters_is_discarded(self):
        server = self.serve(lambda *a: (200, {"value": {"sessionId": "SAFE"}}, 0, False))
        client = self.client(server)
        client.session_id = "../../wda/homescreen"
        self.assertEqual(client.ensure_session(), "SAFE")
        self.assertEqual(server.paths(), ["/session", "/session/SAFE/appium/settings"])

    def test_ensure_session_respects_its_deadline(self):
        server = self.serve(lambda *a: ok())
        client = self.client(server)
        error = self.assert_tool_error(lambda: client.ensure_session(0), "service_unreachable")
        self.assertEqual(error.details["phase"], "deadline")
        self.assertEqual(server.requests, [])

    def test_session_returns_value_and_uses_one_deadline(self):
        server = self.serve(lambda method, path, *a: (200, {"value": {"path": path}, "sessionId": "S"}, 0, False))
        client = self.client(server)
        self.warm_session(client, "S")
        self.assertEqual(client.session("GET", "/window/size"), {"path": "/session/S/window/size"})
        error = self.assert_tool_error(lambda: client.session("GET", "/window/size", timeout=0), "service_unreachable")
        self.assertEqual(error.details["phase"], "deadline")

    def test_session_mutation_does_not_retry_on_other_errors(self):
        server = self.serve(lambda *a: wda_error("element not interactable", "covered"))
        client = self.client(server)
        self.warm_session(client, "S")
        self.assert_tool_error(lambda: client.session("POST", "/element/E/click", {}), "element not interactable")
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(client.session_id, "S")


class MetricsTests(ClientTestCase):
    def test_metrics_shape_and_normalization(self):
        def respond(method, path, body, requests):
            if path.endswith("/click"):
                return wda_error("no such element", "gone", status=404)
            return 200, {"value": "ok"}, 0, False

        server = self.serve(respond)
        client = self.client(server)
        self.warm_session(client, "SID-SECRET")
        client.session("GET", "/source?excluded_attributes=visible")
        client.session("GET", "/element/ELEM-SECRET/attribute/value")
        client.session("GET", "/element/active")
        with self.assertRaises(ToolError):
            client.session("POST", "/element/ELEM-SECRET/click", {})
        client.request("GET", "/status")
        metrics = client.metrics()
        self.assertEqual(metrics["requests"], 5)
        self.assertEqual(metrics["errors"], 1)
        self.assertGreater(metrics["http_bytes"], 0)
        self.assertGreaterEqual(metrics["http_seconds"], 0)
        self.assertEqual(set(metrics["endpoints"]), {
            "/session/:id/source", "/session/:id/element/:id/attribute/value", "/session/:id/element/active",
            "/session/:id/element/:id/click", "/status"})
        entry = metrics["endpoints"]["/status"]
        self.assertEqual(set(entry), {"count", "seconds", "max_seconds", "bytes"})
        self.assertEqual(entry["count"], 1)
        text = json.dumps(metrics)
        for secret in ("SID-SECRET", "ELEM-SECRET", "excluded_attributes", "visible"):
            self.assertNotIn(secret, text)
        record = client.records[0]
        self.assertEqual(set(record), {"method", "endpoint", "seconds", "status", "error", "bytes"})
        client.clear_metrics()
        self.assertEqual(client.metrics()["requests"], 0)
        self.assertEqual(client.metrics()["endpoints"], {})

    def test_records_are_bounded(self):
        self.assertEqual(WDAClient(UnconfiguredTransport()).records.maxlen, 2000)


class UsbmuxEndToEndTests(ClientTestCase):
    def test_requests_and_session_over_a_usbmux_tunnel(self):
        def respond(method, path, body, requests):
            if path == "/session":
                return 200, {"value": {"sessionId": "USB-SID"}}, 0, False
            if path == "/status":
                return 200, {"value": {"ready": True}}, 0, False
            return 200, {"value": {"width": 390, "height": 844}}, 0, False

        server = self.serve(respond)
        fake = FakeUsbmuxd().start()
        self.addCleanup(fake.stop)
        fake.add_device(UDID, ports={8100: server.target})
        transport = UsbmuxTransport(UDID, 8100, env=fake.env())
        self.assertEqual(transport.identity, "usbmux:%s:8100" % UDID)
        client = self.client(transport)
        self.assertTrue(client.request("GET", "/status")["value"]["ready"])
        self.assertEqual(client.session("GET", "/window/size"), {"width": 390, "height": 844})
        self.assertEqual(server.paths(), ["/status", "/session", "/session/USB-SID/appium/settings",
                                          "/session/USB-SID/window/size"])
        # One keep-alive tunnel carried all four requests.
        self.assertEqual(fake.connects, [(UDID, 8100, 0)])
        self.assertEqual(len(set(server.peer_ports)), 1)
        self.assertEqual([r["MessageType"] for r in fake.received()], ["ListDevices", "Connect"])
        # Through the tunnel the Host header names the iPhone's loopback port, as the browser guard requires.
        self.assertEqual({headers["host"] for headers in server.headers}, {"127.0.0.1:8100"})
        self.assertFalse([headers for headers in server.headers if "origin" in headers])

        # Unplugging closes the tunnel; the next read opens a new one.
        fake.close_tunnels()
        self.assertTrue(client.request("GET", "/status")["value"]["ready"])
        self.assertEqual([c[2] for c in fake.connects], [0, 0])


if __name__ == "__main__":
    unittest.main()
