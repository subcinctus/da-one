"""The iPhone Use tool catalog: names, schemas, descriptions, instructions and the validator.

Two forms of every input schema exist:

* ``SCHEMAS`` is the complete runtime contract. Arguments are validated against it
  (``validate`` + ``validate_semantics``) exactly once, before any device I/O.
* ``published_schema(name)`` is what ``tools/list`` sends: the same closed shape, but the
  selector fields are documented only on ``iphone_find`` and repeated building blocks
  become ``$ref``s, which keeps the catalog small. Publication never changes ``SCHEMAS``.
"""

import copy
import math
import re

from errors import ToolError
from wda_tree import predicate

# --- names -------------------------------------------------------------------------------------------

TOOL_NAMES = ("iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
              "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text",
              "iphone_wait", "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen",
              "iphone_metrics")
TOOL_PREFIX = "iphone_"
SERVER_NAME = "iphone"
BATCH_OPS = ("tap", "swipe", "type_text", "launch_app", "press_button", "wait", "observe", "scroll_find")
BUNDLE_RE = re.compile(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+")
COUNTRY_RE = re.compile(r"[A-Za-z]{2}")


def op_name(tool):
    """The handler name of a tool: iphone_type_text -> type_text."""
    return tool[len(TOOL_PREFIX):] if isinstance(tool, str) and tool.startswith(TOOL_PREFIX) else tool


def tool_name(op):
    """The tool name of a handler: type_text -> iphone_type_text."""
    return op if isinstance(op, str) and op.startswith(TOOL_PREFIX) else TOOL_PREFIX + str(op)


# --- schema building blocks (DESIGN.md 11.2) ---------------------------------------------------------


def _string(low, high, description=None, **extra):
    schema = {"type": "string", "minLength": low, "maxLength": high}
    schema.update(extra)
    if description:
        schema["description"] = description
    return schema


def _number(kind, low, high, description=None, **extra):
    schema = {"type": kind, "minimum": low, "maximum": high}
    schema.update(extra)
    if description:
        schema["description"] = description
    return schema


def _boolean(default=None, description=None):
    schema = {"type": "boolean"}
    if default is not None:
        schema["default"] = default
    if description:
        schema["description"] = description
    return schema


def _enum(values, default=None, description=None):
    schema = {"type": "string", "enum": list(values)}
    if default is not None:
        schema["default"] = default
    if description:
        schema["description"] = description
    return schema


def _object(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


SEL = {
    "type": "object",
    "description": ("Exact label/name/value/type/enabled fields, label_contains, or a standalone predicate. rect, "
                    "visible and in_viewport are observation fields, not selector fields. Matches nested at one "
                    "place, or with only one on screen, resolve to that element; several separate matches return "
                    "candidates with tap points and an index."),
    "properties": {
        "label": _string(1, 1000, "Exact accessibility label copied from fresh nodes; real line breaks and "
                                  "punctuation are kept automatically."),
        "label_contains": _string(1, 1000, "Case-sensitive part of the label, for long or changing labels."),
        "name": _string(1, 1000, "Exact accessibility identifier/name. Nodes omit name when it equals label."),
        "value": _string(1, 1000, "Exact current accessibility value (not text to type). Omit values that change "
                                  "on their own."),
        "type": _string(1, 1000, "Element type as nodes show it, e.g. Button. Not an app bundle ID."),
        "enabled": {"oneOf": [{"type": "boolean"}, {"type": "string", "enum": ["true", "false"]}],
                    "description": "Optional exact enabled filter; it does not prove the element can be tapped."},
        "index": _number("integer", 0, 199, "0-based position among the matches in tree order, as listed by "
                                            "iphone_find or an ambiguous_target error. Only to choose between "
                                            "several matches."),
        "predicate": _string(1, 2000, "Advanced NSPredicate used alone (index may accompany it). Prefer the exact "
                                      "fields so text is encoded safely."),
    },
    "required": [],
    "additionalProperties": False,
    "minProperties": 1,
    "examples": [{"label": "Back", "type": "Button"}],
}

OBS = {"type": "string", "enum": ["none", "tree", "screenshot", "both"], "default": "none",
       "description": ("Output after the action, default none. Use tree or both when the next decision needs the "
                       "resulting page; screenshot returns an image. It is context for the next step, not proof "
                       "of this action; expect/verify control checking.")}

VERIFY = {"type": "boolean", "default": False,
          "description": ("Opt in to checking this operation's result. Default false runs it once and leaves "
                          "checking to the next observation or the final check. Never blindly repeat an uncertain "
                          "action.")}

REGION = {"type": "object",
          "description": ("Scroll rectangle in iPhone points (not screenshot pixels). Omit it for the central area, "
                          "or use the list's own bounds; with verify=true it must fit the screen and any native "
                          "alert or sheet."),
          "properties": {"x": _number("number", 0, 10000), "y": _number("number", 0, 10000),
                         "width": _number("number", 1, 10000), "height": _number("number", 1, 10000)},
          "required": ["x", "y", "width", "height"],
          "additionalProperties": False}

OBSERVATION_ID = _string(1, 64, "Optional id of an earlier observation in this session; it only checks that the "
                                "app and orientation are unchanged.")

DIRECTION = _enum(["up", "down", "left", "right"], "up", "Finger movement; up usually reveals later rows.")

# --- per-tool schemas -------------------------------------------------------------------------------

SCHEMAS = {}

SCHEMAS["iphone_doctor"] = _object({})

SCHEMAS["iphone_setup"] = _object({
    "action": _enum(["status", "discover", "configure", "fetch", "build", "start", "stop"],
                    description="status first; fetch, build and start run in the background and return job_id."),
    "job_id": _string(32, 32, "Job to report on (status) or stop (stop)."),
    "wait_seconds": _number("number", 0, 25, "status only: wait up to this many seconds for the job or service "
                                             "to change, instead of sleeping.", default=0),
    "udid": _string(8, 64, "configure: the iPhone's UDID from discover; omit to use the only connected iPhone."),
    "team_id": _string(10, 10, "configure: Apple development Team ID; omit to use the only team signed in to "
                               "Xcode."),
    "bundle_id": _string(3, 200, "configure: unique reverse-DNS ID for the helper app; omit to generate one."),
    "source_dir": _string(1, 4096, "configure (advanced): an existing WebDriverAgent checkout at the pinned "
                                   "commit."),
    "device_port": _number("integer", 1024, 65535, "configure: WebDriverAgent port on the iPhone, default 8100."),
    "mjpeg_port": _number("integer", 1024, 65535, "configure: screen-stream port on the iPhone, default 9100."),
    "app_store_country": _string(2, 2, "configure: default App Store country for iphone_apps, default in."),
    "network_mode": _enum(["usb_only", "allow_network"],
                          description="configure: usb_only (default) keeps the iPhone helper unreachable from "
                                      "Wi-Fi; allow_network only if the user agrees after USB-only failed."),
}, required=["action"])

SCHEMAS["iphone_ready"] = _object({
    "recover": _boolean(True, "Normal startup: true. Lets a persistent automation fault queue one bounded restart "
                              "of the service this plugin started. Use false only if the user forbids restarts or "
                              "wants a read-only check; a needed restart is then reported as "
                              "state=recovery_required."),
    "screenshot": _boolean(False, "Also attach a screenshot besides the screen tree."),
})

SCHEMAS["iphone_observe"] = _object({
    "mode": _enum(["tree", "screenshot", "both"], "tree",
                  "tree = accessibility nodes, screenshot = image only, both = nodes and image. Actions use "
                  "observe=..., this tool uses mode."),
    "include_invisible": _boolean(False, "Also list nodes outside the visible screen."),
    "max_nodes": _number("integer", 1, 300, "Most nodes returned, first in tree order; total_nodes and truncated "
                                            "describe the rest.", default=100),
    "expensive_visibility": _boolean(False, "Ask WebDriverAgent to compute real visibility (slow; rarely "
                                            "needed)."),
})

SCHEMAS["iphone_find"] = _object({
    "selector": SEL,
    "limit": _number("integer", 1, 30, "Most matches to describe.", default=10),
}, required=["selector"])

SCHEMAS["iphone_apps"] = _object({
    "query": _string(1, 100, "App name as the user says it, e.g. Notes or WhatsApp."),
    "country": _string(2, 2, "Two-letter App Store country; default from setup, usually in."),
    "source": _enum(["auto", "installed", "catalog", "apple"], "auto"),
    "limit": _number("integer", 1, 30, default=10),
}, required=["query"])

SCHEMAS["iphone_launch_app"] = _object({
    "bundle_id": _string(3, 200, "Exact bundle ID such as com.apple.mobilenotes, from iphone_apps; never "
                                 "guessed."),
    "verify": VERIFY,
    "expect": SEL,
    "observe": OBS,
}, required=["bundle_id"])

SCHEMAS["iphone_tap"] = _object({
    "selector": SEL,
    "x": _number("number", 0, 10000, "X in iPhone points; give y too."),
    "y": _number("number", 0, 10000, "Y in iPhone points; give x too."),
    "observation_id": OBSERVATION_ID,
    "expect": SEL,
    "observe": OBS,
})

SCHEMAS["iphone_swipe"] = _object({
    "direction": DIRECTION,
    "region": REGION,
    "observation_id": OBSERVATION_ID,
    "expect": SEL,
    "verify": _boolean(False, "false: one gesture, no checks. true: check once that stable content moved; on "
                              "failure a screenshot is returned before any other gesture."),
    "observe": OBS,
})

SCHEMAS["iphone_press_button"] = _object({
    "name": _enum(["home", "volumeup", "volumedown"]),
    "verify": VERIFY,
    "expect": SEL,
    "observe": OBS,
}, required=["name"])

SCHEMAS["iphone_type_text"] = _object({
    "selector": SEL,
    "text": _string(1, 10000, "The full text to type. Required unless continue_token is given."),
    "allow_newlines": _boolean(False, "Allow line breaks; only for a multi-line field you have seen, never a chat "
                                      "box whose Return sends."),
    "submit": _boolean(False, "Press Return once after typing (refused for multi-line editors). Sending needs the "
                              "user's go-ahead."),
    "replace": _boolean(True, "Clear the field first; false appends."),
    "verify": _boolean(False, "Read the text back exactly before any submit; stops on a mismatch. Password fields "
                              "are always refused."),
    "expect": SEL,
    "observe": OBS,
    "continue_token": _string(1, 64, "Token from a result with input_complete=false; pass it alone to type the "
                                     "rest."),
})

SCHEMAS["iphone_wait"] = _object({
    "selector": SEL,
    "timeout_seconds": _number("number", 0, 20, default=6),
}, required=["selector"])

SCHEMAS["iphone_scroll_find"] = _object({
    "selector": SEL,
    "direction": DIRECTION,
    "max_swipes": _number("integer", 0, 1, "0 only checks the current screen; 1 allows one swipe.", default=1),
}, required=["selector"])

SCHEMAS["iphone_collect_list"] = _object({
    "row_type": _string(1, 64, "Row element type, e.g. Cell or StaticText.", default="Cell"),
    "max_pages": _number("integer", 1, 10, default=6),
    "end_selector": SEL,
})

SCHEMAS["iphone_screen"] = _object({
    "action": _enum(["open", "pause", "resume", "status"], "open"),
    "open_browser": _boolean(True, "open only: also open the page in the default browser."),
})

SCHEMAS["iphone_metrics"] = _object({
    "reset": _boolean(False, "Return the totals, then start a new window."),
})

SCHEMAS["iphone_batch"] = _object({
    "steps": {"type": "array", "minItems": 1, "maxItems": 20,
              "items": {"oneOf": [_object({"op": {"type": "string", "const": op},
                                           "args": SCHEMAS[TOOL_PREFIX + op]}, required=["op", "args"])
                                  for op in BATCH_OPS]}},
}, required=["steps"])

# Keep SCHEMAS in the published tool order.
SCHEMAS = {name: SCHEMAS[name] for name in TOOL_NAMES}

# --- descriptions (DESIGN.md 11.3) ------------------------------------------------------------------

DESCRIPTIONS = {
    "iphone_doctor": (
        "Read-only check of this Mac and iPhone for iPhone Use: macOS, full Xcode, the USB connection, the chosen "
        "iPhone's pairing and Developer Mode, Apple signing teams, the pinned WebDriverAgent source and build, "
        "signing expiry, and whether the on-iPhone service answers. Changes nothing. Use it first during setup or "
        "when iphone_setup reports a missing prerequisite; next_steps lists what to do, in order."),
    "iphone_setup": (
        "Set up, start, stop and inspect the on-iPhone automation service (WebDriverAgent). Use action=status "
        "first: it returns configured, config, service, usb and a jobs ARRAY (find your job by id). fetch, build "
        "and start run in the background and return job_id at once; poll status with that job_id and wait_seconds "
        "(up to 25) instead of sleeping. A start job keeps running while the service serves: once "
        "service.ready=true call iphone_ready; never wait for it to succeed and never start twice. configure saves "
        "udid, team_id and bundle_id (omitted values are filled in when there is exactly one choice). stop affects "
        "only jobs this plugin started. Never uninstalls apps."),
    "iphone_ready": (
        "Check that the iPhone can be operated now: the service answers, the phone is unlocked, a session works and "
        "the screen can be read. Call it before the first phone action in each conversation (recover=true) and "
        "reuse its observation and preview.url. Only ready=true permits phone actions. An error service_unreachable "
        "or not_ready means setup is needed (follow error.recovery), not that the task failed. state=recovering or "
        "recovery_required are normal results with ready=false: follow recovery. recover=true may restart only a "
        "service this plugin started; it never starts a stopped one. Never repeats phone actions."),
    "iphone_observe": (
        "Read the current iPhone screen: accessibility nodes and/or a screenshot, with the screen size in iPhone "
        "points and an observation_id. Nodes: type without the XCUIElementType prefix; rect=[x,y,width,height] in "
        "points; an omitted name equals label, an omitted value repeats the text, omitted enabled/visible/"
        "in_viewport are true. A listed node is not proven tappable: headers and overlays can cover it. "
        "Screenshots are scaled: image pixels x image.pixel_to_point [x,y] = points. To check for one element use "
        "iphone_find or iphone_wait instead of a whole tree."),
    "iphone_find": (
        "Look up elements by selector without reading the whole screen tree. Returns matches in tree order with "
        "index, type, texts, rect and tap point; zero matches is not an error. This tool's selector documents the "
        "fields every selector accepts."),
    "iphone_apps": (
        "Find an app's real bundle ID by name: first the chosen iPhone's installed apps, then a bundled list of "
        "common apps, and only if nothing matched, Apple's App Store search for the given country (default in). A "
        "store result does not prove the app is installed; check installed_verified. Pass the bundle_id to "
        "iphone_launch_app; never guess IDs."),
    "iphone_launch_app": (
        "Bring an app to the front by its exact bundle ID (from iphone_apps). Activates it once without restarting "
        "it. verify=true polls up to 5 s until it is in front; expect checks for an element on the expected page; "
        "ask for observe=tree or both when the next step needs the screen. Never repeat an uncertain launch "
        "blindly."),
    "iphone_tap": (
        "Tap the element a selector resolves to (only after on-screen and tappable checks), or tap x/y in iPhone "
        "points (observation_id is optional and only checks app and orientation). If the selector fails nothing is "
        "tapped and the result carries a screenshot and tap points: tap by x/y next instead of trying other "
        "selectors. Runs once; expect opts into a check; ask for observe=tree or both when the next step needs the "
        "new page."),
    "iphone_swipe": (
        "One swipe gesture; direction is the finger movement (up usually reveals later rows). By default "
        "(verify=false, observe=none) it sends one gesture with no checks. verify=true checks once that stable "
        "content moved; on no progress or a changed screen it returns a screenshot without another gesture. No "
        "progress does not prove a list is empty or finished. region is in iPhone points; omit it for the central "
        "area."),
    "iphone_press_button": (
        "Press Home (goes to the Home Screen) or volume up/down, once. verify=true for Home checks that the Home "
        "Screen is in front within 2 s; expect can check a page. Volume effects cannot be verified."),
    "iphone_type_text": (
        "Type the full intended text (any language or emoji) into an editable, non-password field. Omit selector to "
        "type into the field that already has keyboard focus: if a selector failed, tap the field by x/y first, "
        "then type. Send the whole text in one call; long text is typed in parts, and a result with "
        "input_complete=false returns continue_token: call again with only continue_token. replace=true (default) "
        "clears the field first. verify=true reads the text back exactly before any submit. Line breaks need "
        "allow_newlines=true and a multi-line field. submit=true presses Return once and defaults to false. Never "
        "repeats uncertain input."),
    "iphone_wait": (
        "Wait up to timeout_seconds (default 6, at most 20) until an element matching the selector exists. Presence "
        "is a screen check, not proof that a business step succeeded."),
    "iphone_batch": (
        "Run up to 20 known steps (tap, swipe, type_text, launch_app, press_button, wait, observe, scroll_find) in "
        "one call; every step is validated before any runs. Routine steps continue without checks. It stops at an "
        "error, an uncertain action, a submit without expect, unfinished long text (input_continues) or the time "
        "budget; then continue from resume_at and never repeat completed steps. Give the last step observe=tree or "
        "both when the next decision needs the screen. Do not batch speculative repeated swipes."),
    "iphone_scroll_find": (
        "Find a tappable element, swiping at most once (max_swipes=0 only checks). Returns at once if it is already "
        "on screen. Several separate matches or a covering popup stop before any swipe; an unresolved search "
        "returns a screenshot. Look at it before deciding to swipe again."),
    "iphone_collect_list": (
        "Collect and de-duplicate list rows (row_type, default Cell) over up to max_pages pages, swiping once per "
        "page. Returns rows, stop_reason and coverage evidence; complete is always false: reconcile counts, dates "
        "and totals before saying the list is complete."),
    "iphone_screen": (
        "Live view of the iPhone screen for the USER, in their web browser (a private page on this Mac). "
        "action=open starts it and opens the browser (open_browser=false only returns the URL); share the URL with "
        "the user once. pause hides the picture before the user types a password or uses Face ID; resume after "
        "they confirm they are done; status reports the URL and pause state. It never acts on the phone and is "
        "never evidence for you."),
    "iphone_metrics": (
        "Timing and size totals for this session (requests to the iPhone service, tool time, response sizes), "
        "without any text, app data or images. reset=true starts a new window. For diagnosing slowness only."),
}

INSTRUCTIONS = (
    "iPhone Use operates the user's real iPhone over USB; use these tools for anything the user wants done on "
    "their iPhone. "
    "Load the iphone-use skill for phone tasks and iphone-use-setup for installation or connection problems; if "
    "tools seem missing, search \"iphone\" with ToolSearch. "
    "1) First phone step in a conversation: iphone_ready(recover=true). Only ready=true permits phone actions; "
    "reuse its observation, then call iphone_screen(action=open) once so the user can watch. "
    "Error service_unreachable or not_ready means setup, not failure: iphone_setup(action=status), reuse an active "
    "job or start once, poll it with wait_seconds until service.ready=true, then iphone_ready. state=recovering: "
    "poll its job until phase=serving, then iphone_ready. "
    "2) Coordinates are iPhone points; rect=[x,y,width,height]; screenshot pixels x image.pixel_to_point = points. "
    "3) Act optimistically: verify=false and observe=none are defaults; ask for observe=tree or both when the next "
    "step needs the new page. Chain known steps with iphone_batch; continue from resume_at. "
    "4) Every result has ok; if ok=false read error. Selector, focus, scroll and unexpected-page failures attach a "
    "screenshot: look at it first, then tap by x/y instead of trying other selectors. Never repeat an action that "
    "may have run (uncertain=true, or action_executed=true with action_complete=false); look at the screen first. "
    "5) Long text: send it whole; if input_complete=false call iphone_type_text with only continue_token. "
    "6) Never ask for or type passwords, PINs, codes or Face ID: call iphone_screen(action=pause), ask the user "
    "with AskUserQuestion to finish on the phone (first option \"Done, continue\"), wait for the answer, then "
    "iphone_screen(action=resume) and observe again. phone_locked: ask the user to unlock, then iphone_ready. "
    "7) Confirm before paying, transferring, trading, deleting or sending anything not explicitly requested. "
    "Verify key results before reporting completion. The live preview is for the user, never evidence."
)

# --- annotations (DESIGN.md 11.1) -------------------------------------------------------------------

# name: (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
ANNOTATIONS = {
    "iphone_doctor": ("iPhone: Diagnose setup", True, False, True, False),
    "iphone_setup": ("iPhone: Set up service", False, True, False, False),
    "iphone_ready": ("iPhone: Check ready", False, False, False, False),
    "iphone_observe": ("iPhone: Read screen", True, False, True, False),
    "iphone_find": ("iPhone: Find element", True, False, True, False),
    "iphone_apps": ("iPhone: Find app", True, False, True, True),
    "iphone_launch_app": ("iPhone: Open app", False, True, False, False),
    "iphone_tap": ("iPhone: Tap", False, True, False, False),
    "iphone_swipe": ("iPhone: Swipe", False, True, False, False),
    "iphone_press_button": ("iPhone: Press button", False, True, False, False),
    "iphone_type_text": ("iPhone: Type text", False, True, False, False),
    "iphone_wait": ("iPhone: Wait for element", True, False, True, False),
    "iphone_batch": ("iPhone: Run steps", False, True, False, False),
    "iphone_scroll_find": ("iPhone: Scroll to find", False, True, False, False),
    "iphone_collect_list": ("iPhone: Collect list", False, True, False, False),
    "iphone_screen": ("iPhone: Live screen", False, False, True, False),
    "iphone_metrics": ("iPhone: Timing stats", True, False, True, False),
}
ALWAYS_LOAD = ("iphone_ready",)

# --- error codes the model can see (DESIGN.md 11.6) -------------------------------------------------

MODEL_ERROR_CODES = frozenset((
    "service_unreachable", "action_uncertain", "response_too_large", "invalid_response", "http_error",
    "invalid_argument", "invalid_selector", "unknown_tool", "newline_requires_intent", "newline_unsafe",
    "submit_unsafe", "stale_observation", "foreground_unavailable", "no_such_element", "ambiguous_target",
    "occluded_target", "offscreen_target", "not_editable", "no_focused_field", "search_exhausted",
    "no_scroll_progress", "scroll_context_changed", "modal_requires_region", "blocked_scroll_region",
    "postcondition_failed", "input_mismatch", "input_continuation_expired", "device_busy", "phone_locked",
    "not_ready", "mirroring_conflict", "recovery_not_started", "internal_error", "config_invalid",
    "config_choice_required", "prerequisite_missing", "job_conflict", "unknown_job", "state_dir_unsafe",
    "setup_failed", "app_lookup_unavailable",
))
RAW_WDA_ERRORS = ("invalid session id", "no such element", "stale element reference", "element not interactable",
                  "element click intercepted", "invalid element state", "unknown error", "invalid argument")
TOOLBAR_ERROR_CODES = frozenset(("preview_paused", "clipboard_unavailable"))

# --- publication (DESIGN.md 11.2 "Published schemas") ----------------------------------------------

DOC_KEYS = ("description", "examples")


def undocumented(value):
    """A copy of a schema without description/examples keys, at every depth."""
    if isinstance(value, dict):
        return {key: undocumented(item) for key, item in value.items() if key not in DOC_KEYS}
    if isinstance(value, list):
        return [undocumented(item) for item in value]
    return value


SEL_BRIEF = dict(undocumented(SEL), description="Selector; the fields are documented on iphone_find.selector.")
OBS_BRIEF = dict(undocumented(OBS), description="Output after the action for the next decision; default none.")
SHARED_BLOCKS = (("selector", SEL), ("observe", OBS))


def _count_blocks(value, counts):
    for key, block in SHARED_BLOCKS:
        if value == block:
            counts[key] += 1
            return
    if isinstance(value, dict):
        for item in value.values():
            _count_blocks(item, counts)
    elif isinstance(value, list):
        for item in value:
            _count_blocks(item, counts)


def published_schema(name):
    """The model-facing input schema of a tool (a new object every call)."""
    source = SCHEMAS[name]
    if name == "iphone_find":
        return copy.deepcopy(source)
    brief = name == "iphone_batch"
    counts = {key: 0 for key, _ in SHARED_BLOCKS}
    _count_blocks(source, counts)
    shared = {key for key, uses in counts.items() if uses > 1}
    forms = {"selector": undocumented(SEL) if brief else SEL_BRIEF,
             "observe": undocumented(OBS) if brief else OBS_BRIEF}

    def publish(value):
        for key, block in SHARED_BLOCKS:
            if value == block:
                return {"$ref": "#/$defs/" + key} if key in shared else copy.deepcopy(forms[key])
        if isinstance(value, dict):
            return {key: publish(item) for key, item in value.items() if not (brief and key in DOC_KEYS)}
        if isinstance(value, list):
            return [publish(item) for item in value]
        return value

    schema = publish(source)
    if shared:
        schema["$defs"] = {key: copy.deepcopy(forms[key]) for key in sorted(shared)}
    return schema


def tool_entry(name):
    """One tools/list entry."""
    title, read_only, destructive, idempotent, open_world = ANNOTATIONS[name]
    entry = {
        "name": name,
        "title": title,
        "description": DESCRIPTIONS[name],
        "inputSchema": published_schema(name),
        "annotations": {"title": title, "readOnlyHint": read_only, "destructiveHint": destructive,
                        "idempotentHint": idempotent, "openWorldHint": open_world},
    }
    if name in ALWAYS_LOAD:
        entry["_meta"] = {"anthropic/alwaysLoad": True}
    return entry


TOOLS = [tool_entry(name) for name in TOOL_NAMES]

# --- structural validation (DESIGN.md 11.4) --------------------------------------------------------

SUPPORTED_KEYWORDS = frozenset(("type", "properties", "required", "additionalProperties", "minProperties", "enum",
                                "const", "minimum", "maximum", "minLength", "maxLength", "items", "minItems",
                                "maxItems", "oneOf"))
IGNORED_KEYWORDS = frozenset(("default", "description", "examples", "title"))
UNKNOWN_FIELDS_STEP = ("Correct these fields using the tool schema, then call once; nothing was done on the "
                       "phone.")

_TYPE_CHECKS = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "boolean": lambda value: isinstance(value, bool),
    "number": lambda value: (isinstance(value, (int, float)) and not isinstance(value, bool)
                             and math.isfinite(value)),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
}


def _argument_error(message, path, **details):
    full = {"action_executed": False, "argument_path": path}
    full.update(details)
    return ToolError("invalid_argument", message, details=full)


def _step_branch(candidate):
    """The const op of a batch-step branch, or None for other oneOf branches."""
    op = candidate.get("properties", {}).get("op", {}) if isinstance(candidate, dict) else {}
    return op.get("const") if isinstance(op, dict) else None


def _matches(value, schema, path):
    try:
        validate(value, schema, path)
    except ToolError:
        return False
    return True


def validate(value, schema, path="arguments"):
    """Check value against a SCHEMAS-style schema; raise ToolError("invalid_argument") on the first problem."""
    if "oneOf" in schema:
        candidates = schema["oneOf"]
        step_union = all(_step_branch(candidate) is not None for candidate in candidates)
        if isinstance(value, dict) and "op" in value:
            chosen = [candidate for candidate in candidates if _step_branch(candidate) == value["op"]]
            if len(chosen) == 1:
                validate(value, chosen[0], path)
                return
        if sum(1 for candidate in candidates if _matches(value, candidate, path)) != 1:
            if step_union:
                raise _argument_error("`%s` must match exactly one allowed step schema." % path, path)
            raise _argument_error("`%s` must match exactly one allowed form." % path, path)
        return
    kind = schema.get("type")
    if kind is not None and not _TYPE_CHECKS[kind](value):
        raise _argument_error("`%s` must be %s." % (path, kind), path)
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        raise _argument_error("Invalid `%s` option." % path, path)
    if "enum" in schema and not any(value == option and type(value) is type(option) for option in schema["enum"]):
        raise _argument_error("Invalid `%s` option." % path, path)
    if kind == "object":
        _validate_object(value, schema, path)
    elif kind in ("number", "integer"):
        if not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            raise _argument_error("`%s` is out of range." % path, path)
    elif kind == "string":
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 100000):
            raise _argument_error("`%s` has invalid length." % path, path)
    elif kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 100000):
            raise _argument_error("`%s` has invalid number of items." % path, path)
        items = schema.get("items")
        if items is not None:
            for index, item in enumerate(value):
                validate(item, items, "%s[%d]" % (path, index))


def _validate_object(value, schema, path):
    properties = schema.get("properties", {})
    if schema.get("additionalProperties") is False:
        unknown = sorted(str(key) for key in value if key not in properties)
        if unknown:
            raise _argument_error(
                "Unknown fields in `%s`: %s. Use only the declared fields." % (path, ", ".join(unknown)), path,
                unknown_fields=unknown, allowed_fields=sorted(properties),
                recovery={"next_step": UNKNOWN_FIELDS_STEP, "replay_action": False})
    missing = sorted(key for key in schema.get("required", []) if key not in value)
    if missing:
        raise _argument_error("Missing required fields in `%s`: %s." % (path, ", ".join(missing)), path)
    if len(value) < schema.get("minProperties", 0):
        raise _argument_error("`%s` cannot be empty." % path, path)
    for key, item in value.items():
        if key in properties:
            validate(item, properties[key], "%s.%s" % (path, key))


# --- semantic validation ---------------------------------------------------------------------------

SELECTOR_ARGUMENTS = ("selector", "expect", "end_selector")
TAP_FORM_MESSAGE = "iphone_tap needs either selector or both x and y; observation_id is optional."
CONTINUE_ALONE_MESSAGE = "continue_token resumes the earlier call with its own options; pass it alone."
TEXT_REQUIRED_MESSAGE = "iphone_type_text needs text, or continue_token alone."
CONTROL_CHARACTERS_MESSAGE = "text cannot contain control characters other than line breaks."
NEWLINE_INTENT_MESSAGE = ("This text contains line breaks, which can send a message. Use allow_newlines only for a "
                          "multi-line field you have seen.")
BUNDLE_MESSAGE = "Use the app's exact bundle ID (look it up with iphone_apps)."
COUNTRY_MESSAGE = "country must be a two-letter App Store country code, such as in or us."


def _control_character(text):
    return any((ord(ch) < 32 and ch not in "\n\r") or ord(ch) == 127 for ch in text)


def validate_semantics(name, args, path="arguments"):
    """Checks the schema cannot express; run after validate() and before any device I/O.

    For iphone_batch every step is checked, so a bad later step means no phone request at all.
    """
    tool = tool_name(name)
    for key in SELECTOR_ARGUMENTS:
        if key in args:
            try:
                predicate(args[key])
            except ToolError as exc:
                exc.details.setdefault("action_executed", False)
                exc.details.setdefault("argument_path", "%s.%s" % (path, key))
                raise
    if tool == "iphone_tap":
        has_selector = "selector" in args
        has_x, has_y = "x" in args, "y" in args
        if not ((has_selector and not has_x and not has_y) or (not has_selector and has_x and has_y)):
            raise _argument_error(TAP_FORM_MESSAGE, path)
    elif tool == "iphone_type_text":
        if "continue_token" in args:
            if len(args) != 1:
                raise _argument_error(CONTINUE_ALONE_MESSAGE, path)
            return
        if "text" not in args:
            raise _argument_error(TEXT_REQUIRED_MESSAGE, path)
        text = args["text"]
        if _control_character(text):
            raise _argument_error(CONTROL_CHARACTERS_MESSAGE, path + ".text")
        if ("\n" in text or "\r" in text) and args.get("allow_newlines") is not True:
            raise ToolError("newline_requires_intent", NEWLINE_INTENT_MESSAGE,
                            details={"action_executed": False, "argument_path": path + ".text"})
    elif tool == "iphone_launch_app":
        if not BUNDLE_RE.fullmatch(args.get("bundle_id", "")):
            raise _argument_error(BUNDLE_MESSAGE, path + ".bundle_id")
    elif tool == "iphone_apps":
        if "country" in args and not COUNTRY_RE.fullmatch(args["country"]):
            raise _argument_error(COUNTRY_MESSAGE, path + ".country")
    elif tool == "iphone_batch":
        for index, step in enumerate(args.get("steps", [])):
            validate_semantics(step["op"], step["args"], "%s.steps[%d].args" % (path, index))


def check_arguments(name, args):
    """validate + validate_semantics for one tool call (name must be in SCHEMAS)."""
    validate(args, SCHEMAS[name])
    validate_semantics(name, args)
