# Passwords, codes, Face ID and unlocking: handing over to the user

The user completes every sign-in, password, passcode, verification code, Face ID or Touch ID prompt and every
unlock on the iPhone themselves. You pause, ask, wait for a real answer, then continue.

## When to hand over

Hand over only when the current observation or a tool result clearly shows an authentication block: an app's
sign-in or password page, a verification-code screen, a Face ID or Touch ID prompt, an expired app session, or
`phone_locked`. An empty tree or a black screenshot alone does not prove authentication: first tell apart a lock
screen, iPhone Mirroring, custom-drawn content and a connection fault.

## Identify the blocking layer

| Evidence | What it is | What to do |
| --- | --- | --- |
| The app's own sign-in, password, code or Face ID prompt | App authentication | Pause the preview and ask the user to complete it in that app (below), then observe the target page again. READY does not mean the app is signed in. |
| `phone_locked`, or the iPhone is visibly locked | Device lock | The preview is already paused. Ask the user to unlock the iPhone and keep it awake, then run `iphone_ready`. |
| `foreground_unavailable`, an app id starting with `local.pid.`, or "Not authorized for performing UI testing actions" | Connection fault, not a password problem | Recover with `iphone_ready` (see [startup](startup.md)). Ask the user only if the iPhone itself shows a trust or authorization prompt. |
| `not_editable` with `secure_field=true` | A password field you tried to type into | Nothing was typed and the preview paused itself. Ask the user to type it (below). |

## Preview pause rules

The live preview shows the user's screen, so it must not show a password being typed.

- **App authentication:** call `iphone_screen(action=pause)` first. This stops the live picture and the page
  shows a paused placeholder. Then ask the question. This pause is **not** lifted by READY or by opening the
  preview; you lift it with `iphone_screen(action=resume)` after the user confirms.
- **`phone_locked` already pauses** the preview, with `pause_reason=device_locked`. Do **not** call pause on top
  of it: an explicit pause would turn it into an authentication pause, and the successful READY after the unlock
  would then no longer resume it by itself. (A lock never weakens an existing authentication pause.)
- **Typing into a password field** (`not_editable` with `secure_field=true`) pauses with reason
  `authentication` automatically.
- **After an unlock,** a successful READY resumes only the same lock pause it saw; a newer pause stays.
- A pause with an unknown reason needs an explicit `iphone_screen(action=resume)`.
- During the hand-over, do not take screenshots, poll the screen or read what the user types.

## Ask with AskUserQuestion

Do not just write "reply 'continue' when done" in a message. Ask with the AskUserQuestion tool. The question
names the actual app, the blocked step, what the user must do, and what you will do next. The first option is
always **"Done, continue"**; the second is **"I can't do this now"**. The question only asks whether the phone
step is done. It never asks for a password, PIN or code.

Example (app authentication):

```json
{"questions":[{"question":"Your banking app is asking for Face ID. Please complete it on your iPhone and stay on the accounts page. When you're done, choose \"Done, continue\" and I'll read the remaining transactions.","header":"Face ID","multiSelect":false,"options":[{"label":"Done, continue","description":"I finished it on my iPhone"},{"label":"I can't do this now","description":"Stop phone steps and keep what you have so far"}]}]}
```

- Replace the app, the method (Face ID, password, code) and the follow-up work with what you actually saw.
- For a locked iPhone, ask the user to unlock it themselves and keep it awake (header such as "Unlock").
- `header` is a short label of about 12 characters at most; give 2 to 4 options.
- Do any work that does not need the phone **before** asking, because nothing can run while the question is
  open.

## What counts as an answer

- Only the user actually choosing "Done, continue", or a clear typed reply that says it is done, counts.
- These do not count: the tool returning without a selection, an error or a denied question, elapsed time, or
  no answer. Treat the step as not done.
- Do not ask again and again, do not poll the phone, and do not mark the task complete while waiting.
- **No AskUserQuestion available** (for example a non-interactive run or a subagent): write the exact
  instruction as plain text, say the task is paused until they finish it, and end your turn without claiming
  completion.

## Credential hygiene

- Describe only the authentication method and page you actually saw.
- Never guess passwords or PINs, and never try to get around Face ID or Touch ID.
- Never ask the user to send a password, passcode or verification code in the chat.
- Never put credentials in `iphone_type_text`, a batch, logs, scripts or the command-line fallback.
- Even if a password box looks like an ordinary text field, the user types it.
- Keep track of the current app and page, what you have collected, the steps already done and what is left.
  Never record credentials.
- If Face ID fails, falls back to a passcode, or a code expires, the user follows the iPhone's prompt. Do not
  trigger verification repeatedly, and do not restart the app or the helper.

## After the user is done

- **When to continue.** Only after the user chose "Done, continue" or clearly said it is finished.
  - App authentication, or a pause with an unknown reason: call `iphone_screen(action=resume)`.
  - Device lock: run `iphone_ready`; on success it resumes the matching lock pause by itself.
  - Elapsed time is never completion and never a reason to resume.
- **Observe again.** One fresh observation both plans the next step and checks the app in front, any remaining
  prompt, and the target page.
- **Do not reuse old state.** The user may have switched apps, gone back, scrolled or even done later steps.
  Never reuse coordinates, observation ids or element positions from before the hand-over.
- **Protected pages.** If a page's text is not in the tree, read it from a screenshot. Do not sign in again or
  re-check for every step.
- **Still not done:** say what remains and wait. Do not run the blocked action.
- **"I can't do this now":** say what is done and what remains, and stop phone steps. Keep the checkpoint so the
  task can resume later.
- **Phone or connection failed meanwhile:** recover with `iphone_ready` and use its fresh observation. An expired
  app session is not a reason to restart the helper.
- **Submissions during the hand-over.** If something may have been submitted while the user had the phone, read
  it back first. Never resend, re-pay, re-order or replay a whole input or batch.
- **Authentication done is not the task done.** At the end, check all apps, fields, coverage and results.
