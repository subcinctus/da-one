# Command-line fallback

Use this only when the iPhone Use tools are really unavailable in this conversation. It runs the same code with
the same settings, the same shared session and the same one-at-a-time lock as the tools.

## First, check the tools

1. Load them with ToolSearch (query `iphone`). Claude Code may hide MCP tools until they are searched for. Do
   not decide from documentation or an earlier chat that they are missing.
2. If no `iphone_*` tools exist even after ToolSearch, run `python3 --version` with Bash first. A message about
   the Xcode license agreement, or a window offering to install "command line developer tools", means the plugin
   could not start (see the iphone-use-setup skill's troubleshooting), not that the phone failed. The fallback
   below will not work until that is fixed.
3. If the plugin was just installed or updated, the user may need to restart Claude Code (or run `/mcp` to
   reconnect the server). Ask them to do that before using the fallback.
4. Use the fallback only when a needed tool is still missing or its binding is broken. Never switch to it by
   default.

## Running a tool from Bash

```sh
python3 "<plugin root>/scripts/phone.py" iphone_observe '{"mode":"screenshot"}'
```

- `<plugin root>` is two levels above this skill's base directory (Claude Code prints the skill's base
  directory when it loads the skill, ending in `skills/iphone-use`). Use that installed location; never copy a
  path from somewhere else.
- The first argument is the tool name (any of the 17), the second the JSON arguments (optional for tools without
  required arguments), for example
  `python3 "<plugin root>/scripts/phone.py" iphone_press_button '{"name":"home"}'`.
- It prints one line of JSON, the same envelope as the tool (`ok`, `error`, ...). The exit code is 1 when
  `ok=false`, and also for `iphone_ready` when `ready` is not true.
- Screenshots are not shown inline: open `image.path` (or `error.observation.image.path`) with the Read tool and
  convert pixels with `image.pixel_to_point`.
- Bash and Read outside the project may ask the user for permission. That is expected for a fallback.

## Rules

- Continue **the same authorized step**; do not start over and do not repeat steps that already ran.
- The same rules apply: never repeat uncertain actions, never type credentials, confirm money-moving steps.
- Each command is a separate process. An `observation_id` from one command is unknown to the next (it would give
  `stale_observation`), so leave `observation_id` out and tap by coordinates you just read.
- A `continue_token` cannot be resumed by a later command either. If long text stops with
  `input_complete=false`, read the field's text and type only the missing part with `replace=false`.
- The fallback cannot start the preview page: `iphone_screen` here only reports a page that the plugin already
  serves. The user can keep using an already open preview tab.
- Do not pass `--state-dir` or `--url` unless the normal setup really uses a non-default folder or address.
  Never change them to get around `device_busy`, and never operate the same iPhone from two places at once.
- A bug in the plugin is not fixed by switching entry points. Act on the actual error.
