# Changelog

## 0.1.0 — first release for Claude Code

- Operate a real iPhone over USB from Claude Code through 17 MCP tools (read the screen, tap, swipe, type, open apps,
  collect lists, run short batches of known steps).
- USB connection written in plain Python: the plugin talks to the Mac's USB device service (usbmuxd) directly, so no
  Node.js, no port forwarder and no extra local network port are needed.
- The iPhone helper (WebDriverAgent 16.14.0) accepts connections only over the USB cable by default, and web pages
  cannot read its answers; apps and pages on the iPhone itself can still reach it while it runs, so stop it when
  you are done.
- Live preview of the iPhone screen as a private page in your web browser (this Mac only), with Refresh, Home and
  Copy screenshot buttons; it pauses automatically while you sign in or unlock.
- Guided setup in background jobs (fetch, build, start) with status polling, safe restarts of the plugin's own
  helper, and plain-English troubleshooting.
- Screenshot fallback: when an element cannot be targeted, the result carries a screenshot so Claude can tap by
  position instead of guessing.
- Safety rules: uncertain actions are never repeated automatically, line breaks and sending need explicit intent,
  password fields are always refused, and money-moving or irreversible steps need your explicit go-ahead.
- English skills for everyday use and for setup and recovery.
