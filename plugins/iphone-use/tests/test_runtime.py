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
import shutil  # noqa: E402
import socket  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import iphone_use  # noqa: E402
import privstate  # noqa: E402
import runtime as runtime_module  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import FakeWDA  # noqa: E402
from fakes_cmd import FakeRunner, jpeg_out_effect, write_fake_executable  # noqa: E402
from runtime import Runtime  # noqa: E402
from wda_image import solid_png  # noqa: E402

UDID = "00008110-0000000000000001"
TOOL_NAMES = ("iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
              "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text",
              "iphone_wait", "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen",
              "iphone_metrics")


def refused_port():
    """A loopback port with nothing listening (bound but not listening, so nobody else can take it)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    return sock, sock.getsockname()[1]


def test_env(home, mux, extra=None):
    """A minimal, private environment for code under test: no real usbmuxd, no browser, ephemeral preview."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "IPHONE_USE_PREVIEW_PORT": "0",
           "IPHONE_USE_NO_BROWSER": "1", "IPHONE_USE_SETTLE_SECONDS": "0"}
    env.update(mux.env())
    if extra:
        env.update(extra)
    return env


class RuntimeHarness:
    """FakeWDA + FakeUsbmuxd + a Runtime in a short private temp dir.

    url="fake" points the runtime at the FakeWDA over loopback TCP; url=None uses the
    configuration (pass config={"udid": ..} plus via_usbmux=True to tunnel through
    FakeUsbmuxd); any other string is passed as the explicit URL. Screenshots become JPEGs
    through a fake sips. Everything is removed by close().
    """

    def __init__(self, fake=None, url="fake", config=None, env=None, serve_preview=True, state_dir=None,
                 via_usbmux=False, **fake_kwargs):
        self._owns_fake = fake is None
        self.fake = fake if fake is not None else FakeWDA(**fake_kwargs)
        self.mux = None
        self.root = None
        self.runtimes = []
        try:
            self.fake.start()
            self.mux = FakeUsbmuxd().start()
            if via_usbmux:
                ports = {8100: ("127.0.0.1", self.fake.port)}
                if self.fake.mjpeg_port:
                    ports[9100] = ("127.0.0.1", self.fake.mjpeg_port)
                self.mux.add_device(UDID, ports=ports)
            self.root = short_tmpdir()
            self.home = os.path.join(self.root, "home")
            os.mkdir(self.home)
            self.state_dir = state_dir or os.path.join(self.root, "state")
            if config is not None:
                os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
                privstate.write_json_private(os.path.join(self.state_dir, "config.json"), config)
            self.env = test_env(self.home, self.mux, env)
            self.url = self.fake.url if url == "fake" else url
            self.sips_path = write_fake_executable(os.path.join(self.root, "bin"), "sips", "exit 1\n")
            self.runner = FakeRunner()
            self.runner.on("sips", effect=jpeg_out_effect())
            self.runtime = self.make_runtime(serve_preview=serve_preview)
        except BaseException:
            self.close()
            raise

    def make_runtime(self, serve_preview=True, url="same", runner=None):
        """Another Runtime on the same state dir (like a second Claude Code window)."""
        runtime = Runtime(state_dir=self.state_dir, wda_url=self.url if url == "same" else url, env=dict(self.env),
                          runner=runner or self.runner, serve_preview=serve_preview)
        runtime.phone.sips_path = self.sips_path
        self.runtimes.append(runtime)
        return runtime

    def execute(self, name, args=None):
        return self.runtime.execute(name, {} if args is None else args)

    def content(self, name, args=None):
        return iphone_use.result_content(self.execute(name, args))

    def routes(self):
        return self.fake.routes()

    def close(self):
        for runtime in self.runtimes:
            try:
                runtime.close()
            except Exception:  # noqa: BLE001
                pass
        self.runtimes = []
        if self.mux is not None:
            self.mux.stop()
            self.mux = None
        if self._owns_fake and self.fake is not None:
            self.fake.stop()
        if self.root is not None:
            shutil.rmtree(self.root, ignore_errors=True)
            self.root = None

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class HarnessTestCase(unittest.TestCase):
    harness_options = {}

    def setUp(self):
        self.h = self.harness(**self.harness_options)
        self.runtime = self.h.runtime
        self.fake = self.h.fake

    def harness(self, **options):
        harness = RuntimeHarness(**options)
        self.addCleanup(harness.close)
        return harness

    def assert_error(self, envelope, code):
        self.assertIs(envelope["ok"], False, envelope)
        self.assertEqual(envelope["error"]["code"], code, envelope)
        return envelope["error"]


class LockHolder:
    """A child process that holds operation.lock until stopped."""

    CODE = ("import fcntl, os, sys\n"
            "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)\n"
            "fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "sys.stdout.write('locked\\n'); sys.stdout.flush()\n"
            "sys.stdin.read()\n")

    def __init__(self, path):
        self.process = subprocess.Popen([sys.executable, "-c", self.CODE, str(path)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        line = self.process.stdout.readline()
        if line.strip() != b"locked":
            self.stop()
            raise AssertionError("lock holder did not start")

    def stop(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(5)
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()


# --- the operation lock -------------------------------------------------------------------------------


class OperationLockTests(HarnessTestCase):
    def test_lock_held_by_another_process_gives_device_busy_with_zero_device_calls(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.fake.clear_log()
        for name, args in (("iphone_observe", {}), ("iphone_tap", {"x": 10, "y": 10}), ("iphone_ready", {}),
                           ("iphone_batch", {"steps": [{"op": "observe", "args": {}}]})):
            with self.subTest(tool=name):
                error = self.assert_error(self.h.execute(name, args), "device_busy")
                self.assertFalse(error["action_executed"])
                self.assertIn("nothing was done", error["message"])
        self.assertEqual(self.fake.requests, [])

    def test_non_phone_tools_work_while_the_lock_is_held(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.assertTrue(self.h.execute("iphone_doctor")["ok"])
        status = self.h.execute("iphone_setup", {"action": "status"})
        self.assertTrue(status["ok"], status)
        self.assertIsInstance(status["jobs"], list)
        apps = self.h.execute("iphone_apps", {"query": "Settings", "source": "catalog"})
        self.assertTrue(apps["ok"], apps)
        self.assertEqual(apps["candidates"][0]["bundle_id"], "com.apple.Preferences")
        self.assertTrue(self.h.execute("iphone_screen", {"action": "status"})["ok"])
        self.assertTrue(self.h.execute("iphone_metrics")["ok"])
        self.assertNotIn("GET /source", self.h.routes())

    def test_lock_is_released_after_every_call_and_file_is_private(self):
        self.assertTrue(self.h.execute("iphone_observe")["ok"])
        self.assert_error(self.h.execute("iphone_tap", {"selector": {"label": "Nope"}}), "no_such_element")
        path = os.path.join(self.h.state_dir, "operation.lock")
        with privstate.FileLock(path, blocking=False):
            pass
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)


# --- the shared session -------------------------------------------------------------------------------


class SessionCacheTests(HarnessTestCase):
    def session_file(self):
        return os.path.join(self.h.state_dir, "session.json")

    def test_session_is_shared_between_runtimes_without_a_second_session(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        saved = privstate.read_json(self.session_file())
        self.assertEqual(saved, {"transport": self.runtime.transport.identity,
                                 "session_id": self.fake.active_sid})
        self.assertEqual(saved["transport"], "tcp:127.0.0.1:%d" % self.fake.port)
        self.assertEqual(stat.S_IMODE(os.stat(self.session_file()).st_mode), 0o600)
        other = self.h.make_runtime(serve_preview=False)
        self.fake.clear_log()
        result = other.execute("iphone_observe", {})
        self.assertTrue(result["ok"], result)
        self.assertNotIn("POST /session", self.h.routes())
        self.assertEqual(other.client.session_id, saved["session_id"])

    def test_session_for_another_transport_or_bad_sid_is_not_adopted(self):
        for saved in ({"transport": "usbmux:%s:8100" % UDID, "session_id": "ABC-123"},
                      {"transport": "tcp:127.0.0.1:%d" % self.fake.port, "session_id": "bad id!"},
                      {"transport": "tcp:127.0.0.1:%d" % self.fake.port}, ["not", "a", "dict"]):
            with self.subTest(saved=saved):
                privstate.write_json_private(self.session_file(), saved)
                runtime = self.h.make_runtime(serve_preview=False)
                self.fake.clear_log()
                self.assertTrue(runtime.execute("iphone_observe", {})["ok"])
                self.assertIn("POST /session", self.h.routes())
                self.assertEqual(privstate.read_json(self.session_file())["session_id"], runtime.client.session_id)

    def test_session_file_removed_when_the_client_has_no_session(self):
        privstate.write_json_private(self.session_file(), {"transport": "usbmux:x:1", "session_id": "S"})
        self.fake.locked = True
        self.assert_error(self.h.execute("iphone_tap", {"x": 5, "y": 5}), "phone_locked")
        self.assertFalse(os.path.exists(self.session_file()))

    def test_session_replaced_by_another_process_resets_local_observations(self):
        self.assertTrue(self.h.execute("iphone_observe")["ok"])
        self.assertTrue(self.runtime.phone.snapshots)
        privstate.write_json_private(self.session_file(), {"transport": self.runtime.transport.identity,
                                                            "session_id": "OTHER-SESSION"})
        self.runtime._adopt_session()
        self.assertEqual(self.runtime.client.session_id, "OTHER-SESSION")
        self.assertEqual(dict(self.runtime.phone.snapshots), {})


# --- mutations: lock check, privacy pauses, channel faults ---------------------------------------------


class MutationGuardTests(HarnessTestCase):
    def test_locked_phone_blocks_mutations_with_exactly_one_lock_read(self):
        self.fake.locked = True
        self.fake.clear_log()
        error = self.assert_error(self.h.execute("iphone_tap", {"selector": {"label": "General"}}), "phone_locked")
        self.assertFalse(error["action_executed"])
        self.assertEqual(self.h.routes(), ["GET /wda/locked"])
        self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": "device_locked"})

    def test_every_mutating_tool_checks_the_lock_and_reads_do_not(self):
        self.fake.locked = True
        cases = (("iphone_swipe", {}), ("iphone_type_text", {"text": "hi"}), ("iphone_press_button", {"name": "home"}),
                 ("iphone_launch_app", {"bundle_id": "com.apple.Preferences"}),
                 ("iphone_scroll_find", {"selector": {"label": "General"}}), ("iphone_collect_list", {}),
                 ("iphone_batch", {"steps": [{"op": "tap", "args": {"x": 1, "y": 1}}]}))
        for name, args in cases:
            with self.subTest(tool=name):
                self.fake.clear_log()
                self.assert_error(self.h.execute(name, args), "phone_locked")
                self.assertEqual(self.h.routes(), ["GET /wda/locked"])
        for name, args in (("iphone_observe", {}), ("iphone_find", {"selector": {"label": "General"}}),
                           ("iphone_wait", {"selector": {"label": "General"}, "timeout_seconds": 0})):
            with self.subTest(tool=name):
                self.fake.clear_log()
                self.assertTrue(self.h.execute(name, args)["ok"])
                self.assertNotIn("GET /wda/locked", self.h.routes())

    def test_batch_checks_the_lock_once(self):
        self.fake.clear_log()
        result = self.h.execute("iphone_batch", {"steps": [{"op": "tap", "args": {"x": 20, "y": 20}},
                                                           {"op": "tap", "args": {"x": 30, "y": 30}}]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.h.routes().count("GET /wda/locked"), 1)
        self.assertEqual(len(self.fake.taps), 2)

    def test_secure_field_pauses_preview_for_authentication_without_screenshot(self):
        self.fake.set_foreground("com.example.form")
        envelope = self.h.execute("iphone_type_text", {"selector": {"name": "password"}, "text": "secret"})
        error = self.assert_error(envelope, "not_editable")
        self.assertTrue(error["secure_field"])
        self.assertNotIn("observation", error)
        self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": "authentication"})
        self.assertNotIn("secret", json.dumps(envelope))
        self.assertEqual(self.fake.typed, [])
        self.assertNotIn("GET /screenshot", self.h.routes())
        content = iphone_use.result_content(envelope)
        self.assertTrue(content["isError"])
        self.assertEqual(len(content["content"]), 1)

    def test_batch_step_typing_into_a_password_field_pauses_the_preview(self):
        self.fake.set_foreground("com.example.form")
        envelope = self.h.execute("iphone_batch", {"steps": [
            {"op": "wait", "args": {"selector": {"name": "email"}, "timeout_seconds": 0}},
            {"op": "type_text", "args": {"selector": {"name": "password"}, "text": "secret"}}]})
        error = self.assert_error(envelope, "not_editable")
        self.assertTrue(error["secure_field"])
        self.assertEqual(envelope["stopped_at"], 1)
        self.assertEqual(envelope["completed_steps"], 1)
        self.assertFalse(envelope["complete"])
        self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": "authentication"})
        content = iphone_use.result_content(envelope)
        self.assertEqual([block["type"] for block in content["content"]], ["text"])
        self.assertTrue(content["isError"])
        self.assertEqual(self.fake.typed, [])

    def test_batch_step_channel_fault_points_to_ready(self):
        self.fake.foreground_sequence = ["local.pid.0"]
        envelope = self.h.execute("iphone_batch", {"steps": [{"op": "observe", "args": {"mode": "screenshot"}}]})
        error = self.assert_error(envelope, "foreground_unavailable")
        self.assertEqual(error["category"], "channel_runtime")
        self.assertEqual(error["recovery"]["next_tool"], "iphone_ready")
        self.assertFalse(error["recovery"]["replay_action"])

    def test_read_channel_fault_points_to_ready_without_restart(self):
        self.fake.foreground_sequence = ["local.pid.0"]
        error = self.assert_error(self.h.execute("iphone_observe", {"mode": "screenshot"}), "foreground_unavailable")
        self.assertFalse(error["action_executed"])
        self.assertEqual(error["category"], "channel_runtime")
        self.assertEqual(error["recovery"], {"next_tool": "iphone_ready", "next_arguments": {},
                                             "replay_action": False, "next_step": runtime_module.CHANNEL_STEP})

    def test_xctest_authorization_fault_after_an_accepted_tap_keeps_evidence(self):
        self.fake.inject("GET", "/source", error="unknown error",
                         message="Error Domain=XCTDaemonErrorDomain Code=41 Not authorized for performing UI "
                                 "testing actions", times=None)
        error = self.assert_error(self.h.execute("iphone_tap", {"x": 40, "y": 40, "observe": "tree"}),
                                  "unknown error")
        self.assertEqual(error["category"], "channel_runtime")
        self.assertTrue(error["action_executed"])
        self.assertFalse(error["action_complete"])
        self.assertIn("verification_required", error)
        self.assertEqual(len(self.fake.taps), 1)

    def test_generic_stale_element_is_not_a_channel_fault(self):
        self.fake.inject("GET", "/source", error="stale element reference",
                         message="Previously found element Button 'Continue' is not present", times=None)
        error = self.assert_error(self.h.execute("iphone_observe"), "stale element reference")
        self.assertNotIn("category", error)
        self.assertFalse(error["action_executed"])

    def test_non_secure_not_editable_target_does_not_pause(self):
        self.fake.set_foreground("com.example.form")
        self.assert_error(self.h.execute("iphone_type_text", {"selector": {"label": "Send"}, "text": "x"}),
                          "not_editable")
        self.assertFalse(self.runtime.screen.paused())

    def test_preview_telemetry_failures_never_change_an_action(self):
        broken = mock.Mock(side_effect=RuntimeError("preview broken"))
        for method in ("begin", "end", "gesture", "set_viewport", "set_paused"):
            setattr(self.runtime.screen, method, broken)
        result = self.h.execute("iphone_tap", {"x": 50, "y": 60})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.fake.taps, [(50, 60)])
        self.fake.locked = True
        self.assert_error(self.h.execute("iphone_tap", {"x": 50, "y": 60}), "phone_locked")


class ChannelFaultTests(unittest.TestCase):
    def test_classification(self):
        fault = Runtime.channel_fault
        cases = (
            (ToolError("unknown error", "Error Domain=XCTDaemonErrorDomain Code=41 Not authorized"),
             "xctest_authorization"),
            (ToolError("unknown error", "The app is not authorized for performing UI testing actions."),
             "xctest_authorization"),
            (ToolError("foreground_unavailable", "x"), "foreground_unavailable"),
            (ToolError("stale element reference", "Application local.pid.12 is not running"),
             "foreground_unavailable"),
            (ToolError("stale element reference", "Button is gone"), None),
            (ToolError("unknown error", "XCTDaemonErrorDomain code=40"), None),
            (ToolError("no_such_element", "No element matches"), None),
        )
        for error, expected in cases:
            with self.subTest(message=error.message):
                self.assertEqual(fault(error), expected)


# --- setup interplay ------------------------------------------------------------------------------------


class SetupInterplayTests(HarnessTestCase):
    def test_setup_stop_resets_the_session_and_observations(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        self.assertIsNotNone(self.runtime.client.session_id)
        self.assertTrue(self.runtime.phone.snapshots)
        result = self.h.execute("iphone_setup", {"action": "stop"})
        self.assertTrue(result["ok"], result)
        self.assertIsNone(self.runtime.client.session_id)
        self.assertEqual(dict(self.runtime.phone.snapshots), {})

    def test_successful_start_resets_the_session(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        original = self.runtime.setup.setup
        self.runtime.setup.setup = mock.Mock(return_value={"job_id": "c" * 32, "job": {}, "next_step": "poll"})
        result = self.h.execute("iphone_setup", {"action": "start"})
        self.assertEqual(result, {"ok": True, "job_id": "c" * 32, "job": {}, "next_step": "poll"})
        self.runtime.setup.setup.assert_called_once_with(action="start")
        self.assertIsNone(self.runtime.client.session_id)
        self.assertEqual(dict(self.runtime.phone.snapshots), {})
        self.runtime.setup.setup = original

    def test_setup_status_and_failed_start_keep_the_session(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        sid = self.runtime.client.session_id
        self.assertTrue(self.h.execute("iphone_setup", {"action": "status"})["ok"])
        self.assertFalse(self.h.execute("iphone_setup", {"action": "start"})["ok"])
        self.assertEqual(self.runtime.client.session_id, sid)

    def test_configure_with_a_new_device_switches_the_transport(self):
        h = self.harness(url=None, via_usbmux=True)
        runtime = h.runtime
        self.assertEqual(runtime.transport.identity, "none")
        old_client = runtime.client
        result = runtime.execute("iphone_setup", {"action": "configure", "udid": UDID, "team_id": "ABCDE12345",
                                                  "bundle_id": "com.example.wda.test"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(runtime.transport.identity, "usbmux:%s:8100" % UDID)
        self.assertIsNot(runtime.client, old_client)
        self.assertIs(runtime.phone.client, runtime.client)
        observed = runtime.execute("iphone_observe", {})
        self.assertTrue(observed["ok"], observed)
        self.assertEqual(observed["app"], "com.apple.Preferences")

    def test_setup_argument_errors_are_tool_errors(self):
        error = self.assert_error(self.h.execute("iphone_setup", {"action": "status", "udid": UDID}),
                                  "invalid_argument")
        self.assertFalse(error["action_executed"])


# --- envelopes ------------------------------------------------------------------------------------------


class EnvelopeTests(HarnessTestCase):
    def test_success_envelope_starts_with_ok(self):
        envelope = self.h.execute("iphone_observe")
        self.assertEqual(list(envelope)[0], "ok")
        self.assertIs(envelope["ok"], True)
        self.assertIn("observation_id", envelope)

    def test_unknown_tool_and_non_object_arguments(self):
        for name in ("iphone_nope", "observe", None, 3):
            with self.subTest(name=name):
                error = self.assert_error(self.runtime.execute(name, {}), "unknown_tool")
                self.assertFalse(error["action_executed"])
        error = self.assert_error(self.runtime.execute("iphone_observe", ["mode"]), "invalid_argument")
        self.assertEqual(error["argument_path"], "arguments")
        self.assertEqual(self.fake.requests, [])

    def test_invalid_arguments_never_reach_the_phone(self):
        cases = (("iphone_tap", {"x": True, "y": 1}), ("iphone_tap", {"x": 1}),
                 ("iphone_tap", {"selector": {"label": "A"}, "x": 1, "y": 2}),
                 ("iphone_type_text", {"text": "a\nb"}), ("iphone_find", {"selector": {"predicate": "a", "label": "b"}}),
                 ("iphone_apps", {"query": "Notes", "country": "IND"}), ("iphone_apps", {"query": ""}),
                 ("iphone_observe", {"mode": "all"}), ("iphone_observe", {"max_nodes": 1.0}),
                 ("iphone_batch", {"steps": [{"op": "tap", "args": {"x": 1, "y": 1}},
                                             {"op": "launch_app", "args": {"bundle_id": "not a bundle"}}]}),
                 ("iphone_batch", {"steps": [{"op": "tap", "args": {"x": 1, "y": 1}},
                                             {"op": "tap", "args": {"selector": {"label": "A", "predicate": "x"}}}]}),
                 ("iphone_batch", {"steps": [{"op": "doctor", "args": {}}]}))
        for name, args in cases:
            with self.subTest(tool=name, args=args):
                envelope = self.h.execute(name, args)
                self.assertIs(envelope["ok"], False)
                self.assertIn(envelope["error"]["code"], ("invalid_argument", "invalid_selector",
                                                          "newline_requires_intent"))
                self.assertFalse(envelope["error"]["action_executed"])
                self.assertTrue(iphone_use.result_content(envelope)["isError"])
        self.assertEqual(self.fake.requests, [])

    def test_unknown_field_reports_allowed_fields(self):
        error = self.assert_error(self.h.execute("iphone_tap", {"x": 1, "y": 1, "max_attempts": 2}),
                                  "invalid_argument")
        self.assertEqual(error["unknown_fields"], ["max_attempts"])
        self.assertIn("observation_id", error["allowed_fields"])
        self.assertEqual(error["argument_path"], "arguments")
        nested = self.assert_error(self.h.execute("iphone_batch", {"steps": [
            {"op": "tap", "args": {"x": 1, "y": 1}}, {"op": "swipe", "args": {"max_attempts": 2}}]}),
            "invalid_argument")
        self.assertEqual(nested["argument_path"], "arguments.steps[1].args")
        self.assertEqual(self.fake.requests, [])

    def test_unexpected_exception_becomes_internal_error_with_one_stderr_line(self):
        self.runtime.phone.find = mock.Mock(side_effect=RuntimeError("boom with secret text"))
        buffer = io.StringIO()
        with mock.patch("sys.stderr", buffer):
            envelope = self.h.execute("iphone_find", {"selector": {"label": "General"}})
        error = self.assert_error(envelope, "internal_error")
        self.assertTrue(error["uncertain"])
        self.assertEqual(buffer.getvalue(), "iphone-use tool failure: RuntimeError\n")
        self.assertNotIn("secret", json.dumps(envelope))

    def test_handler_value_error_is_invalid_argument(self):
        self.runtime.phone.find = mock.Mock(side_effect=ValueError("The selector could not be used."))
        error = self.assert_error(self.h.execute("iphone_find", {"selector": {"label": "General"}}),
                                  "invalid_argument")
        self.assertFalse(error["action_executed"])
        self.assertEqual(error["message"], "The selector could not be used.")

    def test_batch_error_envelope_keeps_progress_and_screenshot(self):
        envelope = self.h.execute("iphone_batch", {"steps": [
            {"op": "tap", "args": {"x": 20, "y": 20}}, {"op": "tap", "args": {"selector": {"label": "Missing"}}}]})
        error = self.assert_error(envelope, "no_such_element")
        self.assertFalse(envelope["complete"])
        self.assertEqual(envelope["completed_steps"], 1)
        self.assertEqual(envelope["stopped_at"], 1)
        self.assertEqual(envelope["resume_at"], 1)
        self.assertEqual(envelope["stop_reason"], "no_such_element")
        self.assertEqual(len(envelope["results"]), 1)
        self.assertIn("image", error["observation"])
        content = iphone_use.result_content(envelope)
        self.assertFalse(content["isError"])
        self.assertEqual([block["type"] for block in content["content"]], ["text", "image"])

    def test_finished_batch_is_ok(self):
        envelope = self.h.execute("iphone_batch", {"steps": [{"op": "observe", "args": {}}]})
        self.assertIs(envelope["ok"], True)
        self.assertTrue(envelope["complete"])
        self.assertIsNone(envelope["stop_reason"])

    def test_explicit_invalid_url_fails_closed_before_any_io(self):
        h = self.harness(url="http://192.168.1.20:8100")
        self.assertEqual(h.runtime.transport.kind, "none")
        self.assertEqual(h.runtime.env["IPHONE_USE_WDA_URL"], "http://192.168.1.20:8100")
        for name, args in (("iphone_ready", {}), ("iphone_tap", {"x": 1, "y": 1}), ("iphone_observe", {})):
            with self.subTest(tool=name):
                error = self.assert_error(h.execute(name, args), "config_invalid")
                self.assertFalse(error["action_executed"])
        status = h.execute("iphone_setup", {"action": "status"})
        self.assertTrue(status["ok"], status)
        self.assertFalse(status["service"]["reachable"])
        self.assertEqual(h.fake.requests, [])

    def test_bad_configured_url_is_reported_by_ready(self):
        h = self.harness(url=None, config={"format": 1, "wda_url": "http://example.com:8100"})
        error = self.assert_error(h.execute("iphone_ready"), "config_invalid")
        self.assertEqual(error["field"], "wda_url")
        self.assertTrue(h.execute("iphone_doctor")["ok"])
        self.assertEqual(h.fake.requests, [])

    def test_apps_work_with_the_service_unreachable_and_the_phone_locked(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        h = self.harness(url="http://127.0.0.1:%d" % port)
        result = h.execute("iphone_apps", {"query": "WhatsApp", "source": "catalog"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["candidates"][0]["bundle_id"], "net.whatsapp.WhatsApp")
        self.fake.locked = True
        self.assertTrue(self.h.execute("iphone_apps", {"query": "Notes", "source": "catalog"})["ok"])

    def test_unconfigured_runtime_reports_service_unreachable_for_phone_tools(self):
        h = self.harness(url=None)
        error = self.assert_error(h.execute("iphone_observe"), "service_unreachable")
        self.assertEqual(error["reason"], "not_configured")
        self.assertFalse(error["action_executed"])


# --- result -> MCP content --------------------------------------------------------------------------------


class ResultContentTests(unittest.TestCase):
    def setUp(self):
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)

    def image(self, name, data=None, mime=None):
        path = os.path.join(self.root, name)
        with open(path, "wb") as handle:
            handle.write(data if data is not None else solid_png(4, 8))
        image = {"path": path, "width": 4, "height": 8, "pixel_to_point": [1.0, 1.0]}
        if mime:
            image["mimeType"] = mime
        return image

    def test_shape_text_and_image_blocks(self):
        image = self.image("a.jpg", b"\xff\xd8jpegdata", "image/jpeg")
        content = iphone_use.result_content({"ok": True, "image": image, "note": "x"})
        self.assertEqual(set(content), {"content", "isError"})
        self.assertFalse(content["isError"])
        text, block = content["content"]
        self.assertEqual(text["type"], "text")
        parsed = json.loads(text["text"])
        self.assertEqual(text["text"], json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
        self.assertNotIn('": ', text["text"])
        self.assertEqual(block, {"type": "image", "data": base64.b64encode(b"\xff\xd8jpegdata").decode("ascii"),
                                 "mimeType": "image/jpeg"})
        self.assertNotIn(block["data"], text["text"])

    def test_image_lookup_order_first_match_wins(self):
        names = ["top", "observation", "error", "result", "result_observation"]
        images = {name: self.image(name + ".png", name.encode() + b"\x89PNG") for name in names}

        def envelope(*present):
            value = {"ok": False}
            if "top" in present:
                value["image"] = images["top"]
            if "observation" in present:
                value["observation"] = {"image": images["observation"]}
            if "error" in present:
                value["error"] = {"code": "x", "observation": {"image": images["error"]}}
            last = {}
            if "result" in present:
                last["image"] = images["result"]
            if "result_observation" in present:
                last["observation"] = {"image": images["result_observation"]}
            if last:
                value["results"] = [{"image": self.image("first.png")}, last]
            return value

        for index, name in enumerate(names):
            with self.subTest(winner=name):
                content = iphone_use.result_content(envelope(*names[index:]))
                data = base64.b64decode(content["content"][1]["data"])
                self.assertTrue(data.startswith(name.encode() + b"\x89PNG"))
                self.assertEqual(content["content"][1]["mimeType"], "image/png")
                self.assertFalse(content["isError"])

    def test_is_error_only_for_failures_without_an_image(self):
        missing = {"path": os.path.join(self.root, "missing.png")}
        self.assertTrue(iphone_use.result_content({"ok": False, "error": {"code": "x"}})["isError"])
        failed = iphone_use.result_content({"ok": False, "error": {"code": "x", "observation": {"image": missing}}})
        self.assertTrue(failed["isError"])
        self.assertEqual(len(failed["content"]), 1)
        self.assertFalse(iphone_use.result_content({"ok": True, "ready": False})["isError"])
        with_image = iphone_use.result_content({"ok": False, "error": {"code": "x", "observation": {
            "image": self.image("e.png")}}})
        self.assertFalse(with_image["isError"])

    def test_fit_text_halves_the_longest_lists(self):
        nodes = [{"type": "Cell", "label": "Row %04d with some padding text" % i, "rect": [1, 2, 3, 4]}
                 for i in range(3000)]
        envelope = {"ok": True, "observation": {"nodes": nodes}, "rows": nodes[:10],
                    "error": {"candidates": nodes[:5]}}
        content = iphone_use.result_content(envelope)
        text = content["content"][0]["text"]
        self.assertLessEqual(len(text), iphone_use.TEXT_LIMIT)
        parsed = json.loads(text)
        self.assertTrue(parsed["size_truncated"])
        self.assertLess(len(parsed["observation"]["nodes"]), 3000)
        self.assertEqual(parsed["observation"]["nodes"][0], nodes[0])
        self.assertEqual(len(parsed["rows"]), 10)
        self.assertEqual(len(envelope["observation"]["nodes"]), 3000, "the original envelope is not modified")

    def test_fit_text_shortens_batch_observations_and_error_candidates(self):
        nodes = [{"type": "Cell", "label": "x" * 40, "rect": [0, 0, 1, 1]} for _ in range(2000)]
        envelope = {"ok": False, "results": [{"observation": {"nodes": nodes}}],
                    "error": {"code": "ambiguous_target", "candidates": list(nodes)}}
        fitted, text = iphone_use.fit_text(envelope)
        self.assertLessEqual(len(text), iphone_use.TEXT_LIMIT)
        self.assertTrue(fitted["size_truncated"])
        self.assertLess(len(fitted["results"][0]["observation"]["nodes"]) + len(fitted["error"]["candidates"]),
                        4000)

    def test_too_large_without_lists_becomes_response_too_large_keeping_evidence(self):
        envelope = {"ok": True, "action_executed": True, "action_complete": False,
                    "verification_required": "Look first.", "blob": "x" * 60000}
        content = iphone_use.result_content(envelope)
        parsed = json.loads(content["content"][0]["text"])
        self.assertEqual(parsed["ok"], False)
        self.assertEqual(parsed["error"]["code"], "response_too_large")
        self.assertTrue(parsed["error"]["action_executed"])
        self.assertFalse(parsed["error"]["action_complete"])
        self.assertTrue(content["isError"])

    def test_small_results_are_unchanged(self):
        fitted, text = iphone_use.fit_text({"ok": True, "nodes": [1, 2, 3]})
        self.assertEqual(fitted, {"ok": True, "nodes": [1, 2, 3]})
        self.assertEqual(text, '{"ok":true,"nodes":[1,2,3]}')


# --- metrics and knobs -------------------------------------------------------------------------------------


class MetricsTests(HarnessTestCase):
    def test_metrics_shape_contains_no_content_and_reset_starts_a_new_window(self):
        self.assertTrue(self.h.execute("iphone_observe")["ok"])
        self.h.execute("iphone_tap", {"selector": {"label": "Missing"}})
        self.runtime.note_response("iphone_observe", 120, 0)
        result = self.h.execute("iphone_metrics", {"reset": True})
        self.assertTrue(result["ok"])
        self.assertEqual(set(result), {"ok", "http", "tools", "responses"})
        self.assertEqual(set(result["http"]), {"requests", "http_seconds", "http_bytes", "errors", "endpoints"})
        self.assertGreater(result["http"]["requests"], 0)
        self.assertEqual(result["tools"]["count"], 2)
        self.assertEqual(result["tools"]["errors"], 1)
        self.assertEqual(set(result["tools"]["by_tool"]), {"iphone_observe", "iphone_tap"})
        self.assertEqual(set(result["tools"]["by_tool"]["iphone_tap"]), {"count", "seconds", "errors"})
        self.assertEqual(result["responses"], {"count": 1, "text_bytes": 120, "image_bytes": 0})
        dumped = json.dumps(result)
        for secret in ("Settings", "com.apple.Preferences", "Missing", self.fake.active_sid):
            self.assertNotIn(secret, dumped)
        after = self.h.execute("iphone_metrics")
        self.assertEqual(after["tools"]["count"], 1, "the reset call itself opens the new window")
        self.assertEqual(after["tools"]["by_tool"], {"iphone_metrics": after["tools"]["by_tool"]["iphone_metrics"]})
        self.assertEqual(after["http"]["requests"], 0)
        self.assertEqual(after["responses"]["count"], 0)


class KnobTests(unittest.TestCase):
    def runtime_with(self, extra):
        mux = FakeUsbmuxd().start()
        self.addCleanup(mux.stop)
        root = short_tmpdir()
        self.addCleanup(shutil.rmtree, root, True)
        env = test_env(root, mux, extra)
        runtime = Runtime(state_dir=os.path.join(root, "state"), env=env, runner=FakeRunner(), serve_preview=False)
        self.addCleanup(runtime.close)
        return runtime

    def test_environment_knobs_are_applied(self):
        runtime = self.runtime_with({"IPHONE_USE_SETTLE_SECONDS": "1.5", "IPHONE_USE_CALL_BUDGET_SECONDS": "30",
                                     "IPHONE_USE_TYPING_FREQUENCY": "60", "IPHONE_USE_KEEP_SCREENSHOTS": "10",
                                     "IPHONE_USE_JPEG_QUALITY": "60", "IPHONE_USE_IMAGE": "original"})
        phone = runtime.phone
        self.assertEqual((phone.settle_seconds, phone.call_budget, phone.typing_frequency, phone.keep_artifacts,
                          phone.jpeg_quality, phone.image_original), (1.5, 30.0, 60, 10, 60, True))

    def test_invalid_knobs_keep_the_defaults(self):
        for value in ("nan", "inf", "-1", "abc", "1e9", ""):
            with self.subTest(value=value):
                env = {name: value for name in runtime_module.KNOBS}
                env["IPHONE_USE_SETTLE_SECONDS"] = "3" if value == "" else value
                phone = self.runtime_with(env).phone
                self.assertEqual((phone.settle_seconds, phone.call_budget, phone.typing_frequency,
                                  phone.keep_artifacts, phone.jpeg_quality, phone.image_original),
                                 (0.8, 60.0, 30, 40, 80, False))
        phone = self.runtime_with({"IPHONE_USE_TYPING_FREQUENCY": "30.5", "IPHONE_USE_CALL_BUDGET_SECONDS": "91",
                                   "IPHONE_USE_SETTLE_SECONDS": "0"}).phone
        self.assertEqual((phone.typing_frequency, phone.call_budget, phone.settle_seconds), (30, 60.0, 0.0))

    def test_preview_port_parsing(self):
        for value, expected in (("0", 0), ("18300", 18300), ("1023", 18200), ("70000", 18200), ("x", 18200),
                                (None, 18200)):
            with self.subTest(value=value):
                env = {} if value is None else {"IPHONE_USE_PREVIEW_PORT": value}
                self.assertEqual(runtime_module.preview_port(env), expected)


# --- construction and shutdown -------------------------------------------------------------------------------


class LifecycleTests(unittest.TestCase):
    def test_state_dir_inside_git_is_refused(self):
        root = short_tmpdir()
        self.addCleanup(shutil.rmtree, root, True)
        os.mkdir(os.path.join(root, ".git"))
        mux = FakeUsbmuxd().start()
        self.addCleanup(mux.stop)
        with self.assertRaises(ToolError) as caught:
            Runtime(state_dir=os.path.join(root, "state"), env=test_env(root, mux), runner=FakeRunner())
        self.assertEqual(caught.exception.code, "state_dir_unsafe")

    def test_state_dir_is_private(self):
        with RuntimeHarness() as h:
            self.assertEqual(stat.S_IMODE(os.stat(h.state_dir).st_mode), 0o700)
            self.assertEqual(str(h.runtime.state_dir), os.path.realpath(h.state_dir))

    def test_close_stops_the_preview_and_the_connection(self):
        with RuntimeHarness() as h:
            self.assertTrue(h.execute("iphone_ready")["ok"])
            preview = os.path.join(h.state_dir, "preview.json")
            self.assertTrue(os.path.exists(preview))
            h.runtime.close()
            self.assertFalse(os.path.exists(preview))
            self.assertIsNone(h.runtime.preview.current())
            self.assertIsNone(h.runtime.client._connection)
            h.runtime.close()  # idempotent


if __name__ == "__main__":
    unittest.main()
