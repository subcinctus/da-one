import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import inspect  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import wda_controller  # noqa: E402
from fake_wda import Node, list_app  # noqa: E402
from phone_harness import HarnessCase, cell, fake_clock, modal  # noqa: E402

SETTINGS = "com.apple.Preferences"
FORM = "com.example.form"
SPRINGBOARD = "com.apple.springboard"
DRAG = "POST /wda/dragfromtoforduration"
AREA = {"x": 30, "y": 300, "width": 300, "height": 400}
MODAL_AREA = {"x": 70, "y": 250, "width": 200, "height": 250}


def target(y=200, hittable=True, type="TextField"):
    return Node(type, label="Target", rect=(70, y, 250, 44), hittable=hittable)


class SwipeDefaultTests(HarnessCase):
    def test_default_swipe_is_one_gesture_without_any_tree_read(self):
        self.h.warm()
        result = self.phone.swipe()
        self.assertEqual(result, {"action_executed": True, "action_complete": True, "verified": False,
                                  "verification_deferred": True, "strategy": "short_drag", "attempts": 1,
                                  "progress_verified": False})
        self.assertEqual(self.h.routes(), ["GET /window/size", DRAG])
        (drag,) = self.fake.drags
        self.assertEqual(set(drag), {"fromX", "fromY", "toX", "toY", "duration"})
        for key, value in (("fromX", 195), ("fromY", 557.04), ("toX", 195), ("toY", 286.96), ("duration", 0.1)):
            self.assertAlmostEqual(drag[key], value, places=6)
        self.assertEqual(self.phone.accepted_actions, 1)

    def test_direction_is_the_finger_movement(self):
        expected = {"down": (195, 286.96, 195, 557.04), "left": (282.36, 422, 107.64, 422),
                    "right": (107.64, 422, 282.36, 422)}
        for direction, points in expected.items():
            with self.subTest(direction=direction):
                h = self.make_harness()
                h.phone.swipe(direction)
                drag = h.fake.drags[0]
                for key, value in zip(("fromX", "fromY", "toX", "toY"), points):
                    self.assertAlmostEqual(drag[key], value, places=6)

    def test_default_custom_scroll_needs_no_tree_or_observation_id(self):
        result = self.phone.swipe(region=AREA)
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(len(self.fake.drags), 1)
        self.assertFalse(any(route in ("GET /source", "GET /screenshot", "GET /wda/activeAppInfo")
                             for route in self.h.routes()))

    def test_default_scroll_does_not_add_modal_verification_reads(self):
        self.h.show(cell("Row 1"), modal("Alert", y=100))
        result = self.phone.swipe()
        self.assertTrue(result["action_complete"])
        self.assertEqual(len(self.fake.drags), 1)
        self.assertEqual(self.h.count("GET /source"), 0)

    def test_default_swipe_observe_tree_reads_once_for_the_next_decision(self):
        self.h.show_pages([cell("Before")], [cell("Next page")])
        result = self.phone.swipe(observe="tree")
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(result["observation"]["nodes"][0]["label"], "Next page")
        self.assertEqual(self.h.count("GET /source"), 1)
        self.assertEqual(len(self.fake.drags), 1)

    def test_custom_scroll_tolerates_content_refresh_in_its_context(self):
        self.h.show(cell("Banner A", y=100), cell("Row 1", y=400))
        observed = self.phone.observe()
        self.h.show(cell("Banner A", y=100), cell("Different list content", y=400))
        self.fake.clear_log()
        result = self.phone.swipe(region=AREA, observation_id=observed["observation_id"])
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(len(self.fake.drags), 1)
        self.assertFalse(any(route in ("GET /source", "GET /screenshot") for route in self.h.routes()))

    def test_custom_scroll_rejects_a_changed_app_or_orientation_context(self):
        for change in ("app", "orientation"):
            with self.subTest(change=change):
                h = self.make_harness()
                h.show(cell("Row"))
                observed = h.phone.observe()
                if change == "app":
                    h.fake.set_foreground(SETTINGS)
                else:
                    h.fake.size = (844, 390)
                self.assert_code("stale_observation", lambda: h.phone.swipe(
                    region={"x": 30, "y": 100, "width": 300, "height": 250},
                    observation_id=observed["observation_id"]))
                self.assertEqual(h.fake.actions(), [])

    def test_supplied_scroll_context_from_another_runtime_is_rejected(self):
        observed = self.phone.observe("both")
        other = wda_controller.PhoneController(self.h.client, self.h.state_dir)
        self.fake.clear_log()
        error = self.assert_code("stale_observation", lambda: other.swipe(observation_id=observed["observation_id"]))
        self.assertEqual(error.details["reason"], "unknown_observation")
        self.assertEqual(self.fake.requests, [])

    def test_custom_scroll_accepts_a_screenshot_context_or_an_empty_tree(self):
        for mode in ("screenshot", "tree"):
            with self.subTest(mode=mode):
                h = self.make_harness()
                h.show()
                observed = h.phone.observe(mode)
                h.phone.snapshots[observed["observation_id"]]["time"] -= 3600
                h.fake.clear_log()
                result = h.phone.swipe(region=AREA, observation_id=observed["observation_id"])
                self.assertTrue(result["action_executed"])
                self.assertEqual(len(h.fake.drags), 1)
                self.assertFalse(any(route in ("GET /source", "GET /screenshot") for route in h.routes()))

    def test_bad_regions_and_arguments_fail_before_any_gesture(self):
        self.h.warm(viewport=True)
        for arguments in ({"region": {"x": 200, "y": 300, "width": 300, "height": 100}},
                          {"region": {"x": 0, "y": 0, "width": 390, "height": 845}},
                          {"region": {"x": 0, "y": 0, "width": 0, "height": 100}},
                          {"region": {"x": 0, "y": 0, "width": 10, "height": 10, "z": 1}},
                          {"region": [0, 0, 10, 10]}, {"direction": "sideways"}, {"observe": "image"},
                          {"verify": "yes"}):
            with self.subTest(arguments=arguments):
                error = self.assert_code("invalid_argument", lambda: self.phone.swipe(**arguments))
                self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.fake.actions(), [])
        self.assertEqual(self.fake.drags, [])

    def test_max_attempts_no_longer_exists(self):
        self.assertNotIn("max_attempts", inspect.signature(self.phone.swipe).parameters)
        with self.assertRaises(TypeError):
            self.phone.swipe(verify=True, max_attempts=2)
        self.assertEqual(self.fake.requests, [])

    def test_an_uncertain_first_gesture_does_not_claim_an_accepted_action(self):
        self.fake.inject("POST", "/wda/dragfromtoforduration", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.swipe())
        self.assertTrue(error.uncertain)
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.phone.accepted_actions, 0)
        self.assertEqual(self.h.actions(), [DRAG])


class SwipeVerifyTests(HarnessCase):
    def test_progress_is_verified_with_every_observe_mode(self):
        for mode in ("none", "tree", "screenshot", "both"):
            with self.subTest(mode=mode):
                h = self.make_harness()
                h.show_pages([cell("Row 1", y=350)], [cell("Row 1", y=300), cell("Row 2", y=350)])
                result = h.phone.swipe(verify=True, observe=mode)
                self.assertTrue(result["verified"])
                self.assertTrue(result["changed"])
                self.assertTrue(result["progress_verified"])
                self.assertFalse(result["verification_deferred"])
                self.assertEqual((result["attempts"], result["strategy"]), (1, "short_drag"))
                self.assertIn("whether the list is complete is separate", result["verification_scope"])
                self.assertEqual(len(h.fake.drags), 1)
                self.assertEqual(h.count("GET /source"), 2)
                if mode == "none":
                    self.assertNotIn("observation", result)
                else:
                    observed = result["observation"]
                    self.assertIn(observed["observation_id"], h.phone.snapshots)
                    self.assertEqual("image" in observed, mode in ("screenshot", "both"))
                    self.assertEqual("nodes" in observed, mode in ("tree", "both"))
                self.assertEqual(h.count("GET /screenshot"), 1 if mode in ("screenshot", "both") else 0)

    def test_custom_scroll_ignores_carousel_changes_outside_its_region(self):
        for mode in ("tree", "both"):
            with self.subTest(mode=mode):
                h = self.make_harness()
                h.show(cell("Banner A", y=100), cell("Row 1", y=400))
                observed = h.phone.observe(mode)
                h.show_pages([cell("Banner B", y=100), cell("Row 1", y=400)],
                             [cell("Banner C", y=100), cell("Row 1", y=350), cell("Row 2", y=400)])
                h.fake.clear_log()
                result = h.phone.swipe(region=AREA, observation_id=observed["observation_id"], verify=True)
                self.assertTrue(result["verified"])
                self.assertEqual(h.actions(), [DRAG])
                self.assertEqual(h.count("GET /screenshot"), 0)

    def test_custom_scroll_keeps_anchors_beyond_response_truncation(self):
        self.h.show(cell("Banner", y=100), cell("Row 1", y=400))
        observed = self.phone.observe(max_nodes=1)
        self.assertTrue(observed["truncated"])
        self.h.show_pages([cell("Banner", y=100), cell("Row 1", y=400)],
                          [cell("Banner", y=100), cell("Row 1", y=350), cell("Row 2", y=400)])
        result = self.phone.swipe(verify=True, region=AREA, observation_id=observed["observation_id"])
        self.assertTrue(result["verified"])
        self.assertEqual(len(self.fake.drags), 1)

    def test_verified_scroll_requires_an_explicit_region_when_a_native_modal_is_present(self):
        for kind in ("Alert", "Sheet"):
            with self.subTest(kind=kind):
                h = self.make_harness()
                h.show(cell("Row 1"), modal(kind))
                error = self.assert_code("modal_requires_region", lambda: h.phone.swipe(verify=True, observe="tree"))
                self.assertFalse(error.details["action_executed"])
                self.assertFalse(error.details["verified"])
                self.assertEqual(error.details["native_modals"], [{"type": kind, "rect": [40, 100, 310, 600]}])
                self.assertEqual(error.details["region"], {"x": 58.5, "y": 211.0, "width": 273.0, "height": 422.0})
                self.assertIn("nodes", error.details["observation"])
                self.assertIn("image", error.details["observation"])
                self.assertEqual(error.details["recovery"]["use"], "screenshot")
                self.assertEqual(h.fake.actions(), [])

    def test_a_fresh_explicit_region_inside_a_native_modal_can_scroll(self):
        for kind in ("Alert", "Sheet"):
            with self.subTest(kind=kind):
                h = self.make_harness()
                h.show(modal(kind), cell("Row 1", y=300))
                observed = h.phone.observe("both")
                h.show_pages([modal(kind), cell("Row 1", y=300)],
                             [modal(kind), cell("Row 1", y=270), cell("Row 2", y=300)])
                h.fake.clear_log()
                result = h.phone.swipe(verify=True, region=MODAL_AREA, observation_id=observed["observation_id"],
                                       observe="tree")
                self.assertTrue(result["verified"])
                self.assertTrue(result["changed"])
                self.assertEqual(h.actions(), [DRAG])

    def test_an_explicit_region_outside_or_crossing_a_native_modal_is_blocked(self):
        for area in ({"x": 70, "y": 200, "width": 200, "height": 150},
                     {"x": 70, "y": 400, "width": 200, "height": 200}):
            with self.subTest(area=area):
                h = self.make_harness()
                h.show(cell("Row 1", y=area["y"] + 25), modal("Sheet", y=500, height=200))
                observed = h.phone.observe("tree")
                h.fake.clear_log()
                error = self.assert_code("blocked_scroll_region", lambda: h.phone.swipe(
                    verify=True, region=area, observation_id=observed["observation_id"]))
                self.assertFalse(error.details["action_executed"])
                self.assertEqual(h.fake.actions(), [])

    def test_a_region_inside_a_sheet_but_crossing_a_coexisting_alert_is_blocked(self):
        self.h.show(modal("Sheet"), modal("Alert", x=90, y=300, width=170, height=100), cell("Synthetic row", y=350))
        observed = self.phone.observe("tree")
        self.fake.clear_log()
        error = self.assert_code("blocked_scroll_region", lambda: self.phone.swipe(
            verify=True, region=MODAL_AREA, observation_id=observed["observation_id"]))
        self.assertEqual(len(error.details["native_modals"]), 2)
        self.assertEqual(self.fake.actions(), [])

    def test_a_fresh_region_inside_all_coexisting_native_modals_can_scroll(self):
        area = {"x": 100, "y": 300, "width": 150, "height": 100}
        sheet = lambda: modal("Sheet")  # noqa: E731
        alert = lambda: modal("Alert", x=90, y=250, width=170, height=200)  # noqa: E731
        self.h.show(sheet(), alert(), cell("Synthetic row 1", x=100, y=325, width=150))
        observed = self.phone.observe("tree")
        self.h.show_pages([sheet(), alert(), cell("Synthetic row 1", x=100, y=325, width=150)],
                          [sheet(), alert(), cell("Synthetic row 1", x=100, y=315, width=150),
                           cell("Synthetic row 2", x=100, y=350, width=150)])
        self.fake.clear_log()
        result = self.phone.swipe(verify=True, region=area, observation_id=observed["observation_id"])
        self.assertTrue(result["changed"])
        self.assertEqual(self.h.actions(), [DRAG])

    def test_a_verified_region_inside_a_native_modal_needs_no_prior_observation(self):
        self.h.show_pages([modal("Sheet"), cell("First row", y=350)], [modal("Sheet"), cell("First row", y=300)])
        result = self.phone.swipe(region=MODAL_AREA, verify=True)
        self.assertTrue(result["progress_verified"])
        self.assertEqual(len(self.fake.drags), 1)

    def test_a_modal_appearing_after_the_gesture_is_not_scroll_progress(self):
        for placement in ("inside", "outside"):
            for mode in ("none", "tree", "screenshot", "both"):
                with self.subTest(placement=placement, mode=mode):
                    h = self.make_harness()
                    y = 300 if placement == "inside" else 60
                    h.show_pages([cell("Row 1")], [cell("Row 2"), modal("Alert", x=80, y=y, width=230, height=80)])
                    error = self.assert_code("scroll_context_changed",
                                             lambda: h.phone.swipe(verify=True, observe=mode))
                    details = error.details
                    self.assertTrue(details["action_executed"])
                    self.assertFalse(details["action_complete"])
                    self.assertFalse(details["verified"])
                    self.assertFalse(details["changed"])
                    self.assertEqual(details["attempts"], 1)
                    self.assertEqual(details["reasons"], ["modal_changed"])
                    self.assertFalse(details["recovery"]["same_gesture_retry"])
                    self.assertFalse(details["recovery"]["replay_action"])
                    self.assertEqual(h.actions(), [DRAG])
                    observed = details["observation"]
                    self.assertIn(observed["observation_id"], h.phone.snapshots)
                    self.assertIn("image", observed)
                    self.assertEqual("nodes" in observed, mode in ("tree", "both"))
                    self.assertEqual(h.count("GET /screenshot"), 1)
                    if "nodes" in observed:
                        self.assertTrue(any(node["type"] == "Alert" for node in observed["nodes"]))

    def test_modal_disappearance_or_geometry_change_stops_an_intentional_modal_scroll(self):
        for change in ("removed", "moved"):
            with self.subTest(change=change):
                h = self.make_harness()
                h.show(modal("Sheet"), cell("Row 1", y=300))
                observed = h.phone.observe("tree")
                current = [cell("Row 2", y=300)]
                if change == "moved":
                    current.append(modal("Sheet", y=120))
                h.show_pages([modal("Sheet"), cell("Row 1", y=300)], current)
                h.fake.clear_log()
                error = self.assert_code("scroll_context_changed", lambda: h.phone.swipe(
                    verify=True, region=MODAL_AREA, observation_id=observed["observation_id"]))
                self.assertEqual(error.details["attempts"], 1)
                self.assertEqual(error.details["reasons"], ["modal_changed"])
                self.assertEqual(h.actions(), [DRAG])

    def test_an_orientation_change_after_the_gesture_stops_before_any_progress_check(self):
        self.h.show_pages([cell("Row 1", y=350)], [cell("Row 1", y=300), cell("Row 2", y=350)])
        self.fake.on_drag = lambda fake, drag: setattr(fake, "size", (844, 390))
        error = self.assert_code("scroll_context_changed", lambda: self.phone.swipe(verify=True, observe="tree"))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["changed"])
        self.assertEqual(error.details["reasons"], ["viewport_changed"])
        self.assertEqual(error.details["observation"]["viewport"], {"width": 844, "height": 390,
                                                                    "units": "iPhone points"})
        self.assertEqual(self.h.actions(), [DRAG])

    def test_modal_and_orientation_changes_are_both_reported_after_one_gesture(self):
        self.h.show_pages([cell("Row 1")], [cell("Row 2"), modal("Sheet", y=80)])
        self.fake.on_drag = lambda fake, drag: setattr(fake, "size", (844, 390))
        error = self.assert_code("scroll_context_changed", lambda: self.phone.swipe(verify=True))
        self.assertEqual(set(error.details["reasons"]), {"viewport_changed", "modal_changed"})
        self.assertEqual(self.h.actions(), [DRAG])

    def test_arbitrary_other_nodes_are_not_treated_as_native_modals(self):
        overlay = lambda: Node("Other", label="Custom overlay", rect=(40, 100, 310, 600))  # noqa: E731
        self.h.show_pages([cell("Row 1", y=350), overlay()],
                          [cell("Row 1", y=300), cell("Row 2", y=350), overlay()])
        result = self.phone.swipe(verify=True)
        self.assertTrue(result["verified"])
        self.assertEqual(len(self.fake.drags), 1)

    def test_no_progress_stops_before_any_second_gesture(self):
        self.h.show_pages([cell("Row 1")], [cell("Row 1")], [cell("Row 1"), modal("Alert", y=80)])
        error = self.assert_code("no_scroll_progress", lambda: self.phone.swipe(verify=True))
        details = error.details
        self.assertTrue(details["action_executed"])
        self.assertFalse(details["verified"])
        self.assertFalse(details["changed"])
        self.assertEqual(details["attempts"], 1)
        self.assertEqual(details["region"], {"x": 58.5, "y": 211.0, "width": 273.0, "height": 422.0})
        self.assertIn("image", details["observation"])
        self.assertNotIn("nodes", details["observation"])
        recovery = details["recovery"]
        self.assertTrue(recovery["visual_check_required"])
        self.assertFalse(recovery["same_gesture_retry"])
        self.assertFalse(recovery["end_of_list_proven"])
        self.assertNotIn("next_tool", recovery)
        self.assertEqual(recovery["next_step"], wda_controller.SCROLL_STEP + wda_controller.STEP_SUFFIX)
        self.assertEqual(self.h.actions(), [DRAG])

    def test_refreshes_at_fixed_geometry_are_not_scroll_progress(self):
        for change in ("value", "label", "width", "opposite_direction"):
            with self.subTest(change=change):
                h = self.make_harness()
                before = cell("Counter 100", y=350, identifier="Stable row", value="100.00")
                after = {"value": dict(label="Counter 100", y=350, identifier="Stable row", value="100.25"),
                         "label": dict(label="Counter 200", y=350, identifier="Stable row", value="100.00"),
                         "width": dict(label="Counter 100", y=300, width=300, identifier="Stable row",
                                       value="100.00"),
                         "opposite_direction": dict(label="Counter 100", y=400, identifier="Stable row",
                                                    value="100.00")}[change]
                label = after.pop("label")
                h.show_pages([before], [cell(label, **after)])
                error = self.assert_code("no_scroll_progress", lambda: h.phone.swipe(verify=True))
                self.assertTrue(error.details["action_executed"])
                self.assertFalse(error.details["changed"])
                self.assertEqual(len(h.fake.drags), 1)

    def test_a_stable_name_verifies_movement_while_label_and_value_refresh(self):
        self.h.show_pages([cell("Balance 100", y=350, identifier="Stable row", value="100.00")],
                          [cell("Balance 200", y=300, identifier="Stable row", value="200.00")])
        result = self.phone.swipe(verify=True)
        self.assertTrue(result["progress_verified"])

    def test_duplicate_anchor_labels_do_not_create_false_progress(self):
        self.h.show_pages([cell("Repeated row", y=350), cell("Repeated row", y=450)],
                          [cell("Repeated row", y=300), cell("Repeated row", y=400)])
        error = self.assert_code("no_scroll_progress", lambda: self.phone.swipe(verify=True))
        self.assertFalse(error.details["changed"])
        self.assertEqual(len(self.fake.drags), 1)

    def test_no_progress_returns_the_requested_tree_and_a_screenshot(self):
        self.h.show(cell("Row 1"))
        error = self.assert_code("no_scroll_progress", lambda: self.phone.swipe(verify=True, observe="both"))
        observed = error.details["observation"]
        self.assertEqual(observed["nodes"][0]["label"], "Row 1")
        self.assertIn("image", observed)
        self.assertIn(observed["observation_id"], self.phone.snapshots)
        self.assertEqual(self.h.count("GET /source"), 2)
        self.assertEqual(self.h.count("GET /screenshot"), 1)

    def test_another_swipe_requires_a_new_call_after_the_visual_fallback(self):
        self.h.show_pages([cell("Row 1", y=350)], [cell("Row 1", y=350)],
                          [cell("Row 1", y=300), cell("Row 2", y=350)])
        error = self.assert_code("no_scroll_progress", lambda: self.phone.swipe(verify=True, observe="tree"))
        self.assertEqual(len(self.fake.drags), 1)
        self.assertIn("image", error.details["observation"])
        result = self.phone.swipe(verify=True, observe="tree")
        self.assertTrue(result["verified"])
        self.assertEqual(len(self.fake.drags), 2)
        self.assertEqual(result["observation"]["nodes"][-1]["label"], "Row 2")

    def test_a_tree_read_failure_after_the_gesture_keeps_the_evidence_without_retry(self):
        self.h.show(cell("Row 1"))
        self.fake.on_drag = lambda fake, drag: fake.inject("GET", "/source", error="stale element reference",
                                                           message="Application local.pid.0 is not running")
        error = self.assert_code("stale element reference", lambda: self.phone.swipe(verify=True, observe="tree"))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertIn("verification_required", error.details)
        self.assertEqual(error.details["attempts"], 1)
        self.assertEqual(self.phone.accepted_actions, 1)
        self.assertEqual(self.h.actions(), [DRAG])

    def test_a_screenshot_failure_after_progress_keeps_the_evidence(self):
        self.h.show_pages([cell("Row 1", y=350)], [cell("Row 1", y=300), cell("Row 2", y=350)])
        self.fake.inject("GET", "/screenshot", error="unable to capture screen")
        error = self.assert_code("unable to capture screen", lambda: self.phone.swipe(verify=True, observe="both"))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertEqual(self.h.actions(), [DRAG])

    def test_a_screenshot_failure_keeps_the_no_progress_failure_and_its_tree(self):
        self.h.show(cell("Row 1"))
        self.fake.inject("GET", "/screenshot", error="unable to capture screen")
        error = self.assert_code("no_scroll_progress", lambda: self.phone.swipe(verify=True, observe="both"))
        self.assertEqual(error.details["observation_error"]["code"], "unable to capture screen")
        self.assertEqual(error.details["observation"]["nodes"][0]["label"], "Row 1")
        self.assertEqual(error.details["recovery"]["next_tool"], "iphone_observe")
        self.assertEqual(self.h.count("GET /screenshot"), 1)


class LaunchTests(HarnessCase):
    def test_default_launch_accepts_navigation_without_polling(self):
        self.fake.activate_effective = False
        self.h.warm()
        result = self.phone.launch_app(FORM)
        self.assertEqual(result, {"action_executed": True, "action_complete": True, "verified": False,
                                  "verification_deferred": True, "foreground_verified": False})
        self.assertEqual(self.h.routes(), ["POST /wda/apps/activate"])
        self.assertEqual(self.fake.calls(route="/wda/apps/activate")[0].body, {"bundleId": FORM})

    def test_launch_waits_for_the_foreground_without_reactivating(self):
        self.fake.foreground_sequence = [SETTINGS, SETTINGS, FORM]
        with fake_clock() as clock:
            result = self.phone.launch_app(FORM, verify=True)
        self.assertTrue(result["verified"])
        self.assertTrue(result["foreground_verified"])
        self.assertFalse(result["verification_deferred"])
        self.assertEqual(result["verification_scope"], "The requested app is in front; the user's task is separate.")
        self.assertGreater(len(clock.sleeps), 0)
        self.assertLessEqual(clock.monotonic() - 1000.0, 5)
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 3)

    def test_a_transient_unknown_foreground_counts_as_not_yet(self):
        self.fake.foreground_sequence = ["local.pid.4242", FORM]
        with fake_clock():
            result = self.phone.launch_app(FORM, verify=True)
        self.assertTrue(result["foreground_verified"])
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 2)
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])

    def test_a_persistent_unknown_foreground_is_a_channel_fault_at_the_deadline(self):
        self.fake.foreground_sequence = ["local.pid.4242"]
        with fake_clock() as clock:
            error = self.assert_code("foreground_unavailable", lambda: self.phone.launch_app(FORM, verify=True))
        self.assertAlmostEqual(clock.monotonic() - 1000.0, 5, places=6)
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertIn("verification_required", error.details)
        self.assertEqual(error.details["recovery"]["next_tool"], "iphone_ready")
        self.assertNotIn("observation", error.details)
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])

    def test_a_foreground_mismatch_has_bounded_reads_and_execution_evidence(self):
        self.fake.activate_effective = False
        with fake_clock() as clock, mock.patch.object(self.phone, "active_app", wraps=self.phone.active_app) as spy:
            error = self.assert_code("postcondition_failed", lambda: self.phone.launch_app(FORM, verify=True))
        details = error.details
        self.assertTrue(details["action_executed"])
        self.assertFalse(details["action_complete"])
        self.assertEqual((details["requested_app"], details["foreground_app"]), (FORM, SETTINGS))
        self.assertFalse(details["foreground_verified"])
        self.assertFalse(details["recovery"]["replay_action"])
        self.assertEqual(details["observation"]["app"], SETTINGS)  # screenshot built from the known foreground
        self.assertIn("image", details["observation"])
        self.assertAlmostEqual(clock.monotonic() - 1000.0, 5, places=6)
        reads = self.h.count("GET /wda/activeAppInfo")
        self.assertGreater(reads, 1)
        self.assertLessEqual(reads, 60)
        self.assertEqual(spy.call_count, reads)
        self.assertTrue(all(call.kwargs["timeout"] > 0 for call in spy.call_args_list))
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])

    def test_an_uncertain_launch_is_neither_replayed_nor_polled(self):
        self.fake.inject("POST", "/wda/apps/activate", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.launch_app(FORM, verify=True))
        self.assertTrue(error.uncertain)
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.phone.accepted_actions, 0)
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 0)
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])

    def test_a_channel_failure_after_activation_is_not_replayed(self):
        self.fake.inject("GET", "/wda/activeAppInfo", error="unknown error",
                         message="XCTDaemonErrorDomain Code=41 Not authorized for performing UI testing actions")
        error = self.assert_code("unknown error", lambda: self.phone.launch_app(FORM, verify=True))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 1)
        self.assertEqual(self.h.actions(), ["POST /wda/apps/activate"])

    def test_launch_observation_reads_the_current_page_without_a_poll_loop(self):
        result = self.phone.launch_app(FORM, observe="tree")
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(result["observation"]["app"], FORM)
        self.assertLessEqual(self.h.count("GET /wda/activeAppInfo"), 1)
        self.assertEqual(self.h.count("GET /source"), 1)

    def test_an_app_that_is_not_installed_is_a_plain_wda_error(self):
        error = self.assert_code("invalid argument", lambda: self.phone.launch_app("com.example.missing"))
        self.assertFalse(error.uncertain)
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.phone.accepted_actions, 0)

    def test_malformed_bundle_ids_fail_before_any_request(self):
        for bundle_id in ("", "Notes", "com..notes", "com.apple notes", "com.apple.notes/", 5, None):
            with self.subTest(bundle_id=bundle_id):
                error = self.assert_code("invalid_argument", lambda: self.phone.launch_app(bundle_id))
                self.assertIn("iphone_apps", error.message)
        for arguments in ({"verify": "true"}, {"observe": "image"}):
            with self.subTest(arguments=arguments):
                self.assert_code("invalid_argument", lambda: self.phone.launch_app(FORM, **arguments))
        self.assertEqual(self.fake.requests, [])


class HomeAndVolumeTests(HarnessCase):
    def test_home_with_verify_requires_foreground_evidence(self):
        with fake_clock():
            result = self.phone.press_button("home", verify=True)
        self.assertTrue(result["verified"])
        self.assertTrue(result["foreground_verified"])
        self.assertEqual(result["foreground_app"], SPRINGBOARD)
        self.assertEqual(result["verification_scope"], "The Home Screen is in front.")
        self.assertEqual(self.fake.foreground, SPRINGBOARD)
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])
        self.assertIsNone(self.fake.calls(route="/wda/homescreen")[0].sid)  # WDA's sessionless endpoint
        self.assertGreaterEqual(self.h.count("GET /wda/activeAppInfo"), 1)

    def test_default_home_is_exactly_one_request(self):
        self.fake.home_effective = False
        result = self.phone.press_button("home")
        self.assertTrue(result["action_complete"])
        self.assertFalse(result["foreground_verified"])
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(self.h.routes(), ["POST /wda/homescreen"])
        self.assertEqual(self.fake.calls()[0].body, {})

    def test_home_without_a_foreground_change_is_a_failure(self):
        self.fake.home_effective = False
        with fake_clock():
            error = self.assert_code("postcondition_failed", lambda: self.phone.press_button("home", verify=True))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertFalse(error.details["home_foreground_verified"])
        self.assertEqual(error.details["foreground_app"], SETTINGS)
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.foreground, SETTINGS)
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])

    def test_an_uncertain_home_is_not_replayed(self):
        self.fake.inject("POST", "/wda/homescreen", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.press_button("home"))
        self.assertTrue(error.uncertain)
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])
        self.assertEqual(self.h.count("GET /wda/activeAppInfo"), 0)

    def test_a_read_failure_after_home_keeps_the_execution_evidence(self):
        self.fake.inject("GET", "/wda/activeAppInfo", drop=True, times=2)
        error = self.assert_code("service_unreachable", lambda: self.phone.press_button("home", verify=True))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["home_foreground_verified"])
        self.assertIn("Home was pressed", error.details["verification_required"])
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])

    def test_volume_buttons_are_sent_once_and_stay_unverified(self):
        for name in ("volumeup", "volumedown"):
            with self.subTest(name=name):
                h = self.make_harness()
                result = h.phone.press_button(name, verify=True)
                self.assertTrue(result["action_executed"])
                self.assertFalse(result["verified"])
                self.assertEqual(h.actions(), ["POST /wda/pressButton"])
                self.assertEqual(h.fake.calls(route="/wda/pressButton")[0].body, {"name": name})
                self.assertEqual(h.fake.buttons, [name])
                self.assertEqual(h.fake.foreground, SETTINGS)

    def test_unknown_buttons_fail_before_any_request(self):
        for name in ("power", "Home", None):
            with self.subTest(name=name):
                self.assert_code("invalid_argument", lambda: self.phone.press_button(name))
        self.assertEqual(self.fake.requests, [])


class WaitTests(HarnessCase):
    def test_presence_is_reported_with_its_limits(self):
        self.assertEqual(self.phone.wait({"label": "Wi-Fi"}), {
            "verified": True, "matches": 1, "polls": 1,
            "criterion": "selector exists; presence alone does not prove business success"})

    def test_each_poll_request_is_capped_at_two_seconds(self):
        with fake_clock(), mock.patch.object(self.h.client, "session", wraps=self.h.client.session) as spy:
            self.phone.wait({"label": "Wi-Fi"}, timeout_seconds=8)
        timeouts = [call.kwargs.get("timeout") for call in spy.call_args_list if call.args[1] == "/elements"]
        self.assertEqual(timeouts, [2.0])

    def test_later_polls_use_the_remaining_deadline(self):
        original = self.h.client.session
        timeouts = []

        def first_missing_then_found(method, path, payload=None, timeout=None):
            if path == "/elements":
                timeouts.append(timeout)
                if len(timeouts) == 1:
                    return []
            return original(method, path, payload, timeout=timeout)

        with fake_clock() as clock, mock.patch.object(self.h.client, "session", side_effect=first_missing_then_found):
            result = self.phone.wait({"label": "Wi-Fi"}, timeout_seconds=1)
        self.assertEqual(result["polls"], 2)
        self.assertEqual(timeouts, [1.0, 0.75])
        self.assertEqual(clock.sleeps, [0.25])

    def test_a_zero_wait_is_exactly_one_short_probe(self):
        with fake_clock(), mock.patch.object(self.h.client, "session", wraps=self.h.client.session) as spy:
            error = self.assert_code("postcondition_failed",
                                     lambda: self.phone.wait({"label": "Missing"}, timeout_seconds=0))
        self.assertEqual(error.details["polls"], 1)
        self.assertEqual([call.kwargs.get("timeout") for call in spy.call_args_list if call.args[1] == "/elements"],
                         [0.5])
        self.assertIn("image", error.details["observation"])
        self.assertFalse(error.details["action_executed"])

    def test_a_timeout_ends_after_bounded_polls(self):
        with fake_clock() as clock:
            error = self.assert_code("postcondition_failed",
                                     lambda: self.phone.wait({"label": "Missing"}, timeout_seconds=1))
        self.assertEqual(error.details["polls"], 5)
        self.assertEqual(error.message, "The expected element did not appear in time.")
        self.assertTrue(all(0 <= pause <= 0.25 for pause in clock.sleeps))
        self.assertEqual(self.h.count("POST /elements"), 5)

    def test_the_selector_index_is_honoured(self):
        self.assertTrue(self.phone.wait({"label": "Wi-Fi", "index": 0}, timeout_seconds=0)["verified"])
        with fake_clock():
            self.assert_code("postcondition_failed",
                             lambda: self.phone.wait({"label": "Wi-Fi", "index": 1}, timeout_seconds=0))

    def test_arguments_are_checked_before_any_request(self):
        for timeout in (-1, 21, float("nan"), True, "6"):
            with self.subTest(timeout=timeout):
                self.assert_code("invalid_argument", lambda: self.phone.wait({"label": "Wi-Fi"}, timeout))
        self.assert_code("invalid_selector", lambda: self.phone.wait({"text": "Wi-Fi"}))
        self.assertEqual(self.fake.requests, [])

    def test_an_answer_that_is_not_a_list_is_an_invalid_response(self):
        self.fake.inject("POST", "/elements", value={"unexpected": True})
        self.assert_code("invalid_response", lambda: self.phone.wait({"label": "Wi-Fi"}))


class ScrollFindTests(HarnessCase):
    def test_a_visible_match_reuses_the_one_query_for_hittability(self):
        for rich in (True, False):
            with self.subTest(rich=rich):
                h = self.make_harness()
                h.show(target())
                h.fake.rich_elements = rich
                result = h.phone.scroll_find({"label": "Target"}, max_swipes=0)
                self.assertEqual((result["verified"], result["action_executed"], result["swipes"], result["matches"]),
                                 (True, False, 0, 1))
                expected = {"index": 0, "type": "TextField", "label": "Target", "rect": [70, 200, 250, 44],
                            "tap": [195, 222], "hittable": True}
                if not rich:  # bare ids carry no inline attributes; only the rect is read
                    del expected["type"], expected["label"]
                self.assertEqual(result["target"], expected)
                self.assertEqual(h.count("POST /elements"), 1)
                self.assertEqual(h.count("GET /element/:id/rect"), 0 if rich else 1)
                self.assertEqual(h.count("GET /element/:id/attribute/hittable"), 1)
                self.assertEqual(h.fake.actions(), [])

    def test_one_lightweight_swipe_then_one_more_query(self):
        node = target(y=900)
        self.h.show(node)
        self.fake.on_drag = lambda fake, drag: setattr(node, "rect", (70, 200, 250, 44))
        result = self.phone.scroll_find({"label": "Target"})
        self.assertEqual((result["verified"], result["action_executed"], result["swipes"]), (True, True, 1))
        self.assertEqual(self.h.count("POST /elements"), 2)
        self.assertEqual(self.h.actions(), [DRAG])
        self.assertEqual(self.h.count("GET /source"), 0)

    def test_an_unresolved_search_returns_the_screen_after_one_swipe(self):
        error = self.assert_code("search_exhausted", lambda: self.phone.scroll_find({"label": "Missing"}))
        details = error.details
        self.assertEqual((details["swipes"], details["max_swipes"], details["stop_reason"]),
                         (1, 1, "visual_check_required"))
        self.assertTrue(details["recovery"]["visual_check_required"])
        self.assertEqual(details["recovery"]["use"], "coordinates")
        self.assertTrue(details["action_executed"])
        self.assertFalse(details["action_complete"])
        self.assertEqual(self.h.actions(), [DRAG])
        self.assertEqual(self.h.count("POST /elements"), 2)
        self.assertEqual(self.h.count("GET /screenshot"), 1)
        self.assertEqual(self.h.count("GET /source"), 0)

    def test_a_covered_target_stops_before_any_swipe(self):
        self.h.show(target(hittable=False))
        error = self.assert_code("occluded_target", lambda: self.phone.scroll_find({"label": "Target"}))
        self.assertEqual(error.details["swipes"], 0)
        self.assertFalse(error.details["action_executed"])
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.actions(), [])

    def test_several_separate_matches_stop_before_any_swipe(self):
        self.h.show(target(), target(y=400))
        error = self.assert_code("ambiguous_target", lambda: self.phone.scroll_find({"label": "Target"}))
        self.assertEqual(error.details["swipes"], 0)
        self.assertEqual(self.fake.actions(), [])

    def test_a_target_still_offscreen_after_one_swipe_stops(self):
        self.h.show(target(y=900))
        error = self.assert_code("offscreen_target", lambda: self.phone.scroll_find({"label": "Target"}))
        self.assertEqual(error.details["swipes"], 1)
        self.assertTrue(error.details["action_executed"])
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.h.actions(), [DRAG])

    def test_a_zero_budget_returns_the_screen_without_a_gesture(self):
        error = self.assert_code("search_exhausted", lambda: self.phone.scroll_find({"label": "Missing"}, max_swipes=0))
        self.assertEqual(error.details["swipes"], 0)
        self.assertFalse(error.details["action_executed"])
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.actions(), [])

    def test_more_than_one_swipe_is_refused_before_any_request(self):
        for arguments in ({"max_swipes": 2}, {"max_swipes": -1}, {"max_swipes": True}, {"direction": "back"}):
            with self.subTest(arguments=arguments):
                self.assert_code("invalid_argument", lambda: self.phone.scroll_find({"label": "Wi-Fi"}, **arguments))
        self.assert_code("invalid_selector", lambda: self.phone.scroll_find({"text": "Wi-Fi"}))
        self.assertEqual(self.fake.requests, [])

    def test_a_screenshot_failure_keeps_the_search_result(self):
        self.fake.inject("GET", "/screenshot", error="unable to capture screen")
        error = self.assert_code("search_exhausted", lambda: self.phone.scroll_find({"label": "Missing"}))
        self.assertTrue(error.details["action_executed"])
        self.assertEqual(error.details["observation_error"]["code"], "unable to capture screen")
        self.assertEqual(error.details["recovery"]["next_arguments"], {"mode": "screenshot"})
        self.assertEqual(len(self.fake.drags), 1)
        self.assertEqual(self.h.count("GET /screenshot"), 1)


class CollectListTests(HarnessCase):
    def labels(self, result):
        return [row["label"] for row in result["rows"]]

    def test_no_completeness_is_claimed_at_the_page_budget(self):
        self.h.show_pages([cell("Row 1", y=350)], [cell("Row 1", y=300), cell("Row 2", y=350)])
        result = self.phone.collect_list(max_pages=2)
        self.assertEqual(set(result), {"rows", "pages", "stop_reason", "end_marker_seen", "complete",
                                       "coverage_verified", "limitations"})
        self.assertEqual(self.labels(result), ["Row 1", "Row 2"])
        self.assertEqual(result["pages"], [{"page": 1, "rows_seen": 1, "truncated": False},
                                           {"page": 2, "rows_seen": 2, "truncated": False}])
        self.assertEqual(result["stop_reason"], "page_budget")
        self.assertFalse(result["complete"])
        self.assertFalse(result["coverage_verified"])
        self.assertFalse(result["end_marker_seen"])
        self.assertEqual(result["limitations"], wda_controller.LIST_LIMITATIONS)
        self.assertEqual(self.h.count("GET /source"), 2)
        self.assertEqual(len(self.fake.drags), 1)

    def test_an_end_marker_verifies_coverage_but_still_needs_reconciliation(self):
        self.h.show(cell("Row 1"), cell("End", y=400, type="StaticText"))
        result = self.phone.collect_list(max_pages=3, end_selector={"label": "End"})
        self.assertTrue(result["end_marker_seen"])
        self.assertTrue(result["coverage_verified"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["stop_reason"], "explicit_end_marker")
        self.assertEqual(self.fake.actions(), [])
        self.assertEqual(self.h.count("POST /elements"), 1)

    def test_a_repeated_page_stops_with_the_screen_and_without_coverage(self):
        self.h.show(cell("Row 1"))
        result = self.phone.collect_list(max_pages=4)
        self.assertEqual(result["stop_reason"], "no_progress")
        self.assertEqual(len(result["pages"]), 2)
        self.assertFalse(result["complete"])
        self.assertFalse(result["coverage_verified"])
        self.assertEqual(len(self.fake.drags), 1)
        self.assertEqual(self.labels(result), ["Row 1"])
        self.assertIn("image", result["observation"])
        self.assertIn("nodes", result["observation"])
        self.assertTrue(result["recovery"]["visual_check_required"])
        self.assertFalse(result["recovery"]["end_of_list_proven"])
        self.assertEqual(self.h.count("GET /screenshot"), 1)

    def test_virtualized_replacement_pages_are_collected_without_a_fallback(self):
        self.h.show_pages(*[[cell(label, y=350)] for label in ("A", "B", "C")])
        result = self.phone.collect_list(max_pages=3)
        self.assertEqual(self.labels(result), ["A", "B", "C"])
        self.assertEqual(result["stop_reason"], "page_budget")
        self.assertEqual(len(self.fake.drags), 2)
        self.assertEqual(self.h.count("GET /source"), 3)

    def test_value_or_carousel_refreshes_do_not_drive_more_swipes(self):
        self.h.show_pages(*[[cell("Stable row", y=350, value=value), cell("Banner " + value, y=50, type="StaticText")]
                            for value in ("100", "101", "102")])
        result = self.phone.collect_list(max_pages=6)
        self.assertEqual(result["stop_reason"], "no_progress")
        self.assertEqual(len(result["pages"]), 2)
        self.assertEqual(len(self.fake.drags), 1)
        self.assertFalse(result["coverage_verified"])
        self.assertEqual([row["value"] for row in result["rows"]], ["100", "101"])

    def test_a_paged_list_is_collected_to_its_end_marker(self):
        app, roots = list_app(pages=3, rows=8)
        self.fake.set_pages(app.bundle_id, roots)
        self.fake.set_foreground(app.bundle_id)
        result = self.phone.collect_list(end_selector={"label": "End of list"})
        self.assertEqual(self.labels(result), ["Row %d" % number for number in range(1, 25)])
        self.assertEqual(result["stop_reason"], "explicit_end_marker")
        self.assertEqual(len(result["pages"]), 3)
        self.assertTrue(result["coverage_verified"])
        self.assertEqual(len(self.fake.drags), 2)

    def test_rows_are_capped(self):
        self.h.show(*[cell("Row %d" % number, x=0, y=50 + number * 2, width=390, height=2) for number in range(350)])
        result = self.phone.collect_list(max_pages=1)
        self.assertEqual(len(result["rows"]), wda_controller.ROW_LIMIT)
        self.assertTrue(result["rows_truncated"])
        self.assertEqual(result["pages"], [{"page": 1, "rows_seen": 350, "truncated": True}])
        self.assertFalse(result["coverage_verified"])

    def test_a_read_failure_after_a_gesture_keeps_the_execution_evidence(self):
        self.h.show_pages([cell("Stable row", y=350)], [cell("Stable row", y=300)])
        self.fake.on_drag = lambda fake, drag: fake.inject("POST", "/elements", drop=True, times=2)
        error = self.assert_code("service_unreachable",
                                 lambda: self.phone.collect_list(max_pages=3, end_selector={"label": "Missing"}))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertFalse(error.uncertain)
        self.assertEqual(len(self.fake.drags), 1)

    def test_rows_use_the_shared_compact_format_and_row_types(self):
        self.h.show(cell("Row 1"), cell("Caption", y=300, type="StaticText"))
        self.assertEqual(self.phone.collect_list(max_pages=1)["rows"],
                         [{"type": "Cell", "label": "Row 1", "rect": [60, 200, 250, 44]}])
        result = self.phone.collect_list(row_type="XCUIElementTypeStaticText", max_pages=1)
        self.assertEqual(self.labels(result), ["Caption"])

    def test_arguments_are_checked_before_any_request(self):
        for arguments in ({"row_type": "Cell!"}, {"row_type": ""}, {"row_type": 5}, {"max_pages": 0},
                          {"max_pages": 11}, {"max_pages": 2.0}):
            with self.subTest(arguments=arguments):
                self.assert_code("invalid_argument", lambda: self.phone.collect_list(**arguments))
        self.assert_code("invalid_selector", lambda: self.phone.collect_list(end_selector={}))
        self.assertEqual(self.fake.requests, [])


if __name__ == "__main__":
    unittest.main()
