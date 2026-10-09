# Typing, long text, line breaks and sending

## Typing

- **Send the whole text in one call.** Call `iphone_type_text(selector=..., text=...)` once with the complete
  content the user needs, in any language or emoji.
  - Do not type a short test string or plain-ASCII version first, and do not split the text yourself.
  - Use made-up test text only when diagnosing a confirmed typing problem, and never the user's real account or
    financial details.
- **If the selector cannot find the field,** do not try other spellings. Tap the field by x/y from the
  screenshot, then call `iphone_type_text(text=...)` with no selector; it types into the field that has keyboard
  focus. No selector also means no extra tap, so the cursor stays where the user or your tap put it.
- **Defaults:** `replace=true` (clear the field first), `allow_newlines=false`, `submit=false`, `verify=false`,
  `observe=none`.
  - After an ordinary search or filter entry, just continue with the next step.
  - If the next page is unknown, ask for `observe=tree` or `observe=both` in the same call.
  - To keep an existing draft, decide between replacing and appending (`replace=false`) from what the field
    shows now.
  - For key final text, `verify=true` reads the whole field back exactly and stops before any submit on a
    mismatch (`input_mismatch`).
- **Who types credentials.** Passwords, passcodes and verification codes are typed by the user. Password fields
  are refused (`not_editable` with `secure_field=true`); see [authentication](authentication.md). Even when a
  password box looks like an ordinary text field, the user types it.

## Long text and continue_token

- The tool types long text in pieces of about 200 characters, with time limits scaled to the length. Each call
  has a time budget of about 60 seconds.
- **`input_complete=false`.** The text is not finished yet. Call `iphone_type_text` again with **only** the
  returned `continue_token`: no text and no other arguments. Repeat until `input_complete=true`.
- **Between continuations** do not tap, swipe, switch apps or press Home. Any other accepted phone action
  (including the user's Home button on the preview page) cancels the token, and it also expires after 10
  minutes.
- The original call's `verify`, `submit`, `expect` and `observe` run only after all of the text is typed.
- **`input_continuation_expired`.** Nothing was typed by that call. Read the field's actual text, then type only
  the missing remainder with `replace=false`.
- **Error in the middle of typing.** The error carries `characters_confirmed` and `characters_total`. Read the
  field back as well; do not retype the whole text.

## Line breaks

- A line break in a chat box can send the message.
- Set `allow_newlines=true` only when the field is a proper multi-line editor you have seen (a text view such as
  a note or an email body). Without it the tool refuses with `newline_requires_intent`; for a single-line field
  it refuses with `newline_unsafe`.
- Never silently change a format the user asked for into one line; tell them if it cannot be kept.
- Allowing line breaks never authorizes sending.

### Chat apps whose Return key sends

In any chat app whose keyboard Return key reads **Send**, never type line breaks. Compose the message as one line
when possible, then type it and send once. If several lines are truly needed, use the app's own line-break menu
item. Worked example, WeChat:

1. Do not pass text containing line breaks to `iphone_type_text`.
2. Type the first part as a draft and confirm that the cursor is in WeChat's message box.
3. Tap a blank spot inside the message box so that the text editing menu (the small black bar of options)
   appears, and tap its line-break item. Its label depends on the language the iPhone uses; read it from the
   screenshot. Type the next part, and repeat as needed.
4. Check the complete draft on the screen, then tap Send exactly once.
5. If the menu or the line-break item does not appear, stop and look at the current screen again. Never use the
   keyboard's Return key instead.

This depends on the app version and the menu actually shown; `allow_newlines=true` alone does not mean a line
break was inserted safely.

### Multi-line editors and submit

- `submit=true` presses Return once after typing. In a multi-line editor Return adds a line instead of sending,
  so the tool refuses with `submit_unsafe` before typing anything. Type without `submit`, then tap the visible
  Send (or Post, Done) button.

## Sending and submitting

- **Typing and sending are separate.** Text is never submitted by default.
- **Sending needs the user's go-ahead.** Do not slip an unrequested send into navigation or into a batch.
- **When sending is authorized:**
  - Before sending, use one observation (or `verify=true`) to check both the **recipient or conversation** and
    the **complete draft**. Then send **once**.
  - After sending, check the final content **and how many times it was sent** (no duplicates).
- `submit=true` does not prove the result: the result says `submission_verified=false` with
  `verification_required`. Check the real result page or record.
- **Sending again.** Only when it is clearly **not** sent. Never send again because of a timeout, a missing
  check or an ordinary `verified=false`.
- **Garbled text, partial sends, timeouts.** If you see garbled text, a partial send, a timeout, `uncertain=true`
  or a partly completed action, first read the real field, conversation or record. Then do only the unfinished
  part. Never retype or resend blindly.

## Money and irreversible actions

These need the user's explicit instruction for that exact action: paying, transferring money, trading, placing
or cancelling an order, deleting, unsubscribing, and accepting legal terms or other irreversible prompts.

- A general request ("look at my bills", "tidy up my inbox") is not permission to pay or delete anything.
- If the request is clear and specific ("pay the electricity bill of 2,340 from my savings account"), go ahead
  and still check the recipient, amount and account on the screen right before the final tap.
- If anything is unclear or differs from what the user said (another amount, an unexpected fee, a different
  account, a different recipient), stop before the final tap and ask with AskUserQuestion. Show the recipient,
  the amount and the account in the question, for example:

```json
{"questions":[{"question":"Your banking app is ready to pay 2,340.00 to City Power from Savings ...1234. Should I tap Pay?","header":"Confirm pay","multiSelect":false,"options":[{"label":"Yes, pay it","description":"Tap Pay once and show me the receipt"},{"label":"No, stop","description":"Leave it unpaid and tell me what you found"}]}]}
```

- Proceed only on a real "yes". After the final tap, read the confirmation or receipt and report it.
- Never retry a payment, transfer, trade or order whose result is uncertain: look for the receipt, the history
  entry or the order status first.
