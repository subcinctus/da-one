# Recovery: restarts, cooldowns and iPhone Mirroring

## Connection faults

The triggers are faults of the automation connection, not of an app: `foreground_unavailable`, an app id that
starts with `local.pid.`, "Not authorized for performing UI testing actions", or `XCTDaemonErrorDomain Code=41`.
Results with `error.category=channel_runtime` carry `recovery.next_tool=iphone_ready`.

- Do not change selectors or press buttons again. Call `iphone_ready` (with `recover=true` unless the user
  forbade restarts).
- READY first refreshes the session and reads the screen again once (`recovery.state=read_recovered` on
  success). Only a persistent fault queues one restart of the helper that **this plugin started**, with the same
  configuration and build.
- The failed tap, typing or send is never repeated. Old observations and coordinates are void afterwards.
- `service.ready=true` alone does not prove the phone can be operated; only `iphone_ready` does.

## state=recovering

`iphone_ready` returned `ok=true`, `ready=false`, `state=recovering`:

1. Note `recovery.job_id`.
2. Poll with `recovery.status_tool` and `recovery.status_arguments`, that is
   `iphone_setup(action=status, job_id=<id>, wait_seconds=20)`. Find the job in the `jobs` array by id.
3. Follow its `phase`: stopping, then starting, then serving. Do not wait for `succeeded` (a serving job keeps
   running), do not start again, and do not use fixed waits.
4. At `phase=serving`, call `iphone_ready` again and reuse its new observation.
5. If the job fails, read its `error`, `log_errors` and `next_steps` ([troubleshooting](troubleshooting.md)).

## state=recovery_required

`reason=recovery_disabled`: this READY used `recover=false`, so nothing was restarted.
- Only if the user's instructions allow a restart, call `recovery.next_tool` with `recovery.next_arguments`
  (`recover=true`) once.
- If the user forbade restarts or asked for a read-only check, report the blocker and keep the restriction.
  Never flip it to true on your own.

## recovery_not_started

The automatic restart was not started. `recovery.state` says why:

- **cooldown**: a restart already happened in the last 120 seconds (2 minutes). Wait at least
  `recovery.retry_after_seconds` (a status poll with `wait_seconds` is a good way to wait), check the recent
  recovery job's log in `iphone_setup(action=status)`, then call `iphone_ready` once. Never restart in a loop.
- **manual**: the running helper was not started by this plugin (for example from Xcode or another tool), its
  ownership cannot be verified, the iPhone port is held by another service, or the build is missing. Leave the
  existing helper alone and follow `recovery.next_steps`.

A manual restart of **this plugin's own** helper, when it is truly needed:
1. `iphone_setup(action=status)`: find the active start (or recover) job.
2. `iphone_setup(action=stop)` (or with that `job_id`).
3. Confirm it stopped: `exited` is true for the job, and a status call shows no active job.
4. `iphone_setup(action=start)` once, poll it until `service.ready=true`, then `iphone_ready`.

Never kill processes by port, and never point the data folder somewhere else to get around the ownership check.
`unverified_jobs_preserved` in a stop result lists jobs that could not be proven to be this plugin's; they were
left alone.

## The authorization error keeps coming back

If "Not authorized for performing UI testing actions" persists after a restart, ask the user to check, on the
unlocked iPhone:
- Settings > Privacy & Security > Developer Mode is On;
- Settings > Developer > Enable UI Automation is On;
- any trust or authorization prompt on the iPhone is accepted (the user does it).

Do not keep pressing buttons or restarting.

## iPhone Mirroring conflict

A `mirroring_conflict` error, an empty Settings tree, or an iPhone lock screen saying it is in use by the Mac,
means iPhone Mirroring on the Mac is holding the iPhone.
- Ask the user to quit the iPhone Mirroring app on the Mac (and unlock the iPhone if needed), then call
  `iphone_ready`.
- A running iPhone Mirroring app alone is not a conflict: READY refuses only when the screen tree is empty and
  iPhone Mirroring runs.
- The phone connection does not depend on the iPhone Mirroring window; do not follow "lock the iPhone for
  Mirroring" steps.

## Not a recovery case

- An app asking the user to sign in again is not a connection fault. It needs the user (see the iphone-use
  skill's authentication guidance), not a build, start or restart.
- A blank or frozen live preview is not a reason to restart anything.
