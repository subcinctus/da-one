# Troubleshooting

Find the symptom, check the cause, then do the fix. Things only the user can do (sign-ins, trust prompts,
unlocking, Mac password dialogs) are explained to them step by step and confirmed with AskUserQuestion.

## The plugin itself

| Symptom | Check first | What to do |
| --- | --- | --- |
| Claude says the iPhone tools are missing, or /mcp shows the iphone server as failed | Ask Claude to run `python3 --version` in the terminal | If it mentions the Xcode license: open Xcode once and click Agree (or run `sudo xcodebuild -license accept` in Terminal), then restart Claude Code. If a window offers to install "command line developer tools", install Xcode from the App Store and open it once instead. This can happen again after Xcode updates itself. |
| The tools were just installed or updated but are not available | Was Claude Code restarted? | Restart Claude Code (or run `/reload-plugins`, or reconnect with `/mcp`). Use ToolSearch with the query `iphone` and max_results 20 before deciding the tools are missing. |
| `state_dir_unsafe` | Is `IPHONE_USE_STATE_DIR` set to a folder inside a Git project? | Remove that setting or point it at a private folder outside any project. The default folder `~/.local/share/iphone-use` is always accepted. |

## USB and the connection to the iPhone

| Symptom | Check first | What to do |
| --- | --- | --- |
| The Mac's USB device service is not reachable (`reason` `usbmuxd_unavailable`) | Is the iPhone plugged in? Is `USBMUXD_SOCKET_ADDRESS` set in the environment? | Unplug and reconnect the iPhone. Remove a stray `USBMUXD_SOCKET_ADDRESS` setting. If it persists, restart the Mac. |
| The iPhone is not listed (`reason` `device_not_found`), or "not connected over USB" although Finder or Xcode shows it | A data cable (not charge-only)? iPhone unlocked? "Trust This Computer" accepted? Only connected over Wi-Fi? | Reconnect the cable, unlock the iPhone, tap Trust and enter the passcode on the iPhone. An iPhone seen only over Wi-Fi does not count: iPhone Use works over the USB cable. Then `iphone_setup(action=discover)`. Make sure it is the intended iPhone. Do not turn on network access for this. |
| Nothing is listening on the iPhone (`reason` `connection_refused`) | `iphone_setup(action=status)`: is a start job running? | The helper is not running. Start it once (`iphone_setup(action=start)`), poll until `service.ready=true`, then `iphone_ready`. |
| "port 8100 already in use", or the log says `failed to start web server on port` | Was the helper also started from Xcode or another tool? | Another copy of the helper already runs on the iPhone. If `iphone_ready` works, reuse it. Otherwise stop it from where it was started. Never kill processes. |
| A start job's `next_steps` says the helper started but the Mac cannot reach it over USB while it is restricted to the iPhone | `iphone_setup(action=status)`: `network.mode` is `usb_only` | By default the helper only accepts connections over the USB cable, which keeps it off the Wi-Fi. On some setups the Mac cannot reach it that way. Explain the trade-off in plain words and ask the user with AskUserQuestion. Only if they agree: `iphone_setup(action=stop)`, then `iphone_setup(action=configure, network_mode="allow_network")`, then `iphone_setup(action=build)`, then `iphone_setup(action=start)`. Tell them devices on the same Wi-Fi can then reach the helper while it runs, and offer to stop it when they are done. If they decline, report the blocker. |
| A web page, or a tool other than iPhone Use, gets "The request could not be parsed as valid HTTP" from the helper | Does the request come from a web page, or use an address other than 127.0.0.1 or localhost? | Expected: the helper also refuses requests from web pages open on the iPhone, and requests addressed to any name other than 127.0.0.1 or localhost; iPhone Use never sends those. Apps installed on the iPhone can still reach the helper while it runs, so offer to stop it with `iphone_setup(action=stop)` when the user is done. |
| The build succeeded but the helper is unreachable | `iphone_setup(action=status)`: start job, `service`, `usb` | "BUILD SUCCEEDED" is not READY. Start the helper (once), poll, then `iphone_ready`. |
| The helper answers but the session or screen read fails | The `error` of `iphone_ready`, then status | Run `iphone_ready` (it refreshes the session). If it persists, see [recovery](recovery.md). |

## Xcode, iOS and Developer Mode

| Symptom | Check first | What to do |
| --- | --- | --- |
| Xcode not installed, license not accepted, or first-launch components missing | `iphone_doctor`: `checks.full_xcode`, `xcode_version`, `developer_dir` | The user installs the full Xcode, opens it once, clicks Agree and lets it install components, then run `iphone_doctor` again. The Command Line Tools alone cannot build the helper. |
| Only the Command Line Tools are selected (`requires xcode, but active developer directory`) | `developer_dir` starts with `/Library/Developer/CommandLineTools` | The user runs `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` in Terminal and types their Mac password themselves. |
| A build says "iOS ... is not installed. To use with Xcode, first download and install the platform" | Xcode > Settings > Components | Xcode is missing its iOS component. Open Xcode > Settings > Components, click Get next to iOS, wait until it finishes, then `iphone_setup(action=build)` again. |
| The iPhone's iOS is newer than Xcode supports (`is not supported by this version of Xcode`, developer disk image errors) | iOS version (discover) and Xcode version (doctor) | Update Xcode from the Mac App Store, open it once, then build again. If the App Store offers no newer Xcode, this Mac's macOS is too old for the iPhone's iOS: update macOS first. Never retry the same build endlessly. |
| "Unable to find a destination matching" | Xcode > Window > Devices and Simulators | Xcode cannot see the iPhone right now. Reconnect, unlock, check Trust, and wait until "Preparing iPhone" finishes. Then build again. |
| Developer Mode is off | discover: `developer_mode` | The user turns on Settings > Privacy & Security > Developer Mode, lets the iPhone restart, then taps Turn On. Then `iphone_setup(action=discover)` and start. |
| Developer Mode is not listed in Settings | Has Xcode prepared this iPhone yet? | Open Xcode > Window > Devices and Simulators with the iPhone connected and unlocked, wait until "Preparing iPhone" finishes, then look again. |
| "Timed out while enabling automation mode" | Settings > Developer on the iPhone | The user turns on Settings > Developer > Enable UI Automation, then start again. |

## Signing and the Apple account

| Symptom | Check first | What to do |
| --- | --- | --- |
| "Signing requires a development team", "No signing identity", "no accounts" | Xcode > Settings > Accounts | The user signs in (or refreshes the account) in Xcode themselves. Then `iphone_setup(action=configure)` and build. Never put a password anywhere. |
| "Bundle identifier cannot be registered", "No profiles", "is not available" | The configured `bundle_id` | Configure a new unique `bundle_id` (for example the generated pattern with another random part), then build. The installed helper's ID ends in `.xctrunner`. |
| "Maximum number of apps for free development profiles" | How many development apps are on the iPhone | A free account allows about 3. Tell the user the limit; they decide whether to remove an unneeded development app themselves or use another team. Never delete apps or push a paid account. |
| The profile or certificate expired; the helper no longer launches | `iphone_doctor`: `checks.profile_valid`, `provisioning` | Free accounts need re-signing about every 7 days: `iphone_setup(action=build)`, then start, then `iphone_ready`. Restarting alone is not enough. |
| "Untrusted developer", "Unable to verify app", invalid code signature | The iPhone's VPN & Device Management screen | The user opens Settings > General > VPN & Device Management, taps the "Apple Development" entry and taps Trust (an internet connection is needed for verification). Never revoke certificates. |
| The build sits silent for over a minute (`stalled_seconds` > 60), or the log mentions `errSec` or "user interaction is not allowed" | A dialog on the Mac: "codesign wants to access key" | The user enters their Mac login password and clicks Always Allow. The build then continues. |
| "The request was denied by service delegate" | Is the iPhone locked? Is the developer app trusted? | The user unlocks the iPhone and trusts the developer app (above), then start again. |
| fetch fails with "could not resolve host", "unable to access" or "failed to connect to github.com" | Internet connection, proxy | The Mac could not reach GitHub to download WebDriverAgent. Fix the connection or proxy, then fetch again. |
| build or start says the plugin's own WebDriverAgent copy "has an older or incomplete version of its safety settings" | Was the plugin updated, or a fetch stopped? | Run `iphone_setup(action=fetch)` (it updates only the plugin's own copy), then `iphone_setup(action=build)` and `iphone_setup(action=start)`. |

## While using the phone

| Symptom | Check first | What to do |
| --- | --- | --- |
| `phone_locked` | Is the iPhone locked? | The user unlocks it and keeps it awake; then `iphone_ready`. Do not pause the preview on top. |
| `mirroring_conflict`, an empty Settings tree, or "iPhone in use by Mac" on the lock screen | Is iPhone Mirroring open on the Mac? | The user quits iPhone Mirroring (and unlocks the iPhone if needed); then `iphone_ready`. |
| An app id starting with `local.pid.`, or `foreground_unavailable` | Can READY read the app in front? | `iphone_ready`: one session refresh, then a tracked restart if it persists. Old observations are void. |
| "Not authorized for performing UI testing actions" (XCTest code 41) | Developer Mode and Enable UI Automation on the iPhone | `iphone_ready` handles the restart. If it persists, the user checks the unlock, Developer Mode, Enable UI Automation and trust prompts. Do not keep pressing buttons. |
| `ready=false`, `state=recovering` | The status and log of `recovery.job_id` | Normal. Poll that job until `phase=serving`, then `iphone_ready`. Never start again or wait for `succeeded`. |
| `ready=false`, `state=recovery_required` | Did this call use `recover=false`? Did the user forbid restarts? | If restarts are allowed, call `recovery.next_tool` with `recovery.next_arguments` once; otherwise report the blocker. |
| `recovery_not_started` with cooldown or manual | `recovery.state`, `retry_after_seconds` | Cooldown: wait, then `iphone_ready` once. Manual: follow `recovery.next_steps` ([recovery](recovery.md)). Never kill by port. |
| `device_busy` | Is another Claude Code window using the iPhone? | Wait for it to finish, then try again. Never work around the lock. |
| A timeout after a tap, typing or send | The page, field or message in the next observation | It may have happened. Look before continuing; never repeat it automatically. |
| `action_executed=true` with `action_complete=false` | The real state after the accepted part | Read back first; never repeat the whole input, send or batch. |
| The app asks for a sign-in, password, code or Face ID | The app's prompt | The user completes it (the iphone-use skill's authentication steps). READY does not mean the app is signed in; no restart is needed. |
| The helper works but the tree has no content or labels are not found | Custom-drawn, protected or truncated page | Use the attached screenshot and tap by x/y. For typing, tap the field, then type without a selector. |
| The live preview is blank or says "Not connected" | Do the phone tools work? | Phone tools working is what matters. The user can click Refresh preview; if the tab is from an older session, open the preview again (`iphone_screen(action=open)`). Never restart the helper for the preview. |

## Support from Terminal

If the user wants to send diagnostics to someone, they can run the setup check in Terminal; it prints one JSON
result and changes nothing:

```sh
python3 "<plugin root>/server/wda_setup.py" doctor
```

`<plugin root>` is two levels above this skill's base directory. The output contains the iPhone's identifier and
the Apple team ID; tell the user before they share it.
