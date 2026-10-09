# Swiping, scroll search, list collection and batches

## iphone_swipe

- **Direction** is the finger's movement: `up` usually shows later content, `down` earlier content.
- **Default** (`verify=false`, `observe=none`): exactly one gesture, no checks.
- **Region.** Pass a known list `region` in iPhone points (`{"x", "y", "width", "height"}`), for example the
  list's own `rect`. Without one, the central part of the screen is used (70% of the width, 50% of the height).
  Neither an `observation_id` nor a tree is required.
- **Did it move?** When the next step reads the list anyway, use that read to judge the movement. An unverified
  result does not mean it did not move. If it clearly did not move, look at a screenshot for the list's real
  position, the end of the list, an overlay or the wrong region.
- **`verify=true`** checks that one gesture: progress means a stable item (one with a unique label) moved in the
  requested direction. Changing numbers or rotating banners do not count. On no progress or a changed screen it
  returns a screenshot, and it never makes a second gesture.

### Swipe errors

- **`no_scroll_progress`:** the gesture ran, but movement was not proven. It does **not** prove that the list is
  empty or finished.
- **`scroll_context_changed`:** the screen size or a native popup changed after the gesture. The gesture ran; do
  not treat it as not executed or repeat it blindly.
- **`modal_requires_region`** and **`blocked_scroll_region`:** a native alert or sheet is open and the swipe
  region was not explicit and inside it. Nothing ran. Handle the popup, or give a region inside the intended
  list.
- **A screenshot is always attached** to these, even with `observe=none` or `observe=tree`. Use it.
- **Custom panels.** Half-screen panels drawn by the app may not appear as a native alert or sheet. Judge from
  the screenshot; a tree that still lists background buttons does not mean nothing covers them.
- **Capture failure.** If the screenshot itself failed (`observation_error`), keep the evidence from the error,
  take one separate `iphone_observe(mode=screenshot)`, and do not continue acting blindly.

## iphone_scroll_find

- If the target is already tappable on screen, it returns at once (`swipes=0`).
- A covering popup or several separate matches stop it before any swipe, with a screenshot.
- Each call swipes **at most once** (`max_swipes` is 0 or 1; 0 only checks the current screen). If there is
  still no tappable target after the swipe, it fails with `search_exhausted` and a screenshot. Look at it before
  deciding whether to swipe again.
- On success the result has `target` with a `tap` point and `hittable=true`; `action_executed=true` when it
  swiped. Once found, carry on; do not search again for the same item.

## Searching for something whose position is unknown

- Do not pack several swipes in the same direction into one batch.
- Swipe one step and read what the next decision needs. If the tree is truncated in the area you need, or the
  page did not move, take a screenshot before deciding to continue.
- Known short paths may still be batched. Stop scrolling as soon as the needed range or the end of the list is
  visible.

## iphone_collect_list

- **Bounds:** `iphone_collect_list(row_type="Cell", max_pages=6)`; at most 10 pages. Use `row_type` such as
  `StaticText` when the rows are not cells.
- **Paging:** it reads the first page, then swipes once per page and reads the new page.
- **Returns** `rows`, `pages` (one entry per page with `rows_seen` and `truncated`), `stop_reason`
  (`page_budget`, `explicit_end_marker` or `no_progress`), `end_marker_seen`, `coverage_verified` and
  `limitations`. **`complete` is always false.**
- **De-duplication.** Rows with the same type, name, label and value are merged, so genuinely identical records
  can collapse into one. At most 300 rows are returned (`rows_truncated=true` when cut).
- **`end_selector`** names an end-of-list marker (for example `{"label_contains": "No more"}`); seeing it is
  coverage evidence.
- **Reconcile at the end** against what the user asked for: date range, count, totals, missing fields. Reaching
  the page limit or no progress never proves the list is complete.
- **Details.** If the list rows do not show enough, open the detail pages and read them. The same read that
  shows the details also confirms you are on the right page.
- **A repeated page** stops collection with `stop_reason=no_progress`, a screenshot and `recovery`. Keep the rows
  already collected and state the coverage limits.
- **Scope.** It is a page collector, not a model of any app. Keep the first and last page boundaries, the stop
  reason, the merge rule and any missing fields in mind when you report.

## iphone_batch

- **Purpose.** Combine known short paths into one call, up to **20 steps**. Ops: tap, swipe, type_text,
  launch_app, press_button, wait, observe, scroll_find. No list collection and no nesting.
- **Checked first.** Every step is validated before any runs. A schema error means nothing ran
  (`action_executed=false`), with `argument_path` such as `arguments.steps[1].args`.
- **Optimistic.** Routine taps, launches, Home, typing and swipes need no `expect`. An ordinary
  `verified=false` does not block later steps.
- **Where to observe.** Give the last step (or the step whose next page you need) `observe=tree` or
  `observe=both`.
- **Never mix an unrequested send into navigation.** Split batches where unknown pages, sign-in or popups need
  fresh information.

### When a batch stops

Every batch result has `complete`, `completed_steps`, `results`, `stopped_at`, `resume_at`, `stop_reason` and
`next_step`.

| stop_reason | What happened | What to do |
| --- | --- | --- |
| an error code (for example `no_such_element`) | Step `stopped_at` failed; `error` holds the details and usually a screenshot. That step may be partly done. | Look at the screen first, finish only that step if needed, then send the steps from `resume_at` onward in a new call. |
| `input_continues` | Step `stopped_at` typed only part of a long text. | Finish it with `iphone_type_text(continue_token=...)`, then send the steps from `resume_at` onward. |
| `submission_requires_verification` | Step `stopped_at` submitted something without a check. | Check the result of that send first, then continue from `resume_at`. |
| `time_budget` | The call's time budget (about 60 seconds) ran out before step `stopped_at`. | Send the steps from `resume_at` onward in a new call. |

- `completed_steps` counts steps that ran to completion. Completed steps were executed and must not be
  repeated. **Never replay the whole batch.**
- A batch error envelope has `ok=false` and the progress fields next to `error`.
