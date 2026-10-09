import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# The CI scripts (scripts/ci_*.py) run for real only on the macOS simulator workflow; here their logic runs
# without network or Xcode: the WebDriverAgent download against a local Git repository, the simulator choice
# against simctl listings, and the smoke test's whole MCP conversation against the FakeWDA over TCP.

import contextlib  # noqa: E402
import http.server  # noqa: E402
import importlib.util  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
import socketserver  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import wda_setup  # noqa: E402
from fake_wda import FakeWDA  # noqa: E402
from test_runtime import refused_port  # noqa: E402
from test_setup import HTTP_FIXTURE, make_source, patched_files  # noqa: E402

SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts")
GIT_IDENTITY = ["-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false"]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name + "_under_test", os.path.join(SCRIPTS, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def quietly(function, *args, **kwargs):
    """(return value, printed text) of a call whose prints are captured."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        value = function(*args, **kwargs)
    return value, output.getvalue()


@unittest.skipIf(shutil.which("git") is None, "needs git")
class PrepareWdaTests(unittest.TestCase):
    """scripts/ci_prepare_wda.py against a local repository standing in for the pinned upstream."""

    def setUp(self):
        self.prepare = load_script("ci_prepare_wda")
        self.root = tempfile.mkdtemp(prefix="iu-ci-")
        self.addCleanup(shutil.rmtree, self.root, True)
        home = os.path.join(self.root, "home")
        os.mkdir(home)
        isolated = mock.patch.dict(os.environ, {"HOME": home, "GIT_CONFIG_NOSYSTEM": "1",
                                                "GIT_CONFIG_GLOBAL": os.path.join(home, "gitconfig")})
        isolated.start()
        self.addCleanup(isolated.stop)
        self.target = os.path.join(self.root, "WebDriverAgent")

    def git(self, cwd, *args):
        result = subprocess.run(["git"] + GIT_IDENTITY + list(args), cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        return result.stdout.strip()

    def upstream(self, **files):
        """A committed checkout of the two patched files; returns (file:// URL, commit)."""
        path = make_source(os.path.join(self.root, "upstream"), **files)
        self.git(path, "init", "-q")
        self.git(path, "config", "uploadpack.allowAnySHA1InWant", "true")
        self.git(path, "add", "-A")
        self.git(path, "commit", "-q", "-m", "pinned")
        return "file://" + path, self.git(path, "rev-parse", "HEAD")

    def read(self, relative):
        with open(os.path.join(self.target, relative), encoding="utf-8") as handle:
            return handle.read()

    def test_downloads_patches_and_verifies_the_pinned_commit(self):
        url, commit = self.upstream()
        with mock.patch.object(wda_setup, "WDA_COMMIT", commit):
            _, output = quietly(self.prepare.prepare, self.target, repository=url)
        for path, text in patched_files().items():
            self.assertEqual(self.read(path), text)
        self.assertEqual(self.git(self.target, "rev-parse", "HEAD"), commit)
        self.assertEqual(sorted(line.split() for line in self.git(self.target, "status", "--porcelain").splitlines()),
                         sorted(["M", path] for path in wda_setup.PATCH_PATHS))
        self.assertIn("+ git -C %s fetch --depth 1 origin %s" % (os.path.realpath(self.target), commit), output)
        for marker in wda_setup.PATCH_MARKERS:
            self.assertIn(marker, output)
        self.assertIn("Verified: the pinned commit plus exactly the plugin's patches", output)

    def test_main_exit_codes(self):
        url, commit = self.upstream()
        with mock.patch.object(wda_setup, "WDA_COMMIT", commit):
            code, _ = quietly(self.prepare.main, ["--repository", url, self.target])
            self.assertEqual(code, 0)
            code, output = quietly(self.prepare.main, ["--repository", url, self.target])
        self.assertEqual(code, 1)  # the folder is no longer new
        self.assertIn("is not empty; pass a new folder.", output)

    def test_a_commit_other_than_the_pinned_one_is_refused(self):
        url, commit = self.upstream()
        with self.assertRaises(self.prepare.PrepareError) as raised:
            quietly(self.prepare.prepare, self.target, repository=url, commit=commit)
        self.assertEqual(str(raised.exception), wda_setup.SOURCE_WRONG_VERSION)
        self.assertEqual(self.git(self.target, "status", "--porcelain"), "")  # nothing was patched

    def test_source_the_patches_do_not_fit_is_left_unpatched(self):
        url, commit = self.upstream(http_text=HTTP_FIXTURE.replace(wda_setup.GUARD_PATCH_ANCHOR, "  return x;\n"))
        with mock.patch.object(wda_setup, "WDA_COMMIT", commit), \
                self.assertRaises(self.prepare.PrepareError) as raised:
            quietly(self.prepare.prepare, self.target, repository=url)
        self.assertIn("does not match the pinned version", str(raised.exception))
        self.assertEqual(self.git(self.target, "status", "--porcelain"), "")  # no file was half patched

    def test_a_failing_download_is_reported(self):
        url, _ = self.upstream()
        with self.assertRaises(self.prepare.PrepareError) as raised:
            quietly(self.prepare.prepare, self.target, repository=url, commit="0" * 40)
        self.assertIn("fetch --depth 1 origin " + "0" * 40, str(raised.exception))


def device(name, udid, state="Shutdown", available=True):
    return {"name": name, "udid": udid, "state": state, "isAvailable": available,
            "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType." + name.replace(" ", "-")}


UDIDS = ["%08X-0000-4000-8000-%012X" % (index, index) for index in range(1, 12)]
LISTING = {"devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [device("iPhone 16", UDIDS[0])],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        device("iPad Pro 13-inch (M5)", UDIDS[1]), device("iPhone 17 Pro", UDIDS[2]), device("iPhone Air", UDIDS[3]),
        device("iPhone 16e", UDIDS[4]), device("iPhone 17", UDIDS[5]), device("iPhone 18", UDIDS[6], available=False)],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [device("iPad Air 11-inch (M3)", UDIDS[7])],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [device("Apple Watch Series 11 (46mm)", UDIDS[8])],
}}


class PickSimulatorTests(unittest.TestCase):
    """scripts/ci_pick_simulator.py: the newest iOS runtime with an iPhone, a plain model first."""

    def setUp(self):
        self.pick = load_script("ci_pick_simulator")

    def test_newest_runtime_with_an_iphone_and_a_plain_model(self):
        chosen = self.pick.pick(LISTING)
        self.assertEqual(chosen, {"udid": UDIDS[5], "name": "iPhone 17",
                                  "runtime": "com.apple.CoreSimulator.SimRuntime.iOS-26-0", "os": "26.0"})

    def test_a_booted_iphone_is_reused(self):
        listing = json.loads(json.dumps(LISTING))
        listing["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-0"][3]["state"] = "Booted"
        self.assertEqual(self.pick.pick(listing)["name"], "iPhone 16e")

    def test_versions(self):
        self.assertEqual(self.pick.ios_version("com.apple.CoreSimulator.SimRuntime.iOS-26-0-1"), (26, 0, 1))
        self.assertIsNone(self.pick.ios_version("com.apple.CoreSimulator.SimRuntime.tvOS-26-0"))
        listing = {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-18-6-1": [device("iPhone 16", UDIDS[0])]}}
        self.assertEqual(self.pick.pick(listing)["os"], "18.6.1")

    def test_main_prints_github_env_lines_or_fails(self):
        folder = tempfile.mkdtemp(prefix="iu-ci-")
        self.addCleanup(shutil.rmtree, folder, True)
        listing = os.path.join(folder, "devices.json")
        with open(listing, "w", encoding="utf-8") as handle:
            json.dump(LISTING, handle)
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(self.pick.main([listing]), 0)
        self.assertEqual(output.getvalue().splitlines(), [
            "SIM_UDID=" + UDIDS[5], "SIM_NAME=iPhone 17", "SIM_RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            "SIM_OS=26.0"])
        self.assertIn("Chose iPhone 17 (iOS 26.0", errors.getvalue())
        with open(listing, "w", encoding="utf-8") as handle:
            json.dump({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": [device("iPad", UDIDS[1])]}},
                      handle)
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(self.pick.main([listing]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("No available iPhone simulator", errors.getvalue())


class SimSmokeTests(unittest.TestCase):
    """scripts/ci_sim_smoke.py's whole MCP conversation against the FakeWDA (IPHONE_USE_WDA_URL over TCP)."""

    TOOLS = ["iphone_ready", "iphone_observe", "iphone_observe", "iphone_press_button", "iphone_apps",
             "iphone_launch_app", "iphone_find", "iphone_find", "iphone_tap", "iphone_swipe", "iphone_press_button",
             "iphone_launch_app", "iphone_batch", "iphone_tap", "iphone_type_text", "iphone_metrics"]
    ACTIONS = ["POST /wda/homescreen", "POST /wda/apps/activate", "POST /element/:id/click",
               "POST /wda/dragfromtoforduration", "POST /wda/homescreen", "POST /wda/apps/activate", "POST /wda/tap",
               "POST /wda/tap", "POST /element/:id/clear", "POST /wda/keys"]

    def setUp(self):
        self.smoke = load_script("ci_sim_smoke")
        self.fake = FakeWDA().start()
        self.addCleanup(self.fake.stop)
        self.artifacts = tempfile.mkdtemp(prefix="iu-ci-")
        self.addCleanup(shutil.rmtree, self.artifacts, True)
        settle = mock.patch.dict(os.environ, {"IPHONE_USE_SETTLE_SECONDS": "0"})
        settle.start()
        self.addCleanup(settle.stop)

    def run_main(self, *extra):
        return quietly(self.smoke.main, ["--wda-url", self.fake.url, "--artifacts", self.artifacts] + list(extra))

    def results(self):
        with open(os.path.join(self.artifacts, "smoke-results.json"), encoding="utf-8") as handle:
            return json.load(handle)

    def test_the_whole_run_passes_against_the_fake(self):
        code, output = self.run_main("--skip-guard-checks")
        self.assertEqual(code, 0, output)
        results = self.results()
        self.assertIs(results["ok"], True)
        self.assertEqual(results["failures"], [])
        self.assertEqual([call["tool"] for call in results["calls"]], self.TOOLS)
        self.assertEqual({call["outcome"] for call in results["calls"]}, {"ok"})
        for tool in set(self.TOOLS):
            self.assertIn("] " + tool, output)
        self.assertIn("skipped (--skip-guard-checks)", output)
        self.assertIn("Cell 'Wi-Fi': 1 match(es)", output)  # General is off screen on the fake
        self.assertIn("tapping the StaticText 'Settings'", output)  # the fake page has no back button
        self.assertTrue(output.rstrip().endswith("16 tool calls, 0 failed checks: PASSED"), output[-300:])
        # What the phone saw: Home, Settings, the row, a swipe, Home, Settings, two taps and "Wi" typed.
        self.assertEqual(self.fake.actions(), self.ACTIONS)
        self.assertEqual(self.fake.typed, ["Wi"])
        self.assertEqual(self.fake.node(type="SearchField").value, "Wi")
        images = sorted(name for name in os.listdir(self.artifacts) if name.endswith((".png", ".jpg")))
        self.assertEqual([name.split(".")[0] for name in images], ["01-iphone_ready", "03-iphone_observe"])
        self.assertFalse([name for name in os.listdir(self.artifacts) if name.startswith("failure")])

    def test_a_failed_check_fails_the_run_keeps_its_evidence_and_goes_on(self):
        self.fake.home_effective = False
        code, output = self.run_main("--skip-guard-checks")
        self.assertEqual(code, 1)
        results = self.results()
        self.assertIs(results["ok"], False)
        self.assertEqual([failure["check"] for failure in results["failures"]],
                         ["iphone_press_button home (verified)"])
        self.assertIn("postcondition_failed", results["failures"][0]["message"])
        self.assertIn('"code": "postcondition_failed"', output)  # the whole result is printed
        with open(os.path.join(self.artifacts, "failure-01.json"), encoding="utf-8") as handle:
            shown = json.load(handle)
        self.assertEqual(shown["content"][0]["envelope"]["error"]["code"], "postcondition_failed")
        self.assertGreater(shown["content"][1]["base64_characters"], 0)  # the image is a file, not base64
        self.assertTrue(os.path.isfile(os.path.join(self.artifacts, "failure-01-screen.json")))
        self.assertTrue([name for name in os.listdir(self.artifacts) if name.startswith("05-iphone_observe.")])
        self.assertEqual(self.fake.typed, ["Wi"])  # later checks still ran
        self.assertTrue(output.rstrip().endswith("postcondition_failed: Home was pressed, but the Home Screen did not "
                                                 "come to the front. Look at the screen; do not press Home again "
                                                 "automatically."), output[-400:])

    def test_the_guard_checks_catch_a_webdriveragent_without_the_patches(self):
        code, output = self.run_main()  # the fake answers everything and allows every origin, like stock WDA
        self.assertEqual(code, 1)
        failures = self.results()["failures"]
        self.assertEqual([failure["check"] for failure in failures], ["browser guard (direct HTTP)"])
        message = failures[0]["message"]
        self.assertIn("Origin: https://evil.example answered 200, expected 400.", message)
        self.assertIn("Host: evil.example:%d answered 200, expected 400." % self.fake.port, message)
        self.assertIn("Sec-Fetch-Site: cross-site answered 200, expected 400.", message)
        self.assertIn("Access-Control-Allow-Origin: *", message)
        self.assertNotIn("iphone_ready", [failure["check"] for failure in failures])

    def test_an_unreachable_service_stops_after_ready(self):
        _, port = refused_port()
        code, output = quietly(self.smoke.main, ["--wda-url", "http://127.0.0.1:%d" % port, "--artifacts",
                                                 self.artifacts, "--skip-guard-checks"])
        self.assertEqual(code, 1)
        self.assertEqual([failure["check"] for failure in self.results()["failures"]], ["iphone_ready"])
        self.assertIn("service_unreachable", output)
        self.assertNotIn("== iphone_observe", output)

    def test_a_call_without_an_answer_ends_the_tour_quickly(self):
        # The earlier calls (a screenshot conversion with sips on a Mac) must stay well inside the short timeout.
        self.fake.inject("POST", "/wda/apps/activate", delay=8.0)
        with mock.patch.object(self.smoke, "CALL_TIMEOUT", 5.0):
            code, output = self.run_main("--skip-guard-checks")
        self.assertEqual(code, 1)
        self.assertEqual([failure["check"] for failure in self.results()["failures"]],
                         ["iphone_launch_app Settings"])
        self.assertIn("No answer to tools/call within 5 s.", output)
        self.assertEqual(output.count("skipped: the MCP server is not answering"), 8)
        self.assertNotIn("(a screenshot of the screen now", output)  # nothing more is sent to a busy server

    def test_a_non_loopback_url_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as raised:
            quietly(self.smoke.main, ["--wda-url", "http://192.168.1.2:8100"])
        self.assertEqual(raised.exception.code, 2)


class _StubWDAHandler(http.server.BaseHTTPRequestHandler):
    """GET /status like the patched WebDriverAgent (guarded) or like stock WebDriverAgent."""

    guarded = True

    def do_GET(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        from_page = self.headers.get("Origin") is not None or self.headers.get("Sec-Fetch-Site") is not None
        refused = self.guarded and (from_page or host not in ("127.0.0.1", "localhost"))
        self.send_response(400 if refused else 200)
        if not self.guarded:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class BrowserGuardCheckTests(unittest.TestCase):
    def setUp(self):
        self.smoke = load_script("ci_sim_smoke")

    def serve(self, guarded):
        handler = type("Handler", (_StubWDAHandler,), {"guarded": guarded})
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_a_guarded_server_passes(self):
        port = self.serve(guarded=True)
        problems, output = quietly(self.smoke.check_browser_guard, "127.0.0.1", port)
        self.assertEqual(problems, [])
        self.assertEqual(output.count("(expected 400)"), 3)
        self.assertEqual(output.count("-> 200 (expected 200)"), 2)

    def test_an_open_server_is_reported(self):
        port = self.serve(guarded=False)
        problems, _ = quietly(self.smoke.check_browser_guard, "127.0.0.1", port)
        self.assertEqual(len([problem for problem in problems if "expected 400" in problem]), 3)
        self.assertEqual(len([problem for problem in problems if "Access-Control-Allow-Origin: *" in problem]), 5)

    def test_no_answer_is_reported(self):
        _, port = refused_port()
        problems, _ = quietly(self.smoke.check_browser_guard, "127.0.0.1", port, timeout=5)
        self.assertEqual(len(problems), 5)
        self.assertTrue(all("got no HTTP answer" in problem for problem in problems), problems)


def node(kind, label, rect, **extra):
    return dict({"type": kind, "label": label, "rect": rect}, **extra)


VIEWPORT = {"width": 402, "height": 874, "units": "iPhone points"}


class TreeChoiceTests(unittest.TestCase):
    """How the smoke test picks its targets from a Settings tree it has not seen before."""

    def setUp(self):
        self.smoke = load_script("ci_sim_smoke")

    def test_choose_row_prefers_general_and_skips_unsafe_rows(self):
        nodes = [node("StaticText", "Settings", [16, 100, 120, 41]),
                 node("Button", "Edit", [20, 60, 60, 40]),
                 node("Cell", "Sign in to your iPhone", [16, 200, 370, 76]),
                 node("Cell", "Privacy & Security\nLocation", [16, 280, 370, 44]),
                 node("Cell", "Accessibility", [16, 330, 370, 44], enabled=False),
                 node("Cell", "Camera", [16, 380, 370, 44]),
                 node("Cell", "General", [16, 900, 370, 44], in_viewport=False),
                 node("Cell", "General", [16, 430, 370, 44])]
        self.assertEqual(self.smoke.choose_row(nodes, VIEWPORT)["rect"], [16, 430, 370, 44])
        self.assertEqual(self.smoke.choose_row(nodes[:-1], VIEWPORT)["label"], "Camera")
        self.assertEqual(self.smoke.choose_row(nodes[:5], VIEWPORT), None)
        rows_as_buttons = [node("Button", "Back", [8, 60, 80, 44]), node("Button", "General", [16, 300, 370, 44])]
        self.assertEqual(self.smoke.choose_row(rows_as_buttons, VIEWPORT)["label"], "General")
        cut_off = [node("Cell", "Wallpaper", [16, 850, 370, 44])]
        self.assertIsNone(self.smoke.choose_row(cut_off, VIEWPORT))

    def test_back_target_is_the_top_left_button_else_a_text(self):
        page = [node("StaticText", "General", [16, 110, 200, 41]),
                node("Button", "Edit", [330, 60, 60, 40]),
                node("Button", "Settings", [8, 60, 90, 44]),
                node("Button", "About", [16, 300, 370, 44])]
        self.assertEqual(self.smoke.back_target(page, VIEWPORT)["label"], "Settings")
        self.assertEqual(self.smoke.back_target(page[:2], VIEWPORT)["label"], "General")
        self.assertIsNone(self.smoke.back_target(page[1:2], VIEWPORT))
        self.assertEqual(self.smoke.center(page[2]), (53, 82))


if __name__ == "__main__":
    unittest.main()
