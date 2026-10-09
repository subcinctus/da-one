import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import copy  # noqa: E402
import inspect  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import unittest  # noqa: E402

import mcp_schemas  # noqa: E402
import wda_controller  # noqa: E402
from errors import ToolError  # noqa: E402
from mcp_schemas import SCHEMAS, TOOL_NAMES, validate, validate_semantics  # noqa: E402
from runtime import Runtime  # noqa: E402
from wda_apps import AppCatalog  # noqa: E402
from wda_controller import PhoneController  # noqa: E402
from wda_setup import SetupManager  # noqa: E402

EXPECTED_NAMES = ("iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
                  "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text",
                  "iphone_wait", "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen",
                  "iphone_metrics")
ANNOTATIONS = {  # (readOnly, destructive, idempotent, openWorld) from DESIGN.md 11.1
    "iphone_doctor": (True, False, True, False), "iphone_setup": (False, True, False, False),
    "iphone_ready": (False, False, False, False), "iphone_observe": (True, False, True, False),
    "iphone_find": (True, False, True, False), "iphone_apps": (True, False, True, True),
    "iphone_launch_app": (False, True, False, False), "iphone_tap": (False, True, False, False),
    "iphone_swipe": (False, True, False, False), "iphone_press_button": (False, True, False, False),
    "iphone_type_text": (False, True, False, False), "iphone_wait": (True, False, True, False),
    "iphone_batch": (False, True, False, False), "iphone_scroll_find": (False, True, False, False),
    "iphone_collect_list": (False, True, False, False), "iphone_screen": (False, False, True, False),
    "iphone_metrics": (True, False, True, False),
}
CONTROLLER_RAISES = ("invalid_argument", "invalid_selector", "stale_observation", "foreground_unavailable",
                     "no_such_element", "ambiguous_target", "occluded_target", "offscreen_target", "not_editable",
                     "no_focused_field", "search_exhausted", "newline_requires_intent", "newline_unsafe",
                     "submit_unsafe", "input_mismatch", "input_continuation_expired", "postcondition_failed",
                     "modal_requires_region", "blocked_scroll_region", "scroll_context_changed", "no_scroll_progress",
                     "invalid_response", "service_unreachable", "action_uncertain", "response_too_large",
                     "http_error")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def schema_nodes(schema, path="schema"):
    """Every schema object inside a schema (not the property-name maps), with a path."""
    yield path, schema
    for key, value in schema.items():
        if key == "properties":
            for name, child in value.items():
                for item in schema_nodes(child, "%s.properties.%s" % (path, name)):
                    yield item
        elif key == "items":
            for item in schema_nodes(value, path + ".items"):
                yield item
        elif key == "oneOf":
            for index, child in enumerate(value):
                for item in schema_nodes(child, "%s.oneOf[%d]" % (path, index)):
                    yield item
        elif key == "$defs":
            for name, child in value.items():
                for item in schema_nodes(child, "%s.$defs.%s" % (path, name)):
                    yield item


def expand(schema, root=None):
    """Resolve local $refs of a published schema (and drop $defs)."""
    root = schema if root is None else root
    if isinstance(schema, dict):
        if "$ref" in schema:
            target = schema["$ref"]
            assert target.startswith("#/$defs/"), target
            return expand(root["$defs"][target[len("#/$defs/"):]], root)
        return {key: expand(value, root) for key, value in schema.items() if key != "$defs"}
    if isinstance(schema, list):
        return [expand(item, root) for item in schema]
    return schema


def assert_argument_error(case, value, schema, message, path="arguments", code="invalid_argument"):
    with case.assertRaises(ToolError) as caught:
        validate(value, schema)
    error = caught.exception
    case.assertEqual(error.code, code)
    case.assertEqual(error.message, message)
    case.assertEqual(error.details["argument_path"], path)
    case.assertIs(error.details["action_executed"], False)
    return error


class CatalogTests(unittest.TestCase):
    def test_seventeen_names_in_order(self):
        self.assertEqual(TOOL_NAMES, EXPECTED_NAMES)
        self.assertEqual(tuple(SCHEMAS), EXPECTED_NAMES)
        self.assertEqual(tuple(entry["name"] for entry in mcp_schemas.TOOLS), EXPECTED_NAMES)
        self.assertEqual(tuple(mcp_schemas.DESCRIPTIONS), EXPECTED_NAMES)
        self.assertEqual(mcp_schemas.op_name("iphone_type_text"), "type_text")
        self.assertEqual(mcp_schemas.tool_name("type_text"), "iphone_type_text")

    def test_tools_list_entries(self):
        for entry in mcp_schemas.TOOLS:
            name = entry["name"]
            with self.subTest(tool=name):
                expected_keys = {"name", "title", "description", "inputSchema", "annotations"}
                if name == "iphone_ready":
                    expected_keys.add("_meta")
                    self.assertEqual(entry["_meta"], {"anthropic/alwaysLoad": True})
                self.assertEqual(set(entry), expected_keys)
                self.assertTrue(entry["title"].startswith("iPhone: "))
                annotations = entry["annotations"]
                self.assertEqual(annotations["title"], entry["title"])
                self.assertEqual((annotations["readOnlyHint"], annotations["destructiveHint"],
                                  annotations["idempotentHint"], annotations["openWorldHint"]), ANNOTATIONS[name])
                self.assertEqual(entry["description"], mcp_schemas.DESCRIPTIONS[name])
                self.assertEqual(entry["inputSchema"]["type"], "object")
                self.assertNotIn("oneOf", entry["inputSchema"])
                self.assertNotIn("outputSchema", entry)
        self.assertEqual(mcp_schemas.TOOLS[2]["title"], "iPhone: Check ready")
        self.assertEqual(mcp_schemas.TOOLS[15]["title"], "iPhone: Live screen")

    def test_every_object_is_closed(self):
        for name in TOOL_NAMES:
            for published in (False, True):
                schema = mcp_schemas.published_schema(name) if published else SCHEMAS[name]
                for path, node in schema_nodes(schema, name):
                    if node.get("type") == "object":
                        with self.subTest(path=path, published=published):
                            self.assertIs(node.get("additionalProperties"), False)
                            self.assertIsInstance(node.get("required"), list)
                            self.assertIsInstance(node.get("properties"), dict)

    def test_property_names_are_valid(self):
        for name in TOOL_NAMES:
            for prop in SCHEMAS[name]["properties"]:
                self.assertRegex(prop, r"^[A-Za-z0-9_.-]{1,64}$")

    def test_published_schema_is_the_runtime_contract_minus_documentation(self):
        for name in TOOL_NAMES:
            with self.subTest(tool=name):
                published = mcp_schemas.published_schema(name)
                self.assertEqual(mcp_schemas.undocumented(expand(published)), mcp_schemas.undocumented(SCHEMAS[name]))

    def test_shared_blocks_become_refs_only_when_repeated(self):
        tap = mcp_schemas.published_schema("iphone_tap")
        self.assertEqual(tap["properties"]["selector"], {"$ref": "#/$defs/selector"})
        self.assertEqual(tap["properties"]["expect"], {"$ref": "#/$defs/selector"})
        self.assertEqual(tap["properties"]["observe"], mcp_schemas.OBS_BRIEF)
        self.assertEqual(set(tap["$defs"]), {"selector"})
        self.assertEqual(tap["$defs"]["selector"], mcp_schemas.SEL_BRIEF)
        wait = mcp_schemas.published_schema("iphone_wait")
        self.assertEqual(wait["properties"]["selector"], mcp_schemas.SEL_BRIEF)
        self.assertNotIn("$defs", wait)
        self.assertNotIn("$defs", mcp_schemas.published_schema("iphone_doctor"))
        self.assertEqual(mcp_schemas.published_schema("iphone_find"), SCHEMAS["iphone_find"])

    def test_batch_is_published_without_any_documentation(self):
        batch = mcp_schemas.published_schema("iphone_batch")
        text = compact(batch)
        self.assertNotIn('"description"', text)
        self.assertNotIn('"examples"', text)
        self.assertEqual(set(batch["$defs"]), {"selector", "observe"})
        self.assertEqual(batch["$defs"]["selector"], mcp_schemas.undocumented(mcp_schemas.SEL))
        branches = batch["properties"]["steps"]["items"]["oneOf"]
        self.assertEqual([branch["properties"]["op"]["const"] for branch in branches], list(mcp_schemas.BATCH_OPS))

    def test_size_budgets(self):
        for name in TOOL_NAMES:
            with self.subTest(tool=name):
                self.assertLess(len(compact(mcp_schemas.published_schema(name)).encode("utf-8")), 5500)
        self.assertLess(len(compact({"tools": mcp_schemas.TOOLS}).encode("utf-8")), 36000)

    def test_selector_fields_are_documented_once(self):
        catalog = compact({"tools": mcp_schemas.TOOLS})
        for field, schema in mcp_schemas.SEL["properties"].items():
            with self.subTest(field=field):
                self.assertEqual(catalog.count(json.dumps(schema["description"])), 1)
        self.assertEqual(catalog.count(json.dumps(mcp_schemas.SEL["description"])), 1)
        find = mcp_schemas.TOOLS[TOOL_NAMES.index("iphone_find")]["inputSchema"]
        self.assertEqual(find["properties"]["selector"], mcp_schemas.SEL)
        self.assertIn("iphone_find.selector", mcp_schemas.SEL_BRIEF["description"])

    def test_batch_branches_equal_the_standalone_schemas(self):
        branches = SCHEMAS["iphone_batch"]["properties"]["steps"]["items"]["oneOf"]
        self.assertEqual(len(branches), len(mcp_schemas.BATCH_OPS))
        for op, branch in zip(mcp_schemas.BATCH_OPS, branches):
            with self.subTest(op=op):
                self.assertEqual(branch["properties"]["op"], {"type": "string", "const": op})
                self.assertEqual(branch["properties"]["args"], SCHEMAS["iphone_" + op])
                self.assertEqual(branch["required"], ["op", "args"])
                self.assertIs(branch["additionalProperties"], False)
        steps = SCHEMAS["iphone_batch"]["properties"]["steps"]
        self.assertEqual((steps["minItems"], steps["maxItems"]), (1, 20))

    def test_batch_ops_match_the_controller(self):
        self.assertEqual(mcp_schemas.BATCH_OPS, wda_controller.BATCH_OPS)

    def test_publication_never_changes_the_runtime_schemas(self):
        before = copy.deepcopy(SCHEMAS)
        for name in TOOL_NAMES:
            published = mcp_schemas.published_schema(name)
            for _, node in schema_nodes(published):
                node.clear()
        for entry in mcp_schemas.TOOLS:
            self.assertTrue(entry["inputSchema"])
        self.assertEqual(SCHEMAS, before)
        self.assertNotIn("$ref", compact(SCHEMAS))

    def test_valid_examples_pass_both_contracts(self):
        examples = (("iphone_tap", {"selector": {"label": "Back", "type": "Button"}, "observe": "tree"}),
                    ("iphone_batch", {"steps": [{"op": "tap", "args": {"x": 10, "y": 20}},
                                                {"op": "type_text", "args": {"text": "hello", "submit": True}},
                                                {"op": "observe", "args": {"mode": "both"}}]}),
                    ("iphone_setup", {"action": "configure", "network_mode": "allow_network"}),
                    ("iphone_swipe", {"region": {"x": 0, "y": 100, "width": 390, "height": 500.5}}))
        for name, args in examples:
            with self.subTest(tool=name):
                validate(args, SCHEMAS[name])
                validate_semantics(name, args)
                validate(args, expand(mcp_schemas.published_schema(name)))

    def test_setup_schema_carries_network_mode_without_a_default(self):
        prop = SCHEMAS["iphone_setup"]["properties"]["network_mode"]
        self.assertEqual(prop["enum"], ["usb_only", "allow_network"])
        self.assertNotIn("default", prop)
        self.assertEqual(SCHEMAS["iphone_setup"]["required"], ["action"])
        self.assertEqual(SCHEMAS["iphone_setup"]["properties"]["action"]["enum"],
                         ["status", "discover", "configure", "fetch", "build", "start", "stop"])


class DefaultsTests(unittest.TestCase):
    """Every schema default equals the handler's keyword default (DESIGN.md 11.2)."""

    HANDLERS = {
        "iphone_observe": PhoneController.observe, "iphone_find": PhoneController.find,
        "iphone_tap": PhoneController.tap, "iphone_swipe": PhoneController.swipe,
        "iphone_type_text": PhoneController.type_text, "iphone_press_button": PhoneController.press_button,
        "iphone_launch_app": PhoneController.launch_app, "iphone_wait": PhoneController.wait,
        "iphone_scroll_find": PhoneController.scroll_find, "iphone_collect_list": PhoneController.collect_list,
        "iphone_batch": PhoneController.batch, "iphone_ready": Runtime.ready, "iphone_screen": Runtime.screen_tool,
        "iphone_metrics": Runtime.metrics, "iphone_apps": AppCatalog.lookup,
    }

    def test_defaults_equal_handler_signatures(self):
        checked = 0
        for name, handler in self.HANDLERS.items():
            parameters = inspect.signature(handler).parameters
            for prop, schema in SCHEMAS[name]["properties"].items():
                with self.subTest(tool=name, field=prop):
                    self.assertIn(prop, parameters, "schema field without a handler parameter")
                    if "default" in schema:
                        self.assertEqual(parameters[prop].default, schema["default"])
                        self.assertIs(type(parameters[prop].default), type(schema["default"]))
                        checked += 1
                    elif prop not in SCHEMAS[name]["required"]:
                        self.assertIsNot(parameters[prop].default, inspect.Parameter.empty)
            for prop in SCHEMAS[name]["required"]:
                self.assertIs(parameters[prop].default, inspect.Parameter.empty)
        status = inspect.signature(SetupManager.status).parameters
        self.assertEqual(status["wait_seconds"].default,
                         SCHEMAS["iphone_setup"]["properties"]["wait_seconds"]["default"])
        self.assertGreater(checked, 25)

    def test_ready_defaults_to_no_screenshot(self):
        self.assertIs(inspect.signature(Runtime.ready).parameters["screenshot"].default, False)
        self.assertIs(SCHEMAS["iphone_ready"]["properties"]["screenshot"]["default"], False)


class TextTests(unittest.TestCase):
    def test_description_lengths(self):
        for name, text in mcp_schemas.DESCRIPTIONS.items():
            with self.subTest(tool=name):
                self.assertLessEqual(len(text), 1000)
                self.assertNotIn("  ", text)
                self.assertNotIn("\n", text)

    def test_instructions(self):
        text = mcp_schemas.INSTRUCTIONS
        self.assertEqual(len(text), 2026)
        self.assertLessEqual(len(text), 2048)
        self.assertNotIn("\n", text)
        self.assertNotIn("  ", text)
        tokens = set(re.findall(r"\biphone_[a-z][a-z_]*", text))
        self.assertTrue(tokens)
        self.assertLessEqual(tokens, set(TOOL_NAMES))
        self.assertIn("iphone-use skill", text)
        self.assertIn("iphone-use-setup", text)
        self.assertIn("AskUserQuestion", text)
        self.assertTrue(text.startswith("iPhone Use operates the user's real iPhone over USB;"))
        self.assertTrue(text.endswith("The live preview is for the user, never evidence."))

    def test_exact_texts(self):
        self.assertEqual(mcp_schemas.DESCRIPTIONS["iphone_find"],
                         "Look up elements by selector without reading the whole screen tree. Returns matches in "
                         "tree order with index, type, texts, rect and tap point; zero matches is not an error. "
                         "This tool's selector documents the fields every selector accepts.")
        self.assertEqual(mcp_schemas.SEL_BRIEF["description"],
                         "Selector; the fields are documented on iphone_find.selector.")
        self.assertEqual(mcp_schemas.OBS_BRIEF["description"],
                         "Output after the action for the next decision; default none.")

    def test_no_codex_era_tokens(self):
        text = compact({"tools": mcp_schemas.TOOLS, "instructions": mcp_schemas.INSTRUCTIONS})
        for token in ("functions.exec", "view_image", "pua_", "PUA", "side panel", "widget"):
            self.assertNotIn(token, text)

    def test_error_code_catalog(self):
        codes = mcp_schemas.MODEL_ERROR_CODES
        self.assertIsInstance(codes, frozenset)
        self.assertEqual(len(codes), 41)
        self.assertLessEqual(set(CONTROLLER_RAISES), codes)
        for code in codes:
            self.assertRegex(code, r"^[a-z_]+$")
        self.assertFalse(set(mcp_schemas.RAW_WDA_ERRORS) & codes)
        self.assertFalse(mcp_schemas.TOOLBAR_ERROR_CODES & codes)
        for code in ("device_busy", "phone_locked", "not_ready", "mirroring_conflict", "recovery_not_started",
                     "internal_error", "unknown_tool", "config_invalid", "state_dir_unsafe"):
            self.assertIn(code, codes)


class ValidatorTests(unittest.TestCase):
    def test_validator_supports_every_keyword_used(self):
        known = mcp_schemas.SUPPORTED_KEYWORDS | mcp_schemas.IGNORED_KEYWORDS
        used = set()
        for name in TOOL_NAMES:
            for _, node in schema_nodes(SCHEMAS[name], name):
                used.update(node)
        self.assertLessEqual(used, known)
        self.assertLessEqual(mcp_schemas.SUPPORTED_KEYWORDS, used | {"items"})

    def test_each_supported_keyword_is_enforced(self):
        cases = (
            ({"type": "object"}, [], "`arguments` must be object."),
            ({"type": "array"}, {}, "`arguments` must be array."),
            ({"type": "string"}, 1, "`arguments` must be string."),
            ({"type": "boolean"}, 1, "`arguments` must be boolean."),
            ({"type": "number"}, True, "`arguments` must be number."),
            ({"type": "number"}, math.nan, "`arguments` must be number."),
            ({"type": "number"}, math.inf, "`arguments` must be number."),
            ({"type": "integer"}, 1.0, "`arguments` must be integer."),
            ({"type": "integer"}, False, "`arguments` must be integer."),
            ({"type": "string", "enum": ["a"]}, "b", "Invalid `arguments` option."),
            ({"type": "string", "const": "a"}, "b", "Invalid `arguments` option."),
            ({"type": "number", "minimum": 1}, 0.5, "`arguments` is out of range."),
            ({"type": "integer", "maximum": 3}, 4, "`arguments` is out of range."),
            ({"type": "string", "minLength": 2}, "a", "`arguments` has invalid length."),
            ({"type": "string", "maxLength": 2}, "abc", "`arguments` has invalid length."),
            ({"type": "array", "minItems": 1, "items": {}}, [], "`arguments` has invalid number of items."),
            ({"type": "array", "maxItems": 1, "items": {}}, [1, 2], "`arguments` has invalid number of items."),
            ({"type": "array", "items": {"type": "string"}}, ["a", 2], "`arguments[1]` must be string."),
            (mcp_schemas._object({"a": {"type": "string"}}, ["a"]), {}, "Missing required fields in `arguments`: a."),
            ({"type": "object", "properties": {}, "minProperties": 1}, {}, "`arguments` cannot be empty."),
            ({"oneOf": [{"type": "string"}, {"type": "boolean"}]}, 3, "`arguments` must match exactly one allowed "
                                                                       "form."),
        )
        for schema, value, message in cases:
            with self.subTest(schema=schema, value=value):
                path = "arguments[1]" if message.startswith("`arguments[1]`") else "arguments"
                assert_argument_error(self, value, schema, message, path)

    def test_unknown_fields_details(self):
        error = assert_argument_error(self, {"mode": "tree", "zeta": 1, "alpha": 2}, SCHEMAS["iphone_observe"],
                                      "Unknown fields in `arguments`: alpha, zeta. Use only the declared fields.")
        self.assertEqual(error.details["unknown_fields"], ["alpha", "zeta"])
        self.assertEqual(error.details["allowed_fields"],
                         ["expensive_visibility", "include_invisible", "max_nodes", "mode"])
        self.assertEqual(error.details["recovery"]["replay_action"], False)
        self.assertIn("nothing was done on the phone", error.details["recovery"]["next_step"])

    def test_unknown_fields_are_reported_before_missing_ones(self):
        error = assert_argument_error(self, {"bogus": 1}, SCHEMAS["iphone_find"],
                                      "Unknown fields in `arguments`: bogus. Use only the declared fields.")
        self.assertEqual(error.details["unknown_fields"], ["bogus"])
        assert_argument_error(self, {}, SCHEMAS["iphone_find"], "Missing required fields in `arguments`: selector.")

    def test_nested_paths(self):
        assert_argument_error(self, {"selector": {}}, SCHEMAS["iphone_find"], "`arguments.selector` cannot be empty.",
                              "arguments.selector")
        assert_argument_error(self, {"selector": {"label": ""}}, SCHEMAS["iphone_find"],
                              "`arguments.selector.label` has invalid length.", "arguments.selector.label")
        assert_argument_error(self, {"region": {"x": 0, "y": 0, "width": 0, "height": 10}}, SCHEMAS["iphone_swipe"],
                              "`arguments.region.width` is out of range.", "arguments.region.width")
        assert_argument_error(self, {"region": {"x": 0, "y": 0}}, SCHEMAS["iphone_swipe"],
                              "Missing required fields in `arguments.region`: height, width.", "arguments.region")

    def test_batch_step_errors_name_the_step(self):
        schema = SCHEMAS["iphone_batch"]
        steps = [{"op": "tap", "args": {"x": 1, "y": 2}}, {"op": "swipe", "args": {"max_attempts": 2}}]
        error = assert_argument_error(self, {"steps": steps}, schema,
                                      "Unknown fields in `arguments.steps[1].args`: max_attempts. Use only the "
                                      "declared fields.", "arguments.steps[1].args")
        self.assertIn("direction", error.details["allowed_fields"])
        assert_argument_error(self, {"steps": [{"op": "doctor", "args": {}}]}, schema,
                              "`arguments.steps[0]` must match exactly one allowed step schema.", "arguments.steps[0]")
        assert_argument_error(self, {"steps": [{"op": "tap"}]}, schema,
                              "Missing required fields in `arguments.steps[0]`: args.", "arguments.steps[0]")
        assert_argument_error(self, {"steps": [{"op": "wait", "args": {"selector": {"label": "x"},
                                                                       "timeout_seconds": 21}}]}, schema,
                              "`arguments.steps[0].args.timeout_seconds` is out of range.",
                              "arguments.steps[0].args.timeout_seconds")
        assert_argument_error(self, {"steps": []}, schema, "`arguments.steps` has invalid number of items.",
                              "arguments.steps")
        assert_argument_error(self, {"steps": [{"op": "observe", "args": {}}] * 21}, schema,
                              "`arguments.steps` has invalid number of items.", "arguments.steps")
        assert_argument_error(self, {"steps": ["tap"]}, schema,
                              "`arguments.steps[0]` must match exactly one allowed step schema.", "arguments.steps[0]")

    def test_enabled_accepts_a_boolean_or_the_exact_strings(self):
        schema = SCHEMAS["iphone_find"]
        for value in (True, False, "true", "false"):
            validate({"selector": {"enabled": value}}, schema)
        for value in ("TRUE", "yes", 1, None):
            with self.subTest(value=value):
                assert_argument_error(self, {"selector": {"enabled": value}}, schema,
                                      "`arguments.selector.enabled` must match exactly one allowed form.",
                                      "arguments.selector.enabled")

    def test_ranges_and_types_of_tool_fields(self):
        assert_argument_error(self, {"max_nodes": 301}, SCHEMAS["iphone_observe"],
                              "`arguments.max_nodes` is out of range.", "arguments.max_nodes")
        assert_argument_error(self, {"x": "10", "y": 1}, SCHEMAS["iphone_tap"], "`arguments.x` must be number.",
                              "arguments.x")
        assert_argument_error(self, {"max_swipes": 2, "selector": {"label": "a"}}, SCHEMAS["iphone_scroll_find"],
                              "`arguments.max_swipes` is out of range.", "arguments.max_swipes")
        assert_argument_error(self, {"query": "Notes", "country": "IND"}, SCHEMAS["iphone_apps"],
                              "`arguments.country` has invalid length.", "arguments.country")
        assert_argument_error(self, {"action": "status", "job_id": "abc"}, SCHEMAS["iphone_setup"],
                              "`arguments.job_id` has invalid length.", "arguments.job_id")
        assert_argument_error(self, {"action": "open", "open_browser": "yes"}, SCHEMAS["iphone_screen"],
                              "`arguments.open_browser` must be boolean.", "arguments.open_browser")
        validate({"x": 0, "y": 10000}, SCHEMAS["iphone_tap"])
        validate({"timeout_seconds": 0.5, "selector": {"label": "x"}}, SCHEMAS["iphone_wait"])


class SemanticTests(unittest.TestCase):
    def assert_semantic(self, name, args, code="invalid_argument", path="arguments"):
        validate(args, SCHEMAS[name])
        with self.assertRaises(ToolError) as caught:
            validate_semantics(name, args)
        error = caught.exception
        self.assertEqual(error.code, code, error.as_dict())
        self.assertIs(error.details["action_executed"], False)
        self.assertEqual(error.details["argument_path"], path)
        return error

    def test_tap_needs_a_selector_or_both_coordinates(self):
        for args in ({}, {"x": 1}, {"y": 1}, {"selector": {"label": "A"}, "x": 1},
                     {"selector": {"label": "A"}, "x": 1, "y": 2}, {"observation_id": "abc"}):
            with self.subTest(args=args):
                error = self.assert_semantic("iphone_tap", args)
                self.assertEqual(error.message, mcp_schemas.TAP_FORM_MESSAGE)
        for args in ({"selector": {"label": "A"}}, {"x": 1, "y": 2}, {"x": 1, "y": 2, "observation_id": "abc"}):
            validate_semantics("iphone_tap", args)

    def test_continue_token_must_be_alone(self):
        validate_semantics("iphone_type_text", {"continue_token": "abc"})
        for extra in ({"text": "x"}, {"replace": True}, {"selector": {"label": "x"}}):
            with self.subTest(extra=extra):
                args = dict(extra, continue_token="abc")
                error = self.assert_semantic("iphone_type_text", args)
                self.assertIn("pass it alone", error.message)

    def test_text_is_required_without_a_token(self):
        error = self.assert_semantic("iphone_type_text", {"replace": False})
        self.assertEqual(error.message, "iphone_type_text needs text, or continue_token alone.")

    def test_control_characters_and_line_breaks(self):
        for text in ("a\x07b", "tab\tseparated", "del\x7f", "nul\x00"):
            with self.subTest(text=repr(text)):
                self.assert_semantic("iphone_type_text", {"text": text}, path="arguments.text")
        for text in ("line\nbreak", "carriage\rreturn"):
            with self.subTest(text=repr(text)):
                self.assert_semantic("iphone_type_text", {"text": text}, code="newline_requires_intent",
                                     path="arguments.text")
                self.assert_semantic("iphone_type_text", {"text": text, "allow_newlines": False},
                                     code="newline_requires_intent", path="arguments.text")
                validate_semantics("iphone_type_text", {"text": text, "allow_newlines": True})
        validate_semantics("iphone_type_text", {"text": "Hello 👋 नमस्ते, 你好"})

    def test_selectors_are_checked_semantically(self):
        error = self.assert_semantic("iphone_find", {"selector": {"predicate": "label == 'x'", "label": "x"}},
                                     code="invalid_selector", path="arguments.selector")
        self.assertIn("predicate", error.message)
        self.assert_semantic("iphone_launch_app", {"bundle_id": "com.apple.Preferences", "expect": {"index": 1}},
                             code="invalid_selector", path="arguments.expect")
        self.assert_semantic("iphone_collect_list", {"end_selector": {"label": "a\x00"}}, code="invalid_selector",
                             path="arguments.end_selector")

    def test_bundle_id_and_country(self):
        for bundle in ("notabundle", "com.apple.notes;rm -rf", "com..x", ".com.x"):
            with self.subTest(bundle=bundle):
                self.assert_semantic("iphone_launch_app", {"bundle_id": bundle}, path="arguments.bundle_id")
        for bundle in ("com.apple.mobilenotes", "net.whatsapp.WhatsApp", "com.my_app.x-y"):
            validate_semantics("iphone_launch_app", {"bundle_id": bundle})
        self.assert_semantic("iphone_apps", {"query": "Notes", "country": "i1"}, path="arguments.country")
        validate_semantics("iphone_apps", {"query": "Notes", "country": "IN"})

    def test_every_batch_step_is_checked_before_anything_runs(self):
        steps = [{"op": "tap", "args": {"x": 1, "y": 2}},
                 {"op": "launch_app", "args": {"bundle_id": "bad bundle"}}]
        self.assert_semantic("iphone_batch", {"steps": steps}, path="arguments.steps[1].args.bundle_id")
        steps = [{"op": "observe", "args": {}}, {"op": "observe", "args": {}},
                 {"op": "type_text", "args": {"text": "a\nb"}}]
        self.assert_semantic("iphone_batch", {"steps": steps}, code="newline_requires_intent",
                             path="arguments.steps[2].args.text")
        steps = [{"op": "tap", "args": {"x": 1}}]
        self.assert_semantic("iphone_batch", {"steps": steps}, path="arguments.steps[0].args")
        steps = [{"op": "wait", "args": {"selector": {"label": "x", "predicate": "y"}}}]
        self.assert_semantic("iphone_batch", {"steps": steps}, code="invalid_selector",
                             path="arguments.steps[0].args.selector")

    def test_check_arguments_runs_both_passes(self):
        mcp_schemas.check_arguments("iphone_tap", {"x": 1, "y": 2})
        with self.assertRaises(ToolError):
            mcp_schemas.check_arguments("iphone_tap", {"x": 1})
        with self.assertRaises(ToolError):
            mcp_schemas.check_arguments("iphone_tap", {"x": "1", "y": 2})


if __name__ == "__main__":
    unittest.main()
