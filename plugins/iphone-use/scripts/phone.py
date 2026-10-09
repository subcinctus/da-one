#!/usr/bin/env python3
"""Command-line fallback for the iPhone Use tools (same Runtime, same lock, same session).

    python3 scripts/phone.py iphone_observe '{"mode":"screenshot"}'

Prints one compact JSON envelope ({"ok": ...}) on one line; screenshots appear as
image paths (open them with an image viewer or Claude Code's Read tool). The exit code is
1 when ok is false, or for iphone_ready when ready is not true; otherwise 0.
"""

import argparse
import json
import os
import sys

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(PLUGIN_ROOT, "server")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from errors import ToolError  # noqa: E402
from mcp_schemas import TOOL_NAMES  # noqa: E402
from runtime import Runtime  # noqa: E402

ARGUMENTS_MESSAGE = "The tool arguments must be one JSON object, for example '{\"mode\":\"tree\"}'."


def _reject_constant(name):
    raise ValueError("non-finite number %s" % name)


def parse_arguments(text):
    """The JSON arguments (NaN and Infinity rejected); raises ToolError("invalid_argument")."""
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise ToolError("invalid_argument", ARGUMENTS_MESSAGE,
                        details={"action_executed": False, "argument_path": "arguments"}) from None


def emit(envelope):
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def exit_code(tool, envelope) -> int:
    if envelope.get("ok") is not True:
        return 1
    if tool == "iphone_ready" and envelope.get("ready") is not True:
        return 1
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="phone.py", description="Run one iPhone Use tool from the shell.")
    parser.add_argument("tool", choices=TOOL_NAMES, help="tool name, e.g. iphone_observe")
    parser.add_argument("arguments", nargs="?", default="{}", help="JSON object with the tool arguments")
    parser.add_argument("--state-dir", help="private data folder (default ~/.local/share/iphone-use)")
    parser.add_argument("--url", help="explicit loopback WebDriverAgent URL")
    options = parser.parse_args(argv)
    try:
        args = parse_arguments(options.arguments)
        runtime = Runtime(state_dir=options.state_dir, wda_url=options.url, serve_preview=False)
    except ToolError as exc:
        envelope = {"ok": False, "error": exc.as_dict()}
        emit(envelope)
        return exit_code(options.tool, envelope)
    try:
        envelope = runtime.execute(options.tool, args)
    finally:
        runtime.close()
    emit(envelope)
    return exit_code(options.tool, envelope)


if __name__ == "__main__":
    sys.exit(main())
