import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

import wda_controller  # noqa: E402
from fake_wda import Node  # noqa: E402
from phone_harness import HarnessCase, cell, fake_clock, page  # noqa: E402
from wda_controller import PhoneController  # noqa: E402

SETTINGS = "com.apple.Preferences"
FORM = "com.example.form"
TARGET_RECT = {"x": 70, "y": 200, "width": 250, "height": 44}


def target(y=200, x=70, width=250, height=44, type="TextField", label="Target", **attributes):
    return Node(type, label=label, rect=(x, y, width, height), **attributes)


class TargetCase(HarnessCase):
    def clicked_ids(self):
        return [request.path.split("/")[4] for request in self.fake.calls(route="/element/:id/click")]

    def image_png(self, error):
        """The native PNG kept next to the model image of an error's screenshot."""
        return Path(error.details["observation"]["image"]["path"]).with_suffix(".png").read_bytes()


class SelectorResolutionTests(TargetCase):
    def test_exact_target_offscreen_or_occluded_is_not_clicked(self):
        for condition, code in (("offscreen", "offscreen_target"), ("occluded", "occluded_target")):
            with self.subTest(condition=condition):
                h = self.make_harness()
                y = 900 if condition == "offscreen" else 200
                h.show(target(y=y, hittable=condition != "occluded"))
                error = self.assert_code(code, lambda: h.phone.tap(selector={"label": "Target"}))
                self.assertFalse(error.details["action_executed"])
                self.assertEqual(error.details["target_rect"], dict(TARGET_RECT, y=y))
                self.assertEqual(error.details["viewport"], {"width": 390, "height": 844, "units": "iPhone points"})
                recovery = error.details["recovery"]
                self.assertEqual(recovery["use"], "coordinates")
                self.assertFalse(recovery["replay_action"])
                self.assertTrue(recovery["visual_check_required"])
                observation = error.details["observation"]
                self.assertEqual(Path(observation["image"]["path"]).with_suffix(".png").read_bytes(),
                                 h.fake.screenshot_png)
                self.assertNotIn("nodes", observation)
                if condition == "occluded":
                    self.assertEqual(recovery["next_tool"], "iphone_tap")
                    self.assertNotIn("next_arguments", recovery)
                    self.assertIn("popup", recovery["next_step"])
                    self.assertIn("not proof", recovery["next_step"])
                    self.assertEqual(error.details["tap_point"], {"x": 195, "y": 222})
                else:
                    self.assertEqual(recovery["next_tool"], "iphone_swipe")
                self.assertEqual(h.fake.actions(), [])

    def test_separate_duplicate_targets_report_candidates_instead_of_guessing(self):
        for rich in (False, True):
            with self.subTest(rich=rich):
                h = self.make_harness()
                h.fake.rich_elements = rich
                first, second = target(), target(y=400)
                h.show(first, second)
                error = self.assert_code("ambiguous_target", lambda: h.phone.tap(selector={"label": "Target"}))
                details = error.details
                self.assertEqual(details["matches"], 2)
                self.assertFalse(details["action_executed"])
                self.assertEqual([c["index"] for c in details["candidates"]], [0, 1])
                self.assertEqual([c["rect"] for c in details["candidates"]], [[70, 200, 250, 44], [70, 400, 250, 44]])
                self.assertEqual([c["tap"] for c in details["candidates"]], [[195, 222], [195, 422]])
                self.assertTrue(all(c["hittable"] for c in details["candidates"]))
                self.assertFalse(details["candidates_truncated"])
                self.assertEqual("type" in details["candidates"][0], rich)
                text = json.dumps(error.as_dict())
                self.assertNotIn("element_id", text)
                self.assertNotIn(first.id, text)
                self.assertNotIn(second.id, text)
                self.assertEqual(h.fake.actions(), [])

    def test_selector_index_picks_one_reported_candidate(self):
        first, second = target(), target(y=400)
        self.h.show(first, second)
        result = self.phone.tap(selector={"label": "Target", "index": 1})
        self.assertTrue(result["action_executed"])
        self.assertNotIn("target", result)
        self.assertEqual(self.clicked_ids(), [second.id])
        error = self.assert_code("no_such_element", lambda: self.phone.tap(selector={"label": "Target", "index": 2}))
        self.assertEqual(error.details["matches"], 2)
        self.assertEqual(error.message, wda_controller.INDEX_BEYOND_MESSAGE)
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(len(self.fake.actions()), 1)

    def test_nested_or_coincident_matches_are_one_touch_target(self):
        for inner_rect in ((80, 210, 60, 22), (70, 200, 250, 44)):
            with self.subTest(inner=inner_rect):
                h = self.make_harness()
                outer = target(type="Cell")
                inner = Node("StaticText", label="Target", rect=inner_rect)
                h.show(outer, inner)
                result = h.phone.tap(selector={"label": "Target"})
                self.assertEqual(result["target"]["chosen"], "innermost_of_nested_matches")
                self.assertEqual(result["target"]["matches"], 2)
                expected = inner if inner_rect[2] < 250 else outer  # coincident: first in tree order
                clicks = [r.path.split("/")[4] for r in h.fake.calls(route="/element/:id/click")]
                self.assertEqual(clicks, [expected.id])

    def test_nested_matches_skip_an_occluded_inner_element(self):
        outer = target(type="Cell")
        inner = Node("StaticText", label="Target", rect=(80, 210, 60, 22), hittable=False)
        self.h.show(outer, inner)
        self.phone.tap(selector={"label": "Target"})
        self.assertEqual(self.clicked_ids(), [outer.id])
        outer.hittable = False
        self.fake.clear_log()
        error = self.assert_code("occluded_target", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(error.details["recovery"]["use"], "coordinates")
        self.assertEqual([c["tap"] for c in error.details["candidates"]], [[110, 221], [195, 222]])
        self.assertEqual(self.fake.actions(), [])

    def test_offscreen_duplicate_does_not_block_the_one_visible_match(self):
        visible = target()
        self.h.show(visible, target(y=2000))
        result = self.phone.tap(selector={"label": "Target"})
        self.assertEqual(result["target"], {"matches": 2, "chosen": "only_match_on_screen", "index": 0})
        self.assertEqual(self.clicked_ids(), [visible.id])
        # Narrowing never replaces the hittable check of the chosen element.
        visible.hittable = False
        self.fake.clear_log()
        self.assert_code("occluded_target", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(self.fake.actions(), [])

    def test_all_matches_offscreen_is_not_reported_as_ambiguity(self):
        self.h.show(target(y=1500), target(y=2000))
        error = self.assert_code("offscreen_target", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(error.message, wda_controller.ALL_OFFSCREEN_MESSAGE)
        self.assertEqual(len(error.details["candidates"]), 2)
        self.assertEqual(error.details["matches"], 2)
        self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.fake.actions(), [])

    def test_bare_id_matches_beyond_the_inspection_limit_stay_ambiguous(self):
        self.h.show(target(), *[target(y=3000 + number * 50) for number in range(12)])
        self.fake.rich_elements = False
        error = self.assert_code("ambiguous_target", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(error.details["matches"], 13)
        self.assertTrue(error.details["candidates_truncated"])
        self.assertEqual(self.h.count("GET /element/:id/rect"), 8)
        self.assertEqual(self.fake.actions(), [])
        # With inline rects every match is weighed, so the single visible one is certain.
        self.fake.rich_elements = True
        self.fake.clear_log()
        result = self.phone.tap(selector={"label": "Target"})
        self.assertEqual(result["target"]["chosen"], "only_match_on_screen")
        self.assertEqual(self.h.count("GET /element/:id/rect"), 0)

    def test_typing_prefers_the_editable_match_among_same_labels(self):
        field = target()
        container = target(type="Other", x=0, y=180, width=390, height=90)
        key = target(type="Button", y=700)
        self.h.show(container, field, key)
        result = self.phone.type_text({"label": "Target"}, "query")
        self.assertTrue(result["action_complete"])
        self.assertEqual(field.value, "query")
        touched = [r.path for r in self.fake.requests if "/element/" in r.path]
        self.assertFalse(any(container.id in path or key.id in path for path in touched))

    def test_inline_element_attributes_replace_rect_and_type_reads(self):
        self.h.show(target())
        self.h.warm()
        self.phone.tap(selector={"label": "Target"})
        self.assertEqual(self.h.routes(), ["POST /elements", "GET /window/size", "GET /element/:id/attribute/hittable",
                                           "POST /element/:id/click"])
        self.fake.clear_log()
        self.phone.type_text({"label": "Target"}, "text")
        self.assertEqual(self.h.routes(), ["POST /elements", "GET /element/:id/attribute/hittable",
                                           "POST /element/:id/click", "POST /element/:id/clear",
                                           "POST /element/:id/value"])

    def test_bare_ids_fall_back_to_rect_and_type_reads(self):
        self.h.show(target())
        self.fake.rich_elements = False
        self.h.warm(viewport=True)
        self.phone.tap(selector={"label": "Target"})
        self.assertEqual(self.h.routes(), ["POST /elements", "GET /element/:id/rect",
                                           "GET /element/:id/attribute/hittable", "POST /element/:id/click"])
        self.fake.clear_log()
        self.phone.type_text({"label": "Target"}, "text")
        self.assertIn("GET /element/:id/attribute/type", self.h.routes())
        self.assertEqual(self.fake.typed[-1], "text")

    def test_exact_text_and_escaping_match_an_independent_predicate_parser(self):
        self.h.show(target(label="it's \nhere"), target(label="a\\b", y=300), target(label="x", y=400))
        for selector, matches in (({"label": "it's \nhere"}, 1), ({"label": "it's \\nhere"}, 0),
                                  ({"label_contains": "s \nh"}, 1), ({"label_contains": "IT'S"}, 0),
                                  ({"label": "a\\b"}, 1), ({"label": "x' OR TRUEPREDICATE OR label == 'y"}, 0),
                                  ({"predicate": "label BEGINSWITH 'it'", "index": 0}, 1)):
            with self.subTest(selector=selector):
                self.assertEqual(self.phone.find(selector)["matches"], matches)

    def test_exact_enabled_accepts_tree_strings_and_booleans_equally(self):
        self.h.show(target(), target(y=400, enabled=False))
        for value, y in ((True, 200), ("true", 200), (False, 400), ("false", 400)):
            with self.subTest(value=value):
                found = self.phone.find({"label": "Target", "enabled": value})
                self.assertEqual(found["matches"], 1)
                self.assertEqual(found["elements"][0]["rect"][1], y)

    def test_invalid_selectors_fail_before_any_phone_request(self):
        for selector in ({}, {"index": 0}, {"label": "a", "index": -1}, {"label": "a", "index": True},
                         {"label": "a", "index": 200}, {"predicate": "label == 'a'", "label_contains": "a"},
                         {"label": "a\x00b"}, {"label": "Target", "enabled": "TRUE"}, {"label": "Target", "enabled": 1},
                         {"label": "Target", "enabled": None}, {"rect": [1, 2, 3, 4]}, "Target", {"label": ""}):
            with self.subTest(selector=selector):
                self.assert_code("invalid_selector", lambda: self.phone.find(selector))
                self.assert_code("invalid_selector", lambda: self.phone.tap(selector=selector))
                self.assert_code("invalid_selector", lambda: self.phone.tap(x=1, y=1, expect=selector))
        self.assertEqual(self.fake.requests, [])


class FindTests(TargetCase):
    def test_find_describes_matches_in_the_compact_format_with_tap_points(self):
        found = self.phone.find({"label": "Wi-Fi"})
        self.assertEqual(found, {"matches": 1, "truncated": False, "elements": [
            {"index": 0, "type": "Cell", "label": "Wi-Fi", "name": "com.apple.settings.wi-fi", "value": "Home-5G",
             "rect": [16, 347, 358, 44], "tap": [195, 369]}]})
        self.assertEqual(self.h.count("GET /element/:id/attribute/hittable"), 0)
        self.assertEqual(self.h.count("GET /screenshot"), 0)

    def test_zero_matches_is_a_normal_result(self):
        self.assertEqual(self.phone.find({"label": "Missing"}), {"matches": 0, "elements": [], "truncated": False})
        self.assertEqual(self.h.count("GET /screenshot"), 0)

    def test_limit_bounds_the_described_matches(self):
        self.h.show(*[target(y=100 + number * 50) for number in range(5)])
        found = self.phone.find({"label": "Target"}, limit=2)
        self.assertEqual((found["matches"], len(found["elements"]), found["truncated"]), (5, 2, True))
        found = self.phone.find({"label": "Target", "index": 4}, limit=2)
        self.assertEqual(([e["index"] for e in found["elements"]], found["truncated"]), ([4], False))
        self.fake.clear_log()
        for limit in (0, 31, True, 2.0):
            with self.subTest(limit=limit):
                self.assert_code("invalid_argument", lambda: self.phone.find({"label": "Target"}, limit=limit))
        self.assertEqual(self.fake.requests, [])

    def test_the_application_root_is_not_a_match_so_index_means_the_same_everywhere(self):
        # WDA's predicate search includes the Application root (label "Settings" here).
        root_id = self.fake.app(SETTINGS).root.id
        found = self.phone.find({"label": "Settings"})
        self.assertEqual(found["matches"], 1)
        self.assertEqual(found["elements"][0]["type"], "StaticText")
        self.phone.tap(selector={"label": "Settings"})
        self.assertNotIn(root_id, self.clicked_ids())
        self.assertEqual(self.phone.wait({"label": "Settings", "index": 0}, timeout_seconds=0)["matches"], 1)
        with fake_clock():
            self.assert_code("postcondition_failed",
                             lambda: self.phone.wait({"label": "Settings", "index": 1}, timeout_seconds=0))
        found = self.phone.scroll_find({"label": "Settings"}, max_swipes=0)
        self.assertEqual((found["matches"], found["target"]["type"]), (1, "StaticText"))

    def test_element_ids_never_reach_the_model(self):
        found = self.phone.find({"label_contains": "i"}, limit=30)
        text = json.dumps(found)
        self.assertNotIn("element_id", text)
        self.assertNotIn("-0000-0000-9C01-", text)


class CoordinateTapTests(TargetCase):
    def test_coordinate_tap_accepts_an_optional_observation_without_age_limit(self):
        result = self.phone.tap(x=100, y=220)
        self.assertEqual(result, {"action_executed": True, "action_complete": True, "verified": False,
                                  "verification_deferred": True})
        self.assertFalse(any(route in ("GET /source", "GET /screenshot", "GET /wda/activeAppInfo")
                             for route in self.h.routes()))
        observed = self.phone.observe()
        self.phone.snapshots[observed["observation_id"]]["time"] -= 3600
        self.fake.clear_log()
        result = self.phone.tap(x=100, y=220, observation_id=observed["observation_id"])
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(self.h.routes(), ["GET /wda/activeAppInfo", "GET /window/size", "POST /wda/tap"])
        self.assertEqual(self.fake.calls(route="/wda/tap")[-1].body, {"x": 100, "y": 220})

    def test_changed_app_or_orientation_rejects_a_supplied_coordinate_context(self):
        for change, reason in (("app", "foreground_changed"), ("orientation", "viewport_changed")):
            with self.subTest(change=change):
                h = self.make_harness()
                h.show(cell("Row"))
                observed = h.phone.observe()
                if change == "app":
                    h.fake.set_foreground("com.apple.springboard")
                else:
                    h.fake.size = (844, 390)
                h.fake.clear_log()
                error = self.assert_code("stale_observation", lambda: h.phone.tap(
                    x=100, y=220, observation_id=observed["observation_id"]))
                self.assertEqual(error.details["reason"], reason)
                self.assertEqual(error.details["freshness_scope"], "page")
                self.assertEqual(error.details["recovery"]["next_tool"], "iphone_observe")
                self.assertFalse(error.details["action_executed"])
                self.assertNotIn("observation", error.details)  # not a visual failure: no screenshot
                self.assertEqual(h.fake.actions(), [])

    def test_an_observation_from_another_runtime_does_not_authorize_coordinates(self):
        observed = self.phone.observe()
        other = PhoneController(self.h.client, self.h.state_dir)
        self.fake.clear_log()
        error = self.assert_code("stale_observation",
                                 lambda: other.tap(x=100, y=220, observation_id=observed["observation_id"]))
        self.assertEqual(error.details["reason"], "unknown_observation")
        self.assertEqual(self.fake.requests, [])

    def test_screenshot_context_tolerates_changing_pixels(self):
        observed = self.phone.observe("screenshot")
        self.phone.tap(x=100, y=220, observation_id=observed["observation_id"])
        self.fake.screenshot_png = self.fake.screenshot_png + b"changed picture"
        self.fake.clear_log()
        result = self.phone.tap(x=100, y=220, observation_id=observed["observation_id"])
        self.assertTrue(result["action_executed"])
        self.assertEqual(self.h.actions(), ["POST /wda/tap"])
        self.assertFalse(any(route in ("GET /source", "GET /screenshot") for route in self.h.routes()))

    def test_coordinate_context_tolerates_changing_tree_and_image(self):
        observed = self.phone.observe("both")
        self.fake.set_tree(SETTINGS, page(cell("New content on the same page"), label="Settings"))
        self.fake.screenshot_png = self.fake.screenshot_png + b"custom-drawn content changed"
        self.fake.clear_log()
        self.phone.tap(x=100, y=220, observation_id=observed["observation_id"])
        self.assertEqual(self.h.actions(), ["POST /wda/tap"])
        self.assertFalse(any(route in ("GET /source", "GET /screenshot") for route in self.h.routes()))

    def test_coordinates_outside_the_screen_are_rejected_before_any_tap(self):
        for x, y in ((390, 10), (10, 844), (389.9, 843.9)):
            with self.subTest(x=x, y=y):
                if x < 390 and y < 844:
                    self.assertTrue(self.phone.tap(x=x, y=y)["action_executed"])
                else:
                    error = self.assert_code("invalid_argument", lambda: self.phone.tap(x=x, y=y))
                    self.assertEqual(error.message, "Coordinates are outside the iPhone screen.")
        self.assertEqual(self.fake.taps, [(389.9, 843.9)])

    def test_incomplete_mixed_or_malformed_arguments_fail_before_phone_access(self):
        for arguments in ({}, {"x": 10}, {"y": 10}, {"selector": {"label": "Wi-Fi"}, "x": 1},
                          {"x": -1, "y": 1}, {"x": 10001, "y": 1}, {"x": float("nan"), "y": 1}, {"x": True, "y": 1},
                          {"x": "10", "y": 1}, {"x": 1, "y": 1, "observe": "image"}):
            with self.subTest(arguments=arguments):
                error = self.assert_code("invalid_argument", lambda: self.phone.tap(**arguments))
                self.assertFalse(error.details["action_executed"])
        self.assertEqual(self.fake.requests, [])

    def test_a_coordinate_tap_reaches_what_the_selector_could_not(self):
        self.h.show(target(hittable=False))
        error = self.assert_code("occluded_target", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertNotIn("next_arguments", error.details["recovery"])
        result = self.phone.tap(x=195, y=222)
        self.assertTrue(result["action_executed"])
        self.assertEqual(self.h.actions(), ["POST /wda/tap"])
        self.assertEqual(self.fake.calls(route="/wda/tap")[0].body, {"x": 195, "y": 222})


class ScreenshotFallbackTests(TargetCase):
    def test_failed_selector_tap_returns_the_screen_and_points_to_coordinates(self):
        cases = (("no_such_element", lambda h: h.show()),
                 ("occluded_target", lambda h: h.show(target(hittable=False))),
                 ("ambiguous_target", lambda h: h.show(target(), target(y=400))))
        for code, arrange in cases:
            with self.subTest(code=code):
                h = self.make_harness()
                arrange(h)
                error = self.assert_code(code, lambda: h.phone.tap(selector={"label": "Target"}))
                details = error.details
                self.assertFalse(details["action_executed"])
                self.assertEqual((details["recovery"]["use"], details["recovery"]["next_tool"]),
                                 ("coordinates", "iphone_tap"))
                self.assertIn("Do not try other selector spellings", details["recovery"]["next_step"])
                self.assertEqual(Path(details["observation"]["image"]["path"]).with_suffix(".png").read_bytes(),
                                 h.fake.screenshot_png)
                self.assertEqual(h.count("GET /screenshot"), 1)
                self.assertEqual(h.fake.actions(), [])
                if code == "occluded_target":
                    self.assertNotIn("next_arguments", details["recovery"])
                    self.assertTrue(details["recovery"]["next_step"].startswith("Look at the attached screenshot first"))
                if code == "ambiguous_target":
                    self.assertEqual([c["tap"] for c in details["candidates"]], [[195, 222], [195, 422]])

    def test_recovery_texts_are_exact_per_failure_kind(self):
        suffix = wda_controller.STEP_SUFFIX
        self.assertEqual(suffix, (
            " Image pixels x image.pixel_to_point = iPhone points. The screenshot is attached to this result; if you "
            "cannot see it, open observation.image.path with the Read tool or call iphone_observe(mode=screenshot). "
            "Do not try other selector spellings or re-read the tree first."))
        self.assertEqual(wda_controller.OFFSCREEN_STEP, (
            "Look at the attached screenshot first. The match is outside the visible area; check the list, direction "
            "and any overlay before deciding to swipe."))
        self.assertEqual(wda_controller.OCCLUDED_STEP, (
            "Look at the attached screenshot first. A popup may cover the target; dismiss its visible close or "
            "cancel control first. tap_point is where the covered element is, not proof it can be tapped."))
        self.assertEqual(wda_controller.SCROLL_STEP, (
            "Look at the attached screenshot first for the last row, an end marker, unchanged content, the wrong "
            "region, a fixed header or a popup. Decide whether another swipe is needed; do not automatically repeat "
            "scrolling. No progress does not prove the list is empty or complete."))
        self.assertEqual(wda_controller.RESULT_STEP, (
            "Look at the attached screenshot first to see the actual page, field text or send result. Continue only "
            "the missing work; do not blindly repeat."))
        self.assertEqual(wda_controller.TYPING_STEP, (
            "Look at the attached screenshot first. Tap the visible text field by x/y, then call iphone_type_text "
            "with the text and no selector. If an earlier tap did not focus it, pick a new point from this "
            "screenshot."))
        self.assertEqual(wda_controller.TAP_STEP, (
            "Look at the attached screenshot first, then tap the visible target by x/y; tap points in this result "
            "are already in iPhone points."))
        self.h.show(target(y=900))
        with fake_clock():
            cases = (
                (lambda: self.phone.tap(selector={"label": "Target"}), wda_controller.OFFSCREEN_STEP, "iphone_swipe"),
                (lambda: self.phone.tap(selector={"label": "Missing"}), wda_controller.TAP_STEP, "iphone_tap"),
                (lambda: self.phone.type_text({"label": "Missing"}, "abc"), wda_controller.TYPING_STEP, "iphone_tap"),
                (lambda: self.phone.wait({"label": "Missing"}, timeout_seconds=0), wda_controller.RESULT_STEP, None),
                (lambda: self.phone.scroll_find({"label": "Missing"}, max_swipes=0), wda_controller.SCROLL_STEP, None),
            )
            for operation, step, tool in cases:
                with self.subTest(step=step[:40]):
                    with self.assertRaises(Exception) as caught:
                        operation()
                    recovery = caught.exception.details["recovery"]
                    self.assertEqual(recovery["next_step"], step + suffix)
                    self.assertEqual(recovery.get("next_tool"), tool)
                    self.assertNotIn("next_arguments", recovery)

    def test_screen_capture_failure_never_hides_the_selector_error(self):
        self.fake.inject("GET", "/screenshot", error="unable to capture screen")
        error = self.assert_code("no_such_element", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(error.details["observation_error"]["code"], "unable to capture screen")
        self.assertEqual(error.details["recovery"]["use"], "coordinates")
        self.assertEqual(error.details["recovery"]["next_tool"], "iphone_observe")
        self.assertEqual(error.details["recovery"]["next_arguments"], {"mode": "screenshot"})
        self.assertEqual(self.h.count("GET /screenshot"), 1)

    def test_an_unwritable_artifacts_folder_keeps_the_original_error(self):
        self.phone.artifacts_dir.write_bytes(b"not a folder")
        error = self.assert_code("no_such_element", lambda: self.phone.tap(selector={"label": "Target"}))
        self.assertEqual(error.details["observation_error"]["code"], "internal_error")
        self.assertEqual(error.details["recovery"]["next_arguments"], {"mode": "screenshot"})

    def test_a_nested_page_expectation_failure_captures_once(self):
        with fake_clock():
            error = self.assert_code("postcondition_failed", lambda: self.phone.tap(
                x=100, y=200, expect={"label": "Missing"}))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertIn("verification_required", error.details)
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.h.count("GET /screenshot"), 1)
        self.assertEqual(self.h.actions(), ["POST /wda/tap"])

    def test_a_failed_capture_is_not_retried_by_the_outer_wrapper(self):
        # A failing (or hanging) screenshot is tried once per tool call, not again by each wrapper.
        self.fake.inject("GET", "/screenshot", error="unable to capture screen", times=None)
        with fake_clock():
            error = self.assert_code("postcondition_failed", lambda: self.phone.tap(
                x=100, y=200, expect={"label": "Missing"}))
        self.assertEqual(error.details["observation_error"]["code"], "unable to capture screen")
        self.assertEqual(self.h.count("GET /screenshot"), 1)
        self.assertEqual(self.h.actions(), ["POST /wda/tap"])

    def test_wda_click_state_error_returns_the_screen_without_repeating_the_click(self):
        for code in ("element not interactable", "element click intercepted", "invalid element state"):
            with self.subTest(code=code):
                h = self.make_harness()
                h.fake.inject("POST", "/element/:id/click", error=code, message="A popup intercepted the click")
                error = self.assert_code(code, lambda: h.phone.tap(selector={"label": "Wi-Fi"}))
                self.assertIn("image", error.details["observation"])
                self.assertTrue(error.details["recovery"]["visual_check_required"])
                self.assertFalse(error.details["recovery"]["replay_action"])
                self.assertEqual(error.details["recovery"]["use"], "screenshot")
                self.assertFalse(error.details["action_executed"])
                self.assertEqual(h.actions(), ["POST /element/:id/click"])
                self.assertEqual(h.count("GET /screenshot"), 1)

    def test_an_uncertain_click_gets_no_screenshot_and_is_not_repeated(self):
        self.fake.inject("POST", "/element/:id/click", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.tap(selector={"label": "Wi-Fi"}))
        self.assertTrue(error.uncertain)
        self.assertFalse(error.details["action_executed"])
        self.assertNotIn("observation", error.details)
        self.assertNotIn("recovery", error.details)
        self.assertEqual(self.h.actions(), ["POST /element/:id/click"])
        self.assertEqual(self.phone.accepted_actions, 0)

    def test_a_password_field_gets_no_screenshot_or_coordinates(self):
        self.fake.set_foreground(FORM)
        error = self.assert_code("not_editable", lambda: self.phone.type_text({"name": "password"}, "never typed"))
        self.assertTrue(error.details["secure_field"])
        self.assertEqual(error.message, wda_controller.SECURE_FIELD_MESSAGE)
        self.assertNotIn("observation", error.details)
        self.assertNotIn("recovery", error.details)
        self.assertEqual(self.h.count("GET /screenshot"), 0)
        self.assertEqual(self.fake.actions(), [])
        self.assertEqual(self.fake.typed, [])


if __name__ == "__main__":
    unittest.main()
