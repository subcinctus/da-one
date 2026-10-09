import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import pathlib  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import struct  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from unittest import mock  # noqa: E402

import cmdrunner  # noqa: E402
import errors  # noqa: E402
import fakes_cmd  # noqa: E402
import privstate  # noqa: E402
import version  # noqa: E402
from cmdrunner import CommandResult, run_command  # noqa: E402
from errors import ToolError  # noqa: E402
from fakes_cmd import FakeClock, FakeRunner  # noqa: E402


def make_tmpdir(test):
    path = tempfile.mkdtemp(prefix="iu-plat-", dir="/tmp")
    test.addCleanup(shutil.rmtree, path, True)
    return pathlib.Path(path).resolve()


def mode(path):
    return stat.S_IMODE(os.stat(str(path)).st_mode)


class ErrorsAndVersionTests(unittest.TestCase):
    def test_tool_error_as_dict(self):
        error = ToolError("device_busy", "Busy.", details={"action_executed": False, "code": "ignored"})
        self.assertEqual(error.as_dict(), {"code": "device_busy", "message": "Busy.", "uncertain": False,
                                           "action_executed": False})
        self.assertEqual(str(error), "Busy.")
        self.assertIsInstance(error, Exception)

    def test_fail_raises(self):
        with self.assertRaises(ToolError) as caught:
            errors.fail("action_uncertain", "Maybe.", uncertain=True, phase="response")
        self.assertEqual(caught.exception.as_dict(), {"code": "action_uncertain", "message": "Maybe.",
                                                      "uncertain": True, "phase": "response"})

    def test_version(self):
        self.assertEqual(version.VERSION, "0.1.0")
        self.assertEqual(version.PRODUCT, "iphone-use")
        self.assertEqual(version.USER_AGENT, "iphone-use/0.1.0")


class StateDirectoryTests(unittest.TestCase):
    def test_precedence(self):
        tmp = make_tmpdir(self)
        env = {"IPHONE_USE_STATE_DIR": str(tmp / "from-env")}
        self.assertEqual(privstate.state_directory(str(tmp / "explicit"), env), tmp / "explicit")
        self.assertEqual(privstate.state_directory(tmp / "explicit-path", env), tmp / "explicit-path")
        self.assertEqual(privstate.state_directory(None, env), tmp / "from-env")
        self.assertEqual(privstate.state_directory("", env), tmp / "from-env")
        with mock.patch.dict(os.environ, {"HOME": str(tmp / "home")}):
            self.assertEqual(privstate.state_directory(None, {}), tmp / "home/.local/share/iphone-use")
            self.assertEqual(privstate.state_directory(None, {"IPHONE_USE_STATE_DIR": ""}),
                             tmp / "home/.local/share/iphone-use")
            self.assertEqual(privstate.default_state_dir(), tmp / "home/.local/share/iphone-use")
        self.assertFalse((tmp / "explicit").exists())  # nothing is created

    def test_reads_process_environment_when_env_is_none(self):
        tmp = make_tmpdir(self)
        with mock.patch.dict(os.environ, {"IPHONE_USE_STATE_DIR": str(tmp / "proc-env")}):
            self.assertEqual(privstate.state_directory(), tmp / "proc-env")

    def test_expands_user_and_resolves(self):
        tmp = make_tmpdir(self)
        (tmp / "real").mkdir()
        os.symlink(str(tmp / "real"), str(tmp / "link"))
        with mock.patch.dict(os.environ, {"HOME": str(tmp)}):
            self.assertEqual(privstate.state_directory("~/link/state"), tmp / "real" / "state")

    def test_prepare_creates_private_dir_and_gitignore(self):
        tmp = make_tmpdir(self)
        target = tmp / "a" / "b" / "state"
        result = privstate.prepare_state_dir(str(target))
        self.assertEqual(result, target)
        self.assertEqual(mode(target), 0o700)
        gitignore = target / ".gitignore"
        self.assertEqual(gitignore.read_bytes(), b"*\n")
        self.assertEqual(mode(gitignore), 0o600)

    def test_prepare_rechmods_and_rewrites_gitignore(self):
        tmp = make_tmpdir(self)
        target = tmp / "state"
        target.mkdir(mode=0o755)
        os.chmod(str(target), 0o755)
        (target / ".gitignore").write_bytes(b"something else\n")
        privstate.prepare_state_dir(target)
        self.assertEqual(mode(target), 0o700)
        self.assertEqual((target / ".gitignore").read_bytes(), b"*\n")
        self.assertEqual(mode(target / ".gitignore"), 0o600)
        os.chmod(str(target / ".gitignore"), 0o644)
        privstate.prepare_state_dir(target)
        self.assertEqual(mode(target / ".gitignore"), 0o600)
        self.assertEqual(sorted(os.listdir(str(target))), [".gitignore"])  # no temp files left

    def test_explicit_dir_inside_git_is_refused(self):
        tmp = make_tmpdir(self)
        (tmp / "repo" / ".git").mkdir(parents=True)
        for target in (tmp / "repo" / "state", tmp / "repo" / "deep" / "er" / "state", tmp / "repo"):
            with self.subTest(target=target):
                with self.assertRaises(ToolError) as caught:
                    privstate.prepare_state_dir(target)
                self.assertEqual(caught.exception.code, "state_dir_unsafe")
                self.assertEqual(caught.exception.details, {"state_dir": str(target)})
                self.assertIn("IPHONE_USE_STATE_DIR", caught.exception.message)
        self.assertFalse((tmp / "repo" / "state").exists())

    def test_git_file_counts_too(self):
        tmp = make_tmpdir(self)
        (tmp / "worktree").mkdir()
        (tmp / "worktree" / ".git").write_text("gitdir: /elsewhere\n")
        with self.assertRaises(ToolError):
            privstate.check_outside_git(tmp / "worktree" / "state")
        privstate.check_outside_git(tmp / "elsewhere" / "state")

    def test_default_dir_under_a_git_home_is_accepted(self):
        tmp = make_tmpdir(self)
        home = tmp / "home"
        (home / ".git").mkdir(parents=True)
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            state = privstate.prepare_state_dir(privstate.state_directory(None, {}))
            self.assertEqual(state, home / ".local" / "share" / "iphone-use")
            self.assertEqual(mode(state), 0o700)
            self.assertEqual((state / ".gitignore").read_bytes(), b"*\n")
            self.assertEqual(mode(state / ".gitignore"), 0o600)
            # The same folder named explicitly is the default folder, so it is accepted as well.
            self.assertEqual(privstate.prepare_state_dir(str(state)), state)
            # A different folder inside that repository is refused.
            with self.assertRaises(ToolError) as caught:
                privstate.prepare_state_dir(home / "elsewhere")
            self.assertEqual(caught.exception.code, "state_dir_unsafe")

    def test_private_subdir(self):
        tmp = make_tmpdir(self)
        sub = privstate.private_subdir(tmp, "jobs")
        self.assertEqual(sub, tmp / "jobs")
        self.assertEqual(mode(sub), 0o700)
        os.chmod(str(sub), 0o755)
        privstate.private_subdir(tmp, "jobs")
        self.assertEqual(mode(sub), 0o700)


class PrivateFileTests(unittest.TestCase):
    def test_write_json_private_mode_content_and_no_temp(self):
        tmp = make_tmpdir(self)
        target = tmp / "config.json"
        privstate.write_json_private(target, {"udid": "x", "name": "Café"})
        self.assertEqual(mode(target), 0o600)
        self.assertEqual(target.read_bytes(), '{"udid":"x","name":"Café"}\n'.encode("utf-8"))
        privstate.write_json_private(target, {"a": [1, 2]}, indent=2)
        self.assertEqual(target.read_text(encoding="utf-8"), '{\n  "a": [\n    1,\n    2\n  ]\n}\n')
        self.assertEqual(os.listdir(str(tmp)), ["config.json"])

    def test_write_is_atomic_replace(self):
        tmp = make_tmpdir(self)
        target = tmp / "data.json"
        privstate.write_json_private(target, {"v": 1})
        before = os.stat(str(target)).st_ino
        privstate.write_json_private(target, {"v": 2})
        self.assertNotEqual(os.stat(str(target)).st_ino, before)  # a new file replaced the old one
        self.assertEqual(privstate.read_json(target), {"v": 2})

    def test_failed_write_leaves_old_file_and_no_temp(self):
        tmp = make_tmpdir(self)
        target = tmp / "data.json"
        privstate.write_json_private(target, {"v": 1})
        with self.assertRaises(ValueError):
            privstate.write_json_private(target, {"v": float("nan")})
        with self.assertRaises(TypeError):
            privstate.write_bytes_private(target, "not bytes")
        with mock.patch.object(privstate.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                privstate.write_bytes_private(target, b"new")
        self.assertEqual(privstate.read_json(target), {"v": 1})
        self.assertEqual(os.listdir(str(tmp)), ["data.json"])

    def test_write_bytes_private_replaces_existing_permissive_file(self):
        tmp = make_tmpdir(self)
        target = tmp / "shot.png"
        target.write_bytes(b"old")
        os.chmod(str(target), 0o644)
        privstate.write_bytes_private(target, bytearray(b"\x89PNG"))
        self.assertEqual(target.read_bytes(), b"\x89PNG")
        self.assertEqual(mode(target), 0o600)

    def test_read_json_defaults(self):
        tmp = make_tmpdir(self)
        self.assertIsNone(privstate.read_json(tmp / "missing.json"))
        self.assertEqual(privstate.read_json(tmp / "missing.json", {"d": 1}), {"d": 1})
        (tmp / "corrupt.json").write_text("{not json")
        self.assertEqual(privstate.read_json(tmp / "corrupt.json", []), [])
        (tmp / "binary.json").write_bytes(b"\xff\xfe")
        self.assertEqual(privstate.read_json(tmp / "binary.json", "default"), "default")
        self.assertEqual(privstate.read_json(tmp, "dir"), "dir")

    def test_read_config(self):
        tmp = make_tmpdir(self)
        self.assertEqual(privstate.read_config(tmp), {})
        (tmp / "config.json").write_text("[1, 2]")
        self.assertEqual(privstate.read_config(tmp), {})
        privstate.write_json_private(tmp / "config.json", {"udid": "U", "device_port": 8100})
        self.assertEqual(privstate.read_config(str(tmp)), {"udid": "U", "device_port": 8100})

    def test_config_int(self):
        config = {"ok": 8200, "bool": True, "low": 80, "high": 70000, "text": "8100", "float": 8100.0}
        self.assertEqual(privstate.config_int(config, "ok", 8100), 8200)
        for key in ("bool", "low", "high", "text", "float", "missing"):
            with self.subTest(key=key):
                self.assertEqual(privstate.config_int(config, key, 8100), 8100)
        self.assertEqual(privstate.config_int(config, "low", 5, low=1, high=100), 80)
        self.assertEqual(privstate.config_int(None, "ok", 9100), 9100)


class FileLockTests(unittest.TestCase):
    def test_non_blocking_conflict_in_one_process(self):
        tmp = make_tmpdir(self)
        path = tmp / "operation.lock"
        first = privstate.FileLock(path, blocking=False).acquire()
        self.assertTrue(first.held)
        self.assertEqual(mode(path), 0o600)
        second = privstate.FileLock(path, blocking=False)
        with self.assertRaises(BlockingIOError):
            second.acquire()
        self.assertFalse(second.held)
        first.release()
        first.release()  # idempotent
        with second:
            self.assertTrue(second.held)
        self.assertFalse(second.held)

    def test_existing_lock_file_is_made_private(self):
        tmp = make_tmpdir(self)
        path = tmp / ".setup.lock"
        path.write_text("")
        os.chmod(str(path), 0o644)
        with privstate.FileLock(path):
            self.assertEqual(mode(path), 0o600)

    def test_blocking_lock_waits_for_release(self):
        tmp = make_tmpdir(self)
        path = tmp / ".screen-state.lock"
        holder = privstate.FileLock(path).acquire()
        acquired = threading.Event()

        def waiter():
            with privstate.FileLock(path):
                acquired.set()

        thread = threading.Thread(target=waiter, daemon=True)
        thread.start()
        self.assertFalse(acquired.wait(0.15))
        holder.release()
        self.assertTrue(acquired.wait(2.0))
        thread.join(2.0)

    def test_lock_is_released_when_the_body_raises(self):
        tmp = make_tmpdir(self)
        path = tmp / "x.lock"
        with self.assertRaises(RuntimeError):
            with privstate.FileLock(path, blocking=False):
                raise RuntimeError("boom")
        privstate.FileLock(path, blocking=False).acquire().release()

    def test_double_acquire_is_refused(self):
        tmp = make_tmpdir(self)
        lock = privstate.FileLock(tmp / "y.lock").acquire()
        self.addCleanup(lock.release)
        with self.assertRaises(RuntimeError):
            lock.acquire()

    def test_lock_is_held_across_processes(self):
        tmp = make_tmpdir(self)
        path = tmp / "cross.lock"
        code = ("import fcntl, os, sys\n"
                "fd = os.open(sys.argv[1], os.O_RDWR)\n"
                "try:\n"
                "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
                "    print('acquired')\n"
                "except BlockingIOError:\n"
                "    print('busy')\n")
        with privstate.FileLock(path):
            result = run_command([sys.executable, "-c", code, str(path)], timeout=10)
        self.assertEqual(result.stdout.strip(), "busy")
        result = run_command([sys.executable, "-c", code, str(path)], timeout=10)
        self.assertEqual(result.stdout.strip(), "acquired")


class TimeAndProcessTests(unittest.TestCase):
    def test_iso_now_round_trip(self):
        text = privstate.iso_now()
        self.assertTrue(text.endswith("+00:00"))
        parsed = privstate.parse_iso(text)
        self.assertIsNotNone(parsed)
        self.assertLess(abs((datetime.now(timezone.utc) - parsed).total_seconds()), 5)

    def test_parse_iso_forms(self):
        expected = datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(privstate.parse_iso("2026-10-08T12:00:00+00:00"), expected)
        self.assertEqual(privstate.parse_iso("2026-10-08T12:00:00Z"), expected)
        self.assertEqual(privstate.parse_iso("2026-10-08T12:00:00.000000+00:00"), expected)
        self.assertEqual(privstate.parse_iso("2026-10-08T14:00:00+02:00"), expected)
        self.assertEqual(privstate.parse_iso("2026-10-08T14:00:00+02:00").utcoffset(), timedelta(hours=2))
        for value in ("2026-10-08T12:00:00", "not a date", "", None, 1700000000, "2026-13-01T00:00:00Z"):
            with self.subTest(value=value):
                self.assertIsNone(privstate.parse_iso(value))

    def test_pid_alive(self):
        self.assertTrue(privstate.pid_alive(os.getpid()))
        for pid in (0, -1, True, "123", None, 1.5, 2 ** 80):
            with self.subTest(pid=pid):
                self.assertFalse(privstate.pid_alive(pid))
        child = subprocess.Popen([sys.executable, "-c", "pass"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child.wait(10)
        self.assertFalse(privstate.pid_alive(child.pid))
        with mock.patch.object(privstate.os, "kill", side_effect=PermissionError()):
            self.assertTrue(privstate.pid_alive(12345))
        with mock.patch.object(privstate.os, "kill", side_effect=ProcessLookupError()):
            self.assertFalse(privstate.pid_alive(12345))

    def test_prune_files_keeps_newest_by_name(self):
        tmp = make_tmpdir(self)
        names = ["20261008T120000000000Z-%02d.png" % i for i in range(6)]
        for name in reversed(names):
            (tmp / name).write_bytes(b"x")
        (tmp / "keep.jpg").write_bytes(b"x")
        (tmp / "dir.png").mkdir()
        self.assertEqual(privstate.prune_files(tmp, "*.png", 2), 4)
        self.assertEqual(sorted(os.listdir(str(tmp))), sorted(names[-2:] + ["keep.jpg", "dir.png"]))
        self.assertEqual(privstate.prune_files(tmp, "*.png", 5), 0)
        self.assertEqual(privstate.prune_files(tmp, "*.png", 0), 2)
        self.assertEqual(privstate.prune_files(tmp / "missing", "*.png", 1), 0)
        self.assertEqual(privstate.prune_files(tmp, "*.jpg", "bad"), 0)

    def test_prune_files_ignores_unlink_errors(self):
        tmp = make_tmpdir(self)
        for i in range(3):
            (tmp / ("f%d.log" % i)).write_bytes(b"x")
        with mock.patch.object(pathlib.Path, "unlink", side_effect=OSError("busy")):
            self.assertEqual(privstate.prune_files(tmp, "*.log", 1), 0)


class CommandRunnerTests(unittest.TestCase):
    def test_success(self):
        result = run_command([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"])
        self.assertIsInstance(result, CommandResult)
        self.assertEqual(result, CommandResult(0, "out\n", "err\n"))
        self.assertTrue(result.ok)

    def test_non_zero(self):
        result = run_command([sys.executable, "-c", "import sys; sys.exit(3)"])
        self.assertEqual(result.returncode, 3)
        self.assertFalse(result.ok)

    def test_missing_binary(self):
        result = run_command(["/nonexistent/iu-tool", "--flag"])
        self.assertEqual(result.returncode, 127)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("/nonexistent/iu-tool: "))
        bare = run_command(["iu-no-such-program-anywhere"])
        self.assertEqual(bare.returncode, 127)

    def test_invalid_arguments_do_not_raise(self):
        self.assertEqual(run_command([]).returncode, 127)
        self.assertEqual(run_command([sys.executable, "-c", "pass\x00"]).returncode, 127)

    def test_timeout_after_partial_output(self):
        code = "import sys, time; sys.stdout.write('partial'); sys.stdout.flush(); time.sleep(10)"
        started = time.monotonic()
        result = run_command([sys.executable, "-c", code], timeout=0.5)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(result.returncode, 124)
        self.assertEqual(result.stderr, "timed out after 0.5s")
        self.assertIsInstance(result.stdout, str)
        self.assertEqual(result.stdout, "partial")

    def test_input_text_round_trips(self):
        result = run_command(["/bin/cat"], input_text="héllo\nwörld")
        self.assertEqual(result, CommandResult(0, "héllo\nwörld", ""))

    def test_stdin_is_not_inherited(self):
        # The parent's stdin carries data (as the MCP server's JSON-RPC pipe does); the child must not see it.
        code = ("import sys; sys.path.insert(0, %r); from cmdrunner import run_command; "
                "r = run_command([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))'], timeout=10); "
                "print(r.stdout.strip())" % SERVER)
        done = subprocess.run([sys.executable, "-c", code], input=b'{"jsonrpc": "2.0", "id": 7}\n',
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(done.stdout.decode().strip(), "''", done.stderr)

    def test_cwd_and_env(self):
        tmp = make_tmpdir(self)
        env = dict(os.environ, IU_TEST_VALUE="xyz")
        result = run_command([sys.executable, "-c", "import os; print(os.getcwd()); print(os.environ['IU_TEST_VALUE'])"],
                             cwd=str(tmp), env=env)
        self.assertEqual(result.stdout.splitlines(), [str(tmp), "xyz"])

    def test_output_limits(self):
        code = "import sys; sys.stdout.write('a' * 50 + 'b' * 50); sys.stderr.write('c' * 50 + 'd' * 50)"
        with mock.patch.object(cmdrunner, "STDOUT_LIMIT", 60), mock.patch.object(cmdrunner, "STDERR_LIMIT", 60):
            result = run_command([sys.executable, "-c", code])
        self.assertEqual(result.stdout, "a" * 50 + "b" * 10)
        self.assertEqual(result.stderr, "c" * 10 + "d" * 50)
        self.assertEqual(cmdrunner.STDERR_LIMIT, 8000)
        self.assertEqual(cmdrunner.STDOUT_LIMIT, 4 * 1024 * 1024)

    def test_undecodable_output_is_replaced(self):
        result = run_command([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'ok\\xff')"])
        self.assertEqual(result.stdout, "ok�")


class FakeRunnerTests(unittest.TestCase):
    def test_matching_order_and_times(self):
        runner = FakeRunner()
        runner.on("xcrun", "devicectl", stdout="general")
        runner.on("xcrun", "devicectl", "list", "devices", stdout="specific", times=1)
        runner.on("git", returncode=1, stderr="nope")
        self.assertEqual(runner(["xcrun", "devicectl", "list", "devices", "--json-output", "x"]).stdout, "specific")
        self.assertEqual(runner(["/usr/bin/xcrun", "devicectl", "list", "devices"]).stdout, "general")
        self.assertEqual(runner(["xcrun", "devicectl", "device", "info"]).stdout, "general")
        self.assertEqual(runner(["xcrun", "simctl"]), CommandResult(127, "", "fake: no rule for xcrun"))
        self.assertEqual(runner(["git", "status"]), CommandResult(1, "", "nope"))
        self.assertEqual(runner(["/usr/bin/sips", "-g"]), CommandResult(127, "", "fake: no rule for sips"))
        self.assertEqual(len(runner.calls), 6)
        self.assertEqual(len(runner.calls_for("xcrun")), 4)
        self.assertTrue(runner.ran("xcrun", "devicectl", "device"))
        self.assertFalse(runner.ran("xcrun", "devicectl", "install"))
        self.assertTrue(runner.ran("sips"))

    def test_newest_rule_wins_and_exhausted_rules_fall_back(self):
        runner = FakeRunner()
        runner.on("pgrep", returncode=1)
        runner.on("pgrep", stdout="123\n", times=2)
        results = [runner(["pgrep", "-x", "iPhone Mirroring"]).returncode for _ in range(3)]
        self.assertEqual(results, [0, 0, 1])

    def test_records_call_details(self):
        runner = FakeRunner().on("defaults")
        runner(["defaults", "export", "com.apple.dt.Xcode", "-"], timeout=4.0, cwd="/tmp", env={"A": "1"},
               input_text="in")
        call = runner.calls[0]
        self.assertEqual(call, fakes_cmd.Call(["defaults", "export", "com.apple.dt.Xcode", "-"], 4.0, "/tmp",
                                              {"A": "1"}, "in"))

    def test_effects(self):
        seen = []

        def effect(argv, cwd, env, input_text):
            seen.append((argv, cwd, env, input_text))
            return CommandResult(5, "from effect", "")

        runner = FakeRunner()
        runner.on("osascript", effect=effect)
        runner.on("open", effect=lambda *a: None, stdout="defaults used")
        runner.on("security", effect=lambda *a: (0, "tuple", "ok"))
        self.assertEqual(runner(["/usr/bin/osascript", "-e", "x"], input_text="t"), CommandResult(5, "from effect", ""))
        self.assertEqual(seen, [(["/usr/bin/osascript", "-e", "x"], None, None, "t")])
        self.assertEqual(runner(["/usr/bin/open", "http://127.0.0.1"]).stdout, "defaults used")
        self.assertEqual(runner(["security", "find-identity"]), CommandResult(0, "tuple", "ok"))

    def test_json_output_effect(self):
        tmp = make_tmpdir(self)
        document = {"result": {"devices": [{"identifier": "X"}]}}
        runner = FakeRunner().on("xcrun", "devicectl", effect=fakes_cmd.json_output_effect(document))
        target = tmp / "out.json"
        self.assertTrue(runner(["xcrun", "devicectl", "list", "devices", "--json-output", str(target)]).ok)
        self.assertEqual(json.loads(target.read_text()), document)
        self.assertEqual(runner(["xcrun", "devicectl", "list"]).returncode, 64)
        runner(["xcrun", "devicectl", "list", "--json-output", "rel.json"], cwd=str(tmp))
        self.assertEqual(json.loads((tmp / "rel.json").read_text()), document)

    def test_jpeg_out_effect(self):
        tmp = make_tmpdir(self)
        runner = FakeRunner().on("sips", effect=fakes_cmd.jpeg_out_effect())
        target = tmp / "shot.jpg"
        argv = ["/usr/bin/sips", "-s", "format", "jpeg", "-z", "1568", "722", str(tmp / "shot.png"), "--out",
                str(target)]
        self.assertTrue(runner(argv).ok)
        self.assertEqual(target.read_bytes(), fakes_cmd.TINY_JPEG)
        custom = FakeRunner().on("sips", effect=fakes_cmd.jpeg_out_effect(b"\xff\xd8custom"))
        custom(["sips", "--out", str(target)])
        self.assertEqual(target.read_bytes(), b"\xff\xd8custom")
        self.assertEqual(runner(["sips", "-g", "pixelWidth"]).returncode, 1)

    def test_tiny_jpeg(self):
        data = fakes_cmd.TINY_JPEG
        self.assertEqual(len(data), 313)
        self.assertEqual(data[:4], b"\xff\xd8\xff\xe0")
        self.assertEqual(data[-2:], b"\xff\xd9")
        sof = data.index(b"\xff\xc0")
        height, width = struct.unpack(">HH", data[sof + 5:sof + 9])
        self.assertEqual((width, height), (39, 84))


class FakeExecutableTests(unittest.TestCase):
    def test_shell_and_python_bodies_run(self):
        tmp = make_tmpdir(self)
        bin_dir = tmp / "bin"
        shell = fakes_cmd.write_fake_executable(str(bin_dir), "xcodebuild", 'echo "fake $1"\nexit 7\n')
        self.assertEqual(mode(shell), 0o755)
        self.assertEqual(pathlib.Path(shell).read_text(), '#!/bin/sh\necho "fake $1"\nexit 7\n')
        self.assertEqual(run_command([shell, "-version"]), CommandResult(7, "fake -version\n", ""))
        python = fakes_cmd.write_fake_executable(str(bin_dir), "git", "import sys\nprint(sys.argv[1:])\n",
                                                 interpreter=sys.executable)
        self.assertEqual(run_command([python, "status"]).stdout, "['status']\n")
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))
        self.assertEqual(run_command(["git", "log"], env=env).stdout, "['log']\n")


class FakeClockTests(unittest.TestCase):
    def test_clock(self):
        clock = FakeClock()
        self.assertEqual(clock.monotonic(), 1000.0)
        self.assertEqual(clock.time(), 1000.0)
        clock.sleep(2.5)
        clock.advance(0.5)
        self.assertEqual(clock.monotonic(), 1003.0)
        self.assertEqual(clock.time(), 1003.0)
        self.assertEqual(clock.sleeps, [2.5])
        with self.assertRaises(ValueError):
            clock.sleep(-1)
        self.assertEqual(FakeClock(start=5).monotonic(), 5.0)

    def test_patching_a_module_clock(self):
        import wda_client
        clock = FakeClock(50.0)
        started = time.monotonic()
        with mock.patch.object(wda_client, "time", clock):
            self.assertEqual(wda_client.time.monotonic(), 50.0)
            wda_client.time.sleep(3600)
            self.assertEqual(wda_client.time.monotonic(), 3650.0)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIs(wda_client.time, time)


class GrammarTests(unittest.TestCase):
    def test_unit_files_parse_as_python_39(self):
        import ast
        files = [os.path.join(SERVER, name) for name in ("errors.py", "version.py", "privstate.py", "cmdrunner.py",
                                                         "usbmux.py", "wda_client.py")]
        files += [os.path.join(HERE, name) for name in ("fake_usbmuxd.py", "fakes_cmd.py", "test_usbmux.py",
                                                        "test_wda_client.py", "test_platform.py")]
        for path in files:
            with self.subTest(path=os.path.basename(path)):
                with open(path, encoding="utf-8") as handle:
                    ast.parse(handle.read(), filename=path, feature_version=(3, 9))


if __name__ == "__main__":
    unittest.main()
