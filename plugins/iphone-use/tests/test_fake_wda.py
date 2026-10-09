import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ast  # noqa: E402
import base64  # noqa: E402
import http.client  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import select  # noqa: E402
import socket  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
import xml.etree.ElementTree as ET  # noqa: E402

import fake_wda  # noqa: E402
import wda_tree  # noqa: E402
from fake_wda import (ELEMENT_KEY, SETTINGS_DEFAULTS, SETTINGS_XML, TINY_JPEG, App, FakeWDA, Node,  # noqa: E402
                      Request, form_app, list_app, parse_xml, settings_app, springboard_app)
from wda_image import png_size, solid_png  # noqa: E402

CAPS = {"capabilities": {"alwaysMatch": {"shouldWaitForQuiescence": False, "shouldTerminateApp": False,
                                         "waitForIdleTimeout": 0, "maxTypingFrequency": 30}}}
RICH_SETTINGS = {"settings": {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0,
                              "shouldUseCompactResponses": False,
                              "elementResponseAttributes": "type,label,rect,enabled,attribute/name,attribute/value"}}
SID_RE = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$")
ID_RE = re.compile(r"^[0-9A-F]{8}-0000-0000-9C01-000000000000$")
XML_ATTRIBUTE_ORDER = ["type", "value", "name", "label", "enabled", "visible", "accessible", "x", "y", "width",
                       "height", "index", "placeholderValue", "traits", "processId", "bundleId"]
# Written out independently of fake_wda's constants (DESIGN.md 9.2 / notes/wda_api 9.1).
EXPECTED_MJPEG_HEADER = (b"HTTP/1.0 200 OK\r\n"
                         b"Server: WDA MJPEG Server\r\n"
                         b"Connection: close\r\n"
                         b"Max-Age: 0\r\n"
                         b"Expires: 0\r\n"
                         b"Cache-Control: no-cache, private\r\n"
                         b"Pragma: no-cache\r\n"
                         b"Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n"
                         b"\r\n")
EXPECTED_CHUNKED_HEADER = (b"HTTP/1.1 200 OK\r\n"
                           b"Server: WDA MJPEG Server\r\n"
                           b"Transfer-Encoding: chunked\r\n"
                           b"Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n"
                           b"\r\n")
MJPEG_REQUEST = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: multipart/x-mixed-replace\r\nConnection: close\r\n\r\n"


def expected_part(jpeg):
    return (b"--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode()
            + b"\r\n\r\n" + jpeg + b"\r\n\r\n")


def raw_exchange(port, data, timeout=2.0):
    """Send raw bytes and read until the server closes the connection."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        sock.sendall(data)
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        sock.close()


def split_responses(data):
    """[(status_line, headers, body)] from raw HTTP/1.1 responses with Content-Length."""
    responses = []
    while data:
        head, _, rest = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers[name.lower()] = value.strip()
        length = int(headers.get("content-length", "0"))
        responses.append((lines[0], headers, rest[:length]))
        data = rest[length:]
    return responses


def dechunk(data):
    """(payload, chunk sizes, terminated) for an HTTP/1.1 chunked body."""
    out = []
    sizes = []
    while data:
        line, separator, rest = data.partition(b"\r\n")
        if not separator:
            break
        size = int(line, 16)
        if size == 0:
            return b"".join(out), sizes, rest.startswith(b"\r\n")
        if len(rest) < size + 2:
            break
        out.append(rest[:size])
        sizes.append(size)
        data = rest[size + 2:]
    return b"".join(out), sizes, False


class FakeCase(unittest.TestCase):
    fake_kwargs = {}

    def setUp(self):
        self.fake = FakeWDA(**self.fake_kwargs).start()
        self.addCleanup(self.fake.stop)
        self.conn = self.connection()
        self.sid = None

    def connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.fake.port, timeout=5)
        self.addCleanup(conn.close)
        return conn

    def call(self, method, path, payload=None, conn=None):
        conn = conn or self.conn
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        data = response.read()
        return response.status, json.loads(data.decode("utf-8")), response

    def ok(self, method, path, payload=None, conn=None):
        status, body, _ = self.call(method, path, payload, conn)
        self.assertEqual(status, 200, body)
        return body["value"]

    def wda_error(self, method, path, payload=None, code=None, status=None):
        got_status, body, _ = self.call(method, path, payload)
        self.assertIsInstance(body["value"], dict, body)
        self.assertEqual(set(body["value"]), {"error", "message", "traceback"})
        self.assertEqual(body["value"]["traceback"], "")
        if code is not None:
            self.assertEqual(body["value"]["error"], code)
        if status is not None:
            self.assertEqual(got_status, status)
        return body["value"]

    def session(self, caps=CAPS):
        self.sid = self.ok("POST", "/session", caps)["sessionId"]
        return self.sid

    def s(self, path):
        return "/session/%s%s" % (self.sid, path)

    def rich(self):
        self.ok("POST", self.s("/appium/settings"), RICH_SETTINGS)

    def find(self, value, using="predicate string", path="/elements"):
        return self.ok("POST", self.s(path), {"using": using, "value": value})

    def nodes_for(self, items):
        by_id = {node.id: node for app in self.fake.apps.values() for node in app.root.walk()}
        return [by_id[item[ELEMENT_KEY]] for item in items]


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

class TransportTests(FakeCase):
    def test_keep_alive_and_exact_content_length(self):
        self.conn.request("GET", "/status")
        first = self.conn.getresponse()
        data = first.read()
        sock = self.conn.sock
        self.assertEqual(first.version, 11)
        self.assertEqual(first.status, 200)
        self.assertEqual(first.reason, "OK")
        self.assertEqual(first.getheader("Content-Type"), "application/json;charset=UTF-8")
        self.assertEqual(first.getheader("Server"), "WebDriverAgent/1.0")
        self.assertEqual(first.getheader("Access-Control-Allow-Origin"), "*")
        self.assertEqual(int(first.getheader("Content-Length")), len(data))
        self.assertIsNone(first.getheader("Connection"))
        self.assertIsNone(first.getheader("Transfer-Encoding"))
        self.assertIn(b'\n  "value" : {', data)  # pretty-printed like NSJSONSerialization
        self.ok("GET", "/wda/locked")
        self.assertIs(self.conn.sock, sock, "the connection must be reused")

    def test_transfer_encoding_is_rejected_and_the_connection_closed(self):
        data = raw_exchange(self.fake.port, b"POST /session HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n"
                                            b"\r\n0\r\n\r\nGET /status HTTP/1.1\r\n\r\n")
        responses = split_responses(data)
        self.assertEqual(len(responses), 1, "nothing may be answered after the rejection")
        status_line, headers, body = responses[0]
        self.assertEqual(status_line, "HTTP/1.1 400 Bad Request")
        value = json.loads(body)["value"]
        self.assertEqual((value["error"], value["message"]), ("invalid argument", "Transfer-Encoding is not supported"))
        self.assertEqual(self.fake.routes(), ["POST /session"])
        self.assertIsNone(self.fake.active_sid)

    def test_malformed_requests_are_rejected_and_closed(self):
        cases = [b"GET /status HTTP/1.1\r\nNoColonHere\r\n\r\n",
                 b"GET /status HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nxx",
                 b"POST /session HTTP/1.1\r\nContent-Length: 12x\r\n\r\n",
                 b"GET /status HTTP/1.1\r\nHost : x\r\n\r\n",
                 b"GARBAGE\r\n\r\n"]
        for request in cases:
            with self.subTest(request=request):
                responses = split_responses(raw_exchange(self.fake.port, request))
                self.assertEqual(len(responses), 1)
                self.assertTrue(responses[0][0].startswith("HTTP/1.1 400"))
                value = json.loads(responses[0][2])["value"]
                self.assertEqual(value["message"], "The request could not be parsed as valid HTTP")

    def test_pipelined_requests_are_answered_in_order(self):
        data = raw_exchange(self.fake.port, b"GET /status HTTP/1.1\r\n\r\n"
                                            b"GET /wda/locked HTTP/1.1\r\nConnection: close\r\n\r\n")
        responses = split_responses(data)
        self.assertEqual([r[0] for r in responses], ["HTTP/1.1 200 OK", "HTTP/1.1 200 OK"])
        self.assertTrue(json.loads(responses[0][2])["value"]["ready"])
        self.assertIs(json.loads(responses[1][2])["value"], False)
        self.assertEqual(responses[1][1].get("connection"), "close")

    def test_unparseable_json_body_is_treated_as_empty(self):
        self.conn.request("POST", "/session", body=b"{not json", headers={"Content-Type": "application/json"})
        response = self.conn.getresponse()
        value = json.loads(response.read())["value"]
        self.assertEqual(response.status, 500)
        self.assertEqual(value["error"], "session not created")
        self.assertIsNone(self.fake.requests[-1].body)

    def test_json_array_body_breaks_the_handler(self):
        self.session()
        status, body, _ = self.call("POST", self.s("/wda/keys"), ["a"])
        self.assertEqual((status, body["value"]["error"]), (500, "unknown error"))

    def test_options_and_health(self):
        self.assertIsNone(self.ok("OPTIONS", "/anything/at/all"))
        self.conn.request("GET", "/health")
        response = self.conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIsNone(response.getheader("Content-Type"))
        self.assertEqual(response.read(), b"<!DOCTYPE html><html><title>Health Check</title><body><p>I-AM-ALIVE</p>"
                                          b"</body></html>")

    def test_queue_lock_serialises_normal_routes_but_not_status(self):
        self.session()
        self.fake.inject("GET", "/source", delay=0.3)
        worker = threading.Thread(target=lambda: self.ok("GET", self.s("/source"), conn=self.connection()))
        worker.start()
        time.sleep(0.05)
        started = time.monotonic()
        self.ok("GET", "/status", conn=self.connection())
        status_seconds = time.monotonic() - started
        self.ok("GET", "/window/size", conn=self.connection())
        queued_seconds = time.monotonic() - started
        worker.join(5)
        self.assertLess(status_seconds, 0.2)
        self.assertGreater(queued_seconds, 0.15)


# ---------------------------------------------------------------------------
# Routing and sessions
# ---------------------------------------------------------------------------

class RoutingTests(FakeCase):
    def test_wrong_scope_and_unknown_paths_are_unknown_command(self):
        sid = self.session()
        cases = [("POST", "/session/%s/wda/homescreen" % sid, {}), ("POST", "/wda/pressButton", {"name": "home"}),
                 ("GET", "/status/", None), ("GET", "/nope", None), ("PATCH", "/status", None),
                 ("GET", "/session/%s/status" % sid, None), ("POST", "/elements", {"using": "x", "value": "y"}),
                 ("POST", "/wda/tap", {"x": 1, "y": 1}), ("POST", "/session/%s" % sid, {}),
                 ("GET", "/wda/tap/0", None)]
        for method, path, payload in cases:
            with self.subTest(method=method, path=path):
                value = self.wda_error(method, path, payload, code="unknown command", status=404)
                self.assertTrue(value["message"].startswith("Unhandled endpoint: "))
        self.assertEqual(self.fake.foreground, "com.apple.Preferences")
        self.assertEqual(self.fake.taps, [])

    def test_routes_available_in_both_scopes(self):
        self.session()
        for path in ("/source", "/window/size", "/wda/activeAppInfo", "/wda/locked", "/wda/screen", "/screenshot"):
            with self.subTest(path=path):
                self.assertEqual(self.ok("GET", path), self.ok("GET", self.s(path)))

    def test_stale_session_id(self):
        _, body, _ = self.call("GET", "/session/NOT-A-SESSION/window/size")
        self.assertEqual(body["value"]["error"], "invalid session id")
        self.assertIsNone(body["sessionId"])
        sid = self.session()
        status, body, _ = self.call("GET", "/session/NOT-A-SESSION/window/size")
        self.assertEqual((status, body["value"]["message"]), (404, "Session does not exist"))
        self.assertEqual(body["sessionId"], sid, "every response names the active session")

    def test_route_matching_is_case_insensitive(self):
        self.assertIs(self.ok("GET", "/WDA/LOCKED"), False)

    def test_every_response_carries_the_active_session(self):
        sid = self.session()
        _, body, _ = self.call("GET", "/status")
        self.assertEqual(body["sessionId"], sid)


class SessionTests(FakeCase):
    def test_create_session(self):
        status, body, _ = self.call("POST", "/session", CAPS)
        self.assertEqual(status, 200)
        sid = body["value"]["sessionId"]
        self.assertRegex(sid, SID_RE)
        self.assertEqual(body["sessionId"], sid)
        self.assertEqual(body["value"]["capabilities"], {"device": "iphone", "sdkVersion": "18.0"})
        self.assertEqual(self.fake.active_sid, sid)
        expected = dict(SETTINGS_DEFAULTS, waitForIdleTimeout=0, maxTypingFrequency=30)
        self.assertEqual(self.fake.settings, expected)

    def test_capability_borne_settings_but_not_animation_cool_off(self):
        caps = {"capabilities": {"alwaysMatch": {"appium:shouldUseCompactResponses": False,
                                                 "elementResponseAttributes": "type", "animationCoolOffTimeout": 0},
                                 "firstMatch": [{"waitForIdleTimeout": 3}]}}
        self.session(caps)
        self.assertIs(self.fake.settings["shouldUseCompactResponses"], False)
        self.assertEqual(self.fake.settings["elementResponseAttributes"], "type")
        self.assertEqual(self.fake.settings["waitForIdleTimeout"], 3)
        self.assertEqual(self.fake.settings["animationCoolOffTimeout"], 2)

    def test_new_session_resets_settings_and_invalidates_element_ids(self):
        first = self.session()
        self.ok("POST", self.s("/appium/settings"), {"settings": {"animationCoolOffTimeout": 0, "custom": 1}})
        item = self.find("label == 'Wi-Fi'")[0]
        element_path = "/element/%s/rect" % item[ELEMENT_KEY]
        self.assertEqual(self.ok("GET", self.s(element_path)), {"x": 16, "y": 347, "width": 358, "height": 44})
        second = self.session()
        self.assertNotEqual(first, second)
        self.assertEqual(self.fake.settings["animationCoolOffTimeout"], 2)
        self.assertNotIn("custom", self.fake.settings)
        value = self.wda_error("GET", "/session/%s%s" % (first, element_path), code="invalid session id")
        self.assertEqual(value["message"], "Session does not exist")
        value = self.wda_error("GET", self.s(element_path), code="stale element reference", status=404)
        self.assertIn("expired from the internal cache", value["message"])

    def test_capabilities_are_mandatory_and_the_old_session_dies_anyway(self):
        self.session()
        value = self.wda_error("POST", "/session", {"desiredCapabilities": {}}, code="session not created",
                               status=500)
        self.assertEqual(value["message"], "'capabilities' is mandatory to create a new session")
        self.assertIsNone(self.fake.active_sid)

    def test_get_and_delete_session(self):
        sid = self.session()
        self.assertEqual(self.ok("GET", "/session/" + sid)["sessionId"], sid)
        self.assertIsNone(self.ok("DELETE", "/session/" + sid))
        self.assertIsNone(self.fake.active_sid)
        self.wda_error("GET", "/session/%s/source" % sid, code="invalid session id")
        self.wda_error("DELETE", "/session/" + sid, code="invalid session id")
        self.wda_error("GET", "/session/" + sid, code="invalid session id")
        self.assertEqual(self.fake.calls(route="/session/:sid", method="DELETE")[0].sid, sid)

    def test_invalidate_session_models_another_client(self):
        sid = self.session()
        item = self.find("label == 'Done'")[0]
        self.fake.invalidate_session()
        self.assertNotEqual(self.fake.active_sid, sid)
        self.assertRegex(self.fake.active_sid, SID_RE)
        self.wda_error("GET", self.s("/source"), code="invalid session id")
        self.sid = self.fake.active_sid
        self.wda_error("GET", self.s("/element/%s/rect" % item[ELEMENT_KEY]), code="stale element reference")


class SettingsTests(FakeCase):
    def test_merge_return_and_history(self):
        self.session()
        value = self.ok("POST", self.s("/appium/settings"), {"settings": {"animationCoolOffTimeout": 0.8,
                                                                         "ignored": None}})
        self.assertEqual(value, dict(self.fake.settings))
        self.assertEqual(value["animationCoolOffTimeout"], 0.8)
        self.assertEqual(value["waitForIdleTimeout"], 0)
        self.assertNotIn("ignored", value)
        self.ok("POST", self.s("/appium/settings"), {"settings": {"animationCoolOffTimeout": 0}})
        self.assertEqual(self.fake.settings_history, [{"animationCoolOffTimeout": 0.8, "ignored": None},
                                                      {"animationCoolOffTimeout": 0}])
        self.assertEqual(self.ok("GET", self.s("/appium/settings")), dict(self.fake.settings))
        self.assertEqual(self.ok("POST", self.s("/appium/settings"), {}), dict(self.fake.settings))

    def test_non_dict_settings_and_wrong_scope(self):
        self.session()
        value = self.wda_error("POST", self.s("/appium/settings"), {"settings": [1]}, code="invalid argument",
                               status=400)
        self.assertEqual(value["message"], "settings must be a dictionary")
        self.wda_error("POST", "/appium/settings", {"settings": {}}, code="unknown command")


# ---------------------------------------------------------------------------
# /source
# ---------------------------------------------------------------------------

class SourceTests(FakeCase):
    def test_settings_source_is_byte_identical_to_the_reference_document(self):
        self.assertEqual(self.ok("GET", "/source"), SETTINGS_XML)
        self.session()
        self.assertEqual(self.ok("GET", self.s("/source?format=xml")), SETTINGS_XML)
        self.assertEqual(self.ok("GET", self.s("/source?format=XML")), SETTINGS_XML)

    def test_attribute_order_on_every_element(self):
        self.fake.set_foreground("com.example.form")
        for document in (SETTINGS_XML, self.ok("GET", "/source")):
            for line in document.splitlines()[1:]:
                if line.strip().startswith("</"):
                    continue
                names = re.findall(r' ([A-Za-z]+)="', line)
                positions = [XML_ATTRIBUTE_ORDER.index(name) for name in names]
                self.assertEqual(positions, sorted(positions), line)
                self.assertEqual(names[0], "type")
                self.assertIn("traits", names)

    def test_root_attributes_and_text_field_labels(self):
        self.fake.set_foreground("com.example.form")
        root = ET.fromstring(self.ok("GET", "/source"))
        self.assertEqual(list(root.attrib)[-2:], ["processId", "bundleId"])
        self.assertEqual(root.get("bundleId"), "com.example.form")
        fields = [e for e in root.iter() if e.get("type") in ("XCUIElementTypeTextField",
                                                              "XCUIElementTypeSecureTextField")]
        self.assertEqual([(e.get("label"), e.get("value"), e.get("placeholderValue")) for e in fields],
                         [("", "Email", "Email"), ("", "Password", "Password")])
        text_view = root.find(".//XCUIElementTypeTextView")
        self.assertNotIn("placeholderValue", text_view.attrib)
        self.assertNotIn("label", text_view.attrib)
        self.assertEqual(text_view.get("name"), "message")
        self.assertTrue(all("processId" not in e.attrib for e in root.iter() if e is not root))

    def test_elementtree_and_wda_tree_parse_it(self):
        xml = self.ok("GET", "/source")
        self.assertEqual(len(list(ET.fromstring(xml).iter())), 16)
        tree = wda_tree.parse_source(xml)
        self.assertEqual((tree.bundle_id, tree.width, tree.height), ("com.apple.Preferences", 390.0, 844.0))

    def test_excluded_attributes(self):
        xml = self.ok("GET", "/source?format=xml&excluded_attributes=visible")
        self.assertNotIn(" visible=", xml)
        self.assertEqual(xml, SETTINGS_XML.replace(' visible="true"', "").replace(' visible="false"', ""))
        xml = self.ok("GET", "/source?excluded_attributes=Visible,ACCESSIBLE,%20traits,bundleId,type,unknown")
        for name in ("visible", "accessible", "traits"):
            self.assertNotIn(" %s=" % name, xml)
        self.assertIn(' bundleId="com.apple.Preferences"', xml)
        self.assertIn('<XCUIElementTypeWindow type="XCUIElementTypeWindow"', xml)

    def test_wrapper_root(self):
        self.fake.wrapper_root = "AppiumAUT"
        xml = self.ok("GET", "/source")
        root = ET.fromstring(xml)
        self.assertEqual(root.tag, "AppiumAUT")
        self.assertEqual(root.attrib, {})
        self.assertEqual(root[0].get("bundleId"), "com.apple.Preferences")
        self.assertIn("\n  <XCUIElementTypeApplication ", xml)
        tree = wda_tree.parse_source(xml)
        self.assertEqual((tree.bundle_id, tree.width, tree.height), (None, None, None))
        self.fake.wrapper_root = None
        self.assertEqual(ET.fromstring(self.ok("GET", "/source?scope=Wrapper")).tag, "Wrapper")

    def test_root_attributes_can_be_omitted(self):
        self.fake.root_attributes = False
        root = ET.fromstring(self.ok("GET", "/source"))
        self.assertNotIn("bundleId", root.attrib)
        self.assertNotIn("processId", root.attrib)
        self.assertEqual(root.get("width"), "390")

    def test_escaping_of_attribute_values(self):
        label = 'a<b>&"c"\td\ne\rf\x01g￾'
        root = Node("Application", label="Esc", children=[Node("StaticText", label=label, rect=(0, 0, 10, 10))])
        self.fake.set_tree("com.apple.Preferences", root)
        xml = self.ok("GET", "/source")
        self.assertIn('label="a&lt;b&gt;&amp;&quot;c&quot;&#9;d&#10;e&#13;fg"', xml)
        parsed = ET.fromstring(xml)
        self.assertEqual(parsed[0].get("label"), 'a<b>&"c"\td\ne\rfg')

    def test_springboard_and_empty_roots(self):
        self.fake.set_foreground("com.apple.springboard")
        root = ET.fromstring(self.ok("GET", "/source"))
        self.assertEqual((root.get("bundleId"), root.get("label")), ("com.apple.springboard", "SpringBoard"))
        self.assertEqual([icon.get("label") for icon in root.iter("XCUIElementTypeIcon")],
                         ["Settings", "Notes", "Messages"])
        self.fake.set_tree("com.example.empty", Node("Application"))
        self.fake.set_foreground("com.example.empty")
        xml = self.ok("GET", "/source")
        self.assertEqual(xml.splitlines()[1],
                         '<XCUIElementTypeApplication type="XCUIElementTypeApplication" enabled="true" '
                         'visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0" '
                         'traits="" processId="%d" bundleId="com.example.empty"/>'
                         % self.fake.app("com.example.empty").pid)
        self.assertEqual(wda_tree.filter_nodes(wda_tree.parse_source(xml).elements,
                                               {"width": 390, "height": 844}), [])

    def test_integral_rects(self):
        root = Node("Application", children=[Node("Button", label="b", rect=(10.4, 20.6, 30.2, 5.5))])
        self.fake.set_tree("com.apple.Preferences", root)
        button = ET.fromstring(self.ok("GET", "/source"))[0]
        self.assertEqual([button.get(k) for k in ("x", "y", "width", "height")], ["10", "20", "31", "7"])

    def test_other_formats_and_depth_limit(self):
        tree = self.ok("GET", "/source?format=json")
        self.assertEqual((tree["type"], tree["name"], tree["isEnabled"]), ("Application", "Settings", "1"))
        self.assertEqual(tree["children"][0]["type"], "Window")
        self.assertIsInstance(self.ok("GET", "/source?format=description"), str)
        value = self.wda_error("GET", "/source?format=yaml", code="invalid argument", status=400)
        self.assertIn("Unknown source format 'yaml'", value["message"])
        self.session()
        self.ok("POST", self.s("/appium/settings"), {"settings": {"snapshotMaxDepth": 1}})
        root = ET.fromstring(self.ok("GET", self.s("/source")))
        self.assertEqual([e.tag for e in root.iter()], ["XCUIElementTypeApplication", "XCUIElementTypeWindow"])

    def test_parse_xml_round_trip(self):
        app = App("com.apple.Preferences", parse_xml(SETTINGS_XML), pid=412)
        with FakeWDA(apps=[app]) as other:
            conn = http.client.HTTPConnection("127.0.0.1", other.port, timeout=5)
            self.addCleanup(conn.close)
            conn.request("GET", "/source")
            self.assertEqual(json.loads(conn.getresponse().read())["value"], SETTINGS_XML)
        wrapped = parse_xml("<AppiumAUT>" + SETTINGS_XML.split("\n", 1)[1] + "</AppiumAUT>")
        self.assertEqual(wrapped.type, "XCUIElementTypeApplication")
        field = wrapped.find(type="TextField")
        self.assertIsNone(field.value, "an empty field's placeholder value is not its text")
        self.assertEqual(field.wd_value, "Email")


# ---------------------------------------------------------------------------
# Predicates and element lookups
# ---------------------------------------------------------------------------

TRICKY = ["it's \n", "a\\b ", 'say "hi"', "line\nbreak", "line\\nbreak", "tab\there", "\U0001F44D\U0001F3FD up",
          "%@ literal", "你好", "back\\", "quote'", "del\x7f", "sep line", "a' OR TRUEPREDICATE OR "
          "label == 'b"]


class PredicateTests(FakeCase):
    def setUp(self):
        super().setUp()
        self.session()

    def types(self, items):
        return [node.type[len("XCUIElementType"):] for node in self.nodes_for(items)]

    def labels(self, value):
        return [node.label for node in self.nodes_for(self.find(value))]

    def test_root_is_included_in_tree_order(self):
        self.assertEqual(self.types(self.find("label == 'Settings'")), ["Application", "StaticText"])
        self.assertEqual(self.types(self.find("name == 'Settings'")),
                         ["Application", "NavigationBar", "StaticText"])

    def test_plugin_predicates_select_exactly_the_intended_node(self):
        children = [Node("StaticText", label=text, rect=(0, i * 20, 100, 20)) for i, text in enumerate(TRICKY)]
        root = Node("Application", label="Tricky", children=[Node("Window", children=children)])
        self.fake.set_tree("com.apple.Preferences", root)
        for text in TRICKY:
            with self.subTest(text=text):
                self.assertEqual(self.labels(wda_tree.predicate({"label": text})), [text])
                self.assertEqual(self.labels(wda_tree.predicate({"type": "StaticText", "label": text})), [text])
        self.assertEqual(self.labels(wda_tree.predicate({"label_contains": "line"})),
                         ["line\nbreak", "line\\nbreak", "sep line"])
        self.assertEqual(self.labels(wda_tree.predicate({"label_contains": "\\"})),
                         ["a\\b ", "line\\nbreak", "back\\"])
        self.assertEqual(self.labels(wda_tree.predicate({"label_contains": "'"})),
                         ["it's \n", "quote'", TRICKY[-1]])

    def test_double_quoted_literals_and_escapes(self):
        root = Node("Application", children=[Node("Button", label='say "hi"'), Node("Button", label="x'y")])
        self.fake.set_tree("com.apple.Preferences", root)
        self.assertEqual(self.labels('label == "say \\"hi\\""'), ['say "hi"'])
        self.assertEqual(self.labels('label == "x\'y"'), ["x'y"])
        self.assertEqual(self.labels("label == 'x\\u0027y'"), ["x'y"])
        self.assertEqual(self.labels("label == 'X\\u0027Y'"), [])

    def test_enabled_forms(self):
        for literal in ("false", "NO", "0", "FALSE"):
            with self.subTest(literal=literal):
                self.assertEqual(self.labels("enabled == " + literal), ["Privacy & Security\nLocation, Camera"])
        cells = self.find("enabled == true AND type == 'XCUIElementTypeCell'")
        self.assertEqual(len(cells), 4)
        self.assertEqual(self.find("enabled == 'true'"), [])

    def test_attribute_semantics(self):
        self.assertEqual(self.types(self.find("value == 'Search'")), ["SearchField"])
        self.assertEqual(self.types(self.find("value == 'Settings'")), ["StaticText"])
        self.assertEqual(self.types(self.find("placeholderValue == 'Email'")), ["TextField"])
        self.assertEqual(self.labels("visible == false"), ["General"])
        self.assertEqual(len(self.find("hittable == true")), 16)
        self.assertEqual(self.types(self.find("label == ''")), ["TextField"])
        self.assertEqual(self.find("type == 'Button'"), [], "types are full names")

    def test_operators(self):
        self.assertEqual(len(self.find("TRUEPREDICATE")), 16)
        self.assertEqual(self.find("FALSEPREDICATE"), [])
        self.assertEqual(self.labels("label BEGINSWITH 'Wi'"), ["Wi-Fi"])
        self.assertEqual(self.labels("label ENDSWITH 'Camera'"), ["Privacy & Security\nLocation, Camera"])
        self.assertEqual(self.labels("label CONTAINS[c] 'GENERAL'"), ["General"])
        self.assertEqual(self.labels("label LIKE 'Wi-*'"), ["Wi-Fi"])
        self.assertEqual(self.labels("label MATCHES 'G.n.*l'"), ["General"])
        self.assertEqual(self.labels("label == 'Wi-Fi' OR label == 'General'"), ["Wi-Fi", "General"])
        self.assertEqual(self.labels("label == 'Wi-Fi' || label == 'General'"), ["Wi-Fi", "General"])
        # The label-less container cell matches too: nil CONTAINS 'i' is false, so NOT makes it true.
        self.assertEqual(self.labels("type == 'XCUIElementTypeCell' AND NOT (label CONTAINS 'i')"), [None, "General"])
        self.assertEqual(self.labels("type == 'XCUIElementTypeCell' && !(enabled == true)"),
                         ["Privacy & Security\nLocation, Camera"])
        self.assertEqual(len(self.find("type != 'XCUIElementTypeCell'")), 11)
        self.assertEqual(len(self.find("label != 'Settings'")), 14)
        self.assertEqual(self.labels("(label == 'Done') and (enabled == YES)"), ["Done"])

    def test_syntax_errors_are_500_unknown_error(self):
        cases = ["label ==", "label == 'unterminated", "label == 'a\nb'", "(label == 'x'", "label == 'x' AND",
                 "label 'x'", "label == 'bad \\q escape'", "'x' == label", "label == 'a' garbage",
                 "label == 'x\\u12'", "label === 'x'", ""]
        for value in cases:
            with self.subTest(value=value):
                error = self.wda_error("POST", self.s("/elements"), {"using": "predicate string", "value": value},
                                       code="unknown error", status=500)
                self.assertTrue(error["message"].startswith("Unable to parse the format string"))

    def test_unknown_attribute_is_500_unknown_error(self):
        error = self.wda_error("POST", self.s("/elements"), {"using": "predicate string", "value": "foo == 1"},
                               code="unknown error", status=500)
        self.assertTrue(error["message"].startswith("The attribute 'foo' is unknown"))
        error = self.wda_error("POST", self.s("/elements"),
                               {"using": "predicate string", "value": "label == 'x' OR Label == 'y'"},
                               code="unknown error")
        self.assertIn("'Label'", error["message"])

    def test_other_strategies(self):
        self.assertEqual(len(self.find("XCUIElementTypeCell", using="class name")), 5)
        self.wda_error("POST", self.s("/elements"), {"using": "class name", "value": "Cell"},
                       code="invalid argument", status=400)
        self.assertEqual(self.labels_for(self.find("com.apple.settings.wi-fi", using="accessibility id")), ["Wi-Fi"])
        value = self.wda_error("POST", self.s("/elements"), {"using": "xpath", "value": "//*"},
                               code="invalid argument", status=400)
        self.assertEqual(value["message"], "Invalid locator requested: xpath")
        self.wda_error("POST", self.s("/elements"), {"using": "predicate string"}, code="invalid argument")

    def labels_for(self, items):
        return [node.label for node in self.nodes_for(items)]

    def test_single_element_and_child_searches(self):
        item = self.find("type == 'XCUIElementTypeCell'", path="/element")
        self.assertIsInstance(item, dict)
        self.assertEqual(self.labels_for([item]), ["Sign in to your iPhone, Set up iCloud, the App Store, and more."])
        value = self.wda_error("POST", self.s("/element"), {"using": "predicate string", "value": "label == 'zz'"},
                               code="no such element", status=404)
        self.assertEqual(value["message"], "unable to find an element using 'predicate string', value 'label == 'zz''")
        table = self.find("type == 'XCUIElementTypeTable'")[0]
        cells = self.ok("POST", self.s("/element/%s/elements" % table[ELEMENT_KEY]),
                        {"using": "predicate string", "value": "type == 'XCUIElementTypeCell'"})
        self.assertEqual(len(cells), 5)
        switch = self.ok("POST", self.s("/element/%s/element" % table[ELEMENT_KEY]),
                         {"using": "class name", "value": "XCUIElementTypeSwitch"})
        self.assertEqual(self.labels_for([switch]), ["Airplane Mode"])

    def test_compact_items_by_default(self):
        items = self.find("label == 'Wi-Fi'")
        self.assertEqual(len(items), 1)
        self.assertEqual(set(items[0]), {ELEMENT_KEY, "ELEMENT"})
        self.assertEqual(items[0][ELEMENT_KEY], items[0]["ELEMENT"])
        self.assertRegex(items[0]["ELEMENT"], ID_RE)
        self.assertEqual(self.find("label == 'Wi-Fi'"), items, "ids are stable per node")

    def test_rich_items_after_settings(self):
        self.rich()
        item = self.find("label == 'Wi-Fi'")[0]
        self.assertEqual({key: value for key, value in item.items() if key not in (ELEMENT_KEY, "ELEMENT")},
                         {"type": "XCUIElementTypeCell", "label": "Wi-Fi",
                          "rect": {"x": 16, "y": 347, "width": 358, "height": 44}, "enabled": True,
                          "attribute/name": "com.apple.settings.wi-fi", "attribute/value": "Home-5G"})
        self.ok("POST", self.s("/appium/settings"),
                {"settings": {"elementResponseAttributes": "name,text,displayed,selected,attribute/bogus,unknown"}})
        item = self.find("label == 'Wi-Fi'")[0]
        self.assertEqual(item["name"], "XCUIElementTypeCell", "WDA's name field is the type")
        self.assertEqual(item["text"], "Home-5G")
        self.assertIs(item["displayed"], True)
        self.assertNotIn("attribute/bogus", item)
        self.assertNotIn("unknown", item)

    def test_rich_elements_switch_forces_bare_ids(self):
        self.rich()
        self.fake.rich_elements = False
        self.assertEqual(set(self.find("label == 'Wi-Fi'")[0]), {ELEMENT_KEY, "ELEMENT"})


class ElementRouteTests(FakeCase):
    def setUp(self):
        super().setUp()
        self.fake.set_foreground("com.example.form")
        self.session()

    def element(self, predicate):
        return "/element/%s" % self.find(predicate)[0][ELEMENT_KEY]

    def test_rect_and_attributes(self):
        email = self.element("name == 'email'")
        self.assertEqual(self.ok("GET", self.s(email + "/rect")), {"x": 16, "y": 120, "width": 358, "height": 44})
        expected = {"hittable": True, "type": "XCUIElementTypeTextField", "value": "Email", "name": "email",
                    "label": "", "enabled": True, "visible": True, "placeholderValue": "Email"}
        for name, value in expected.items():
            with self.subTest(name=name):
                self.assertEqual(self.ok("GET", self.s(email + "/attribute/" + name)), value)
        error = self.wda_error("GET", self.s(email + "/attribute/bogus"), code="unknown error", status=500)
        self.assertIn("'bogus'", error["message"])
        send = self.element("label == 'Send'")
        self.assertIsNone(self.ok("GET", self.s(send + "/attribute/value")))
        self.assertIsNone(self.ok("GET", self.s(send + "/attribute/placeholderValue")))
        self.assertEqual(self.ok("GET", self.s(send + "/text")), "Send")
        self.assertEqual(self.ok("GET", self.s(send + "/name")), "XCUIElementTypeButton")
        self.assertIs(self.ok("GET", self.s(send + "/enabled")), True)
        self.assertIs(self.ok("GET", self.s(send + "/displayed")), True)

    def test_click_focuses_and_active_element(self):
        value = self.wda_error("GET", self.s("/element/active"), code="no such element", status=404)
        self.assertEqual(value["message"], "unable to find an element using '(null)', value '(null)'")
        email = self.element("name == 'email'")
        self.assertIsNone(self.ok("POST", self.s(email + "/click"), {}))
        self.assertEqual(self.fake.focused_node().name, "email")
        active = self.ok("GET", self.s("/element/active"))
        self.assertEqual("/element/" + active[ELEMENT_KEY], email)
        self.ok("POST", self.s(self.element("name == 'message'") + "/click"), {})
        self.assertEqual(self.fake.focused_node().name, "message")

    def test_value_clear_and_readback(self):
        email = self.element("name == 'email'")
        self.ok("POST", self.s(email + "/value"), {"text": "ann@", "frequency": 30})
        self.ok("POST", self.s(email + "/value"), {"value": ["exam", "ple.com"]})
        self.ok("POST", self.s(email + "/value"), {"value": "!", "text": "ignored"})
        self.assertEqual(self.ok("GET", self.s(email + "/attribute/value")), "ann@example.com!")
        self.assertEqual(self.fake.typed, ["ann@", "example.com", "!"])
        self.assertEqual(self.fake.focused_node().name, "email")
        self.ok("POST", self.s(email + "/clear"), {})
        self.assertEqual(self.ok("GET", self.s(email + "/attribute/value")), "Email", "empty reads as placeholder")
        self.assertIsNone(self.fake.node(name="email").value)
        value = self.wda_error("POST", self.s(email + "/value"), {"frequency": 30}, code="invalid argument",
                               status=400)
        self.assertEqual(value["message"], "Neither 'value' nor 'text' parameter is provided")

    def test_newline_submits_single_line_fields_but_breaks_lines_in_text_views(self):
        email = self.element("name == 'email'")
        self.ok("POST", self.s(email + "/value"), {"text": "a@b.c\n"})
        self.assertEqual(self.fake.submits, ["a@b.c"])
        self.assertEqual(self.fake.node(name="email").value, "a@b.c")
        message = self.element("name == 'message'")
        self.ok("POST", self.s(message + "/value"), {"text": "line 1\nline 2"})
        self.assertEqual(self.fake.node(name="message").value, "line 1\nline 2")
        self.assertEqual(self.fake.submits, ["a@b.c"])

    def test_secure_field_reads_back_bullets(self):
        password = self.element("name == 'password'")
        self.assertEqual(self.ok("GET", self.s(password + "/attribute/value")), "Password")
        self.ok("POST", self.s(password + "/value"), {"text": "hunter2"})
        self.assertEqual(self.ok("GET", self.s(password + "/attribute/value")), "•" * 7)
        self.assertEqual(self.ok("GET", self.s(password + "/attribute/type")), "XCUIElementTypeSecureTextField")

    def test_unknown_and_vanished_ids_are_stale(self):
        value = self.wda_error("GET", self.s("/element/FFFFFFFF-0000-0000-9C01-000000000000/rect"),
                               code="stale element reference", status=404)
        self.assertIn("expired from the internal cache", value["message"])
        known = self.fake.node(label="Send")
        value = self.wda_error("POST", self.s("/element/%s/click" % known.id), {}, code="stale element reference")
        self.assertIn("either not present", value["message"])
        send = self.element("label == 'Send'")
        self.fake.set_foreground("com.apple.Preferences")
        value = self.wda_error("POST", self.s(send + "/click"), {}, code="stale element reference")
        self.assertIn("not present in the current view anymore", value["message"])


class KeysTests(FakeCase):
    def setUp(self):
        super().setUp()
        self.fake.set_foreground("com.example.form")
        self.session()

    def test_value_must_be_a_list(self):
        error = self.wda_error("POST", self.s("/wda/keys"), {"value": "abc"}, code="unknown error", status=500)
        self.assertIn("unrecognized selector", error["message"])
        self.assertEqual(self.fake.typed, [])

    def test_types_into_the_focused_field(self):
        self.fake.node(name="message").focused = True
        self.ok("POST", self.s("/wda/keys"), {"value": ["Hello ", "\U0001F44B"], "frequency": 30})
        self.ok("POST", self.s("/wda/keys"), {"value": ["\n"]})
        self.assertEqual(self.fake.node(name="message").value, "Hello \U0001F44B\n")
        self.assertEqual(self.fake.typed, ["Hello \U0001F44B", "\n"])

    def test_nothing_focused_succeeds_and_changes_nothing(self):
        self.assertIsNone(self.ok("POST", self.s("/wda/keys"), {"value": ["lost"]}))
        self.assertTrue(all(node.value is None for node in self.fake.app("com.example.form").root.walk()))
        self.assertEqual(self.fake.typed, ["lost"])
        self.assertEqual(self.fake.submits, [])


# ---------------------------------------------------------------------------
# Gestures, buttons, apps and device state
# ---------------------------------------------------------------------------

class GestureTests(FakeCase):
    def setUp(self):
        super().setUp()
        self.session()

    def test_tap_hit_test_focuses_a_text_field(self):
        self.fake.set_foreground("com.example.form")
        self.ok("POST", self.s("/wda/tap"), {"x": 195, "y": 142})
        self.assertEqual(self.fake.focused_node().name, "email")
        self.assertEqual(self.fake.taps, [(195, 142)])
        self.ok("POST", self.s("/wda/tap"), {"x": 20.5, "y": 200.25})
        self.assertEqual(self.fake.focused_node().name, "password")

    def test_tap_argument_rules(self):
        for payload in ({"x": 10}, {"y": 10}, {"x": 10, "y": None}):
            with self.subTest(payload=payload):
                value = self.wda_error("POST", self.s("/wda/tap"), payload, code="invalid argument", status=400)
                self.assertEqual(value["message"], "Both x and y coordinates must be provided")
        self.wda_error("POST", self.s("/wda/tap"), {"x": "1", "y": 2}, code="invalid argument")
        self.assertEqual(self.fake.taps, [])
        self.ok("POST", self.s("/wda/tap"), {})
        self.assertEqual(self.fake.taps, [(195.0, 422.0)], "no coordinates taps the centre (and is recorded)")

    def test_tap_runs_on_tap_and_bubbles_to_the_handler(self):
        self.fake.set_foreground("com.apple.springboard")
        self.ok("POST", self.s("/wda/tap"), {"x": 59, "y": 138})
        self.assertEqual(self.fake.foreground, "com.apple.Preferences")
        hits = []
        cell = Node("Cell", label="Row", rect=(0, 100, 390, 60), on_tap=lambda fake, node: hits.append(node.label),
                    children=[Node("StaticText", label="Row title", rect=(16, 110, 200, 30))])
        hidden = Node("Button", label="Hidden", rect=(0, 300, 390, 60), visible=False,
                      on_tap=lambda fake, node: hits.append(node.label))
        self.fake.set_tree("com.apple.Preferences", Node("Application", children=[cell, hidden]))
        self.ok("POST", self.s("/wda/tap"), {"x": 50, "y": 120})
        self.ok("POST", self.s("/wda/tap"), {"x": 50, "y": 320})
        self.assertEqual(hits, ["Row"])

    def test_a_failing_callback_becomes_a_wda_error(self):
        def broken(fake, node):
            raise RuntimeError("callback bug")

        self.fake.set_tree("com.apple.Preferences", Node("Application", children=[
            Node("Button", label="Boom", rect=(0, 0, 100, 100), on_tap=broken)]))
        value = self.wda_error("POST", self.s("/wda/tap"), {"x": 10, "y": 10}, code="unknown error", status=500)
        self.assertIn("RuntimeError: callback bug", value["message"])
        self.assertEqual([type(e) for e in self.fake.handler_errors], [RuntimeError])
        self.assertIs(self.ok("GET", "/wda/locked"), False, "the connection survives")

    def test_element_click_runs_on_tap(self):
        self.fake.set_foreground("com.apple.springboard")
        notes_icon = self.find("label == 'Messages'")[0]
        self.fake.apps["com.apple.MobileSMS"] = App("com.apple.MobileSMS", Node("Application", label="Messages"))
        self.ok("POST", self.s("/element/%s/click" % notes_icon[ELEMENT_KEY]), {})
        self.assertEqual(self.fake.foreground, "com.apple.MobileSMS")

    def test_drag_advances_pages_and_stays_on_the_last(self):
        app, roots = list_app(pages=2, rows=3)
        self.fake.apps[app.bundle_id] = app
        self.fake.set_foreground(app.bundle_id)
        row = self.find("label == 'Row 1'")[0]
        drag = {"fromX": 195, "fromY": 557, "toX": 195, "toY": 287, "duration": 0.1}
        self.ok("POST", self.s("/wda/dragfromtoforduration"), drag)
        self.assertIs(app.root, roots[1])
        self.assertEqual([n.label for n in self.nodes_for(self.find("type == 'XCUIElementTypeCell'"))],
                         ["Row 4", "Row 5", "Row 6"])
        self.wda_error("GET", self.s("/element/%s/rect" % row[ELEMENT_KEY]), code="stale element reference")
        self.ok("POST", self.s("/wda/dragfromtoforduration"), drag)
        self.assertIs(app.root, roots[1])
        self.assertEqual(self.fake.drags, [drag, drag])

    def test_drag_defaults_errors_and_hook(self):
        seen = []
        self.fake.on_drag = lambda fake, drag: seen.append(drag)
        self.ok("POST", self.s("/wda/dragfromtoforduration"), {"toY": 5})
        self.assertEqual(self.fake.drags, [{"fromX": 0, "fromY": 0, "toX": 0, "toY": 5, "duration": 0}])
        self.assertEqual(seen, self.fake.drags)
        value = self.wda_error("POST", self.s("/wda/dragfromtoforduration"), {"duration": -1},
                               code="invalid argument", status=400)
        self.assertEqual(value["message"], "Drag press and hold durations must be non-negative numbers of seconds")
        self.wda_error("POST", self.s("/wda/dragfromtoforduration"), {"fromX": "a"}, code="invalid argument")
        self.assertEqual(len(self.fake.drags), 1)


class SystemTests(FakeCase):
    def test_homescreen_is_sessionless_and_can_be_ineffective(self):
        sid = self.session()
        self.assertIsNone(self.ok("POST", "/wda/homescreen", {}))
        self.assertEqual(self.fake.foreground, "com.apple.springboard")
        self.fake.set_foreground("com.example.form")
        self.fake.home_effective = False
        self.ok("POST", "/wda/homescreen", {})
        self.assertEqual(self.fake.foreground, "com.example.form")
        self.wda_error("POST", "/session/%s/wda/homescreen" % sid, {}, code="unknown command")

    def test_press_button(self):
        self.session()
        self.ok("POST", self.s("/wda/pressButton"), {"name": "volumeUp"})
        self.ok("POST", self.s("/wda/pressButton"), {"name": "VOLUMEDOWN"})
        self.assertEqual(self.fake.foreground, "com.apple.Preferences")
        self.ok("POST", self.s("/wda/pressButton"), {"name": "home"})
        self.assertEqual(self.fake.foreground, "com.apple.springboard")
        self.assertEqual(self.fake.buttons, ["volumeup", "volumedown", "home"])
        value = self.wda_error("POST", self.s("/wda/pressButton"), {"name": "power"}, code="unknown error",
                               status=500)
        self.assertIn("The button 'power' is not supported", value["message"])

    def test_apps(self):
        self.session()
        value = self.wda_error("POST", self.s("/wda/apps/activate"), {"bundleId": "com.missing.app"},
                               code="invalid argument", status=400)
        self.assertEqual(value["message"], "The application 'com.missing.app' is not installed on the device under test")
        self.ok("POST", self.s("/wda/apps/activate"), {"bundleId": "com.example.form"})
        self.assertEqual(self.fake.foreground, "com.example.form")
        self.fake.activate_effective = False
        self.ok("POST", self.s("/wda/apps/launch"), {"bundleId": "com.apple.Preferences"})
        self.assertEqual(self.fake.foreground, "com.example.form")
        self.wda_error("POST", self.s("/wda/apps/activate"), {}, code="unknown error", status=500)
        states = [self.ok("POST", self.s("/wda/apps/state"), {"bundleId": bundle})
                  for bundle in ("com.example.form", "com.apple.Preferences", "com.missing.app")]
        self.assertEqual(states, [4, 3, 1])
        self.assertIs(self.ok("POST", self.s("/wda/apps/terminate"), {"bundleId": "com.apple.Preferences"}), False)
        self.assertIs(self.ok("POST", self.s("/wda/apps/terminate"), {"bundleId": "com.example.form"}), True)
        self.assertEqual(self.fake.foreground, "com.apple.springboard")

    def test_locked_status_and_sizes(self):
        self.assertIs(self.ok("GET", "/wda/locked"), False)
        self.fake.locked = True
        self.assertIs(self.ok("GET", "/wda/locked"), True)
        status = self.ok("GET", "/status")
        self.assertIs(status["ready"], True)
        self.assertEqual(status["build"]["version"], "16.14.0")
        self.assertEqual(status["message"], "WebDriverAgent is ready to accept commands")
        self.assertEqual(set(status), {"ready", "message", "state", "os", "ios", "build", "device"})
        self.fake.status_ready = False
        self.assertIs(self.ok("GET", "/status")["ready"], False)
        self.assertEqual(self.ok("GET", "/window/size"), {"width": 390, "height": 844})
        self.assertEqual(self.ok("GET", "/wda/screen"), {"screenSize": {"width": 390, "height": 844},
                                                         "statusBarSize": {"width": 390, "height": 47},
                                                         "displayId": 1, "scale": 3})

    def test_screenshot_is_a_png_of_window_times_scale(self):
        data = base64.b64decode(self.ok("GET", "/screenshot"), validate=True)
        self.assertEqual(png_size(data), (1170, 2532))
        self.fake.screenshot_png = solid_png(2, 3)
        self.assertEqual(png_size(base64.b64decode(self.ok("GET", "/screenshot"))), (2, 3))
        self.fake.screenshot_png = None
        self.fake.size = (844, 390)
        self.assertEqual(png_size(base64.b64decode(self.ok("GET", "/screenshot"))), (2532, 1170))

    def test_other_device_sizes(self):
        with FakeWDA(size=(440, 956), scale=3) as other:
            conn = http.client.HTTPConnection("127.0.0.1", other.port, timeout=5)
            self.addCleanup(conn.close)
            conn.request("GET", "/screenshot")
            data = base64.b64decode(json.loads(conn.getresponse().read())["value"])
            self.assertEqual(png_size(data), (1320, 2868))
            conn.request("GET", "/source")
            root = ET.fromstring(json.loads(conn.getresponse().read())["value"])
            self.assertEqual((root.get("width"), root.get("height")), ("440", "956"))

    def test_active_app_info_and_foreground_sequence(self):
        info = self.ok("GET", "/wda/activeAppInfo")
        self.assertEqual(info, {"pid": 412, "bundleId": "com.apple.Preferences", "name": "", "processArguments": {}})
        self.fake.foreground_sequence = ["local.pid.77", "com.example.form"]
        bundles = [self.ok("GET", "/wda/activeAppInfo")["bundleId"] for _ in range(3)]
        self.assertEqual(bundles, ["local.pid.77", "com.example.form", "com.example.form"])
        self.assertEqual(self.fake.foreground, "com.apple.Preferences")

    def test_forbidden_routes_exist_and_are_recorded(self):
        self.assertIsNone(self.ok("GET", "/wda/healthcheck"))
        self.fake.locked = True
        self.assertIsNone(self.ok("POST", "/wda/unlock", {}))
        self.assertTrue(self.fake.locked, "the fake never unlocks the phone")
        self.assertEqual(self.fake.routes(), ["GET /wda/healthcheck", "POST /wda/unlock"])


# ---------------------------------------------------------------------------
# Fault injection and the request log
# ---------------------------------------------------------------------------

class InjectTests(FakeCase):
    def setUp(self):
        super().setUp()
        self.session()

    def test_error_uses_the_wda_status_table(self):
        self.fake.inject("GET", "/wda/locked", error="unknown error", message="boom")
        status, body, _ = self.call("GET", "/wda/locked")
        self.assertEqual(status, 500)
        self.assertEqual(body["value"], {"error": "unknown error", "message": "boom", "traceback": ""})
        self.assertEqual(body["sessionId"], self.sid)
        self.assertIs(self.ok("GET", "/wda/locked"), False, "times=1 by default")
        self.fake.inject("POST", "/elements", error="stale element reference")
        status, body, _ = self.call("POST", self.s("/elements"), {"using": "class name", "value": "x"})
        self.assertEqual(status, 404)
        self.assertIn("no longer attached", body["value"]["message"])
        self.fake.inject("GET", "/source", error="invalid element state", status=500)
        self.assertEqual(self.call("GET", self.s("/source"))[0], 500)

    def test_status_alone_and_value_override(self):
        self.fake.inject("GET", "/status", status=503)
        status, body, response = self.call("GET", "/status")
        self.assertEqual((status, response.reason, body["value"]), (503, "Status", None))
        self.fake.inject("POST", "/elements", value=None)
        self.assertIsNone(self.ok("POST", self.s("/elements"), {"using": "predicate string",
                                                                "value": "TRUEPREDICATE"}))
        self.fake.inject("GET", "/wda/activeAppInfo", value={"bundleId": "local.pid.5"})
        self.assertEqual(self.ok("GET", "/wda/activeAppInfo"), {"bundleId": "local.pid.5"})
        self.fake.inject("POST", "/wda/homescreen", value="done")
        self.assertEqual(self.ok("POST", "/wda/homescreen", {}), "done")
        self.assertEqual(self.fake.foreground, "com.apple.springboard", "a value override still runs the command")

    def test_raw_body(self):
        self.fake.inject("GET", "/source", raw=b"\x00garbage{")
        self.conn.request("GET", self.s("/source"))
        response = self.conn.getresponse()
        self.assertEqual((response.status, response.read()), (200, b"\x00garbage{"))
        self.assertEqual(response.getheader("Content-Length"), "9")
        self.assertIn("<?xml", self.ok("GET", self.s("/source")))

    def test_drop_without_execution(self):
        self.fake.inject("POST", "/wda/homescreen", drop=True)
        with self.assertRaises((http.client.HTTPException, ConnectionError)):
            self.call("POST", "/wda/homescreen", {})
        self.assertEqual(self.fake.foreground, "com.apple.Preferences")
        self.assertEqual(self.fake.routes()[-1], "POST /wda/homescreen")
        self.assertIsNone(self.ok("POST", "/wda/homescreen", {}, conn=self.connection()))

    def test_drop_after_execution(self):
        self.fake.inject("POST", "/element/:id/click", drop=True, execute=True)
        self.fake.set_foreground("com.apple.springboard")
        icon = self.find("label == 'Settings'")
        icon = [item for item in icon if self.nodes_for([item])[0].type.endswith("Icon")][0]
        with self.assertRaises((http.client.HTTPException, ConnectionError)):
            self.call("POST", self.s("/element/%s/click" % icon[ELEMENT_KEY]), {})
        self.assertEqual(self.fake.foreground, "com.apple.Preferences", "executed, but the answer was lost")

    def test_error_with_execute_runs_the_command(self):
        self.fake.inject("POST", "/wda/tap", error="unknown error", execute=True)
        self.call("POST", self.s("/wda/tap"), {"x": 1, "y": 2})
        self.assertEqual(self.fake.taps, [(1, 2)])
        self.fake.inject("POST", "/wda/tap", error="unknown error")
        self.call("POST", self.s("/wda/tap"), {"x": 3, "y": 4})
        self.assertEqual(self.fake.taps, [(1, 2)])

    def test_delay(self):
        self.fake.inject("GET", "/wda/locked", delay=0.2)
        started = time.monotonic()
        self.assertIs(self.ok("GET", "/wda/locked"), False)
        self.assertGreaterEqual(time.monotonic() - started, 0.19)

    def test_times_and_matching(self):
        self.fake.inject("GET", "/wda/locked", value=True, times=2)
        self.assertEqual([self.ok("GET", "/wda/locked") for _ in range(3)], [True, True, False])
        self.fake.inject("GET", "/wda/locked", value="always", times=None)
        self.assertEqual([self.ok("GET", self.s("/wda/locked")) for _ in range(3)], ["always"] * 3)
        self.fake.inject("POST", "/window/size", value="wrong method")
        self.assertEqual(self.ok("GET", "/window/size"), {"width": 390, "height": 844})
        self.fake.inject(None, None, value="anything")
        self.assertEqual(self.ok("GET", "/window/size"), "anything")

    def test_injection_returns_the_fake_for_chaining(self):
        self.assertIs(self.fake.inject("GET", "/status", status=500), self.fake)


class RequestLogTests(FakeCase):
    def test_request_fields(self):
        sid = self.session()
        item = self.ok("POST", self.s("/elements"), {"using": "predicate string", "value": "label == 'Done'"})[0]
        self.ok("GET", self.s("/source?format=xml&excluded_attributes=visible"))
        self.ok("POST", self.s("/element/%s/click" % item[ELEMENT_KEY]), {})
        create, find, source, click = self.fake.requests
        self.assertEqual(create, Request("POST", "/session", "/session", {}, CAPS, None))
        self.assertEqual((find.route, find.sid, find.body["using"]), ("/elements", sid, "predicate string"))
        self.assertEqual(source.path, "/session/%s/source" % sid)
        self.assertEqual(source.query, {"format": "xml", "excluded_attributes": "visible"})
        self.assertEqual(click.route, "/element/:id/click")
        self.assertEqual(click.path, "/session/%s/element/%s/click" % (sid, item[ELEMENT_KEY]))
        self.assertIsNone(source.body)

    def test_routes_actions_calls_and_clear(self):
        self.session()
        self.ok("GET", "/wda/locked")
        self.ok("POST", self.s("/appium/settings"), {"settings": {}})
        item = self.ok("POST", self.s("/element"), {"using": "predicate string", "value": "label == 'Wi-Fi'"})
        self.ok("POST", self.s("/element/%s/elements" % item[ELEMENT_KEY]), {"using": "class name",
                                                                            "value": "XCUIElementTypeCell"})
        self.ok("POST", self.s("/element/%s/click" % item[ELEMENT_KEY]), {})
        self.ok("POST", self.s("/wda/tap"), {"x": 1, "y": 1})
        self.ok("POST", self.s("/wda/keys"), {"value": ["a"]})
        self.ok("POST", "/wda/homescreen", {})
        self.assertEqual(self.fake.routes(), [
            "POST /session", "GET /wda/locked", "POST /appium/settings", "POST /element",
            "POST /element/:id/elements", "POST /element/:id/click", "POST /wda/tap", "POST /wda/keys",
            "POST /wda/homescreen"])
        actions = self.fake.actions()
        self.assertEqual([r.route for r in actions], ["/element/:id/click", "/wda/tap", "/wda/keys",
                                                      "/wda/homescreen"])
        self.assertEqual(actions, ["POST /element/:id/click", "POST /wda/tap", "POST /wda/keys",
                                   "POST /wda/homescreen"])
        self.assertEqual(["/wda/tap"], [r for r in actions if r == "/wda/tap"])
        self.assertEqual(str(actions[1]), "POST /wda/tap")
        self.assertNotEqual(actions[1], "GET /wda/tap")
        self.assertEqual(len(self.fake.calls(route="/wda/tap")), 1)
        self.assertEqual(len(self.fake.calls(method="post")), 8)
        self.assertEqual(len(self.fake.calls(route="/wda/locked", method="GET")), 1)
        self.fake.clear_log()
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.fake.actions(), [])

    def test_request_equality_with_tuples_still_works(self):
        a = Request("GET", "/x", "/x", {}, None, None)
        self.assertEqual(a, Request("GET", "/x", "/x", {}, None, None))
        self.assertNotEqual(a, Request("POST", "/x", "/x", {}, None, None))
        self.assertEqual(a, ("GET", "/x", "/x", {}, None, None))
        self.assertNotEqual(a, 5)
        self.assertIn(a, ["GET /x"])


# ---------------------------------------------------------------------------
# Device model helpers
# ---------------------------------------------------------------------------

class ModelTests(unittest.TestCase):
    def test_node_attribute_semantics(self):
        text = Node("StaticText", label="Hello")
        self.assertEqual((text.type, text.wd_value, text.wd_name, text.wd_label),
                         ("XCUIElementTypeStaticText", "Hello", "Hello", "Hello"))
        field = Node("TextField", placeholder="Email", name="email")
        self.assertEqual((field.wd_value, field.wd_name, field.wd_label), ("Email", "email", ""))
        field.value = "a"
        self.assertEqual(field.wd_value, "a")
        field.value = ""
        self.assertEqual(field.wd_value, "Email")
        button = Node("Button", label="", identifier="")
        self.assertEqual((button.wd_value, button.wd_name, button.wd_label), (None, None, None))
        self.assertEqual(Node("Switch", label="Wi-Fi", value="1").wd_value, "1")
        self.assertEqual(Node("Cell", identifier="cell.id", label="Row").wd_name, "cell.id")
        alias = Node("Cell", name="a")
        alias.identifier = "b"
        self.assertEqual(alias.name, "b")

    def test_ids_are_unique_and_safe(self):
        ids = [Node("Other").id for _ in range(50)]
        self.assertEqual(len(set(ids)), 50)
        self.assertTrue(all(ID_RE.match(i) for i in ids))

    def test_walk_find_and_add(self):
        root = Node("Application").add(Node("Window").add(Node("Button", label="A"), Node("Button", label="B")),
                                       Node("Other", label="C"))
        self.assertEqual([n.label for n in root.walk()], [None, None, "A", "B", "C"])
        self.assertEqual(root.find(label="B").label, "B")
        self.assertEqual(root.find(type="XCUIElementTypeOther").label, "C")
        self.assertEqual(root.find(type="Button").label, "A")
        self.assertIsNone(root.find(label="Z"))

    def test_default_accessibility_and_traits(self):
        self.assertTrue(Node("Button", label="x").is_accessible)
        self.assertEqual(Node("Button", label="x").trait_text, "Button")
        self.assertEqual(Node("Button", label="x", enabled=False).trait_text, "Button, NotEnabled")
        self.assertFalse(Node("Other").is_accessible)
        self.assertEqual(Node("Other").trait_text, "")
        self.assertFalse(Node("Cell", children=[Node("Image")]).is_accessible)

    def test_factories(self):
        settings = settings_app()
        self.assertEqual((settings.bundle_id, settings.pid), ("com.apple.Preferences", 412))
        self.assertEqual(len(list(settings.root.walk())), 16)
        board = springboard_app()
        self.assertEqual(board.bundle_id, "com.apple.springboard")
        self.assertEqual(board.root.label, "SpringBoard")
        self.assertEqual([n.label for n in board.root.walk() if n.type.endswith("Icon")],
                         ["Settings", "Notes", "Messages"])
        form = form_app()
        self.assertEqual(form.bundle_id, "com.example.form")
        kinds = [(n.type[len("XCUIElementType"):], n.wd_name) for n in form.root.walk() if n.wd_name]
        self.assertEqual(kinds[1:], [("TextField", "email"), ("SecureTextField", "password"),
                                     ("TextView", "message"), ("Button", "Send"), ("Button", "Cancel")])
        self.assertEqual(form.root.find(name="password").placeholder, "Password")

    def test_list_app_pages(self):
        app, roots = list_app(pages=3, rows=8)
        self.assertEqual(app.bundle_id, "com.example.list")
        self.assertIs(app.root, roots[0])
        self.assertEqual(app.pages, roots)
        for page, root in enumerate(roots):
            labels = [n.label for n in root.walk() if n.type.endswith("Cell")]
            self.assertEqual(labels, ["Row %d" % (page * 8 + i + 1) for i in range(8)])
            self.assertEqual(root.find(label="End of list") is not None, page == 2)

    def test_scenario_helpers(self):
        fake = FakeWDA()
        self.assertEqual(list(fake.apps), ["com.apple.Preferences", "com.apple.springboard", "com.example.form"])
        self.assertEqual(fake.foreground, "com.apple.Preferences")
        self.assertIsNone(fake.mjpeg_port)
        with self.assertRaises(KeyError):
            fake.set_foreground("com.missing")
        with self.assertRaises(KeyError):
            fake.app("com.missing")
        fake.set_foreground("com.example.form")
        self.assertEqual(fake.node(name="email").placeholder, "Email")
        self.assertIsNone(fake.focused_node())
        fake.node(name="email").focused = True
        self.assertEqual(fake.focused_node().name, "email")
        app, roots = list_app(pages=2)
        fake.set_pages("com.example.form", roots)
        self.assertIs(fake.app("com.example.form").root, roots[0])
        replacement = Node("Application", label="New")
        fake.set_tree("com.example.form", replacement)
        self.assertIsNone(fake.app("com.example.form").pages)
        fake.set_tree("com.example.new", Node("Application"))
        self.assertIn("com.example.new", fake.apps)
        only = FakeWDA(apps=[form_app()], foreground="com.example.form")
        self.assertEqual(list(only.apps), ["com.example.form"])

    def test_fake_does_not_use_the_plugin_predicate_builder(self):
        with open(fake_wda.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), feature_version=(3, 9))
        modules = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                modules.add(node.module)
        self.assertNotIn("wda_tree", modules)
        self.assertNotIn("wda_controller", modules)


# ---------------------------------------------------------------------------
# MJPEG
# ---------------------------------------------------------------------------

class MjpegCase(unittest.TestCase):
    def start(self, mode="normal", fps=50, frames=None):
        fake = FakeWDA(mjpeg=True, mjpeg_fps=fps, mjpeg_mode=mode)
        if frames is not None:
            fake.mjpeg_frames = frames
        fake.start()
        self.addCleanup(fake.stop)
        return fake

    def client(self, fake, request=MJPEG_REQUEST):
        sock = socket.create_connection(("127.0.0.1", fake.mjpeg_port), timeout=2)
        self.addCleanup(sock.close)
        if request:
            sock.sendall(request)
        return sock

    def read(self, sock, count, timeout=2.0):
        data = b""
        deadline = time.monotonic() + timeout
        while len(data) < count and time.monotonic() < deadline:
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                chunk = sock.recv(min(65536, count - len(data)))
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
        return data

    def read_to_eof(self, sock, timeout=2.0):
        return self.read(sock, 1 << 30, timeout)

    def assert_silent(self, sock, seconds=0.25):
        readable, _, _ = select.select([sock], [], [], seconds)
        if readable:
            self.assertEqual(sock.recv(65536), b"", "expected no bytes")
            self.fail("connection closed unexpectedly")


class MjpegTests(MjpegCase):
    def test_nothing_is_sent_before_the_client_speaks(self):
        fake = self.start()
        sock = self.client(fake, request=None)
        self.assert_silent(sock, 0.15)
        sock.sendall(b"x")
        self.assertEqual(self.read(sock, len(EXPECTED_MJPEG_HEADER)), EXPECTED_MJPEG_HEADER)
        self.assertEqual(fake.mjpeg_requests, [b"x"])

    def test_exact_header_and_frames(self):
        fake = self.start()
        sock = self.client(fake)
        expected = EXPECTED_MJPEG_HEADER + expected_part(TINY_JPEG) * 3
        self.assertEqual(self.read(sock, len(expected)), expected)
        self.assertEqual(fake.mjpeg_requests, [MJPEG_REQUEST])
        self.assertEqual(fake.mjpeg_clients(), 1)

    def test_frames_cycle_and_client_count_drops_on_close(self):
        other = solid_png(1, 1)
        fake = self.start(frames=[TINY_JPEG, other])
        sock = self.client(fake)
        expected = EXPECTED_MJPEG_HEADER + expected_part(TINY_JPEG) + expected_part(other) + expected_part(TINY_JPEG)
        self.assertEqual(self.read(sock, len(expected)), expected)
        sock.close()
        deadline = time.monotonic() + 1.0
        while fake.mjpeg_clients() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(fake.mjpeg_clients(), 0)

    def test_chunked_mode(self):
        fake = self.start("chunked")
        sock = self.client(fake)
        head = self.read(sock, len(EXPECTED_CHUNKED_HEADER))
        self.assertEqual(head, EXPECTED_CHUNKED_HEADER)
        body = self.read(sock, 3 * len(expected_part(TINY_JPEG)) * 3)
        payload, sizes, terminated = dechunk(body)
        self.assertTrue(payload.startswith(expected_part(TINY_JPEG) * 2))
        self.assertTrue(sizes and max(sizes) <= 7)
        self.assertFalse(terminated)
        fake.stop()
        payload, sizes, terminated = dechunk(body + self.read_to_eof(sock))
        self.assertTrue(terminated, "0\\r\\n\\r\\n is written on stop()")

    def test_split_mode_bytes_match_the_normal_format(self):
        fake = self.start("split")
        sock = self.client(fake)
        expected = EXPECTED_MJPEG_HEADER + expected_part(TINY_JPEG) * 2
        self.assertEqual(self.read(sock, len(expected)), expected)

    def test_garbage_mode(self):
        fake = self.start("garbage")
        sock = self.client(fake)
        data = self.read(sock, len(EXPECTED_MJPEG_HEADER) + 200 + 2 * len(expected_part(TINY_JPEG)))
        self.assertTrue(data.startswith(EXPECTED_MJPEG_HEADER))
        junk, boundary, rest = data[len(EXPECTED_MJPEG_HEADER):].partition(b"--BoundaryString\r\n")
        self.assertTrue(junk)
        self.assertNotIn(b"\xff\xd8", junk)
        self.assertNotIn(b"\r\n\r\n", junk)
        self.assertTrue((boundary + rest).startswith(expected_part(TINY_JPEG)))

    def test_close_after(self):
        fake = self.start("close_after:2")
        sock = self.client(fake)
        self.assertEqual(self.read_to_eof(sock), EXPECTED_MJPEG_HEADER + expected_part(TINY_JPEG) * 2)

    def test_stall_after_keeps_the_socket_open(self):
        fake = self.start("stall_after:1")
        sock = self.client(fake)
        expected = EXPECTED_MJPEG_HEADER + expected_part(TINY_JPEG)
        self.assertEqual(self.read(sock, len(expected)), expected)
        self.assert_silent(sock, 0.25)
        self.assertEqual(fake.mjpeg_clients(), 1)

    def test_silent_mode_never_answers(self):
        fake = self.start("silent")
        sock = self.client(fake)
        self.assert_silent(sock, 0.25)
        self.assertEqual(fake.mjpeg_requests, [MJPEG_REQUEST])

    def test_close_after_zero_sends_only_the_header(self):
        fake = self.start("close_after:0")
        sock = self.client(fake)
        self.assertEqual(self.read_to_eof(sock), EXPECTED_MJPEG_HEADER)

    def test_unknown_modes_are_rejected(self):
        with self.assertRaises(ValueError):
            FakeWDA(mjpeg=True, mjpeg_mode="bogus")
        with self.assertRaises(ValueError):
            FakeWDA(mjpeg=True, mjpeg_mode="close_after:x")
        fake = self.start()
        fake.mjpeg_mode = "changed-later"
        sock = self.client(fake)
        self.assertEqual(self.read_to_eof(sock), b"", "a bad mode set later closes the stream without data")

    def test_command_port_is_separate(self):
        fake = self.start()
        self.assertNotEqual(fake.port, fake.mjpeg_port)
        conn = http.client.HTTPConnection("127.0.0.1", fake.port, timeout=5)
        self.addCleanup(conn.close)
        conn.request("GET", "/status")
        self.assertEqual(conn.getresponse().status, 200)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

class LifecycleTests(unittest.TestCase):
    def test_stop_closes_ports_and_joins_threads(self):
        baseline = threading.active_count()
        fake = FakeWDA(mjpeg=True, mjpeg_fps=50).start()
        port, mjpeg_port = fake.port, fake.mjpeg_port
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/status")
        conn.getresponse().read()
        stream = socket.create_connection(("127.0.0.1", mjpeg_port), timeout=2)
        stream.sendall(MJPEG_REQUEST)
        stream.recv(10)
        started = time.monotonic()
        fake.stop()
        self.assertLess(time.monotonic() - started, 2.5)
        conn.close()
        stream.close()
        for closed_port in (port, mjpeg_port):
            with self.assertRaises(ConnectionRefusedError):
                socket.create_connection(("127.0.0.1", closed_port), timeout=1).close()
        deadline = time.monotonic() + 1.0
        while threading.active_count() > baseline and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertLessEqual(threading.active_count(), baseline)

    def test_stop_interrupts_a_delayed_request(self):
        fake = FakeWDA().start()
        fake.inject("GET", "/wda/locked", delay=10)
        errors = []

        def request():
            conn = http.client.HTTPConnection("127.0.0.1", fake.port, timeout=5)
            try:
                conn.request("GET", "/wda/locked")
                conn.getresponse().read()
            except (http.client.HTTPException, OSError) as exc:
                errors.append(exc)
            finally:
                conn.close()

        worker = threading.Thread(target=request)
        worker.start()
        time.sleep(0.1)
        started = time.monotonic()
        fake.stop()
        worker.join(3)
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)

    def test_context_manager_and_idempotent_start(self):
        with FakeWDA() as fake:
            self.assertIs(fake.start(), fake)
            self.assertTrue(fake.url.startswith("http://127.0.0.1:"))
            self.assertEqual(fake.url, "http://127.0.0.1:%d" % fake.port)
        fake.stop()  # a second stop is harmless


if __name__ == "__main__":
    unittest.main()
