"""Test helpers: a fake command runner, a fake clock and fake executables.

FakeRunner implements the runner protocol of cmdrunner (``runner(argv, timeout=12.0,
cwd=None, env=None, input_text=None) -> CommandResult``) so tests can stand in for
macOS-only tools such as xcrun, xcodebuild or sips on any platform.
"""

import base64
import collections
import json
import os
import sys
import threading
import time as _real_time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from cmdrunner import CommandResult  # noqa: E402

# A 313-byte 39x84 baseline JPEG (SOF0), starts FFD8FFE0 and ends FFD9.
TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNi"
    "UFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8"
    "fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCABUACcDASIAAhEBAxEB/8QAFQABAQAAAAAA"
    "AAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEA"
    "AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYBUTQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q=="
)

Call = collections.namedtuple("Call", "argv timeout cwd env input_text")


class _Rule:
    def __init__(self, program, args, returncode, stdout, stderr, effect, times):
        self.program = program
        self.args = list(args)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.effect = effect
        self.remaining = times  # None = unlimited

    def matches(self, argv):
        if self.remaining is not None and self.remaining <= 0:
            return False
        if not argv or os.path.basename(str(argv[0])) != self.program:
            return False
        return [str(a) for a in argv[1:1 + len(self.args)]] == self.args


def _as_result(value):
    if isinstance(value, CommandResult):
        return value
    returncode, stdout, stderr = value
    return CommandResult(int(returncode), str(stdout), str(stderr))


class FakeRunner:
    """Scriptable stand-in for cmdrunner.run_command.

    ``runner.on("xcrun", "devicectl", stdout="...")`` adds a rule; the most recently
    added matching rule with uses left answers. Every call is recorded in ``calls``.
    """

    def __init__(self):
        self.calls = []
        self._rules = []
        self._lock = threading.Lock()

    def on(self, program, *args, returncode=0, stdout="", stderr="", effect=None, times=None):
        rule = _Rule(program, [str(a) for a in args], returncode, stdout, stderr, effect, times)
        with self._lock:
            self._rules.append(rule)
        return self

    def __call__(self, argv, timeout=12.0, cwd=None, env=None, input_text=None):
        argv = [str(a) for a in argv]
        with self._lock:
            self.calls.append(Call(list(argv), timeout, cwd, None if env is None else dict(env), input_text))
            rule = None
            for candidate in reversed(self._rules):
                if candidate.matches(argv):
                    rule = candidate
                    break
            if rule is not None and rule.remaining is not None:
                rule.remaining -= 1
        if rule is None:
            program = os.path.basename(argv[0]) if argv else ""
            return CommandResult(127, "", "fake: no rule for %s" % program)
        if rule.effect is not None:
            produced = rule.effect(argv, cwd, env, input_text)
            if produced is not None:
                return _as_result(produced)
        return CommandResult(rule.returncode, rule.stdout, rule.stderr)

    def calls_for(self, program):
        with self._lock:
            return [c for c in self.calls if c.argv and os.path.basename(c.argv[0]) == program]

    def ran(self, program, *args):
        wanted = [str(a) for a in args]
        for call in self.calls_for(program):
            if call.argv[1:1 + len(wanted)] == wanted:
                return True
        return False


def _value_after(argv, flag):
    try:
        index = argv.index(flag)
    except ValueError:
        return None
    if index + 1 >= len(argv):
        return None
    return argv[index + 1]


def json_output_effect(document):
    """Effect that writes json.dumps(document) to the path after "--json-output"."""

    def effect(argv, cwd, env, input_text):
        target = _value_after(list(argv), "--json-output")
        if target is None:
            return CommandResult(64, "", "fake: --json-output path missing")
        if cwd and not os.path.isabs(target):
            target = os.path.join(cwd, target)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(document))
        return None

    return effect


def jpeg_out_effect(data=None):
    """Effect that writes JPEG bytes (default TINY_JPEG) to the path after "--out"."""
    payload = TINY_JPEG if data is None else bytes(data)

    def effect(argv, cwd, env, input_text):
        target = _value_after(list(argv), "--out")
        if target is None:
            return CommandResult(1, "", "fake: --out path missing")
        if cwd and not os.path.isabs(target):
            target = os.path.join(cwd, target)
        with open(target, "wb") as handle:
            handle.write(payload)
        return None

    return effect


def write_fake_executable(bin_dir, name, body, interpreter="/bin/sh"):
    """Write an executable script ``bin_dir/name`` and return its path.

    For Python bodies pass interpreter=sys.executable so the fake runs under the
    same interpreter as the tests.
    """
    os.makedirs(bin_dir, exist_ok=True)
    path = os.path.join(bin_dir, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("#!%s\n%s" % (interpreter, body))
    os.chmod(path, 0o755)
    return path


class FakeClock:
    """Instant clock for tests: patch.object(module, "time", FakeClock()).

    monotonic() and time() return the same advancing value; sleep() advances it
    without waiting (it only yields the GIL so other threads can run).
    """

    def __init__(self, start=1000.0):
        self._now = float(start)
        self._lock = threading.Lock()
        self.sleeps = []

    def monotonic(self):
        with self._lock:
            return self._now

    def time(self):
        with self._lock:
            return self._now

    def perf_counter(self):
        return self.monotonic()

    def sleep(self, seconds):
        seconds = float(seconds)
        if seconds < 0:
            raise ValueError("sleep length must be non-negative")
        with self._lock:
            self.sleeps.append(seconds)
            self._now += seconds
        _real_time.sleep(0)

    def advance(self, seconds):
        with self._lock:
            self._now += float(seconds)
