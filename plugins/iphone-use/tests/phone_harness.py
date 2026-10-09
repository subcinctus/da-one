"""One fixture for phone tests: FakeWDA + a real WDAClient + PhoneController (DESIGN.md 12.4).

    with PhoneHarness() as h:              # FakeWDA with Settings, SpringBoard and the form app
        h.phone.observe()
        h.fake.actions()                   # the phone mutations the fake received

`via_usbmux=True` routes the client through FakeUsbmuxd (udid UDID, device ports 8100 and
9100 mapped to the fake). Screenshots are converted by a fake `sips`: an executable stub in
a temp bin plus a FakeRunner rule that writes a small JPEG, so the JPEG path is exercised
on any OS. Everything lives in a short private temp dir that close() removes.

Also here, for tests of units C and F: page/cell builders for FakeWDA trees, a recording
stand-in for the ScreenHub, a FakeClock context manager for the controller, and checks
that recovery hints only name real tools.
"""

import contextlib
import os
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from unittest import mock  # noqa: E402

import wda_controller  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from fake_wda import DEFAULT_SIZE, FakeWDA, Node  # noqa: E402
from fakes_cmd import FakeClock, FakeRunner, jpeg_out_effect, write_fake_executable  # noqa: E402
from privstate import prepare_state_dir  # noqa: E402
from wda_client import TcpTransport, UsbmuxTransport, WDAClient  # noqa: E402
from wda_controller import PhoneController  # noqa: E402

UDID = "00008110-0000000000000001"
TOOL_NAMES = ("iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
              "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text",
              "iphone_wait", "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen",
              "iphone_metrics")
FORBIDDEN_TOKENS = ("functions.exec", "view_image", "PUA", "pua_")
TEST_BUNDLE = "com.example.test"


# --- tree builders ------------------------------------------------------------------------------------


def cell(label, y=200, x=60, width=250, height=44, type="Cell", **attributes):
    """A FakeWDA node with a label at the given rect (defaults mirror the reference tests)."""
    return Node(type, label=label, rect=(x, y, width, height), **attributes)


def modal(type="Alert", x=40, y=100, width=310, height=600, **attributes):
    """A native alert or sheet without text."""
    return Node(type, rect=(x, y, width, height), **attributes)


def page(*children, label="Test", size=DEFAULT_SIZE):
    """An Application root whose rect follows the fake's window size (so rotation shows in /source)."""
    width, height = size
    window = Node("Window", rect=(0, 0, width, height), children=list(children))
    return Node("Application", label=label, rect=(0, 0, 0, 0), children=[window])


# --- stand-ins ----------------------------------------------------------------------------------------


class RecordingScreen:
    """Records the controller's preview telemetry (the ScreenHub methods it calls).

    `fail=True` makes every method raise, to prove telemetry never affects actions.
    """

    def __init__(self, fail=False):
        self.fail = fail
        self.gestures = []
        self.viewports = []
        self.seq = 0

    def _check(self):
        if self.fail:
            raise RuntimeError("preview unavailable")

    def gesture(self, kind, point=None, from_point=None, to_point=None, duration_ms=None, viewport=None):
        self._check()
        self.gestures.append({"kind": kind, "point": point, "from_point": from_point, "to_point": to_point,
                              "duration_ms": duration_ms, "viewport": viewport})

    def set_viewport(self, viewport):
        self._check()
        self.viewports.append(dict(viewport))

    def external_seq(self):
        self._check()
        return self.seq

    def note_external_action(self):
        self._check()
        self.seq += 1


@contextlib.contextmanager
def fake_clock(start=1000.0):
    """Patch the controller's clock (monotonic/sleep) with an instant FakeClock."""
    clock = FakeClock(start)
    with mock.patch.object(wda_controller, "time", clock):
        yield clock


def iter_strings(value):
    """Every string (keys and values) inside a JSON-like structure."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            for text in iter_strings(item):
                yield text
    elif isinstance(value, (list, tuple)):
        for item in value:
            for text in iter_strings(item):
                yield text


def iter_next_tools(value):
    """Every value of a `next_tool` key inside a JSON-like structure."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("next_tool", "status_tool"):
                yield item
            for tool in iter_next_tools(item):
                yield tool
    elif isinstance(value, (list, tuple)):
        for item in value:
            for tool in iter_next_tools(item):
                yield tool


def hint_problems(value):
    """Problems with model-facing hints: unknown tool names or Codex-era tokens."""
    problems = []
    for tool in iter_next_tools(value):
        if tool not in TOOL_NAMES:
            problems.append("unknown next_tool %r" % (tool,))
    for text in iter_strings(value):
        for token in FORBIDDEN_TOKENS:
            if token in text:
                problems.append("forbidden token %r in %r" % (token, text[:80]))
    return problems


# --- the harness --------------------------------------------------------------------------------------


class PhoneHarness:
    """FakeWDA + WDAClient + PhoneController (+ optional FakeUsbmuxd) in a private temp dir.

    Arguments: `fake` (an existing FakeWDA, started if needed and not stopped by close()),
    `via_usbmux`, `settle` (controller settle_seconds), `screen` (passed to the controller);
    any other keyword goes to FakeWDA(...).
    """

    def __init__(self, fake=None, via_usbmux=False, settle=0.0, screen=None, **fake_kwargs):
        self._owns_fake = fake is None
        self.fake = fake if fake is not None else FakeWDA(**fake_kwargs)
        self.usbmuxd = None
        self.root = None
        try:
            self.fake.start()
            self.root = short_tmpdir()
            self.state_dir = prepare_state_dir(os.path.join(self.root, "state"))
            if via_usbmux:
                self.usbmuxd = FakeUsbmuxd().start()
                ports = {8100: ("127.0.0.1", self.fake.port),
                         9100: ("127.0.0.1", self.fake.mjpeg_port) if self.fake.mjpeg_port else None}
                self.usbmuxd.add_device(UDID, ports=ports)
                self.transport = UsbmuxTransport(UDID, 8100, env=self.usbmuxd.env())
            else:
                self.transport = TcpTransport(self.fake.url)
            self.client = WDAClient(self.transport)
            self.runner = FakeRunner()
            self.runner.on("sips", effect=jpeg_out_effect())
            self.sips_path = write_fake_executable(os.path.join(self.root, "bin"), "sips", "exit 1\n")
            self.phone = PhoneController(self.client, self.state_dir, screen=screen, runner=self.runner)
            self.phone.settle_seconds = settle
            self.phone.sips_path = self.sips_path
        except BaseException:
            self.close()
            raise

    # --- conveniences ---

    def warm(self, viewport=False):
        """Create the WDA session (and optionally read the viewport), then clear the fake's log."""
        self.client.ensure_session()
        if viewport:
            self.phone.viewport()
        self.fake.clear_log()
        return self

    def show(self, *children, bundle_id=TEST_BUNDLE, label="Test"):
        """Install a page of nodes as `bundle_id` and bring it to the front."""
        self.fake.set_tree(bundle_id, page(*children, label=label, size=self.fake.size))
        self.fake.set_foreground(bundle_id)
        return self

    def show_pages(self, *pages_of_children, bundle_id=TEST_BUNDLE, label="Test"):
        """Install pages (each a list of nodes); every drag advances to the next one."""
        roots = [page(*children, label=label, size=self.fake.size) for children in pages_of_children]
        self.fake.set_pages(bundle_id, roots)
        self.fake.set_foreground(bundle_id)
        return self

    def routes(self):
        return self.fake.routes()

    def actions(self):
        return [str(request) for request in self.fake.actions()]

    def count(self, route):
        """How many logged requests equal "METHOD /route" (or just "/route")."""
        return sum(1 for request in self.fake.calls() if request == route)

    def close(self):
        client = getattr(self, "client", None)
        if client is not None:
            client.close()
        if self.usbmuxd is not None:
            self.usbmuxd.stop()
            self.usbmuxd = None
        if self._owns_fake and self.fake is not None:
            self.fake.stop()
        if self.root is not None:
            shutil.rmtree(self.root, ignore_errors=True)
            self.root = None

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class HarnessCase(unittest.TestCase):
    """Base test case: a fresh PhoneHarness per test (options from `harness_options`)."""

    harness_options = {}

    def setUp(self):
        self.h = self.make_harness(**self.harness_options)
        self.phone = self.h.phone
        self.fake = self.h.fake

    def make_harness(self, **options):
        harness = PhoneHarness(**options)
        self.addCleanup(harness.close)
        return harness

    def assert_code(self, code, operation):
        """Run operation, require a ToolError with `code`, and check its hints are clean."""
        with self.assertRaises(ToolError) as caught:
            operation()
        error = caught.exception
        self.assertEqual(error.code, code, error.as_dict())
        self.assertEqual(hint_problems(error.as_dict()), [])
        return error
