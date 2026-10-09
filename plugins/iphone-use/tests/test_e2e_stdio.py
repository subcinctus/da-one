import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# End to end: the MCP server as Claude Code runs it, over stdio, against a fake iPhone.
#
# `server/iphone_use.py` runs as a child process with a private state dir, a configured
# iPhone (config.json with a UDID) and USBMUXD_SOCKET_ADDRESS pointing at FakeUsbmuxd, which
# tunnels device ports 8100 (commands) and 9100 (MJPEG) to a FakeWDA. The test speaks
# newline-delimited JSON-RPC exactly like an MCP client and checks every line the server
# writes, the phone actions the fake recorded, the live preview it serves and a clean exit
# on stdin EOF.

import base64  # noqa: E402
import uuid  # noqa: E402
import http.client  # noqa: E402
import json  # noqa: E402
import queue  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from urllib.parse import urlsplit  # noqa: E402

import mcp_schemas  # noqa: E402
import privstate  # noqa: E402
import wda_setup  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import TINY_JPEG, FakeWDA  # noqa: E402
from test_runtime import RuntimeHarness  # noqa: E402
from version import VERSION  # noqa: E402

SERVER_SCRIPT = os.path.join(SERVER, "iphone_use.py")
UDID = "00008110-0000000000000001"
READ_TIMEOUT = 15.0
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
TOOL_ENTRY_LIMIT = 5500
TOOLS_LIST_LIMIT = 36000
TEXT_LIMIT = 48000

# The JSON Schema vocabulary the published schemas may use, and the JSON types.
SCHEMA_KEYWORDS = {"type", "properties", "required", "additionalProperties", "minProperties", "enum", "const",
                   "minimum", "maximum", "minLength", "maxLength", "items", "minItems", "maxItems", "oneOf",
                   "default", "description", "examples", "title", "$ref", "$defs"}
JSON_TYPES = {"object", "array", "string", "boolean", "number", "integer", "null"}


def rpc(ident, method, params=None):
    message = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        message["params"] = params
    return message


def tool_call(ident, name, arguments=None):
    params = {"name": name}
    if arguments is not None:
        params["arguments"] = arguments
    return rpc(ident, "tools/call", params)


class StdioServer:
    """server/iphone_use.py as a child process; every stdout line is kept for inspection."""

    def __init__(self, env, cwd):
        self.process = subprocess.Popen([sys.executable, SERVER_SCRIPT], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd)
        self.raw_lines = []
        self.lines = queue.Queue()
        self.stderr_chunks = []
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()
        self.err_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self.err_reader.start()

    def _read_stdout(self):
        try:
            for line in iter(self.process.stdout.readline, b""):
                self.raw_lines.append(line)
                self.lines.put(line)
        except (OSError, ValueError):
            pass
        self.lines.put(None)

    def _read_stderr(self):
        try:
            for chunk in iter(lambda: self.process.stderr.read(4096), b""):
                self.stderr_chunks.append(chunk)
        except (OSError, ValueError):
            pass

    def send(self, *messages):
        for message in messages:
            data = message if isinstance(message, bytes) else json.dumps(message).encode("utf-8")
            self.process.stdin.write(data + b"\n")
        self.process.stdin.flush()

    def read(self, timeout=READ_TIMEOUT):
        line = self.lines.get(timeout=timeout)
        if line is None:
            raise AssertionError("the server closed its output; stderr: %r" % self.stderr())
        return json.loads(line.decode("utf-8"))

    def quiet(self, timeout=0.3):
        """True when nothing more arrives within timeout (used after notifications)."""
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            return True
        self.lines.put(line)
        return False

    def stderr(self):
        return b"".join(self.stderr_chunks).decode("utf-8", "replace")

    def close_stdin_and_wait(self, timeout=20):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        code = self.process.wait(timeout)
        self.reader.join(5)
        self.err_reader.join(5)
        return code

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass


def check_schema(test, schema, root, path):
    """A structural JSON Schema check of one (sub)schema of a published inputSchema."""
    test.assertIsInstance(schema, dict, path)
    unknown = set(schema) - SCHEMA_KEYWORDS
    test.assertEqual(unknown, set(), "%s uses unsupported keywords" % path)
    if "$ref" in schema:
        ref = schema["$ref"]
        test.assertTrue(ref.startswith("#/$defs/"), path)
        test.assertIn(ref[len("#/$defs/"):], root.get("$defs", {}), "%s: dangling $ref %s" % (path, ref))
    if "type" in schema:
        test.assertIn(schema["type"], JSON_TYPES, path)
    for key in ("minimum", "maximum"):
        if key in schema:
            test.assertIsInstance(schema[key], (int, float), path)
            test.assertNotIsInstance(schema[key], bool, path)
    if "minimum" in schema and "maximum" in schema:
        test.assertLessEqual(schema["minimum"], schema["maximum"], path)
    for key in ("minLength", "maxLength", "minItems", "maxItems", "minProperties"):
        if key in schema:
            test.assertIsInstance(schema[key], int, path)
            test.assertGreaterEqual(schema[key], 0, path)
    if "minLength" in schema and "maxLength" in schema:
        test.assertLessEqual(schema["minLength"], schema["maxLength"], path)
    if "enum" in schema:
        test.assertIsInstance(schema["enum"], list, path)
        test.assertTrue(schema["enum"], path)
        test.assertEqual(len(schema["enum"]), len({json.dumps(item) for item in schema["enum"]}), path)
    if "description" in schema:
        test.assertIsInstance(schema["description"], str, path)
    if "properties" in schema:
        test.assertIsInstance(schema["properties"], dict, path)
        for name, sub in schema["properties"].items():
            check_schema(test, sub, root, "%s.properties.%s" % (path, name))
    if "required" in schema:
        test.assertIsInstance(schema["required"], list, path)
        test.assertEqual(len(schema["required"]), len(set(schema["required"])), path)
        for name in schema["required"]:
            test.assertIn(name, schema.get("properties", {}), "%s: required %s is not a property" % (path, name))
    if "additionalProperties" in schema:
        test.assertIs(schema["additionalProperties"], False, path)
    if "items" in schema:
        check_schema(test, schema["items"], root, path + ".items")
    if "oneOf" in schema:
        test.assertIsInstance(schema["oneOf"], list, path)
        test.assertTrue(schema["oneOf"], path)
        for index, sub in enumerate(schema["oneOf"]):
            check_schema(test, sub, root, "%s.oneOf[%d]" % (path, index))
    if "$defs" in schema:
        test.assertIs(schema, root, "%s: $defs only at the root" % path)
        for name, sub in schema["$defs"].items():
            check_schema(test, sub, root, "%s.$defs.%s" % (path, name))


class EndToEndStdioTests(unittest.TestCase):
    """One full MCP conversation over stdio with a USB-configured (fake) iPhone."""

    def setUp(self):
        self.fake = FakeWDA(mjpeg=True, mjpeg_fps=20).start()
        self.addCleanup(self.fake.stop)
        self.mux = FakeUsbmuxd().start()
        self.addCleanup(self.mux.stop)
        self.mux.add_device(UDID, ports={8100: ("127.0.0.1", self.fake.port),
                                         9100: ("127.0.0.1", self.fake.mjpeg_port)})
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)
        for name in ("bin", "home"):
            os.mkdir(os.path.join(self.root, name))
        self.state_dir = os.path.join(self.root, "state")
        os.mkdir(self.state_dir, 0o700)
        privstate.write_json_private(os.path.join(self.state_dir, "config.json"), {
            "format": 1, "udid": UDID, "team_id": "ABCDE12345", "bundle_id": "com.iphoneuse.e2etest01.wda",
            "device_port": 8100, "mjpeg_port": 9100, "app_store_country": "in", "wda_url": None,
            "updated_at": "2026-10-09T00:00:00+00:00"})
        # A cached preview-header model, so the background device lookup never runs Xcode tools.
        privstate.write_json_private(os.path.join(self.state_dir, "device.json"),
                                     {"udid": UDID, "model": "iPhone 16 Pro"})
        # Only an empty bin directory on PATH: nothing macOS-specific can run, even on a Mac runner.
        self.env = {"PATH": os.path.join(self.root, "bin"), "HOME": os.path.join(self.root, "home"),
                    "PYTHONDONTWRITEBYTECODE": "1", "IPHONE_USE_STATE_DIR": self.state_dir,
                    "IPHONE_USE_PREVIEW_PORT": "0", "IPHONE_USE_NO_BROWSER": "1",
                    "IPHONE_USE_SETTLE_SECONDS": "0"}
        self.env.update(self.mux.env())
        self.server = None
        self.next_id = 100

    def start_server(self):
        self.server = StdioServer(self.env, self.root)
        self.addCleanup(self.server.kill)
        return self.server

    # --- helpers ---------------------------------------------------------------------------------------

    def call(self, name, arguments=None):
        """tools/call -> (MCP result, parsed envelope)."""
        self.next_id += 1
        ident = self.next_id
        self.server.send(tool_call(ident, name, arguments))
        reply = self.server.read()
        self.assertEqual(reply.get("jsonrpc"), "2.0", reply)
        self.assertEqual(reply.get("id"), ident, reply)
        self.assertNotIn("error", reply, reply)
        result = reply["result"]
        self.assertEqual(set(result), {"content", "isError"}, result)
        self.assertGreaterEqual(len(result["content"]), 1)
        self.assertLessEqual(len(result["content"]), 2)
        text_block = result["content"][0]
        self.assertEqual(text_block["type"], "text")
        self.assertLessEqual(len(text_block["text"]), TEXT_LIMIT)
        envelope = json.loads(text_block["text"])
        self.assertEqual(text_block["text"], json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))
        self.assertIn(envelope.get("ok"), (True, False), envelope)
        has_image = len(result["content"]) == 2
        self.assertIs(result["isError"], envelope["ok"] is False and not has_image, envelope)
        return result, envelope

    def ok(self, name, arguments=None):
        result, envelope = self.call(name, arguments)
        self.assertIs(envelope["ok"], True, envelope)
        self.assertIs(result["isError"], False)
        return result, envelope

    def assert_image_block(self, result, envelope_image):
        self.assertEqual(len(result["content"]), 2, result)
        block = result["content"][1]
        self.assertEqual(set(block), {"type", "data", "mimeType"})
        self.assertEqual(block["type"], "image")
        self.assertIn(block["mimeType"], ("image/png", "image/jpeg"))
        data = base64.b64decode(block["data"], validate=True)
        if block["mimeType"] == "image/png":
            self.assertTrue(data.startswith(PNG_SIGNATURE))
        else:
            self.assertTrue(data.startswith(b"\xff\xd8"))
        self.assertEqual(block["mimeType"], envelope_image["mimeType"])
        self.assertTrue(envelope_image["path"].startswith(os.path.realpath(self.state_dir)))
        self.assertNotIn(block["data"][:64], result["content"][0]["text"])  # no base64 in the JSON text
        self.assertEqual(len(envelope_image["pixel_to_point"]), 2)

    def preview_json(self, parts, path):
        """GET a JSON route of the live preview page (Host header 127.0.0.1:<port>)."""
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        try:
            connection.request("GET", parts.path + path)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            return json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def wait_for(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return predicate()

    # --- the conversation ------------------------------------------------------------------------------

    def test_full_mcp_conversation_over_stdio(self):
        server = self.start_server()

        # Claude Code's newer client probes server/discover first and falls back on any error.
        server.send(rpc(0, "server/discover", {}))
        self.assertEqual(server.read(), {"jsonrpc": "2.0", "id": 0,
                                         "error": {"code": -32601, "message": "Method not found"}})

        # initialize: a supported protocol version is echoed back.
        server.send(rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "claude-code", "version": "2.1.295"}}))
        initialized = server.read()
        self.assertEqual(initialized["id"], 1)
        info = initialized["result"]
        self.assertEqual(info["protocolVersion"], "2025-06-18")
        self.assertEqual(info["capabilities"], {"tools": {"listChanged": False}})
        self.assertEqual(info["serverInfo"], {"name": "iphone-use", "title": "iPhone Use", "version": VERSION})
        self.assertEqual(info["instructions"], mcp_schemas.INSTRUCTIONS)
        self.assertLessEqual(len(info["instructions"]), 2048)

        # notifications are never answered.
        server.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertTrue(server.quiet())

        # tools/list: 17 tools, closed JSON Schema objects, within the size budgets.
        server.send(rpc(2, "tools/list"))
        listing = server.read()
        tools = listing["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], list(mcp_schemas.TOOL_NAMES))
        self.assertEqual(len(tools), 17)
        self.assertLess(len(json.dumps(listing["result"], separators=(",", ":"))), TOOLS_LIST_LIMIT)
        for tool in tools:
            with self.subTest(tool=tool["name"]):
                self.assertTrue(tool["name"].startswith("iphone_"))
                self.assertLessEqual(set(tool), {"name", "title", "description", "inputSchema", "annotations",
                                                 "_meta"})
                self.assertLessEqual(len(tool["description"]), 1000)
                self.assertLess(len(json.dumps(tool["inputSchema"], separators=(",", ":"))), TOOL_ENTRY_LIMIT)
                schema = tool["inputSchema"]
                self.assertEqual(schema["type"], "object")
                self.assertIs(schema["additionalProperties"], False)
                self.assertNotIn("oneOf", schema)
                check_schema(self, schema, schema, tool["name"])
                self.assertEqual(set(tool["annotations"]), {"title", "readOnlyHint", "destructiveHint",
                                                            "idempotentHint", "openWorldHint"})
                self.assertNotIn("outputSchema", tool)
        meta = {tool["name"]: tool.get("_meta") for tool in tools}
        self.assertEqual(meta["iphone_ready"], {"anthropic/alwaysLoad": True})
        self.assertEqual([name for name, value in meta.items() if value], ["iphone_ready"])

        # ping is answered at once.
        server.send(rpc("ping-1", "ping"))
        self.assertEqual(server.read(), {"jsonrpc": "2.0", "id": "ping-1", "result": {}})

        # iphone_ready over usbmux: session, unlocked, tree read, preview URL (no screenshot by default).
        result, ready = self.ok("iphone_ready", {"recover": True})
        self.assertIs(ready["ready"], True, ready)
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["proof"]["wda_version"], "16.14.0")
        self.assertIs(ready["proof"]["session_usable"], True)
        self.assertIs(ready["proof"]["screenshot_readable"], False)
        self.assertEqual(len(result["content"]), 1)
        self.assertEqual(ready["observation"]["app"], "com.apple.Preferences")
        self.assertTrue(any(node.get("label") == "Wi-Fi" for node in ready["observation"]["nodes"]))
        preview_url = ready["preview"]["url"]
        self.assertRegex(preview_url, r"^http://127\.0\.0\.1:\d+/[0-9a-f]{32}/$")
        self.assertIs(ready["preview"]["paused"], False)
        parts = urlsplit(preview_url)
        health = self.preview_json(parts, "api/health")
        self.assertEqual(health, {"ok": True, "name": "iphone-use", "version": VERSION, "viewers": 0})
        self.assertEqual(self.mux.connects[0][:2], (UDID, 8100))
        self.assertEqual(len(self.fake.calls("/session", "POST")), 1)

        # iphone_observe tree, then screenshot (an image block with base64 data and its mimeType).
        result, tree = self.ok("iphone_observe", {"mode": "tree", "max_nodes": 50})
        self.assertEqual(len(result["content"]), 1)
        self.assertEqual(tree["viewport"], {"width": 390, "height": 844, "units": "iPhone points"})
        self.assertGreater(tree["total_nodes"], 5)
        self.assertNotIn("image", tree)
        result, shot = self.ok("iphone_observe", {"mode": "screenshot"})
        self.assertNotIn("nodes", shot)
        self.assert_image_block(result, shot["image"])
        result, both = self.ok("iphone_observe", {"mode": "both"})
        self.assertIn("nodes", both)
        self.assert_image_block(result, both["image"])
        observation_id = both["observation_id"]

        # iphone_find: matches with tap points, no screenshot.
        result, found = self.ok("iphone_find", {"selector": {"label": "Wi-Fi"}})
        self.assertEqual(found["matches"], 1)
        self.assertEqual(found["elements"][0]["tap"], [195, 369])
        self.assertEqual(len(result["content"]), 1)

        # iphone_tap by selector: one element click, after the lock check.
        self.fake.clear_log()
        _, tapped = self.ok("iphone_tap", {"selector": {"label": "Wi-Fi", "type": "Cell"}})
        self.assertIs(tapped["action_executed"], True)
        self.assertIs(tapped["action_complete"], True)
        self.assertEqual(self.fake.routes()[0], "GET /wda/locked")
        self.assertEqual(self.fake.actions(), ["POST /element/:id/click"])

        # iphone_tap by x/y with the earlier observation id.
        self.fake.clear_log()
        _, tapped = self.ok("iphone_tap", {"x": 200, "y": 300, "observation_id": observation_id})
        self.assertIs(tapped["action_executed"], True)
        self.assertEqual(self.fake.actions(), ["POST /wda/tap"])
        self.assertEqual(self.fake.taps[-1], (200, 300))
        # The controller's tap telemetry reaches the shared preview state (never the phone).
        state = self.preview_json(parts, "api/state?last_event_id=0")
        taps = [event for event in state["events"] if event["kind"] == "tap"]
        self.assertEqual(taps[-1]["point"], {"x": 200, "y": 300})
        self.assertEqual(state["viewport"], {"width": 390, "height": 844})
        # The preview header model comes from a background lookup (here: the cached device.json).
        self.assertTrue(self.wait_for(lambda: self.preview_json(parts, "api/state")["device"] == {
            "model": "iPhone 16 Pro"}))
        self.assertIs(state["paused"], False)
        self.assertNotIn("pause_id", state)

        # A selector that matches nothing: ok=false with a screenshot attached, so isError is false.
        self.fake.clear_log()
        result, missing = self.call("iphone_tap", {"selector": {"label": "No such row"}})
        self.assertIs(missing["ok"], False)
        self.assertIs(result["isError"], False)
        self.assertEqual(missing["error"]["code"], "no_such_element")
        self.assertIs(missing["error"]["action_executed"], False)
        self.assertEqual(missing["error"]["recovery"]["next_tool"], "iphone_tap")
        self.assert_image_block(result, missing["error"]["observation"]["image"])
        self.assertEqual(self.fake.actions(), [])

        # iphone_launch_app (verified), then iphone_type_text into the email field (exact readback).
        _, launched = self.ok("iphone_launch_app", {"bundle_id": "com.example.form", "verify": True})
        self.assertIs(launched["foreground_verified"], True)
        self.assertEqual(self.fake.foreground, "com.example.form")
        _, typed = self.ok("iphone_type_text", {"selector": {"name": "email"}, "text": "pat@example.com",
                                                "verify": True})
        self.assertIs(typed["input_complete"], True)
        self.assertIs(typed["exact_readback"], True)
        self.assertIs(typed["submitted"], False)
        self.assertEqual(typed["characters"], len("pat@example.com"))
        self.assertEqual(self.fake.node(name="email").value, "pat@example.com")

        # A password field is refused before anything is sent, without a screenshot, and pauses the preview.
        self.fake.clear_log()
        result, refused = self.call("iphone_type_text", {"selector": {"name": "password"}, "text": "secret"})
        self.assertEqual(refused["error"]["code"], "not_editable")
        self.assertIs(refused["error"]["secure_field"], True)
        self.assertIs(result["isError"], True)
        self.assertEqual(len(result["content"]), 1)
        self.assertEqual(self.fake.actions(), [])
        self.assertNotIn("secret", "".join(self.fake.typed))
        _, status = self.ok("iphone_screen", {"action": "status"})
        self.assertIs(status["paused"], True)
        self.assertEqual(status["pause_reason"], "authentication")
        _, resumed = self.ok("iphone_screen", {"action": "resume"})
        self.assertIs(resumed["paused"], False)

        # iphone_swipe: one gesture by default.
        self.fake.clear_log()
        _, swiped = self.ok("iphone_swipe", {"direction": "up"})
        self.assertEqual(swiped["strategy"], "short_drag")
        self.assertEqual(self.fake.actions(), ["POST /wda/dragfromtoforduration"])

        # iphone_press_button home (verified): the Home Screen is in front.
        _, home = self.ok("iphone_press_button", {"name": "home", "verify": True})
        self.assertIs(home["foreground_verified"], True)
        self.assertEqual(home["foreground_app"], "com.apple.springboard")

        # iphone_batch: launch, tap and read the resulting page in one call.
        self.fake.clear_log()
        _, batch = self.ok("iphone_batch", {"steps": [
            {"op": "launch_app", "args": {"bundle_id": "com.apple.Preferences"}},
            {"op": "tap", "args": {"selector": {"label": "Done"}}},
            {"op": "observe", "args": {"mode": "tree", "max_nodes": 20}}]})
        self.assertIs(batch["complete"], True)
        self.assertEqual(batch["completed_steps"], 3)
        self.assertIsNone(batch["stop_reason"])
        self.assertEqual(batch["results"][2]["app"], "com.apple.Preferences")
        self.assertEqual(self.fake.actions(), ["POST /wda/apps/activate", "POST /element/:id/click"])

        # A batch whose later step is invalid runs nothing at all.
        self.fake.clear_log()
        result, bad_batch = self.call("iphone_batch", {"steps": [
            {"op": "press_button", "args": {"name": "home"}},
            {"op": "launch_app", "args": {"bundle_id": "not a bundle"}}]})
        self.assertIs(result["isError"], True)
        self.assertEqual(bad_batch["error"]["code"], "invalid_argument")
        self.assertEqual(self.fake.requests, [])

        # Invalid arguments: structured errors with isError true and zero device calls.
        result, invalid = self.call("iphone_tap", {"x": 10})
        self.assertIs(result["isError"], True)
        self.assertEqual(invalid["error"]["code"], "invalid_argument")
        self.assertIs(invalid["error"]["action_executed"], False)
        self.assertIs(invalid["error"]["uncertain"], False)
        result, unknown = self.call("iphone_observe", {"mode": "tree", "colour": "red"})
        self.assertIs(result["isError"], True)
        self.assertEqual(unknown["error"]["unknown_fields"], ["colour"])
        self.assertEqual(unknown["error"]["argument_path"], "arguments")
        result, nope = self.call("iphone_nope", {})
        self.assertEqual(nope["error"]["code"], "unknown_tool")
        self.assertEqual(self.fake.requests, [])

        # The live preview relays the iPhone's MJPEG stream (device port 9100 over usbmux) to the page.
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        try:
            connection.request("GET", parts.path + "stream.mjpeg")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(response.getheader("Content-Type").startswith("multipart/x-mixed-replace"))
            self.assertIn("default-src 'none'", response.getheader("Content-Security-Policy"))
            received = b""
            deadline = time.monotonic() + 5
            while TINY_JPEG not in received and time.monotonic() < deadline:
                chunk = response.read1(65536) if hasattr(response, "read1") else response.read(1024)
                if not chunk:
                    break
                received += chunk
            self.assertIn(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(TINY_JPEG),
                          received)
            self.assertIn(TINY_JPEG, received)
        finally:
            connection.close()
        self.assertTrue(any(connect[:2] == (UDID, 9100) for connect in self.mux.connects))

        # The preview toolbar's Home button (the user's click) goes through the same process.
        self.fake.clear_log()
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=10)
        try:
            body = json.dumps({"action": "home"})
            connection.request("POST", parts.path + "api/action", body=body,
                               headers={"Content-Type": "application/json",
                                        "Origin": "http://127.0.0.1:%d" % parts.port})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read().decode("utf-8")), {"ok": True, "action": "home"})
        finally:
            connection.close()
        self.assertEqual(self.fake.actions(), ["POST /wda/homescreen"])
        self.assertEqual(self.fake.foreground, "com.apple.springboard")

        # A cross-site POST is refused and never reaches the phone.
        self.fake.clear_log()
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        try:
            connection.request("POST", parts.path + "api/action", body=json.dumps({"action": "home"}),
                               headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
            self.assertEqual(connection.getresponse().status, 403)
        finally:
            connection.close()
        self.assertEqual(self.fake.requests, [])

        # iphone_screen open (no browser here) and iphone_metrics (sizes and timings only).
        _, opened = self.ok("iphone_screen", {"action": "open"})
        self.assertEqual(opened["url"], preview_url)
        self.assertIs(opened["opened"], False)
        _, metrics = self.ok("iphone_metrics")
        self.assertGreater(metrics["http"]["requests"], 10)
        self.assertGreater(metrics["tools"]["count"], 10)
        self.assertGreater(metrics["responses"]["image_bytes"], 0)
        self.assertNotIn("pat@example.com", json.dumps(metrics))

        # ping still works after all of that.
        server.send(rpc(999, "ping"))
        self.assertEqual(server.read(), {"jsonrpc": "2.0", "id": 999, "result": {}})

        # stdin EOF: a clean exit, empty stderr, preview record removed, session saved privately.
        self.assertEqual(server.close_stdin_and_wait(), 0)
        self.assertEqual(server.stderr(), "")
        self.assertIsNone(server.lines.get(timeout=5))  # nothing unread: only the end-of-output marker
        for raw in server.raw_lines:
            self.assertTrue(raw.endswith(b"\n"))
            message = json.loads(raw.decode("utf-8"))
            self.assertEqual(message.get("jsonrpc"), "2.0", raw)
            self.assertIn("id", message, raw)
            self.assertEqual(len({"result", "error"} & set(message)), 1, raw)
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "preview.json")))
        session_path = os.path.join(self.state_dir, "session.json")
        with open(session_path, encoding="utf-8") as handle:
            session = json.load(handle)
        self.assertEqual(session["transport"], "usbmux:%s:8100" % UDID)
        self.assertEqual(session["session_id"], self.fake.active_sid)
        self.assertEqual(os.stat(session_path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.state_dir).st_mode & 0o777, 0o700)
        self.assertEqual(self.fake.calls("/wda/healthcheck"), [])
        self.assertEqual(self.fake.calls("/wda/unlock"), [])
        self.assertTrue(self.wait_for(lambda: self.mux.active_tunnels() == 0))

    def test_eof_while_a_call_is_queued_answers_the_running_call_and_exits(self):
        server = self.start_server()
        server.send(rpc(1, "initialize", {"protocolVersion": "2099-01-01"}))
        self.assertEqual(server.read()["result"]["protocolVersion"], "2025-11-25")
        self.fake.inject("GET", "/wda/locked", delay=0.3)
        server.send(tool_call(2, "iphone_ready"), tool_call(3, "iphone_observe"))
        self.assertTrue(self.wait_for(lambda: self.fake.calls("/wda/locked")))
        server.process.stdin.close()
        self.assertEqual(server.close_stdin_and_wait(), 0)
        answered = [json.loads(raw.decode("utf-8"))["id"] for raw in server.raw_lines]
        self.assertEqual(answered, [1, 2])
        self.assertEqual(server.stderr(), "")
        # READY read the screen once; the queued iphone_observe was discarded, never run.
        self.assertEqual(len(self.fake.calls("/source")), 1)

    def test_cold_start_without_configuration_points_to_setup(self):
        os.unlink(os.path.join(self.state_dir, "config.json"))
        server = self.start_server()
        server.send(rpc(1, "initialize", {"protocolVersion": "2025-11-25"}))
        self.assertEqual(server.read()["result"]["protocolVersion"], "2025-11-25")

        # READY is a setup step here, not a failure: it names iphone_setup(action=status) and starts nothing.
        result, ready = self.call("iphone_ready", {})
        self.assertIs(result["isError"], True)
        error = ready["error"]
        self.assertEqual(error["code"], "service_unreachable")
        self.assertEqual(error["reason"], "not_configured")
        self.assertIs(error["uncertain"], False)
        self.assertIs(error["initialization_required"], True)
        self.assertEqual(error["recovery"]["next_tool"], "iphone_setup")
        self.assertEqual(error["recovery"]["next_arguments"], {"action": "status"})

        # Phone tools refuse without touching anything; setup status and doctor still answer.
        result, observe = self.call("iphone_observe", {})
        self.assertEqual(observe["error"]["code"], "service_unreachable")
        _, status = self.ok("iphone_setup", {"action": "status"})
        self.assertIs(status["configured"], False)
        self.assertEqual(status["jobs"], [])
        self.assertIs(status["service"]["ready"], False)
        self.assertTrue(status["next_steps"])
        started = time.monotonic()
        _, doctor = self.ok("iphone_doctor", {})
        self.assertLess(time.monotonic() - started, 10)
        self.assertIs(doctor["healthy"], False)
        self.assertIs(doctor["checks"]["configured"], False)
        self.assertTrue(doctor["next_steps"][-1].endswith("Keep the iPhone unlocked and awake while Claude uses it."))

        self.assertEqual(server.close_stdin_and_wait(), 0)
        self.assertEqual(server.stderr(), "")
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.mux.connects, [])
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "config.json")))


class RealSetupRecoveryTests(unittest.TestCase):
    """READY's recovery branches against the real SetupManager (unit tests stub it out)."""

    CONFIG = {"format": 1, "udid": UDID, "team_id": "ABCDE12345", "bundle_id": "com.iphoneuse.e2etest01.wda",
              "device_port": 8100, "mjpeg_port": 9100}
    XCTEST_DENIED = "Error Domain=com.apple.dt.XCTest Code=41 Not authorized for performing UI testing actions."

    def setUp(self):
        self.h = RuntimeHarness(config=dict(self.CONFIG))
        self.addCleanup(self.h.close)
        self.runtime = self.h.runtime

    def test_a_pending_recover_job_makes_ready_report_recovering_without_any_request(self):
        manager = self.runtime.setup
        config = manager._normalized(manager.config)
        job_id, target = uuid.uuid4().hex, uuid.uuid4().hex
        privstate.write_json_private(manager.jobs_dir / (job_id + ".json"), {
            "format": 2, "id": job_id, "action": "recover", "state": "queued", "phase": "queued",
            "created_at": privstate.iso_now(), "started_at": None, "completed_at": None,
            "owner_token": uuid.uuid4().hex, "pid": None, "worker_entrypoint": str(manager.entrypoint),
            "config": config, "config_fingerprint": wda_setup.build_fingerprint(config, True), "patched": True,
            "transport": self.runtime.transport.identity, "service_started_at": None, "recovery_of": target,
            "recovery_target": None, "source_dir": None, "error": None})
        self.h.fake.clear_log()
        envelope = self.h.execute("iphone_ready", {})
        self.assertIs(envelope["ok"], True, envelope)
        self.assertIs(envelope["ready"], False)
        self.assertEqual(envelope["state"], "recovering")
        recovery = envelope["recovery"]
        self.assertEqual((recovery["job_id"], recovery["recovery_of"], recovery["phase"]), (job_id, target, "queued"))
        self.assertEqual(recovery["status_arguments"], {"action": "status", "job_id": job_id, "wait_seconds": 20})
        self.assertEqual(recovery["next_tool"], "iphone_ready")
        self.assertIs(recovery["replay_action"], False)
        for key in ("proof", "observation", "error"):
            self.assertNotIn(key, envelope)
        self.assertEqual(self.h.fake.requests, [])

    def test_a_channel_fault_on_a_service_this_plugin_did_not_start_is_not_restarted(self):
        self.h.fake.inject("GET", "/source", error="unknown error", message=self.XCTEST_DENIED, times=None)
        envelope = self.h.execute("iphone_ready", {"recover": True})
        error = envelope["error"]
        self.assertEqual(error["code"], "recovery_not_started")
        self.assertEqual(error["category"], "channel_runtime")
        self.assertEqual(error["recovery"]["state"], "manual")
        self.assertTrue(error["recovery"]["next_steps"])
        self.assertEqual(error["cause"]["code"], "unknown error")
        self.assertEqual(os.listdir(str(self.runtime.setup.jobs_dir)), [])  # no job, nothing signalled
        disabled = self.h.execute("iphone_ready", {"recover": False})
        self.assertIs(disabled["ok"], True)
        self.assertEqual((disabled["state"], disabled["reason"]), ("recovery_required", "recovery_disabled"))
        self.assertEqual(disabled["recovery"]["next_arguments"], {"screenshot": False, "recover": True})


if __name__ == "__main__":
    unittest.main()
