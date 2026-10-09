import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import wda_controller  # noqa: E402
from fake_wda import ELEMENT_KEY  # noqa: E402
from phone_harness import HarnessCase, RecordingScreen, fake_clock  # noqa: E402
from wda_text import request_timeout  # noqa: E402

FORM = "com.example.form"
EMAIL = {"name": "email"}
PASSWORD = {"name": "password"}
MESSAGE = {"name": "message"}
EMAIL_POINT = (195, 142)
PASSWORD_POINT = (195, 202)
RETURN = {"value": ["\n"]}


class TypingCase(HarnessCase):
    def setUp(self):
        super().setUp()
        self.fake.set_foreground(FORM)
        self.email = self.fake.node(name="email")

    def bodies(self, route):
        return [request.body for request in self.fake.calls(route=route)]

    def typing_timeouts(self, spy):
        return [call.kwargs.get("timeout") for call in spy.call_args_list
                if call.args[1].endswith("/value") or call.args[1] == "/wda/keys"]


class TypingTests(TypingCase):
    def test_unicode_text_round_trips_exactly_before_submit(self):
        text = "你好 👋 Café 漢字 é"
        result = self.phone.type_text(EMAIL, text, submit=True, verify=True)
        self.assertTrue(result["exact_readback"])
        self.assertTrue(result["submitted"])
        self.assertFalse(result["submission_verified"])
        self.assertFalse(result["verified"])
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(result["verification_required"], wda_controller.SUBMIT_VERIFICATION)
        self.assertEqual(self.email.value, text)
        self.assertEqual(self.fake.submits, [text])
        routes = self.h.routes()
        readback = max(index for index, route in enumerate(routes) if route == "GET /element/:id/attribute/value")
        self.assertLess(readback, routes.index("POST /wda/keys"))
        self.assertEqual(self.fake.actions()[-1].body, RETURN)

    def test_default_input_sends_the_full_text_once_without_reads(self):
        text = "完整中文输入 👋 Café é " * 20
        result = self.phone.type_text(EMAIL, text)
        self.assertEqual(result, {"action_executed": True, "action_complete": True, "input_complete": True,
                                  "verified": False, "verification_deferred": True, "exact_readback": False,
                                  "characters": len(text), "submitted": False})
        self.assertEqual(self.email.value, text)
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 0)
        self.assertEqual(self.h.count("GET /element/:id/attribute/type"), 0)
        self.assertEqual(self.h.count("GET /source"), 0)
        self.assertEqual(self.h.count("POST /element/:id/value"), 1)
        self.assertEqual(self.fake.submits, [])

    def test_default_append_neither_clears_nor_reads_existing_text(self):
        self.email.value = "Existing "
        result = self.phone.type_text(EMAIL, "追加", replace=False)
        self.assertTrue(result["verification_deferred"])
        self.assertEqual(self.email.value, "Existing 追加")
        self.assertEqual(self.h.count("POST /element/:id/clear"), 0)
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 0)

    def test_append_preserves_existing_text_and_verifies_the_combined_value(self):
        self.email.value = "Existing "
        result = self.phone.type_text(EMAIL, "追加", replace=False, verify=True)
        self.assertTrue(result["verified"])
        self.assertEqual(self.email.value, "Existing 追加")
        self.assertEqual(self.h.count("POST /element/:id/clear"), 0)
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 2)
        self.assertEqual(self.h.count("GET /element/:id/attribute/placeholderValue"), 1)

    def test_appending_to_an_empty_field_ignores_its_placeholder(self):
        # WDA reports an empty field's placeholder ("Email") as its value.
        result = self.phone.type_text(EMAIL, "a@b.c", replace=False, verify=True)
        self.assertTrue(result["exact_readback"])
        self.assertEqual(self.email.value, "a@b.c")

    def test_a_verified_replace_has_only_one_final_readback(self):
        self.email.value = "old value"
        result = self.phone.type_text(EMAIL, "new value", verify=True)
        self.assertTrue(result["exact_readback"])
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 1)
        self.assertEqual(self.h.count("GET /element/:id/attribute/placeholderValue"), 0)
        self.assertEqual(self.email.value, "new value")

    def test_an_uncertain_input_stops_without_retyping_or_submitting(self):
        self.fake.inject("POST", "/element/:id/value", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.type_text(EMAIL, "one full input",
                                                                                 submit=True))
        self.assertTrue(error.uncertain)
        self.assertTrue(error.details["action_executed"])  # the focus click and clear were accepted
        self.assertFalse(error.details["action_complete"])
        self.assertEqual((error.details["characters_confirmed"], error.details["characters_total"]), (0, 14))
        self.assertEqual(self.h.count("POST /element/:id/value"), 1)
        self.assertEqual(self.h.count("POST /wda/keys"), 0)
        self.assertNotIn("observation", error.details)
        self.assertIsNone(self.phone.pending_input)

    def test_password_and_other_non_text_fields_are_refused_before_any_mutation(self):
        error = self.assert_code("not_editable", lambda: self.phone.type_text(PASSWORD, "do not type"))
        self.assertTrue(error.details["secure_field"])
        self.assertNotIn("observation", error.details)
        error = self.assert_code("not_editable", lambda: self.phone.type_text({"label": "Send"}, "never typed"))
        self.assertFalse(error.details["secure_field"])
        self.assertEqual(error.message, wda_controller.NOT_EDITABLE_MESSAGE)
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.actions(), [])
        self.assertEqual(self.fake.typed, [])

    def test_bare_ids_still_refuse_a_password_field(self):
        self.fake.rich_elements = False
        error = self.assert_code("not_editable", lambda: self.phone.type_text(PASSWORD, "do not type"))
        self.assertTrue(error.details["secure_field"])
        self.assertEqual(self.h.count("GET /element/:id/attribute/type"), 1)
        self.assertEqual(self.fake.actions(), [])

    def test_an_input_mismatch_neither_submits_nor_retypes(self):
        self.fake.inject("GET", "/element/:id/attribute/value", value="你好 ?")
        error = self.assert_code("input_mismatch", lambda: self.phone.type_text(EMAIL, "你好 👋", submit=True,
                                                                               verify=True))
        self.assertEqual((error.details["expected_length"], error.details["actual_length"]), (4, 4))
        self.assertNotIn("你好", json.dumps(error.as_dict(), ensure_ascii=False))  # typed text is never echoed
        self.assertIn("image", error.details["observation"])
        self.assertTrue(error.details["recovery"]["visual_check_required"])
        self.assertTrue(error.details["action_executed"])
        self.assertEqual(self.h.actions(), ["POST /element/:id/click", "POST /element/:id/clear",
                                            "POST /element/:id/value"])
        self.assertEqual(self.fake.submits, [])

    def test_line_breaks_need_intent_and_a_multi_line_field(self):
        for text in ("a\nb", "a\rb"):
            with self.subTest(text=text):
                self.assert_code("newline_requires_intent", lambda: self.phone.type_text(EMAIL, text))
        self.assertEqual(self.fake.requests, [])
        error = self.assert_code("newline_unsafe", lambda: self.phone.type_text(EMAIL, "a\nb", allow_newlines=True))
        self.assertFalse(error.details["action_executed"])
        self.assertNotIn("observation", error.details)
        self.assertEqual(self.fake.actions(), [])

    def test_an_explicit_multi_line_text_view_round_trips(self):
        result = self.phone.type_text(MESSAGE, "第一行\n第二行", allow_newlines=True, verify=True)
        self.assertTrue(result["exact_readback"])
        self.assertFalse(result["submitted"])
        self.assertEqual(self.fake.node(name="message").value, "第一行\n第二行")

    def test_submit_is_refused_for_a_multi_line_editor_before_any_mutation(self):
        error = self.assert_code("submit_unsafe", lambda: self.phone.type_text(MESSAGE, "hello", submit=True))
        self.assertFalse(error.details["action_executed"])
        self.assertIn("tap the visible Send button", error.message)
        self.assertNotIn("observation", error.details)
        self.assertEqual(self.fake.actions(), [])
        self.assertEqual(self.h.count("GET /screenshot"), 0)

    def test_text_is_validated_before_any_request(self):
        for text in ("", "\x00", "a\tb", "a\x7fb", "\x1b[0m", "x" * 10001, 5, ["a"]):
            with self.subTest(text=text if isinstance(text, str) and len(text) < 20 else type(text)):
                error = self.assert_code("invalid_argument", lambda: self.phone.type_text(EMAIL, text))
                self.assertFalse(error.details["action_executed"])
        error = self.assert_code("invalid_argument", lambda: self.phone.type_text(EMAIL))
        self.assertIn("needs text", error.message)
        for arguments in ({"submit": "yes"}, {"replace": 1}, {"verify": None}, {"allow_newlines": "true"},
                          {"observe": "image"}):
            with self.subTest(arguments=arguments):
                self.assert_code("invalid_argument", lambda: self.phone.type_text(EMAIL, "abc", **arguments))
        self.assert_code("invalid_selector", lambda: self.phone.type_text(EMAIL, "abc", expect={"text": "x"}))
        self.assertEqual(self.fake.requests, [])

    def test_the_maximum_text_length_is_accepted(self):
        self.phone.typing_piece = 5000
        result = self.phone.type_text(EMAIL, "x" * 10000)
        self.assertEqual(result["characters"], 10000)
        self.assertEqual(len(self.email.value), 10000)

    def test_an_expectation_after_submit_verifies_the_submission_step(self):
        result = self.phone.type_text(EMAIL, "me@example.com", submit=True, expect={"label": "Send"}, observe="tree")
        self.assertTrue(result["submitted"])
        self.assertTrue(result["submission_verified"])
        self.assertTrue(result["verified"])
        self.assertFalse(result["verification_deferred"])
        self.assertEqual(result["verification_scope"], wda_controller.SUBMIT_SCOPE)
        self.assertEqual(result["postcondition"]["matches"], 1)
        self.assertIn("nodes", result["observation"])

    def test_a_grapheme_is_never_split_between_requests(self):
        family = "👨‍👩‍👧"
        text = "a" * 199 + family + "b" * 10
        self.phone.type_text(EMAIL, text)
        self.assertEqual(self.bodies("/element/:id/value")[0]["text"], "a" * 199)
        self.assertEqual(self.bodies("/wda/keys"), [{"value": [family + "b" * 10], "frequency": 30}])
        self.assertEqual(self.email.value, text)


class FocusedFieldTests(TypingCase):
    def test_text_without_a_selector_goes_to_the_field_focused_by_a_coordinate_tap(self):
        self.email.value = "old"
        self.phone.tap(x=EMAIL_POINT[0], y=EMAIL_POINT[1])
        self.fake.clear_log()
        result = self.phone.type_text(text="坐标聚焦后输入", verify=True)
        self.assertTrue(result["exact_readback"])
        self.assertEqual(self.email.value, "坐标聚焦后输入")
        # No second tap that could move the caret, and no selector query at all.
        self.assertEqual(self.h.actions(), ["POST /element/:id/clear", "POST /wda/keys"])
        self.assertEqual(self.h.count("POST /elements"), 0)
        self.assertEqual(self.h.count("GET /element/active"), 1)
        appended = self.phone.type_text(text="++", replace=False)
        self.assertTrue(appended["action_complete"])
        self.assertEqual(self.email.value, "坐标聚焦后输入++")

    def test_no_focused_field_returns_the_screen_and_the_tap_first_hint(self):
        error = self.assert_code("no_focused_field", lambda: self.phone.type_text(text="nowhere"))
        self.assertFalse(error.details["action_executed"])
        recovery = error.details["recovery"]
        self.assertEqual((recovery["use"], recovery["next_tool"]), ("coordinates", "iphone_tap"))
        self.assertEqual(recovery["next_step"], wda_controller.TYPING_STEP + wda_controller.STEP_SUFFIX)
        self.assertIn("no selector", recovery["next_step"])
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.actions(), [])

    def test_focused_input_keeps_every_text_safeguard(self):
        self.phone.tap(x=EMAIL_POINT[0], y=EMAIL_POINT[1])
        self.assert_code("newline_unsafe", lambda: self.phone.type_text(text="a\nb", allow_newlines=True))
        self.phone.tap(x=PASSWORD_POINT[0], y=PASSWORD_POINT[1])
        error = self.assert_code("not_editable", lambda: self.phone.type_text(text="never typed"))
        self.assertTrue(error.details["secure_field"])
        self.assertNotIn("observation", error.details)
        self.fake.inject("GET", "/element/active",
                         value={ELEMENT_KEY: "ABC-1", "ELEMENT": "ABC-1", "type": "XCUIElementTypeButton"})
        error = self.assert_code("not_editable", lambda: self.phone.type_text(text="never typed"))
        self.assertFalse(error.details["secure_field"])
        self.assertEqual(self.h.actions(), ["POST /wda/tap", "POST /wda/tap"])
        self.assertEqual(self.fake.typed, [])

    def test_a_focused_answer_without_an_element_id_is_no_focus(self):
        self.fake.inject("GET", "/element/active", value={})
        self.assert_code("no_focused_field", lambda: self.phone.type_text(text="x"))

    def test_other_focus_read_errors_are_passed_through(self):
        self.fake.inject("GET", "/element/active", error="unknown error", message="snapshot failed")
        error = self.assert_code("unknown error", lambda: self.phone.type_text(text="x"))
        self.assertFalse(error.details["action_executed"])
        self.assertNotIn("observation", error.details)

    def test_a_failed_selector_points_to_tap_then_focused_input(self):
        error = self.assert_code("no_such_element", lambda: self.phone.type_text({"label": "Search"}, "query"))
        self.assertIn("no selector", error.details["recovery"]["next_step"])
        self.assertIn("image", error.details["observation"])
        self.assertEqual(self.fake.actions(), [])


class LongInputTests(TypingCase):
    def test_long_text_is_typed_in_short_requests_with_matching_timeouts(self):
        text = "中文 mix 输入。" * 45
        self.assertEqual(len(text), 450)
        with mock.patch.object(self.h.client, "session", wraps=self.h.client.session) as spy:
            result = self.phone.type_text(EMAIL, text)
        self.assertTrue(result["action_complete"])
        self.assertEqual(result["characters"], 450)
        self.assertNotIn("continue_token", result)
        self.assertEqual(self.email.value, text)
        typing = [route for route in self.h.routes() if route in ("POST /element/:id/value", "POST /wda/keys")]
        self.assertEqual(typing, ["POST /element/:id/value", "POST /wda/keys", "POST /wda/keys"])
        self.assertEqual(self.typing_timeouts(spy), [request_timeout(200, 30, 15.0), request_timeout(200, 30, 15.0),
                                                     15.0])
        self.assertAlmostEqual(self.typing_timeouts(spy)[0], 200 / 30 * 2 + 10)
        sent = self.bodies("/element/:id/value") + self.bodies("/wda/keys")
        self.assertTrue(all(body["frequency"] == 30 for body in sent))
        self.assertTrue(all(isinstance(body["value"], list) for body in self.bodies("/wda/keys")))
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 0)

    def test_short_text_is_still_one_request(self):
        self.phone.type_text(EMAIL, "x" * 200)
        self.assertEqual(self.h.actions(), ["POST /element/:id/click", "POST /element/:id/clear",
                                            "POST /element/:id/value"])

    def test_frequency_and_piece_size_are_knobs(self):
        self.phone.typing_frequency = 60
        self.phone.typing_piece = 100
        with mock.patch.object(self.h.client, "session", wraps=self.h.client.session) as spy:
            self.phone.type_text(EMAIL, "y" * 250)
        self.assertEqual(self.h.count("POST /element/:id/value") + self.h.count("POST /wda/keys"), 3)
        self.assertTrue(all(body["frequency"] == 60
                            for body in self.bodies("/element/:id/value") + self.bodies("/wda/keys")))
        self.assertEqual(self.typing_timeouts(spy), [15.0, 15.0, 15.0])

    def test_the_budget_hands_back_a_token_and_finishes_with_the_original_options(self):
        self.phone.call_budget = 0
        text = "".join(chr(0x4E00 + number % 500) for number in range(500))
        first = self.phone.type_text(EMAIL, text, verify=True, submit=True, observe="tree")
        self.assertEqual((first["input_complete"], first["action_complete"], first["submitted"]), (False, False, False))
        self.assertEqual((first["characters"], first["remaining_characters"]), (200, 300))
        self.assertEqual(first["next_step"], wda_controller.TYPE_PARTIAL_NEXT_STEP)
        self.assertRegex(first["continue_token"], r"^[0-9a-f]{12}$")
        self.assertNotIn("observation", first)
        self.assertNotIn(RETURN, [request.body for request in self.fake.actions()])
        second = self.phone.type_text(continue_token=first["continue_token"])
        self.assertEqual((second["characters"], second["remaining_characters"]), (400, 100))
        self.assertNotEqual(second["continue_token"], first["continue_token"])
        final = self.phone.type_text(continue_token=second["continue_token"])
        self.assertTrue(final["action_complete"])
        self.assertTrue(final["input_complete"])
        self.assertTrue(final["exact_readback"])
        self.assertTrue(final["submitted"])
        self.assertIn("nodes", final["observation"])
        self.assertEqual(self.email.value, text)
        actions = self.fake.actions()
        self.assertEqual(actions[-1].body, RETURN)
        self.assertEqual(sum(request.body == RETURN for request in actions), 1)
        self.assertEqual(self.h.count("POST /element/:id/clear"), 1)
        self.assertEqual(self.h.count("GET /element/:id/attribute/value"), 1)
        self.assertEqual(self.fake.submits, [text])
        self.assert_code("input_continuation_expired",
                         lambda: self.phone.type_text(continue_token=second["continue_token"]))

    def test_another_phone_action_invalidates_the_continuation(self):
        self.phone.call_budget = 0
        first = self.phone.type_text(EMAIL, "a" * 500)
        self.phone.observe()
        self.phone.tap(x=10, y=10)
        error = self.assert_code("input_continuation_expired",
                                 lambda: self.phone.type_text(continue_token=first["continue_token"]))
        self.assertFalse(error.details["action_executed"])
        self.assertFalse(error.details["recovery"]["replay_action"])
        self.assertIn("replace=false", error.details["recovery"]["next_step"])
        self.assertEqual(self.email.value, "a" * 200)

    def test_reads_do_not_invalidate_and_unknown_tokens_type_nothing(self):
        self.phone.call_budget = 0
        first = self.phone.type_text(EMAIL, "a" * 300)
        self.phone.observe()
        self.phone.find(EMAIL)
        self.phone.wait(EMAIL, timeout_seconds=0)
        self.assertEqual(self.phone.type_text(continue_token=first["continue_token"])["characters"], 300)
        second = self.phone.type_text(EMAIL, "b" * 300)
        self.assert_code("input_continuation_expired", lambda: self.phone.type_text(continue_token="unknown"))
        self.assertEqual(self.email.value, "b" * 200)
        # An unknown token also drops the pending text, so the real token no longer works either.
        self.assert_code("input_continuation_expired",
                         lambda: self.phone.type_text(continue_token=second["continue_token"]))

    def test_a_user_action_in_the_preview_invalidates_the_continuation(self):
        screen = RecordingScreen()
        h = self.make_harness(screen=screen)
        h.fake.set_foreground(FORM)
        h.phone.call_budget = 0
        first = h.phone.type_text(EMAIL, "a" * 500)
        screen.note_external_action()  # e.g. Home from another process's preview toolbar
        self.assert_code("input_continuation_expired",
                         lambda: h.phone.type_text(continue_token=first["continue_token"]))
        self.assertEqual(h.fake.node(name="email").value, "a" * 200)
        second = h.phone.type_text(EMAIL, "c" * 500)
        h.phone.external_action()  # Home from this process's toolbar
        self.assert_code("input_continuation_expired",
                         lambda: h.phone.type_text(continue_token=second["continue_token"]))

    def test_a_continuation_expires_after_its_time_to_live(self):
        self.phone.call_budget = 0
        with fake_clock() as clock:
            first = self.phone.type_text(EMAIL, "a" * 300)
            clock.advance(wda_controller.INPUT_TTL + 1)
            self.assert_code("input_continuation_expired",
                             lambda: self.phone.type_text(continue_token=first["continue_token"]))
        self.assertEqual(self.email.value, "a" * 200)

    def test_a_continuation_accepts_no_other_argument(self):
        for extra in ({"text": "more"}, {"selector": EMAIL}, {"submit": True}, {"replace": False}, {"verify": True},
                      {"observe": "tree"}, {"expect": {"name": "email"}}, {"allow_newlines": True}):
            with self.subTest(extra=extra):
                error = self.assert_code("invalid_argument", lambda: self.phone.type_text(continue_token="token",
                                                                                         **extra))
                self.assertFalse(error.details["action_executed"])
        self.assert_code("invalid_argument", lambda: self.phone.type_text(selector=EMAIL))
        self.assertEqual(self.fake.requests, [])

    def test_a_failure_midway_reports_what_was_accepted_and_stops(self):
        self.fake.inject("POST", "/wda/keys", drop=True, execute=True)
        error = self.assert_code("action_uncertain", lambda: self.phone.type_text(EMAIL, "a" * 900, submit=True))
        self.assertEqual((error.details["characters_confirmed"], error.details["characters_total"]), (200, 900))
        self.assertTrue(error.details["action_executed"])
        self.assertFalse(error.details["action_complete"])
        self.assertEqual(self.h.count("POST /wda/keys"), 1)
        self.assertNotIn(RETURN, [request.body for request in self.fake.actions()])
        self.assertIsNone(self.phone.pending_input)


if __name__ == "__main__":
    unittest.main()
