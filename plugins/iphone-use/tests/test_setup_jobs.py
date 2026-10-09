import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import hashlib  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
import uuid  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from unittest import mock  # noqa: E402

import privstate  # noqa: E402
import wda_setup  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fakes_cmd import write_fake_executable  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F7A"
TEAM = "ABCDE12345"
BUNDLE = "com.example.helper.wda"
OLD_COMMIT = "1111111111111111111111111111111111111111"
PBX_PATH = "WebDriverAgent.xcodeproj/project.pbxproj"
PATCH_PATH = wda_setup.MJPEG_PATCH_PATH
FB_NEW = (
    "- (BOOL)startHTTPServer\n"
    "{\n"
    + "".join(wda_setup.CORS_HEADER_LINES)
    + "}\n"
    "- (void)initScreenshotsBroadcaster\n"
    "{\n"
    "  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n"
    + wda_setup.MJPEG_PATCH_ANCHOR
    + "  self.mjpegServer.socket = self.screenshotsBroadcaster;\n"
    "}\n"
)
FB_OLD = "// WebDriverAgent 16.13.6\n" + FB_NEW
GUARD_PATH = wda_setup.GUARD_PATCH_PATH
HTTP_NEW = (
    "- (nullable NSDictionary<NSString *, NSString *> *)parsedHeaderFieldsFromLines:(NSArray<NSString *> *)lines\n"
    "{\n"
    "  NSMutableDictionary<NSString *, NSString *> *requestHeaders = [NSMutableDictionary dictionary];\n"
    + wda_setup.GUARD_PATCH_ANCHOR
    + "}\n"
)
HTTP_OLD = "// WebDriverAgent 16.13.6\n" + HTTP_NEW
PRISTINE = {
    wda_setup.WDA_COMMIT: {PBX_PATH: "// project 16.14.0\n", PATCH_PATH: FB_NEW, GUARD_PATH: HTTP_NEW},
    OLD_COMMIT: {PBX_PATH: "// project 16.13.6\n", PATCH_PATH: FB_OLD, GUARD_PATH: HTTP_OLD},
}


def patched_files(files):
    """files (a PRISTINE entry) with every patch applied."""
    result = dict(files)
    for patch in wda_setup.PATCHES:
        result[patch.path] = patch.apply(files[patch.path])
    return result


def fingerprint_before_the_guard(config, patched):
    """build.json's fingerprint as the plugin wrote it before the browser guard (patched: mjpeg-bind-v2 only)."""
    data = {key: config.get(key) for key in ("udid", "team_id", "bundle_id", "source_dir", "network_mode",
                                             "device_port", "mjpeg_port")}
    data.update(commit=wda_setup.WDA_COMMIT, patched="iphone-use: mjpeg-bind-v2" if patched else False)
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()


# A tiny stand-in for git: repository state lives in <repo>/.git/fakegit.json; tracked files are compared with
# the pristine contents of HEAD. Every call is logged next to the script, with its environment.
FAKE_GIT = r'''
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPOSITORY = %(repository)r
PRISTINE = %(pristine)r


def fail(message, code=128):
    sys.stderr.write(message + "\n")
    sys.exit(code)


argv = sys.argv[1:]
with open(os.path.join(HERE, "git-calls.jsonl"), "a") as handle:
    handle.write(json.dumps(argv) + "\n")
with open(os.path.join(HERE, "git-env.json"), "w") as handle:
    json.dump(dict(os.environ), handle)

if argv[:1] == ["init"]:
    os.makedirs(os.path.join(argv[1], ".git"), exist_ok=True)
    with open(os.path.join(argv[1], ".git", "fakegit.json"), "w") as handle:
        json.dump({"head": None, "origin": None, "fetched": None}, handle)
    print("Initialized empty Git repository")
    sys.exit(0)
if argv[:1] != ["-C"]:
    fail("unsupported", 2)
repo, command = argv[1], argv[2:]
state_path = os.path.join(repo, ".git", "fakegit.json")
try:
    with open(state_path) as handle:
        state = json.load(handle)
except OSError:
    fail("fatal: not a git repository")


def save():
    with open(state_path, "w") as handle:
        json.dump(state, handle)


def files():
    return PRISTINE.get(state["head"] or "", {})


def write(path, text):
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", newline="") as handle:
        handle.write(text)


def changes():
    result = []
    for path, text in sorted(files().items()):
        try:
            with open(os.path.join(repo, path), newline="") as handle:
                current = handle.read()
        except OSError:
            result.append(" D " + path)
            continue
        if current != text:
            result.append(" M " + path)
    return result


if command == ["rev-parse", "HEAD"]:
    if not state["head"]:
        fail("fatal: ambiguous argument 'HEAD'")
    print(state["head"])
elif command[:2] == ["remote", "add"]:
    state["origin"] = command[3]
    save()
elif command[:2] == ["remote", "get-url"]:
    if not state["origin"]:
        fail("error: No such remote 'origin'", 2)
    print(state["origin"])
elif command[:1] == ["status"]:
    for line in changes():
        print(line)
elif command[:1] == ["fetch"]:
    if state["origin"] != REPOSITORY:
        fail("fatal: unable to access the repository")
    state["fetched"] = command[-1]
    save()
    print("From github.com:appium/WebDriverAgent")
elif command == ["checkout", "--detach", "FETCH_HEAD"]:
    if changes():
        fail("error: Your local changes to the following files would be overwritten by checkout", 1)
    state["head"] = state["fetched"]
    for path, text in files().items():
        write(path, text)
    save()
elif command[:2] == ["checkout", "--"]:
    for path in command[2:]:
        write(path, files()[path])
elif command[:1] == ["show"]:
    path = command[1].split(":", 1)[1]
    if path not in files():
        fail("fatal: path does not exist")
    sys.stdout.write(files()[path])
else:
    fail("unsupported", 2)
'''

# A stand-in for xcodebuild. build-for-testing writes products; test-without-building serves GET /status on an
# ephemeral loopback port (published in ./port) until SIGTERM. ./xcodebuild-mode selects failures.
FAKE_XCODEBUILD = r'''
import http.server
import json
import os
import signal
import socketserver
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
action = args[-1] if args else ""
with open(os.path.join(HERE, "xcodebuild-calls.jsonl"), "a") as handle:
    handle.write(json.dumps({"argv": args, "cwd": os.getcwd(), "pid": os.getpid()}) + "\n")
mode_path = os.path.join(HERE, "xcodebuild-mode")
mode = open(mode_path).read().strip() if os.path.exists(mode_path) else "ok"

if action == "build-for-testing":
    print('Signing Identity: "Apple Development: someone@example.org (ABCDE12345)"', flush=True)
    if mode == "fail":
        print('error: Signing for "WebDriverAgentRunner" requires a development team.', flush=True)
        print("** TEST BUILD FAILED **", flush=True)
        sys.exit(65)
    products = os.path.join(args[args.index("-derivedDataPath") + 1], "Build", "Products", "Debug-iphoneos",
                            "WebDriverAgentRunner-Runner.app")
    os.makedirs(products, exist_ok=True)
    with open(os.path.join(products, "embedded.mobileprovision"), "wb") as handle:
        handle.write(b"profile")
    if mode == "orphan":
        child = subprocess.Popen([sys.executable, "-c", "import signal, time; "
                                  "signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
        with open(os.path.join(HERE, "orphan.pid"), "w") as handle:
            handle.write(str(child.pid))
        time.sleep(0.2)
    print("** TEST BUILD SUCCEEDED **", flush=True)
    sys.exit(0)

if action == "test-without-building":
    if mode == "crash":
        print("Testing failed: the runner exited early", flush=True)
        sys.exit(65)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"value": {"ready": True, "build": {"version": "16.14.0"}},
                               "sessionId": None}).encode()
            self.send_response(200 if self.path == "/status" else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *ignored):
            pass

    class Server(http.server.HTTPServer):
        def server_bind(self):
            # HTTPServer.server_bind calls socket.getfqdn(), which can stall for many seconds on macOS.
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = self.server_address[:2]

    server = Server(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    signal.signal(signal.SIGTERM, lambda *ignored: os._exit(0))
    with open(os.path.join(HERE, "port.tmp"), "w") as handle:
        handle.write(str(port))
    os.replace(os.path.join(HERE, "port.tmp"), os.path.join(HERE, "port"))
    print("ServerURLHere->http://127.0.0.1:%d<-ServerURLHere" % port, flush=True)
    server.serve_forever()
sys.exit(2)
'''


def read_text(path):
    with open(path) as handle:
        return handle.read()


def kill_process(process):
    if process.poll() is None:
        process.kill()
    process.wait(5)


def wait_worker(manager, job_id):
    """Wait for a worker this manager spawned, unless it was already reaped."""
    process = manager._workers.get(job_id)
    if process is not None:
        process.wait(5)


def process_gone(pid):
    """True when pid no longer exists or is only a zombie."""
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, check=False)
    state = result.stdout.strip()
    return not state or state.startswith("Z")


class JobCase(unittest.TestCase):
    """Real detached workers with fake git/xcodebuild first on PATH and a FakeUsbmuxd for the iPhone."""

    def setUp(self):
        self.tmp = os.path.realpath(short_tmpdir())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.bin = os.path.join(self.tmp, "bin")
        write_fake_executable(self.bin, "git", FAKE_GIT % {"repository": wda_setup.WDA_REPOSITORY,
                                                            "pristine": PRISTINE}, interpreter=sys.executable)
        write_fake_executable(self.bin, "xcodebuild", FAKE_XCODEBUILD, interpreter=sys.executable)
        self.daemon = FakeUsbmuxd().start()
        self.addCleanup(self.daemon.stop)
        self.daemon.add_device(UDID)
        self.mapped = None
        self.env = {"PATH": self.bin + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.tmp,
                    "LANG": "C.UTF-8", "USBMUXD_SOCKET_ADDRESS": self.daemon.address,
                    "HTTPS_PROXY": "http://proxy.example:3128", "no_proxy": "localhost,127.0.0.1",
                    "SECRET_TOKEN": "do-not-pass", "IPHONE_USE_STATE_DIR": "/nonexistent"}
        self.managers = []
        self.addCleanup(self.stop_everything)

    def manager(self, **kwargs):
        manager = wda_setup.SetupManager(self.state, platform="darwin", env=self.env, **kwargs)
        self.managers.append(manager)
        return manager

    def stop_everything(self):
        for manager in self.managers:
            try:
                manager.stop()
            except Exception:
                pass
            for process in list(manager._workers.values()):
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    kill_process(process)

    # -- fixtures --

    def checkout(self, path, head=wda_setup.WDA_COMMIT, patched=False, origin=wda_setup.WDA_REPOSITORY,
                 overrides=None):
        os.makedirs(os.path.join(path, ".git"), exist_ok=True)
        with open(os.path.join(path, ".git", "fakegit.json"), "w") as handle:
            json.dump({"head": head, "origin": origin, "fetched": None}, handle)
        files = patched_files(PRISTINE[head]) if patched else dict(PRISTINE[head])
        files.update(overrides or {})
        for name, text in files.items():
            full = os.path.join(path, name)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", newline="") as handle:
                handle.write(text)
        return path

    def configured(self, patched=True, **kwargs):
        manager = self.manager(**kwargs)
        self.checkout(str(manager.owned_source), patched=patched)
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        return manager

    def write_build(self, manager, patched=True):
        config = manager._normalized(manager.config)
        privstate.write_json_private(manager.state_dir / "build.json", {
            "config_fingerprint": wda_setup.build_fingerprint(config, patched), "commit": wda_setup.WDA_COMMIT,
            "built_at": privstate.iso_now()})

    def assert_fully_patched(self, manager, source):
        """Every PATCHES file holds exactly its patch on top of the pinned commit, and nothing else changed."""
        for name, text in patched_files(PRISTINE[wda_setup.WDA_COMMIT]).items():
            self.assertEqual(read_text(os.path.join(source, name)), text, name)
        self.assertEqual(manager._verify_source(source), {"patched": True})

    def git_calls(self):
        path = os.path.join(self.bin, "git-calls.jsonl")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in read_text(path).splitlines()]

    def xcodebuild_calls(self):
        path = os.path.join(self.bin, "xcodebuild-calls.jsonl")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in read_text(path).splitlines()]

    def set_mode(self, mode):
        with open(os.path.join(self.bin, "xcodebuild-mode"), "w") as handle:
            handle.write(mode)

    def pump(self):
        """Point the iPhone's port 8100 (in FakeUsbmuxd) at the fake WDA's newest ephemeral port."""
        try:
            port = int(read_text(os.path.join(self.bin, "port")))
        except (OSError, ValueError):
            return
        if port != self.mapped:
            self.daemon.map_port(UDID, 8100, ("127.0.0.1", port))
            self.mapped = port

    def wait_job(self, manager, job_id, predicate, timeout=15.0):
        deadline = time.monotonic() + timeout
        while True:
            self.pump()
            job = privstate.read_json(manager.jobs_dir / (job_id + ".json"), {})
            if predicate(job):
                return job
            if time.monotonic() > deadline:
                log = manager.logs_dir / (job_id + ".log")
                self.fail("job did not get there: %r\nlog:\n%s" % (job, read_text(str(log)) if log.exists() else ""))
            time.sleep(0.05)

    def wait_done(self, manager, job_id, timeout=15.0):
        job = self.wait_job(manager, job_id, lambda job: job.get("state") in ("succeeded", "failed", "stopped"),
                            timeout)
        process = manager._workers.get(job_id)
        if process is not None:
            process.wait(5)
        return job

    def log_text(self, manager, job_id):
        return read_text(str(manager.logs_dir / (job_id + ".log")))


# --- fetch -----------------------------------------------------------------------------------------


class FetchJobTests(JobCase):
    def test_fresh_fetch_patches_the_owned_checkout_with_a_filtered_environment(self):
        manager = self.manager()
        result = manager.fetch()
        job = self.wait_done(manager, result["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        # The worker made the last git call so far: its environment is the filtered one.
        environment = json.loads(read_text(os.path.join(self.bin, "git-env.json")))
        for key in ("PATH", "HOME", "LANG", "HTTPS_PROXY", "no_proxy", "USBMUXD_SOCKET_ADDRESS"):
            self.assertEqual(environment.get(key), self.env[key], key)
        self.assertNotIn("SECRET_TOKEN", environment)
        self.assertNotIn("IPHONE_USE_STATE_DIR", environment)
        source = str(manager.owned_source)
        self.assertEqual(job["source_dir"], source)
        self.assertEqual(stat.S_IMODE(os.stat(source).st_mode), 0o700)
        self.assert_fully_patched(manager, source)
        commands = [call[2:] if call[:1] == ["-C"] else call for call in self.git_calls()]
        self.assertIn(["init", source], commands)
        self.assertIn(["remote", "add", "origin", wda_setup.WDA_REPOSITORY], commands)
        self.assertIn(["fetch", "--depth", "1", "origin", wda_setup.WDA_COMMIT], commands)
        self.assertIn(["checkout", "--detach", "FETCH_HEAD"], commands)
        job_path = manager.jobs_dir / (result["job_id"] + ".json")
        log_path = manager.logs_dir / (result["job_id"] + ".log")
        for path in (job_path, log_path):
            self.assertEqual(stat.S_IMODE(os.stat(str(path)).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(str(manager.jobs_dir)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(str(manager.logs_dir)).st_mode), 0o700)
        log = self.log_text(manager, result["job_id"])
        self.assertIn("Running: git init", log)
        self.assertIn("no requests from web pages) to %s and %s." % (PATCH_PATH, GUARD_PATH), log)
        stored = privstate.read_json(job_path)
        self.assertEqual(stored["worker_entrypoint"], os.path.join(SERVER, "wda_setup.py"))
        self.assertIsNotNone(stored["completed_at"])
        view = manager.status(job_id=result["job_id"])["jobs"][0]
        self.assertEqual(view["state"], "succeeded")
        self.assertEqual(view["source_dir"], source)

    def test_patched_pinned_checkout_needs_no_download(self):
        manager = self.manager()
        self.checkout(str(manager.owned_source), patched=True)
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertFalse([call for call in self.git_calls() if "fetch" in call])
        self.assertFalse([call for call in self.git_calls() if "checkout" in call])
        self.assert_fully_patched(manager, str(manager.owned_source))

    def test_clean_pinned_checkout_from_an_earlier_run_gets_patched(self):
        manager = self.manager()
        self.checkout(str(manager.owned_source))
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertFalse([call for call in self.git_calls() if "fetch" in call])
        self.assert_fully_patched(manager, str(manager.owned_source))

    def test_our_patch_on_an_older_commit_is_restored_then_updated(self):
        manager = self.manager()
        source = str(manager.owned_source)
        self.checkout(source, head=OLD_COMMIT, patched=True)
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        calls = self.git_calls()
        restore = calls.index(["-C", source, "checkout", "--", PATCH_PATH, GUARD_PATH])
        fetch = calls.index(["-C", source, "fetch", "--depth", "1", "origin", wda_setup.WDA_COMMIT])
        detach = calls.index(["-C", source, "checkout", "--detach", "FETCH_HEAD"])
        self.assertLess(restore, fetch)
        self.assertLess(fetch, detach)
        self.assert_fully_patched(manager, source)

    def test_the_first_version_of_our_patch_is_replaced(self):
        # mjpeg-bind-v1 left WebDriverAgent's CORS headers in place; fetch restores the file and patches it again.
        manager = self.manager()
        source = str(manager.owned_source)
        legacy = wda_setup.legacy_mjpeg_patches(FB_NEW)[0]
        self.assertIn("mjpeg-bind-v1", legacy)
        self.checkout(source, overrides={PATCH_PATH: legacy})
        with self.assertRaises(ToolError) as caught:
            manager._verify_source(source)
        self.assertEqual(caught.exception.message, wda_setup.OUTDATED_COPY)
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertIn(["-C", source, "checkout", "--", PATCH_PATH], self.git_calls())
        self.assertNotIn("Access-Control-Allow-Origin", read_text(os.path.join(source, PATCH_PATH)))
        self.assert_fully_patched(manager, source)

    def test_a_copy_without_the_browser_guard_is_upgraded_and_needs_a_new_build(self):
        # The previous plugin version patched FBWebServer.m only (mjpeg-bind-v2) and built from that.
        manager = self.manager()
        source = str(manager.owned_source)
        self.checkout(source, overrides={PATCH_PATH: wda_setup.apply_mjpeg_patch(FB_NEW)})
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        config = manager._normalized(manager.config)
        # Same formula as today; only the recorded patch versions differ.
        self.assertEqual(fingerprint_before_the_guard(config, False), wda_setup.build_fingerprint(config, False))
        old_build = fingerprint_before_the_guard(config, True)
        privstate.write_json_private(manager.state_dir / "build.json", {
            "config_fingerprint": old_build, "commit": wda_setup.WDA_COMMIT, "built_at": privstate.iso_now()})
        with self.assertRaises(ToolError) as caught:
            manager.start()
        self.assertEqual(caught.exception.message, wda_setup.OUTDATED_COPY)
        self.assertEqual(caught.exception.details["next_steps"], [wda_setup.FETCH_STEP])
        self.assertFalse(manager.status()["built"])

        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        calls = self.git_calls()
        restore = calls.index(["-C", source, "checkout", "--", PATCH_PATH])
        self.assertLess(restore, calls.index(["-C", source, "checkout", "--detach", "FETCH_HEAD"]))
        self.assert_fully_patched(manager, source)
        # The old build lacks the guard: its fingerprint no longer matches, so start asks for a build first.
        self.assertNotEqual(wda_setup.build_fingerprint(config, True), old_build)
        self.assertFalse(manager.status()["built"])
        with self.assertRaises(ToolError) as caught:
            manager.start()
        self.assertEqual(caught.exception.message, wda_setup.NEEDS_BUILD)
        build = self.wait_done(manager, manager.build()["job_id"])
        self.assertEqual(build["state"], "succeeded", build)
        self.assertTrue(manager.status()["built"])

    def test_modified_owned_copy_is_left_untouched(self):
        manager = self.manager()
        source = str(manager.owned_source)
        self.checkout(source, head=OLD_COMMIT, overrides={PBX_PATH: "// edited by someone\n"})
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"], wda_setup.MODIFIED_COPY)
        self.assertEqual(read_text(os.path.join(source, PBX_PATH)), "// edited by someone\n")
        self.assertEqual(read_text(os.path.join(source, PATCH_PATH)), FB_OLD)
        self.assertEqual(read_text(os.path.join(source, GUARD_PATH)), HTTP_OLD)
        self.assertFalse([call for call in self.git_calls() if "fetch" in call])

    def test_a_user_source_dir_is_never_patched(self):
        manager = self.manager()
        external = self.checkout(os.path.join(self.tmp, "my-wda"))
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, source_dir=external)
        job = self.wait_done(manager, manager.fetch()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertEqual(job["source_dir"], str(manager.owned_source))
        self.assertEqual(read_text(os.path.join(external, PATCH_PATH)), FB_NEW)
        self.assertEqual(read_text(os.path.join(external, GUARD_PATH)), HTTP_NEW)
        self.assertFalse([call for call in self.git_calls() if call[:2] == ["-C", external] and "checkout" in call])
        self.assertEqual(manager.config["source_dir"], external)


# --- build -----------------------------------------------------------------------------------------


class BuildJobTests(JobCase):
    def test_build_writes_the_marker(self):
        manager = self.configured()
        job = self.wait_done(manager, manager.build()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        config = manager._normalized(manager.config)
        marker = privstate.read_json(manager.state_dir / "build.json")
        self.assertEqual(marker["config_fingerprint"], wda_setup.build_fingerprint(config, True))
        self.assertEqual(marker["commit"], wda_setup.WDA_COMMIT)
        self.assertEqual(stat.S_IMODE(os.stat(str(manager.state_dir / "build.json")).st_mode), 0o600)
        call = self.xcodebuild_calls()[0]
        self.assertEqual(["xcodebuild"] + call["argv"],
                         wda_setup.xcodebuild_argv(config, manager.state_dir, "build-for-testing"))
        self.assertEqual(call["cwd"], str(manager.owned_source))
        self.assertTrue(manager.status()["built"])
        log = self.log_text(manager, job["id"])
        self.assertNotIn("someone@example.org", log)
        self.assertIn("[redacted email]", log)

    def test_failed_build_leaves_no_marker(self):
        manager = self.configured()
        self.write_build(manager)
        self.set_mode("fail")
        job = self.wait_done(manager, manager.build()["job_id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"], "xcodebuild exited with code 65; see the log.")
        self.assertFalse((manager.state_dir / "build.json").exists())
        view = manager.status(job_id=job["id"])["jobs"][0]
        self.assertTrue(any("requires a development team" in line for line in view["log_errors"]))
        self.assertTrue(any("Check signing" in step for step in view["next_steps"]))
        self.assertNotIn("someone@example.org", json.dumps(view))
        self.assertFalse(manager.status()["built"])

    def test_orphan_descendant_is_cleaned_up(self):
        manager = self.configured()
        self.set_mode("orphan")
        job = self.wait_done(manager, manager.build()["job_id"])
        self.assertEqual(job["state"], "succeeded", job)
        orphan = int(read_text(os.path.join(self.bin, "orphan.pid")))
        deadline = time.monotonic() + 5
        while not process_gone(orphan) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(process_gone(orphan))


# --- start, stop, recover --------------------------------------------------------------------------


class ServiceJobTests(JobCase):
    def start_serving(self, manager):
        result = manager.start()
        job = self.wait_job(manager, result["job_id"], lambda job: job.get("phase") == "serving")
        return result["job_id"], job

    def test_start_serves_and_stop_ends_only_the_owned_group(self):
        manager = self.configured()
        self.write_build(manager)
        job_id, job = self.start_serving(manager)
        self.assertEqual(job["state"], "running")
        self.assertIsNotNone(privstate.parse_iso(job["service_started_at"]))
        self.assertEqual(job["transport"], "usbmux:%s:8100" % UDID)
        status = manager.status(job_id=job_id)
        self.assertTrue(status["service"]["ready"])
        self.assertEqual(status["service"]["transport"], "usbmux")
        self.assertEqual(status["jobs"][0]["phase"], "serving")
        self.assertEqual(status["usb"], {"usbmuxd": True, "attached": True, "connection_type": "USB"})
        self.assertEqual(status["network"], {"mode": "usb_only", "control_port": "usb_only",
                                             "screen_stream": "usb_only"})
        self.assertEqual(status["next_steps"], [])
        self.assertIn("ServerURLHere->http://127.0.0.1:", self.log_text(manager, job_id))
        call = self.xcodebuild_calls()[-1]
        self.assertEqual(call["argv"][-2:], ["USE_IP=127.0.0.1", "test-without-building"])
        again = manager.start()
        self.assertTrue(again["already_ready"])
        server_pid = call["pid"]
        result = manager.stop()
        self.assertEqual(result["stopped_jobs"], [job_id])
        self.assertEqual(result["exited"], {job_id: True})
        final = self.wait_done(manager, job_id)
        self.assertEqual(final["state"], "stopped")
        self.assertTrue(process_gone(server_pid))
        self.assertEqual(manager.port_state(), "refused")

    def test_start_job_fails_when_the_service_exits(self):
        manager = self.configured()
        self.write_build(manager)
        self.set_mode("crash")
        job = self.wait_done(manager, manager.start()["job_id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"], "The iPhone service stopped; see the log and start again.")
        self.assertEqual(job["phase"], "launching")

    def test_recover_restarts_the_owned_service(self):
        manager = self.configured()
        self.write_build(manager)
        start_id, _ = self.start_serving(manager)
        first_server = self.xcodebuild_calls()[-1]["pid"]
        self.assertIsNone(manager.pending_recovery())
        result = manager.recover()
        self.assertTrue(result["ok"], result)
        recover_id = result["job_id"]
        self.assertEqual(result["recovery"], {"state": "queued", "phase": "queued", "job_id": recover_id,
                                              "recovery_of": start_id})
        stored = privstate.read_json(manager.jobs_dir / (recover_id + ".json"))
        self.assertEqual(stored["recovery_target"]["id"], start_id)
        recovered = self.wait_job(manager, recover_id, lambda job: job.get("phase") == "serving")
        self.assertEqual(recovered["state"], "running")
        self.assertEqual(privstate.read_json(manager.jobs_dir / (start_id + ".json"))["state"], "stopped")
        self.assertTrue(process_gone(first_server))
        servers = [call for call in self.xcodebuild_calls() if call["argv"][-1] == "test-without-building"]
        self.assertEqual(len(servers), 2)
        log = self.log_text(manager, recover_id)
        self.assertLess(log.index("Phase: stopping"), log.index("Phase: starting"))
        self.assertLess(log.index("Phase: starting"), log.index("Phase: serving"))
        self.assertIsNone(manager.pending_recovery())
        cooldown = self.manager().recover()
        self.assertFalse(cooldown["ok"])
        self.assertEqual(cooldown["recovery"]["state"], "cooldown")
        self.assertTrue(1 <= cooldown["recovery"]["retry_after_seconds"] <= 121)
        self.assertTrue(manager.status(job_id=recover_id)["service"]["ready"])


# --- ownership -------------------------------------------------------------------------------------


class OwnershipTests(JobCase):
    def spawn(self, argv_tail, new_session=True):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"] + argv_tail,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=new_session)
        self.addCleanup(kill_process, process)
        return process

    def test_marker_rules(self):
        manager = self.manager()
        job_id, token = uuid.uuid4().hex, uuid.uuid4().hex
        entry = str(manager.entrypoint)
        state = str(manager.state_dir)
        good = self.spawn([entry, wda_setup.WORKER_FLAG, state, job_id, token])
        job = {"format": 2, "id": job_id, "pid": good.pid, "owner_token": token, "worker_entrypoint": entry}
        self.assertTrue(manager._owned(job))
        self.assertFalse(manager._owned(dict(job, owner_token="different-token")))
        self.assertFalse(manager._owned(dict(job, worker_entrypoint="/different/cache/server/wda_setup.py")))
        for invalid in ("", "server/wda_setup.py", "/private/source/other.py", None, 5):
            self.assertFalse(manager._owned(dict(job, worker_entrypoint=invalid)), invalid)
        self.assertFalse(manager._owned(dict(job, format=1)))
        self.assertFalse(manager._owned(dict(job, id="e" * 32)))
        for pid in (None, 1, 0, True, "123"):
            self.assertFalse(manager._owned(dict(job, pid=pid)), pid)

        moved = "/private/old checkout/server/wda_setup.py"
        survivor = self.spawn([moved, wda_setup.WORKER_FLAG, state, job_id, token])
        self.assertTrue(manager._owned(dict(job, pid=survivor.pid, worker_entrypoint=moved)))

        prefixed = self.spawn(["/different-prefix" + entry, wda_setup.WORKER_FLAG, state, job_id, token])
        self.assertFalse(manager._owned(dict(job, pid=prefixed.pid)))
        longer = self.spawn([entry, wda_setup.WORKER_FLAG, state, job_id, token + "extra"])
        self.assertFalse(manager._owned(dict(job, pid=longer.pid)))
        followed = self.spawn([entry, wda_setup.WORKER_FLAG, state, job_id, token, "--more"])
        self.assertTrue(manager._owned(dict(job, pid=followed.pid)))
        other_state = self.spawn([entry, wda_setup.WORKER_FLAG, state + "-other", job_id, token])
        self.assertFalse(manager._owned(dict(job, pid=other_state.pid)))
        not_leader = self.spawn([entry, wda_setup.WORKER_FLAG, state, job_id, token], new_session=False)
        self.assertFalse(manager._owned(dict(job, pid=not_leader.pid)))
        kill_process(good)
        self.assertFalse(manager._owned(job))


# --- recovery bookkeeping (no real worker needed) --------------------------------------------------


class RecoveryTests(JobCase):
    def setUp(self):
        super().setUp()
        stub = write_fake_executable(os.path.join(self.tmp, "stub"), "stub-python", "exit 0\n")
        self.manager_ = self.configured(python=stub)
        self.write_build(self.manager_)

    def write_job(self, **fields):
        manager = self.manager_
        job_id = fields.pop("id", None) or uuid.uuid4().hex
        config = manager._normalized(manager.config)
        job = {"format": 2, "id": job_id, "action": "start", "state": "running", "phase": "serving",
               "created_at": privstate.iso_now(), "started_at": privstate.iso_now(), "completed_at": None,
               "owner_token": uuid.uuid4().hex, "pid": None, "worker_entrypoint": str(manager.entrypoint),
               "config": config, "config_fingerprint": wda_setup.build_fingerprint(config, True), "patched": True,
               "transport": "usbmux:%s:8100" % UDID, "service_started_at": privstate.iso_now(),
               "recovery_of": None, "recovery_target": None, "source_dir": None, "error": None}
        job.update(fields)
        privstate.write_json_private(manager.jobs_dir / (job_id + ".json"), job)
        return job

    def owned(self, **fields):
        job_id, token = uuid.uuid4().hex, fields.pop("owner_token", None) or uuid.uuid4().hex
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", str(self.manager_.entrypoint),
                                    wda_setup.WORKER_FLAG, str(self.manager_.state_dir), job_id, token],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        self.addCleanup(kill_process, process)
        return self.write_job(id=job_id, owner_token=token, pid=process.pid, **fields), process

    def recover_jobs(self):
        return [job for job in self.manager_._jobs() if job.get("action") == "recover"]

    def test_queues_without_signalling(self):
        target, process = self.owned()
        with mock.patch.object(wda_setup.os, "killpg") as killpg:
            result = self.manager_.recover()
        self.assertTrue(result["ok"], result)
        killpg.assert_not_called()
        self.assertEqual(result["recovery"]["recovery_of"], target["id"])
        self.assertEqual(result["recovery"]["phase"], "queued")
        stored = privstate.read_json(self.manager_.jobs_dir / (result["job_id"] + ".json"))
        self.assertEqual(stored["phase"], "queued")
        self.assertEqual(stored["recovery_of"], target["id"])
        snapshot = stored["recovery_target"]
        for key in ("id", "pid", "owner_token", "worker_entrypoint", "config_fingerprint", "transport"):
            self.assertEqual(snapshot[key], target[key], key)
        self.assertIsNone(process.poll())
        view = self.manager_.status(job_id=result["job_id"])["jobs"][0]
        self.assertNotIn("recovery_target", view)
        self.assertEqual(view["recovery_of"], target["id"])
        wait_worker(self.manager_, result["job_id"])

    def test_refuses_without_a_unique_owned_matching_target(self):
        manual = "The running iPhone service was not started by this plugin, so it was not restarted."
        result = self.manager_.recover()
        self.assertEqual((result["ok"], result["recovery"]["state"], result["error"]), (False, "manual", manual))
        cases = [
            {"stale_token": True},
            {"config_fingerprint": "0" * 64},
            {"transport": "usbmux:%s:8101" % UDID},
            {"state": "failed"},
            {"action": "build"},
        ]
        for fields in cases:
            with self.subTest(fields=fields):
                if fields.pop("stale_token", False):
                    job, process = self.owned()
                    privstate.write_json_private(self.manager_.jobs_dir / (job["id"] + ".json"),
                                                 dict(job, owner_token="stale-token"))
                else:
                    job, process = self.owned(**fields)
                result = self.manager_.recover()
                self.assertEqual(result["recovery"]["state"], "manual", result)
                self.assertEqual(self.recover_jobs(), [])
                self.assertIsNone(process.poll())
                kill_process(process)
        first, _ = self.owned()
        second, _ = self.owned()
        self.assertEqual(self.manager_.recover()["recovery"]["state"], "manual")

    def test_missing_build_is_refused_before_queueing(self):
        self.owned()
        os.unlink(str(self.manager_.state_dir / "build.json"))
        result = self.manager_.recover()
        self.assertFalse(result["ok"])
        self.assertEqual(result["recovery"]["state"], "manual")
        self.assertIn("Build the iPhone service", result["error"])
        self.assertEqual(self.recover_jobs(), [])

    def test_deduplicates_publishing_and_running_recoveries(self):
        target, _ = self.owned()
        publishing = self.write_job(action="recover", state="queued", phase="queued", pid=None,
                                    recovery_of=target["id"], service_started_at=None)
        result = self.manager_.recover()
        self.assertTrue(result["already_running"])
        self.assertEqual(result["job_id"], publishing["id"])
        self.assertEqual(result["recovery"]["state"], "queued")
        self.assertEqual(self.manager_.pending_recovery(), {"state": "queued", "phase": "queued",
                                                            "job_id": publishing["id"], "recovery_of": target["id"]})
        os.unlink(str(self.manager_.jobs_dir / (publishing["id"] + ".json")))
        running, _ = self.owned(action="recover", state="running", phase="stopping", recovery_of=target["id"])
        result = self.manager_.recover()
        self.assertTrue(result["already_running"])
        self.assertEqual(result["recovery"]["phase"], "stopping")
        self.assertEqual(len(self.recover_jobs()), 1)

    def test_cooldown_persists_and_expires(self):
        self.owned()
        now = datetime.now(timezone.utc)
        recent = self.write_job(action="recover", state="failed", phase="starting", created_at=(
            now - timedelta(seconds=500)).isoformat(), completed_at=now.isoformat(), service_started_at=None,
            error="fixture")
        result = wda_setup.SetupManager(self.state, platform="darwin", env=self.env).recover()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "A recent restart is still within its 2-minute cooldown.")
        self.assertEqual(result["recovery"]["state"], "cooldown")
        self.assertEqual(result["recovery"]["job_id"], recent["id"])
        self.assertTrue(119 <= result["recovery"]["retry_after_seconds"] <= 121)
        old = (now - timedelta(seconds=121)).isoformat()
        privstate.write_json_private(self.manager_.jobs_dir / (recent["id"] + ".json"),
                                     dict(recent, created_at=old, completed_at=old))
        result = self.manager_.recover()
        self.assertTrue(result["ok"], result)
        wait_worker(self.manager_, result["job_id"])

    def test_cooldown_counts_from_service_start(self):
        self.owned()
        old = (datetime.now(timezone.utc) - timedelta(seconds=400)).isoformat()
        self.write_job(action="recover", state="running", phase="serving", created_at=old,
                       service_started_at=(datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat())
        result = self.manager_.recover()
        self.assertEqual(result["recovery"]["state"], "cooldown")
        self.assertTrue(80 <= result["recovery"]["retry_after_seconds"] <= 91)

    def test_orphan_queued_recovery_is_interrupted_and_cools_down(self):
        target, _ = self.owned()
        created = (datetime.now(timezone.utc) - timedelta(seconds=6)).isoformat()
        orphan = self.write_job(action="recover", state="queued", phase="queued", pid=None, created_at=created,
                                recovery_of=target["id"], service_started_at=None)
        self.assertIsNone(self.manager_.pending_recovery())
        self.assertEqual(self.manager_._job_status(orphan)["state"], "interrupted")
        self.assertEqual(self.manager_.recover()["recovery"]["state"], "cooldown")

    def test_pending_recovery_is_read_only_and_excludes_serving(self):
        target, _ = self.owned()
        table = [("queued", "queued", True), ("running", "stopping", True), ("running", "starting", True),
                 ("running", "serving", False), ("failed", "starting", False)]
        for state, phase, expected in table:
            with self.subTest(state=state, phase=phase):
                job, process = self.owned(action="recover", state=state, phase=phase, recovery_of=target["id"])
                path = self.manager_.jobs_dir / (job["id"] + ".json")
                before = path.read_bytes()
                listing = sorted(os.listdir(str(self.manager_.jobs_dir)))
                with mock.patch.object(wda_setup.os, "killpg") as killpg:
                    pending = self.manager_.pending_recovery()
                killpg.assert_not_called()
                self.assertEqual(self.manager_._workers, {})
                self.assertEqual(sorted(os.listdir(str(self.manager_.jobs_dir))), listing)
                self.assertEqual(pending is not None, expected)
                if expected:
                    self.assertEqual(pending, {"state": state, "phase": phase, "job_id": job["id"],
                                               "recovery_of": target["id"]})
                self.assertEqual(path.read_bytes(), before)
                kill_process(process)
                path.unlink()
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        for created in (None, "invalid", 123, future, "2026-10-06T00:00:00"):
            self.write_job(id="f" * 32, action="recover", state="queued", phase="queued", pid=None,
                           created_at=created)
            self.assertIsNone(self.manager_.pending_recovery(), created)

    def test_worker_revalidates_the_target_before_any_signal(self):
        target, process = self.owned()
        snapshot = {key: target[key] for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                 "config_fingerprint", "transport")}
        job = self.write_job(action="recover", state="running", phase="stopping", recovery_target=snapshot,
                             recovery_of=target["id"])
        privstate.write_json_private(self.manager_.jobs_dir / (target["id"] + ".json"),
                                     dict(target, owner_token="different-owner"))
        with mock.patch.object(wda_setup.os, "killpg") as killpg:
            with self.assertRaisesRegex(RuntimeError, "nothing was stopped"):
                self.manager_._stop_recovery_target(job)
        killpg.assert_not_called()
        privstate.write_json_private(self.manager_.jobs_dir / (target["id"] + ".json"), target)
        config_path = self.manager_.state_dir / "config.json"  # the config changed after the restart was queued
        privstate.write_json_private(config_path, dict(self.manager_.config, device_port=8101))
        with mock.patch.object(wda_setup.os, "killpg") as killpg:
            with self.assertRaisesRegex(RuntimeError, "nothing was stopped"):
                self.manager_._stop_recovery_target(job)
        killpg.assert_not_called()
        self.assertIsNone(process.poll())

    def test_worker_waits_for_the_port_and_never_escalates(self):
        target, process = self.owned()
        snapshot = {key: target[key] for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                 "config_fingerprint", "transport")}
        job = self.write_job(action="recover", state="running", phase="stopping", recovery_target=snapshot,
                             recovery_of=target["id"])
        with mock.patch.object(wda_setup, "STOP_WAIT_SECONDS", 0.6), \
                mock.patch.object(self.manager_, "port_state", return_value="open"):
            with self.assertRaisesRegex(RuntimeError, "still in use by another service"):
                self.manager_._stop_recovery_target(job)
        self.assertEqual(process.wait(5), -signal.SIGTERM)

        target, process = self.owned()
        snapshot = {key: target[key] for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                 "config_fingerprint", "transport")}
        job = self.write_job(action="recover", state="running", phase="stopping", recovery_target=snapshot)
        real_killpg = os.killpg
        sent = []
        with mock.patch.object(wda_setup, "STOP_WAIT_SECONDS", 0.6), \
                mock.patch.object(wda_setup.os, "killpg", side_effect=lambda pid, sig: sent.append((pid, sig))):
            with self.assertRaisesRegex(RuntimeError, "did not stop within 10 seconds"):
                self.manager_._stop_recovery_target(job)
        self.assertEqual(sent, [(target["pid"], signal.SIGTERM)])
        self.assertIsNone(process.poll())
        real_killpg(target["pid"], signal.SIGTERM)
        process.wait(5)

        target, process = self.owned()
        snapshot = {key: target[key] for key in ("id", "pid", "owner_token", "worker_entrypoint",
                                                 "config_fingerprint", "transport")}
        job = self.write_job(action="recover", state="running", phase="stopping", recovery_target=snapshot)
        self.manager_._stop_recovery_target(job)  # FakeUsbmuxd: nothing mapped on 8100 -> refused
        self.assertEqual(process.wait(5), -signal.SIGTERM)


# --- pruning ---------------------------------------------------------------------------------------


class PruneTests(JobCase):
    def test_keep_jobs_never_deletes_active_ones(self):
        stub = write_fake_executable(os.path.join(self.tmp, "stub"), "stub-python", "exit 0\n")
        manager = self.manager(python=stub)
        base = datetime(2026, 10, 1, tzinfo=timezone.utc)
        token = uuid.uuid4().hex
        active_id = uuid.uuid4().hex
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", str(manager.entrypoint),
                                    wda_setup.WORKER_FLAG, str(manager.state_dir), active_id, token],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        self.addCleanup(kill_process, process)
        ids = []
        for index in range(6):
            job_id = active_id if index == 0 else uuid.uuid4().hex
            job = {"format": 2, "id": job_id, "action": "build" if index == 0 else "fetch",
                   "state": "running" if index == 0 else "succeeded", "phase": None,
                   "created_at": (base + timedelta(minutes=index)).isoformat(), "owner_token": token,
                   "pid": process.pid if index == 0 else None, "worker_entrypoint": str(manager.entrypoint)}
            privstate.write_json_private(manager.jobs_dir / (job_id + ".json"), job)
            with open(str(manager.logs_dir / (job_id + ".log")), "w") as handle:
                handle.write("log\n")
            ids.append(job_id)
        foreign = manager.jobs_dir / ("0" * 32 + ".json")
        privstate.write_json_private(foreign, {"id": "0" * 32, "state": "succeeded"})
        kill_process(process)  # now interrupted, but its file still says running: it must survive pruning
        with mock.patch.object(wda_setup, "KEEP_JOBS", 3):
            created = manager.fetch()
        wait_worker(manager, created["job_id"])
        # 7 jobs of ours, keep 3: the 4 oldest finished ones go; the old active one always stays.
        remaining = sorted(path.stem for path in manager.jobs_dir.glob("*.json"))
        self.assertEqual(remaining, sorted([active_id, ids[5], created["job_id"], "0" * 32]))
        logs = sorted(path.stem for path in manager.logs_dir.glob("*.log"))
        self.assertEqual(logs, sorted([active_id, ids[5], created["job_id"]]))
        self.assertTrue(foreign.exists())


if __name__ == "__main__":
    unittest.main()
