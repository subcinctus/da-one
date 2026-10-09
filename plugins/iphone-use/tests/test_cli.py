import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import importlib.util  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import FakeWDA  # noqa: E402
from test_runtime import refused_port  # noqa: E402
from version import VERSION  # noqa: E402

PLUGIN = os.path.dirname(HERE)
PHONE_SCRIPT = os.path.join(PLUGIN, "scripts", "phone.py")
SERVER_SCRIPT = os.path.join(SERVER, "iphone_use.py")


def load_phone_module():
    spec = importlib.util.spec_from_file_location("phone_cli_under_test", PHONE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CliCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeWDA().start()
        self.addCleanup(self.fake.stop)
        self.mux = FakeUsbmuxd().start()
        self.addCleanup(self.mux.stop)
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)
        os.mkdir(os.path.join(self.root, "bin"))
        os.mkdir(os.path.join(self.root, "home"))
        self.state_dir = os.path.join(self.root, "state")
        self.env = {"PATH": os.path.join(self.root, "bin"), "HOME": os.path.join(self.root, "home"),
                    "PYTHONDONTWRITEBYTECODE": "1", "IPHONE_USE_PREVIEW_PORT": "0", "IPHONE_USE_NO_BROWSER": "1",
                    "IPHONE_USE_SETTLE_SECONDS": "0"}
        self.env.update(self.mux.env())

    def run_script(self, script, *args, state_dir=None, url="fake", input_data=None):
        argv = [sys.executable, script] + list(args) + ["--state-dir", state_dir or self.state_dir]
        if url == "fake":
            argv += ["--url", self.fake.url]
        elif url:
            argv += ["--url", url]
        process = subprocess.run(argv, input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=self.env, cwd=self.root, timeout=60)
        return process.returncode, process.stdout.decode("utf-8"), process.stderr.decode("utf-8")

    def envelope(self, stdout):
        lines = stdout.splitlines()
        self.assertEqual(len(lines), 1, stdout)
        text = lines[0]
        value = json.loads(text)
        self.assertEqual(text, json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return value

    def git_state_dir(self):
        project = os.path.join(self.root, "project")
        os.makedirs(os.path.join(project, ".git"))
        return os.path.join(project, "state")


class PhoneScriptTests(CliCase):
    def test_observe_prints_one_envelope_and_exits_zero(self):
        code, stdout, stderr = self.run_script(PHONE_SCRIPT, "iphone_observe", '{"mode":"tree"}')
        self.assertEqual((code, stderr), (0, ""))
        envelope = self.envelope(stdout)
        self.assertIs(envelope["ok"], True)
        self.assertEqual(envelope["app"], "com.apple.Preferences")
        self.assertIn("GET /source", self.fake.routes())

    def test_screenshot_is_a_path_not_base64(self):
        code, stdout, stderr = self.run_script(PHONE_SCRIPT, "iphone_observe", '{"mode":"screenshot"}')
        self.assertEqual((code, stderr), (0, ""))
        image = self.envelope(stdout)["image"]
        self.assertTrue(os.path.isfile(image["path"]))
        self.assertTrue(image["path"].startswith(os.path.realpath(self.state_dir)))
        self.assertLess(len(stdout), 2000)

    def test_arguments_default_to_an_empty_object(self):
        code, stdout, _ = self.run_script(PHONE_SCRIPT, "iphone_metrics")
        self.assertEqual(code, 0)
        self.assertEqual(set(self.envelope(stdout)), {"ok", "http", "tools", "responses"})

    def test_invalid_arguments_exit_one_without_phone_requests(self):
        for raw in ("{bad", "NaN", '{"x": Infinity}', '[1]', '{"mode":"nope"}', '{"unknown": 1}'):
            with self.subTest(raw=raw):
                code, stdout, stderr = self.run_script(PHONE_SCRIPT, "iphone_observe", raw)
                self.assertEqual((code, stderr), (1, ""))
                error = self.envelope(stdout)["error"]
                self.assertEqual(error["code"], "invalid_argument")
                self.assertFalse(error["action_executed"])
        self.assertEqual(self.fake.requests, [])

    def test_ready_exit_codes(self):
        code, stdout, _ = self.run_script(PHONE_SCRIPT, "iphone_ready")
        self.assertEqual(code, 0)
        envelope = self.envelope(stdout)
        self.assertIs(envelope["ready"], True)
        self.assertNotIn("preview", envelope)
        self.fake.locked = True
        code, stdout, _ = self.run_script(PHONE_SCRIPT, "iphone_ready")
        self.assertEqual(code, 1)
        self.assertEqual(self.envelope(stdout)["error"]["code"], "phone_locked")

    def test_unreachable_service_exits_one(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        code, stdout, _ = self.run_script(PHONE_SCRIPT, "iphone_ready", url="http://127.0.0.1:%d" % port)
        self.assertEqual(code, 1)
        error = self.envelope(stdout)["error"]
        self.assertEqual(error["code"], "service_unreachable")
        self.assertTrue(error["initialization_required"])

    def test_unknown_tool_is_a_usage_error(self):
        code, stdout, stderr = self.run_script(PHONE_SCRIPT, "iphone_reboot", "{}")
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("invalid choice", stderr)

    def test_state_dir_inside_git_is_refused(self):
        code, stdout, _ = self.run_script(PHONE_SCRIPT, "iphone_observe", state_dir=self.git_state_dir())
        self.assertEqual(code, 1)
        self.assertEqual(self.envelope(stdout)["error"]["code"], "state_dir_unsafe")


class PhoneMainTests(unittest.TestCase):
    """phone.main() in-process with a stand-in Runtime (exit-code rules only)."""

    def run_main(self, envelope, tool="iphone_ready"):
        module = load_phone_module()
        runtime = mock.Mock()
        runtime.execute.return_value = envelope
        output = io.StringIO()
        with mock.patch.object(module, "Runtime", return_value=runtime) as factory, \
                mock.patch("sys.stdout", output):
            code = module.main([tool, '{"recover": false}', "--state-dir", "/tmp/x", "--url", "http://127.0.0.1:9"])
        factory.assert_called_once_with(state_dir="/tmp/x", wda_url="http://127.0.0.1:9", serve_preview=False)
        runtime.close.assert_called_once_with()
        return code, output.getvalue()

    def test_ready_false_is_exit_one_even_when_ok(self):
        code, output = self.run_main({"ok": True, "ready": False, "state": "recovering"})
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["state"], "recovering")

    def test_ready_true_is_exit_zero(self):
        self.assertEqual(self.run_main({"ok": True, "ready": True})[0], 0)

    def test_other_tools_only_look_at_ok(self):
        self.assertEqual(self.run_main({"ok": True}, tool="iphone_tap")[0], 0)
        self.assertEqual(self.run_main({"ok": False, "error": {"code": "x"}}, tool="iphone_tap")[0], 1)

    def test_runtime_is_closed_even_when_execute_fails(self):
        module = load_phone_module()
        runtime = mock.Mock()
        runtime.execute.side_effect = KeyboardInterrupt
        with mock.patch.object(module, "Runtime", return_value=runtime), mock.patch("sys.stdout", io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                module.main(["iphone_observe"])
        runtime.close.assert_called_once_with()


class ServerFlagTests(CliCase):
    def test_version(self):
        process = subprocess.run([sys.executable, SERVER_SCRIPT, "--version"], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=self.env, cwd=self.root, timeout=30)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(process.stdout.decode(), "iphone-use %s\n" % VERSION)

    def test_ready_flag_exit_codes_and_json(self):
        code, stdout, stderr = self.run_script(SERVER_SCRIPT, "--ready")
        self.assertEqual((code, stderr), (0, ""))
        envelope = self.envelope(stdout)
        self.assertIs(envelope["ready"], True)
        self.assertEqual(envelope["proof"]["screenshot_readable"], False)
        self.fake.locked = True
        code, stdout, _ = self.run_script(SERVER_SCRIPT, "--ready")
        self.assertEqual(code, 1)
        self.assertEqual(self.envelope(stdout)["error"]["code"], "phone_locked")

    def test_doctor_flag_prints_the_report(self):
        code, stdout, stderr = self.run_script(SERVER_SCRIPT, "--doctor", url=None)
        self.assertEqual((code, stderr), (0, ""))
        envelope = self.envelope(stdout)
        self.assertIs(envelope["ok"], True)
        self.assertIs(envelope["healthy"], False)
        self.assertIsInstance(envelope["next_steps"], list)

    def test_flags_with_an_unsafe_state_dir_exit_one(self):
        for flag in ("--ready", "--doctor"):
            with self.subTest(flag=flag):
                code, stdout, _ = self.run_script(SERVER_SCRIPT, flag, state_dir=self.git_state_dir())
                self.assertEqual(code, 1)
                self.assertEqual(self.envelope(stdout)["error"]["code"], "state_dir_unsafe")
                shutil.rmtree(os.path.join(self.root, "project"))

    def test_runtime_failure_still_serves_and_reports_the_error(self):
        lines = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
                 {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        data = b"".join(json.dumps(line).encode() + b"\n" for line in lines)
        code, stdout, stderr = self.run_script(SERVER_SCRIPT, state_dir=self.git_state_dir(), input_data=data)
        self.assertEqual((code, stderr), (0, ""))
        replies = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in replies], [1, 2])
        self.assertEqual(len(replies[1]["result"]["tools"]), 17)

    def test_runtime_failure_answers_tool_calls_over_stdio(self):
        state_dir = self.git_state_dir()
        process = subprocess.Popen([sys.executable, SERVER_SCRIPT, "--state-dir", state_dir], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env, cwd=self.root)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        try:
            message = {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                       "params": {"name": "iphone_ready", "arguments": {}}}
            process.stdin.write(json.dumps(message).encode() + b"\n")
            process.stdin.flush()
            reply = json.loads(process.stdout.readline().decode())
            process.stdin.close()
            self.assertEqual(process.wait(20), 0)
            self.assertEqual(process.stderr.read(), b"")
        finally:
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(reply["id"], 5)
        self.assertTrue(reply["result"]["isError"])
        error = json.loads(reply["result"]["content"][0]["text"])["error"]
        self.assertEqual(error["code"], "state_dir_unsafe")
        self.assertIn("IPHONE_USE_STATE_DIR", error["message"])
        self.assertFalse(os.path.exists(state_dir))


if __name__ == "__main__":
    unittest.main()
