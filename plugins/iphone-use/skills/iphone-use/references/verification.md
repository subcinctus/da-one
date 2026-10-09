# Verification: what to check before reporting

## Verify only where it matters

- Routine actions are optimistic: no extra observation just to check the previous action. When the next step
  needs page information, use that read to judge progress, and redo something only on a clear failure.
- `expect`, `verify=true` and the final read-back are for key results: final values, sent messages, saved
  items, submitted forms, delivered files. Not for every tap, page switch, expansion or swipe.
- Before you report, take a fresh read of each key result. The result of a single call (`ok`, `verified`,
  `action_complete`) is not proof that the user's task is done.

## Lists and detail pages

- Records with the same name can be different records. Tell them apart by order number, date, status and amount
  together.
- List collection merges rows that look identical (same type, name, label and value). If real records may have
  collapsed, say so in the answer.
- On a detail page, read the needed fields directly; that same read is enough to show you are on the right page.
  Add no separate page-check round.
- Fixed headers, native overlays and custom panels can hide items that still appear in the tree. An
  `occluded_target` or `offscreen_target` error did not tap anything.
- Keep the first and last item you saw, the date range, the stop reason and any missing fields; reconcile them
  with what the user asked for.

## Time-sensitive and financial data

- If content refreshes by itself, wait only when the data you need is not loaded yet. Read the actual fields and
  note the date the page shows (valuation date, statement date, trade date). Opening an app today does not mean
  its numbers are today's.
- Keep amounts per account and per currency. Do not add up both the detail lines and the account totals.
- "Pending", "processing", "debited" and "completed" are different stages. Define success the way the user
  asked for it.
- Cash, holdings, money in transit and unknown accounts keep their own labels. Differences you cannot reconcile
  stay "unknown"; do not invent a figure.
- The plugin reads what the apps show. It does not value assets, convert currencies or compute net worth; if
  you calculate something, say it is your calculation and how you did it.

## Typing and sending

- If typed text does not read back exactly, or an expected page is missing, a screenshot is attached. First judge
  the focus, the actual text, popups and the send result, then finish only the missing part.
- If the screenshot failed too, keep the original error and its evidence, take one separate screenshot, and do
  not keep typing or sending on your own.
- After a send, check the content and that it was sent exactly once. See
  [typing and sending](typing-and-sending.md).

## Writing results somewhere else

- The plugin only operates the iPhone. To put results into a document, spreadsheet, CRM or database, use the
  user's own connected tools (their MCP connectors) or files they name.
- Before writing to an external service, check its field types and meaning with that service's tool. After
  writing, one read-back of the key target, the content, the fields and the number of entries is enough.

## Evidence and traceability

- Observation ids and screenshots tie actions to what was on screen. Screenshots are kept in the private iPhone
  Use folder on this Mac (by default `~/.local/share/iphone-use/artifacts`); only the newest 40 are kept. If the user wants
  evidence kept longer, copy the needed images to a folder they name, outside any project or repository.
- Screen trees and typed text are not saved as a history. `iphone_metrics` holds only timing and size totals for
  the current session, never text, app data or images.
- Judge speed by the real task time and how complete the result is; do not describe skipped checks as if the
  outcome were proven.

## Reporting to the user

- Lead with the business answer: the numbers, names, dates or confirmation they asked for.
- Add one line on coverage and limits, for example: "I read all 23 transactions from 1-7 October; 2 had no
  amount shown."
- Say plainly what you did not do or could not see, and why.
- Leave out technical terms (helper internals, ids, codes) unless the user asks.
