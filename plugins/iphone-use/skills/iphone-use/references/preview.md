# The live preview page

The live preview lets the **user** watch their iPhone screen while you work. It is a private web page served by
the plugin on this Mac only (an address like `http://127.0.0.1:18200/<random>/`), shown in the user's normal web
browser. You cannot see it, and it is never evidence for you.

## Opening it

- `iphone_ready` returns `preview.url` when it succeeds; it never opens a browser by itself.
- After the first successful READY in a conversation, call `iphone_screen(action=open)` once. It returns `url`,
  `opened` (the browser was opened on the Mac), `already_viewing` (the user already has it open), `paused` and
  `pause_reason`.
- Give the user the link **once**, in one short line ("You can watch your iPhone here: <url>"). Do not repeat it
  on every step. If `already_viewing=true`, a short mention is enough.
- If the user asks to watch first ("open the screen so I can watch"), open it and then continue with the task;
  wait only if they explicitly asked you to wait for their go-ahead. Opening it is not an approval step.
- `iphone_screen(action=open, open_browser=false)` only returns the link. `iphone_screen(action=status)`
  reports the link, whether it is paused, and how many viewers are connected.

## How long the link works

- The link stays the same while this Claude Code session runs, across READY, recovery, pause and resume.
- A new Claude Code session (or a plugin restart) can give a new link. An old tab then shows "Not connected" and
  the hint "The preview stopped. Ask Claude to open the iPhone screen again." When the user says so, call
  `iphone_screen(action=open)` once and give them the new link.
- After a plugin update, restart Claude Code (or reconnect the server with `/mcp`) and open the preview again.

## What the page shows

- The iPhone model and a status at the top: "Connecting...", "Live", "Paused" ("Waiting for unlock" or "Paused
  for sign-in") or "Not connected".
- The live screen in an iPhone frame. With no picture, a dark screen with an icon for connecting, locked,
  sign-in, paused or unavailable. A short gap keeps the last picture, which is not proof of the current state.
- A glowing edge while you are operating the phone, and small circles where taps and swipes happen. Neither
  proves an action succeeded.
- Three buttons for the user: **Refresh preview**, **Go to Home Screen** and **Copy screenshot to clipboard**.
  These are the user's controls, not yours. Home and Copy are disabled while the preview is paused.

## The user's buttons change the phone

- If the user presses **Go to Home Screen**, the iPhone really goes to the Home Screen. Continue from what your
  next observation shows. It also cancels any unfinished long-text `continue_token`.
- **Refresh preview** reconnects the picture and checks whether the iPhone is unlocked. If it is, the pause that
  existed when the user clicked is lifted (a pause that starts during the check stays). It never restarts the
  helper, creates a session or sends a gesture.

## Pauses

- When `paused=true`, check `pause_reason`:
  - `device_locked`: waiting for the user to unlock. A successful `iphone_ready` resumes this pause by itself.
  - `authentication`: you or a password field paused it for a sign-in. Resume only with
    `iphone_screen(action=resume)` after the user confirmed they are done (see [authentication](authentication.md)).
- While paused, the page shows no picture and nothing is captured.

## Rules

- The preview is never evidence: a black frame, the glow or the tap circles prove neither READY, nor an action's
  success, nor completion. Decide only from tool results.
- Never add screenshots, observations or polling to refresh the preview.
- Preview problems never justify restarting the helper or recovering the connection. If phone tools work but the
  preview shows nothing, carry on with the task and mention it to the user once.
- `frame_available=false` does not prove a connection failure.
- The picture is captured only while someone is watching (and for 5 seconds after the tab is hidden or closed).
  Pictures are kept in memory only, never on disk.

## Wi-Fi note

By default the iPhone helper accepts connections only over the USB cable. Only if the user agreed to
`allow_network` (see the iphone-use-setup skill) can devices on the same Wi-Fi reach it while it runs. Offer to
stop it when the user is done for the day.
