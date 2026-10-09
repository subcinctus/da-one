---
name: iphone-use-setup
description: Set up or reconnect iPhone Use - install and sign the on-iPhone helper (WebDriverAgent) with Xcode, start it, and fix USB, trust, Developer Mode, signing or connection problems. Use for first-time setup, when iphone_ready says the service is not running or needs recovery, when the weekly free-account signature has expired, or when the user asks to connect their iPhone.
---

# iPhone Use setup

The phone tools need a small helper app (WebDriverAgent) running on the user's iPhone, built and signed on this
Mac with the user's own Apple account. This skill installs, starts and repairs it. Call it "the iPhone helper"
when you talk to the user; they are not a developer.

## 1. Goal

End in one of two states, and say which:
- **READY**: `iphone_ready` returned `ready=true`. Then call `iphone_screen(action=open)` once, give the user the
  link, and continue with their original request.
- **NEEDS_USER_ACTION**: one exact step only the user can do (what, where, why), and what you will do after.

Until `iphone_ready` returns `ready=true`, the phone is not ready, whatever else looks fine ("BUILD SUCCEEDED",
the helper's icon on the iPhone, an open port).

## 2. Golden rules

- Start with `iphone_setup(action=status)`. Reuse a working setup, an existing build and running jobs. Never
  rebuild or reinstall per task.
- Poll background jobs with `iphone_setup(action=status, job_id=<id>, wait_seconds=20)`. It returns early when
  something changes. No Bash `sleep`, no fixed loops.
- `jobs` is always an **array**, even with `job_id`. Find your job by `id`.
- A start job stays `state=running` for as long as the helper serves; it never "succeeds". Call `iphone_ready`
  once `service.ready=true`.
- Never start twice. Never rebuild just because the helper stopped; `start` reuses the build.
- Never kill processes, never uninstall apps, never revoke certificates, never push the user to buy a paid
  developer account, and never copy someone else's device or team identifiers.
- The user does every sign-in, password, verification code, trust prompt and unlock themselves, on the Mac or the
  iPhone. Never ask for or type credentials.
- When you need the user, ask with AskUserQuestion: name the exact screen and button, first option
  "Done, continue", second option "I can't do this now". Continue only on a real "Done, continue". Steps that do
  not depend on the answer may run first.
- Keep the helper reachable only over the USB cable (`network_mode=usb_only`, the default). Never switch to
  `allow_network` without asking the user first (section 7).
- Speak plainly: no UDIDs, team ids, job ids or error codes unless the user asks.
- The device and signing details stay on this Mac, in the private iPhone Use folder; never put them in a project,
  a repository or a chat with someone else.

## 3. Cold start (READY said the helper is not running)

`iphone_ready` returned `service_unreachable` or `not_ready` (with `initialization_required=true`):

1. `iphone_setup(action=status)`: look at `configured`, `built`, `service`, `usb`, `jobs`, `next_steps`.
2. `service.ready=true` already: call `iphone_ready`.
3. An active start or recover job: poll it until `service.ready=true` (start) or `phase=serving` (recover), then
   `iphone_ready`.
4. Configured, nothing running: `iphone_setup(action=start)` once, poll the job, then `iphone_ready`.
   - `already_ready=true`: a helper already answers; call `iphone_ready`.
   - Only when start reports a missing source, run `fetch`; only when it reports a missing or outdated build
     (`built=false`, an expired signature, a configuration change), run `build`. Then start once.
5. Not configured: first-time setup (section 4), only the missing items.
6. A job failed: read its `error`, `log_errors`, `log_tail` and `next_steps`
   ([troubleshooting](references/troubleshooting.md)). Do not loop on start.

## 4. First-time setup

1. `iphone_doctor`. It is read-only and returns `healthy`, `checks` and a numbered `next_steps` list.
2. Walk the user through the items it reports, one at a time, using
   [first-time setup](references/first-time-setup.md): full Xcode (opened once, with its iOS component), the
   Apple account in Xcode > Settings > Accounts, the cable and "Trust This Computer", Developer Mode, and
   Settings > Developer > Enable UI Automation. Ask with AskUserQuestion after each step that needs them.
3. `iphone_setup(action=discover)`: confirm the iPhone is listed, paired and in Developer Mode.
4. `iphone_setup(action=configure)` with no arguments. It fills in the only connected iPhone, the only Apple team
   and a new unique bundle ID by itself.
   - `config_choice_required`: several iPhones or teams. Ask the user which one (AskUserQuestion, using the names
     from `choices`), then configure with that `udid` or `team_id`.
   - `prerequisite_missing`: no iPhone connected, or no team signed in to Xcode. Help the user, then configure
     again.
5. `iphone_setup(action=fetch)`, poll until `succeeded`. It downloads the pinned WebDriverAgent into the private
   folder (it needs internet access to GitHub).
6. `iphone_setup(action=build)`, poll until `succeeded`. A first build takes a few minutes. Warn the user first:
   the Mac may show "codesign wants to access key ... in your keychain"; they enter their Mac login password and
   click **Always Allow**. If status shows the build silent for over a minute (`stalled_seconds`), that dialog
   is probably waiting.
7. If the iPhone says the developer is not trusted: the user opens Settings > General > VPN & Device
   Management, taps the "Apple Development" entry and taps Trust.
8. `iphone_setup(action=start)`, poll until `service.ready=true`, then `iphone_ready`.
9. Then `iphone_screen(action=open)`, give the link, and explain the permission prompts once (section 9).

## 5. Weekly re-signing (free Apple account)

- A free Apple account ("Personal Team") signs the helper for about 7 days and allows about 3 development apps
  on the iPhone; the helper counts as one.
- Tell the user up front, in plain words: about once a week the helper must be re-signed, and you can do it.
- When doctor, start or READY reports an expired profile (`checks.profile_valid=false`, or a build or start
  error about expiry): `iphone_setup(action=build)`, then `iphone_setup(action=start)`, then `iphone_ready`.
- "Maximum number of apps": tell the user the limit. They decide whether to remove another development app
  themselves or use another team. Never delete apps.

## 6. Recovery

Connection faults, restarts in progress, cooldowns and iPhone Mirroring conflicts:
[recovery](references/recovery.md).

## 7. USB-only connection and the network setting

- By default the helper is restricted to the iPhone itself: the Mac reaches it over the USB cable, and devices
  on the Wi-Fi cannot. `iphone_setup(action=status)` and `iphone_doctor` report this in `network`
  (`mode`, `control_port`, `screen_stream`, each `usb_only` or `network`).
- If a start job's `next_steps` says the helper started but the Mac cannot reach it over USB while it is
  restricted to the iPhone, explain the trade-off in plain words and **ask with AskUserQuestion** whether to
  allow network access while the helper runs. Only if the user agrees:
  `iphone_setup(action=stop)`, then `iphone_setup(action=configure, network_mode="allow_network")`, then
  `iphone_setup(action=build)`, then `iphone_setup(action=start)`. If they decline, stop and report the blocker.
- Changing `network_mode` or the ports needs a new build before start (`built=false` until then).

## 8. When the user is done

- Offer to stop the helper with `iphone_setup(action=stop)` when the user is done for the day. Stop affects
  only jobs this plugin started and never uninstalls anything.
- If `network.control_port` or `network.screen_stream` is `network` while it runs, say clearly that devices on
  the same Wi-Fi can reach it until it is stopped.

## 9. Permissions

- Explain once: Claude Code asks before each iPhone tool runs. The user may choose "Yes, and don't ask again"
  for tools they are comfortable with, or add the allowlist from the plugin's README to their settings.
- That decision is the user's. Never edit permission settings yourself.

## 10. Troubleshooting

- Symptom table and fixes: [troubleshooting](references/troubleshooting.md).
- If no `iphone_*` tools exist even after ToolSearch (query `iphone`), run `python3 --version` with Bash first;
  an Xcode license or "command line developer tools" message means the plugin could not start.

## References

- [first-time-setup.md](references/first-time-setup.md) - the plain-English checklist for the user.
- [recovery.md](references/recovery.md) - restarts, cooldowns, manual restarts, iPhone Mirroring.
- [troubleshooting.md](references/troubleshooting.md) - symptoms, checks and fixes.
