import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import stat  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import iphone_use  # noqa: E402
import privstate  # noqa: E402
from fake_wda import Node  # noqa: E402
from screen_hub import ScreenHub  # noqa: E402
from test_runtime import UDID, RuntimeHarness, refused_port  # noqa: E402

JOB = "a" * 32
TARGET = "b" * 32
CODE_41 = "Error Domain=XCTDaemonErrorDomain Code=41 Not authorized for performing UI testing actions"
NOT_READY_KEYS = ("proof", "observation", "image", "error")


def stub_setup():
    """Duck-typed stand-in for SetupManager's recovery API (the real one is covered by unit D)."""
    setup = mock.Mock()
    setup.pending_recovery.return_value = None
    setup.recover.return_value = {"ok": True, "job_id": JOB, "recovery": {"state": "queued", "phase": "queued",
                                                                           "job_id": JOB, "recovery_of": TARGET}}
    setup.mirroring_running.return_value = False
    setup.device_model.return_value = None
    return setup


class ReadyCase(unittest.TestCase):
    harness_options = {}

    def setUp(self):
        self.h = self.harness(**self.harness_options)
        self.runtime = self.h.runtime
        self.fake = self.h.fake
        self.setup = stub_setup()
        self.runtime.setup = self.setup

    def harness(self, **options):
        harness = RuntimeHarness(**options)
        self.addCleanup(harness.close)
        return harness

    def ready(self, runtime=None, **args):
        return (runtime or self.runtime).execute("iphone_ready", args)

    def assert_ready(self, envelope):
        self.assertIs(envelope["ok"], True, envelope)
        self.assertIs(envelope["ready"], True, envelope)
        self.assertEqual(envelope["state"], "ready")
        return envelope

    def assert_error(self, envelope, code):
        self.assertIs(envelope["ok"], False, envelope)
        self.assertEqual(envelope["error"]["code"], code, envelope)
        return envelope["error"]

    def assert_not_ready(self, envelope, state):
        self.assertIs(envelope["ok"], True, envelope)
        self.assertIs(envelope["ready"], False)
        self.assertEqual(envelope["state"], state)
        self.assertFalse(envelope["action_executed"])
        self.assertEqual(envelope["category"], "channel_runtime")
        for key in NOT_READY_KEYS:
            self.assertNotIn(key, envelope)
        self.assertFalse(envelope["recovery"]["replay_action"])
        content = iphone_use.result_content(envelope)
        self.assertFalse(content["isError"])
        self.assertEqual(len(content["content"]), 1)
        return envelope

    def assert_recovering(self, envelope, job_id=JOB):
        self.assert_not_ready(envelope, "recovering")
        recovery = envelope["recovery"]
        self.assertEqual(recovery["job_id"], job_id)
        self.assertEqual(recovery["status_tool"], "iphone_setup")
        self.assertEqual(recovery["status_arguments"], {"action": "status", "job_id": job_id, "wait_seconds": 20})
        self.assertEqual(recovery["next_tool"], "iphone_ready")
        self.assertEqual(recovery["retry_after_seconds"], 1)
        self.assertIsNone(self.runtime.client.session_id)
        self.assertEqual(dict(self.runtime.phone.snapshots), {})
        return envelope

    def no_phone_mutation(self):
        self.assertEqual([str(request) for request in self.fake.actions()], [])

    def session_posts(self):
        return self.h.routes().count("POST /session")

    def other_hub(self):
        hub = ScreenHub(self.h.state_dir)
        self.addCleanup(hub.close)
        return hub


class ReadySuccessTests(ReadyCase):
    def test_healthy_ready_has_proof_observation_and_preview(self):
        envelope = self.assert_ready(self.ready())
        self.assertEqual(envelope["proof"], {"status_ready": True, "phone_unlocked": True, "session_usable": True,
                                             "foreground_resolved": True, "source_readable": True,
                                             "viewport_readable": True, "screenshot_readable": False,
                                             "wda_version": "16.14.0"})
        observation = envelope["observation"]
        self.assertGreater(observation["total_nodes"], 0)
        self.assertEqual(observation["app"], "com.apple.Preferences")
        self.assertNotIn("image", observation)
        preview = envelope["preview"]
        self.assertTrue(preview["url"].startswith("http://127.0.0.1:"))
        self.assertTrue(preview["url"].endswith("/"))
        self.assertEqual((preview["paused"], preview["pause_reason"]), (False, None))
        self.assertEqual(self.h.routes()[:3], ["GET /status", "GET /wda/locked", "POST /session"])
        self.assertNotIn("GET /screenshot", self.h.routes())
        self.no_phone_mutation()
        self.setup.recover.assert_not_called()
        content = iphone_use.result_content(envelope)
        self.assertFalse(content["isError"])
        self.assertEqual(len(content["content"]), 1)

    def test_ready_with_screenshot_attaches_one_image(self):
        envelope = self.assert_ready(self.ready(screenshot=True))
        self.assertTrue(envelope["proof"]["screenshot_readable"])
        self.assertIn("image", envelope["observation"])
        content = iphone_use.result_content(envelope)
        self.assertEqual([block["type"] for block in content["content"]], ["text", "image"])

    def test_ready_never_opens_a_browser(self):
        self.runtime.platform = "darwin"
        self.runtime.env.pop("IPHONE_USE_NO_BROWSER", None)
        spawned = []
        self.runtime._spawn = spawned.append
        self.assert_ready(self.ready())
        self.assertEqual(spawned, [])
        self.assertEqual(self.h.runner.calls_for("open"), [])

    def test_empty_tree_with_iphone_mirroring_is_a_conflict(self):
        self.fake.set_tree("com.apple.Preferences", Node("Application", rect=(0, 0, 390, 844)))
        self.setup.mirroring_running.return_value = True
        error = self.assert_error(self.ready(), "mirroring_conflict")
        self.assertIn("iPhone Mirroring", error["message"])
        self.setup.mirroring_running.return_value = False
        envelope = self.assert_ready(self.ready())
        self.assertEqual(envelope["observation"]["total_nodes"], 0)
        self.assertIn("warnings", envelope["observation"])

    def test_adopted_session_from_an_earlier_service_is_replaced(self):
        self.assert_ready(self.ready())
        old = self.runtime.client.session_id
        self.fake.invalidate_session()
        later = self.h.make_runtime(serve_preview=False)
        later.setup = stub_setup()
        envelope = self.assert_ready(self.ready(runtime=later))
        self.assertNotEqual(later.client.session_id, old)
        self.assert_ready(self.ready())

    def test_ready_over_usbmux_with_the_configured_iphone(self):
        h = self.harness(url=None, via_usbmux=True, config={"format": 1, "udid": UDID})
        h.runtime.setup = stub_setup()
        envelope = self.assert_ready(h.runtime.execute("iphone_ready", {}))
        self.assertEqual(envelope["observation"]["app"], "com.apple.Preferences")
        saved = privstate.read_json(os.path.join(h.state_dir, "session.json"))
        self.assertEqual(saved["transport"], "usbmux:%s:8100" % UDID)
        self.assertEqual([connect[1] for connect in h.mux.connects], [8100] * len(h.mux.connects))
        self.assertTrue(h.mux.connects)

    def test_preview_failure_never_breaks_readiness(self):
        self.runtime.preview.ensure = mock.Mock(side_effect=OSError("port in use"))
        self.runtime.screen.begin = mock.Mock(side_effect=RuntimeError("hub broken"))
        envelope = self.assert_ready(self.ready())
        self.assertNotIn("preview", envelope)

    def test_ready_without_a_live_preview_server_omits_preview(self):
        h = self.harness(serve_preview=False)
        h.runtime.setup = stub_setup()
        envelope = self.assert_ready(h.runtime.execute("iphone_ready", {}))
        self.assertNotIn("preview", envelope)


class ReadyRefusalTests(ReadyCase):
    def lock_failure(self):
        self.fake.locked = True
        error = self.assert_error(self.ready(), "phone_locked")
        self.fake.locked = False
        return error

    def test_locked_phone_creates_no_session_and_pauses_the_preview(self):
        self.fake.locked = True
        self.fake.clear_log()
        error = self.assert_error(self.ready(), "phone_locked")
        self.assertIn("unlock", error["message"])
        self.assertIs(error["action_executed"], False)
        self.assertEqual(self.h.routes(), ["GET /status", "GET /wda/locked"])
        self.assertIsNone(self.runtime.client.session_id)
        self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": "device_locked"})
        self.setup.recover.assert_not_called()
        self.assertTrue(iphone_use.result_content(self.ready())["isError"])

    def test_unclear_lock_answer_is_treated_as_locked(self):
        for value in (None, "false", 0):
            with self.subTest(value=value):
                self.fake.inject("GET", "/wda/locked", value=value)
                error = self.assert_error(self.ready(), "phone_locked")
                self.assertIs(error["action_executed"], False)
                self.assertIsNone(self.runtime.client.session_id)

    def test_cold_start_errors_point_to_setup_and_never_start_anything(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        unreachable = self.harness(url="http://127.0.0.1:%d" % port)
        cases = (("service_unreachable", unreachable.runtime), ("not_ready", self.runtime))
        self.fake.status_ready = False
        for code, runtime in cases:
            for recover in (True, False):
                with self.subTest(code=code, recover=recover):
                    runtime.setup = stub_setup()
                    error = self.assert_error(self.ready(runtime=runtime, recover=recover), code)
                    self.assertIs(error["ready"], False)
                    self.assertIs(error["action_executed"], False)
                    self.assertIs(error["initialization_required"], True)
                    self.assertEqual(error["recovery"]["next_tool"], "iphone_setup")
                    self.assertEqual(error["recovery"]["next_arguments"], {"action": "status"})
                    self.assertIs(error["recovery"]["replay_action"], False)
                    self.assertIn("setup step", error["recovery"]["next_step"])
                    self.assertNotIn("proof", error)
                    runtime.setup.recover.assert_not_called()
        self.no_phone_mutation()

    def test_unreachable_error_keeps_the_transport_reason(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        h = self.harness(url="http://127.0.0.1:%d" % port)
        h.runtime.setup = stub_setup()
        error = self.assert_error(h.runtime.execute("iphone_ready", {}), "service_unreachable")
        self.assertEqual((error["phase"], error["reason"]), ("connect", "connection_refused"))

    def test_generic_stale_element_is_raised_unchanged(self):
        self.fake.inject("GET", "/source", error="stale element reference",
                         message="Previously found element Button 'Continue' is not present", times=None)
        error = self.assert_error(self.ready(), "stale element reference")
        self.assertNotIn("category", error)
        self.assertEqual(self.h.routes().count("GET /source"), 1)
        self.assertIsNotNone(self.runtime.client.session_id)
        self.setup.recover.assert_not_called()


class ReadyRecoveryTests(ReadyCase):
    def persistent_foreground_fault(self):
        self.fake.root_attributes = False
        self.fake.foreground_sequence = ["local.pid.0"]

    def test_transient_local_pid_foreground_retries_one_fresh_read(self):
        self.fake.root_attributes = False
        self.fake.foreground_sequence = ["local.pid.0", "com.apple.Preferences"]
        envelope = self.assert_ready(self.ready())
        self.assertEqual(envelope["recovery"], {"state": "read_recovered", "session_recreated": True,
                                                "replayed_action": False})
        self.assertTrue(envelope["proof"]["foreground_resolved"])
        self.assertEqual(self.session_posts(), 2)
        self.assertEqual(self.h.routes().count("GET /wda/activeAppInfo"), 2)
        self.setup.recover.assert_not_called()
        self.no_phone_mutation()

    def test_persistent_foreground_fault_queues_one_recovery(self):
        self.persistent_foreground_fault()
        envelope = self.assert_recovering(self.ready())
        self.assertTrue(envelope["session_read_retried"])
        self.assertEqual(envelope["cause"]["code"], "foreground_unavailable")
        self.assertEqual(envelope["recovery"]["next_arguments"], {"screenshot": False, "recover": True})
        self.assertEqual(envelope["recovery"]["recovery_of"], TARGET)
        self.setup.recover.assert_called_once_with()
        self.assertEqual(self.session_posts(), 2)
        self.no_phone_mutation()

    def test_local_pid_stale_source_uses_the_same_bounded_recovery(self):
        self.fake.inject("GET", "/source", error="stale element reference",
                         message="Application local.pid.0 is not running", times=None)
        envelope = self.assert_recovering(self.ready())
        self.assertTrue(envelope["session_read_retried"])
        self.assertEqual(self.h.routes().count("GET /source"), 2)
        self.setup.recover.assert_called_once_with()

    def test_xctest_authorization_skips_the_read_retry(self):
        self.fake.inject("GET", "/source", error="unknown error", message=CODE_41, times=None)
        envelope = self.assert_recovering(self.ready())
        self.assertFalse(envelope["session_read_retried"])
        self.assertEqual(self.h.routes().count("GET /source"), 1)
        self.assertEqual(envelope["cause"]["code"], "unknown error")
        self.setup.recover.assert_called_once_with()

    def test_recover_false_reports_recovery_required_without_restarting(self):
        self.persistent_foreground_fault()
        for screenshot in (False, True):
            with self.subTest(screenshot=screenshot):
                envelope = self.assert_not_ready(self.ready(recover=False, screenshot=screenshot),
                                                 "recovery_required")
                self.assertEqual(envelope["reason"], "recovery_disabled")
                self.assertTrue(envelope["session_read_retried"])
                self.assertEqual(envelope["cause"]["code"], "foreground_unavailable")
                self.assertEqual(envelope["recovery"]["state"], "disabled")
                self.assertEqual(envelope["recovery"]["next_tool"], "iphone_ready")
                self.assertEqual(envelope["recovery"]["next_arguments"], {"screenshot": screenshot, "recover": True})
                self.assertIn("user", envelope["recovery"]["permission_note"].lower())
        self.setup.recover.assert_not_called()
        self.no_phone_mutation()

    def test_unproven_owner_never_claims_a_recovery(self):
        self.persistent_foreground_fault()
        self.setup.recover.return_value = {"ok": False, "error": "The running iPhone service was not started by "
                                           "this plugin, so it was not restarted.", "recovery": {"state": "manual"},
                                           "next_steps": ["Restart it from where it was started."]}
        error = self.assert_error(self.ready(), "recovery_not_started")
        self.assertIn("not started by this plugin", error["message"])
        self.assertTrue(error["message"].startswith("Automatic restart was not started: "))
        self.assertIs(error["ready"], False)
        self.assertIs(error["action_executed"], False)
        self.assertEqual(error["category"], "channel_runtime")
        self.assertTrue(error["session_read_retried"])
        self.assertEqual(error["cause"]["code"], "foreground_unavailable")
        self.assertNotIn("job_id", error["recovery"])
        self.assertEqual(error["recovery"]["state"], "manual")
        self.assertEqual(error["recovery"]["next_steps"], ["Restart it from where it was started."])
        self.assertIs(error["recovery"]["replay_action"], False)
        self.no_phone_mutation()

    def test_recovery_cooldown_is_an_actionable_error(self):
        self.persistent_foreground_fault()
        self.setup.recover.return_value = {"ok": False, "error": "A recent restart is still within its 2-minute "
                                           "cooldown.", "recovery": {"state": "cooldown", "retry_after_seconds": 95},
                                           "next_steps": []}
        error = self.assert_error(self.ready(), "recovery_not_started")
        self.assertEqual(error["recovery"]["state"], "cooldown")
        self.assertEqual(error["recovery"]["retry_after_seconds"], 95)
        self.assertNotIn("job_id", error["recovery"])
        self.assertTrue(iphone_use.result_content(self.ready())["isError"])

    def test_recover_without_job_id_is_not_a_recovery(self):
        self.persistent_foreground_fault()
        self.setup.recover.return_value = {"ok": True, "recovery": {"state": "queued"}}
        self.assert_error(self.ready(), "recovery_not_started")

    def test_lock_during_the_foreground_retry_stops_recovery(self):
        self.fake.root_attributes = False
        self.fake.foreground_sequence = ["local.pid.0", "com.apple.Preferences"]
        original = self.runtime.phone.active_app

        def active_app(*args, **kwargs):
            try:
                return original(*args, **kwargs)
            finally:
                self.fake.locked = True

        self.runtime.phone.active_app = active_app
        self.assert_error(self.ready(), "phone_locked")
        self.assertEqual(self.session_posts(), 1)
        self.assertIsNone(self.runtime.client.session_id)
        self.setup.recover.assert_not_called()
        self.no_phone_mutation()


class PendingRecoveryTests(ReadyCase):
    def pending(self):
        return {"state": "queued", "phase": "stopping", "job_id": JOB, "recovery_of": TARGET}

    def test_pending_recovery_never_proves_ready_from_the_old_service(self):
        privstate.write_json_private(os.path.join(self.h.state_dir, "session.json"),
                                     {"transport": self.runtime.transport.identity, "session_id": "OLD-SESSION"})
        self.runtime.phone.snapshots["old"] = {"nodes": []}
        self.setup.pending_recovery.return_value = self.pending()
        envelope = self.assert_recovering(self.ready(recover=False))
        self.assertEqual(self.fake.requests, [])
        self.assertFalse(envelope["session_read_retried"])
        self.assertNotIn("cause", envelope)
        self.assertEqual(envelope["recovery"]["next_arguments"], {"screenshot": False, "recover": False})
        self.assertEqual(envelope["recovery"]["phase"], "stopping")
        self.assertFalse(os.path.exists(os.path.join(self.h.state_dir, "session.json")))
        self.setup.recover.assert_not_called()

    def test_pending_recovery_found_after_a_failed_probe(self):
        holder, port = refused_port()
        self.addCleanup(holder.close)
        h = self.harness(url="http://127.0.0.1:%d" % port)
        setup = stub_setup()
        setup.pending_recovery.side_effect = [None, self.pending()]
        h.runtime.setup = setup
        self.runtime = h.runtime
        envelope = self.assert_recovering(h.runtime.execute("iphone_ready", {"recover": False}))
        self.assertEqual(envelope["cause"]["code"], "service_unreachable")
        self.assertEqual(envelope["recovery"]["next_arguments"], {"screenshot": False, "recover": False})
        setup.recover.assert_not_called()

    def test_pending_recovery_is_ignored_for_unrelated_errors(self):
        self.fake.locked = True
        self.setup.pending_recovery.side_effect = [None, self.pending()]
        self.assert_error(self.ready(), "phone_locked")
        self.setup.pending_recovery.side_effect = [None, self.pending()]
        self.fake.locked = False
        self.fake.set_tree("com.apple.Preferences", Node("Application", rect=(0, 0, 390, 844)))
        self.setup.mirroring_running.return_value = True
        self.assert_error(self.ready(), "mirroring_conflict")

    def test_pending_recovery_errors_are_tolerated(self):
        self.setup.pending_recovery.side_effect = OSError("job folder unreadable")
        self.assert_ready(self.ready())


class ReadyPreviewTests(ReadyCase):
    def lock_failure(self):
        self.fake.locked = True
        self.assert_error(self.ready(), "phone_locked")
        self.fake.locked = False

    def test_unlock_ready_clears_only_its_lock_pause(self):
        other = self.other_hub()
        self.lock_failure()
        self.assertEqual(other.pause_status(), {"paused": True, "pause_reason": "device_locked"})
        envelope = self.assert_ready(self.ready())
        self.assertEqual((envelope["preview"]["paused"], envelope["preview"]["pause_reason"]), (False, None))
        self.assertFalse(other.paused())
        self.assertEqual(self.h.routes().count("GET /screenshot"), 0)

    def test_authentication_and_legacy_pauses_survive_ready_until_the_user_refreshes(self):
        state_file = os.path.join(self.h.state_dir, "screen-state.json")
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.runtime.screen.set_paused(False)
                if legacy:
                    privstate.write_json_private(state_file, {"paused": True})
                else:
                    self.assertTrue(self.runtime.execute("iphone_screen", {"action": "pause"})["ok"])
                self.lock_failure()
                reason = "unknown" if legacy else "authentication"
                self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": reason})
                envelope = self.assert_ready(self.ready())
                self.assertEqual((envelope["preview"]["paused"], envelope["preview"]["pause_reason"]),
                                 (True, reason))
                self.fake.clear_log()
                refreshed = self.runtime.toolbar_action("refresh")
                self.assertEqual(refreshed["paused"], False, refreshed)
                self.assertEqual(self.h.routes(), ["GET /status", "GET /wda/locked"])

    def test_failed_health_check_keeps_the_lock_pause(self):
        self.lock_failure()
        self.fake.status_ready = False
        self.assert_error(self.ready(), "not_ready")
        self.assertEqual(self.runtime.screen.pause_status(), {"paused": True, "pause_reason": "device_locked"})

    def test_pause_created_during_the_probe_survives(self):
        other = self.other_hub()
        observe = self.runtime.phone.observe
        for reason in ("authentication", "device_locked"):
            with self.subTest(reason=reason):
                self.runtime.screen.set_paused(False)
                self.lock_failure()

                def concurrent_pause(*args, **kwargs):
                    result = observe(*args, **kwargs)
                    other.set_paused(True, reason)
                    return result

                with mock.patch.object(self.runtime.phone, "observe", side_effect=concurrent_pause):
                    envelope = self.assert_ready(self.ready())
                self.assertEqual((envelope["preview"]["paused"], envelope["preview"]["pause_reason"]),
                                 (True, reason))

    def test_pause_id_is_private(self):
        self.lock_failure()
        pause_id = self.runtime.screen.locked_pause_id()
        self.assertIsNotNone(pause_id)
        status = self.runtime.execute("iphone_screen", {"action": "status"})
        self.assertNotIn(pause_id, json.dumps(status))
        self.assertNotIn(pause_id, json.dumps(self.assert_ready(self.ready())))


class DeviceLookupTests(ReadyCase):
    harness_options = {"config": {"format": 1, "udid": UDID}}

    def test_model_is_looked_up_once_and_cached_privately(self):
        self.runtime._spawn = lambda function: function()
        self.setup.device_model.return_value = "iPhone 16 Pro"
        self.assert_ready(self.ready())
        self.assert_ready(self.ready())
        self.assertTrue(self.runtime.execute("iphone_screen", {"action": "open", "open_browser": False})["ok"])
        self.setup.device_model.assert_called_once_with(UDID)
        self.assertEqual(self.runtime.screen.device, {"model": "iPhone 16 Pro"})
        path = os.path.join(self.h.state_dir, "device.json")
        self.assertEqual(privstate.read_json(path), {"udid": UDID, "model": "iPhone 16 Pro"})
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        later = self.h.make_runtime(serve_preview=False)
        later.setup = stub_setup()
        later._spawn = lambda function: function()
        self.assert_ready(self.ready(runtime=later))
        later.setup.device_model.assert_not_called()
        self.assertEqual(later.screen.device, {"model": "iPhone 16 Pro"})

    def test_lookup_failure_keeps_the_generic_header(self):
        self.runtime._spawn = lambda function: function()
        self.setup.device_model.side_effect = RuntimeError("devicectl failed")
        self.assert_ready(self.ready())
        self.assertIsNone(self.runtime.screen.device)
        self.assertFalse(os.path.exists(os.path.join(self.h.state_dir, "device.json")))

    def test_screen_open_returns_while_the_lookup_is_still_running(self):
        release = threading.Event()
        started = threading.Event()

        def slow_model(udid):
            started.set()
            release.wait(5)
            return "iPhone 15"

        self.setup.device_model.side_effect = slow_model
        begin = time.monotonic()
        result = self.runtime.execute("iphone_screen", {"action": "open", "open_browser": False})
        elapsed = time.monotonic() - begin
        self.assertTrue(result["ok"], result)
        self.assertTrue(started.wait(5))
        self.assertLess(elapsed, 1.5)
        self.assertIsNone(self.runtime.screen.device)
        release.set()
        for thread in list(self.runtime._threads):
            thread.join(5)
        self.assertEqual(self.runtime.screen.device, {"model": "iPhone 15"})


class UnconfiguredLookupTests(ReadyCase):
    def test_runtime_without_a_configured_iphone_never_looks_for_a_device(self):
        spawned = []
        self.runtime._spawn = spawned.append
        self.assert_ready(self.ready())
        self.assertTrue(self.runtime.execute("iphone_screen", {"action": "open", "open_browser": False})["ok"])
        self.assertEqual(spawned, [])
        self.setup.device_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
