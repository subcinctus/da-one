import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import base64  # noqa: E402
import glob  # noqa: E402
import http.client  # noqa: E402
import json  # noqa: E402
import stat  # noqa: E402
import unittest  # noqa: E402
from urllib.parse import urlsplit  # noqa: E402

import privstate  # noqa: E402
from cmdrunner import CommandResult  # noqa: E402
from screen_hub import ScreenHub  # noqa: E402
from test_runtime import LockHolder, RuntimeHarness, refused_port  # noqa: E402
from wda_image import solid_png  # noqa: E402


class ToolbarCase(unittest.TestCase):
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

    def other_hub(self):
        hub = ScreenHub(self.h.state_dir)
        self.addCleanup(hub.close)
        return hub


class RefreshTests(ToolbarCase):
    def test_refresh_probes_status_and_lock_on_a_separate_connection(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        sid = self.runtime.client.session_id
        connection = self.runtime.client._connection
        stream = self.runtime.screen.stream_id
        self.fake.clear_log()
        result = self.runtime.toolbar_action("refresh")
        self.assertEqual(result, {"ok": True, "action": "refresh", "service_ready": True, "paused": False,
                                  "pause_reason": None})
        self.assertEqual(self.h.routes(), ["GET /status", "GET /wda/locked"])
        self.assertTrue(all(request.sid is None for request in self.fake.requests))
        self.assertEqual(self.runtime.client.session_id, sid)
        self.assertIs(self.runtime.client._connection, connection)
        self.assertNotEqual(self.runtime.screen.stream_id, stream)
        self.assertEqual(self.fake.actions(), [])

    def test_refresh_is_the_users_explicit_resume(self):
        other = self.other_hub()
        for reason in ("authentication", "device_locked"):
            with self.subTest(reason=reason):
                other.set_paused(True, reason)
                result = self.runtime.toolbar_action("refresh")
                self.assertEqual((result["paused"], result["pause_reason"]), (False, None))
                self.assertFalse(other.paused())

    def test_refresh_on_a_locked_phone_pauses_for_the_lock(self):
        self.fake.locked = True
        result = self.runtime.toolbar_action("refresh")
        self.assertEqual(result, {"ok": True, "action": "refresh", "service_ready": True, "paused": True,
                                  "pause_reason": "device_locked"})

    def test_refresh_with_the_service_down_keeps_the_pause(self):
        self.runtime.screen.set_paused(True, "authentication")
        self.fake.status_ready = False
        self.fake.clear_log()
        result = self.runtime.toolbar_action("refresh")
        self.assertFalse(result["service_ready"])
        self.assertEqual((result["paused"], result["pause_reason"]), (True, "authentication"))
        self.assertEqual(self.h.routes(), ["GET /status"])

    def test_refresh_reports_an_unreachable_service(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        h = self.harness(url="http://127.0.0.1:%d" % port)
        result = h.runtime.toolbar_action("refresh")
        self.assertEqual(result, {"ok": True, "action": "refresh", "service_ready": False, "paused": False,
                                  "pause_reason": None})

    def test_refresh_probe_error_on_the_lock_read_keeps_the_pause(self):
        self.runtime.screen.set_paused(True, "device_locked")
        self.fake.inject("GET", "/wda/locked", error="unknown error", message="lock state unavailable")
        result = self.runtime.toolbar_action("refresh")
        self.assertFalse(result["service_ready"])
        self.assertTrue(result["paused"])

    def test_refresh_works_while_a_phone_step_holds_the_lock(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.assertTrue(self.runtime.toolbar_action("refresh")["service_ready"])


class HomeTests(ToolbarCase):
    def test_home_is_one_sessionless_request_under_the_operation_lock(self):
        self.assertTrue(self.h.execute("iphone_ready")["ok"])
        self.fake.set_foreground("com.apple.Preferences")
        before = self.runtime.phone.accepted_actions
        self.runtime.phone.pending_input = {"token": "abc"}
        seq = self.runtime.screen.external_seq()
        sid = self.runtime.client.session_id
        lock_path = os.path.join(self.h.state_dir, "operation.lock")
        self.fake.clear_log()
        result = self.runtime.toolbar_action("home")
        self.assertEqual(result, {"ok": True, "action": "home"})
        self.assertEqual(self.h.routes(), ["POST /wda/homescreen"])
        self.assertIsNone(self.fake.requests[0].sid)
        self.assertEqual(self.fake.foreground, "com.apple.springboard")
        self.assertEqual(self.runtime.phone.accepted_actions, before + 1)
        self.assertIsNone(self.runtime.phone.pending_input)
        self.assertEqual(self.runtime.screen.external_seq(), seq + 1)
        self.assertEqual(self.runtime.client.session_id, sid)
        with privstate.FileLock(lock_path, blocking=False):
            pass  # released again

    def test_home_holds_the_lock_while_it_sends(self):
        lock_path = os.path.join(self.h.state_dir, "operation.lock")
        held = []
        original = self.runtime.phone.external_action

        def external_action():
            try:
                privstate.FileLock(lock_path, blocking=False).acquire().release()
                held.append(False)
            except BlockingIOError:
                held.append(True)
            original()

        self.runtime.phone.external_action = external_action
        self.assertTrue(self.runtime.toolbar_action("home")["ok"])
        self.assertEqual(held, [True])

    def test_home_while_another_step_runs_is_device_busy_with_zero_calls(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.fake.clear_log()
        error = self.assert_error(self.runtime.toolbar_action("home"), "device_busy")
        self.assertFalse(error["action_executed"])
        self.assertIn("nothing was sent", error["message"])
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.runtime.phone.accepted_actions, 0)

    def test_uncertain_home_still_invalidates_local_state(self):
        self.fake.inject("POST", "/wda/homescreen", drop=True, execute=True)
        self.runtime.phone.pending_input = {"token": "abc"}
        error = self.assert_error(self.runtime.toolbar_action("home"), "action_uncertain")
        self.assertTrue(error["uncertain"])
        self.assertIsNone(self.runtime.phone.pending_input)
        self.assertEqual(self.runtime.screen.external_seq(), 1)
        self.assertEqual(len(self.fake.calls("/wda/homescreen")), 1)

    def test_home_and_screenshot_are_refused_while_paused(self):
        self.runtime.screen.set_paused(True, "authentication")
        self.fake.clear_log()
        for action in ("home", "screenshot"):
            with self.subTest(action=action):
                error = self.assert_error(self.runtime.toolbar_action(action), "preview_paused")
                self.assertFalse(error["action_executed"])
                self.assertFalse(error["uncertain"])
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.h.runner.calls_for("osascript"), [])

    def test_unknown_action_is_invalid_argument(self):
        for action in ("reboot", "", None, 3):
            with self.subTest(action=action):
                error = self.assert_error(self.runtime.toolbar_action(action), "invalid_argument")
                self.assertFalse(error["action_executed"])
        self.assertEqual(self.fake.requests, [])


class ScreenshotTests(ToolbarCase):
    def clipboard_files(self):
        return glob.glob(os.path.join(self.h.state_dir, ".clipboard-*"))

    def test_screenshot_copies_the_native_png_and_leaves_no_file(self):
        png = solid_png(30, 60)
        self.fake.screenshot_png = png
        observed = {}

        def osascript(argv, cwd, env, input_text):
            path = argv[-1]
            with open(path, "rb") as handle:
                observed["data"] = handle.read()
            observed["mode"] = stat.S_IMODE(os.stat(path).st_mode)
            observed["path"] = path
            return CommandResult(0, "", "")

        self.h.runner.on("osascript", effect=osascript)
        self.fake.clear_log()
        result = self.runtime.toolbar_action("screenshot")
        self.assertEqual(result, {"ok": True, "action": "screenshot", "copied": True, "width": 30, "height": 60})
        self.assertEqual(self.h.routes(), ["GET /screenshot"])
        self.assertIsNone(self.fake.requests[0].sid)
        self.assertEqual(observed["data"], png)
        self.assertEqual(observed["mode"], 0o600)
        call = self.h.runner.calls_for("osascript")[0]
        self.assertEqual(call.argv[0], "/usr/bin/osascript")
        self.assertFalse(any(self.h.state_dir in part for part in call.argv[:-1]))
        self.assertFalse(os.path.exists(observed["path"]))
        self.assertEqual(self.clipboard_files(), [])
        self.assertEqual(glob.glob(os.path.join(self.h.state_dir, "*.png")), [])
        self.assertIsNone(self.runtime.client.session_id)

    def test_clipboard_failure_is_reported_and_cleaned_up(self):
        self.h.runner.on("osascript", returncode=1, stderr="not allowed")
        error = self.assert_error(self.runtime.toolbar_action("screenshot"), "clipboard_unavailable")
        self.assertFalse(error["action_executed"])
        self.assertEqual(self.clipboard_files(), [])

    def test_bad_screenshot_data_is_invalid_response(self):
        for value in ("!!not base64!!", base64.b64encode(b"GIF89a-not-a-png").decode("ascii"), 42):
            with self.subTest(value=value):
                self.fake.inject("GET", "/screenshot", value=value)
                error = self.assert_error(self.runtime.toolbar_action("screenshot"), "invalid_response")
                self.assertFalse(error["action_executed"])
        self.assertEqual(self.h.runner.calls_for("osascript"), [])

    def test_screenshot_works_while_a_phone_step_holds_the_lock(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.h.runner.on("osascript")
        self.assertTrue(self.runtime.toolbar_action("screenshot")["ok"])


class ScreenToolTests(ToolbarCase):
    def screen(self, runtime=None, **args):
        envelope = (runtime or self.runtime).execute("iphone_screen", args)
        self.assertIs(envelope["ok"], True, envelope)
        return envelope

    def test_open_returns_the_private_url_without_a_browser_by_default_here(self):
        opened = self.screen()
        self.assertEqual(set(opened), {"ok", "url", "opened", "already_viewing", "paused", "pause_reason"})
        self.assertRegex(opened["url"], r"^http://127\.0\.0\.1:\d+/[0-9a-f]{32}/$")
        self.assertFalse(opened["opened"])
        self.assertFalse(opened["already_viewing"])
        self.assertEqual(self.screen()["url"], opened["url"], "a second open reuses the same page")
        self.assertEqual(self.h.runner.calls_for("open"), [])

    def test_browser_opens_only_on_a_mac_when_allowed_and_nobody_watches(self):
        self.h.runner.on("open")
        self.runtime._spawn = lambda function: function()
        self.runtime.platform = "darwin"
        self.runtime.env.pop("IPHONE_USE_NO_BROWSER", None)
        opened = self.screen(action="open")
        self.assertTrue(opened["opened"])
        self.assertEqual([call.argv for call in self.h.runner.calls_for("open")], [["/usr/bin/open", opened["url"]]])
        self.assertFalse(self.screen(action="open", open_browser=False)["opened"])
        self.runtime.env["IPHONE_USE_NO_BROWSER"] = "1"
        self.assertFalse(self.screen(action="open")["opened"])
        self.runtime.env.pop("IPHONE_USE_NO_BROWSER")
        self.runtime.platform = "linux"
        self.assertFalse(self.screen(action="open")["opened"])
        self.assertEqual(len(self.h.runner.calls_for("open")), 1)

    def test_open_with_a_viewer_already_watching_does_not_open_another_tab(self):
        self.h.runner.on("open")
        self.runtime._spawn = lambda function: function()
        self.runtime.platform = "darwin"
        self.runtime.env.pop("IPHONE_USE_NO_BROWSER", None)
        real = self.runtime.preview.ensure()
        self.runtime.preview.ensure = lambda: real._replace(viewers=1)
        opened = self.screen()
        self.assertEqual((opened["opened"], opened["already_viewing"]), (False, True))
        self.assertEqual(self.h.runner.calls_for("open"), [])

    def test_pause_resume_and_status(self):
        url = self.screen()["url"]
        self.assertEqual(self.screen(action="pause"), {"ok": True, "paused": True, "pause_reason": "authentication",
                                                       "url": url})
        status = self.screen(action="status")
        self.assertEqual(status, {"ok": True, "url": url, "running": True, "paused": True,
                                  "pause_reason": "authentication", "viewers": 0, "frame_available": False})
        self.assertEqual(self.screen(action="resume"), {"ok": True, "paused": False, "pause_reason": None,
                                                        "url": url})

    def test_screen_never_takes_the_lock_or_touches_the_phone(self):
        holder = LockHolder(os.path.join(self.h.state_dir, "operation.lock"))
        self.addCleanup(holder.stop)
        self.fake.clear_log()
        self.screen(action="open", open_browser=False)
        for action in ("pause", "status", "resume"):
            self.screen(action=action)
        self.assertEqual(self.fake.requests, [])

    def test_without_its_own_server_the_cli_reuses_or_explains(self):
        cli = self.h.make_runtime(serve_preview=False)
        alone = self.screen(runtime=cli)
        self.assertEqual(alone, {"ok": True, "url": None, "note": "The live preview runs inside Claude Code; open "
                                                                  "it from there."})
        self.assertEqual(self.screen(runtime=cli, action="status")["running"], False)
        served = self.screen()["url"]
        reused = self.screen(runtime=cli, open_browser=False)
        self.assertEqual(reused["url"], served)
        status = self.screen(runtime=cli, action="status")
        self.assertEqual((status["url"], status["running"], status["frame_available"]), (served, True, False))
        self.assertEqual(self.screen(runtime=cli, action="pause")["url"], served)
        self.assertTrue(self.runtime.screen.paused(), "the pause is shared through the state folder")

    def test_invalid_screen_arguments_are_rejected(self):
        for args in ({"action": "close"}, {"open_browser": "yes"}, {"extra": 1}):
            with self.subTest(args=args):
                self.assert_error(self.runtime.execute("iphone_screen", args), "invalid_argument")


class PreviewPageActionTests(ToolbarCase):
    def post(self, url, body):
        parts = urlsplit(url)
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        self.addCleanup(connection.close)
        connection.request("POST", parts.path + "api/action", body=json.dumps(body),
                           headers={"Content-Type": "application/json",
                                    "Origin": "http://127.0.0.1:%d" % parts.port})
        response = connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))

    def test_the_preview_page_buttons_reach_the_toolbar_actions(self):
        opened = self.runtime.execute("iphone_screen", {"action": "open", "open_browser": False})
        self.assertTrue(opened["ok"], opened)
        status, envelope = self.post(opened["url"], {"action": "refresh"})
        self.assertEqual(status, 200)
        self.assertEqual(envelope["action"], "refresh")
        self.assertTrue(envelope["service_ready"])
        status, envelope = self.post(opened["url"], {"action": "home"})
        self.assertEqual((status, envelope), (200, {"ok": True, "action": "home"}))
        self.assertEqual(self.fake.foreground, "com.apple.springboard")


if __name__ == "__main__":
    unittest.main()
