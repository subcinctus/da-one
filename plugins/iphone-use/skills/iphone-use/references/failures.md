# Failures: every error code and what to do

A failed call returns `{"ok": false, "error": {...}}`. Read `error.code` first, then `error.message`,
`error.recovery` and the evidence fields:

- `action_executed=false`: nothing was sent to the phone.
- `action_executed=true` with `action_complete=false`: part of the work happened. `verification_required` says
  what to check.
- `uncertain=true`: the action was sent but its answer was lost; it may or may not have happened.
- `observation.image`: a screenshot is attached (look at it first).
- `recovery`: the suggested next tool and arguments, and `replay_action=false` (never repeat automatically).

## Error codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `service_unreachable` | The Mac could not reach the iPhone helper (not running, cable, or the Mac's USB service). With `phase` connect or deadline nothing was sent; with `phase` read only a read failed. | Not a failed task. Follow `recovery`: `iphone_setup(action=status)` and the cold start in [startup](startup.md). |
| `action_uncertain` | The action was sent, then the connection failed or timed out (`uncertain=true`). It may have happened. | Look at the current screen before deciding anything. Never repeat it automatically. |
| `response_too_large` | The answer was too large to return. | If `action_executed=true` or `uncertain=true`, the phone already acted: do not repeat it or the `completed_steps`; read the screen first (finish any `continue_token`). Otherwise ask for less (`max_nodes`, fewer pages). |
| `invalid_response` | The helper returned something unreadable (for example a screenshot that could not be decoded). | If `uncertain=true`, treat it like `action_uncertain`. Otherwise read once more; if it repeats, run `iphone_ready`. |
| `http_error` | The helper answered with an HTTP error and no details. | If `uncertain=true`, read the screen first. Otherwise run `iphone_ready` before continuing. |
| `invalid_argument` | The arguments failed validation. Nothing ran (`action_executed=false`). | Fix once using `argument_path`, `unknown_fields` and `allowed_fields`, then call again. Never drop or ignore unknown fields. |
| `invalid_selector` | The selector uses an unknown field, a bad value or an index without a match field. Nothing ran. | Use only the selector fields documented on `iphone_find`; copy values from fresh nodes. |
| `unknown_tool` | The tool name does not exist. Nothing ran. | Use one of the 17 names in [tools](tools.md). |
| `newline_requires_intent` | The text contains line breaks but `allow_newlines` was not set. Nothing was typed. | Write one line, or set `allow_newlines=true` only for a multi-line field you have seen. Never in a chat box whose Return sends. |
| `newline_unsafe` | Line breaks were allowed but the field is not a multi-line text view. Nothing was typed. | Send the text as one line, or use the app's own line-break menu item (see [typing and sending](typing-and-sending.md)). |
| `submit_unsafe` | `submit=true` on a multi-line editor, where Return adds a line instead of sending. Nothing was typed. | Type without `submit`, then tap the visible Send button. |
| `stale_observation` | The `observation_id` is unknown here, or the app in front or the screen orientation changed. Nothing was tapped. | Look at the current screen (`recovery` suggests `iphone_observe` with mode both) and locate the target again. The id is optional; you can leave it out. |
| `foreground_unavailable` | The automation channel cannot tell which app is in front (a channel fault, not an app problem). | Run `iphone_ready` (see channel recovery in [startup](startup.md)), then continue from what the screen shows. Do not change selectors. |
| `no_such_element` | No element matches the selector. Nothing was tapped. A screenshot is attached. | Find the target in the screenshot and tap it by x/y. Do not try other selector spellings. |
| `ambiguous_target` | Several separate elements match. Nothing was tapped. `candidates` lists each with a `tap` point. | Tap the intended candidate's `tap` point by x/y, or repeat the selector with its `index`. |
| `occluded_target` | The element exists but something covers it. Nothing was tapped. `tap_point` says where it is. | Look at the screenshot; dismiss the covering popup with its visible close or cancel control first. `tap_point` is not proof the element can be tapped. |
| `offscreen_target` | The element is outside the visible screen. Nothing was tapped. | Look at the screenshot; check the list, direction and any overlay, then swipe toward it if it makes sense. |
| `not_editable` | The element does not accept typed text. With `secure_field=true` it is a password field: no screenshot, and the preview is paused. | Normal field: tap the right field by x/y from the screenshot, then type without a selector. Password field: hand over to the user ([authentication](authentication.md)); never type credentials. |
| `no_focused_field` | No text field has keyboard focus, so nothing was typed. | Tap the visible field by x/y (pick a new point from the screenshot), then `iphone_type_text` with no selector. |
| `search_exhausted` | `iphone_scroll_find` found no tappable match after its one swipe. A screenshot is attached. | Look at it before deciding to swipe again. It does not prove the item does not exist. |
| `no_scroll_progress` | The swipe ran, but movement of stable content could not be proven. A screenshot is attached. | Look at it for the last row, an end marker, a popup or the wrong region. Do not repeat automatically; it does not prove the list is empty or finished. |
| `scroll_context_changed` | After the swipe, the screen size or a native popup changed. The swipe did run. | Look at the screenshot and handle what is now on screen. Do not treat the swipe as not executed. |
| `modal_requires_region` | A native alert or sheet is open, and a checked swipe needs an explicit `region` inside it. Nothing ran. | Handle the popup, or give a `region` inside the list you mean. |
| `blocked_scroll_region` | The given `region` is not inside the open alert or sheet. Nothing ran. | Choose a region inside the popup's list, or close the popup first. |
| `postcondition_failed` | The action ran, but the requested check (`expect`, or `verify=true`) failed. | Look at the screenshot for loading pages, sign-in or system prompts. Continue only the missing work; never repeat the action (for example an app launch) automatically. |
| `input_mismatch` | The typed text did not read back exactly. Nothing was submitted. | Look at the field in the screenshot and fix only the difference. Do not submit or retype blindly. |
| `input_continuation_expired` | The `continue_token` is no longer valid (finished, expired after 10 minutes, or another phone action ran). Nothing was typed now. | Read the field's actual text, then type only the missing part with `replace=false`. |
| `device_busy` | Another iPhone Use step is running, perhaps in another Claude Code window. Nothing was done. | Wait for it to finish, then try again. Never work around the lock (no other data folder, no parallel control). |
| `phone_locked` | The iPhone is locked. Nothing was done; the preview is paused automatically. | Ask the user to unlock it and keep it awake ([authentication](authentication.md)), then `iphone_ready`. Do not add an extra pause. |
| `not_ready` | The helper answers but is not accepting commands yet. | A setup step, not a failure: follow `recovery` and the cold start in [startup](startup.md). |
| `mirroring_conflict` | iPhone Mirroring on the Mac is holding the iPhone and the screen tree is empty. | Ask the user to quit iPhone Mirroring (and unlock if needed), then `iphone_ready`. Never act on an empty tree. |
| `recovery_not_started` | An automatic restart was not started: a recent restart is in its 2-minute cooldown (`recovery.state=cooldown`), or the helper was not started by this plugin (`recovery.state=manual`). | Cooldown: wait `recovery.retry_after_seconds`, then `iphone_ready` once. Manual: follow `recovery.next_steps`. Never loop restarts or kill processes. |
| `internal_error` | The tool failed unexpectedly (`uncertain=true`). | Check `iphone_setup(action=status)` and look at the screen before continuing. Never repeat the action blindly. |
| `config_invalid` | A setup value is invalid (the message names the field), or the saved configuration cannot be used. | Correct that value with `iphone_setup(action=configure, ...)`. See the iphone-use-setup skill. |
| `config_choice_required` | Several iPhones or Apple teams are available; `choices` lists them. | Ask the user which one with AskUserQuestion, then configure with their choice. |
| `prerequisite_missing` | Something must happen first: Xcode, a build, the cable, an unlocked iPhone, the source. | Follow `next_steps`. A missing build means `iphone_setup(action=build)` before start. |
| `job_conflict` | Another setup job is already running. | Check `iphone_setup(action=status)`; reuse or wait for that job, or stop it first if the user agrees. |
| `unknown_job` | The job id does not exist (or is malformed). | Call `iphone_setup(action=status)` without `job_id` and use an id from the `jobs` array. |
| `state_dir_unsafe` | A custom data folder (set with IPHONE_USE_STATE_DIR) is inside a Git project, where screenshots could end up in a repository. | Ask the user to remove that setting or choose a private folder outside any project. The default folder is always accepted. |
| `setup_failed` | A setup step failed. | Read the job's `error`, `log_errors` and `next_steps`; explain the blocker in plain words. Do not loop. |
| `app_lookup_unavailable` | The app list could not be read (the iPhone's installed apps or the App Store search). `warnings` says why; `candidates` may still list matches. | Use the candidates if they fit, try `source=catalog`, or ask the user. Never guess a bundle ID. |
| Raw WebDriverAgent errors | Errors passed through unchanged from the iPhone helper: `invalid session id`, `no such element`, `stale element reference`, `element not interactable`, `element click intercepted`, `invalid element state`, `unknown error`, `invalid argument`. | Look at the current screen first (a screenshot is attached for the element errors). For `invalid session id`, `stale element reference` or repeated `unknown error`, run `iphone_ready`. Never repeat an action that may have run. |

## The never-repeat rule

- Retry or re-plan only after you have **seen** a definite failure on the screen.
- Never repeat typing, a send, a payment, an order, a delete or a whole batch whose outcome is uncertain:
  `uncertain=true`, `action_executed=true` with `action_complete=false`, or a timeout after the action. Read the
  real field, message or record first, then do only the unfinished part.
- Recovery of the connection never repeats business actions, and switching to the command-line fallback does
  not change this rule.
- Pure reads may be read again (the tool already retries a failed read once within its time limit). A failed
  read does not prove that a phone action ran.

## The screenshot-first rule

- Failures about finding, focusing, scrolling or checking the screen attach one screenshot. Look at it
  **before** anything else, then tap by x/y if needed. Do not re-read the tree, try other selector spellings,
  or swipe again first.
- If no screenshot is attached (`observation_error`), take one with `iphone_observe(mode=screenshot)`.
- Password fields never get a screenshot: hand over to the user instead.
- The rule covers screen-location problems only. Argument errors are fixed from the schema, channel faults go
  to `iphone_ready`, locks and sign-ins go to the user, and uncertain actions are checked on the real screen.
- Details: [screen reading](screen-reading.md).

## Quick guide by situation

| Situation | What to do |
| --- | --- |
| Empty tree or labels not found, but the helper works | Custom-drawn, protected or truncated page. Tap by x/y from a screenshot; for typing, tap the field, then type without a selector. If still unreadable, tell the user the specific limit. |
| A tap, typing or send timed out | It may have happened. Look at the page, field or message in the next observation before continuing. |
| The helper looks healthy but every action fails | Run `iphone_ready`; it checks the session, the app in front and the screen. |
| An app's own sign-in expired | Not a connection fault. Hand over to the user; no restart is needed. |
