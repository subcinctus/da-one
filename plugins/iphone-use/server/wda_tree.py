"""The screen model: WDA XML source to nodes, selectors to NSPredicates, and geometry.

Everything here is pure (no I/O). The controller reads `/source` and `/elements` through
the WDA client and uses these helpers to decide what Claude sees and where to touch.

Geometry arguments: a `viewport` is always a mapping with numeric `width` and `height`
(extra keys such as `units` are ignored; it is never unpacked positionally). `rect`,
`region` and `area` are mappings with numeric x, y, width and height. Node lists are
the dicts produced by `filter_nodes`.
"""

from __future__ import annotations

import collections
import json
import math
import xml.etree.ElementTree as ET

from errors import ToolError

TYPE_PREFIX = "XCUIElementType"
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
APPLICATION = "XCUIElementTypeApplication"
WINDOW = "XCUIElementTypeWindow"
EDITABLE_TYPES = ("XCUIElementTypeTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView")
TEXT_VIEW = "XCUIElementTypeTextView"
SECURE_TYPE = "XCUIElementTypeSecureTextField"
MODAL_TYPES = ("XCUIElementTypeAlert", "XCUIElementTypeSheet")
ANCHOR_TYPES = ("XCUIElementTypeCell", "XCUIElementTypeStaticText", "XCUIElementTypeOther", "XCUIElementTypeImage")
SELECTOR_FIELDS = ("label", "label_contains", "name", "value", "type", "enabled", "predicate", "index")
STATUS_BAR_Y = 45.0

STATUS_BAR_TYPE = "XCUIElementTypeStatusBar"
TEXT_FIELDS = ("label", "label_contains", "name", "value", "type")
RECT_KEYS = ("x", "y", "width", "height")
NODE_KEYS = ("type", "name", "label", "value", "enabled", "visible")
MAX_INDEX = 199
MAX_FIELD_LENGTH = 1000
MAX_PREDICATE_LENGTH = 2000
DIRECTIONS = ("up", "down", "left", "right")

SourceTree = collections.namedtuple("SourceTree", "bundle_id width height elements")


# ---------------------------------------------------------------------------
# Types and names
# ---------------------------------------------------------------------------

def short_type(t):
    """'XCUIElementTypeButton' -> 'Button'; None or '' -> ''."""
    if not isinstance(t, str) or not t:
        return ""
    return t[len(TYPE_PREFIX):] if t.startswith(TYPE_PREFIX) else t


def full_type(t):
    """'Button' -> 'XCUIElementTypeButton'; full names are returned unchanged."""
    t = "" if t is None else str(t)
    return t if t.startswith(TYPE_PREFIX) else TYPE_PREFIX + t


# ---------------------------------------------------------------------------
# Selectors -> NSPredicate
# ---------------------------------------------------------------------------

def _invalid_selector(message):
    return ToolError("invalid_selector", message, details={"action_executed": False})


def predicate_literal(value):
    """`value` as a single-quoted NSPredicate string literal.

    Backslash and single quote are escaped; control characters, DEL, U+2028 and U+2029
    become \\uXXXX (lower-case hex) because NSPredicate rejects raw line breaks inside
    quotes. Everything else (emoji, CJK, `%@`) stays literal: inside quotes it is text.
    """
    out = ["'"]
    for character in value:
        code = ord(character)
        if character == "\\":
            out.append("\\\\")
        elif character == "'":
            out.append("\\'")
        elif code < 32 or code == 127 or character in "  ":
            out.append("\\u%04x" % code)
        else:
            out.append(character)
    out.append("'")
    return "".join(out)


def _check_text_field(value):
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_FIELD_LENGTH:
        raise _invalid_selector("Selector text fields must be text of 1 to 1000 characters.")
    if "\x00" in value:
        raise _invalid_selector("Selector text cannot contain the NUL character; NSPredicate cannot match it.")


def predicate(selector):
    """Validate `selector` and return the NSPredicate string WDA should search with.

    Raises ToolError("invalid_selector") for anything malformed, before any phone I/O.
    """
    if not isinstance(selector, dict) or not selector or not set(selector) <= set(SELECTOR_FIELDS):
        raise _invalid_selector(
            "A selector uses only label, label_contains, name, value, type, enabled, predicate and index.")
    if "index" in selector:
        index = selector["index"]
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= MAX_INDEX:
            raise _invalid_selector("index must be a whole number from 0 to 199 that picks one match.")
    criteria = [(key, value) for key, value in selector.items() if key != "index"]
    if not criteria:
        raise _invalid_selector("index only chooses among matches; add label, name, value, type, enabled or predicate.")
    if "predicate" in selector:
        if len(criteria) != 1:
            raise _invalid_selector("predicate must be used alone (index may accompany it).")
        raw = selector["predicate"]
        if not isinstance(raw, str) or not 1 <= len(raw) <= MAX_PREDICATE_LENGTH or "\x00" in raw:
            raise _invalid_selector("predicate must be text of 1 to 2000 characters without NUL.")
        return raw
    clauses = []
    for key, value in criteria:
        if key == "enabled":
            if value is True or value == "true":
                clauses.append("enabled == true")
            elif value is False or value == "false":
                clauses.append("enabled == false")
            else:
                raise _invalid_selector('enabled must be true or false (a boolean or exactly "true"/"false").')
            continue
        _check_text_field(value)
        if key == "type":
            value = full_type(value)
        if key == "label_contains":
            clauses.append("label CONTAINS " + predicate_literal(value))
        else:
            clauses.append(key + " == " + predicate_literal(value))
    return " AND ".join(clauses)


def selector_index(selector):
    """The selector's `index` (which match to use), or None."""
    if not isinstance(selector, dict):
        return None
    return selector.get("index")


# ---------------------------------------------------------------------------
# XML source -> elements -> nodes
# ---------------------------------------------------------------------------

def _finite_float(text):
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _element_rect(attributes):
    rect = {}
    for key in RECT_KEYS:
        number = _finite_float(attributes.get(key, 0))
        if number is None:
            return None
        rect[key] = number
    return rect


def parse_source(xml_text):
    """Parse WDA's `/source?format=xml` text into a SourceTree.

    bundle_id/width/height come from an XCUIElementTypeApplication root (None for any
    other root, e.g. an <AppiumAUT> wrapper, so callers fall back to dedicated reads).
    `elements` lists every element in document order, root included.
    """
    if not isinstance(xml_text, str):
        raise ToolError("invalid_response", "The iPhone screen description is not XML text.")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        raise ToolError("invalid_response", "The iPhone screen description could not be parsed.") from None
    bundle_id = width = height = None
    if (root.get("type") or root.tag) == APPLICATION:
        bundle = root.get("bundleId")
        if bundle and not bundle.startswith("local.pid."):
            bundle_id = bundle
        root_width = _finite_float(root.get("width"))
        root_height = _finite_float(root.get("height"))
        if root_width is not None and root_height is not None:
            width, height = root_width, root_height
    elements = []
    for element in root.iter():
        attributes = element.attrib
        item = {"type": attributes.get("type") or element.tag}
        for key in ("name", "label", "value", "enabled", "visible"):
            if key in attributes:
                item[key] = attributes[key]
        if "placeholderValue" in attributes:
            item["placeholder"] = attributes["placeholderValue"]
        item["rect"] = _element_rect(attributes)
        elements.append(item)
    return SourceTree(bundle_id, width, height, elements)


def _viewport_size(viewport):
    return float(viewport["width"]), float(viewport["height"])


def _has_text(element):
    return any(isinstance(element.get(key), str) and element.get(key) for key in ("label", "name", "value"))


def filter_nodes(elements, viewport, include_invisible=False):
    """The nodes worth showing Claude, in document order.

    Keeps elements that carry text (or are native alerts/sheets), have a parseable
    rect and (unless include_invisible) intersect the viewport and are not marked
    invisible. Application and Window elements are never nodes.
    """
    width, height = _viewport_size(viewport)
    nodes = []
    for element in elements:
        kind = element.get("type")
        if not _has_text(element) and kind not in MODAL_TYPES:
            continue
        rect = element.get("rect")
        if rect is None:
            continue
        x, y, w, h = (rect[key] for key in RECT_KEYS)
        intersects = w > 0 and h > 0 and x < width and y < height and x + w > 0 and y + h > 0
        if not include_invisible and (not intersects or element.get("visible") == "false"):
            continue
        if kind in (APPLICATION, WINDOW):
            continue
        node = {key: element[key] for key in NODE_KEYS if element.get(key) is not None}
        node["rect"] = dict(rect)
        node["in_viewport"] = intersects
        nodes.append(node)
    return nodes


def _rect_numbers(rect):
    if not isinstance(rect, dict):
        return None
    values = []
    for key in RECT_KEYS:
        value = rect.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        values.append(value)
    return values


def compact_node(node):
    """The one model-facing node format.

    Omitted keys mean their defaults: name equals label, value repeats the text,
    enabled/visible/in_viewport are true. Element ids are never included.
    """
    result = {}
    kind = short_type(node.get("type"))
    if kind:
        result["type"] = kind
    label = node.get("label")
    name = node.get("name")
    value = node.get("value")
    if label:
        result["label"] = label
    if name and name != label:
        result["name"] = name
    if value and value != (label or name):
        result["value"] = value
    if node.get("enabled") in ("false", False):
        result["enabled"] = False
    if node.get("visible") in ("false", False):
        result["visible"] = False
    if node.get("in_viewport") is False:
        result["in_viewport"] = False
    numbers = _rect_numbers(node.get("rect"))
    if numbers is not None:
        result["rect"] = [round(number) for number in numbers]
    return result


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def center(rect):
    """(x + width / 2, y + height / 2)."""
    return rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2


def on_screen(rect, viewport):
    """Whether the rect has a size and its centre lies inside the viewport."""
    if not (rect["width"] > 0 and rect["height"] > 0):
        return False
    width, height = _viewport_size(viewport)
    cx, cy = center(rect)
    return 0 <= cx < width and 0 <= cy < height


def contains(outer, inner, slack=1.0):
    """Whether `inner` lies within `outer`, allowing `slack` points on every side."""
    return (
        outer["x"] - slack <= inner["x"]
        and outer["y"] - slack <= inner["y"]
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + slack
        and inner["y"] + inner["height"] <= outer["y"] + outer["height"] + slack
    )


def native_modals(nodes):
    """Native alerts and sheets among `nodes`, as {type, name, label, rect} (present keys only)."""
    modals = []
    for node in nodes:
        if node.get("type") in MODAL_TYPES:
            modals.append({key: node[key] for key in ("type", "name", "label", "rect") if key in node})
    return modals


def default_region(viewport):
    """The central scroll region: 70% of the width and the middle half of the height."""
    width, height = _viewport_size(viewport)
    return {"x": width * 0.15, "y": height * 0.25, "width": width * 0.7, "height": height * 0.5}


def _region_error():
    return ToolError(
        "invalid_argument",
        "The scroll region must be inside the iPhone screen, in points.",
        details={"action_executed": False},
    )


def _finite_number(value, low, high):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and low <= value <= high
    )


def validate_region(region, viewport):
    """Check an explicit scroll region against the viewport and return a copy of it."""
    if not isinstance(region, dict) or set(region) != set(RECT_KEYS):
        raise _region_error()
    for key in ("x", "y"):
        if not _finite_number(region[key], 0, 10000):
            raise _region_error()
    for key in ("width", "height"):
        if not _finite_number(region[key], 1, 10000):
            raise _region_error()
    width, height = _viewport_size(viewport)
    if region["x"] + region["width"] > width or region["y"] + region["height"] > height:
        raise _region_error()
    return {key: region[key] for key in RECT_KEYS}


def _check_direction(direction):
    if direction not in DIRECTIONS:
        raise ToolError("invalid_argument", "direction must be up, down, left or right.",
                        details={"action_executed": False})


def gesture_points(region, direction):
    """((from_x, from_y), (to_x, to_y)) for a drag across 64% of the region.

    `direction` is where the finger moves: "up" drags from below the centre to above it.
    """
    _check_direction(direction)
    cx, cy = center(region)
    dx = 0.32 * region["width"]
    dy = 0.32 * region["height"]
    if direction == "up":
        return (cx, cy + dy), (cx, cy - dy)
    if direction == "down":
        return (cx, cy - dy), (cx, cy + dy)
    if direction == "left":
        return (cx + dx, cy), (cx - dx, cy)
    return (cx - dx, cy), (cx + dx, cy)


def region_nodes(nodes, area):
    """Nodes whose centre lies inside `area` (inclusive), minus status-bar content."""
    selected = []
    for node in nodes:
        rect = node.get("rect")
        if not isinstance(rect, dict):
            continue
        if node.get("type") == STATUS_BAR_TYPE or rect["y"] < STATUS_BAR_Y:
            continue
        if area is not None:
            cx, cy = center(rect)
            inside_x = area["x"] <= cx <= area["x"] + area["width"]
            inside_y = area["y"] <= cy <= area["y"] + area["height"]
            if not (inside_x and inside_y):
                continue
        selected.append(node)
    return selected


def _anchors(nodes, area):
    """Stable text anchors in the area: {(type, field, text): rect} for keys unique on the page."""
    found = collections.defaultdict(list)
    for node in region_nodes(nodes, area):
        kind = node.get("type")
        if kind not in ANCHOR_TYPES:
            continue
        for field in ("name", "label"):
            text = node.get(field)
            if isinstance(text, str) and text:
                found[(kind, field, text)].append(node["rect"])
    return {key: rects[0] for key, rects in found.items() if len(rects) == 1}


def scroll_progress(before, after, area, direction):
    """Whether content in `area` moved the way a `direction` drag should move it.

    True only if some anchor that is unique on both pages moved more than 2 points
    along the drag axis in the finger's direction, at most 3 points across it, and kept
    its width and height within 2 points. Value refreshes, labels changing in place,
    opposite movement and duplicate labels are never progress.
    """
    _check_direction(direction)
    old = _anchors(before, area)
    new = _anchors(after, area)
    if direction in ("up", "down"):
        axis, cross = "y", "x"
    else:
        axis, cross = "x", "y"
    sign = -1 if direction in ("up", "left") else 1
    for key in old.keys() & new.keys():
        a = old[key]
        b = new[key]
        moved_along = (b[axis] - a[axis]) * sign > 2
        steady_across = abs(b[cross] - a[cross]) <= 3
        same_size = abs(b["width"] - a["width"]) <= 2 and abs(b["height"] - a["height"]) <= 2
        if moved_along and steady_across and same_size:
            return True
    return False


def row_identity(node):
    """Dedupe key for list rows: type, name, label and value."""
    return json.dumps({key: node.get(key) for key in ("type", "name", "label", "value")}, sort_keys=True)


def page_key(rows):
    """Key for a page of rows (value excluded, so refreshing numbers are not new pages)."""
    return json.dumps([{key: row.get(key) for key in ("type", "name", "label", "rect")} for row in rows],
                      sort_keys=True)
