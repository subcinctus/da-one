"""PhoneController: every operation Claude can perform on the iPhone.

The controller sits on top of a WDAClient (unit A) and the pure screen-model helpers
(wda_tree, wda_text, wda_image). Its rules, in short:

* Execute once, optimistically. A mutation goes through `_post` exactly once and is
  never replayed; verification happens only when the caller asks (`verify`/`expect`).
* Report what really happened. `accepted_actions` counts mutations the phone accepted,
  so every failure can say whether something already changed (`action_executed`,
  `action_complete`, `verification_required`).
* Never guess a target. A selector must resolve to one on-screen, hittable element;
  ambiguity returns candidates with tap points instead of a guess.
* When a selector, scroll or check fails, attach one screenshot so the next call can
  act by coordinates - except for password fields, which are never captured.

All coordinates are iPhone points (WDA's /window/size space).
"""

from __future__ import annotations

import base64
import binascii
import collections
import datetime
import functools
import inspect
import math
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import wda_image
import wda_text
import wda_tree
from errors import ToolError
from wda_image import JPEG_QUALITY, SIPS_PATH
from wda_tree import compact_node

# --- constants (DESIGN.md section 7.1) ---------------------------------------------------------------

CALL_BUDGET = 60.0
INPUT_TTL = 600.0
VIEWPORT_TTL = 30.0
SNAPSHOT_LIMIT = 32
CANDIDATE_LIMIT = 8
TYPING_FREQUENCY = 30
TYPING_PIECE = 200
KEEP_ARTIFACTS = 40
LAUNCH_VERIFY_SECONDS = 5.0
HOME_VERIFY_SECONDS = 2.0
SPRINGBOARD = "com.apple.springboard"
DRAG_HOLD_SECONDS = 0.1
SELECTOR_FAILURES = ("no_such_element", "ambiguous_target", "occluded_target", "offscreen_target",
                     "not_editable", "no_focused_field", "search_exhausted")
VISUAL_FAILURES = SELECTOR_FAILURES + ("no_scroll_progress", "scroll_context_changed", "modal_requires_region",
                                       "blocked_scroll_region", "postcondition_failed", "input_mismatch",
                                       "element not interactable", "element click intercepted",
                                       "invalid element state", "no such element")
BATCH_OPS = ("tap", "swipe", "type_text", "launch_app", "press_button", "wait", "observe", "scroll_find")
BUNDLE_RE = re.compile(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+")

# --- internal limits and timings ----------------------------------------------------------------------

OBSERVE_MODES = ("none", "tree", "screenshot", "both")
OBSERVATION_MODES = ("tree", "screenshot", "both")
DIRECTIONS = ("up", "down", "left", "right")
BUTTONS = ("home", "volumeup", "volumedown")
ROW_TYPE_RE = re.compile(r"(?:XCUIElementType)?[A-Za-z]+")
MAX_NODES_LIMIT = 300
LIST_MAX_NODES = 300
ROW_LIMIT = 300
MAX_BATCH_STEPS = 20
MAX_TEXT_LENGTH = 10000
SCREEN_TARGET_LIMIT = 32
SCREENSHOT_TIMEOUT = 25.0
ACTIVATE_TIMEOUT = 45.0
WAIT_REQUEST_CAP = 2.0
WAIT_ZERO_PROBE = 0.5
WAIT_SLEEP = 0.25
POLL_SLEEP = 0.1
MIN_POLL_TIMEOUT = 0.05
SCREENSHOT_SETTLE_CAP = 0.5
TAP_TELEMETRY = "tap"
DRAG_TELEMETRY = "drag"

# --- model-facing texts --------------------------------------------------------------------------------

PARTIAL_VERIFICATION = ("At least one phone action was accepted before the error. Look at the current screen; "
                        "do not automatically repeat the operation.")
EMPTY_TREE_WARNING = ("The screen tree is empty: look at a screenshot for a lock screen, iPhone Mirroring, loading "
                      "or custom-drawn content before acting.")
STALE_NEXT_STEP = ("Look at the current screen before reusing coordinates. An observation_id is optional; changing "
                   "text, numbers or pixels do not invalidate it, only a different app or screen orientation does.")

NO_MATCH_MESSAGE = ("No element matches this selector. Find the target in the attached screenshot and tap it by "
                    "x/y instead of trying other selector spellings.")
INDEX_BEYOND_MESSAGE = "selector.index is beyond the current matches; nothing was tapped."
OFFSCREEN_MESSAGE = "The matching element is outside the visible screen; nothing was tapped."
ALL_OFFSCREEN_MESSAGE = "Several elements match, but none is inside the visible screen; nothing was tapped."
OCCLUDED_MESSAGE = "The element was found but something covers it, so nothing was tapped."
AMBIGUOUS_MESSAGE = ("Several separate elements match. Tap the intended candidate's tap point by x/y, or repeat "
                     "the selector with its index.")
AMBIGUOUS_NEXT_STEP = ("Tap the intended candidate's tap point by x/y, or repeat the call with selector.index. "
                       "Nothing was sent to the phone.")
NOT_EDITABLE_MESSAGE = "This element does not accept typed text."
SECURE_FIELD_MESSAGE = "This is a password field. Ask the user to type it themselves."
NO_FOCUS_MESSAGE = ("No text field has keyboard focus; nothing was typed. Look at the screenshot for a popup or the "
                    "wrong target, then tap the visible field by x/y.")

OFFSCREEN_STEP = ("Look at the attached screenshot first. The match is outside the visible area; check the list, "
                  "direction and any overlay before deciding to swipe.")
OCCLUDED_STEP = ("Look at the attached screenshot first. A popup may cover the target; dismiss its visible close "
                 "or cancel control first. tap_point is where the covered element is, not proof it can be tapped.")
SCROLL_STEP = ("Look at the attached screenshot first for the last row, an end marker, unchanged content, the "
               "wrong region, a fixed header or a popup. Decide whether another swipe is needed; do not "
               "automatically repeat scrolling. No progress does not prove the list is empty or complete.")
RESULT_STEP = ("Look at the attached screenshot first to see the actual page, field text or send result. Continue "
               "only the missing work; do not blindly repeat.")
TYPING_STEP = ("Look at the attached screenshot first. Tap the visible text field by x/y, then call "
               "iphone_type_text with the text and no selector. If an earlier tap did not focus it, pick a new "
               "point from this screenshot.")
TAP_STEP = ("Look at the attached screenshot first, then tap the visible target by x/y; tap points in this result "
            "are already in iPhone points.")
STEP_SUFFIX = (" Image pixels x image.pixel_to_point = iPhone points. The screenshot is attached to this result; "
               "if you cannot see it, open observation.image.path with the Read tool or call "
               "iphone_observe(mode=screenshot). Do not try other selector spellings or re-read the tree first.")
SCROLL_CODES = ("search_exhausted", "no_scroll_progress", "scroll_context_changed", "modal_requires_region",
                "blocked_scroll_region")
RESULT_CODES = ("postcondition_failed", "input_mismatch")

TYPE_PARTIAL_NEXT_STEP = ("Call iphone_type_text with only continue_token to type the rest. Do not resend the text "
                          "or touch the phone in between.")
SUBMIT_VERIFICATION = ("Check the result of sending before saying the task is done; do not send again "
                       "automatically.")
SUBMIT_SCOPE = "The expected element is present; check the final result before saying the task is done."
CONTINUATION_EXPIRED = ("This continuation already finished, expired, or another phone action ran since. Nothing "
                        "was typed now.")
CONTINUATION_NEXT_STEP = "Read the field's actual text, then type only the missing part with replace=false."

BATCH_NEXT_STEPS = {
    "time_budget": ("Send the steps from resume_at onward in a new call; completed steps already ran and must not "
                    "be repeated."),
    "input_continues": ("Finish the text with iphone_type_text(continue_token=...), then send the steps from "
                        "resume_at onward."),
    "submission_requires_verification": "Check the result of the send step (stopped_at) before continuing from "
                                        "resume_at.",
    "error": ("Look at the current screen (a screenshot is attached when available) and continue only the missing "
              "steps; do not repeat completed steps."),
}

LIST_LIMITATIONS = [
    "Rows that look identical (same type, name, label and value) are merged.",
    "Only text exposed to accessibility is collected; reconcile expected counts, dates and totals before claiming "
    "completeness.",
]


# --- small helpers ----------------------------------------------------------------------------------------


def _invalid(message, **details):
    """An invalid_argument error; nothing was sent to the phone."""
    details.setdefault("action_executed", False)
    return ToolError("invalid_argument", message, details=details)


def _finite(value, name, low=0, high=10000):
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
            or not low <= value <= high):
        raise _invalid("%s must be a finite number in [%s, %s]." % (name, low, high))
    return value


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise _invalid("%s must be a whole number in [%s, %s]." % (name, low, high))
    return value


def _boolean(value, name):
    if not isinstance(value, bool):
        raise _invalid("%s must be true or false." % name)
    return value


def _check_observe(observe):
    if observe not in OBSERVE_MODES:
        raise _invalid("observe must be none, tree, screenshot or both.")


def _check_direction(direction):
    if direction not in DIRECTIONS:
        raise _invalid("direction must be up, down, left or right.")


def _check_expect(expect):
    if expect is not None:
        wda_tree.predicate(expect)


def _stale(message, reason, scope="page"):
    return ToolError("stale_observation", message, details={
        "action_executed": False,
        "reason": reason,
        "freshness_scope": scope,
        "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                     "same_observation_retry": False, "replay_action": False, "next_step": STALE_NEXT_STEP},
    })


def _valid_rect(rect):
    if not isinstance(rect, dict):
        return False
    for key in ("x", "y", "width", "height"):
        value = rect.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return False
    return True


def _area(rect):
    return rect["width"] * rect["height"]


def _inside(area, rect):
    """Whether the scroll area lies wholly inside rect (no slack: a popup edge is a hard boundary)."""
    return (area["x"] >= rect["x"] and area["y"] >= rect["y"]
            and area["x"] + area["width"] <= rect["x"] + rect["width"]
            and area["y"] + area["height"] <= rect["y"] + rect["height"])


def _element_id(item):
    if not isinstance(item, dict):
        return None
    value = item.get(wda_tree.ELEMENT_KEY) or item.get("ELEMENT")
    return value if isinstance(value, str) and value else None


def _now_text():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def action_result(function):
    """Attach execution evidence (and, for visual failures, a screenshot) to every ToolError.

    If the phone accepted at least one mutation during the call, the error says the
    operation ran partly (`action_executed: True`, `action_complete: False`) and must
    be checked rather than repeated. Nested calls keep the first screenshot.
    """
    typing = function.__name__ == "type_text"
    swipe = function.__name__ == "swipe"

    @functools.wraps(function)
    def wrapper(self, *args, **kwargs):
        before = self.accepted_actions
        try:
            return function(self, *args, **kwargs)
        except ToolError as error:
            accepted = self.accepted_actions - before
            if accepted > 0:
                error.details.update(action_executed=True, action_complete=False)
                error.details.setdefault("verification_required", PARTIAL_VERIFICATION)
                if swipe:
                    error.details.setdefault("attempts", accepted)
            else:
                error.details.setdefault("action_executed", False)
            self._switch_to_coordinates(error, typing=typing)
            raise

    return wrapper


class PhoneController:
    """All phone operations on top of one WDAClient.

    The runtime sets the public knobs (settle_seconds, call_budget, typing_frequency,
    keep_artifacts, image_original, jpeg_quality, ...) after construction.
    """

    def __init__(self, client, state_dir, screen=None, runner=None):
        self.client = client
        self.state_dir = Path(state_dir)
        self.artifacts_dir = self.state_dir / "artifacts"
        self.screen = screen
        self.runner = runner
        self.accepted_actions = 0
        self.settle_seconds = 0.0
        self.call_budget = CALL_BUDGET
        self.typing_frequency = TYPING_FREQUENCY
        self.typing_piece = TYPING_PIECE
        self.keep_artifacts = KEEP_ARTIFACTS
        self.image_original = False
        self.sips_path = SIPS_PATH
        self.jpeg_quality = JPEG_QUALITY
        self.snapshots = collections.OrderedDict()
        self.pending_input = None
        self.last_target = None
        self._viewport_cache = None   # (monotonic time, viewport dict)
        self._screen_viewport = None  # last {"width", "height"} pushed to the preview
        self._screen_targets = {}     # element path -> centre point, for preview tap markers
        self._source_app = None       # bundle id named by the last /source root
        self._deadline = None         # batch-wide deadline (also caps typing)

    # --- support API used by the runtime -------------------------------------------------------------

    def external_action(self):
        """The user acted on the phone from the preview (e.g. Home): earlier focus and geometry may be gone."""
        self.accepted_actions += 1
        self._viewport_cache = None
        self.pending_input = None

    def reset(self):
        """The WDA session was closed or replaced: forget everything tied to it."""
        self.snapshots.clear()
        self._viewport_cache = None
        self.pending_input = None
        self._source_app = None
        self._screen_targets.clear()
        self.last_target = None

    # --- mutations and preview telemetry --------------------------------------------------------------

    def _post(self, path, payload, timeout=None, session=True):
        """The only way a mutation reaches the phone: sent once, counted when accepted."""
        self._telemetry(path, payload)
        if session:
            result = self.client.session("POST", path, payload, timeout=timeout)
        else:
            result = self.client.request("POST", path, payload, timeout=timeout)
        self.accepted_actions += 1
        return result

    def _telemetry(self, path, payload):
        """Show the gesture in the live preview. Never raises, never talks to WDA, never delays."""
        screen = self.screen
        if screen is None:
            return
        try:
            viewport = self._telemetry_viewport()
            if path == "/wda/tap":
                screen.gesture(TAP_TELEMETRY, point={"x": payload["x"], "y": payload["y"]}, viewport=viewport)
            elif path.endswith("/click"):
                point = self._screen_targets.get(path[:-len("/click")])
                if point is not None:
                    screen.gesture(TAP_TELEMETRY, point=dict(point), viewport=viewport)
            elif path == "/wda/dragfromtoforduration":
                duration_ms = max(300, min(3000, int((payload.get("duration", 0) + 0.35) * 1000)))
                screen.gesture(DRAG_TELEMETRY,
                               from_point={"x": payload["fromX"], "y": payload["fromY"]},
                               to_point={"x": payload["toX"], "y": payload["toY"]},
                               duration_ms=duration_ms, viewport=viewport)
        except Exception:  # telemetry must never affect the phone action
            pass

    def _telemetry_viewport(self):
        cached = self._viewport_cache
        if cached is None:
            return None
        return {"width": cached[1]["width"], "height": cached[1]["height"]}

    def _remember_target(self, path, cx, cy):
        if self.screen is None:
            return
        if len(self._screen_targets) >= SCREEN_TARGET_LIMIT:
            self._screen_targets.clear()
        self._screen_targets[path] = {"x": cx, "y": cy}

    def _push_viewport(self, width, height):
        if self.screen is None:
            return
        current = {"width": width, "height": height}
        if current == self._screen_viewport:
            return
        self._screen_viewport = current
        try:
            self.screen.set_viewport(dict(current))
        except Exception:
            pass

    def _external_seq(self):
        """The preview's count of user actions (toolbar Home), or None without a preview."""
        if self.screen is None:
            return None
        try:
            return self.screen.external_seq()
        except Exception:
            return None

    # --- viewport and foreground ---------------------------------------------------------------------

    def viewport(self, max_age=0):
        """The screen size in points; a cached value younger than max_age seconds is reused."""
        cached = self._viewport_cache
        if max_age and cached is not None and time.monotonic() - cached[0] <= max_age:
            return dict(cached[1])
        value = self.client.session("GET", "/window/size")
        width = value.get("width") if isinstance(value, dict) else None
        height = value.get("height") if isinstance(value, dict) else None
        for number in (width, height):
            if (isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number)
                    or not 1 <= number <= 10000):
                raise ToolError("invalid_response", "The iPhone did not report its screen size.")
        result = {"width": width, "height": height, "units": "iPhone points"}
        self._viewport_cache = (time.monotonic(), result)
        self._push_viewport(width, height)
        return dict(result)

    def _source_viewport(self, info):
        """Reuse the cached viewport while the /source root reports exactly that size."""
        cached = self._viewport_cache
        if info.width is None or info.height is None or cached is None:
            return self.viewport()
        if (float(cached[1]["width"]), float(cached[1]["height"])) != (info.width, info.height):
            return self.viewport()  # first read or rotation: ask WDA for the real window size
        self._viewport_cache = (time.monotonic(), cached[1])
        return dict(cached[1])

    def active_app(self, timeout=None):
        """Bundle id of the app in front; a channel fault when XCTest cannot tell."""
        result = self.client.request("GET", "/wda/activeAppInfo", timeout=timeout)
        value = result.get("value") if isinstance(result, dict) else None
        app = value.get("bundleId") if isinstance(value, dict) else None
        if not isinstance(app, str) or not app or app.startswith("local.pid."):
            raise ToolError(
                "foreground_unavailable",
                "The iPhone automation channel cannot identify the app in front. Run iphone_ready to refresh the "
                "connection.",
                details={"foreground_app": app, "action_executed": False,
                         "recovery": {"next_tool": "iphone_ready", "next_arguments": {}, "replay_action": False}})
        return app

    # --- observation ---------------------------------------------------------------------------------

    def _tree(self, include_invisible=False, expensive_visibility=False):
        """(nodes, viewport) from one /source read; the root usually names the app and size."""
        path = "/source?format=xml" if expensive_visibility else "/source?format=xml&excluded_attributes=visible"
        raw = self.client.session("GET", path)
        info = wda_tree.parse_source(raw)
        self._source_app = info.bundle_id
        viewport = self._source_viewport(info)
        nodes = wda_tree.filter_nodes(info.elements, viewport, include_invisible)
        return nodes, viewport

    def observe(self, mode="tree", include_invisible=False, max_nodes=100, expensive_visibility=False):
        """Read the screen: accessibility nodes, a screenshot, or both."""
        if mode not in OBSERVATION_MODES:
            raise _invalid("mode must be tree, screenshot or both.")
        _integer(max_nodes, "max_nodes", 1, MAX_NODES_LIMIT)
        _boolean(include_invisible, "include_invisible")
        _boolean(expensive_visibility, "expensive_visibility")
        if mode == "screenshot":
            app = self.active_app()
            nodes, viewport = [], self.viewport(VIEWPORT_TTL)
        else:
            nodes, viewport = self._tree(include_invisible, expensive_visibility)
            app = self._source_app or self.active_app()
        return self._observation(nodes, viewport, app, mode, max_nodes, expensive_visibility)

    def _observation(self, nodes, viewport, app, mode, max_nodes=100, expensive_visibility=False):
        """Remember a snapshot (all nodes) and build the model-facing observation."""
        observation_id = uuid.uuid4().hex[:12]
        self.snapshots[observation_id] = {"time": time.monotonic(), "viewport": viewport, "app": app,
                                          "nodes": nodes if mode != "screenshot" else None}
        while len(self.snapshots) > SNAPSHOT_LIMIT:
            self.snapshots.popitem(last=False)
        result = {"observation_id": observation_id, "observed_at": _now_text(), "app": app, "viewport": viewport}
        if mode in ("tree", "both"):
            result["nodes"] = [compact_node(node) for node in nodes[:max_nodes]]
            result["total_nodes"] = len(nodes)
            result["truncated"] = len(nodes) > max_nodes
            if expensive_visibility:
                result["visibility_computed"] = True
            if not nodes:
                result["warnings"] = [EMPTY_TREE_WARNING]
        if mode in ("screenshot", "both"):
            result["image"] = self.capture(viewport)
        return result

    def _scroll_observation(self, nodes, viewport, mode, max_nodes=100):
        """An observation built from a tree that was already read (no extra source request)."""
        if mode == "none":
            return None
        return self._observation(nodes, viewport, self._source_app or self.active_app(), mode, max_nodes)

    def _cool_off(self, seconds):
        """Let WDA wait up to `seconds` for animations before the next snapshot. Never fails the caller."""
        try:
            self.client.session("POST", "/appium/settings", {"settings": {"animationCoolOffTimeout": seconds}})
            return True
        except ToolError:
            self.client.reapply_settings()  # the next command re-sends the fast session settings
            return False

    def _observe_after(self, mode, max_nodes=100):
        """Post-action observation; with settling on, a tree read waits for the transition to end."""
        settle = self.settle_seconds
        if settle > 0 and mode == "screenshot":
            time.sleep(min(settle, SCREENSHOT_SETTLE_CAP))  # WDA has no animation wait for screenshots
        if settle <= 0 or mode not in ("tree", "both") or not self._cool_off(settle):
            return self.observe(mode, max_nodes=max_nodes)
        try:
            return self.observe(mode, max_nodes=max_nodes)
        finally:
            self._cool_off(0)

    def capture(self, viewport):
        """Take a screenshot: keep the native PNG privately, return the model-sized image."""
        response = self.client.request("GET", "/screenshot", timeout=SCREENSHOT_TIMEOUT)
        encoded = response.get("value") if isinstance(response, dict) else None
        try:
            data = base64.b64decode(encoded, validate=True)
        except (TypeError, ValueError, binascii.Error):
            raise ToolError("invalid_response", "The iPhone screenshot could not be decoded.") from None
        if not data.startswith(wda_image.PNG_SIGNATURE):
            raise ToolError("invalid_response", "The iPhone screenshot is not a PNG image.")
        path = wda_image.save_png_artifact(self.artifacts_dir, data)
        native = wda_image.png_size(data[:32])
        if native and (native[0] > native[1]) != (viewport["width"] > viewport["height"]):
            # The capture is turned the other way than the remembered viewport: the phone rotated.
            viewport.update(self.viewport())
        image = wda_image.model_image(path, runner=self.runner, sips_path=self.sips_path,
                                      original=self.image_original, quality=self.jpeg_quality)
        wda_image.prune_artifacts(self.artifacts_dir, self.keep_artifacts)
        result = {"path": str(image.path), "mimeType": image.mime_type}
        if image.width and image.height:
            result["width"] = image.width
            result["height"] = image.height
            result["pixel_to_point"] = [round(viewport["width"] / image.width, 4),
                                        round(viewport["height"] / image.height, 4)]
        return result

    # --- queries and target resolution -----------------------------------------------------------------

    def _elements(self, predicate_text, timeout=None):
        """POST /elements; the Application root WDA may prepend is dropped so index means the same everywhere."""
        found = self.client.session("POST", "/elements", {"using": "predicate string", "value": predicate_text},
                                    timeout=timeout)
        if found is None:
            return []
        if not isinstance(found, list):
            raise ToolError("invalid_response", "The iPhone returned an unexpected element list.")
        return [item for item in found
                if not (isinstance(item, dict) and item.get("type") == wda_tree.APPLICATION)]

    def _query(self, selector, limit=CANDIDATE_LIMIT):
        """Matches in tree order, carrying whatever attributes WDA returned inline."""
        found = self._elements(wda_tree.predicate(selector))
        index = wda_tree.selector_index(selector)
        inline = all(isinstance(item, dict) and isinstance(item.get("rect"), dict) for item in found)
        if index is not None:
            chosen = [(index, found[index])] if index < len(found) else []
        else:
            # Inline rects cost nothing more, so every match can be weighed; bare ids are read up to the limit.
            chosen = list(enumerate(found if inline else found[:limit]))
        elements = []
        for position, item in chosen:
            element_id = _element_id(item)
            if element_id is None:
                continue
            element = {"element_id": element_id, "index": position}
            for source, key in (("rect", "rect"), ("type", "type"), ("label", "label"), ("attribute/name", "name"),
                                ("attribute/value", "value"), ("enabled", "enabled")):
                if item.get(source) is not None:
                    element[key] = item[source]
            elements.append(element)
        return {"elements": elements, "matches": len(found),
                "complete": index is not None or len(elements) == len(found)}

    @staticmethod
    def _element_path(element):
        return "/element/" + quote(element["element_id"], safe="")

    def _element_rect(self, element):
        if "rect" not in element:
            element["rect"] = self.client.session("GET", self._element_path(element) + "/rect")
        rect = element["rect"]
        if not _valid_rect(rect):
            raise ToolError("invalid_response", "The iPhone reported an element position that is not a number.")
        return rect

    def _element_hittable(self, element):
        if "hittable" not in element:
            value = self.client.session("GET", self._element_path(element) + "/attribute/hittable")
            element["hittable"] = value in (True, 1, "true", "1")
        return element["hittable"]

    def _describe(self, element):
        """The candidate format used by find, scroll_find and target errors (never an element id)."""
        rect = self._element_rect(element)
        cx, cy = wda_tree.center(rect)
        described = {"index": element["index"]}
        described.update(compact_node(dict(element, rect=rect)))
        described["tap"] = [round(cx), round(cy)]
        if "hittable" in element:
            described["hittable"] = element["hittable"]
        return described

    def find(self, selector, limit=10):
        """Look up elements without reading the whole tree; zero matches is a normal result."""
        _integer(limit, "limit", 1, 30)
        found = self._query(selector, limit)
        elements = [self._describe(element) for element in found["elements"][:limit]]
        truncated = found["matches"] > min(limit, len(found["elements"])) and wda_tree.selector_index(selector) is None
        return {"matches": found["matches"], "elements": elements, "truncated": truncated}

    def _choose(self, found, viewport, editable):
        """Reduce several matches to the one a tap can only mean, or report the candidates."""
        matches, complete = found["matches"], found["complete"]
        candidates = [element for element in found["elements"]
                      if wda_tree.on_screen(self._element_rect(element), viewport)]
        if not candidates and complete:
            raise ToolError("offscreen_target", ALL_OFFSCREEN_MESSAGE, details={
                "action_executed": False, "matches": matches,
                "candidates": [self._describe(element) for element in found["elements"][:CANDIDATE_LIMIT]],
                "viewport": viewport,
                "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                             "replay_action": False}})
        if editable:
            fields = [element for element in candidates if element.get("type") in wda_tree.EDITABLE_TYPES]
            if fields:
                candidates = fields
        if complete and len(candidates) == 1:
            # Observations list only on-screen nodes, so the remaining match is the one that was seen.
            self.last_target = {"matches": matches, "chosen": "only_match_on_screen",
                                "index": candidates[0]["index"]}
            return candidates[0]
        listed = candidates[:CANDIDATE_LIMIT]
        ordered = sorted(listed, key=lambda element: _area(element["rect"]))
        nested = (complete and len(listed) == len(candidates) > 1
                  and all(wda_tree.contains(ordered[i + 1]["rect"], ordered[i]["rect"])
                          for i in range(len(ordered) - 1)))
        if nested:
            # Nested matches share one touch point: the innermost centre lies inside all of them.
            for element in ordered:
                if self._element_hittable(element):
                    self.last_target = {"matches": matches, "chosen": "innermost_of_nested_matches",
                                        "index": element["index"]}
                    return element
            raise ToolError("occluded_target", OCCLUDED_MESSAGE, details={
                "action_executed": False, "matches": matches,
                "candidates": [self._describe(element) for element in ordered], "viewport": viewport,
                "recovery": {"use": "coordinates", "next_tool": "iphone_tap", "replay_action": False}})
        for element in listed:
            self._element_hittable(element)
        raise ToolError("ambiguous_target", AMBIGUOUS_MESSAGE, details={
            "action_executed": False, "matches": matches,
            "candidates": [self._describe(element) for element in listed],
            "candidates_truncated": not complete or len(listed) < len(candidates),
            "recovery": {"replay_action": False, "next_step": AMBIGUOUS_NEXT_STEP}})

    def _resolve(self, selector, editable=False, found=None):
        """One reachable element for the selector, with its WDA path. Sends nothing on failure."""
        result = found if found is not None else self._query(selector)
        self.last_target = None
        if result["matches"] == 0:
            raise ToolError("no_such_element", NO_MATCH_MESSAGE, details={"action_executed": False})
        if not result["elements"]:
            raise ToolError("no_such_element", INDEX_BEYOND_MESSAGE,
                            details={"action_executed": False, "matches": result["matches"]})
        viewport = self.viewport(VIEWPORT_TTL)
        if result["matches"] == 1 or wda_tree.selector_index(selector) is not None:
            element = result["elements"][0]
        else:
            element = self._choose(result, viewport, editable)
        rect = self._element_rect(element)
        cx, cy = wda_tree.center(rect)
        if not wda_tree.on_screen(rect, viewport):
            raise ToolError("offscreen_target", OFFSCREEN_MESSAGE, details={
                "action_executed": False, "target_rect": rect, "viewport": viewport,
                "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                             "replay_action": False}})
        path = self._element_path(element)
        if not self._element_hittable(element):
            tap_point = {"x": round(cx), "y": round(cy)}
            raise ToolError("occluded_target", OCCLUDED_MESSAGE, details={
                "action_executed": False, "target_rect": rect, "tap_point": tap_point, "viewport": viewport,
                "recovery": {"use": "coordinates", "next_tool": "iphone_tap", "next_arguments": dict(tap_point),
                             "replay_action": False}})
        if editable:
            if "type" not in element:
                element["type"] = self.client.session("GET", path + "/attribute/type")
            if element.get("type") not in wda_tree.EDITABLE_TYPES:
                secure = element.get("type") == wda_tree.SECURE_TYPE
                raise ToolError("not_editable", SECURE_FIELD_MESSAGE if secure else NOT_EDITABLE_MESSAGE,
                                details={"action_executed": False, "secure_field": secure})
        self._remember_target(path, cx, cy)
        element["path"] = path
        return element

    def _target(self, selector, editable=False, found=None):
        element = self._resolve(selector, editable, found)
        return element["path"], element.get("type")

    # --- screenshot-on-failure -----------------------------------------------------------------------

    def _switch_to_coordinates(self, error, typing=False):
        """Hand a failed selector/scroll/check back with one screenshot, so the next call can use x/y."""
        details = error.details
        if error.code not in VISUAL_FAILURES or details.get("secure_field"):
            return  # privacy: a password field is never captured (the runtime pauses the preview)
        recovery = details.get("recovery")
        if isinstance(recovery, dict) and recovery.get("visual_check_required"):
            return  # an inner call already attached its screenshot (or tried to)
        details.setdefault("action_executed", False)
        try:
            observation = details.get("observation")
            if not isinstance(observation, dict):
                app = details.get("foreground_app")
                if isinstance(app, str) and app:
                    details["observation"] = self._observation([], self.viewport(VIEWPORT_TTL), app, "screenshot")
                else:
                    details["observation"] = self.observe("screenshot")
            elif "image" not in observation:
                observation["image"] = self.capture(observation["viewport"])
        except ToolError as failure:
            details["observation_error"] = {"code": failure.code, "message": failure.message}
        except Exception:  # e.g. the artifacts folder is not writable: keep the original error
            details["observation_error"] = {"code": "internal_error", "message": "The screenshot could not be saved."}
        rebuilt = dict(recovery) if isinstance(recovery, dict) else {}
        rebuilt.pop("next_tool", None)
        rebuilt.pop("next_arguments", None)
        rebuilt["use"] = "coordinates" if error.code in SELECTOR_FAILURES else "screenshot"
        rebuilt["visual_check_required"] = True
        rebuilt["replay_action"] = False
        tool, step = self._recovery_hint(error.code, typing)
        rebuilt["next_step"] = step + STEP_SUFFIX
        if tool is not None:
            rebuilt["next_tool"] = tool
        observation = details.get("observation")
        if not (isinstance(observation, dict) and "image" in observation):
            rebuilt["next_tool"] = "iphone_observe"
            rebuilt["next_arguments"] = {"mode": "screenshot"}
        elif (rebuilt.get("next_tool") == "iphone_tap" and not typing and error.code != "occluded_target"
              and isinstance(details.get("tap_point"), dict)):
            rebuilt["next_arguments"] = dict(details["tap_point"])
        details["recovery"] = rebuilt

    @staticmethod
    def _recovery_hint(code, typing):
        """(next_tool or None, next_step) for a visual failure."""
        if code == "offscreen_target":
            return "iphone_swipe", OFFSCREEN_STEP
        if code == "occluded_target":
            return "iphone_tap", OCCLUDED_STEP
        if code in SCROLL_CODES:
            return None, SCROLL_STEP
        if code in RESULT_CODES:
            return None, RESULT_STEP
        if typing:
            return "iphone_tap", TYPING_STEP
        return "iphone_tap", TAP_STEP

    # --- shared result shape -------------------------------------------------------------------------

    def _after(self, expect=None, observe="none", max_nodes=100):
        """Result of a successful mutation: optimistic unless expect asks for a check."""
        result = {"action_executed": True, "action_complete": True, "verified": False, "verification_deferred": True}
        if expect:
            result["postcondition"] = self.wait(expect)
            result["verified"] = True
            result["verification_deferred"] = False
        if observe != "none":
            result["observation"] = self._observe_after(observe, max_nodes)
        return result

    def _guard(self, observation_id=None):
        """Viewport for coordinates; a supplied observation_id must still match the app and orientation."""
        if observation_id is None:
            return self.viewport(VIEWPORT_TTL)
        snapshot = self.snapshots.get(observation_id) if isinstance(observation_id, str) else None
        if snapshot is None:
            raise _stale("This observation_id is unknown here. Observe again, or use coordinates from the current "
                         "screen.", "unknown_observation")
        if self.active_app() != snapshot["app"]:
            raise _stale("The app in front changed since that observation. Observe again.", "foreground_changed")
        viewport = self.viewport(0)
        if viewport != snapshot["viewport"]:
            raise _stale("The screen orientation changed since that observation. Observe again before using its "
                         "coordinates.", "viewport_changed")
        return viewport

    # --- operations ----------------------------------------------------------------------------------

    @action_result
    def wait(self, selector, timeout_seconds=6):
        """Poll until an element matching the selector exists (presence only)."""
        _finite(timeout_seconds, "timeout_seconds", 0, 20)
        predicate_text = wda_tree.predicate(selector)
        wanted = wda_tree.selector_index(selector) or 0
        deadline = time.monotonic() + timeout_seconds
        polls = 0
        while True:
            polls += 1
            if timeout_seconds:
                request_timeout = min(max(MIN_POLL_TIMEOUT, deadline - time.monotonic()), WAIT_REQUEST_CAP)
            else:
                request_timeout = WAIT_ZERO_PROBE
            found = self._elements(predicate_text, timeout=request_timeout)
            if len(found) > wanted:
                return {"verified": True, "matches": len(found), "polls": polls,
                        "criterion": "selector exists; presence alone does not prove business success"}
            if time.monotonic() >= deadline:
                raise ToolError("postcondition_failed", "The expected element did not appear in time.",
                                details={"polls": polls})
            time.sleep(min(WAIT_SLEEP, max(0.0, deadline - time.monotonic())))

    @action_result
    def tap(self, selector=None, x=None, y=None, observation_id=None, expect=None, observe="none"):
        """Tap a resolved element, or x/y in iPhone points."""
        _check_observe(observe)
        _check_expect(expect)
        if selector is not None:
            if x is not None or y is not None:
                raise _invalid("iphone_tap needs either selector or both x and y; observation_id is optional.")
            path, _ = self._target(selector)
            chosen = self.last_target
            self._post(path + "/click", {})
        else:
            if x is None or y is None:
                raise _invalid("iphone_tap needs either selector or both x and y; observation_id is optional.")
            _finite(x, "x")
            _finite(y, "y")
            viewport = self._guard(observation_id)
            if x >= viewport["width"] or y >= viewport["height"]:
                raise _invalid("Coordinates are outside the iPhone screen.")
            chosen = None
            self._post("/wda/tap", {"x": x, "y": y})
        result = self._after(expect, observe)
        if chosen:
            result["target"] = chosen
        return result

    @action_result
    def launch_app(self, bundle_id, verify=False, expect=None, observe="none"):
        """Bring an app to the front once (activate, never relaunch)."""
        if not isinstance(bundle_id, str) or not BUNDLE_RE.fullmatch(bundle_id):
            raise _invalid("Use the app's exact bundle ID (look it up with iphone_apps).")
        _boolean(verify, "verify")
        _check_observe(observe)
        _check_expect(expect)
        self._viewport_cache = None
        self._post("/wda/apps/activate", {"bundleId": bundle_id}, timeout=ACTIVATE_TIMEOUT)
        if not verify:
            result = self._after(expect, observe)
            result["foreground_verified"] = False
            return result
        deadline = time.monotonic() + LAUNCH_VERIFY_SECONDS
        app = None
        channel_fault = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if channel_fault is not None:
                    raise channel_fault
                raise ToolError(
                    "postcondition_failed",
                    "The app was activated but did not come to the front within five seconds. Do not activate it "
                    "again automatically.",
                    details={"requested_app": bundle_id, "foreground_app": app, "foreground_verified": False,
                             "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                                          "replay_action": False}})
            try:
                app = self.active_app(timeout=max(MIN_POLL_TIMEOUT, remaining))
                channel_fault = None
            except ToolError as error:
                if error.code != "foreground_unavailable":
                    raise
                channel_fault = error  # XCTest may briefly not know the app mid-launch: not yet
                app = None
            if app == bundle_id:
                break
            time.sleep(min(POLL_SLEEP, max(0.0, deadline - time.monotonic())))
        result = self._after(expect, observe)
        result.update(verified=True, verification_deferred=False, foreground_verified=True,
                      verification_scope="The requested app is in front; the user's task is separate.")
        return result

    @action_result
    def press_button(self, name, verify=False, expect=None, observe="none"):
        """Press Home (WDA's dedicated endpoint) or a volume button, once."""
        if name not in BUTTONS:
            raise _invalid("name must be home, volumeup or volumedown.")
        _boolean(verify, "verify")
        _check_observe(observe)
        _check_expect(expect)
        if name != "home":
            self._post("/wda/pressButton", {"name": name})
            return self._after(expect, observe)  # volume changes cannot be verified
        self._viewport_cache = None
        # XCTest pressButton can acknowledge Home without leaving the app; /wda/homescreen cannot.
        self._post("/wda/homescreen", {}, session=False)
        if not verify:
            result = self._after(expect, observe)
            result["foreground_verified"] = False
            return result
        deadline = time.monotonic() + HOME_VERIFY_SECONDS
        app = None
        try:
            while True:
                app = self.active_app(timeout=max(MIN_POLL_TIMEOUT, deadline - time.monotonic()))
                if app == SPRINGBOARD:
                    break
                if time.monotonic() >= deadline:
                    raise ToolError("postcondition_failed",
                                    "Home was pressed, but the Home Screen did not come to the front. Look at the "
                                    "screen; do not press Home again automatically.",
                                    details={"foreground_app": app})
                time.sleep(min(POLL_SLEEP, max(0.0, deadline - time.monotonic())))
            result = self._after(expect, observe)
            result.update(verified=True, verification_deferred=False, foreground_verified=True, foreground_app=app,
                          verification_scope="The Home Screen is in front.")
            return result
        except ToolError as error:
            error.details.update(action_executed=True, home_foreground_verified=(app == SPRINGBOARD),
                                 verification_required="Home was pressed. Look at the screen before the next action; "
                                                       "do not press it again automatically.")
            raise

    @action_result
    def swipe(self, direction="up", region=None, observation_id=None, expect=None, verify=False, observe="none",
              _baseline=None, _max_nodes=100):
        """One drag gesture; verify=True checks once that stable content moved. Never a second gesture."""
        _check_direction(direction)
        _check_observe(observe)
        _boolean(verify, "verify")
        _check_expect(expect)
        viewport = None
        if observation_id is not None:
            viewport = self._guard(observation_id)
            if region is not None:
                wda_tree.validate_region(region, viewport)
        if verify:
            before, current = _baseline if _baseline is not None else self._tree()
            if viewport is not None and current != viewport:
                raise _stale("The screen orientation changed while preparing this swipe. Observe again.",
                             "viewport_changed", scope="region")
            viewport = current
        else:
            before = []
            if viewport is None:
                viewport = _baseline[1] if _baseline is not None else self.viewport(VIEWPORT_TTL)
        area = wda_tree.validate_region(region, viewport) if region is not None else wda_tree.default_region(viewport)
        modals = wda_tree.native_modals(before) if verify else []
        if modals and (region is None or not all("rect" in modal and _inside(area, modal["rect"])
                                                  for modal in modals)):
            self._refuse_modal_scroll(region, area, modals, before, viewport, observe, _max_nodes)
        (from_x, from_y), (to_x, to_y) = wda_tree.gesture_points(area, direction)
        self._post("/wda/dragfromtoforduration",
                   {"fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y, "duration": DRAG_HOLD_SECONDS})
        if not verify:
            result = self._after(expect, observe, max_nodes=_max_nodes)
            result.update(strategy="short_drag", attempts=1, progress_verified=False)
            return result
        after, after_viewport = self._tree()
        tree_mode = "tree" if observe in ("tree", "both") else "none"
        reasons = []
        if after_viewport != viewport:
            reasons.append("viewport_changed")
        if wda_tree.native_modals(after) != modals:
            reasons.append("modal_changed")
        if reasons:
            details = {"action_executed": True, "verified": False, "changed": False, "attempts": 1,
                       "reasons": reasons, "recovery": {"same_gesture_retry": False, "replay_action": False}}
            observed = self._scroll_observation(after, after_viewport, tree_mode, _max_nodes)
            if observed:
                details["observation"] = observed
            raise ToolError("scroll_context_changed",
                            "The swipe was sent, but the screen orientation or a native alert or sheet changed. "
                            "Look at the screenshot before the next action.", details=details)
        if wda_tree.scroll_progress(before, after, area, direction):
            result = {"action_executed": True, "action_complete": True, "verified": True,
                      "verification_deferred": False, "changed": True, "progress_verified": True,
                      "verification_scope": "Stable on-screen content moved in the requested direction; whether "
                                            "the list is complete is separate.",
                      "attempts": 1, "strategy": "short_drag"}
            observed = self._scroll_observation(after, after_viewport, observe, _max_nodes)
            if observed:
                result["observation"] = observed
            if expect:
                result["postcondition"] = self.wait(expect)
            return result
        details = {"action_executed": True, "verified": False, "changed": False, "attempts": 1, "region": area,
                   "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                                "next_step": "Look at the page and where the list starts. On an overview, tap the "
                                             "actual list entry; at the end, reconcile counts; otherwise look for a "
                                             "custom picker or overlay, or another stable region.",
                                "same_gesture_retry": False, "end_of_list_proven": False}}
        observed = self._scroll_observation(after, after_viewport, tree_mode, _max_nodes)
        if observed:
            details["observation"] = observed
        raise ToolError("no_scroll_progress",
                        "The swipe was sent, but stable on-screen content did not move in that direction. This does "
                        "not prove the list is empty or finished; look at the screenshot before the next action.",
                        details=details)

    def _refuse_modal_scroll(self, region, area, modals, before, viewport, observe, max_nodes):
        details = {"action_executed": False, "verified": False, "region": area,
                   "native_modals": [compact_node(modal) for modal in modals],
                   "recovery": {"next_tool": "iphone_observe", "next_arguments": {"mode": "both"},
                                "replay_action": False,
                                "next_step": "Handle the alert or sheet first, or choose a fresh scroll region wholly "
                                             "inside the list you mean. Do not scroll the page underneath a popup."}}
        observed = self._scroll_observation(before, viewport, "tree" if observe in ("tree", "both") else "none",
                                            max_nodes)
        if observed:
            details["observation"] = observed
        if region is None:
            raise ToolError("modal_requires_region",
                            "A native alert or sheet is on screen, so a checked swipe needs an explicit region "
                            "inside it. Handle the popup first, or give such a region; nothing was swiped.",
                            details=details)
        raise ToolError("blocked_scroll_region",
                        "The scroll region is not wholly inside every native alert or sheet on screen, so nothing "
                        "was swiped.", details=details)

    @action_result
    def scroll_find(self, selector, direction="up", max_swipes=1):
        """Find a tappable element, swiping at most once."""
        wda_tree.predicate(selector)
        _integer(max_swipes, "max_swipes", 0, 1)
        _check_direction(direction)
        count = 0
        for count in range(max_swipes + 1):
            found = self._query(selector)
            if found["matches"]:
                try:
                    element = self._resolve(selector, found=found)
                except ToolError as error:
                    error.details.update(swipes=count, max_swipes=max_swipes)
                    # Only "not on screen yet" earns the one swipe; ambiguity or a popup stops at once.
                    if error.code != "offscreen_target" or count > 0 or max_swipes == 0:
                        raise
                else:
                    target = self._describe(element)
                    target["hittable"] = True
                    return {"verified": True, "action_executed": count > 0, "swipes": count,
                            "matches": found["matches"], "target": target}
            if count == max_swipes:
                break
            self.swipe(direction, verify=False, observe="none")
        raise ToolError("search_exhausted", "No tappable match after this search step.", details={
            "swipes": count, "max_swipes": max_swipes, "stop_reason": "visual_check_required",
            "action_executed": count > 0})

    @action_result
    def collect_list(self, row_type="Cell", max_pages=6, end_selector=None):
        """Collect de-duplicated rows over up to max_pages pages; never claims completeness."""
        _integer(max_pages, "max_pages", 1, 10)
        if end_selector is not None:
            wda_tree.predicate(end_selector)
        if not isinstance(row_type, str) or not ROW_TYPE_RE.fullmatch(row_type):
            raise _invalid("row_type must be an element type such as Cell or StaticText.")
        kind = wda_tree.full_type(row_type)
        rows = collections.OrderedDict()
        pages = []
        seen_pages = set()
        reason = "page_budget"
        end_marker = False
        observed = self.observe(max_nodes=LIST_MAX_NODES)
        index = 0
        for index in range(max_pages):
            nodes = self.snapshots[observed["observation_id"]]["nodes"]  # untruncated
            current = [node for node in nodes if node.get("type") == kind]
            for node in current:
                rows.setdefault(wda_tree.row_identity(node), node)
            pages.append({"page": index + 1, "rows_seen": len(current), "truncated": observed["truncated"]})
            if end_selector is not None:
                found = self._query(end_selector)
                if found["matches"]:
                    try:
                        self._resolve(end_selector, found=found)
                    except ToolError as error:
                        if error.code not in ("offscreen_target", "occluded_target", "ambiguous_target"):
                            raise
                    else:
                        end_marker = True
                        reason = "explicit_end_marker"
                        break
            # Virtualized lists may replace every label in fixed slots, so the next page is consumed
            # directly; value refreshes do not count as a new page.
            key = wda_tree.page_key(current)
            if key in seen_pages:
                reason = "no_progress"
                break
            seen_pages.add(key)
            if index == max_pages - 1:
                break
            observed = self.swipe("up", verify=False, observe="tree", _baseline=(nodes, observed["viewport"]),
                                  _max_nodes=LIST_MAX_NODES)["observation"]
        collected = [compact_node(row) for row in rows.values()]
        rows_truncated = len(collected) > ROW_LIMIT
        result = {"rows": collected[:ROW_LIMIT], "pages": pages, "stop_reason": reason,
                  "end_marker_seen": end_marker, "complete": False,
                  "coverage_verified": end_marker and not rows_truncated and not any(p["truncated"] for p in pages),
                  "limitations": list(LIST_LIMITATIONS)}
        if rows_truncated:
            result["rows_truncated"] = True
        if reason == "no_progress":
            error = ToolError("no_scroll_progress", "The list did not change after the last swipe.", details={
                "observation": observed, "action_executed": index > 0,
                "recovery": {"same_gesture_retry": False, "end_of_list_proven": False}})
            self._switch_to_coordinates(error)
            for key in ("observation", "observation_error", "recovery"):
                if key in error.details:
                    result[key] = error.details[key]
        return result

    # --- typing --------------------------------------------------------------------------------------

    @action_result
    def type_text(self, selector=None, text=None, allow_newlines=False, submit=False, replace=True, verify=False,
                  expect=None, observe="none", continue_token=None):
        """Type the whole text into an editable, non-password field (long text in parts)."""
        if continue_token is not None:
            if (selector is not None or text is not None or allow_newlines is not False or submit is not False
                    or replace is not True or verify is not False or expect is not None or observe != "none"):
                raise _invalid("continue_token resumes the earlier call with its own options; pass it alone.")
            return self._continue_input(continue_token)
        if text is None:
            raise _invalid("iphone_type_text needs text, or continue_token alone.")
        if (not isinstance(text, str) or not 1 <= len(text) <= MAX_TEXT_LENGTH
                or any((ord(ch) < 32 and ch not in "\n\r") or ord(ch) == 127 for ch in text)):
            raise _invalid("text must be 1 to 10000 characters, without control characters other than line breaks.")
        has_newline = "\n" in text or "\r" in text
        if has_newline and not allow_newlines:
            raise ToolError("newline_requires_intent",
                            "This text contains line breaks, which can send a message. Use allow_newlines only for a "
                            "multi-line field you have seen.", details={"action_executed": False})
        for value, name in ((allow_newlines, "allow_newlines"), (submit, "submit"), (replace, "replace"),
                            (verify, "verify")):
            _boolean(value, name)
        _check_observe(observe)
        _check_expect(expect)
        # Target (the first phone requests; all reads).
        if selector is not None:
            path, kind = self._target(selector, editable=True)
        else:
            path, kind = self._focused_field()
        if has_newline and kind != wda_tree.TEXT_VIEW:
            raise ToolError("newline_unsafe", "Line breaks are allowed only in a multi-line text view.",
                            details={"action_executed": False})
        if submit and kind == wda_tree.TEXT_VIEW:
            raise ToolError("submit_unsafe",
                            "This is a multi-line editor: Return adds a line break instead of sending. Type without "
                            "submit, then tap the visible Send button.", details={"action_executed": False})
        before = ""
        if verify and not replace:
            before = self._read_value(path)
            placeholder = self.client.session("GET", path + "/attribute/placeholderValue")
            if isinstance(placeholder, str) and placeholder and before == placeholder:
                before = ""  # WDA reports an empty field's placeholder as its value
        # Mutations.
        self.pending_input = None
        if selector is not None:
            self._post(path + "/click", {})  # focus; without a selector a coordinate tap already focused it
        if replace:
            self._post(path + "/clear", {})
        plan = {"path": path, "focused": selector is None, "pieces": wda_text.split_text(text, self.typing_piece),
                "typed": 0, "total": len(text), "expected": text if replace else before + text, "verify": verify,
                "submit": submit, "expect": expect, "observe": observe, "kind": kind}
        return self._type_pieces(plan)

    def _read_value(self, path):
        value = self.client.session("GET", path + "/attribute/value")
        return "" if value is None else str(value)

    def _focused_field(self):
        """(path, type) of the element with keyboard focus, for typing after a coordinate tap."""
        try:
            found = self.client.session("GET", "/element/active")
        except ToolError as error:
            if error.code != "no such element":
                raise
            raise ToolError("no_focused_field", NO_FOCUS_MESSAGE, details={"action_executed": False}) from None
        element_id = _element_id(found)
        if element_id is None:
            raise ToolError("no_focused_field", NO_FOCUS_MESSAGE, details={"action_executed": False})
        path = "/element/" + quote(element_id, safe="")
        kind = found.get("type") or self.client.session("GET", path + "/attribute/type")
        if kind not in wda_tree.EDITABLE_TYPES:
            secure = kind == wda_tree.SECURE_TYPE
            raise ToolError("not_editable", SECURE_FIELD_MESSAGE if secure else NOT_EDITABLE_MESSAGE,
                            details={"action_executed": False, "secure_field": secure})
        return path, kind

    def _type_pieces(self, plan):
        """Type pieces in order until done or the call budget is used; then hand back a token."""
        deadline = time.monotonic() + self.call_budget
        if self._deadline is not None:
            deadline = min(deadline, self._deadline)
        frequency = self.typing_frequency
        floor = getattr(self.client, "timeout", None) or 15.0
        sent = 0
        while plan["pieces"]:
            if sent and time.monotonic() >= deadline:
                break
            piece = plan["pieces"][0]
            timeout = wda_text.request_timeout(len(piece), frequency, floor=floor)
            try:
                # The element request focuses the field once; later pieces go to that focus, because
                # another element request may tap again and move the caret.
                if plan["focused"]:
                    self._post("/wda/keys", {"value": [piece], "frequency": frequency}, timeout=timeout)
                else:
                    self._post(plan["path"] + "/value", {"text": piece, "frequency": frequency}, timeout=timeout)
            except ToolError as error:
                error.details.update(characters_confirmed=plan["typed"], characters_total=plan["total"])
                self.pending_input = None
                raise
            plan["focused"] = True
            plan["pieces"].pop(0)
            plan["typed"] += len(piece)
            sent += 1
        if plan["pieces"]:
            plan.update(token=uuid.uuid4().hex[:12], mark=self.accepted_actions, external_mark=self._external_seq(),
                        created=time.monotonic())
            self.pending_input = plan
            return {"action_executed": True, "action_complete": False, "input_complete": False, "verified": False,
                    "verification_deferred": True, "characters": plan["typed"],
                    "remaining_characters": plan["total"] - plan["typed"], "submitted": False,
                    "continue_token": plan["token"], "next_step": TYPE_PARTIAL_NEXT_STEP}
        self.pending_input = None
        if plan["verify"]:
            actual = self.client.session("GET", plan["path"] + "/attribute/value")
            if actual != plan["expected"]:
                raise ToolError("input_mismatch",
                                "The typed text did not read back exactly. Do not submit or type it again blindly.",
                                details={"expected_length": len(plan["expected"]),
                                         "actual_length": len("" if actual is None else str(actual))})
        result = {"action_executed": True, "action_complete": True, "input_complete": True,
                  "verified": plan["verify"], "verification_deferred": not plan["verify"],
                  "exact_readback": plan["verify"], "characters": plan["total"], "submitted": False}
        if plan["submit"]:
            self._post("/wda/keys", {"value": ["\n"]})
            result.update(submitted=True, verified=False, verification_deferred=True, submission_verified=False,
                          verification_required=SUBMIT_VERIFICATION)
        if plan["expect"]:
            result["postcondition"] = self.wait(plan["expect"])
            result.update(verified=True, verification_deferred=False)
            if plan["submit"]:
                result.update(submission_verified=True, verification_scope=SUBMIT_SCOPE)
        if plan["observe"] != "none":
            result["observation"] = self._observe_after(plan["observe"])
        return result

    def _continue_input(self, token):
        plan = self.pending_input
        valid = (plan is not None and isinstance(token, str) and plan.get("token") == token
                 and self.accepted_actions == plan.get("mark")
                 and self._external_seq() == plan.get("external_mark")
                 and time.monotonic() - plan.get("created", 0.0) <= INPUT_TTL)
        if not valid:
            self.pending_input = None
            raise ToolError("input_continuation_expired", CONTINUATION_EXPIRED, details={
                "action_executed": False,
                "recovery": {"replay_action": False, "next_step": CONTINUATION_NEXT_STEP}})
        return self._type_pieces(plan)

    # --- batch ---------------------------------------------------------------------------------------

    def _batch_arguments(self, op):
        method = getattr(self, op)
        return {name for name in inspect.signature(method).parameters if not name.startswith("_")}

    def batch(self, steps):
        """Run known steps in order; stop at an error, unfinished text, an unverified send or the budget."""
        if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_BATCH_STEPS:
            raise _invalid("steps must be a list of 1 to 20 steps.")
        calls = []
        for position, step in enumerate(steps):
            path = "arguments.steps[%d]" % position
            if (not isinstance(step, dict) or not set(step) <= {"op", "args"} or step.get("op") not in BATCH_OPS
                    or not isinstance(step.get("args", {}), dict)):
                raise _invalid("Each step needs op (one of %s) and an args object." % ", ".join(BATCH_OPS),
                               argument_path=path)
            args = step.get("args", {})
            unknown = sorted(set(args) - self._batch_arguments(step["op"]))
            if unknown:
                raise _invalid("Unknown fields in `%s.args`: %s. Use only the declared fields."
                               % (path, ", ".join(unknown)), argument_path=path + ".args")
            calls.append((step["op"], args))
        results = []
        self._deadline = time.monotonic() + self.call_budget
        try:
            for index, (op, args) in enumerate(calls):
                if index > 0 and time.monotonic() >= self._deadline:
                    return self._batch_stop(results, index, index, "time_budget", completed=index)
                before = self.accepted_actions
                try:
                    result = getattr(self, op)(**args)
                except ToolError as error:
                    error.details.setdefault("action_executed", self.accepted_actions > before)
                    return self._batch_stop(results, index, index, error.code, completed=index,
                                            error=error.as_dict())
                results.append(result)
                if result.get("input_complete") is False:
                    return self._batch_stop(results, index, index + 1, "input_continues", completed=index)
                if result.get("submitted") and not result.get("submission_verified"):
                    return self._batch_stop(results, index, index + 1, "submission_requires_verification",
                                            completed=index + 1)
            return {"complete": True, "completed_steps": len(calls), "results": results, "stopped_at": None,
                    "resume_at": None, "stop_reason": None, "next_step": None}
        finally:
            self._deadline = None

    @staticmethod
    def _batch_stop(results, stopped_at, resume_at, reason, completed, error=None):
        """A stopped batch: where it stopped, where to resume, and what to do next."""
        next_step = BATCH_NEXT_STEPS["error"] if error is not None else BATCH_NEXT_STEPS[reason]
        stopped = {"complete": False, "completed_steps": completed, "results": results, "stopped_at": stopped_at,
                   "resume_at": resume_at, "stop_reason": reason, "next_step": next_step}
        if error is not None:
            stopped["error"] = error
        return stopped
