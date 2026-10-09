"""The one injectable command runner.

Every macOS-only binary (xcrun, xcodebuild, sips, osascript, ...) is run through a
*runner*: any callable ``runner(argv, timeout=12.0, cwd=None, env=None,
input_text=None) -> CommandResult``. Production code uses :func:`run_command`;
tests inject ``fakes_cmd.FakeRunner``.
"""

import subprocess
from typing import NamedTuple

STDERR_LIMIT = 8000
STDOUT_LIMIT = 4 * 1024 * 1024


class CommandResult(NamedTuple):
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def _text(value) -> str:
    """Normalise captured output (None, bytes or str) to str."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def _trim(stdout, stderr):
    stdout = _text(stdout)[:STDOUT_LIMIT]
    stderr = _text(stderr)
    if len(stderr) > STDERR_LIMIT:
        stderr = stderr[-STDERR_LIMIT:]
    return stdout, stderr


def run_command(argv, timeout=12.0, cwd=None, env=None, input_text=None) -> CommandResult:
    """Run argv and capture its output. Never raises for process problems.

    A missing binary or other OSError gives returncode 127; a timeout gives 124.
    stdin is never inherited from the MCP process: it is /dev/null unless
    input_text is given.
    """
    argv = list(argv)
    program = str(argv[0]) if argv else ""
    try:
        completed = subprocess.run(
            argv,
            input=input_text,
            stdin=(None if input_text is not None else subprocess.DEVNULL),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout,
            cwd=cwd,
            env=env,
            check=False,
            close_fds=True,
        )
    except subprocess.TimeoutExpired as exc:
        stdout, _ = _trim(exc.stdout, "")
        return CommandResult(124, stdout, "timed out after %ss" % (timeout,))
    except (OSError, ValueError) as exc:
        reason = getattr(exc, "strerror", None) or str(exc) or type(exc).__name__
        return CommandResult(127, "", "%s: %s" % (program, reason))
    stdout, stderr = _trim(completed.stdout, completed.stderr)
    return CommandResult(completed.returncode, stdout, stderr)
