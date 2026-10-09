import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

import wda_controller  # noqa: E402
from phone_harness import HarnessCase, fake_clock, hint_problems  # noqa: E402

FORM = "com.example.form"
EMAIL = {"name": "email"}
PASSWORD = {"name": "password"}
STOP_KEYS = {"complete", "completed_steps", "results", "stopped_at", "resume_at", "stop_reason", "next_step"}
HOME = {"op": "press_button", "args": {"name": "home"}}


class BatchCase(HarnessCase):
    def setUp(self):
        super().setUp()
        self.fake.set_foreground(FORM)
        self.email = self.fake.node(name="email")

    def run_batch(self, steps):
        result = self.phone.batch(steps)
        self.assertEqual(set(result) - {"error"}, STOP_KEYS)
        self.assertEqual("error" in result, result["stop_reason"] not in (None, "time_budget", "input_continues",
                                                                          "submission_requires_verification"))
        self.assertEqual(hint_problems(result), [])
        self.assertIsNone(self.phone._deadline)
        return result

    def assert_stop(self, result, reason, stopped_at, resume_at, completed):
        self.assertFalse(result["complete"])
        self.assertEqual((result["stop_reason"], result["stopped_at"], result["resume_at"], result["completed_steps"]),
                         (reason, stopped_at, resume_at, completed))
        kind = reason if reason in wda_controller.BATCH_NEXT_STEPS and reason != "error" else "error"
        self.assertEqual(result["next_step"], wda_controller.BATCH_NEXT_STEPS[kind])


class BatchTests(BatchCase):
    def test_routine_steps_continue_with_deferred_verification(self):
        result = self.run_batch([
            {"op": "tap", "args": {"selector": {"label": "Send"}}},
            {"op": "type_text", "args": {"selector": EMAIL, "text": "continue"}},
            HOME,
        ])
        self.assertEqual(result, {"complete": True, "completed_steps": 3, "results": result["results"],
                                  "stopped_at": None, "resume_at": None, "stop_reason": None, "next_step": None})
        self.assertEqual(len(result["results"]), 3)
        self.assertTrue(all(item["verification_deferred"] for item in result["results"]))
        self.assertEqual(self.email.value, "continue")
        self.assertEqual(self.h.actions()[-1], "POST /wda/homescreen")
        self.assertFalse(any(route in ("GET /source", "GET /wda/activeAppInfo", "GET /element/:id/attribute/value")
                             for route in self.h.routes()))

    def test_an_uncertain_step_stops_the_batch(self):
        self.fake.inject("POST", "/element/:id/click", drop=True, execute=True)
        result = self.run_batch([{"op": "tap", "args": {"selector": {"label": "Send"}, "observe": "none"}}, HOME])
        self.assert_stop(result, "action_uncertain", 0, 0, 0)
        self.assertEqual(result["results"], [])
        self.assertTrue(result["error"]["uncertain"])
        self.assertFalse(result["error"]["action_executed"])
        self.assertEqual(self.h.count("POST /wda/homescreen"), 0)
        self.assertEqual(self.h.count("POST /wda/pressButton"), 0)

    def test_a_blocked_target_keeps_the_completed_steps_and_stops(self):
        self.fake.node(label="Send").hittable = False
        result = self.run_batch([{"op": "observe", "args": {}},
                                 {"op": "tap", "args": {"selector": {"label": "Send"}}}, HOME])
        self.assert_stop(result, "occluded_target", 1, 1, 1)
        self.assertEqual(len(result["results"]), 1)
        self.assertIn("observation_id", result["results"][0])
        error = result["error"]
        self.assertFalse(error["action_executed"])
        self.assertEqual(error["recovery"]["use"], "coordinates")
        self.assertTrue(Path(error["observation"]["image"]["path"]).is_file())
        self.assertEqual(self.fake.actions(), [])

    def test_a_submission_is_a_verification_barrier(self):
        result = self.run_batch([
            {"op": "type_text", "args": {"selector": EMAIL, "text": "Verified input", "submit": True}}, HOME])
        self.assert_stop(result, "submission_requires_verification", 0, 1, 1)
        self.assertEqual(len(result["results"]), 1)
        self.assertTrue(result["results"][0]["submitted"])
        self.assertEqual(self.fake.submits, ["Verified input"])
        self.assertEqual(self.h.count("POST /wda/homescreen"), 0)

    def test_an_explicit_expectation_lets_the_batch_continue_after_a_submission(self):
        result = self.run_batch([
            {"op": "type_text", "args": {"selector": EMAIL, "text": "Full input", "submit": True,
                                         "expect": {"label": "Send"}}}, HOME])
        self.assertTrue(result["complete"])
        self.assertEqual(result["completed_steps"], 2)
        self.assertTrue(result["results"][0]["submission_verified"])
        self.assertEqual(self.h.actions()[-1], "POST /wda/homescreen")

    def test_an_expectation_failure_stops_before_the_next_action(self):
        with fake_clock():
            result = self.run_batch([{"op": "tap", "args": {"selector": {"label": "Send"},
                                                             "expect": {"label": "Missing"}}}, HOME])
        self.assert_stop(result, "postcondition_failed", 0, 0, 0)
        self.assertTrue(result["error"]["action_executed"])
        self.assertFalse(result["error"]["action_complete"])
        self.assertIn("image", result["error"]["observation"])
        self.assertEqual(self.h.count("GET /screenshot"), 1)
        self.assertEqual(self.h.actions(), ["POST /element/:id/click"])

    def test_a_verified_home_lets_the_batch_continue(self):
        with fake_clock():
            result = self.run_batch([{"op": "press_button", "args": {"name": "home", "verify": True}},
                                     {"op": "observe", "args": {}}])
        self.assertTrue(result["complete"])
        self.assertEqual(result["completed_steps"], 2)
        self.assertTrue(result["results"][0]["foreground_verified"])
        self.assertEqual(result["results"][1]["app"], "com.apple.springboard")
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])

    def test_observation_wait_and_verified_input_steps_complete(self):
        result = self.run_batch([
            {"op": "observe", "args": {}},
            {"op": "wait", "args": {"selector": EMAIL, "timeout_seconds": 0}},
            {"op": "type_text", "args": {"selector": EMAIL, "text": "Verified input", "verify": True}},
        ])
        self.assertTrue(result["complete"])
        self.assertEqual(result["completed_steps"], 3)
        self.assertTrue(result["results"][2]["exact_readback"])
        self.assertEqual(self.email.value, "Verified input")

    def test_unfinished_input_and_the_time_budget_stop_the_batch(self):
        self.phone.call_budget = 0
        result = self.run_batch([{"op": "type_text", "args": {"selector": EMAIL, "text": "a" * 300}}, HOME])
        self.assert_stop(result, "input_continues", 0, 1, 0)
        self.assertEqual(len(result["results"]), 1)  # the partial step is reported but not counted
        token = result["results"][0]["continue_token"]
        self.assertEqual(self.h.count("POST /wda/homescreen"), 0)
        resumed = self.run_batch([{"op": "type_text", "args": {"continue_token": token}}, HOME])
        self.assert_stop(resumed, "time_budget", 1, 1, 1)
        self.assertEqual(len(resumed["results"]), 1)
        self.assertTrue(resumed["results"][0]["input_complete"])
        self.assertEqual(self.email.value, "a" * 300)
        self.assertEqual(self.h.count("POST /wda/homescreen"), 0)

    def test_the_first_step_always_runs_even_without_budget(self):
        self.phone.call_budget = 0
        result = self.run_batch([HOME])
        self.assertTrue(result["complete"])
        self.assertEqual(self.h.actions(), ["POST /wda/homescreen"])

    def test_a_batch_inside_its_budget_has_null_stop_fields(self):
        result = self.run_batch([HOME, {"op": "observe", "args": {}}])
        self.assertTrue(result["complete"])
        self.assertEqual((result["stopped_at"], result["resume_at"], result["stop_reason"], result["next_step"]),
                         (None, None, None, None))
        self.assertNotIn("error", result)

    def test_stop_texts_are_exact(self):
        self.assertEqual(wda_controller.BATCH_NEXT_STEPS, {
            "time_budget": "Send the steps from resume_at onward in a new call; completed steps already ran and must "
                           "not be repeated.",
            "input_continues": "Finish the text with iphone_type_text(continue_token=...), then send the steps from "
                               "resume_at onward.",
            "submission_requires_verification": "Check the result of the send step (stopped_at) before continuing "
                                                "from resume_at.",
            "error": "Look at the current screen (a screenshot is attached when available) and continue only the "
                     "missing steps; do not repeat completed steps.",
        })

    def test_a_password_step_stops_without_a_screenshot(self):
        result = self.run_batch([{"op": "type_text", "args": {"selector": PASSWORD, "text": "secret"}}, HOME])
        self.assert_stop(result, "not_editable", 0, 0, 0)
        self.assertTrue(result["error"]["secure_field"])
        self.assertNotIn("observation", result["error"])
        self.assertNotIn("recovery", result["error"])
        self.assertEqual(self.h.count("GET /screenshot"), 0)
        self.assertEqual(self.fake.actions(), [])

    def test_a_channel_fault_step_stops_with_its_code_and_recovery(self):
        self.fake.foreground_sequence = ["local.pid.9"]
        result = self.run_batch([{"op": "observe", "args": {"mode": "screenshot"}}, HOME])
        self.assert_stop(result, "foreground_unavailable", 0, 0, 0)
        self.assertFalse(result["error"]["action_executed"])
        self.assertEqual(result["error"]["recovery"]["next_tool"], "iphone_ready")
        self.assertEqual(self.fake.actions(), [])

    def test_a_failed_read_step_reports_no_execution(self):
        self.fake.inject("GET", "/source", drop=True, times=2)
        result = self.run_batch([{"op": "observe", "args": {}}, HOME])
        self.assert_stop(result, "service_unreachable", 0, 0, 0)
        self.assertFalse(result["error"]["action_executed"])
        self.assertFalse(result["error"]["uncertain"])

    def test_a_read_failure_after_a_scroll_find_gesture_stops_the_batch(self):
        self.fake.on_drag = lambda fake, drag: fake.inject("POST", "/elements", drop=True, times=2)
        result = self.run_batch([{"op": "scroll_find", "args": {"selector": {"label": "Missing"}, "max_swipes": 1}},
                                 HOME])
        self.assert_stop(result, "service_unreachable", 0, 0, 0)
        self.assertFalse(result["error"]["uncertain"])
        self.assertTrue(result["error"]["action_executed"])
        self.assertFalse(result["error"]["action_complete"])
        self.assertEqual(len(self.fake.drags), 1)
        self.assertEqual(self.h.count("POST /wda/homescreen"), 0)

    def test_a_stop_carries_the_same_screenshot_evidence(self):
        result = self.run_batch([{"op": "tap", "args": {"selector": {"label": "Gone"}}}, HOME])
        self.assert_stop(result, "no_such_element", 0, 0, 0)
        self.assertEqual(result["error"]["recovery"]["use"], "coordinates")
        self.assertTrue(Path(result["error"]["observation"]["image"]["path"]).is_file())
        self.assertEqual(self.fake.actions(), [])

    def test_steps_after_completed_ones_are_reported_from_the_right_index(self):
        result = self.run_batch([{"op": "tap", "args": {"x": 10, "y": 10}},
                                 {"op": "swipe", "args": {}},
                                 {"op": "tap", "args": {"selector": {"label": "Gone"}}}, HOME])
        self.assert_stop(result, "no_such_element", 2, 2, 2)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(self.h.actions(), ["POST /wda/tap", "POST /wda/dragfromtoforduration"])

    def test_malformed_steps_fail_before_any_step_runs(self):
        good = {"op": "tap", "args": {"x": 10, "y": 10}}
        for steps in ([], [good] * 21, "tap", None, [good, "tap"], [good, {"op": "find", "args": {}}],
                      [good, {"op": "collect_list", "args": {}}], [good, {"op": "batch", "args": {"steps": []}}],
                      [good, {"op": "tap", "args": {}, "extra": 1}], [good, {"op": "tap", "args": []}],
                      [good, {"args": {}}],
                      [good, {"op": "tap", "args": {"x": 1, "y": 1, "bogus": True}}],
                      [good, {"op": "swipe", "args": {"_baseline": None}}],
                      [good, {"op": "swipe", "args": {"max_attempts": 2}}]):
            with self.subTest(steps=steps if not isinstance(steps, list) or len(steps) < 5 else len(steps)):
                self.assert_code("invalid_argument", lambda: self.phone.batch(steps))
        self.assertEqual(self.fake.requests, [])
        self.assertIsNone(self.phone._deadline)

    def test_args_may_be_omitted_for_steps_without_arguments(self):
        result = self.run_batch([{"op": "observe"}])
        self.assertTrue(result["complete"])


if __name__ == "__main__":
    unittest.main()
