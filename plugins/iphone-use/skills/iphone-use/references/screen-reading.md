# Reading the screen, selectors and coordinates

## Observation strategy

- **Known target or known path: no observation.** For a known, unique target or a known navigation path, keep
  the default `observe=none`. Steps can run back to back, or together in `iphone_batch`.
- **Unknown next page: observe inside the action.** When the next step must identify an unknown page, choose a
  region or read content, set `observe=tree`, `observe=screenshot` or `observe=both` on the action itself. Use
  that `observation` both to plan the next step and to judge whether the action worked. Do not act with
  `observe=none` and then call `iphone_observe` separately: that costs an extra round.
- **Standalone reads** use `iphone_observe(mode=...)`. `mode` belongs to `iphone_observe`; `observe` belongs to
  actions; `none` is not a standalone mode.
- **What an action's observation is.** Context for the next step, not proof of the action. `expect` and
  `verify=true` are the checks.
- Post-action tree reads wait briefly for animations to settle, so you do not get a mix of two pages.

## Tree format

- Each node keeps one copy of each fact:
  - `type` has no `XCUIElementType` prefix (`Button`, `Cell`, `StaticText`, `TextField`, ...).
  - `rect` is `[x, y, width, height]` in iPhone points.
  - A missing `name` means it equals `label`; a missing `value` means it repeats the text.
  - Missing `enabled`, `visible` or `in_viewport` mean true.
- `total_nodes` and `truncated` describe what was left out; `max_nodes` (default 100, at most 300) returns more.
- Keep the defaults `include_invisible=false`, `max_nodes=100` and `expensive_visibility=false`.
- To check for one element, use `iphone_find` (matches with tap points) or `iphone_wait` (wait until it
  exists), not the whole tree.
- A truncated tree, or a node marked as on screen, proves neither that the content is complete nor that the
  node can be tapped. Fixed headers, popups and overlays can cover it. A listed node is not proven tappable.
- An empty tree comes with a warning. Look at a screenshot: it may be a lock screen, iPhone Mirroring, a loading
  page or custom-drawn content.

## Screenshots and pixel_to_point

- Take one only when custom-drawn content, covering popups or missing labels need a visual judgment.
- The screenshot arrives as an image in the same result, already scaled for reading (about 720 x 1568 pixels).
- Convert image pixels to iPhone points with `image.pixel_to_point`:
  `x = pixel_x * pixel_to_point[0]`, `y = pixel_y * pixel_to_point[1]`. Pass those points to `iphone_tap`.
  - Never scale by the phone's native resolution or by the Mac screen.
  - Never pass screenshot pixels or positions on the preview page as x/y.
- `mode=screenshot` skips the tree; `mode=both` returns tree and image.
- The scaled image is at `image.path`; the full-size original has the same name ending in `.png`. If you cannot
  see an image that a result mentions, open `image.path` with the Read tool.
- Some apps react to screenshots (for example by offering to share). Handle what is on screen; do not loop on
  repeated screenshots.
- The live preview page is for the user. It never replaces you looking at a tool's image.

## Screenshot fallback for unusual screens

The screenshot is the general fallback when the screen does not behave as expected. It is attached
automatically to these failures (except on password fields):
- a selector or focus failure (`no_such_element`, `ambiguous_target`, `occluded_target`, `offscreen_target`,
  `not_editable`, `no_focused_field`);
- no tappable target after a scroll search (`search_exhausted`);
- no scroll progress, a changed scroll context, or a blocked region (`no_scroll_progress`,
  `scroll_context_changed`, `modal_requires_region`, `blocked_scroll_region`);
- a typed-text mismatch or an expected page that did not appear (`input_mismatch`, `postcondition_failed`).

Take a screenshot yourself (`iphone_observe(mode=screenshot)`) when a tree is truncated in the place you need,
a coordinate tap clearly had no effect, or the page does not match what you expected.

**Look first, then act.** Look at the screenshot already in the result before deciding the next action. If
none is attached (`observation_error` is set), take one with `iphone_observe(mode=screenshot)`.
- Do not first re-read the whole tree, try another label spelling, add more swipes, or retry unchanged.
- A normal `verified=false` is not a problem and needs no screenshot.

**What to read from it:** the current page; whether the first and last rows moved; an end-of-list marker or
blank space; popups and fixed headers; the real scrollable area.

**Stopping and direction.** Once the target or the end of the needed range is visible, stop searching. If the
screen no longer moves, deal with the end of the list or the covering element first, then decide whether another
region or direction is needed. `direction` is always the finger's movement: `up` usually reveals content below.

**Tapping from a screenshot.** `tap_point` and a candidate's `tap` are where the element is, in iPhone points.
They do not prove it can be tapped: coupons, ads, menus or sign-in overlays can cover it. Find the visible close
or cancel button in the screenshot, deal with the overlay, then tap the target.

**Typing from a screenshot.** Tap the input field you can see in the screenshot, then call `iphone_type_text`
with the text and no selector.
- `no_focused_field` means nothing was typed: the tap may have hit an overlay or the wrong spot. Pick a new point
  from the current screenshot; do not repeat the same point.

**Target off-screen.** Swipe toward it first, then tap using the next screenshot. If a wait or a scroll search
fails, continue from the real screen; do not loop on the same label.

**Scope of the fallback.** It is for screen-location problems only.
- Argument errors: fix the arguments per the schema.
- Channel faults: run `iphone_ready` (see [startup](startup.md)).
- Lock or sign-in: the user completes it (see [authentication](authentication.md)).
- Unclear whether an action took effect: read the real state first; never repeat typing, a send, an order or a
  whole batch.
- Routine popups that a screenshot can resolve are yours to handle; do not hand the task back to the user early.

**Hints in the result.** Failure results carry `error.recovery` with `visual_check_required=true`,
`replay_action=false`, `use` (`coordinates` or `screenshot`), `next_tool` and a `next_step` sentence. If the
capture itself failed, `observation_error` is set and `next_tool` is `iphone_observe` with
`{"mode": "screenshot"}`. Password-field errors never carry a screenshot.

## Selectors

- Prefer a selector. Copy `label`, `name`, `value` or `type` verbatim from current nodes; `enabled` may be
  added.
- `label_contains` is for long labels, or labels with changing times or numbers. It is case-sensitive.
- `predicate` stands alone (`index` may accompany it). The exact fields encode quotes, backslashes and line
  breaks safely, which is why they are preferred.
- `rect`, `visible` and `in_viewport` are observation fields, not selector fields.
- `value` is the element's current value, not the text to type. Leave out values that change by themselves.
  `type` is an element type such as `Button`, never a bundle ID.

## Several matches

- Matches nested at one place (a cell and its own text), or where only one match is on screen, resolve to that
  element automatically. The result's `target` explains the choice (`only_match_on_screen` or
  `innermost_of_nested_matches`).
- Several separate matches return `ambiguous_target` with `candidates` (`index`, type, texts, `rect`, a `tap`
  point and `hittable`). Nothing was tapped. Tap the intended candidate's `tap` point by x/y, or repeat the same
  selector with its `index`.
- Do not pick the first one arbitrarily, and do not observe again just for this.

## Coordinates and observation_id

- If the selector fails or the labels are not enough, tap x/y in iPhone points.
- `observation_id` is optional. If given, it must come from this session, and it only checks that the app in
  front and the screen size and orientation are unchanged. It does not compare content, pixels or age.
  Changing text, numbers or images never invalidate it.
- A mismatch returns `stale_observation` and nothing is tapped: locate the target again from fresh
  information.
- Do not read the tree or take a screenshot again when the information you have is enough.
- After a page change, a hand-over to the user, or a rotation, locate targets again from current information.
- Selector taps are checked first: off-screen gives `offscreen_target`, covered gives `occluded_target` (with
  `tap_point`). In both cases nothing was sent and a screenshot is attached.
