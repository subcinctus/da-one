import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ast  # noqa: E402
import copy  # noqa: E402
import json  # noqa: E402
import unittest  # noqa: E402

import wda_tree  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_wda import SETTINGS_XML  # noqa: E402
from wda_tree import (center, compact_node, contains, default_region, filter_nodes, full_type,  # noqa: E402
                      gesture_points, native_modals, on_screen, page_key, parse_source, predicate,
                      predicate_literal, region_nodes, row_identity, scroll_progress, selector_index,
                      short_type, validate_region)

VIEWPORT = {"width": 390.0, "height": 844.0, "units": "iPhone points"}
RULE1 = "A selector uses only label, label_contains, name, value, type, enabled, predicate and index."
RULE3 = "index only chooses among matches; add label, name, value, type, enabled or predicate."
RULE4 = "predicate must be used alone (index may accompany it)."
REGION_MESSAGE = "The scroll region must be inside the iPhone screen, in points."


def node(label="Row 1", y=200, kind="Cell", x=60, width=250, height=44, **extra):
    """A filter_nodes-style node (the shape the controller passes to the geometry helpers)."""
    result = {"type": wda_tree.TYPE_PREFIX + kind, "label": label, "name": label,
              "rect": {"x": float(x), "y": float(y), "width": float(width), "height": float(height)},
              "in_viewport": True}
    result.update(extra)
    return result


def element(kind="Button", x=0, y=0, width=10, height=10, **attributes):
    """A parse_source-style element dict."""
    result = {"type": wda_tree.TYPE_PREFIX + kind,
              "rect": {"x": float(x), "y": float(y), "width": float(width), "height": float(height)}}
    result.update(attributes)
    return result


class ErrorAssertions(unittest.TestCase):
    def assert_tool_error(self, code, function, *args, message=None, **kwargs):
        with self.assertRaises(ToolError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        if message is not None:
            self.assertEqual(caught.exception.message, message)
        return caught.exception

    def assert_invalid_selector(self, selector, message=None):
        error = self.assert_tool_error("invalid_selector", predicate, selector, message=message)
        self.assertEqual(error.details, {"action_executed": False})
        self.assertFalse(error.uncertain)
        return error


class TypeNameTests(unittest.TestCase):
    def test_short_and_full_type(self):
        self.assertEqual(short_type("XCUIElementTypeButton"), "Button")
        self.assertEqual(short_type("Button"), "Button")
        self.assertEqual(short_type(None), "")
        self.assertEqual(short_type(""), "")
        self.assertEqual(full_type("Button"), "XCUIElementTypeButton")
        self.assertEqual(full_type("XCUIElementTypeCell"), "XCUIElementTypeCell")

    def test_constants(self):
        self.assertEqual(wda_tree.ELEMENT_KEY, "element-6066-11e4-a52e-4f735466cecf")
        self.assertEqual(wda_tree.SELECTOR_FIELDS,
                         ("label", "label_contains", "name", "value", "type", "enabled", "predicate", "index"))
        self.assertEqual(wda_tree.STATUS_BAR_Y, 45.0)
        self.assertIn(wda_tree.TEXT_VIEW, wda_tree.EDITABLE_TYPES)
        self.assertNotIn(wda_tree.SECURE_TYPE, wda_tree.EDITABLE_TYPES)

    def test_only_errors_is_imported_from_the_plugin(self):
        with open(wda_tree.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), feature_version=(3, 9))
        modules = set()
        for item in ast.walk(tree):
            if isinstance(item, ast.Import):
                modules.update(alias.name for alias in item.names)
            elif isinstance(item, ast.ImportFrom):
                modules.add(item.module)
        self.assertEqual(modules - {"__future__", "collections", "json", "math", "xml.etree.ElementTree"},
                         {"errors"})


class PredicateTests(ErrorAssertions):
    def test_examples_verbatim(self):
        self.assertEqual(
            predicate({"label": "it's \n", "type": "Button", "enabled": True}),
            "label == 'it\\'s \\u000a' AND type == 'XCUIElementTypeButton' AND enabled == true")
        self.assertEqual(predicate({"label_contains": "a\\b "}), "label CONTAINS 'a\\\\b '")

    def test_literal_escaping(self):
        self.assertEqual(predicate_literal("plain"), "'plain'")
        self.assertEqual(predicate_literal(""), "''")
        self.assertEqual(predicate_literal("\\"), "'\\\\'")
        self.assertEqual(predicate_literal("'"), "'\\''")
        self.assertEqual(predicate_literal("a\tb"), "'a\\u0009b'")
        self.assertEqual(predicate_literal("\r\n"), "'\\u000d\\u000a'")
        self.assertEqual(predicate_literal("\x7f"), "'\\u007f'")
        self.assertEqual(predicate_literal("\x1b"), "'\\u001b'")
        self.assertEqual(predicate_literal("  "), "'\\u2028\\u2029'")
        self.assertEqual(predicate_literal("\\n"), "'\\\\n'")  # a literal backslash-n stays two characters
        self.assertEqual(predicate_literal('say "hi"'), "'say \"hi\"'")

    def test_unicode_and_format_specifiers_stay_literal(self):
        text = "你好 \U0001F44D\U0001F3FD %@ %K $var é"
        self.assertEqual(predicate_literal(text), "'" + text + "'")
        self.assertEqual(predicate({"label": text}), "label == '" + text + "'")

    def test_quote_injection_is_neutralised(self):
        self.assertEqual(
            predicate({"label": "a' OR TRUEPREDICATE OR label == 'b"}),
            "label == 'a\\' OR TRUEPREDICATE OR label == \\'b'")

    def test_every_field_and_selector_key_order(self):
        self.assertEqual(predicate({"name": "email"}), "name == 'email'")
        self.assertEqual(predicate({"value": "1"}), "value == '1'")
        self.assertEqual(predicate({"type": "XCUIElementTypeCell"}), "type == 'XCUIElementTypeCell'")
        self.assertEqual(predicate({"type": "Cell", "label": "Wi-Fi", "index": 2}),
                         "type == 'XCUIElementTypeCell' AND label == 'Wi-Fi'")
        self.assertEqual(predicate({"label": "Wi-Fi", "type": "Cell"}),
                         "label == 'Wi-Fi' AND type == 'XCUIElementTypeCell'")
        self.assertEqual(predicate({"label_contains": "Fi", "enabled": "false"}),
                         "label CONTAINS 'Fi' AND enabled == false")

    def test_enabled_accepts_booleans_and_exact_tree_strings(self):
        for value, expected in ((True, "enabled == true"), ("true", "enabled == true"),
                                (False, "enabled == false"), ("false", "enabled == false")):
            self.assertEqual(predicate({"enabled": value}), expected)

    def test_enabled_rejects_guesses(self):
        for value in ("TRUE", "True", "yes", "1", "", 1, 0, None, [], 1.0):
            with self.subTest(value=value):
                self.assert_invalid_selector({"enabled": value})

    def test_rule1_shape_and_keys(self):
        for selector in (None, [], "label", 5, {}, {"text": "x"}, {"label": "x", "id": "y"}, {"Label": "x"}):
            with self.subTest(selector=selector):
                self.assert_invalid_selector(selector, RULE1)

    def test_rule2_index_bounds_and_type(self):
        for index in (-1, 200, True, False, "1", 1.0, None):
            with self.subTest(index=index):
                self.assert_invalid_selector({"label": "x", "index": index})
        self.assertEqual(predicate({"label": "x", "index": 0}), "label == 'x'")
        self.assertEqual(predicate({"label": "x", "index": 199}), "label == 'x'")

    def test_rule3_index_alone(self):
        self.assert_invalid_selector({"index": 0}, RULE3)

    def test_rule4_predicate_alone_and_unchanged(self):
        raw = "label BEGINSWITH 'Wi' AND type == \"XCUIElementTypeCell\" OR name == 'x\\'y'"
        self.assertEqual(predicate({"predicate": raw}), raw)
        self.assertEqual(predicate({"predicate": raw, "index": 3}), raw)
        self.assert_invalid_selector({"predicate": raw, "label": "x"}, RULE4)
        self.assert_invalid_selector({"label": "x", "predicate": raw}, RULE4)
        self.assertEqual(predicate({"predicate": "x" * 2000}), "x" * 2000)
        for bad in ("", "x" * 2001, "label == 'a\x00'", 5, None, ["label == 'a'"]):
            with self.subTest(bad=bad):
                self.assert_invalid_selector({"predicate": bad})

    def test_rule5_text_fields(self):
        for key in ("label", "label_contains", "name", "value", "type"):
            with self.subTest(key=key):
                self.assertTrue(predicate({key: "a" * 1000}).endswith("a" * 1000 + "'"))
                for bad in ("", "a" * 1001, 5, None, True, ["a"], b"a"):
                    self.assert_invalid_selector({key: bad})

    def test_rule5_nul_is_rejected(self):
        for key in ("label", "label_contains", "name", "value", "type"):
            with self.subTest(key=key):
                error = self.assert_invalid_selector({key: "a\x00b"})
                self.assertIn("NUL", error.message)

    def test_selector_index(self):
        self.assertEqual(selector_index({"label": "x", "index": 3}), 3)
        self.assertIsNone(selector_index({"label": "x"}))
        self.assertIsNone(selector_index(None))


class ParseSourceTests(ErrorAssertions):
    def test_settings_screen(self):
        tree = parse_source(SETTINGS_XML)
        self.assertEqual(tree.bundle_id, "com.apple.Preferences")
        self.assertEqual((tree.width, tree.height), (390.0, 844.0))
        self.assertEqual(len(tree.elements), 16)
        self.assertEqual(tree.elements[0]["type"], "XCUIElementTypeApplication")
        self.assertEqual([e["type"] for e in tree.elements[:4]],
                         ["XCUIElementTypeApplication", "XCUIElementTypeWindow", "XCUIElementTypeOther",
                          "XCUIElementTypeNavigationBar"])

    def test_element_dicts(self):
        elements = parse_source(SETTINGS_XML).elements
        search = elements[5]
        self.assertEqual(search, {"type": "XCUIElementTypeSearchField", "name": "Search", "label": "Search",
                                  "value": "Search", "enabled": "true", "visible": "true", "placeholder": "Search",
                                  "rect": {"x": 16.0, "y": 143.0, "width": 358.0, "height": 36.0}})
        window = elements[1]
        self.assertEqual(window, {"type": "XCUIElementTypeWindow", "enabled": "true", "visible": "true",
                                  "rect": {"x": 0.0, "y": 0.0, "width": 390.0, "height": 844.0}})
        text_field = elements[14]
        self.assertEqual(text_field["label"], "")
        self.assertEqual(text_field["placeholder"], "Email")
        privacy = elements[12]
        self.assertEqual(privacy["label"], "Privacy & Security\nLocation, Camera")
        self.assertEqual(privacy["enabled"], "false")

    def test_application_root_variants(self):
        def source(**attributes):
            text = " ".join('%s="%s"' % item for item in attributes.items())
            return '<?xml version="1.0" encoding="UTF-8"?>\n<XCUIElementTypeApplication %s/>' % text

        app = "XCUIElementTypeApplication"
        tree = parse_source(source(type=app, bundleId="local.pid.4242", width="390", height="844"))
        self.assertIsNone(tree.bundle_id)
        self.assertEqual(tree.width, 390.0)
        self.assertIsNone(parse_source(source(type=app, bundleId="", width="1", height="2")).bundle_id)
        tree = parse_source(source(type=app, bundleId="com.x", width="390"))
        self.assertEqual((tree.bundle_id, tree.width, tree.height), ("com.x", None, None))
        tree = parse_source(source(type=app, bundleId="com.x", width="abc", height="844"))
        self.assertEqual((tree.width, tree.height), (None, None))
        tree = parse_source(source(type=app, bundleId="com.x", width="inf", height="844"))
        self.assertEqual((tree.width, tree.height), (None, None))
        tree = parse_source(source(bundleId="com.tag.only", width="375.5", height="667"))
        self.assertEqual((tree.bundle_id, tree.width, tree.height), ("com.tag.only", 375.5, 667.0))
        self.assertEqual(tree.elements[0]["type"], app)

    def test_wrapper_root_gives_no_root_information(self):
        inner = SETTINGS_XML.split("\n", 1)[1]
        tree = parse_source("<AppiumAUT>" + inner + "</AppiumAUT>")
        self.assertEqual((tree.bundle_id, tree.width, tree.height), (None, None, None))
        self.assertEqual(len(tree.elements), 17)
        self.assertEqual(tree.elements[0]["type"], "AppiumAUT")
        self.assertEqual(tree.elements[1]["type"], "XCUIElementTypeApplication")

    def test_empty_application_root(self):
        tree = parse_source('<XCUIElementTypeApplication type="XCUIElementTypeApplication" bundleId="com.apple.'
                            'springboard" x="0" y="0" width="390" height="844"/>')
        self.assertEqual(tree.bundle_id, "com.apple.springboard")
        self.assertEqual(filter_nodes(tree.elements, VIEWPORT), [])

    def test_rect_parsing(self):
        tree = parse_source('<root><a type="XCUIElementTypeButton" label="x" x="abc" y="1" width="2" height="3"/>'
                            '<b type="XCUIElementTypeButton" label="y" x="nan" y="1" width="2" height="3"/>'
                            '<c type="XCUIElementTypeButton" label="z"/>'
                            '<d type="XCUIElementTypeButton" label="w" x="-1" y="2.5" width="1e2" height="3"/></root>')
        rects = [e["rect"] for e in tree.elements[1:]]
        self.assertEqual(rects[0], None)
        self.assertEqual(rects[1], None)
        self.assertEqual(rects[2], {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
        self.assertEqual(rects[3], {"x": -1.0, "y": 2.5, "width": 100.0, "height": 3.0})

    def test_invalid_input(self):
        self.assert_tool_error("invalid_response", parse_source, "<unclosed",
                               message="The iPhone screen description could not be parsed.")
        self.assert_tool_error("invalid_response", parse_source, "",
                               message="The iPhone screen description could not be parsed.")
        for value in (None, b"<a/>", 5, {"value": "<a/>"}):
            with self.subTest(value=value):
                self.assert_tool_error("invalid_response", parse_source, value,
                                       message="The iPhone screen description is not XML text.")


class FilterNodesTests(unittest.TestCase):
    def settings(self, include_invisible=False):
        return filter_nodes(parse_source(SETTINGS_XML).elements, VIEWPORT, include_invisible)

    def test_settings_screen_default(self):
        nodes = self.settings()
        self.assertEqual([(short_type(n["type"]), n.get("label") or n.get("name")) for n in nodes], [
            ("NavigationBar", "Settings"), ("StaticText", "Settings"), ("SearchField", "Search"),
            ("Cell", "Sign in to your iPhone, Set up iCloud, the App Store, and more."),
            ("Image", "Airplane Mode"), ("Switch", "Airplane Mode"), ("Cell", "Wi-Fi"),
            ("Cell", "Privacy & Security\nLocation, Camera"), ("TextField", None), ("Button", "Done")])
        self.assertTrue(all(n["in_viewport"] for n in nodes))
        self.assertEqual(nodes[-2], {"type": "XCUIElementTypeTextField", "label": "", "value": "Email",
                                     "enabled": "true", "visible": "true",
                                     "rect": {"x": 16.0, "y": 760.0, "width": 358.0, "height": 34.0},
                                     "in_viewport": True})

    def test_include_invisible_keeps_offscreen_and_hidden(self):
        nodes = self.settings(include_invisible=True)
        self.assertEqual(len(nodes), 11)
        general = [n for n in nodes if n.get("label") == "General"][0]
        self.assertFalse(general["in_viewport"])
        self.assertEqual(general["visible"], "false")
        self.assertFalse(any(n["type"] in (wda_tree.APPLICATION, wda_tree.WINDOW) for n in nodes))

    def test_text_or_modal_rule(self):
        elements = [element("Other"), element("Other", label=""), element("Alert"), element("Sheet"),
                    element("Button", name="n"), element("Button", value="v"), element("Button", label="l")]
        kinds = [short_type(n["type"]) for n in filter_nodes(elements, VIEWPORT)]
        self.assertEqual(kinds, ["Alert", "Sheet", "Button", "Button", "Button"])

    def test_unparseable_rect_is_skipped_even_when_invisible_allowed(self):
        bad = {"type": "XCUIElementTypeButton", "label": "x", "rect": None}
        self.assertEqual(filter_nodes([bad], VIEWPORT, include_invisible=True), [])

    def test_offscreen_cases(self):
        cases = {
            "right of screen": dict(x=390, y=10),
            "below screen": dict(x=10, y=844),
            "left of screen": dict(x=-20, y=10, width=20),
            "above screen": dict(x=10, y=-10, height=10),
            "zero width": dict(x=10, y=10, width=0),
            "zero height": dict(x=10, y=10, height=0),
        }
        for name, geometry in cases.items():
            with self.subTest(name=name):
                item = element("Button", label="x", **geometry)
                self.assertEqual(filter_nodes([item], VIEWPORT), [])
                kept = filter_nodes([item], VIEWPORT, include_invisible=True)
                self.assertEqual(len(kept), 1)
                self.assertFalse(kept[0]["in_viewport"])
        partly = element("Button", label="x", x=-5, y=-5, width=10, height=10)
        self.assertTrue(filter_nodes([partly], VIEWPORT)[0]["in_viewport"])

    def test_visible_false_is_skipped_unless_invisible_allowed(self):
        hidden = element("Button", label="x", visible="false")
        self.assertEqual(filter_nodes([hidden], VIEWPORT), [])
        self.assertEqual(filter_nodes([hidden], VIEWPORT, include_invisible=True)[0]["visible"], "false")
        shown = element("Button", label="x", visible="true")
        self.assertEqual(filter_nodes([shown], VIEWPORT)[0]["visible"], "true")

    def test_application_and_window_are_never_nodes(self):
        elements = [element("Application", label="App", width=390, height=844),
                    element("Window", label="Win", width=390, height=844)]
        self.assertEqual(filter_nodes(elements, VIEWPORT, include_invisible=True), [])

    def test_node_keys_and_copies(self):
        source = element("Button", label="x", placeholder="p", enabled="true")
        result = filter_nodes([source], {"width": 100, "height": 100})[0]
        self.assertEqual(set(result), {"type", "label", "enabled", "rect", "in_viewport"})
        result["rect"]["x"] = 99
        self.assertEqual(source["rect"]["x"], 0.0)


class CompactNodeTests(unittest.TestCase):
    def test_exact_dicts(self):
        back = "返回"
        balance = "余额 1,234.56"
        self.assertEqual(compact_node(node(back, kind="Button", enabled="true")),
                         {"type": "Button", "label": back, "rect": [60, 200, 250, 44]})
        self.assertEqual(compact_node(node(balance, y=300, kind="StaticText", value=balance)),
                         {"type": "StaticText", "label": balance, "rect": [60, 300, 250, 44]})
        general = node("通用", y=400, name="General", value="1", enabled="false", x=16.4, width=250.6)
        self.assertEqual(compact_node(general), {"type": "Cell", "label": "通用", "name": "General",
                                                 "value": "1", "enabled": False, "rect": [16, 400, 251, 44]})

    def test_key_order(self):
        full = node("L", name="N", value="V", enabled=False, visible="false", in_viewport=False)
        self.assertEqual(list(compact_node(full)),
                         ["type", "label", "name", "value", "enabled", "visible", "in_viewport", "rect"])

    def test_bankers_rounding(self):
        rounded = compact_node(node(x=2.5, y=3.5, width=0.5, height=1.5))["rect"]
        self.assertEqual(rounded, [2, 4, 0, 2])

    def test_name_and_value_duplicates_are_omitted(self):
        self.assertEqual(compact_node({"type": "XCUIElementTypeCell", "name": "n", "value": "n"}),
                         {"type": "Cell", "name": "n"})
        self.assertEqual(compact_node({"type": "XCUIElementTypeCell", "name": "n", "value": "v"}),
                         {"type": "Cell", "name": "n", "value": "v"})
        self.assertEqual(compact_node({"type": "XCUIElementTypeCell", "label": "l", "name": "n", "value": "n"}),
                         {"type": "Cell", "label": "l", "name": "n", "value": "n"})
        self.assertEqual(compact_node({"type": "XCUIElementTypeCell", "label": "", "name": "", "value": ""}),
                         {"type": "Cell"})

    def test_departures_from_defaults(self):
        self.assertEqual(compact_node({"enabled": False, "visible": False, "in_viewport": False}),
                         {"enabled": False, "visible": False, "in_viewport": False})
        self.assertEqual(compact_node({"enabled": "true", "visible": "true", "in_viewport": True}), {})
        self.assertEqual(compact_node({"enabled": None, "visible": "FALSE", "in_viewport": 0}), {})

    def test_never_exposes_element_ids(self):
        item = node("x", element_id="13000000-0000-0000-9C01-000000000000", index=0)
        item[wda_tree.ELEMENT_KEY] = "13000000-0000-0000-9C01-000000000000"
        result = compact_node(item)
        self.assertNotIn("13000000", json.dumps(result))
        self.assertLessEqual(set(result), {"type", "label", "name", "value", "enabled", "visible",
                                           "in_viewport", "rect"})

    def test_missing_or_malformed_rect_is_omitted(self):
        self.assertNotIn("rect", compact_node({"type": "XCUIElementTypeButton", "label": "x"}))
        self.assertNotIn("rect", compact_node({"label": "x", "rect": {"x": 1, "y": 2, "width": "3", "height": 4}}))
        self.assertNotIn("rect", compact_node({"label": "x", "rect": None}))
        self.assertEqual(compact_node({"label": "x", "rect": {"x": 1, "y": 2, "width": 3, "height": 4}})["rect"],
                         [1, 2, 3, 4])

    def test_typical_node_is_several_times_smaller_than_the_wda_attributes(self):
        native = {"type": "XCUIElementTypeButton", "name": "返回", "label": "返回",
                  "enabled": "true", "rect": {"x": 16.0, "y": 62.0, "width": 44.0, "height": 44.0},
                  "in_viewport": True}
        before = len(json.dumps(native, ensure_ascii=False))
        after = len(json.dumps(compact_node(native), ensure_ascii=False, separators=(",", ":")))
        self.assertLess(after * 2.5, before)

    def test_whole_settings_page_shrinks(self):
        nodes = filter_nodes(parse_source(SETTINGS_XML).elements, VIEWPORT)
        before = len(json.dumps(nodes, ensure_ascii=False))
        after = len(json.dumps([compact_node(n) for n in nodes], ensure_ascii=False, separators=(",", ":")))
        self.assertLess(after * 2, before)


class GeometryTests(ErrorAssertions):
    def test_center_on_screen_and_contains(self):
        rect = {"x": 10, "y": 20, "width": 30, "height": 40}
        self.assertEqual(center(rect), (25.0, 40.0))
        self.assertTrue(on_screen(rect, VIEWPORT))
        self.assertFalse(on_screen({"x": 380, "y": 0, "width": 20, "height": 10}, VIEWPORT))  # centre x == 390
        self.assertTrue(on_screen({"x": 379, "y": 0, "width": 20, "height": 10}, VIEWPORT))
        self.assertFalse(on_screen({"x": 10, "y": 1200, "width": 10, "height": 10}, VIEWPORT))
        self.assertFalse(on_screen({"x": 10, "y": 10, "width": 0, "height": 10}, VIEWPORT))
        self.assertFalse(on_screen({"x": -30, "y": 10, "width": 40, "height": 10}, VIEWPORT))
        outer = {"x": 0, "y": 0, "width": 100, "height": 100}
        self.assertTrue(contains(outer, outer))
        self.assertTrue(contains(outer, {"x": -1, "y": -1, "width": 102, "height": 102}))
        self.assertFalse(contains(outer, {"x": -1.5, "y": 0, "width": 10, "height": 10}))
        self.assertTrue(contains(outer, {"x": -1.5, "y": 0, "width": 10, "height": 10}, slack=2))
        self.assertFalse(contains({"x": 0, "y": 0, "width": 10, "height": 10}, outer))

    def test_native_modals(self):
        nodes = [node("OK", kind="Alert"), node("Share", kind="Sheet", value="x"),
                 node("Other overlay", kind="Other"), {"type": "XCUIElementTypeAlert", "rect": {"x": 0}}]
        modals = native_modals(nodes)
        self.assertEqual([m["type"] for m in modals],
                         ["XCUIElementTypeAlert", "XCUIElementTypeSheet", "XCUIElementTypeAlert"])
        self.assertEqual(set(modals[1]), {"type", "name", "label", "rect"})
        self.assertEqual(modals[2], {"type": "XCUIElementTypeAlert", "rect": {"x": 0}})

    def test_default_region_gives_the_557_to_287_drag(self):
        region = default_region(VIEWPORT)
        self.assertEqual(region, {"x": 58.5, "y": 211.0, "width": 273.0, "height": 422.0})
        (fx, fy), (tx, ty) = gesture_points(region, "up")
        self.assertEqual((round(fx), round(fy), round(tx), round(ty)), (195, 557, 195, 287))

    def test_gesture_directions(self):
        region = {"x": 0, "y": 0, "width": 100, "height": 200}
        self.assertEqual(gesture_points(region, "up"), ((50.0, 164.0), (50.0, 36.0)))
        self.assertEqual(gesture_points(region, "down"), ((50.0, 36.0), (50.0, 164.0)))
        self.assertEqual(gesture_points(region, "left"), ((82.0, 100.0), (18.0, 100.0)))
        self.assertEqual(gesture_points(region, "right"), ((18.0, 100.0), (82.0, 100.0)))
        error = self.assert_tool_error("invalid_argument", gesture_points, region, "sideways")
        self.assertEqual(error.details, {"action_executed": False})

    def test_validate_region_accepts_and_copies(self):
        region = {"x": 30, "y": 300, "width": 300, "height": 400}
        result = validate_region(region, VIEWPORT)
        self.assertEqual(result, region)
        self.assertIsNot(result, region)
        self.assertEqual(validate_region({"x": 0, "y": 0, "width": 390, "height": 844}, VIEWPORT)["width"], 390)
        self.assertEqual(validate_region({"x": 0.5, "y": 1.5, "width": 1, "height": 1.0}, VIEWPORT)["x"], 0.5)

    def test_validate_region_errors(self):
        base = {"x": 30, "y": 300, "width": 300, "height": 400}
        bad = [None, [], {"x": 1, "y": 1, "width": 1}, dict(base, extra=1), dict(base, x=True),
               dict(base, y="1"), dict(base, x=float("nan")), dict(base, width=float("inf")), dict(base, x=-1),
               dict(base, width=0), dict(base, height=0.5), dict(base, width=10001), dict(base, x=10001),
               dict(base, x=91), dict(base, y=445), dict(base, height=None)]
        for region in bad:
            with self.subTest(region=region):
                error = self.assert_tool_error("invalid_argument", validate_region, region, VIEWPORT,
                                               message=REGION_MESSAGE)
                self.assertEqual(error.details, {"action_executed": False})

    def test_region_nodes_excludes_status_bar_content(self):
        area = {"x": 0, "y": 0, "width": 390, "height": 844}
        nodes = [node("Clock", y=10, kind="StaticText"), node("Battery", y=44.9, height=2, kind="Other"),
                 node("Bar", y=50, kind="StatusBar"), node("Row", y=45)]
        self.assertEqual([n["label"] for n in region_nodes(nodes, area)], ["Row"])
        self.assertEqual([n["label"] for n in region_nodes(nodes, None)], ["Row"])

    def test_region_nodes_uses_the_inclusive_centre(self):
        area = {"x": 100, "y": 100, "width": 100, "height": 100}
        nodes = [node("left edge", x=90, y=100, width=20, height=20),     # centre (100, 110): inside
                 node("right edge", x=190, y=100, width=20, height=20),   # centre (200, 110): inside
                 node("just outside", x=191, y=100, width=20, height=20),  # centre (201, 110)
                 node("below", x=150, y=200, width=10, height=20),         # centre y 210
                 {"type": "XCUIElementTypeCell", "label": "no rect"}]
        self.assertEqual([n["label"] for n in region_nodes(nodes, area)], ["left edge", "right edge"])


class ScrollProgressTests(unittest.TestCase):
    AREA = {"x": 30, "y": 300, "width": 300, "height": 400}

    def progress(self, before, after, direction="up", area=None):
        return scroll_progress(before, after, area or self.AREA, direction)

    def test_true_movement_in_each_direction(self):
        self.assertTrue(self.progress([node(y=400)], [node(y=350)], "up"))
        self.assertTrue(self.progress([node(y=400)], [node(y=450)], "down"))
        self.assertTrue(self.progress([node(x=60, y=400)], [node(x=20, y=400)], "left"))
        self.assertTrue(self.progress([node(x=60, y=400)], [node(x=100, y=400)], "right"))

    def test_opposite_direction_is_not_progress(self):
        self.assertFalse(self.progress([node(y=400)], [node(y=450)], "up"))
        self.assertFalse(self.progress([node(y=400)], [node(y=350)], "down"))
        self.assertFalse(self.progress([node(x=60, y=400)], [node(x=100, y=400)], "left"))

    def test_threshold_along_and_across_the_axis(self):
        self.assertFalse(self.progress([node(y=400)], [node(y=398)]))
        self.assertTrue(self.progress([node(y=400)], [node(y=397.5)]))
        self.assertTrue(self.progress([node(x=60, y=400)], [node(x=63, y=350)]))
        self.assertFalse(self.progress([node(x=60, y=400)], [node(x=63.5, y=350)]))

    def test_size_must_stay_within_two_points(self):
        self.assertTrue(self.progress([node(y=400)], [node(y=350, width=252, height=46)]))
        self.assertFalse(self.progress([node(y=400)], [node(y=350, width=300)]))
        self.assertFalse(self.progress([node(y=400)], [node(y=350, height=47)]))

    def test_value_refresh_and_label_change_in_place(self):
        before = node("Counter 100", y=350, name="Stable row", value="100.00")
        refreshed = copy.deepcopy(before)
        refreshed["value"] = "100.25"
        self.assertFalse(self.progress([before], [refreshed]))
        relabelled = copy.deepcopy(before)
        relabelled["label"] = "Counter 200"
        self.assertFalse(self.progress([before], [relabelled]))

    def test_stable_name_proves_movement_while_label_and_value_refresh(self):
        before = [node("Balance 100", y=350, name="Stable row", value="100.00")]
        after = [node("Balance 200", y=300, name="Stable row", value="200.00")]
        self.assertTrue(self.progress(before, after))

    def test_duplicate_labels_are_not_anchors(self):
        before = [node("Repeated row", y=350), node("Repeated row", y=450)]
        after = [node("Repeated row", y=300), node("Repeated row", y=400)]
        self.assertFalse(self.progress(before, after))

    def test_a_label_duplicated_only_on_one_page_is_not_an_anchor(self):
        before = [node("Row", y=450)]
        after = [node("Row", y=400), node("Row", y=600)]
        self.assertFalse(self.progress(before, after))

    def test_changes_outside_the_region_are_ignored(self):
        before = [node("Banner A", y=100), node("Row 1", y=400)]
        after = [node("Banner A", y=50), node("Row 1", y=400)]
        self.assertFalse(self.progress(before, after))
        after = [node("Banner C", y=100), node("Row 1", y=350), node("Row 2", y=400)]
        self.assertTrue(self.progress(before, after))

    def test_only_anchor_types_count(self):
        for kind, expected in (("Cell", True), ("StaticText", True), ("Other", True), ("Image", True),
                               ("Button", False), ("Switch", False), ("TextField", False)):
            with self.subTest(kind=kind):
                self.assertEqual(self.progress([node(y=400, kind=kind)], [node(y=350, kind=kind)]), expected)

    def test_anchor_identity_includes_the_type(self):
        self.assertFalse(self.progress([node("X", y=400, kind="Cell")], [node("X", y=350, kind="StaticText")]))

    def test_status_bar_and_missing_pages(self):
        self.assertFalse(self.progress([node("Clock", y=30, kind="StaticText")],
                                       [node("Clock", y=10, kind="StaticText")], area=VIEWPORT_AREA))
        self.assertFalse(self.progress([], [node(y=350)]))
        self.assertFalse(self.progress([node(y=400)], []))

    def test_invalid_direction(self):
        with self.assertRaises(ToolError):
            self.progress([node(y=400)], [node(y=350)], "diagonal")


VIEWPORT_AREA = {"x": 0, "y": 0, "width": 390, "height": 844}


class RowKeyTests(unittest.TestCase):
    def test_row_identity(self):
        a = node("Row 1", y=100, value="v", enabled="true")
        b = node("Row 1", y=900, value="v", enabled="false")
        self.assertEqual(row_identity(a), row_identity(b))
        self.assertNotEqual(row_identity(a), row_identity(node("Row 1", y=100, value="w")))
        self.assertEqual(json.loads(row_identity({"type": "XCUIElementTypeCell", "label": "x"})),
                         {"type": "XCUIElementTypeCell", "name": None, "label": "x", "value": None})
        self.assertEqual(row_identity({"label": "x", "type": "t"}), row_identity({"type": "t", "label": "x"}))

    def test_page_key(self):
        rows = [node("Row 1", y=100, value="1"), node("Row 2", y=160, value="2")]
        refreshed = [node("Row 1", y=100, value="9"), node("Row 2", y=160, value="8")]
        moved = [node("Row 1", y=90, value="1"), node("Row 2", y=160, value="2")]
        self.assertEqual(page_key(rows), page_key(refreshed))
        self.assertNotEqual(page_key(rows), page_key(moved))
        self.assertNotEqual(page_key(rows), page_key(list(reversed(rows))))
        self.assertEqual(json.loads(page_key([])), [])
        decoded = json.loads(page_key(rows[:1]))
        self.assertEqual(decoded, [{"type": "XCUIElementTypeCell", "name": "Row 1", "label": "Row 1",
                                    "rect": {"x": 60.0, "y": 100.0, "width": 250.0, "height": 44.0}}])


if __name__ == "__main__":
    unittest.main()
