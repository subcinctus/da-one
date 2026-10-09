# iPhone Use for Claude Code

## What it is

Ask Claude to do things on your iPhone. Claude reads the screen, opens apps, taps, scrolls and types on your
real iPhone, connected to your Mac with a USB cable, and shows you a live picture of the screen while it works.

Things you can ask:

- "Read today's messages from Priya in WhatsApp and summarize them for me."
- "Check my bank balance in my banking app."
- "Turn on Do Not Disturb."
- "Collect last week's card transactions from my banking app into a table."

Claude never types your passwords or codes, and it never moves money or does anything irreversible without your
explicit go-ahead.

## What you need

- A Mac whose macOS can run the Xcode that supports your iPhone's iOS version (for an iPhone on iOS 26 that is
  Xcode 26, which needs macOS 15.6 or newer; the Mac App Store shows which Xcode your Mac can install).
- **Xcode**: free from the Mac App Store. You need the full app, opened once.
- An **iPhone** on iOS 15 or newer (iOS 17 or newer recommended) and a USB cable that carries data.
- An **Apple account**. A free one works; a paid Apple Developer Program membership avoids re-signing the helper
  every week.
- **Claude Code** on the Mac.
- `python3`, which comes with macOS and Xcode. Nothing else to install.

## Install in 5 steps

1. **Install and open Xcode**, then sign in under Xcode > Settings > Accounts with your Apple account.
2. **Connect the iPhone** with the cable, unlock it, tap **Trust**, and turn on Developer Mode
   (Settings > Privacy & Security > Developer Mode). If Developer Mode is not listed yet, Claude will help you
   find it during setup.
3. **Add this plugin's marketplace.** The plugin's GitHub repository is private, so this Mac must first be
   signed in to GitHub with an account that may read it. The simplest way: install GitHub's `gh` tool, run
   `gh auth login` in Terminal and answer **Yes** when it offers to sign Git in too (GitHub Desktop users: sign in
   there as well). To check, `git ls-remote https://github.com/subcinctus/da-one` in Terminal must list the
   repository without asking for a password. Then, in Claude Code, type:

   ```text
   /plugin marketplace add subcinctus/da-one#claude/iphone-use-plugin
   ```

   (In Terminal you can run `claude plugin marketplace add "subcinctus/da-one#claude/iphone-use-plugin"`
   instead.) The part after `#` is the branch the plugin is on for now; once it is merged, plain
   `subcinctus/da-one` works.
4. **Install the plugin**:

   ```text
   /plugin install iphone-use@da-one
   ```

   Then restart Claude Code (or type `/reload-plugins`). On Claude Code 2.1.275 or later, steps 3 and 4 also
   work as one command (after signing in to GitHub):
   `/plugin install iphone-use --marketplace subcinctus/da-one#claude/iphone-use-plugin`.
5. **Paste the first-run prompt** below into Claude Code.

## First-run prompt

```text
Set up iPhone Use for me. Use the iphone-use-setup skill: check my Mac and iPhone with iphone_doctor, guide me through anything I must do myself (Xcode sign-in, trusting this Mac, Developer Mode, trusting the developer app), use my own Apple team and an automatically chosen bundle ID, then fetch, build and start the iPhone helper and keep going until iphone_ready says ready. Then open the live iPhone screen for me. Explain each step in plain English and wait for me when I need to do something on the phone.
```

The first setup can take a while, mostly Xcode downloading its parts and preparing the iPhone. Claude tells you
exactly when you need to do something (for example tap Trust on the iPhone, or enter your Mac password when the
Mac asks "codesign wants to access key": click **Always Allow**).

## Everyday use

- Just ask for what you want done on your iPhone. Claude checks the connection first, then works.
- Claude opens a live view of your iPhone screen in your web browser. You can watch, press **Go to Home Screen**,
  or **Copy screenshot to clipboard** from that page. The page is private to this Mac.
- When an app asks for your password, a code or Face ID, Claude pauses the live view and asks you to do it on
  the iPhone. Choose "Done, continue" when you are finished.
- Keep the iPhone unlocked and connected while Claude works.
- To stop the iPhone helper when you are done, say "stop the iPhone service".

## Fewer permission prompts

Claude Code asks your permission before each iPhone tool runs. You can answer "Yes, and don't ask again" for the
tools you are comfortable with. Or add an allowlist to `~/.claude/settings.json`. This one allows the tools that
only read or check things (reading the screen, finding apps, the live view), while taps and typing still ask:

```json
{"permissions": {"allow": ["mcp__plugin_iphone-use_iphone__iphone_ready", "mcp__plugin_iphone-use_iphone__iphone_observe",
  "mcp__plugin_iphone-use_iphone__iphone_find", "mcp__plugin_iphone-use_iphone__iphone_wait",
  "mcp__plugin_iphone-use_iphone__iphone_apps", "mcp__plugin_iphone-use_iphone__iphone_screen",
  "mcp__plugin_iphone-use_iphone__iphone_doctor", "mcp__plugin_iphone-use_iphone__iphone_metrics"]}}
```

To allow everything from this plugin, use `"mcp__plugin_iphone-use_iphone__*"` instead. The trade-off: Claude
could then tap, type and send on your iPhone without asking you each time (it still pays, transfers, trades,
deletes or sends only when you asked for that exact action, and asks you first when anything is unclear or differs
from what you said, but Claude Code itself no longer stops it). Claude never changes these settings for you.

## Safety and privacy

- **Your data:** settings, logs and screenshots are saved in a private folder on your Mac,
  `~/.local/share/iphone-use`, that only your user account can read; only the newest 40 screenshots are kept.
  What Claude reads on the iPhone (screen text and screenshots) is sent to Claude as part of your conversation,
  like anything else you share with Claude, and looking up an app by name may ask Apple's App Store. Do not open
  screens with information you are not allowed to share with Claude.
- **Passwords:** Claude never asks for or types your passwords, passcodes or verification codes. It pauses the
  live view while you type them yourself on the iPhone.
- **Money and irreversible actions:** Claude asks you before paying, transferring, trading, deleting or sending
  anything you did not explicitly ask for.
- **USB only:** by default the helper accepts connections only over the USB cable while it runs, so other
  devices on your Wi-Fi cannot reach it. Apps and web pages open on the iPhone itself can still reach it while it
  runs, and it keeps running after you quit Claude Code, so stop it when you are done ("stop the iPhone
  service"). If USB-only ever fails on your Mac, Claude asks you before allowing network access.
- **Keyboard:** while the helper runs it turns off the iPhone keyboard's Auto-Correction and Predictive text, so
  typed text arrives exactly. Turn them back on in Settings > General > Keyboard if you like.
- **Free Apple accounts:** the helper must be re-signed about every 7 days (ask Claude to "rebuild the iPhone
  helper"), and it counts as one of the 3 development apps a free account allows.
- **Nothing is uninstalled automatically**, and only the plugin's own helper is ever stopped or restarted.

## Updating

1. In Terminal: `claude plugin marketplace update da-one`, then `claude plugin update iphone-use@da-one` (or
   in Claude Code: type `/plugin`, open the installed plugins, choose iphone-use and Update).
2. Restart Claude Code.
3. Reload the live view tab in your browser (or ask Claude to open the iPhone screen again).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Claude says the iPhone tools are missing, or /mcp shows the iphone server as failed | Ask Claude to run `python3 --version` in the terminal. If it mentions the Xcode license: open Xcode once and click Agree (or run `sudo xcodebuild -license accept` in Terminal), then restart Claude Code. If a window offers to install "command line developer tools", install Xcode from the App Store and open it once instead. This can happen again after Xcode updates itself. |
| No iPhone found | Use a data cable (not charge-only), unlock the iPhone and reconnect it. |
| The iPhone never asked to trust the Mac | Unplug and reconnect while the iPhone is unlocked, then tap **Trust** and enter your passcode. |
| Developer Mode is missing in Settings | Open Xcode > Window > Devices and Simulators with the iPhone connected and unlocked, wait until "Preparing iPhone" finishes, then look again under Settings > Privacy & Security. |
| Signing or team errors during the build | Make sure you are signed in under Xcode > Settings > Accounts, then ask Claude to build again. |
| "Maximum number of apps" | A free account allows about 3 development apps on the iPhone. Remove one you no longer need yourself, or use a paid team. Claude never deletes apps. |
| It stopped working after about 7 days | The free signature expired. Ask Claude to "rebuild the iPhone helper". |
| The Mac asks "codesign wants to access key" | Enter your Mac login password and click **Always Allow**. The build waits for this. |
| The iPhone says "in use by Mac", or the screen looks empty | Quit the iPhone Mirroring app on the Mac and unlock the iPhone. |
| Claude says the iPhone is locked | Unlock it and keep it awake (Settings > Display & Brightness > Auto-Lock can be set longer). |
| The live view is blank or says "Not connected" | Click **Refresh preview**. If that does not help, ask Claude to open the iPhone screen again. |

For anything else, ask Claude to "run iphone_doctor": it checks the Mac, Xcode, the cable and the iPhone and lists
what to do, in order.

## Uninstall

1. In Claude Code: `/plugin uninstall iphone-use@da-one`.
2. Delete the folder `~/.local/share/iphone-use` (in Finder: Go > Go to Folder...).
3. On the iPhone, delete the app "WebDriverAgentRunner" like any other app.

## Credits and license

- MIT license; see [LICENSE](LICENSE).
- Based on ZHONG XIN's MIT-licensed [iPhone-use](https://github.com/zhongerxin/iPhone-use) (a Codex plugin),
  re-implemented for Claude Code.
- Uses Appium [WebDriverAgent](https://github.com/appium/WebDriverAgent) (BSD-3-Clause) as the iPhone helper,
  downloaded during setup.
- Details: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Changes: [CHANGELOG.md](CHANGELOG.md).
- How Claude uses the tools: [iphone-use skill](skills/iphone-use/SKILL.md) and
  [setup skill](skills/iphone-use-setup/SKILL.md).
