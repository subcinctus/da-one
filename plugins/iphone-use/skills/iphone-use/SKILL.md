---
name: iphone-use
description: Operate the user's real iPhone, connected to this Mac by USB, with the iPhone Use tools - open apps, read the screen, tap, scroll, type, collect lists and check key results. Use for any request to do, find, read or send something on the user's iPhone.
when_to_use: The user asks to do something on their iPhone or in an iPhone app (read messages, check a bank or brokerage app, fill a form, change a setting, find information), or mentions the live iPhone preview.
---

# iPhone Use

You operate the user's own iPhone, connected to this Mac by a USB cable, through the iPhone Use tools
(`iphone_*`). The user is usually a busy executive, not a developer: speak plainly, keep going until the job is
done, and never take an action they did not ask for.

## 1. Start of a phone task

- If the `iphone_*` tools are not in your tool list, load them with ToolSearch (query `iphone`) before deciding
  they are missing. If they still do not appear, see section 12.
- First phone step in each conversation: `iphone_ready(recover=true)`. Add `screenshot=true` only when you need
  to see the screen straight away; text tasks do not.
  - Only `ready=true` allows phone actions. Reuse its `observation` to plan the first step; do not observe again
    straight away.
  - Then call `iphone_screen(action=open)` once and give the user the link in one short line, for example "You
    can watch your iPhone here: <url>".
- Not ready yet? Follow [startup](references/startup.md):
  - error `service_unreachable` or `not_ready`: the iPhone helper is not running. This is a setup step, not a
    failed task.
  - `ok=true` with `ready=false` and `state=recovering` or `state=recovery_required`: follow `recovery` in the
    result.
  - error `phone_locked`: ask the user to unlock (section 8), then `iphone_ready` again.
- Do not run `iphone_ready` before every step or every task. Run it again only after a channel fault, a
  recovery, a lock, or when a result tells you to.
- An earlier conversation, the plugin being installed, an open preview or the helper icon on the iPhone do not
  prove READY in this conversation.

## 2. How to work

- Work out the deliverable first: what the user wants handed back, and when it is complete.
- Act optimistically. The defaults are `observe=none` and `verify=false`: an action that returns `ok=true` ran
  as planned, so move on.
- When the next step needs the new page, ask for it on the action itself (`observe=tree` or `observe=both`).
  That one observation plans the next step and shows whether the last one worked. Do not act with
  `observe=none` and then call `iphone_observe` only to check.
- `verified=false` with `verification_deferred=true` is normal. It means "not separately checked", not
  "failed".
- `ok`, `verified` and `action_complete` describe one call, not the task. A finished batch, a Home press or one
  app read is a phase, not the end of the job.
- Keep going until every part of the deliverable is done and checked. Give short progress notes on long tasks.
  Do not end your turn with "next I'll ..." - do it.
- Use `expect` or `verify=true` only for key results or real dependencies, not on every step.

## 3. Reading the screen

- `iphone_observe(mode=tree)` returns accessibility nodes, `mode=screenshot` an image, `mode=both` both.
  Actions take `observe=...`; the standalone tool takes `mode=...`.
- Node format: `type` without the `XCUIElementType` prefix; `rect=[x,y,width,height]` in iPhone points; a
  missing `name` equals `label`; a missing `value` repeats the text; missing `enabled`, `visible` and
  `in_viewport` mean true.
- Screenshots arrive as an image inside the same tool result, scaled for reading: image pixel x
  `image.pixel_to_point` = iPhone points. Never pass raw screenshot pixels, or positions on the Mac screen or
  the preview page, as x/y.
- Take a screenshot only when you need to judge something visually: custom-drawn content, popups, missing labels.
- To check for one element use `iphone_find` or `iphone_wait`, not a whole tree.
- A truncated tree or a listed node proves neither that the content is complete nor that the node can be
  tapped: fixed headers and overlays can cover it.
- If a result mentions an image you cannot see, open its `image.path` (or `error.observation.image.path`) with
  the Read tool, or call `iphone_observe(mode=screenshot)`.

Details: [screen reading](references/screen-reading.md).

## 4. Acting

- Selectors: copy `label`, `name`, `value` or `type` verbatim from fresh nodes. Use `label_contains` for long
  labels or labels with changing times or numbers. `rect`, `visible` and `in_viewport` are not selector fields.
  All fields are documented on `iphone_find`.
- Several separate matches return `ambiguous_target` with `candidates` and nothing is tapped: tap the intended
  candidate's `tap` point by x/y, or repeat the selector with its `index`. Never pick the first one blindly.
- Coordinates are iPhone points. `observation_id` is optional; it only checks that the app and the screen
  orientation are unchanged.
- Open apps with `iphone_launch_app` and the exact bundle ID from `iphone_apps`
  ([apps](references/apps.md)). Never guess or construct a bundle ID.
- Home Screen: `iphone_press_button(name=home)`.
- Chain known steps with `iphone_batch` (up to 20). If it stops, continue from `resume_at`; never repeat
  completed steps.
- Use `iphone_wait` only when the flow truly depends on something appearing; no fixed waits.

## 5. When a call fails

- Every result has `ok`. If `ok=false`, read `error.code` and `error.message`. Full table:
  [failures](references/failures.md).
- Selector, focus, scroll and unexpected-page failures attach a screenshot, and such a result is not flagged as
  a tool error so that the image reaches you. Look at the screenshot **first**, then tap by x/y. Do not try
  other selector spellings, extra swipes or a new tree read first.
- Never repeat anything that may have run: `uncertain=true`, or `action_executed=true` with
  `action_complete=false`, or a timeout after a tap, typing or a send. Look at the current screen and continue
  only the missing part.
- Channel faults (`foreground_unavailable`, or `error.category=channel_runtime`): call `iphone_ready`, then
  continue from what the screen shows. Changing selectors or pressing buttons again cannot fix them.
- `device_busy`: another iPhone Use step is running, perhaps in another Claude Code window. Wait and try again;
  never work around the lock.
- Argument errors (`invalid_argument`, `invalid_selector`) mean nothing ran: fix the fields named in
  `argument_path`, `unknown_fields` and `allowed_fields`, then call once.
- Routine screen trouble that a screenshot can solve is yours to solve; do not hand it back to the user early.

## 6. Typing and sending

- Send the whole text in one `iphone_type_text` call. Do not type a test string first and do not split it
  yourself.
- If the field cannot be found by selector, tap it by x/y, then call `iphone_type_text` with the text and no
  selector.
- Long text: a result with `input_complete=false` carries a `continue_token`. Call `iphone_type_text` again with
  **only** `continue_token`. Do not touch the phone in between.
- Line breaks need `allow_newlines=true` and a multi-line field you have seen. Never type line breaks into a
  chat box whose Return key sends: write one line, or use the app's own line-break menu item.
- `submit` defaults to false. It is refused for multi-line editors (`submit_unsafe`): type without submit, then
  tap the visible Send button.
- Sending needs the user's go-ahead. Before sending, check the recipient and the complete draft; send once;
  then check that it was sent exactly once.
- **Money and irreversible actions** - pay, transfer, trade, place an order, delete, accept terms: only with the
  user's explicit instruction for that exact action. If anything is unclear (recipient, amount, account,
  quantity), ask with AskUserQuestion before the final tap, showing recipient, amount and account. A general
  request ("sort out my bills") is not permission to pay.

Details: [typing and sending](references/typing-and-sending.md).

## 7. Lists and scrolling

- `direction` is the finger's movement: `up` usually reveals later rows.
- For a target whose position is unknown, swipe once per decision and read what the next step needs. Do not
  pack several speculative swipes into a batch.
- `iphone_scroll_find` swipes at most once per call. If it returns `search_exhausted`, look at the screenshot
  before deciding to swipe again.
- `no_scroll_progress` never proves that a list is empty or finished.
- `iphone_collect_list` always returns `complete=false`. Reconcile counts, dates and totals against what the
  user asked for before saying a list is complete.

Details: [lists and scrolling](references/lists-and-scrolling.md).

## 8. Passwords, codes, Face ID and unlocking

- Never ask for, type or store passwords, passcodes, PINs, verification codes or Apple Account details, and
  never try to get around Face ID. That includes `iphone_batch`, the command line and scripts. Password fields
  are refused anyway (`not_editable` with `secure_field=true`).
- When the screen shows a sign-in, password, code or Face ID prompt:
  1. `iphone_screen(action=pause)` - hides the live picture while the user types.
  2. Ask with AskUserQuestion: name the app and exactly what the user must do on the iPhone. First option
     "Done, continue", second option "I can't do this now".
  3. Continue only after the user really chose "Done, continue", or clearly said it is done.
  4. `iphone_screen(action=resume)`, then observe again. Never reuse coordinates from before the hand-over.
- `phone_locked`: the preview is already paused. Ask the user (AskUserQuestion) to unlock the iPhone and keep it
  awake, then call `iphone_ready`. Do not add a pause on top.
- Without AskUserQuestion (non-interactive runs, subagents): write the exact instruction, say you are waiting
  for them, and end the turn without claiming the task is done.

Details and the exact question format: [authentication](references/authentication.md).

## 9. Finishing and reporting

- Check the key results with a fresh read before you report: final values, sent messages, saved items.
- Report business content plainly, with coverage and limits, for example: "I read all 23 transactions from
  1-7 October; 2 had no amount shown."
- Do not mention WDA, WebDriverAgent, XCTest, UDIDs, job ids, tool names or error codes to the user unless they
  ask. Say "the iPhone helper" or "the connection to your iPhone".
- If something needs the user, say exactly what, where on the phone or Mac, and what happens next.

Details: [verification](references/verification.md).

## 10. Privacy

- Screenshots stay in the private iPhone Use folder on this Mac (the newest 40 are kept). Never copy them into
  the project, a repository or a chat with someone else unless the user asks.
- The live preview is for the user to watch. It is never evidence for you: decide only from tool results.
  See [preview](references/preview.md).

## 11. One controller at a time

- Never operate the phone from parallel subagents or from two sessions at once. The iPhone has one screen; a
  second caller gets `device_busy`. Keep phone work in the main conversation.

## 12. If the tools do not work

- First load them with ToolSearch (query `iphone`).
- If no `iphone_*` tools exist even after ToolSearch, run `python3 --version` with Bash first. A message about
  the Xcode licence or "command line developer tools" means the plugin could not start (see the
  iphone-use-setup skill's troubleshooting), not that the phone failed.
- If a tool binding is broken but Python works, continue the same authorized step through the command-line
  fallback: [CLI fallback](references/cli-fallback.md).

## References

- [tools.md](references/tools.md) - all 17 tools, their full Claude Code names, arguments and result fields.
- [startup.md](references/startup.md) - READY outcomes, starting the helper, channel recovery.
- [screen-reading.md](references/screen-reading.md) - observations, screenshots, selectors, coordinates.
- [failures.md](references/failures.md) - every error code and what to do; the never-repeat rule.
- [typing-and-sending.md](references/typing-and-sending.md) - text entry, long text, line breaks, sending, money.
- [lists-and-scrolling.md](references/lists-and-scrolling.md) - swipes, scroll search, list collection, batches.
- [authentication.md](references/authentication.md) - handing sign-in, codes, Face ID and unlocking to the user.
- [verification.md](references/verification.md) - what to check before reporting, financial data.
- [preview.md](references/preview.md) - the live preview page the user watches.
- [apps.md](references/apps.md) - finding an app's bundle ID.
- [cli-fallback.md](references/cli-fallback.md) - the command-line fallback when the tools are unavailable.
