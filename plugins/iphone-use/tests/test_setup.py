import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import json  # noqa: E402
import plistlib  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import unittest  # noqa: E402
import uuid  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from unittest import mock  # noqa: E402

import privstate  # noqa: E402
import wda_setup  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import FakeWDA  # noqa: E402
from fakes_cmd import FakeClock, FakeRunner, json_output_effect, write_fake_executable  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F7A"
UDID2 = "00008120-0011223344556677"
TEAM = "ABCDE12345"
TEAM2 = "ZYXWV98765"
BUNDLE = "com.example.helper.wda"
SCRIPT = os.path.join(SERVER, "wda_setup.py")
PBXPROJ = "// !$*UTF8*$!\n{ archiveVersion = 1; }\n"
FB_FIXTURE = (
    "- (void)initScreenshotsBroadcaster\n"
    "{\n"
    "  [self readMjpegSettingsFromEnv];\n"
    "  self.mjpegServer = [[FBMjpegServer alloc] init];\n"
    "  self.screenshotsBroadcaster = [[FBTCPSocket alloc]\n"
    + wda_setup.MJPEG_PATCH_ANCHOR
    + "  self.mjpegServer.socket = self.screenshotsBroadcaster;\n"
    "}\n"
)
PATCH_ENTRY = " M " + wda_setup.MJPEG_PATCH_PATH + "\n"


def iphone(udid, name="iPhone", model="iPhone 15", paired="paired", devmode="enabled", device_type="iPhone"):
    """A devicectl 'current layout' device entry."""
    return {"identifier": "CORE-" + udid[-4:], "properties": {
        "hardware": {"reality": "physical", "deviceType": device_type, "udid": udid, "marketingName": model},
        "state": {"name": name, "developerModeStatus": {devmode: {"mode": 1}}},
        "connection": {"pairingState": paired, "state": "connected", "transportType": "wired"},
        "software": {"osVersionNumber": {"stringValue": "26.0.1"}}}}


SIMULATOR = {"identifier": "SIM", "properties": {"hardware": {"reality": "simulated", "deviceType": "iPhone",
                                                                "udid": "SIMULATOR-0001"}}}
LEGACY = {"identifier": "core-legacy",
          "hardwareProperties": {"reality": "physical", "deviceType": "iPhone", "udid": "LEGACY-UDID-0001",
                                 "marketingName": "iPhone 12"},
          "deviceProperties": {"name": "Legacy", "developerModeStatus": "disabled", "osVersionNumber": "17.0"},
          "connectionProperties": {"pairingState": "unpaired", "tunnelState": "disconnected",
                                   "transportType": "localNetwork"}}


def devicectl_doc(*items):
    return {"info": {"outcome": "success"}, "result": {"devices": list(items)}}


def teams_plist(*teams):
    """Xcode preferences as `defaults export com.apple.dt.Xcode -` prints them."""
    document = {
        "IDEProvisioningTeamByIdentifier": {"5F1C-ACCOUNT": [dict(team) for team in teams]},
        "DVTTextEditorWrapsLines": True,
    }
    return plistlib.dumps(document).decode("utf-8")


PERSONAL_TEAM = {"teamID": TEAM, "teamName": "Alex Doe (Personal Team)", "isFreeProvisioningTeam": True,
                 "teamType": "Individual"}
COMPANY_TEAM = {"teamID": TEAM2, "teamName": "Example Corp", "isFreeProvisioningTeam": False,
                "teamType": "Company"}


def make_source(path, fb_text=FB_FIXTURE):
    os.makedirs(os.path.join(path, "WebDriverAgent.xcodeproj"), exist_ok=True)
    with open(os.path.join(path, "WebDriverAgent.xcodeproj", "project.pbxproj"), "w") as handle:
        handle.write(PBXPROJ)
    target = os.path.join(path, wda_setup.MJPEG_PATCH_PATH)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w") as handle:
        handle.write(fb_text)
    return path


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def kill_process(process):
    if process.poll() is None:
        process.kill()
    process.wait(5)


class SetupCase(unittest.TestCase):
    """Temp state dir, fake runner, fake executables for which(), and an env that never reaches real usbmuxd."""

    def setUp(self):
        self.tmp = os.path.realpath(short_tmpdir())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.bin = os.path.join(self.tmp, "bin")
        for name in ("xcodebuild", "xcrun", "git"):
            write_fake_executable(self.bin, name, "exit 0\n")
        self.runner = FakeRunner()
        self.env = {"PATH": self.bin, "HOME": self.tmp, "IPHONE_USE_WDA_URL": "",
                    "USBMUXD_SOCKET_ADDRESS": "unix:" + os.path.join(self.tmp, "missing-usbmuxd.sock")}

    def manager(self, platform="darwin", **kwargs):
        return wda_setup.SetupManager(self.state, runner=self.runner, platform=platform, env=self.env, **kwargs)

    def write_config(self, **fields):
        os.makedirs(self.state, exist_ok=True)
        privstate.write_json_private(os.path.join(self.state, "config.json"), dict(fields))

    def refused_port(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.addCleanup(sock.close)
        return sock.getsockname()[1]

    def fake_wda(self, **kwargs):
        fake = FakeWDA(**kwargs).start()
        self.addCleanup(fake.stop)
        return fake

    def usbmuxd(self, *udids):
        daemon = FakeUsbmuxd().start()
        self.addCleanup(daemon.stop)
        for udid in udids:
            daemon.add_device(udid)
        self.env.update(daemon.env())
        return daemon

    def git_rules(self, src, head=wda_setup.WDA_COMMIT, status="", show=FB_FIXTURE, status_code=0):
        self.runner.on("git", "-C", src, "rev-parse", "HEAD", stdout=head + "\n")
        self.runner.on("git", "-C", src, "status", "--porcelain", "--untracked-files=no", stdout=status,
                       returncode=status_code)
        self.runner.on("git", "-C", src, "show", "HEAD:" + wda_setup.MJPEG_PATCH_PATH, stdout=show)

    def owned_source(self, manager, patched=False):
        src = str(manager.owned_source)
        make_source(src, wda_setup.apply_mjpeg_patch(FB_FIXTURE) if patched else FB_FIXTURE)
        self.git_rules(src, status=PATCH_ENTRY if patched else "")
        return src

    def write_build(self, manager, patched=False):
        config = manager._normalized(manager.config)
        privstate.write_json_private(manager.state_dir / "build.json", {
            "config_fingerprint": wda_setup.build_fingerprint(config, patched), "commit": wda_setup.WDA_COMMIT,
            "built_at": privstate.iso_now()})

    def spawn_owned(self, manager, job_id, token, entrypoint=None, new_session=True):
        """A live process whose command line carries the worker marker (stands in for a real worker)."""
        entrypoint = entrypoint or str(manager.entrypoint)
        argv = [sys.executable, "-c", "import time; time.sleep(60)", entrypoint, wda_setup.WORKER_FLAG,
                str(manager.state_dir), job_id, token]
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=new_session)
        self.addCleanup(kill_process, process)
        return process

    def write_job(self, manager, **fields):
        job_id = fields.pop("id", None) or uuid.uuid4().hex
        config = manager._normalized(manager.config)
        job = {"format": 2, "id": job_id, "action": "start", "state": "running", "phase": "launching",
               "created_at": privstate.iso_now(), "started_at": privstate.iso_now(), "completed_at": None,
               "owner_token": uuid.uuid4().hex, "pid": None, "worker_entrypoint": str(manager.entrypoint),
               "config": config, "config_fingerprint": wda_setup.build_fingerprint(config, False), "patched": False,
               "transport": manager._transport_identity(manager.config), "service_started_at": None,
               "recovery_of": None, "recovery_target": None, "source_dir": None, "error": None}
        job.update(fields)
        privstate.write_json_private(manager.jobs_dir / (job_id + ".json"), job)
        return job

    def owned_job(self, manager, **fields):
        job_id = fields.pop("id", None) or uuid.uuid4().hex
        token = uuid.uuid4().hex
        process = self.spawn_owned(manager, job_id, token)
        return self.write_job(manager, id=job_id, owner_token=token, pid=process.pid, **fields), process

    def assertToolError(self, code, function, *args, **kwargs):
        with self.assertRaises(ToolError) as caught:
            function(*args, **kwargs)
        error = caught.exception
        self.assertEqual(error.code, code, error.as_dict())
        self.assertIs(error.details.get("action_executed"), False, error.as_dict())
        self.assertIsInstance(error.details.get("next_steps"), list, error.as_dict())
        return error


# --- configuration ---------------------------------------------------------------------------------


class ConfigureTests(SetupCase):
    def test_invalid_values_are_rejected_before_anything_runs(self):
        manager = self.manager()
        base = {"udid": UDID, "team_id": TEAM, "bundle_id": BUNDLE}
        cases = [
            ("udid", "id; touch /tmp/pwn"), ("udid", "short"), ("udid", 12345678),
            ("team_id", "abcde12345"), ("team_id", "ABCDE1234"), ("team_id", "ABCDE12345;"),
            ("bundle_id", "com.example"), ("bundle_id", "1com.example.app"), ("bundle_id", "com.ex_ample.app"),
            ("bundle_id", "com.example.app$(id)"),
            ("device_port", 80), ("device_port", True), ("device_port", 70000), ("device_port", "8100"),
            ("mjpeg_port", 1.5), ("app_store_country", "ind"), ("app_store_country", "i1"),
            ("app_store_country", "üs"), ("network_mode", "wifi"), ("source_dir", "relative/path"),
            ("wda_url", "http://example.com:8100"), ("wda_url", "https://127.0.0.1:8100"),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                arguments = dict(base, **{field: value})
                error = self.assertToolError("config_invalid", manager.configure, **arguments)
                self.assertEqual(error.details["field"], field)
        self.assertEqual(self.runner.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.state, "config.json")))

    def test_auto_fill_single_device_and_team_and_generated_bundle_is_reused(self):
        self.runner.on("xcrun", "devicectl", "list", "devices",
                       effect=json_output_effect(devicectl_doc(iphone(UDID, model="iPhone 16 Pro"), SIMULATOR)))
        self.runner.on("defaults", "export", "com.apple.dt.Xcode", "-", stdout=teams_plist(PERSONAL_TEAM))
        manager = self.manager()
        result = manager.configure()
        config = result["config"]
        self.assertEqual(config["udid"], UDID)
        self.assertEqual(config["team_id"], TEAM)
        self.assertRegex(config["bundle_id"], r"^com\.iphoneuse\.[a-z0-9]{10}\.wda$")
        self.assertEqual(result["generated"], ["udid", "team_id", "bundle_id"])
        self.assertIn("udid", result["changed"])
        self.assertIn("fetch", result["next_step"])
        self.assertEqual(config["device_port"], 8100)
        self.assertEqual(config["mjpeg_port"], 9100)
        self.assertEqual(config["app_store_country"], "in")
        self.assertEqual(config["network_mode"], "usb_only")
        self.assertEqual(config["source_dir"], str(manager.owned_source))
        stored = privstate.read_config(self.state)
        self.assertEqual(stored["format"], 1)
        self.assertIsNone(stored["wda_url"])
        self.assertIsNotNone(privstate.parse_iso(stored["updated_at"]))
        path = os.path.join(self.state, "config.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode), 0o700)
        for name in ("jobs", "logs", "runtime"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.state, name)).st_mode), 0o700)
        self.assertEqual(os.listdir(self.state).count("config.json"), 1)
        self.assertFalse([name for name in os.listdir(self.state) if name.startswith("devices-")])

        calls_before = len(self.runner.calls)
        again = manager.configure(device_port=8200)
        self.assertEqual(again["config"]["bundle_id"], config["bundle_id"])
        self.assertEqual(again["generated"], [])
        self.assertEqual(again["changed"], ["device_port"])
        self.assertEqual(len(self.runner.calls), calls_before)

    def test_usb_attached_iphone_is_preferred_when_several_are_known(self):
        self.usbmuxd(UDID2)
        self.runner.on("xcrun", "devicectl", "list", "devices",
                       effect=json_output_effect(devicectl_doc(iphone(UDID), iphone(UDID2))))
        manager = self.manager()
        result = manager.configure(team_id=TEAM, bundle_id=BUNDLE)
        self.assertEqual(result["config"]["udid"], UDID2)
        self.assertEqual(result["generated"], ["udid"])

    def test_choices_required_for_two_iphones_and_for_two_teams(self):
        self.runner.on("xcrun", "devicectl", "list", "devices", effect=json_output_effect(devicectl_doc(
            iphone(UDID, name="Work", model="iPhone 16"), iphone(UDID2, name="Home", model="iPhone 13"))))
        self.runner.on("defaults", "export", "com.apple.dt.Xcode", "-",
                       stdout=teams_plist(PERSONAL_TEAM, COMPANY_TEAM))
        manager = self.manager()
        error = self.assertToolError("config_choice_required", manager.configure, team_id=TEAM)
        self.assertEqual(error.details["choices"], [{"udid": UDID, "name": "Work", "model": "iPhone 16"},
                                                    {"udid": UDID2, "name": "Home", "model": "iPhone 13"}])
        self.assertEqual(error.message, "Choose which iPhone to use.")
        error = self.assertToolError("config_choice_required", manager.configure, udid=UDID)
        self.assertEqual(error.details["choices"], [
            {"team_id": TEAM, "name": "Alex Doe (Personal Team)", "free": True},
            {"team_id": TEAM2, "name": "Example Corp", "free": False}])
        self.assertFalse(os.path.exists(os.path.join(self.state, "config.json")))

    def test_prerequisites_when_nothing_is_connected_or_signed_in(self):
        self.runner.on("xcrun", "devicectl", "list", "devices", effect=json_output_effect(devicectl_doc()))
        self.runner.on("xcrun", "xcdevice", "list", stdout="[]")
        self.runner.on("defaults", "export", "com.apple.dt.Xcode", "-", stdout=teams_plist())
        manager = self.manager()
        error = self.assertToolError("prerequisite_missing", manager.configure, team_id=TEAM)
        self.assertIn("No iPhone is connected", error.message)
        error = self.assertToolError("prerequisite_missing", manager.configure, udid=UDID)
        self.assertEqual(error.message, "Sign in to your Apple account in Xcode > Settings > Accounts first.")

    def test_explicit_values_need_no_discovery(self):
        manager = self.manager()
        result = manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, app_store_country="US",
                                   device_port=8101, mjpeg_port=9101)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(result["generated"], [])
        self.assertEqual(result["config"]["app_store_country"], "us")
        self.assertEqual(result["config"]["device_port"], 8101)

    def test_ports_must_differ(self):
        manager = self.manager()
        error = self.assertToolError("config_invalid", manager.configure, udid=UDID, team_id=TEAM, bundle_id=BUNDLE,
                                     device_port=9100)
        self.assertIn("different", error.message)

    def test_user_source_dir_must_be_pinned_and_is_never_modified(self):
        manager = self.manager()
        external = make_source(os.path.join(self.tmp, "external", "WebDriverAgent"))
        before = read_bytes(os.path.join(external, wda_setup.MJPEG_PATCH_PATH))
        self.git_rules(external, head="0123456789abcdef")
        error = self.assertToolError("prerequisite_missing", manager.configure, udid=UDID, team_id=TEAM,
                                     bundle_id=BUNDLE, source_dir=external)
        self.assertIn("16.14.0", error.message)
        self.assertEqual(read_bytes(os.path.join(external, wda_setup.MJPEG_PATCH_PATH)), before)
        self.assertFalse(os.path.exists(os.path.join(self.state, "config.json")))
        self.git_rules(external)
        result = manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, source_dir=external + "/")
        self.assertEqual(result["config"]["source_dir"], external)
        self.assertEqual(read_bytes(os.path.join(external, wda_setup.MJPEG_PATCH_PATH)), before)

    def test_refused_while_an_owned_job_is_active(self):
        manager = self.manager()
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        job, process = self.owned_job(manager, action="build", phase=None)
        error = self.assertToolError("job_conflict", manager.configure, device_port=8300)
        self.assertEqual(error.message, "Stop the running setup job before changing the configuration.")
        kill_process(process)
        self.assertEqual(manager.configure(device_port=8300)["changed"], ["device_port"])

    def test_network_mode_through_setup_and_partial_updates(self):
        manager = self.manager()
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        privstate.write_json_private(manager.state_dir / "build.json", {"config_fingerprint": "x", "commit": "y"})
        result = manager.setup("configure", network_mode="allow_network")
        self.assertEqual(result["config"]["network_mode"], "allow_network")
        self.assertEqual(result["changed"], ["network_mode"])
        self.assertTrue((manager.state_dir / "build.json").exists())
        self.assertToolError("config_invalid", manager.setup, "configure", network_mode="everywhere")
        kept = manager.setup("configure", device_port=8200)
        self.assertEqual(kept["config"]["network_mode"], "allow_network")
        self.assertEqual(manager.status()["config"]["network_mode"], "allow_network")

    def test_wda_url_only_through_the_cli_entry(self):
        manager = self.manager()
        error = self.assertToolError("invalid_argument", manager.setup, "configure", udid=UDID,
                                     wda_url="http://127.0.0.1:8100")
        self.assertEqual(error.message, "configure does not take wda_url.")
        result = manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, wda_url="http://127.0.0.1:8100")
        self.assertEqual(result["config"]["wda_url"], "http://127.0.0.1:8100")
        cleared = manager.configure(wda_url="")
        self.assertNotIn("wda_url", cleared["config"])
        self.assertEqual(cleared["changed"], ["wda_url"])

    def test_setup_argument_whitelist(self):
        manager = self.manager()
        error = self.assertToolError("invalid_argument", manager.setup, "fetch", udid=UDID)
        self.assertEqual(error.message, "fetch does not take udid.")
        error = self.assertToolError("invalid_argument", manager.setup, "status", team_id=TEAM, udid=UDID)
        self.assertEqual(error.message, "status does not take team_id, udid.")
        self.assertToolError("invalid_argument", manager.setup, "execute", command="echo unsafe")
        self.assertToolError("invalid_argument", manager.setup, "stop", wait_seconds=1)
        self.assertToolError("invalid_argument", manager.configure, apple_password="secret")
        self.assertEqual(manager.setup("status", job_id=None)["jobs"], [])

    def test_foreign_config_keys_are_ignored(self):
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, local_port=18100, device_port="bad")
        manager = self.manager()
        status = manager.status()
        self.assertTrue(status["configured"])
        self.assertNotIn("local_port", status["config"])
        self.assertEqual(status["config"]["device_port"], 8100)


class StateDirTests(SetupCase):
    def test_state_dir_inside_git_is_refused(self):
        repository = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(repository, ".git"))
        with self.assertRaises(ToolError) as caught:
            wda_setup.SetupManager(os.path.join(repository, "state"), runner=self.runner, env=self.env)
        self.assertEqual(caught.exception.code, "state_dir_unsafe")
        self.assertFalse(os.path.exists(os.path.join(repository, "state")))

    def test_gitignore_written(self):
        manager = self.manager()
        with open(os.path.join(str(manager.state_dir), ".gitignore"), "rb") as handle:
            self.assertEqual(handle.read(), b"*\n")


# --- teams, discovery ------------------------------------------------------------------------------


class TeamsTests(SetupCase):
    def test_parse_nested_duplicates_and_missing_keys(self):
        document = {
            "IDEProvisioningTeams": {"someone@example.org": [
                {"teamID": TEAM, "teamName": None},
                {"teamID": "bad-team", "teamName": "Ignored"},
                {"teamName": "No ID"},
            ]},
            "nested": [{"deeper": {"teamID": TEAM, "teamName": "Alex Doe (Personal Team)",
                                   "isFreeProvisioningTeam": 1}},
                       {"teamID": TEAM2, "isFreeProvisioningTeam": False}],
            "list": "not a dict",
        }
        self.assertEqual(wda_setup.parse_teams(document), [
            {"team_id": TEAM, "name": "Alex Doe (Personal Team)", "free": True},
            {"team_id": TEAM2, "name": None, "free": False},
        ])
        self.assertEqual(wda_setup.parse_teams("text"), [])
        self.assertEqual(wda_setup.parse_teams(None), [])

    def test_defaults_export_is_read_and_failures_mean_no_teams(self):
        manager = self.manager()
        self.runner.on("defaults", "export", "com.apple.dt.Xcode", "-", stdout=teams_plist(PERSONAL_TEAM))
        self.assertEqual(manager._teams(), [{"team_id": TEAM, "name": "Alex Doe (Personal Team)", "free": True}])
        call = self.runner.calls_for("defaults")[0]
        self.assertEqual(call.argv, ["defaults", "export", "com.apple.dt.Xcode", "-"])
        self.assertEqual(call.timeout, 8)
        self.runner.on("defaults", "export", stdout="not a plist")
        self.assertEqual(manager._teams(), [])
        self.runner.on("defaults", "export", returncode=1, stderr="Domain com.apple.dt.Xcode does not exist")
        self.assertEqual(manager._teams(), [])


class DiscoverTests(SetupCase):
    def test_current_layout_usb_rows_and_no_error_key(self):
        self.usbmuxd(UDID)
        self.runner.on("xcrun", "devicectl", "list", "devices", effect=json_output_effect(devicectl_doc(
            iphone(UDID, name="Alex's iPhone", model="iPhone 16 Pro"), SIMULATOR,
            iphone(UDID2, device_type="iPad", model="iPad Air", paired="unpaired", devmode="disabled"))))
        self.runner.on("defaults", "export", stdout=teams_plist(PERSONAL_TEAM))
        manager = self.manager()
        result = manager.discover()
        self.assertNotIn("error", result)
        self.assertNotIn("warnings", result)
        self.assertEqual([row["udid"] for row in result["devices"]], [UDID, UDID2])
        first = result["devices"][0]
        self.assertEqual(first, {"udid": UDID, "core_device_id": "CORE-6F7A", "name": "Alex's iPhone",
                                 "model": "iPhone 16 Pro", "ios_version": "26.0.1", "pairing_state": "paired",
                                 "connection_state": "connected", "transport": "wired", "developer_mode": "enabled",
                                 "usb_attached": True, "unlocked": "user_check_required"})
        self.assertFalse(result["devices"][1]["usb_attached"])
        self.assertEqual(result["devices"][1]["developer_mode"], "disabled")
        self.assertEqual(result["usb"], {"usbmuxd": True, "attached": [{"udid": UDID, "connection_type": "USB"}]})
        self.assertIsNone(result["selected_udid"])
        self.assertEqual(len(result["teams"]), 1)
        self.assertTrue(result["next_steps"])
        devicectl = self.runner.calls_for("xcrun")[0]
        self.assertEqual(devicectl.argv[:5], ["xcrun", "devicectl", "list", "devices", "--json-output"])
        self.assertEqual(devicectl.argv[-2:], ["--timeout", "8"])
        self.assertEqual(devicectl.timeout, 12)
        self.assertFalse(os.path.exists(devicectl.argv[5]))
        self.assertTrue(devicectl.argv[5].startswith(str(manager.state_dir)))
        self.assertFalse(self.runner.ran("xcrun", "xcdevice"))
        self.assertEqual(manager.device_model(UDID), "iPhone 16 Pro")
        self.assertEqual(manager.device_model(UDID.lower().replace("-", "")), "iPhone 16 Pro")
        self.assertIsNone(manager.device_model("00000000-0000000000000000"))

    def test_legacy_layout_and_defensive_parsing(self):
        rows = wda_setup.parse_devices(devicectl_doc(LEGACY))
        self.assertEqual(rows[0]["udid"], "LEGACY-UDID-0001")
        self.assertEqual(rows[0]["developer_mode"], "disabled")
        self.assertEqual(rows[0]["pairing_state"], "unpaired")
        self.assertEqual(rows[0]["connection_state"], "disconnected")
        self.assertEqual(rows[0]["ios_version"], "17.0")
        self.assertEqual(rows[0]["unlocked"], "user_check_required")
        weird = devicectl_doc(
            {"identifier": "X1", "properties": "broken"},
            {"identifier": "X2", "properties": {"hardware": ["not", "a", "dict"]}},
            {"identifier": "X3-0000-AAAA", "properties": {"hardware": {"reality": "physical", "deviceType": "iPhone"},
                                                          "state": None, "connection": 5,
                                                          "software": {"osVersionNumber": 18}}},
            None, "text")
        rows = wda_setup.parse_devices(weird)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["udid"], "X3-0000-AAAA")
        self.assertEqual(rows[0]["ios_version"], "18")
        self.assertEqual(rows[0]["pairing_state"], "unknown")
        self.assertEqual(rows[0]["name"], "iPhone")
        for document in (None, [], {"result": []}, {"result": {"devices": "x"}}):
            self.assertEqual(wda_setup.parse_devices(document), [])

    def test_xcdevice_fallback_when_devicectl_fails(self):
        self.runner.on("xcrun", "devicectl", returncode=1,
                       stderr="Error: someone@example.org could not be authenticated\nERROR: devicectl failed")
        self.runner.on("xcrun", "xcdevice", "list", stdout=json.dumps([
            {"simulator": True, "platform": "com.apple.platform.iphonesimulator", "identifier": "SIM-1"},
            {"simulator": False, "platform": "com.apple.platform.iphoneos", "identifier": UDID, "name": "Alex",
             "modelName": "iPhone 15", "operatingSystemVersion": "18.1 (22B83)", "available": True,
             "interface": "usb"},
            {"simulator": False, "platform": "com.apple.platform.macosx", "identifier": "MAC-1"}]))
        self.runner.on("defaults", "export", returncode=1)
        result = self.manager().discover()
        self.assertEqual([row["udid"] for row in result["devices"]], [UDID])
        row = result["devices"][0]
        self.assertEqual(row["model"], "iPhone 15")
        self.assertEqual(row["pairing_state"], "unknown")
        self.assertEqual(row["connection_state"], "available")
        self.assertEqual(row["transport"], "usb")
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("devicectl", result["warnings"][0])
        self.assertNotIn("someone@example.org", json.dumps(result))
        xcdevice = self.runner.calls_for("xcrun")[1]
        self.assertEqual(xcdevice.argv, ["xcrun", "xcdevice", "list", "--timeout", "5"])
        self.assertEqual(xcdevice.timeout, 9)
        self.assertEqual(result["usb"], {"usbmuxd": False, "attached": []})

    def test_fallback_when_devicectl_finds_nothing_and_steps_when_nothing_is_connected(self):
        self.runner.on("xcrun", "devicectl", "list", "devices", effect=json_output_effect(devicectl_doc()))
        self.runner.on("xcrun", "xcdevice", "list", stdout="not json")
        result = self.manager().discover()
        self.assertTrue(self.runner.ran("xcrun", "xcdevice"))
        self.assertEqual(result["devices"], [])
        self.assertNotIn("warnings", result)
        self.assertIn("Connect the iPhone", result["next_steps"][0])
        self.assertTrue(any("Accounts" in step for step in result["next_steps"]))


# --- source verification, patch, argv, fingerprint -------------------------------------------------


class SourceTests(SetupCase):
    def test_apply_mjpeg_patch(self):
        patched = wda_setup.apply_mjpeg_patch(FB_FIXTURE)
        self.assertEqual(patched.count(wda_setup.MJPEG_PATCH_LINE), 1)
        self.assertIn(wda_setup.MJPEG_PATCH_ANCHOR + wda_setup.MJPEG_PATCH_LINE, patched)
        self.assertEqual(patched.replace(wda_setup.MJPEG_PATCH_LINE, "", 1), FB_FIXTURE)
        self.assertEqual(wda_setup.apply_mjpeg_patch(patched), patched)
        self.assertEqual(wda_setup.MJPEG_PATCH_ANCHOR[:34], " " * 33 + "i")
        for text in ("no anchor here\n", FB_FIXTURE + wda_setup.MJPEG_PATCH_ANCHOR):
            with self.assertRaises(ToolError) as caught:
                wda_setup.apply_mjpeg_patch(text)
            self.assertEqual(caught.exception.code, "prerequisite_missing")
            self.assertIn("does not match the pinned version", caught.exception.message)

    def test_missing_source_runs_nothing(self):
        manager = self.manager()
        error = self.assertToolError("prerequisite_missing", manager._verify_source, os.path.join(self.tmp, "none"))
        self.assertIn("missing", error.message)
        self.assertEqual(self.runner.calls, [])

    def test_wrong_head_is_refused_and_left_untouched(self):
        manager = self.manager()
        src = make_source(os.path.join(self.tmp, "user-wda"))
        before = sorted(os.listdir(src))
        self.git_rules(src, head="9d1d17dd" * 5)
        error = self.assertToolError("prerequisite_missing", manager._verify_source, src)
        self.assertIn(wda_setup.WDA_COMMIT, error.message)
        self.assertEqual(sorted(os.listdir(src)), before)
        self.runner.on("git", "-C", src, "rev-parse", "HEAD", returncode=128, stderr="fatal: not a git repository")
        self.assertToolError("prerequisite_missing", manager._verify_source, src)

    def test_tree_states(self):
        manager = self.manager()
        owned = str(manager.owned_source)
        user = make_source(os.path.join(self.tmp, "user-wda"))
        patched_text = wda_setup.apply_mjpeg_patch(FB_FIXTURE)
        wrong_patch = FB_FIXTURE.replace(wda_setup.MJPEG_PATCH_ANCHOR, wda_setup.MJPEG_PATCH_ANCHOR
                                         + "  self.screenshotsBroadcaster.interface = @\"0.0.0.0\";\n")
        dirty = " M WebDriverAgent.xcodeproj/project.pbxproj\n"
        cases = [
            # (path, fb text, status, owned, expected patched or error message)
            (owned, FB_FIXTURE, "", None, False),
            (user, FB_FIXTURE, "", None, False),
            (owned, patched_text, PATCH_ENTRY, None, True),
            (owned, patched_text, "M  " + wda_setup.MJPEG_PATCH_PATH + "\n", None, True),
            (owned, wrong_patch, PATCH_ENTRY, None, wda_setup.MODIFIED_COPY),
            (owned, patched_text, PATCH_ENTRY + dirty, None, wda_setup.MODIFIED_COPY),
            (owned, FB_FIXTURE, dirty, None, wda_setup.MODIFIED_COPY),
            (user, patched_text, PATCH_ENTRY, None, wda_setup.SOURCE_MODIFIED),
            (user, patched_text, PATCH_ENTRY, True, True),
            (user, FB_FIXTURE, dirty, None, wda_setup.SOURCE_MODIFIED),
        ]
        for path, text, status, owned_flag, expected in cases:
            with self.subTest(path=os.path.basename(path), status=status, expected=expected):
                make_source(path, text)
                self.git_rules(path, status=status)
                if isinstance(expected, bool):
                    self.assertEqual(manager._verify_source(path, owned=owned_flag), {"patched": expected})
                else:
                    error = self.assertToolError("prerequisite_missing", manager._verify_source, path, owned_flag)
                    self.assertEqual(error.message, expected)
        self.git_rules(user, status="", status_code=128)
        self.assertToolError("prerequisite_missing", manager._verify_source, user)

    def test_xcodebuild_argv_exact(self):
        manager = self.manager()
        config = manager._complete_config({"udid": UDID, "team_id": TEAM, "bundle_id": BUNDLE,
                                           "source_dir": "/src/WDA"})
        expected = ["xcodebuild", "-project", "/src/WDA/WebDriverAgent.xcodeproj", "-scheme", "WebDriverAgentRunner",
                    "-configuration", "Debug", "-destination", "id=" + UDID, "-derivedDataPath",
                    "/state/derived_data", "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration",
                    "DEVELOPMENT_TEAM=" + TEAM, "CODE_SIGN_STYLE=Automatic", "CODE_SIGN_IDENTITY=Apple Development",
                    "PRODUCT_BUNDLE_IDENTIFIER=" + BUNDLE, "USE_PORT=8100", "MJPEG_SERVER_PORT=9100",
                    "USE_IP=127.0.0.1", "build-for-testing"]
        self.assertEqual(wda_setup.xcodebuild_argv(config, "/state", "build-for-testing"), expected)
        start = wda_setup.xcodebuild_argv(config, "/state", "test-without-building")
        self.assertEqual(start, expected[:-1] + ["test-without-building"])
        network = dict(config, network_mode="allow_network", device_port=8200, mjpeg_port=9200)
        argv = wda_setup.xcodebuild_argv(network, "/state", "build-for-testing")
        self.assertNotIn("USE_IP=127.0.0.1", argv)
        self.assertEqual(argv[-3:], ["USE_PORT=8200", "MJPEG_SERVER_PORT=9200", "build-for-testing"])

    def test_fingerprint_changes_need_a_new_build(self):
        manager = self.manager()
        manager.configure(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        self.owned_source(manager, patched=True)
        self.write_build(manager, patched=True)
        self.assertTrue(manager.status()["built"])
        config = manager._normalized(manager.config)
        self.assertNotEqual(wda_setup.build_fingerprint(config, True), wda_setup.build_fingerprint(config, False))
        manager.configure(network_mode="allow_network")
        self.assertFalse(manager.status()["built"])
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.NEEDS_BUILD)
        manager.configure(network_mode="usb_only")
        self.assertTrue(manager.status()["built"])
        manager.configure(device_port=8101)
        self.assertFalse(manager.status()["built"])
        self.assertToolError("prerequisite_missing", manager.start)


# --- doctor ----------------------------------------------------------------------------------------


class DoctorTests(SetupCase):
    def xcode_rules(self, devices=(), teams=(PERSONAL_TEAM,)):
        self.runner.on("xcodebuild", "-version", stdout="Xcode 26.0\nBuild version 17A324\n")
        self.runner.on("xcode-select", "-p", stdout="/Applications/Xcode.app/Contents/Developer\n")
        self.runner.on("xcrun", "devicectl", "list", "devices", effect=json_output_effect(devicectl_doc(*devices)))
        self.runner.on("xcrun", "xcdevice", "list", stdout="[]")
        self.runner.on("defaults", "export", stdout=teams_plist(*teams))
        self.runner.on("pgrep", returncode=1)

    def profile(self, manager, expires, devices=(UDID,)):
        app = os.path.join(str(manager.state_dir), "derived_data", "Build", "Products", "Debug-iphoneos",
                           "WebDriverAgentRunner-Runner.app")
        os.makedirs(app)
        with open(os.path.join(app, "embedded.mobileprovision"), "wb") as handle:
            handle.write(b"\x30\x80signed-profile")
        document = {"ExpirationDate": expires, "ProvisionedDevices": list(devices), "TeamIdentifier": [TEAM]}
        self.runner.on("security", "cms", "-D", "-i", stdout=plistlib.dumps(document).decode("utf-8"))

    def healthy_setup(self):
        self.usbmuxd(UDID)
        fake = self.fake_wda()
        self.env["IPHONE_USE_WDA_URL"] = fake.url
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        self.xcode_rules(devices=(iphone(UDID, model="iPhone 16 Pro"),))
        manager = self.manager()
        self.owned_source(manager, patched=True)
        self.write_build(manager, patched=True)
        self.profile(manager, datetime(2099, 1, 1))
        return manager

    def test_healthy_mac_and_iphone(self):
        manager = self.healthy_setup()
        result = manager.doctor()
        self.assertNotIn("ok", result)
        self.assertTrue(all(result["checks"].values()), result["checks"])
        self.assertEqual(list(result["checks"]), ["macos", "full_xcode", "git", "python", "usbmuxd", "configured",
                                                  "device_connected", "usb_attached", "paired", "developer_mode",
                                                  "pinned_source", "built", "profile_valid"])
        self.assertTrue(result["healthy"])
        self.assertEqual(result["next_steps"], ["1. " + wda_setup.KEEP_AWAKE_STEP])
        self.assertEqual(result["selected_device"]["udid"], UDID)
        self.assertEqual(result["xcode_version"], "Xcode 26.0\nBuild version 17A324")
        self.assertEqual(result["developer_dir"], "/Applications/Xcode.app/Contents/Developer")
        self.assertEqual(result["usb"], {"usbmuxd": True, "attached": True, "connection_type": "USB"})
        self.assertTrue(result["service"]["ready"])
        self.assertEqual(result["service"]["wda_version"], "16.14.0")
        self.assertEqual(result["service"]["transport"], "tcp")
        self.assertEqual(result["provisioning"]["expired"], False)
        self.assertTrue(result["provisioning"]["device_included"])
        self.assertEqual(result["network"], {"mode": "usb_only", "control_port": "usb_only",
                                             "screen_stream": "usb_only"})
        self.assertEqual(result["wda_commit"], wda_setup.WDA_COMMIT)
        self.assertEqual(result["state_dir"], str(manager.state_dir))
        self.assertEqual(set(result["manual_checks"].values()), {"user_check_required"})
        self.assertIn("7 days", result["signing_note"])
        self.assertEqual(result["teams"][0]["team_id"], TEAM)

    def test_nothing_installed(self):
        empty = os.path.join(self.tmp, "empty-bin")
        os.makedirs(empty)
        self.env["PATH"] = empty
        result = self.manager(platform="linux").doctor()
        self.assertFalse(result["healthy"])
        self.assertFalse(result["checks"]["macos"])
        self.assertFalse(result["checks"]["git"])
        self.assertEqual(result["binaries"], {"xcodebuild": None, "xcrun": None, "git": None})
        steps = result["next_steps"]
        self.assertEqual([step.split(". ", 1)[0] for step in steps], ["1", "2", "3", "4", "5"])
        self.assertTrue(steps[0].startswith("1. Install Xcode"))
        self.assertTrue(steps[1].startswith("2. Sign in to your Apple account"))
        self.assertTrue(steps[2].startswith("3. Choose the iPhone and signing team"))
        self.assertTrue(steps[3].startswith("4. Download the iPhone helper"))
        self.assertEqual(steps[4], "5. " + wda_setup.KEEP_AWAKE_STEP)
        self.assertFalse(self.runner.ran("xcrun"))
        self.assertFalse(self.runner.ran("pgrep"))
        self.assertIsNone(result["xcode_version"])
        self.assertEqual(result["provisioning"]["known"], False)

    def test_command_line_tools_only(self):
        self.runner.on("xcodebuild", "-version", returncode=1,
                       stderr="xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer "
                              "directory '/Library/Developer/CommandLineTools' is a command line tools instance")
        self.runner.on("xcode-select", "-p", stdout="/Library/Developer/CommandLineTools\n")
        result = self.manager().doctor()
        self.assertFalse(result["checks"]["full_xcode"])
        self.assertEqual(result["developer_dir"], "/Library/Developer/CommandLineTools")
        self.assertIn("sudo xcode-select -s /Applications/Xcode.app/Contents/Developer", result["next_steps"][0])

    def test_device_steps_are_gated_on_configuration(self):
        self.xcode_rules(devices=(iphone(UDID2),))
        result = self.manager().doctor()
        text = "\n".join(result["next_steps"])
        self.assertNotIn("Connect the iPhone", text)
        self.assertNotIn("Developer Mode", text)
        self.assertIn("iphone_setup(action=\"configure\")", text)

        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        result = self.manager().doctor()
        text = "\n".join(result["next_steps"])
        self.assertIn("Connect the iPhone", text)
        self.assertNotIn("Developer Mode", text)
        self.assertNotIn("iphone_setup(action=\"configure\")", text)
        self.assertFalse(result["checks"]["device_connected"])

    def test_developer_mode_step_and_order(self):
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        self.xcode_rules(devices=(iphone(UDID, devmode="disabled"),))
        manager = self.manager()
        self.owned_source(manager)
        result = manager.doctor()
        steps = [step.split(". ", 1)[1] for step in result["next_steps"]]
        self.assertEqual(steps[0], wda_setup.DEVELOPER_MODE_STEP)
        self.assertIn("If Developer Mode is not listed", steps[0])
        self.assertIn("Enable UI Automation", steps[1])
        self.assertTrue(steps[2].startswith("Build the iPhone helper"))
        self.assertEqual(steps[-1], wda_setup.KEEP_AWAKE_STEP)
        self.assertTrue(result["checks"]["paired"])
        self.assertFalse(result["checks"]["developer_mode"])

    def test_expired_profile_mirroring_and_wifi_steps(self):
        manager = self.healthy_setup()
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, network_mode="allow_network")
        self.write_build(manager, patched=True)
        shutil.rmtree(os.path.join(str(manager.state_dir), "derived_data"))
        self.profile(manager, datetime(2001, 1, 1))
        self.runner.on("pgrep", "-f", wda_setup.MIRRORING_PATTERN, returncode=0, stdout="4242\n")
        result = manager.doctor()
        self.assertFalse(result["checks"]["profile_valid"])
        self.assertTrue(result["provisioning"]["expired"])
        self.assertTrue(result["mirroring_running"])
        self.assertEqual(result["network"], {"mode": "allow_network", "control_port": "network",
                                             "screen_stream": "network"})
        steps = [step.split(". ", 1)[1] for step in result["next_steps"]]
        self.assertIn("expired", steps[-4])
        self.assertIn("iPhone Mirroring", steps[-3])
        self.assertEqual(steps[-2], wda_setup.WIFI_STEP)
        self.assertEqual(steps[-1], wda_setup.KEEP_AWAKE_STEP)

    def test_profile_without_this_iphone_and_unreadable_profile(self):
        manager = self.manager()
        self.profile(manager, datetime(2099, 1, 1), devices=(UDID2,))
        result = manager._provisioning(UDID)
        self.assertTrue(result["known"])
        self.assertFalse(result["device_included"])
        self.runner.on("security", "cms", returncode=1, stdout="")
        self.assertEqual(manager._provisioning(UDID)["known"], False)
        self.assertEqual(self.runner.calls_for("security")[0].timeout, 5)

    def test_doctor_never_raises(self):
        def broken(argv, timeout=12.0, cwd=None, env=None, input_text=None):
            raise RuntimeError("runner exploded")

        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        manager = wda_setup.SetupManager(self.state, runner=broken, platform="darwin", env=self.env)
        result = manager.doctor()
        self.assertFalse(result["healthy"])
        self.assertTrue(result["next_steps"])


# --- start pre-checks and probes -------------------------------------------------------------------


class StartTests(SetupCase):
    def ready_to_start(self, url=None, **config):
        if url is not None:
            self.env["IPHONE_USE_WDA_URL"] = url
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, **config)
        stub_dir = os.path.join(self.tmp, "stub")
        stub = write_fake_executable(stub_dir, "stub-python", "exit 0\n")
        manager = self.manager(python=stub)
        self.owned_source(manager)
        self.write_build(manager)
        return manager

    def job_files(self, manager):
        return sorted(os.listdir(str(manager.jobs_dir)))

    def test_unconfigured_and_missing_source_and_platform(self):
        manager = self.manager()
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.NOT_CONFIGURED)
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.SOURCE_MISSING)
        self.owned_source(manager)
        error = self.assertToolError("prerequisite_missing", self.manager(platform="linux").start)
        self.assertEqual(error.message, wda_setup.NEEDS_MACOS)
        os.unlink(os.path.join(self.bin, "xcodebuild"))
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.NEEDS_MACOS)
        error = self.assertToolError("prerequisite_missing", manager.build)
        self.assertEqual(error.message, wda_setup.NEEDS_MACOS)
        self.write_config(udid="bad", team_id=TEAM, bundle_id=BUNDLE)
        self.assertToolError("config_invalid", manager.start)
        self.assertEqual(self.job_files(manager), [])

    def test_build_required(self):
        manager = self.ready_to_start(url="http://127.0.0.1:%d" % self.refused_port())
        os.unlink(os.path.join(str(manager.state_dir), "build.json"))
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.NEEDS_BUILD)
        self.assertIn("build", error.details["next_steps"][0])
        self.assertEqual(self.job_files(manager), [])

    def test_open_and_ready_reuses_the_service_without_a_job(self):
        fake = self.fake_wda()
        manager = self.ready_to_start(url=fake.url)
        result = manager.start()
        self.assertTrue(result["already_ready"])
        self.assertEqual(result["note"], "The iPhone service is already running.")
        self.assertTrue(result["service"]["ready"])
        self.assertEqual(self.job_files(manager), [])
        self.assertEqual(fake.routes(), ["GET /status"])

    def test_open_but_not_ready_is_refused(self):
        fake = self.fake_wda()
        fake.status_ready = False
        manager = self.ready_to_start(url=fake.url)
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertIn("already uses port %d" % fake.port, error.message)
        self.assertEqual(self.job_files(manager), [])

    def test_refused_port_creates_a_start_job(self):
        port = self.refused_port()
        manager = self.ready_to_start(url="http://127.0.0.1:%d" % port)
        result = manager.start()
        job_id = result["job_id"]
        process = manager._workers.get(job_id)
        if process is not None:
            process.wait(5)
        self.assertRegex(job_id, r"^[a-f0-9]{32}$")
        self.assertEqual(result["job"]["state"], "queued")
        self.assertEqual(result["job"]["action"], "start")
        self.assertIn('job_id="%s", wait_seconds=20' % job_id, result["next_step"])
        for key in ("owner_token", "config", "recovery_target", "worker_entrypoint"):
            self.assertNotIn(key, result["job"])
        stored = privstate.read_json(manager.jobs_dir / (job_id + ".json"))
        self.assertEqual(stored["format"], 2)
        self.assertEqual(stored["transport"], "tcp:127.0.0.1:%d" % port)
        self.assertIsInstance(stored["pid"], int)
        self.assertEqual(stored["worker_entrypoint"], SCRIPT)
        self.assertEqual(stored["config"]["udid"], UDID)
        self.assertEqual(stored["patched"], False)
        self.assertEqual(stored["config_fingerprint"],
                         wda_setup.build_fingerprint(manager._normalized(manager.config), False))
        for path in (manager.jobs_dir / (job_id + ".json"), manager.logs_dir / (job_id + ".log")):
            self.assertEqual(stat.S_IMODE(os.stat(str(path)).st_mode), 0o600)

    def test_usb_checks_for_the_usbmux_transport(self):
        manager = self.ready_to_start()
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertIn("usbmuxd", error.message)
        self.usbmuxd()
        manager = self.manager()
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.NOT_ON_USB)

    def test_unreachable_port_creates_no_job(self):
        daemon = self.usbmuxd(UDID)
        manager = self.ready_to_start()
        daemon.force_result(2)
        error = self.assertToolError("prerequisite_missing", manager.start)
        self.assertEqual(error.message, wda_setup.UNREACHABLE_PORT)
        self.assertEqual(error.details["next_steps"], [
            "Reconnect the iPhone with a cable, unlock it, then run iphone_setup(action=\"start\") again."])
        self.assertEqual(self.job_files(manager), [])

    def test_running_start_job_is_reused_and_other_jobs_conflict(self):
        manager = self.ready_to_start(url="http://127.0.0.1:%d" % self.refused_port())
        job, _ = self.owned_job(manager, action="start", phase="launching")
        result = manager.start()
        self.assertTrue(result["already_running"])
        self.assertEqual(result["job_id"], job["id"])
        self.assertEqual(result["job"]["state"], "running")
        self.assertEqual(len(self.job_files(manager)), 1)
        manager2 = self.ready_to_start(url="http://127.0.0.1:%d" % self.refused_port())
        build, process = self.owned_job(manager2, action="build", phase=None)
        kill_process(_)
        error = self.assertToolError("job_conflict", manager2.start)
        self.assertEqual(error.message, "A build job is already running. Check its status or stop it first.")
        self.assertEqual(error.details["job_id"], build["id"])


class ProbeTests(SetupCase):
    def test_probe_service_over_tcp(self):
        fake = self.fake_wda()
        manager = self.manager()
        result = manager.probe_service({"wda_url": fake.url})
        self.assertEqual(result, {"reachable": True, "ready": True, "wda_version": "16.14.0",
                                  "pinned_version": "16.14.0", "transport": "tcp", "error": None})
        fake.status_ready = False
        self.assertFalse(manager.probe_service({"wda_url": fake.url})["ready"])
        self.assertEqual(manager.port_state({"wda_url": fake.url}), "open")
        refused = "http://127.0.0.1:%d" % self.refused_port()
        result = manager.probe_service({"wda_url": refused})
        self.assertFalse(result["reachable"])
        self.assertTrue(result["error"])
        self.assertEqual(manager.port_state({"wda_url": refused}), "refused")
        self.assertEqual(manager.port_state({"wda_url": "http://example.com:1"}), "unreachable")

    def test_unconfigured(self):
        manager = self.manager()
        result = manager.probe_service()
        self.assertEqual(result["transport"], "none")
        self.assertFalse(result["reachable"])
        self.assertIn("not set up", result["error"])
        self.assertEqual(manager.port_state(), "unreachable")

    def test_probe_and_port_state_over_usbmux(self):
        fake = self.fake_wda()
        daemon = self.usbmuxd()
        daemon.add_device(UDID, ports={8100: ("127.0.0.1", fake.port)})
        manager = self.manager()
        config = {"udid": UDID}
        result = manager.probe_service(config)
        self.assertTrue(result["ready"])
        self.assertEqual(result["transport"], "usbmux")
        self.assertEqual(manager.port_state(config), "open")
        daemon.map_port(UDID, 8100, None)
        self.assertEqual(manager.port_state(config), "refused")
        self.assertEqual(manager.port_state({"udid": UDID2}), "unreachable")
        daemon.force_result(2)
        self.assertEqual(manager.port_state(config), "unreachable")

    def test_env_url_takes_precedence(self):
        fake = self.fake_wda()
        self.env["IPHONE_USE_WDA_URL"] = fake.url
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        manager = self.manager()
        self.assertEqual(manager.probe_service()["transport"], "tcp")
        self.assertEqual(manager._transport_identity(manager.config), "tcp:127.0.0.1:%d" % fake.port)


# --- status ----------------------------------------------------------------------------------------


class StatusTests(SetupCase):
    def setUp(self):
        super().setUp()
        self.env["IPHONE_USE_WDA_URL"] = "http://127.0.0.1:%d" % self.refused_port()

    def configured(self, **fields):
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE, **fields)
        return self.manager()

    def write_log(self, manager, job_id, text):
        path = manager.logs_dir / (job_id + ".log")
        with open(str(path), "w") as handle:
            handle.write(text)
        os.chmod(str(path), 0o600)
        return path

    def test_jobs_is_always_an_array_and_ids_are_checked(self):
        manager = self.configured()
        result = manager.status()
        self.assertEqual(result["jobs"], [])
        self.assertEqual(result["waited_seconds"], 0.0)
        self.assertTrue(result["configured"])
        self.assertEqual(result["config"], {"udid": UDID, "team_id": TEAM, "bundle_id": BUNDLE, "device_port": 8100,
                                            "mjpeg_port": 9100, "app_store_country": "in",
                                            "source_dir": str(manager.owned_source), "network_mode": "usb_only"})
        self.assertFalse(result["built"])
        self.assertEqual(result["state_dir"], str(manager.state_dir))
        self.assertEqual(result["next_steps"], [])
        self.assertEqual(result["usb"], {"usbmuxd": False, "attached": False, "connection_type": None})
        job = self.write_job(manager, state="succeeded", action="fetch", phase=None,
                             completed_at=privstate.iso_now())
        single = manager.status(job_id=job["id"])
        self.assertEqual([item["id"] for item in single["jobs"]], [job["id"]])
        for bad in ("../../config", "A" * 32, "a" * 31, "a" * 33, "", 5):
            with self.subTest(job_id=bad):
                self.assertToolError("invalid_argument", manager.status, job_id=bad)
                self.assertToolError("invalid_argument", manager.stop, job_id=bad)
        error = self.assertToolError("unknown_job", manager.status, job_id="b" * 32)
        self.assertEqual(error.message, "Unknown job_id.")
        self.assertToolError("unknown_job", manager.stop, job_id="b" * 32)

    def test_foreign_job_files_are_ignored(self):
        manager = self.configured()
        foreign_id = "c" * 32
        privstate.write_json_private(manager.jobs_dir / (foreign_id + ".json"), {
            "id": foreign_id, "action": "start", "state": "running", "pid": os.getpid(), "owner_token": "x",
            "created_at": privstate.iso_now()})
        privstate.write_json_private(manager.jobs_dir / ("d" * 32 + ".json"), {
            "format": 1, "id": "d" * 32, "action": "start", "state": "running"})
        self.assertEqual(manager.status()["jobs"], [])
        self.assertToolError("unknown_job", manager.status, job_id=foreign_id)
        result = manager.stop()
        self.assertEqual(result["stopped_jobs"], [])
        self.assertEqual(result["unverified_jobs_preserved"], [])

    def test_job_view_is_redacted_and_diagnosed(self):
        manager = self.configured()
        job = self.write_job(manager, action="build", phase=None, state="failed", completed_at=privstate.iso_now(),
                             error="xcodebuild exited with code 65; see the log.",
                             recovery_target={"id": "x", "owner_token": "secret-token"})
        self.write_log(manager, job["id"],
                       "Running: xcodebuild ...\nApple ID someone@example.org password=supersecret\n"
                       "Authorization: Bearer private-token\nerror: No profiles for 'com.example.helper.wda' were "
                       "found\nProvisioning profile expired.\n** BUILD FAILED **\n")
        view = manager.status()["jobs"][0]
        for key in ("owner_token", "config", "recovery_target", "worker_entrypoint", "pid", "format"):
            self.assertNotIn(key, view)
        text = json.dumps(view)
        for secret in ("someone@example.org", "supersecret", "private-token", "secret-token"):
            self.assertNotIn(secret, text)
        self.assertEqual(view["log_tail"][-1], "** BUILD FAILED **")
        self.assertEqual(len(view["log_errors"]), 2)
        self.assertTrue(view["log_errors"][0].startswith("error: No profiles"))
        self.assertIsNone(view["stalled_seconds"])
        self.assertTrue(view["log_path"].endswith(job["id"] + ".log"))
        self.assertTrue(any("expired" in step for step in view["next_steps"]))
        self.assertTrue(any("Check signing" in step for step in view["next_steps"]))

    def test_log_tail_is_bounded(self):
        manager = self.configured()
        job = self.write_job(manager, state="failed", action="build", phase=None)
        self.write_log(manager, job["id"], "".join("line %d with some padding text\n" % i for i in range(2000)))
        view = manager.status()["jobs"][0]
        self.assertEqual(len(view["log_tail"]), wda_setup.LOG_TAIL_LINES)
        self.assertEqual(view["log_tail"][-1], "line 1999 with some padding text")

    def test_interrupted_and_publishing_states(self):
        manager = self.configured()
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait(5)
        dead = self.write_job(manager, state="running", pid=gone.pid)
        publishing = self.write_job(manager, state="queued", pid=None, action="fetch", phase=None)
        old = (datetime.now(timezone.utc) - timedelta(seconds=6)).isoformat()
        orphan = self.write_job(manager, state="queued", pid=None, created_at=old, action="build", phase=None)
        views = {view["id"]: view for view in manager.status()["jobs"]}
        self.assertEqual(views[dead["id"]]["state"], "interrupted")
        self.assertEqual(views[dead["id"]]["error"], wda_setup.INTERRUPTED_MESSAGE)
        self.assertEqual(views[publishing["id"]]["state"], "queued")
        self.assertEqual(views[orphan["id"]]["state"], "interrupted")
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        for created in (None, "invalid", 123, future, "2026-10-06T00:00:00"):
            job = self.write_job(manager, state="queued", pid=None, created_at=created)
            self.assertEqual(manager._job_status(job)["state"], "interrupted", created)

    def test_newest_six_jobs_newest_first(self):
        manager = self.configured()
        base = datetime(2026, 10, 1, tzinfo=timezone.utc)
        ids = []
        for index in range(8):
            job = self.write_job(manager, state="succeeded", action="fetch", phase=None,
                                 created_at=(base + timedelta(minutes=index)).isoformat())
            ids.append(job["id"])
        listed = [view["id"] for view in manager.status()["jobs"]]
        self.assertEqual(listed, list(reversed(ids))[:6])

    def test_wait_seconds_is_bounded(self):
        manager = self.configured()
        for bad in (-1, 25.5, True, "5", float("nan"), float("inf")):
            with self.subTest(wait=bad):
                self.assertToolError("invalid_argument", manager.status, wait_seconds=bad)

    def test_long_poll_returns_immediately_without_active_jobs(self):
        manager = self.configured()
        self.write_job(manager, state="succeeded", action="fetch", phase=None)
        clock = FakeClock()
        with mock.patch.object(wda_setup, "time", clock):
            result = manager.status(wait_seconds=20)
        self.assertEqual(result["waited_seconds"], 0.0)
        self.assertEqual(clock.sleeps, [])

    def test_long_poll_gives_up_at_wait_seconds_and_probes_at_most_once_per_second(self):
        manager = self.configured()
        job, _ = self.owned_job(manager, state="running", phase="launching")
        probes = []
        original = manager.probe_service

        def counting_probe(*args, **kwargs):
            probes.append(clock.monotonic())
            return original(*args, **kwargs)

        clock = FakeClock()
        with mock.patch.object(wda_setup, "time", clock), mock.patch.object(manager, "probe_service", counting_probe):
            result = manager.status(job_id=job["id"], wait_seconds=3)
        self.assertEqual(result["waited_seconds"], 3.0)
        self.assertEqual(result["jobs"][0]["state"], "running")
        self.assertLessEqual(len(probes), 4)
        self.assertTrue(all(b - a >= 1.0 for a, b in zip(probes, probes[1:])))

    def test_long_poll_returns_early_on_a_change(self):
        manager = self.configured()
        job, _ = self.owned_job(manager, state="running", phase="launching")
        path = manager.jobs_dir / (job["id"] + ".json")

        class ChangingClock(FakeClock):
            def sleep(self, seconds):
                super().sleep(seconds)
                if len(self.sleeps) == 2:
                    privstate.write_json_private(path, dict(job, phase="serving"))

        clock = ChangingClock()
        with mock.patch.object(wda_setup, "time", clock):
            result = manager.status(wait_seconds=20)
        self.assertEqual(result["waited_seconds"], 1.0)
        self.assertEqual(result["jobs"][0]["phase"], "serving")

    def test_long_poll_stops_when_a_serving_service_is_ready(self):
        fake = self.fake_wda()
        self.env["IPHONE_USE_WDA_URL"] = fake.url
        manager = self.configured()
        job, _ = self.owned_job(manager, state="running", phase="serving")
        clock = FakeClock()
        with mock.patch.object(wda_setup, "time", clock):
            result = manager.status(wait_seconds=20)
        self.assertEqual(result["waited_seconds"], 0.0)
        self.assertTrue(result["service"]["ready"])

    def test_network_block_and_wifi_sentence(self):
        cases = [
            ("usb_only", True, {"mode": "usb_only", "control_port": "usb_only", "screen_stream": "usb_only"}),
            ("usb_only", False, {"mode": "usb_only", "control_port": "usb_only", "screen_stream": "network"}),
            ("allow_network", True, {"mode": "allow_network", "control_port": "network", "screen_stream": "network"}),
            ("allow_network", False, {"mode": "allow_network", "control_port": "network",
                                      "screen_stream": "network"}),
        ]
        for mode, patched, expected in cases:
            with self.subTest(mode=mode, patched=patched):
                manager = self.configured(network_mode=mode)
                self.owned_source(manager, patched=patched)
                result = manager.status()
                self.assertEqual(result["network"], expected)
                self.assertEqual(result["next_steps"], [])

        manager = self.configured(network_mode="usb_only")
        self.owned_source(manager, patched=True)
        snapshot = dict(manager._normalized(manager.config), network_mode="allow_network")
        job, process = self.owned_job(manager, state="running", phase="launching", config=snapshot, patched=True)
        result = manager.status()
        self.assertEqual(result["network"]["control_port"], "network")
        self.assertEqual(result["next_steps"], [])
        privstate.write_json_private(manager.jobs_dir / (job["id"] + ".json"), dict(job, phase="serving"))
        result = manager.status()
        self.assertEqual(result["next_steps"], [wda_setup.WIFI_STEP])
        kill_process(process)
        self.assertEqual(manager.status()["network"]["control_port"], "usb_only")

    def test_unconfigured_status(self):
        result = self.manager().status()
        self.assertFalse(result["configured"])
        self.assertIsNone(result["config"]["udid"])
        self.assertEqual(result["next_steps"], [wda_setup.CONFIGURE_STEP])
        self.assertFalse(result["service"]["ready"])

    def test_stalled_build_hint(self):
        manager = self.configured()
        job, _ = self.owned_job(manager, action="build", phase=None, state="running")
        path = self.write_log(manager, job["id"], "Running: xcodebuild\nSigning...\n")
        old = os.stat(str(path)).st_mtime - 120
        os.utime(str(path), (old, old))
        view = manager.status()["jobs"][0]
        self.assertGreaterEqual(view["stalled_seconds"], 119)
        self.assertIn(wda_setup.STALL_STEP, view["next_steps"])

    def loopback_case(self, action="start", phase="launching", mode="usb_only", elapsed=31, ready=False,
                      marker=True):
        clock = FakeClock(start=10000.0)
        if ready:
            self.env["IPHONE_USE_WDA_URL"] = self.fake_wda().url
        manager = self.configured()
        snapshot = dict(manager._normalized(manager.config), network_mode=mode)
        started = datetime.fromtimestamp(10000.0, timezone.utc).isoformat()
        job, _ = self.owned_job(manager, action=action, phase=phase, state="running", config=snapshot,
                                started_at=started, created_at=started)
        text = "Running: xcodebuild\n"
        if marker:
            text += "2026-10-08 ServerURLHere->http://127.0.0.1:8100<-ServerURLHere\n"
        self.write_log(manager, job["id"], text)
        clock.advance(elapsed)
        with mock.patch.object(wda_setup, "time", clock):
            view = manager.status(job_id=job["id"])["jobs"][0]
        return wda_setup.LOOPBACK_STEP in view["next_steps"]

    def test_loopback_start_diagnostic(self):
        self.assertTrue(self.loopback_case())
        self.assertTrue(self.loopback_case(action="recover", phase="starting"))
        self.assertFalse(self.loopback_case(elapsed=10))
        self.assertFalse(self.loopback_case(mode="allow_network"))
        self.assertFalse(self.loopback_case(marker=False))
        self.assertFalse(self.loopback_case(phase="serving"))
        self.assertFalse(self.loopback_case(ready=True))
        text = wda_setup.LOOPBACK_STEP
        order = [text.index('iphone_setup(action="stop")'), text.index('network_mode="allow_network"'),
                 text.index('iphone_setup(action="build")'), text.index('iphone_setup(action="start")')]
        self.assertEqual(order, sorted(order))


class StopTests(SetupCase):
    def test_only_owned_groups_are_signalled_and_waited_for(self):
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        manager = self.manager()
        owned, owned_process = self.owned_job(manager, action="start")
        stale_id = uuid.uuid4().hex
        stale_process = self.spawn_owned(manager, stale_id, "real-token")
        stale = self.write_job(manager, id=stale_id, owner_token="stale-token", pid=stale_process.pid)
        result = manager.stop()
        self.assertEqual(result["stopped_jobs"], [owned["id"]])
        self.assertEqual(result["exited"], {owned["id"]: True})
        self.assertEqual(result["unverified_jobs_preserved"], [stale["id"]])
        self.assertEqual(result["note"], wda_setup.STOP_NOTE)
        self.assertEqual(owned_process.wait(5), -15)
        self.assertIsNone(stale_process.poll())

    def test_stop_one_job(self):
        self.write_config(udid=UDID, team_id=TEAM, bundle_id=BUNDLE)
        manager = self.manager()
        first, first_process = self.owned_job(manager, action="start")
        second, second_process = self.owned_job(manager, action="build", phase=None)
        result = manager.stop(job_id=second["id"])
        self.assertEqual(result["stopped_jobs"], [second["id"]])
        self.assertIsNone(first_process.poll())
        second_process.wait(5)


# --- redaction and diagnosis -----------------------------------------------------------------------


class RedactionTests(unittest.TestCase):
    def test_redact(self):
        text = ("Signing as Apple Development: someone.name+tag@example.co.uk (ABCDE12345) password: hunter2, "
                "passwd=abc; api_key = K-123 access token: T-9 secret=s3 Authorization: Basic dXNlcjpwYXNz "
                "https://user:pa55@github.com/appium http://u:p@127.0.0.1:8100/status")
        redacted = wda_setup.redact(text)
        for secret in ("someone.name+tag@example.co.uk", "hunter2", "passwd=abc", "K-123", "T-9", "s3 ",
                       "dXNlcjpwYXNz", "pa55", "u:p@"):
            self.assertNotIn(secret, redacted)
        self.assertIn("[redacted email]", redacted)
        self.assertIn("(ABCDE12345)", redacted)
        self.assertIn("https://[redacted]@127.0.0.1:8100/status", redacted)
        self.assertEqual(wda_setup.redact(None), "")

    def test_diagnose_examples(self):
        hints = wda_setup.diagnose("Error Domain=XCTDaemonErrorDomain Code=41 \"Not authorized for performing UI "
                                   "testing actions.\"")
        self.assertEqual(len(hints), 1)
        self.assertIn("iphone_ready", hints[0])
        self.assertIn("Enable UI Automation", hints[0])
        self.assertIn("iphone_ready", wda_setup.diagnose("XCTDaemonErrorDomain error code = 41")[0])
        clt = wda_setup.diagnose("xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer "
                                 "directory '/Library/Developer/CommandLineTools' is a command line tools instance")
        self.assertIn("sudo xcode-select -s", clt[0])
        self.assertIn("Components", wda_setup.diagnose("iOS 26.0 is not installed. To use with Xcode, first "
                                                       "download and install the platform")[0])
        newer = wda_setup.diagnose("The device is not supported by this version of Xcode")
        self.assertIn("update macOS first", newer[0])
        self.assertIn("GitHub", wda_setup.diagnose("fatal: unable to access 'https://github.com/...': Could not "
                                                    "resolve host: github.com")[0])
        self.assertIn("Always Allow", wda_setup.diagnose("errSecInternalComponent")[0])
        self.assertIn("port 8100", wda_setup.diagnose("Failed to start web server on port 8100 with error")[0])
        self.assertIn("iphone_setup(action=\"configure\"", wda_setup.diagnose(
            "Failed to register bundle identifier: The app identifier cannot be registered to your development "
            "team")[0])

    def test_word_boundaries(self):
        self.assertEqual(wda_setup.diagnose("The iPhone is unlocked and nothing is blocked."), [])
        self.assertTrue(any("Unlock the iPhone" in hint for hint in wda_setup.diagnose("Device is locked")))
        self.assertEqual(wda_setup.diagnose("connection to buddy reached its maximum number"), [])
        self.assertEqual(wda_setup.diagnose("unexpired certificate"), [])
        self.assertEqual(wda_setup.diagnose(""), [])
        self.assertEqual(wda_setup.diagnose(None), [])

    def test_cap_and_table_order(self):
        text = ("requires xcode, but active developer directory; errSecInternalComponent; expired; developer mode; "
                "not paired; the iPhone is locked; could not resolve host")
        hints = wda_setup.diagnose(text)
        self.assertEqual(len(hints), 4)
        self.assertIn("Command Line Tools", hints[0])
        self.assertIn("keychain", hints[1])
        self.assertIn("expired", hints[2])
        self.assertIn("Developer Mode", hints[3])

    def test_hints_use_real_tool_names_only(self):
        import re
        names = {"iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
                 "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text",
                 "iphone_wait", "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen",
                 "iphone_metrics"}
        texts = [hint for _, hint in wda_setup._DIAGNOSES] + [
            wda_setup.WIFI_STEP, wda_setup.LOOPBACK_STEP, wda_setup.CONFIGURE_STEP, wda_setup.FETCH_STEP,
            wda_setup.BUILD_STEP, wda_setup.NEEDS_BUILD, wda_setup.SOURCE_MISSING, wda_setup.CONFIGURE_NEXT]
        for text in texts:
            for token in re.findall(r"\biphone_[a-z][a-z_]*", text):
                self.assertIn(token, names, text)


# --- CLI -------------------------------------------------------------------------------------------


class CliTests(SetupCase):
    def run_cli(self, *args):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.tmp,
               "USBMUXD_SOCKET_ADDRESS": "unix:" + os.path.join(self.tmp, "missing.sock"),
               "IPHONE_USE_WDA_URL": "http://127.0.0.1:%d" % self.refused_port()}
        process = subprocess.run([sys.executable, SCRIPT] + list(args), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60, text=True)
        self.assertEqual(process.stderr, "")
        return process.returncode, json.loads(process.stdout)

    def test_status_prints_an_envelope(self):
        code, envelope = self.run_cli("--state-dir", self.state, "status")
        self.assertEqual(code, 0)
        self.assertTrue(envelope["ok"])
        self.assertEqual(envelope["jobs"], [])
        self.assertEqual(envelope["state_dir"], self.state)
        self.assertFalse(envelope["configured"])

    def test_configure_errors_and_success(self):
        code, envelope = self.run_cli("--state-dir", self.state, "configure", "--udid", "id; touch /tmp/pwn",
                                      "--team-id", TEAM, "--bundle-id", BUNDLE)
        self.assertEqual(code, 1)
        self.assertFalse(envelope["ok"])
        self.assertEqual(envelope["error"]["code"], "config_invalid")
        code, envelope = self.run_cli("--state-dir", self.state, "configure", "--udid", UDID, "--team-id", TEAM,
                                      "--bundle-id", BUNDLE, "--country", "GB", "--network-mode", "allow_network",
                                      "--wda-url", "http://127.0.0.1:8100", "--device-port", "8101")
        self.assertEqual(code, 0, envelope)
        self.assertEqual(envelope["config"]["app_store_country"], "gb")
        self.assertEqual(envelope["config"]["network_mode"], "allow_network")
        self.assertEqual(envelope["config"]["wda_url"], "http://127.0.0.1:8100")
        self.assertEqual(envelope["config"]["device_port"], 8101)

    def test_usage_errors(self):
        code, envelope = self.run_cli("--state-dir", self.state, "explode")
        self.assertEqual(code, 2)
        self.assertEqual(envelope["error"]["code"], "invalid_argument")
        code, envelope = self.run_cli("--state-dir", self.state, "status", "--udid", UDID)
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error"]["message"], "status does not take udid.")
        code, envelope = self.run_cli("--state-dir", self.state, "status", "--job-id", "../../config")
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error"]["code"], "invalid_argument")

    def test_state_dir_inside_git(self):
        repository = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(repository, ".git"))
        code, envelope = self.run_cli("--state-dir", os.path.join(repository, "state"), "status")
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error"]["code"], "state_dir_unsafe")

    def test_worker_flag_with_wrong_arguments_exits_quietly(self):
        process = subprocess.run([sys.executable, SCRIPT, wda_setup.WORKER_FLAG, self.state, "x" * 32, "token"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={"PATH": "/usr/bin:/bin", "HOME": self.tmp}, timeout=60)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(process.stdout, b"")
        self.assertEqual(wda_setup.main([wda_setup.WORKER_FLAG, "only-one"]), 2)


if __name__ == "__main__":
    unittest.main()
