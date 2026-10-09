# Startup: READY, starting the helper, channel recovery

## When to run READY

- Run `iphone_ready(recover=true)` as the first phone step of each conversation. Keep `screenshot=false` unless
  you need to see the screen at once; text tasks still get every check (service, unlock, session, screen tree,
  screen size) without an extra image.
- If READY already succeeded in this conversation and nothing has failed since, reuse it. Do not re-check before
  every step or task, and do not repeat doctor, discover, build or start for each task.
- Use `recover=false` only when the user explicitly forbids restarts or asks for a read-only check. Never use it
  "to be careful", and never switch it back to true against the user's wish.
- None of these replaces READY in this conversation: success in an earlier chat, a fresh install, an open
  preview, the helper's icon on the iPhone, "BUILD SUCCEEDED" in a log, or an open port.

## What iphone_ready returns

| Result | What it means | What to do |
| --- | --- | --- |
| `ok=true`, `ready=true`, `state=ready` | The phone can be operated now. `proof` lists what was checked; `observation` is the current screen; `preview.url` is the live preview link. | Plan the next step from `observation`; do not observe again straight away. Call `iphone_screen(action=open)` once and give the user the link. |
| `ready=true` plus `recovery.state=read_recovered` | A stale connection was refreshed and the screen was read again once. Nothing was repeated. | Continue from this observation. Earlier observations, coordinates and element positions are void. |
| `ok=true`, `ready=false`, `state=recovering` | This plugin's own helper is restarting in the background. Not an error, but the phone cannot be operated yet. | Poll the job (see "Channel recovery"), then `iphone_ready` again. |
| `ok=true`, `ready=false`, `state=recovery_required`, `reason=recovery_disabled` | A restart is needed, but this call had `recover=false`. Nothing was restarted. | Only if the user allows restarts: call `recovery.next_tool` with `recovery.next_arguments` once. Otherwise tell the user what is blocked and keep their restriction. |
| error `service_unreachable` or `not_ready`, with `initialization_required=true` | The helper is not running yet, or not accepting commands yet. This is a setup step, not a failed task. | Follow "Cold start" below (`recovery.next_tool` is `iphone_setup` with `{"action": "status"}`). |
| error `phone_locked` | The iPhone is locked. The preview is already paused. | Ask the user to unlock it (see [authentication](authentication.md)), then `iphone_ready`. |
| error `mirroring_conflict` | iPhone Mirroring on the Mac is holding the iPhone and the screen tree is empty. | Ask the user to quit the iPhone Mirroring app on the Mac (and unlock the iPhone if needed), then `iphone_ready`. |
| error `recovery_not_started` | An automatic restart was not started (cooldown, or the helper was not started by this plugin). | See "Channel recovery" below. |
| error `config_invalid` or `state_dir_unsafe` | The saved setup cannot be used. | Load the iphone-use-setup skill. |

`recovering` and `recovery_required` are normal results with `ok=true` and no `error`, yet the phone is still
not operable. Only `ready=true` permits phone actions.

## Cold start: the helper is not running

`recover=true` never starts a stopped helper. You start it once, through setup.

1. Call `iphone_setup(action=status)`. Look at `configured`, `built`, `service`, `usb`, `jobs` and
   `next_steps`.
   - `jobs` is always an **array**, even when you pass `job_id`. Find your job by its `id`; ignore old,
     unrelated jobs.
2. If `service.ready=true` already, skip starting and call `iphone_ready`.
3. If a start or recover job is active (`state` queued or running), note its `id` and poll it with
   `iphone_setup(action=status, job_id=<id>, wait_seconds=20)`.
   - A start job stays `state=running` for as long as the helper serves; it never reaches `succeeded`. Call
     `iphone_ready` as soon as `service.ready=true` (the job's `phase` is then `serving`).
   - A recover job moves through `phase` stopping, starting and serving. At `phase=serving`, call
     `iphone_ready`.
   - A running fetch or build job: poll it until `succeeded`, then do the remaining steps.
4. If `configured=true`, the helper is not ready, and no job is active, call `iphone_setup(action=start)`
   **once**. It reuses the existing signed build.
   - It returns `job_id` (or `already_running=true` with `job_id`): poll that job as in step 3.
   - `already_ready=true`: a helper is already answering; call `iphone_ready`. This plugin does not own or stop
     a helper it did not start.
   - `prerequisite_missing` asking for a build (for example `built=false` after a configuration change, or an
     expired signature on a free Apple account): `iphone_setup(action=build)`, poll it until it succeeds, then
     start once.
   - `prerequisite_missing` saying the WebDriverAgent source is missing: `fetch`, then `build`, then `start`.
   - Other `prerequisite_missing` messages (cable, unlock, Xcode): follow `next_steps`; they usually need the
     user.
5. If `configured=false`, load the iphone-use-setup skill and complete only the missing items.
6. When `iphone_ready` returns `ready=true`, reuse its observation and carry on with the user's task.

Rules for this branch:
- Poll with `wait_seconds` (up to 25): the call returns early as soon as a job or the service changes. Never use
  Bash `sleep`, long fixed waits or a fixed number of blind polls.
- Never start twice. Never rebuild, re-sign or reinstall just because the helper stopped.
- If a job failed, read that job's `error`, `log_errors`, `log_tail` and `next_steps`. Do not loop on start;
  explain the blocker to the user in plain words.
- A start job may add a `next_steps` entry saying the helper started but the Mac cannot reach it over USB while
  it is restricted to the iPhone. Do not change anything yourself: the iphone-use-setup skill asks the user
  first.
- A blank live preview while the helper starts proves nothing either way.
- Report a blocker only when a missing item really needs the user, or startup genuinely failed.

## Channel recovery

Channel faults are faults of the automation connection, not of the app: `foreground_unavailable`, an app id that
starts with `local.pid.`, or "Not authorized for performing UI testing actions" (XCTest code 41). Results with
`error.category=channel_runtime` carry `recovery.next_tool=iphone_ready`. A new selector or another button press
cannot fix them, and `service.ready=true` alone does not prove the phone can be operated.

- Call `iphone_ready` (keep `recover=true` unless the user forbade restarts). It first refreshes the session and
  reads the screen again once; on success the result has `recovery.state=read_recovered`. Only a persistent
  fault queues one restart of the helper this plugin started, with the same configuration and build.
- `state=recovering`: note `recovery.job_id`; poll with `recovery.status_tool` and `recovery.status_arguments`
  (that is `iphone_setup(action=status, job_id=<id>, wait_seconds=20)`), find the job in `jobs` by id, and wait
  for `phase=serving`. Then call `iphone_ready` again. Do not start again and do not wait for `succeeded`.
- `state=recovery_required` (`recover=false` was used): see the table above.
- `recovery_not_started`:
  - `recovery.state=cooldown`: a restart already happened within the last 2 minutes. Wait at least
    `recovery.retry_after_seconds` (a status poll with `wait_seconds` is a good way to wait), then call
    `iphone_ready` once. Never restart in a loop.
  - `recovery.state=manual`: the running helper was not started by this plugin, or something else makes an
    automatic restart unsafe. Leave that helper alone and follow `recovery.next_steps`. A manual restart of this
    plugin's own helper is: status, then `iphone_setup(action=stop)`, confirm it stopped, then
    `iphone_setup(action=start)` once.
  - Never kill processes and never change the data folder to get around these checks.
- If the authorization error returns after a restart, ask the user to check, on the unlocked iPhone,
  Settings > Privacy & Security > Developer Mode and Settings > Developer > Enable UI Automation.
- An app asking the user to sign in again is not a channel fault: it needs the user (see
  [authentication](authentication.md)), not a restart.

## After any recovery

- Nothing is ever repeated for you. Recovery restores the connection only; it never replays the failed tap,
  typing, send or batch.
- Read the fresh observation to see how far the task got, then continue only what is missing. Old observation
  ids and coordinates are void.
- The user's restrictions ("read only", "don't start", "don't restart") still apply after recovery.
