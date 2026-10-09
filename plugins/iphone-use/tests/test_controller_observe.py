import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import re  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402
from unittest import mock  # noqa: E402

import wda_controller  # noqa: E402
import wda_image  # noqa: E402
from fake_wda import Node  # noqa: E402
from phone_harness import (TOOL_NAMES, HarnessCase, RecordingScreen, UDID, cell, fake_clock,  # noqa: E402
                           hint_problems)
from wda_client import SESSION_SETTINGS  # noqa: E402
from wda_tree import compact_node  # noqa: E402

SETTINGS = "com.apple.Preferences"
JPEG_POINTS = [round(390 / 725, 4), round(844 / 1568, 4)]  # 1170x2532 PNG -> 725x1568 JPEG


class CompactObservationTests(HarnessCase):
    def test_node_keeps_each_fact_once(self):
        self.h.show(
            Node("Button", label="返回", rect=(60, 200, 250, 44)),
            Node("StaticText", label="余额 1,234.56", value="余额 1,234.56", rect=(60, 300, 250, 44)),
            Node("Cell", label="通用", identifier="General", value="1", enabled=False, rect=(16.4, 400, 250.6, 44)),
        )
        observed = self.phone.observe()
        self.assertEqual(observed["nodes"], [
            {"type": "Button", "label": "返回", "rect": [60, 200, 250, 44]},
            {"type": "StaticText", "label": "余额 1,234.56", "rect": [60, 300, 250, 44]},
            {"type": "Cell", "label": "通用", "name": "General", "value": "1", "enabled": False,
             "rect": [16, 400, 251, 44]},
        ])
        self.assertEqual(observed["total_nodes"], 3)
        self.assertFalse(observed["truncated"])

    def test_observation_key_set_and_snapshot_are_exact(self):
        observed = self.phone.observe()
        self.assertEqual(set(observed), {"observation_id", "observed_at", "app", "viewport", "nodes", "total_nodes",
                                         "truncated"})
        self.assertRegex(observed["observed_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertRegex(observed["observation_id"], r"^[0-9a-f]{12}$")
        self.assertEqual(observed["app"], SETTINGS)
        self.assertEqual(observed["viewport"], {"width": 390, "height": 844, "units": "iPhone points"})
        snapshot = self.phone.snapshots[observed["observation_id"]]
        self.assertEqual(set(snapshot), {"time", "viewport", "app", "nodes"})
        self.assertEqual(len(snapshot["nodes"]), observed["total_nodes"])
        source = self.fake.calls(route="/source")[-1]
        self.assertEqual(source.query, {"format": "xml", "excluded_attributes": "visible"})

    def test_expensive_visibility_asks_for_real_visibility(self):
        observed = self.phone.observe(expensive_visibility=True)
        self.assertTrue(observed["visibility_computed"])
        self.assertEqual(self.fake.calls(route="/source")[-1].query, {"format": "xml"})
        # The Settings fixture has an invisible General row below the screen; it stays hidden.
        self.assertNotIn("General", [node.get("label") for node in observed["nodes"]])

    def test_empty_tree_still_explains_itself(self):
        self.h.show()
        observed = self.phone.observe()
        self.assertEqual(observed["nodes"], [])
        self.assertEqual(observed["total_nodes"], 0)
        self.assertEqual(observed["warnings"], [wda_controller.EMPTY_TREE_WARNING])
        self.assertIn("screen tree is empty", observed["warnings"][0])

    def test_departures_from_defaults_stay_visible(self):
        self.h.show(cell("On screen"), cell("Below", y=2000), cell("Hidden", y=300, visible=False))
        observed = self.phone.observe(include_invisible=True, expensive_visibility=True)
        self.assertEqual([n["label"] for n in observed["nodes"]], ["On screen", "Below", "Hidden"])
        self.assertEqual([n.get("in_viewport", True) for n in observed["nodes"]], [True, False, True])
        self.assertEqual([n.get("visible", True) for n in observed["nodes"]], [True, True, False])
        # Real visibility is excluded by default (it is slow in WDA), so only the off-screen row is dropped.
        self.assertEqual([n["label"] for n in self.phone.observe()["nodes"]], ["On screen", "Hidden"])
        visible_only = self.phone.observe(expensive_visibility=True)
        self.assertEqual([n["label"] for n in visible_only["nodes"]], ["On screen"])

    def test_truncation_keeps_the_first_nodes_and_the_snapshot_keeps_all(self):
        self.h.show(*[cell("Row %d" % number, y=100 + number * 50) for number in range(5)])
        observed = self.phone.observe(max_nodes=2)
        self.assertEqual([n["label"] for n in observed["nodes"]], ["Row 0", "Row 1"])
        self.assertEqual(observed["total_nodes"], 5)
        self.assertTrue(observed["truncated"])
        self.assertEqual(len(self.phone.snapshots[observed["observation_id"]]["nodes"]), 5)

    def test_invalid_arguments_fail_before_any_request(self):
        for arguments in ({"mode": "none"}, {"mode": "pixels"}, {"max_nodes": 0}, {"max_nodes": 301},
                          {"max_nodes": True}, {"max_nodes": 1.5}, {"include_invisible": "yes"},
                          {"expensive_visibility": 1}):
            with self.subTest(arguments=arguments):
                error = self.assert_code("invalid_argument", lambda: self.phone.observe(**arguments))
                self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.fake.requests, [])

    def test_compact_node_is_several_times_smaller_than_the_wda_attributes(self):
        native = {"type": "XCUIElementTypeButton", "name": "Back", "label": "Back", "enabled": "true",
                  "rect": {"x": 16.0, "y": 62.0, "width": 44.0, "height": 44.0}, "in_viewport": True}
        before = len(json.dumps(native))
        after = len(json.dumps(compact_node(native), separators=(",", ":")))
        self.assertLess(after * 2.5, before)

    def test_snapshots_are_bounded(self):
        identifiers = [self.phone.observe()["observation_id"] for _ in range(wda_controller.SNAPSHOT_LIMIT + 3)]
        self.assertEqual(len(self.phone.snapshots), wda_controller.SNAPSHOT_LIMIT)
        self.assertNotIn(identifiers[0], self.phone.snapshots)
        self.assertIn(identifiers[-1], self.phone.snapshots)


class SourceRootTests(HarnessCase):
    """The /source root names the app and spans the screen, so one read usually answers everything."""

    def test_tree_observation_needs_one_request_once_the_viewport_is_known(self):
        self.h.warm()
        first = self.phone.observe()
        self.assertEqual(self.h.routes(), ["GET /source", "GET /window/size"])
        self.fake.clear_log()
        second = self.phone.observe()
        self.assertEqual(self.h.routes(), ["GET /source"])
        self.assertEqual((second["app"], second["viewport"]), (SETTINGS, first["viewport"]))
        self.fake.clear_log()
        result = self.phone.tap(selector={"label": "Wi-Fi"}, observe="tree")
        self.assertEqual(result["observation"]["app"], SETTINGS)
        self.assertFalse(any(route in ("GET /wda/activeAppInfo", "GET /window/size") for route in self.h.routes()))

    def test_a_root_without_identity_falls_back_to_the_foreground_read(self):
        self.fake.root_attributes = False
        observed = self.phone.observe()
        self.assertEqual(observed["app"], SETTINGS)
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 1)

    def test_a_wrapper_root_falls_back_to_both_reads_every_time(self):
        self.fake.wrapper_root = "AppiumAUT"
        self.h.warm()
        for _ in range(2):
            observed = self.phone.observe()
            self.assertEqual(observed["app"], SETTINGS)
            self.assertGreater(observed["total_nodes"], 0)
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 2)
        self.assertEqual(self.h.count("GET /window/size"), 2)

    def test_unresolved_foreground_is_a_channel_fault(self):
        self.fake.foreground = "local.pid.77"
        error = self.assert_code("foreground_unavailable", lambda: self.phone.observe())
        self.assertEqual(error.details["foreground_app"], "local.pid.77")
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(error.details["recovery"],
                         {"next_tool": "iphone_ready", "next_arguments": {}, "replay_action": False})
        self.assertNotIn("observation", error.details)

    def test_rotation_falls_back_to_a_real_viewport_read(self):
        self.h.show(cell("Row"))
        self.phone.observe()
        self.fake.size = (844, 390)
        self.fake.clear_log()
        rotated = self.phone.observe()
        self.assertIn("GET /window/size", self.h.routes())
        self.assertEqual((rotated["viewport"]["width"], rotated["viewport"]["height"]), (844, 390))

    def test_supplied_observation_still_checks_the_real_foreground(self):
        observed = self.phone.observe()
        self.fake.set_foreground("com.apple.springboard")
        error = self.assert_code("stale_observation",
                                 lambda: self.phone.tap(x=10, y=10, observation_id=observed["observation_id"]))
        self.assertEqual(error.details["reason"], "foreground_changed")
        self.assertEqual(self.fake.actions(), [])

    def test_screenshot_reuses_the_viewport_until_the_image_turns(self):
        self.h.show(cell("Row"))
        self.phone.observe("screenshot")
        self.fake.clear_log()
        self.phone.observe("screenshot")
        self.assertEqual(self.h.routes(), ["GET /wda/activeAppInfo", "GET /screenshot"])
        self.fake.size = (844, 390)  # the fake's screenshot turns with it (2532x1170)
        self.fake.clear_log()
        turned = self.phone.observe("screenshot")
        self.assertIn("GET /window/size", self.h.routes())
        self.assertEqual(turned["viewport"]["width"], 844)
        self.assertEqual((turned["image"]["width"], turned["image"]["height"]), (1568, 725))
        self.assertEqual(turned["image"]["pixel_to_point"], [round(844 / 1568, 4), round(390 / 725, 4)])
        self.assertEqual(self.phone.snapshots[turned["observation_id"]]["viewport"]["width"], 844)


class ViewportCacheTests(HarnessCase):
    def setUp(self):
        super().setUp()
        # Without a sized source root every observation reads the window size (as in the reference fake).
        self.fake.wrapper_root = "AppiumAUT"

    def count(self):
        return self.h.count("GET /window/size")

    def test_plain_actions_share_one_viewport_read(self):
        self.phone.tap(x=10, y=10)
        self.phone.tap(x=20, y=20)
        self.phone.swipe()
        self.phone.tap(selector={"label": "Wi-Fi"})
        self.assertEqual(self.count(), 1)

    def test_a_supplied_observation_and_every_observation_read_it_again(self):
        observed = self.phone.observe()
        self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 1)
        self.phone.tap(x=10, y=10, observation_id=observed["observation_id"])
        self.assertEqual(self.count(), 2)
        self.phone.observe()
        self.assertEqual(self.count(), 3)

    def test_app_switches_age_and_reset_drop_the_cached_viewport(self):
        self.phone.tap(x=10, y=10)
        self.phone.launch_app("com.example.form")
        self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 2)
        self.phone.press_button("home")
        self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 3)
        with mock.patch.object(wda_controller, "VIEWPORT_TTL", 0):
            self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 4)
        self.phone.reset()
        self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 5)
        self.phone.external_action()
        self.phone.tap(x=10, y=10)
        self.assertEqual(self.count(), 6)

    def test_rotation_seen_by_a_fresh_read_rejects_old_coordinates(self):
        self.phone.tap(x=380, y=10)
        self.fake.size = (844, 390)
        self.phone.observe()
        error = self.assert_code("invalid_argument", lambda: self.phone.tap(x=10, y=800))
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.fake.taps, [(380, 10)])

    def test_an_unusable_window_size_is_an_invalid_response(self):
        for value in ({"width": 0, "height": 844}, {"width": "390", "height": 844}, {"width": 390}, None,
                      {"width": float("1e9"), "height": 844}):
            with self.subTest(value=value):
                self.phone.reset()
                self.fake.inject("GET", "/window/size", value=value)
                self.assert_code("invalid_response", lambda: self.phone.viewport())


class ScreenshotTests(HarnessCase):
    def artifacts(self, pattern):
        return sorted(self.phone.artifacts_dir.glob(pattern))

    def test_model_receives_a_bounded_jpeg_with_its_exact_point_scale(self):
        observed = self.phone.observe("screenshot")
        image = observed["image"]
        self.assertEqual((image["mimeType"], image["width"], image["height"]), ("image/jpeg", 725, 1568))
        self.assertEqual(image["pixel_to_point"], JPEG_POINTS)
        path = Path(image["path"])
        self.assertEqual(path.suffix, ".jpg")
        self.assertEqual(path.parent, self.h.state_dir / "artifacts")
        self.assertEqual(path.read_bytes()[:2], b"\xff\xd8")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        native = path.with_suffix(".png")
        self.assertEqual(native.read_bytes(), self.fake.screenshot_png)
        self.assertEqual(native.stat().st_mode & 0o777, 0o600)
        (call,) = self.h.runner.calls_for("sips")
        self.assertEqual(call.argv, [self.h.sips_path, "-s", "format", "jpeg", "-s", "formatOptions", "80",
                                     "-z", "1568", "725", str(native), "--out", str(path)])
        self.assertNotIn("nodes", observed)
        self.assertIsNone(self.phone.snapshots[observed["observation_id"]]["nodes"])
        self.assertEqual(self.h.count("GET /source"), 0)
        self.assertRegex(path.name, r"^\d{8}T\d{12}Z-[0-9a-f]{8}\.jpg$")

    def test_jpeg_quality_is_a_knob(self):
        self.phone.jpeg_quality = 60
        self.phone.observe("screenshot")
        self.assertEqual(self.h.runner.calls_for("sips")[0].argv[6], "60")

    def test_original_png_is_used_on_request(self):
        self.phone.image_original = True
        image = self.phone.observe("screenshot")["image"]
        self.assertEqual((image["mimeType"], image["width"], image["height"]), ("image/png", 1170, 2532))
        self.assertEqual(image["pixel_to_point"], [round(390 / 1170, 4), round(844 / 2532, 4)])
        self.assertEqual(self.h.runner.calls, [])

    def test_unavailable_sips_keeps_the_png(self):
        self.phone.sips_path = os.path.join(self.h.root, "missing", "sips")
        image = self.phone.observe("both")["image"]
        self.assertEqual(image["mimeType"], "image/png")
        self.assertEqual(Path(image["path"]).read_bytes(), self.fake.screenshot_png)

    def test_a_failed_conversion_keeps_the_capture(self):
        self.h.runner.on("sips", returncode=1, stderr="sips failed")
        image = self.phone.observe("screenshot")["image"]
        self.assertEqual(image["mimeType"], "image/png")
        self.assertEqual(self.artifacts("*.jpg"), [])
        self.assertEqual(len(self.artifacts("*.png")), 1)

    def test_a_small_screenshot_is_sent_unchanged(self):
        self.fake.size = (375, 667)
        self.fake.scale = 2
        image = self.phone.observe("screenshot")["image"]
        self.assertEqual((image["mimeType"], image["width"], image["height"]), ("image/png", 750, 1334))
        self.assertEqual(image["pixel_to_point"], [0.5, 0.5])
        self.assertEqual(self.h.runner.calls, [])

    def test_both_kinds_of_artifact_are_pruned(self):
        self.phone.keep_artifacts = 5
        self.phone.artifacts_dir.mkdir(mode=0o700, parents=True)
        for number in range(8):
            for suffix in (".png", ".jpg"):
                (self.phone.artifacts_dir / ("00000000T000000%06dZ-old%s" % (number, suffix))).write_bytes(b"old")
        image = self.phone.observe("screenshot")["image"]
        self.assertEqual((len(self.artifacts("*.png")), len(self.artifacts("*.jpg"))), (5, 5))
        self.assertTrue(Path(image["path"]).exists())
        self.assertEqual(wda_controller.KEEP_ARTIFACTS, 40)

    def test_an_unusable_screenshot_is_an_invalid_response(self):
        for value, text in (("aGVsbG8=", "not a PNG"), ("%%% not base64", "could not be decoded"),
                            (None, "could not be decoded")):
            with self.subTest(value=value):
                self.fake.inject("GET", "/screenshot", value=value)
                error = self.assert_code("invalid_response", lambda: self.phone.observe("screenshot"))
                self.assertIn(text, error.message)
        self.assertEqual(self.artifacts("*.png"), [])

    def test_the_screenshot_request_gets_a_longer_timeout(self):
        with mock.patch.object(self.h.client, "request", wraps=self.h.client.request) as spy:
            self.phone.observe("screenshot")
        timeouts = [call.kwargs.get("timeout") for call in spy.call_args_list if call.args[1] == "/screenshot"]
        self.assertEqual(timeouts, [25.0])


class SettleTests(HarnessCase):
    harness_options = {"settle": 0.5}

    def toggles_since(self, start):
        return self.fake.settings_history[start:]

    def test_post_action_tree_read_waits_for_the_transition_then_restores_speed(self):
        self.h.warm(viewport=True)
        start = len(self.fake.settings_history)
        self.phone.tap(selector={"label": "Wi-Fi"}, observe="tree")
        self.assertEqual(self.toggles_since(start),
                         [{"animationCoolOffTimeout": 0.5}, {"animationCoolOffTimeout": 0}])
        routes = self.h.routes()
        source = routes.index("GET /source")
        toggles = [index for index, route in enumerate(routes) if route == "POST /appium/settings"]
        self.assertEqual(len(toggles), 2)
        self.assertLess(toggles[0], source)
        self.assertGreater(toggles[1], source)
        self.assertEqual(self.phone.accepted_actions, 1)  # the toggles are not phone actions

    def test_other_reads_and_the_default_do_not_toggle_settings(self):
        unsettled = self.make_harness()
        unsettled.warm()
        start = len(unsettled.fake.settings_history)
        unsettled.phone.tap(selector={"label": "Wi-Fi"}, observe="tree")
        self.assertEqual(unsettled.fake.settings_history[start:], [])
        self.h.warm()
        start = len(self.fake.settings_history)
        with fake_clock():
            self.phone.observe()
            self.phone.tap(x=10, y=10, observe="screenshot")
            self.phone.tap(x=10, y=10)
        self.assertEqual(self.toggles_since(start), [])

    def test_failed_toggle_never_fails_the_action_and_restores_settings_later(self):
        self.h.warm(viewport=True)
        start = len(self.fake.settings_history)
        self.fake.inject("POST", "/appium/settings", error="unknown error", message="settings lost")
        result = self.phone.tap(selector={"label": "Wi-Fi"}, observe="tree")
        self.assertTrue(result["action_complete"])
        self.assertIn("nodes", result["observation"])
        # The failed toggle made the client re-send the fast session settings before the read.
        self.assertEqual(self.toggles_since(start), [SESSION_SETTINGS])

    def test_speed_is_restored_when_the_read_fails(self):
        self.h.warm(viewport=True)
        self.fake.inject("GET", "/source", error="unknown error", message="snapshot failed")
        error = self.assert_code("unknown error",
                                 lambda: self.phone.tap(selector={"label": "Wi-Fi"}, observe="tree"))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertEqual(self.fake.settings_history[-1], {"animationCoolOffTimeout": 0})
        self.assertEqual(self.h.count("POST /element/:id/click"), 1)

    def test_post_action_screenshot_waits_briefly_only_when_settling_is_on(self):
        self.phone.settle_seconds = 0
        with fake_clock() as clock:
            self.phone.tap(x=10, y=10, observe="screenshot")
            self.assertEqual(clock.sleeps, [])
            self.phone.settle_seconds = 0.8
            self.phone.tap(x=10, y=10, observe="screenshot")
            self.assertEqual(clock.sleeps, [0.5])
            self.phone.observe("screenshot")
            self.assertEqual(clock.sleeps, [0.5])


class TelemetryTests(HarnessCase):
    def test_taps_and_drags_reach_the_preview_with_the_cached_viewport(self):
        screen = RecordingScreen()
        h = self.make_harness(screen=screen)
        h.phone.tap(x=100, y=200)
        h.phone.tap(selector={"label": "Wi-Fi"})
        h.phone.swipe()
        self.assertEqual(screen.viewports, [{"width": 390, "height": 844}])
        viewport = {"width": 390, "height": 844}
        self.assertEqual([g["kind"] for g in screen.gestures], ["tap", "tap", "drag"])
        self.assertEqual(screen.gestures[0]["point"], {"x": 100, "y": 200})
        self.assertEqual(screen.gestures[1]["point"], {"x": 195.0, "y": 369.0})  # Wi-Fi cell centre
        drag = screen.gestures[2]
        self.assertEqual(drag["duration_ms"], int((0.1 + 0.35) * 1000))  # clamp(int((hold + 0.35) s), 300, 3000)
        self.assertEqual(drag["from_point"], {"x": h.fake.drags[0]["fromX"], "y": h.fake.drags[0]["fromY"]})
        self.assertEqual(drag["to_point"], {"x": h.fake.drags[0]["toX"], "y": h.fake.drags[0]["toY"]})
        self.assertTrue(all(g["viewport"] == viewport for g in screen.gestures))

    def test_a_failing_preview_never_changes_the_phone_actions(self):
        quiet = self.make_harness()
        broken = self.make_harness(screen=RecordingScreen(fail=True))
        for harness in (quiet, broken):
            self.assertTrue(harness.phone.tap(x=100, y=200)["action_complete"])
            harness.phone.tap(selector={"label": "Wi-Fi"})
            harness.phone.swipe()
            harness.phone.type_text({"label": "Search"}, "abc")
        self.assertEqual(quiet.routes(), broken.routes())
        self.assertEqual(quiet.fake.drags, broken.fake.drags)
        self.assertEqual(broken.phone.accepted_actions, quiet.phone.accepted_actions)


class ContractTests(unittest.TestCase):
    """The interface other units code against (DESIGN.md 7.1) and the hygiene of model-facing text."""

    SIGNATURES = {
        "observe": [("mode", "tree"), ("include_invisible", False), ("max_nodes", 100),
                    ("expensive_visibility", False)],
        "find": [("selector", None), ("limit", 10)],
        "tap": [("selector", None), ("x", None), ("y", None), ("observation_id", None), ("expect", None),
                ("observe", "none")],
        "swipe": [("direction", "up"), ("region", None), ("observation_id", None), ("expect", None),
                  ("verify", False), ("observe", "none"), ("_baseline", None), ("_max_nodes", 100)],
        "type_text": [("selector", None), ("text", None), ("allow_newlines", False), ("submit", False),
                      ("replace", True), ("verify", False), ("expect", None), ("observe", "none"),
                      ("continue_token", None)],
        "press_button": [("name", None), ("verify", False), ("expect", None), ("observe", "none")],
        "launch_app": [("bundle_id", None), ("verify", False), ("expect", None), ("observe", "none")],
        "wait": [("selector", None), ("timeout_seconds", 6)],
        "scroll_find": [("selector", None), ("direction", "up"), ("max_swipes", 1)],
        "collect_list": [("row_type", "Cell"), ("max_pages", 6), ("end_selector", None)],
        "batch": [("steps", None)],
        "viewport": [("max_age", 0)],
        "active_app": [("timeout", None)],
        "capture": [("viewport", None)],
        "external_action": [],
        "reset": [],
    }

    def test_public_signatures_and_defaults(self):
        import inspect

        phone = wda_controller.PhoneController(object(), "/nonexistent-state")
        for name, expected in self.SIGNATURES.items():
            with self.subTest(name=name):
                parameters = inspect.signature(getattr(phone, name)).parameters.values()
                actual = [(p.name, None if p.default is inspect.Parameter.empty else p.default) for p in parameters]
                self.assertEqual(actual, expected)
        self.assertEqual(list(inspect.signature(wda_controller.PhoneController).parameters),
                         ["client", "state_dir", "screen", "runner"])

    def test_constants_and_knobs(self):
        phone = wda_controller.PhoneController(object(), "/tmp/state-for-contract")
        self.assertEqual((wda_controller.CALL_BUDGET, wda_controller.INPUT_TTL, wda_controller.VIEWPORT_TTL,
                          wda_controller.SNAPSHOT_LIMIT, wda_controller.CANDIDATE_LIMIT,
                          wda_controller.TYPING_FREQUENCY, wda_controller.TYPING_PIECE,
                          wda_controller.KEEP_ARTIFACTS), (60.0, 600.0, 30.0, 32, 8, 30, 200, 40))
        self.assertEqual(wda_controller.BATCH_OPS, ("tap", "swipe", "type_text", "launch_app", "press_button",
                                                    "wait", "observe", "scroll_find"))
        self.assertEqual(phone.artifacts_dir, Path("/tmp/state-for-contract/artifacts"))
        self.assertEqual((phone.accepted_actions, phone.settle_seconds, phone.call_budget, phone.typing_frequency,
                          phone.typing_piece, phone.keep_artifacts, phone.image_original, phone.sips_path,
                          phone.jpeg_quality), (0, 0.0, 60.0, 30, 200, 40, False, wda_image.SIPS_PATH, 80))
        self.assertIsNone(phone.pending_input)
        self.assertIsNone(phone.last_target)
        self.assertEqual(len(phone.snapshots), 0)

    def test_model_facing_strings_name_only_real_tools(self):
        import ast

        source = Path(wda_controller.__file__).read_text(encoding="utf-8")
        strings = [node.value for node in ast.walk(ast.parse(source))
                   if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        self.assertGreater(len(strings), 50)
        tools = set(re.findall(r"\biphone_[a-z][a-z_]*", " ".join(strings)))
        self.assertTrue(tools)
        self.assertLessEqual(tools, set(TOOL_NAMES))
        for text in strings:
            for token in ("functions.exec", "view_image", "PUA", "pua_", "Inspect the attached screenshot FIRST"):
                self.assertNotIn(token, text)


class UsbmuxSmokeTests(HarnessCase):
    def test_observe_and_coordinate_tap_through_usbmux(self):
        h = self.make_harness(via_usbmux=True)
        self.assertEqual(h.client.transport.identity, "usbmux:%s:8100" % UDID)
        observed = h.phone.observe()
        self.assertEqual(observed["app"], SETTINGS)
        self.assertIn("Wi-Fi", [node.get("label") for node in observed["nodes"]])
        result = h.phone.tap(x=195, y=369, observation_id=observed["observation_id"])
        self.assertTrue(result["action_executed"])
        self.assertEqual(h.fake.taps, [(195, 369)])
        self.assertTrue(any(port == 8100 and number == 0 for _, port, number in h.usbmuxd.connects))
        self.assertEqual(hint_problems(result), [])


if __name__ == "__main__":
    unittest.main()
