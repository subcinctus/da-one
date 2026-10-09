import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import base64  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import queue  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import unittest  # noqa: E402

import iphone_use  # noqa: E402
import mcp_schemas  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import FakeWDA  # noqa: E402
from test_runtime import RuntimeHarness  # noqa: E402
from version import VERSION  # noqa: E402

SERVER_SCRIPT = os.path.join(SERVER, "iphone_use.py")
READ_TIMEOUT = 10.0


def request(ident, method, params=None):
    message = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        message["params"] = params
    return message


def call(ident, name, arguments=None):
    params = {"name": name}
    if arguments is not None:
        params["arguments"] = arguments
    return request(ident, "tools/call", params)


def encode(message):
    if isinstance(message, bytes):
        return message if message.endswith(b"\n") else message + b"\n"
    if isinstance(message, str):
        return message.encode("utf-8") + b"\n"
    return json.dumps(message).encode("utf-8") + b"\n"


class LineReader:
    """Reads JSON lines from a binary stream on a thread, so tests can wait with a timeout."""

    def __init__(self, stream):
        self.stream = stream
        self.lines = queue.Queue()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            for line in iter(self.stream.readline, b""):
                self.lines.put(line)
        except (OSError, ValueError):
            pass
        self.lines.put(None)

    def read(self, timeout=READ_TIMEOUT):
        line = self.lines.get(timeout=timeout)
        if line is None:
            raise AssertionError("the server closed its output")
        return json.loads(line.decode("utf-8"))

    def raw(self, timeout=READ_TIMEOUT):
        return self.lines.get(timeout=timeout)

    def silent(self, timeout=0.2):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            return True
        self.lines.put(line)
        return line is None


class ServerProcess:
    """server/iphone_use.py as a child process (the way Claude Code runs it)."""

    def __init__(self, args, env, cwd):
        self.process = subprocess.Popen([sys.executable, SERVER_SCRIPT] + list(args), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd)
        self.reader = LineReader(self.process.stdout)
        self.stderr = b""

    def send(self, *messages):
        for message in messages:
            self.process.stdin.write(encode(message))
        self.process.stdin.flush()

    def read(self, timeout=READ_TIMEOUT):
        return self.reader.read(timeout)

    def finish(self, timeout=20):
        """Close stdin and wait; returns (exit code, remaining stdout lines, stderr text)."""
        if not self.process.stdin.closed:
            self.process.stdin.close()
        code = self.process.wait(timeout)
        self.reader.thread.join(5)
        rest = []
        while True:
            line = self.reader.lines.get_nowait() if not self.reader.lines.empty() else None
            if line is None:
                break
            rest.append(line)
        self.stderr = self.process.stderr.read().decode("utf-8", "replace")
        self.process.stdout.close()
        self.process.stderr.close()
        return code, rest, self.stderr

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeWDA().start()
        self.addCleanup(self.fake.stop)
        self.mux = FakeUsbmuxd().start()
        self.addCleanup(self.mux.stop)
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)
        os.mkdir(os.path.join(self.root, "bin"))
        os.mkdir(os.path.join(self.root, "home"))
        self.env = {"PATH": os.path.join(self.root, "bin"), "HOME": os.path.join(self.root, "home"),
                    "PYTHONDONTWRITEBYTECODE": "1", "IPHONE_USE_WDA_URL": self.fake.url,
                    "IPHONE_USE_PREVIEW_PORT": "0", "IPHONE_USE_NO_BROWSER": "1", "IPHONE_USE_SETTLE_SECONDS": "0"}
        self.env.update(self.mux.env())

    def start(self, *args):
        server = ServerProcess(["--state-dir", os.path.join(self.root, "state")] + list(args), self.env, self.root)
        self.addCleanup(server.kill)
        return server

    def finish(self, server):
        code, rest, stderr = server.finish()
        self.assertEqual(code, 0)
        self.assertEqual(rest, [])
        self.assertEqual(stderr, "")

    def test_initialize_notification_ping_and_tool_catalog(self):
        server = self.start()
        server.send(request(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                              "clientInfo": {"name": "test", "version": "1"}}))
        initialized = server.read()
        server.send({"jsonrpc": "2.0", "method": "notifications/initialized"}, request("ping", "ping"),
                    request(3, "tools/list"))
        ping, listing = server.read(), server.read()
        self.assertEqual([initialized["id"], ping["id"], listing["id"]], [1, "ping", 3])
        result = initialized["result"]
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
        self.assertEqual(result["serverInfo"], {"name": "iphone-use", "title": "iPhone Use", "version": VERSION})
        self.assertEqual(result["instructions"], mcp_schemas.INSTRUCTIONS)
        self.assertEqual(ping["result"], {})
        self.assertEqual([tool["name"] for tool in listing["result"]["tools"]], list(mcp_schemas.TOOL_NAMES))
        for tool in listing["result"]["tools"]:
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertIs(tool["inputSchema"]["additionalProperties"], False)
        self.finish(server)
        self.assertEqual(self.fake.requests, [])

    def test_unknown_or_missing_protocol_version_gets_the_newest(self):
        server = self.start()
        server.send(request(1, "initialize", {"protocolVersion": "2099-01-01"}), request(2, "initialize", {}))
        self.assertEqual(server.read()["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(server.read()["result"]["protocolVersion"], "2025-11-25")
        for version in iphone_use.PROTOCOL_VERSIONS:
            server.send(request(version, "initialize", {"protocolVersion": version}))
            self.assertEqual(server.read()["result"]["protocolVersion"], version)
        self.finish(server)

    def test_server_discover_probe_falls_back_to_initialize(self):
        server = self.start()
        server.send(request(0, "server/discover", {"_meta": {"protocolVersion": "2026-07-28"}}))
        probe = server.read()
        self.assertEqual(probe, {"jsonrpc": "2.0", "id": 0, "error": {"code": -32601, "message": "Method not found"}})
        server.send(request(1, "initialize", {"protocolVersion": "2025-11-25"}), request(2, "tools/list"))
        self.assertEqual(server.read()["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(len(server.read()["result"]["tools"]), 17)
        self.finish(server)

    def test_parse_errors_do_not_stop_the_server(self):
        server = self.start()
        for raw in (b"{not json", b"\xff\xfe\x00", b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":NaN}}',
                    b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":Infinity}}'):
            server.send(raw)
            self.assertEqual(server.read(), {"jsonrpc": "2.0", "id": None,
                                             "error": {"code": -32700, "message": "Parse error"}})
        server.send(b"", b"   ", request(9, "ping"))
        self.assertEqual(server.read(), {"jsonrpc": "2.0", "id": 9, "result": {}})
        self.finish(server)

    def test_invalid_requests_and_unknown_methods_are_rpc_errors(self):
        server = self.start()
        cases = (({"jsonrpc": "1.0", "id": 7, "method": "ping"}, 7, -32600),
                 ({"jsonrpc": "2.0", "id": 8}, 8, -32600),
                 ({"jsonrpc": "2.0", "id": True, "method": "ping"}, None, -32600),
                 ({"jsonrpc": "2.0", "id": {"a": 1}, "method": "ping"}, None, -32600),
                 ({"jsonrpc": "2.0", "id": None, "method": "ping"}, None, -32600),
                 ([1, 2, 3], None, -32600),
                 ({"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": []}, 9, -32602),
                 ({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": None}, 10, -32602),
                 (request(11, "resources/list"), 11, -32601),
                 (request(12, "prompts/list"), 12, -32601),
                 (request(13, "resources/read", {"uri": "ui://x"}), 13, -32601),
                 ({"jsonrpc": "2.0", "id": 14, "result": {}}, 14, -32600))
        for message, ident, code in cases:
            with self.subTest(message=message):
                server.send(message)
                reply = server.read()
                self.assertEqual(reply["id"], ident)
                self.assertEqual(reply["error"]["code"], code)
                if code == -32602:
                    self.assertEqual(reply["error"]["message"], "params must be an object.")
        server.send({"jsonrpc": "2.0", "method": "notifications/whatever"}, request(15, "ping"))
        self.assertEqual(server.read()["id"], 15)
        self.finish(server)

    def test_tool_failures_are_results_not_rpc_errors(self):
        server = self.start()
        server.send(call(1, "iphone_nope", {}), call(2, "iphone_tap", {"x": 1}),
                    call(3, "iphone_type_text", {"text": "a\nb"}), call(4, "iphone_observe", "notadict"))
        replies = {reply["id"]: reply for reply in (server.read(), server.read(), server.read(), server.read())}
        expected = {1: "unknown_tool", 2: "invalid_argument", 3: "newline_requires_intent", 4: "invalid_argument"}
        for ident, code in expected.items():
            with self.subTest(ident=ident):
                result = replies[ident]["result"]
                self.assertEqual(set(result), {"content", "isError"})
                self.assertIs(result["isError"], True)
                self.assertEqual(len(result["content"]), 1)
                text = result["content"][0]["text"]
                envelope = json.loads(text)
                self.assertEqual(text, json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))
                self.assertEqual(envelope["error"]["code"], code)
                self.assertFalse(envelope["error"]["action_executed"])
        self.finish(server)
        self.assertEqual(self.fake.requests, [])

    def test_phone_tools_run_and_return_compact_json(self):
        server = self.start()
        server.send(call(1, "iphone_observe"), call(2, "iphone_screen", {"action": "status"}),
                    call(3, "iphone_observe", {"mode": "screenshot"}))
        replies = {reply["id"]: reply["result"] for reply in (server.read(), server.read(), server.read())}
        observe = replies[1]
        self.assertIs(observe["isError"], False)
        envelope = json.loads(observe["content"][0]["text"])
        self.assertIs(envelope["ok"], True)
        self.assertEqual(envelope["app"], "com.apple.Preferences")
        self.assertNotIn('": ', observe["content"][0]["text"])
        status = json.loads(replies[2]["content"][0]["text"])
        self.assertEqual(status["running"], False)
        shot = replies[3]
        self.assertEqual([block["type"] for block in shot["content"]], ["text", "image"])
        image = shot["content"][1]
        # PNG as captured, or JPEG when macOS sips is present to downscale it; the bytes must match the type.
        self.assertIn(image["mimeType"], ("image/png", "image/jpeg"))
        magic = b"\x89PNG" if image["mimeType"] == "image/png" else b"\xff\xd8"
        self.assertTrue(base64.b64decode(image["data"]).startswith(magic))
        self.assertNotIn(shot["content"][1]["data"][:200], shot["content"][0]["text"])
        self.finish(server)
        self.assertIn("GET /source", self.fake.routes())

    def test_eof_exits_cleanly_with_empty_stderr(self):
        server = self.start()
        server.send(request(1, "ping"))
        self.assertEqual(server.read()["id"], 1)
        self.finish(server)


# --- in-process serve() over pipes ---------------------------------------------------------------------------


class GateRuntime:
    """A stand-in runtime: records calls; a call whose arguments carry "gate" waits for that event."""

    def __init__(self):
        self.calls = []
        self.started = {}
        self.gates = {}
        self.responses = []
        self.closed = False
        self.lock = threading.Lock()

    def gate(self, tag):
        self.gates[tag] = threading.Event()
        self.started[tag] = threading.Event()
        return self.gates[tag]

    def execute(self, name, args):
        tag = args.get("tag") if isinstance(args, dict) else None
        with self.lock:
            self.calls.append(tag)
        if tag in self.started:
            self.started[tag].set()
        if tag in self.gates:
            self.gates[tag].wait(10)
        return {"ok": True, "tag": tag}

    def note_response(self, name, text_bytes, image_bytes):
        self.responses.append((name, text_bytes, image_bytes))

    def close(self):
        self.closed = True


class PipeServer:
    """iphone_use.serve() on a thread, fed and read through OS pipes."""

    def __init__(self, runtime):
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        self.stdin = os.fdopen(in_read, "rb")
        self.input = os.fdopen(in_write, "wb")
        self.output = os.fdopen(out_read, "rb")
        self.stdout = os.fdopen(out_write, "wb")
        self.runtime = runtime
        self.result = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.reader = LineReader(self.output)

    def _run(self):
        try:
            self.result = iphone_use.serve(self.runtime, self.stdin, self.stdout)
        finally:
            self.stdout.close()
            self.stdin.close()

    def send(self, *messages):
        for message in messages:
            self.input.write(encode(message))
        self.input.flush()

    def read(self, timeout=READ_TIMEOUT):
        return self.reader.read(timeout)

    def finish(self, timeout=10):
        if not self.input.closed:
            self.input.close()
        self.thread.join(timeout)
        return self.result

    def close(self):
        self.finish()
        self.output.close()


class ServeTests(unittest.TestCase):
    def server(self, runtime):
        server = PipeServer(runtime)
        self.addCleanup(server.close)
        return server

    def test_phone_calls_run_strictly_in_order(self):
        runtime = GateRuntime()
        gate = runtime.gate("a")
        server = self.server(runtime)
        server.send(call(1, "iphone_tap", {"tag": "a"}), call(2, "iphone_tap", {"tag": "b"}),
                    call(3, "iphone_tap", {"tag": "c"}), request(4, "ping"))
        self.assertEqual(server.read()["id"], 4)
        self.assertTrue(runtime.started["a"].wait(5))
        self.assertEqual(runtime.calls, ["a"])
        gate.set()
        self.assertEqual([server.read()["id"] for _ in range(3)], [1, 2, 3])
        self.assertEqual(runtime.calls, ["a", "b", "c"])
        self.assertEqual(server.finish(), 0)
        self.assertTrue(runtime.closed)
        self.assertEqual([name for name, _, _ in runtime.responses], ["iphone_tap"] * 3)
        self.assertTrue(all(text > 0 and image == 0 for _, text, image in runtime.responses))

    def test_cancelled_queued_call_is_dropped_without_an_answer(self):
        runtime = GateRuntime()
        gate = runtime.gate("a")
        server = self.server(runtime)
        server.send(call(1, "iphone_tap", {"tag": "a"}), call("two", "iphone_tap", {"tag": "b"}),
                    call(3, "iphone_tap", {"tag": "c"}))
        self.assertTrue(runtime.started["a"].wait(5))
        server.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": "two",
                                                                                         "reason": "user"}},
                    {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}},
                    request(4, "ping"))
        self.assertEqual(server.read()["id"], 4)
        gate.set()
        self.assertEqual([server.read()["id"], server.read()["id"]], [1, 3])
        self.assertEqual(runtime.calls, ["a", "c"])
        self.assertTrue(server.reader.silent())

    def test_cancel_matches_the_id_type(self):
        runtime = GateRuntime()
        gate = runtime.gate("a")
        server = self.server(runtime)
        server.send(call(1, "iphone_tap", {"tag": "a"}), call(2, "iphone_tap", {"tag": "b"}))
        self.assertTrue(runtime.started["a"].wait(5))
        server.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": "2"}})
        gate.set()
        self.assertEqual([server.read()["id"], server.read()["id"]], [1, 2])

    def test_eof_answers_the_running_call_and_discards_queued_ones(self):
        runtime = GateRuntime()
        gate = runtime.gate("a")
        server = self.server(runtime)
        server.send(call(1, "iphone_tap", {"tag": "a"}), call(2, "iphone_tap", {"tag": "b"}))
        self.assertTrue(runtime.started["a"].wait(5))
        server.input.close()
        threading.Timer(0.1, gate.set).start()
        self.assertEqual(server.read()["id"], 1)
        self.assertEqual(server.finish(), 0)
        self.assertEqual(runtime.calls, ["a"])
        self.assertTrue(runtime.closed)
        self.assertIsNone(server.reader.raw())

    def test_screen_tool_is_answered_while_a_phone_call_is_blocked(self):
        harness = RuntimeHarness()
        self.addCleanup(harness.close)
        runtime = harness.runtime
        entered, release = threading.Event(), threading.Event()
        observe = runtime.phone.observe

        def blocked_observe(*args, **kwargs):
            entered.set()
            release.wait(10)
            return observe(*args, **kwargs)

        runtime.phone.observe = blocked_observe
        server = self.server(runtime)
        server.send(call(1, "iphone_observe", {}))
        self.assertTrue(entered.wait(5))
        server.send(call(2, "iphone_screen", {"action": "pause"}), request(3, "ping"),
                    call(4, "iphone_screen", {"action": "status"}))
        first, second, third = server.read(), server.read(), server.read()
        self.assertEqual([first["id"], second["id"], third["id"]], [2, 3, 4])
        paused = json.loads(first["result"]["content"][0]["text"])
        self.assertEqual((paused["ok"], paused["paused"], paused["pause_reason"]), (True, True, "authentication"))
        release.set()
        observed = server.read()
        self.assertEqual(observed["id"], 1)
        self.assertIs(json.loads(observed["result"]["content"][0]["text"])["ok"], True)
        self.assertEqual(server.finish(), 0)

    def test_inline_tool_has_unhashable_name_guard(self):
        runtime = GateRuntime()
        server = self.server(runtime)
        server.send(request(1, "tools/call", {"name": ["iphone_screen"], "arguments": {"tag": "x"}}),
                    request(2, "ping"))
        replies = {reply["id"]: reply for reply in (server.read(), server.read())}
        self.assertEqual(replies[1]["result"]["content"][0]["type"], "text")
        self.assertEqual(replies[2]["result"], {})

    def test_failed_runtime_still_serves_the_protocol(self):
        runtime = iphone_use.FailedRuntime(ToolError("state_dir_unsafe", "Use a private folder.",
                                                     details={"state_dir": "/x"}))
        server = self.server(runtime)
        server.send(request(1, "initialize", {"protocolVersion": "2025-11-25"}), request(2, "tools/list"),
                    call(3, "iphone_ready", {}))
        replies = {reply["id"]: reply for reply in (server.read(), server.read(), server.read())}
        self.assertEqual(replies[1]["result"]["serverInfo"]["name"], "iphone-use")
        self.assertEqual(len(replies[2]["result"]["tools"]), 17)
        result = replies[3]["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"])["error"]["code"], "state_dir_unsafe")
        self.assertEqual(server.finish(), 0)


class StreamTests(unittest.TestCase):
    """serve() on in-memory streams for framing edge cases (no tool calls, so EOF order does not matter)."""

    def run_lines(self, data, runtime=None):
        output = io.BytesIO()
        runtime = runtime or GateRuntime()
        code = iphone_use.serve(runtime, io.BytesIO(data), output)
        self.assertEqual(code, 0)
        self.assertTrue(runtime.closed)
        return [json.loads(line) for line in output.getvalue().decode("utf-8").splitlines()]

    def test_line_longer_than_the_limit_is_a_parse_error(self):
        too_long = b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"' + b"x" * iphone_use.MAX_LINE_BYTES \
            + b'"}}\n'
        replies = self.run_lines(too_long + encode(request(2, "ping")))
        self.assertEqual(replies, [{"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
                                   {"jsonrpc": "2.0", "id": 2, "result": {}}])

    def test_line_at_the_limit_is_accepted(self):
        head = b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"'
        tail = b'"}}'
        line = head + b"x" * (iphone_use.MAX_LINE_BYTES - len(head) - len(tail)) + tail
        self.assertEqual(len(line), iphone_use.MAX_LINE_BYTES)
        self.assertEqual(self.run_lines(line + b"\n"), [{"jsonrpc": "2.0", "id": 1, "result": {}}])

    def test_last_line_without_newline_and_crlf(self):
        replies = self.run_lines(json.dumps(request(1, "ping")).encode() + b"\r\n" +
                                 json.dumps(request(2, "ping")).encode())
        self.assertEqual([reply["id"] for reply in replies], [1, 2])

    def test_notifications_are_never_answered(self):
        replies = self.run_lines(encode({"jsonrpc": "2.0", "method": "notifications/initialized"}) +
                                 encode({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                         "params": {"requestId": 99}}) +
                                 encode({"jsonrpc": "2.0", "method": "ping"}))
        self.assertEqual(replies, [])

    def test_closed_client_output_is_swallowed(self):
        class Broken(io.RawIOBase):
            def writable(self):
                return True

            def write(self, data):
                raise BrokenPipeError("client gone")

        runtime = GateRuntime()
        code = iphone_use.serve(runtime, io.BytesIO(encode(request(1, "ping")) + encode(request(2, "tools/list"))),
                                Broken())
        self.assertEqual(code, 0)
        self.assertTrue(runtime.closed)

    def test_messages_are_one_utf8_json_line_each(self):
        output = io.BytesIO()
        iphone_use.serve(GateRuntime(), io.BytesIO(encode(request(1, "initialize", {}))), output)
        raw = output.getvalue()
        self.assertEqual(raw.count(b"\n"), 1)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertIn("iPhone Use".encode("utf-8"), raw)
        self.assertNotIn(b"\\u", raw.split(b'"instructions"')[0])


if __name__ == "__main__":
    unittest.main()
