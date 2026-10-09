# Tool reference

The plugin `iphone-use` runs one MCP server named `iphone`. Claude Code shows each tool as
`mcp__plugin_iphone-use_iphone__iphone_<name>`; the skills use the short name, for example `iphone_tap`.
If the tools are not in your tool list, load them with ToolSearch (query `iphone`).

## The 17 tools

| Tool | Full name in Claude Code | What it does | Key arguments (default) |
| --- | --- | --- | --- |
| `iphone_doctor` | `mcp__plugin_iphone-use_iphone__iphone_doctor` | Read-only check of the Mac, Xcode, USB, the chosen iPhone and the helper. `next_steps` lists what to do, in order. | none |
| `iphone_setup` | `mcp__plugin_iphone-use_iphone__iphone_setup` | Set up, start, stop and inspect the iPhone helper. fetch, build and start run in the background and return `job_id`. | `action` (required): status, discover, configure, fetch, build, start or stop; `job_id`; `wait_seconds` 0-25 (0, status only); configure fields `udid`, `team_id`, `bundle_id`, `source_dir`, `device_port`, `mjpeg_port`, `app_store_country`, `network_mode` |
| `iphone_ready` | `mcp__plugin_iphone-use_iphone__iphone_ready` | Check that the iPhone can be operated now. Returns proof, an observation and the preview link. | `recover` (true); `screenshot` (false) |
| `iphone_observe` | `mcp__plugin_iphone-use_iphone__iphone_observe` | Read the current screen: nodes, a screenshot, or both. | `mode` tree, screenshot or both (tree); `max_nodes` 1-300 (100); `include_invisible` (false); `expensive_visibility` (false) |
| `iphone_find` | `mcp__plugin_iphone-use_iphone__iphone_find` | Look up elements by selector without reading the whole tree. Zero matches is not an error. Its schema documents the selector fields. | `selector` (required); `limit` 1-30 (10) |
| `iphone_apps` | `mcp__plugin_iphone-use_iphone__iphone_apps` | Find an app's real bundle ID by name. | `query` (required); `source` auto, installed, catalog or apple (auto); `country` (from setup, usually in); `limit` 1-30 (10) |
| `iphone_launch_app` | `mcp__plugin_iphone-use_iphone__iphone_launch_app` | Bring an app to the front by its exact bundle ID, once. | `bundle_id` (required); `verify` (false); `expect`; `observe` (none) |
| `iphone_tap` | `mcp__plugin_iphone-use_iphone__iphone_tap` | Tap the element a selector resolves to, or tap x/y in iPhone points. | `selector`, or both `x` and `y`; `observation_id`; `expect`; `observe` (none) |
| `iphone_swipe` | `mcp__plugin_iphone-use_iphone__iphone_swipe` | One swipe gesture; direction is the finger's movement. | `direction` up, down, left or right (up); `region`; `verify` (false); `observation_id`; `expect`; `observe` (none) |
| `iphone_press_button` | `mcp__plugin_iphone-use_iphone__iphone_press_button` | Press Home or volume up/down, once. | `name` (required): home, volumeup or volumedown; `verify` (false); `expect`; `observe` (none) |
| `iphone_type_text` | `mcp__plugin_iphone-use_iphone__iphone_type_text` | Type text into an editable, non-password field. | `text`; `selector` (omit to type into the focused field); `replace` (true); `allow_newlines` (false); `submit` (false); `verify` (false); `expect`; `observe` (none); `continue_token` (pass it alone) |
| `iphone_wait` | `mcp__plugin_iphone-use_iphone__iphone_wait` | Wait until an element matching the selector exists. | `selector` (required); `timeout_seconds` 0-20 (6) |
| `iphone_batch` | `mcp__plugin_iphone-use_iphone__iphone_batch` | Run up to 20 known steps in one call; every step is checked before any runs. | `steps` (required): a list of `{"op": ..., "args": {...}}` with op tap, swipe, type_text, launch_app, press_button, wait, observe or scroll_find |
| `iphone_scroll_find` | `mcp__plugin_iphone-use_iphone__iphone_scroll_find` | Find a tappable element, swiping at most once. | `selector` (required); `direction` (up); `max_swipes` 0 or 1 (1) |
| `iphone_collect_list` | `mcp__plugin_iphone-use_iphone__iphone_collect_list` | Collect and de-duplicate list rows over several pages. | `row_type` (Cell); `max_pages` 1-10 (6); `end_selector` |
| `iphone_screen` | `mcp__plugin_iphone-use_iphone__iphone_screen` | The live preview page for the user, in their web browser. Never acts on the phone. | `action` open, pause, resume or status (open); `open_browser` (true) |
| `iphone_metrics` | `mcp__plugin_iphone-use_iphone__iphone_metrics` | Timing and size totals for this session, for diagnosing slowness only. | `reset` (false) |

Notes:
- `observe` on an action is the output after the action: none, tree, screenshot or both. It is context for the
  next step, not proof of the action.
- `expect` is a selector that must appear after the action (a check you opt into). `verify=true` opts into the
  tool's own check (for example "the app is in front" or "the list moved").
- `network_mode` for configure is `usb_only` (the default, the helper is reachable only over the USB cable) or
  `allow_network`. Use `allow_network` only after the user agreed (see the iphone-use-setup skill).
- In `iphone_batch`, each step's `args` are exactly the arguments of the matching tool.

## Selectors

A selector is an object with one or more of these fields; they are combined with AND.

| Field | Meaning |
| --- | --- |
| `label` | Exact accessibility label, copied from fresh nodes. Real line breaks and punctuation are kept. |
| `label_contains` | Case-sensitive part of the label, for long or changing labels. |
| `name` | Exact accessibility identifier. Nodes omit `name` when it equals `label`. |
| `value` | Exact current value of the element (not the text to type). Leave out values that change by themselves. |
| `type` | Element type as nodes show it, for example `Button`, `Cell`, `TextField`. Not a bundle ID. |
| `enabled` | true or false. It does not prove the element can be tapped. |
| `index` | 0-based position among the matches, as listed by `iphone_find` or an `ambiguous_target` error. Only to choose between several matches. |
| `predicate` | Advanced NSPredicate string, used alone (`index` may accompany it). Prefer the exact fields: they encode text safely. |

Example: `{"label": "Back", "type": "Button"}`.

## Results

Every tool returns one JSON object:
- success: `{"ok": true, ...tool fields}`
- failure: `{"ok": false, "error": {"code": ..., "message": ..., "uncertain": ..., ...details}}`
- a stopped `iphone_batch` keeps its progress fields (`completed_steps`, `results`, `stopped_at`, `resume_at`,
  `stop_reason`, `next_step`) next to `ok` and `error`.

Common fields:
- `action_executed`: whether anything was sent to the phone. `action_complete=false` after `action_executed=true`
  means part of the work happened. `verification_required` says what to check.
- `verified`, `verification_deferred`: whether this call checked its own result. `verified=false` with
  `verification_deferred=true` is normal.
- `observation`: `observation_id`, `observed_at`, `app` (bundle ID of the app in front), `viewport` (`width`,
  `height` in iPhone points), `nodes`, `total_nodes`, `truncated`, and `image` when a screenshot was taken.
- `image`: `path` (file on this Mac), `mimeType`, `width`, `height`, `pixel_to_point` ([x, y] factors from
  image pixels to iPhone points).
- `error.recovery`: `next_tool` and `next_arguments` (what to call next), `next_step` (one sentence), `use`
  (`coordinates` or `screenshot`), `visual_check_required`, `replay_action` (always false), and for setup or
  restarts `status_tool`, `status_arguments`, `retry_after_seconds`, `state`, `job_id`.
- `error.category=channel_runtime` marks a fault of the automation connection; `recovery.next_tool` is then
  `iphone_ready`.

## How results reach you

- Each result is one compact JSON text block, plus at most one image block.
- A screenshot, whether it belongs to a success or to a failure, arrives as an image inside the same result.
- A failure **with** a screenshot is delivered as a normal tool result (MCP `isError` false) with `ok=false`
  inside, so that the image reaches you. A failure **without** an image is flagged as a tool error and you see
  only its text. Either way `ok=false` means the call failed: read `error`.
- The JSON never contains image data, only `image.path`. If you cannot see an image that a result mentions,
  open that path with the Read tool, or call `iphone_observe(mode=screenshot)`.
- Very large results are trimmed and marked `size_truncated=true`. Ask for fewer nodes (`max_nodes`) or pages.
