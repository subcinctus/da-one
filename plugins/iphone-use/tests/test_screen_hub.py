import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import contextlib  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import struct  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

import screen_hub  # noqa: E402
from fake_usbmuxd import short_tmpdir  # noqa: E402
from fake_wda import MJPEG_HEADER, TINY_JPEG, mjpeg_part  # noqa: E402
from screen_hub import MJPEG_REQUEST, ScreenHub, normalize_state  # noqa: E402

HEX32 = re.compile(r"[0-9a-f]{32}")
WIRE_KEYS = {"server_time", "stream_id", "seq", "frame_available", "frame_width", "frame_height", "device",
             "viewport", "busy", "operating", "paused", "pause_reason", "capturing", "viewers", "events"}
T0 = 1_700_000_000_000


def synthetic_jpeg(width=440, height=956, payload=b"pixels"):
    frame_header = bytes([8]) + struct.pack(">HH", height, width) + b"\x01\x01\x11\x00"
    return (b"\xff\xd8\xff\xe0\x00\x04AB\xff\xc0\x00\x0b" + frame_header + b"\xff\xda\x00\x02"
            + payload + b"\xff\xd9")


FRAME_A = synthetic_jpeg(1179, 2556, b"frame-a")
FRAME_B = synthetic_jpeg(1179, 2556, b"frame-b")
FRAME_C = synthetic_jpeg(1179, 2556, b"frame-c")


def eventually(predicate, timeout=2.0, message="condition not reached"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


@contextlib.contextmanager
def clock(milliseconds):
    """Pin the hub's wall clock (milliseconds) for state-timing tests."""
    with mock.patch.object(ScreenHub, "_now", return_value=milliseconds):
        yield


class _Peer:
    """The far end of one socketpair: answers like WDA's MJPEG port."""

    def __init__(self, sock, frames, close_after_frames):
        self.sock = sock
        self.frames = list(frames)
        self.close_after_frames = close_after_frames
        self.request = b""
        self.ready = threading.Event()
        self.eof = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.sock.settimeout(10)
            while len(self.request) < len(MJPEG_REQUEST):
                data = self.sock.recv(4096)
                if not data:
                    return
                self.request += data
            self.sock.sendall(MJPEG_HEADER + b"".join(mjpeg_part(frame) for frame in self.frames))
            self.ready.set()
            if self.close_after_frames:
                self.sock.shutdown(socket.SHUT_WR)
            while self.sock.recv(4096):
                pass
        except OSError:
            pass
        finally:
            self.ready.set()
            self.eof.set()

    def send(self, jpeg):
        self.ready.wait(2)
        try:
            self.sock.sendall(mjpeg_part(jpeg))
        except OSError:
            pass

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
        self.thread.join(2)


class FakeStream:
    """A ScreenHub opener: each call returns one end of a new socketpair (or fails, per script)."""

    def __init__(self, frames=(), script=None, close_after_frames=False):
        self.frames = list(frames)
        self.script = list(script or [])     # per call: "fail" | "none" | "frames" | "frames_close"
        self.close_after_frames = close_after_frames
        self.calls = 0
        self.peers = []
        self.lock = threading.Lock()

    def __call__(self):
        with self.lock:
            self.calls += 1
            step = self.script.pop(0) if self.script else ("frames_close" if self.close_after_frames else "frames")
            if step == "fail":
                raise OSError("usbmux connect refused")
            if step == "none":
                return None
            ours, theirs = socket.socketpair()
            peer = _Peer(theirs, self.frames, step == "frames_close")
            self.peers.append(peer)
        peer.thread.start()
        return ours

    @property
    def peer(self):
        with self.lock:
            return self.peers[-1] if self.peers else None

    def close(self):
        with self.lock:
            peers = list(self.peers)
        for peer in peers:
            peer.close()


class HubCase(unittest.TestCase):
    def setUp(self):
        self.root = short_tmpdir()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state_dir = os.path.join(self.root, "state")
        os.mkdir(self.state_dir, 0o700)
        self.hubs = []

    def tearDown(self):
        for hub in self.hubs:
            hub.close()

    def hub(self, opener=None):
        hub = ScreenHub(self.state_dir, opener=opener)
        self.hubs.append(hub)
        return hub

    def stream(self, **kwargs):
        stream = FakeStream(**kwargs)
        self.addCleanup(stream.close)
        return stream

    def raw_file(self):
        with open(os.path.join(self.state_dir, "screen-state.json"), "rb") as handle:
            return json.loads(handle.read().decode("utf-8"))

    def write_raw(self, value):
        with open(os.path.join(self.state_dir, "screen-state.json"), "w") as handle:
            handle.write(value if isinstance(value, str) else json.dumps(value))


class StateFileTests(HubCase):
    def test_default_wire_state(self):
        state = self.hub().state()
        self.assertEqual(set(state), WIRE_KEYS)
        self.assertTrue(HEX32.fullmatch(state["stream_id"]))
        self.assertEqual({key: state[key] for key in WIRE_KEYS - {"server_time", "stream_id"}},
                         {"seq": 0, "frame_available": False, "frame_width": None, "frame_height": None,
                          "device": None, "viewport": None, "busy": False, "operating": False, "paused": False,
                          "pause_reason": None, "capturing": False, "viewers": 0, "events": []})
        self.assertIsInstance(state["server_time"], int)

    def test_normalization_of_a_corrupt_file(self):
        now = T0
        raw = {
            "paused": True, "pause_reason": "something else", "pause_id": "NOT-HEX",
            "actors": {"a" * 32: now - 1000, "b" * 32: now - 200_000, "c" * 32: True, "short": now,
                       "D" * 32: now, "e" * 32: now + 5000},
            "events": [
                {"id": 1, "kind": "tap", "at": now - 100, "point": {"x": 1, "y": 2, "text": "secret"}},
                {"id": 2, "kind": "type", "at": now - 100, "point": {"x": 1, "y": 2}},
                {"id": 3, "kind": "tap", "at": now - 20_000, "point": {"x": 1, "y": 2}},
                {"id": True, "kind": "tap", "at": now, "point": {"x": 1, "y": 2}},
                {"id": 5, "kind": "drag", "at": now, "from": {"x": 1, "y": 2}, "to": {"x": 3, "y": 4},
                 "duration_ms": 6000},
                {"id": 6, "kind": "drag", "at": now, "from": {"x": 1, "y": 2}, "to": {"x": 3, "y": 4},
                 "duration_ms": 300, "viewport": {"width": 390, "height": 844, "units": "points"}},
                {"id": 7, "kind": "tap", "at": now, "point": {"x": float("inf"), "y": 2}},
                "junk",
            ],
            "last_event_id": -4, "finished_at": now - 100, "last_activity_at": "yesterday",
            "viewport": {"width": 0, "height": 844}, "external_seq": -1, "extra": "dropped",
        }
        self.assertEqual(normalize_state(raw, now), {
            "paused": True, "pause_reason": "unknown", "pause_id": None,
            "actors": {"a" * 32: now - 1000},
            "events": [
                {"id": 1, "kind": "tap", "at": now - 100, "point": {"x": 1.0, "y": 2.0}},
                {"id": 6, "kind": "drag", "at": now, "from": {"x": 1.0, "y": 2.0}, "to": {"x": 3.0, "y": 4.0},
                 "duration_ms": 300.0, "viewport": {"width": 390.0, "height": 844.0}},
            ],
            "last_event_id": 6, "finished_at": now - 100, "last_activity_at": 0, "viewport": None,
            "external_seq": 0,
        })
        self.assertEqual(normalize_state(raw, now + 650)["finished_at"], 0)
        self.assertEqual(normalize_state("not a dict", now), normalize_state({}, now))
        unpaused = normalize_state({"paused": "yes", "pause_reason": "authentication", "pause_id": "a" * 32}, now)
        self.assertEqual((unpaused["paused"], unpaused["pause_reason"], unpaused["pause_id"]), (False, None, None))

    def test_unreadable_files_read_as_defaults(self):
        hub = self.hub()
        for content in ("{not json", "[1, 2]", "", "null"):
            self.write_raw(content)
            self.assertFalse(hub.paused())
            self.assertEqual(hub.state()["events"], [])
        self.write_raw(b"\xff\xfe".decode("latin-1"))
        self.assertFalse(hub.paused())

    def test_privacy_and_file_modes(self):
        hub = self.hub()
        hub.set_viewport({"width": 390, "height": 844, "units": "iPhone points", "note": "secret"})
        token = hub.begin("type_text secret password into com.secret.bank")
        hub.gesture("tap", point={"x": 20, "y": 30, "text": "secret"}, viewport={"width": 390, "height": 844,
                                                                                 "units": "iPhone points"})
        hub.end(token)
        with open(os.path.join(self.state_dir, "screen-state.json"), "rb") as handle:
            encoded = handle.read().decode("utf-8")
        for word in ("secret", "password", "type_text", "units", "data", "jpeg"):
            self.assertNotIn(word, encoded)
        for name in ("screen-state.json", ".screen-state.lock"):
            self.assertEqual(os.stat(os.path.join(self.state_dir, name)).st_mode & 0o777, 0o600)
        self.assertEqual(sorted(os.listdir(self.state_dir)), [".screen-state.lock", "screen-state.json"])

    def test_state_file_is_parsed_once_per_change(self):
        hub = self.hub()
        hub.gesture("tap", point={"x": 1, "y": 1})
        with mock.patch("screen_hub.json.loads", wraps=json.loads) as parse:
            for _ in range(200):
                self.assertFalse(hub.paused())
                hub.state()
                hub.pause_status()
            self.assertLessEqual(parse.call_count, 1)
            other = self.hub()
            other.set_paused(True)          # another process replaces the file: seen at once
            self.assertTrue(hub.paused())
            self.assertTrue(hub.state()["paused"])
        os.unlink(os.path.join(self.state_dir, "screen-state.json"))
        self.assertFalse(hub.paused())

    def test_device_model_only(self):
        hub = self.hub()
        hub.device = {"model": "iPhone 16 Pro", "name": "Private Phone Name", "udid": "00008110-0001"}
        self.assertEqual(hub.state()["device"], {"model": "iPhone 16 Pro"})
        hub.device = {"model": "x" * 100}
        self.assertEqual(hub.state()["device"], {"model": "x" * 60})
        for value in (None, "iPhone", {"model": ""}, {"model": 5}):
            hub.device = value
            self.assertIsNone(hub.state()["device"])

    def test_creates_a_missing_state_folder(self):
        nested = os.path.join(self.root, "missing", "state")
        hub = ScreenHub(nested)
        self.hubs.append(hub)
        hub.note_external_action()
        self.assertEqual(hub.external_seq(), 1)


class PauseTests(HubCase):
    def test_pause_hides_reason_id_from_the_wire(self):
        hub = self.hub()
        state = hub.set_paused(True)
        self.assertTrue(state["paused"])
        self.assertEqual(state["pause_reason"], "authentication")
        self.assertNotIn("pause_id", state)
        self.assertNotIn("pause_id", json.dumps(hub.state()))
        self.assertTrue(HEX32.fullmatch(self.raw_file()["pause_id"]))
        self.assertEqual(hub.pause_status(), {"paused": True, "pause_reason": "authentication"})

    def test_pause_clears_activity(self):
        hub = self.hub()
        token = hub.begin("tap")
        hub.gesture("tap", point={"x": 1, "y": 2})
        hub.begin("swipe")
        hub.end(token)
        hub.set_paused(True, "device_locked")
        raw = self.raw_file()
        self.assertEqual((raw["actors"], raw["events"], raw["finished_at"]), ({}, [], 0))
        state = hub.state()
        self.assertEqual((state["busy"], state["operating"], state["events"]), (False, False, []))

    def test_lock_pause_never_downgrades_another_pause(self):
        hub = self.hub()
        hub.set_paused(True, "authentication")
        first_id = self.raw_file()["pause_id"]
        hub.set_paused(True, "device_locked")
        self.assertEqual(hub.pause_status()["pause_reason"], "authentication")
        self.assertEqual(self.raw_file()["pause_id"], first_id)
        self.write_raw({"paused": True, "pause_reason": "legacy"})
        hub.set_paused(True, "device_locked")
        self.assertEqual(hub.pause_status(), {"paused": True, "pause_reason": "unknown"})

    def test_every_applied_pause_gets_a_fresh_id(self):
        hub = self.hub()
        hub.set_paused(True, "device_locked")
        first = self.raw_file()["pause_id"]
        hub.set_paused(True, "device_locked")
        second = self.raw_file()["pause_id"]
        hub.set_paused(True, "authentication")
        third = self.raw_file()["pause_id"]
        self.assertEqual(len({first, second, third}), 3)
        self.assertEqual(hub.pause_status()["pause_reason"], "authentication")

    def test_invalid_reason_is_refused(self):
        hub = self.hub()
        with self.assertRaises(ValueError):
            hub.set_paused(True, "because")
        self.assertFalse(hub.paused())

    def test_explicit_resume_is_unconditional(self):
        hub = self.hub()
        for reason in ("authentication", "device_locked"):
            hub.set_paused(True, reason)
            state = hub.set_paused(False)
            self.assertFalse(state["paused"])
            self.assertIsNone(state["pause_reason"])
            self.assertIsNone(self.raw_file()["pause_id"])

    def test_locked_pause_id(self):
        hub = self.hub()
        self.assertIsNone(hub.locked_pause_id())
        hub.set_paused(True, "authentication")
        self.assertIsNone(hub.locked_pause_id())
        hub.set_paused(False)
        hub.set_paused(True, "device_locked")
        self.assertEqual(hub.locked_pause_id(), self.raw_file()["pause_id"])

    def test_resume_after_unlock(self):
        hub = self.hub()
        self.assertFalse(hub.resume_after_unlock(None))
        self.assertFalse(hub.resume_after_unlock("a" * 32))
        hub.set_paused(True, "device_locked")
        lock_id = hub.locked_pause_id()
        self.assertFalse(hub.resume_after_unlock("b" * 32))
        self.assertTrue(hub.resume_after_unlock(lock_id))
        self.assertFalse(hub.paused())

        hub.set_paused(True, "authentication")
        auth_id = self.raw_file()["pause_id"]
        self.assertFalse(hub.resume_after_unlock(auth_id))           # READY never lifts a sign-in pause
        self.assertTrue(hub.paused())
        self.assertTrue(hub.resume_after_unlock(auth_id, explicit=True))  # the user's own Refresh does
        self.assertFalse(hub.paused())

    def test_pause_created_after_the_probe_survives(self):
        hub, other = self.hub(), self.hub()
        hub.set_paused(True, "device_locked")
        probe_id = hub.reconnect_pause_id()
        other.set_paused(True, "authentication")        # another process pauses during the probe
        self.assertFalse(hub.resume_after_unlock(probe_id, explicit=True))
        self.assertEqual(hub.pause_status(), {"paused": True, "pause_reason": "authentication"})

    def test_reconnect_pause_id_for_a_legacy_pause(self):
        hub = self.hub()
        self.assertIsNone(hub.reconnect_pause_id())
        self.write_raw({"paused": True, "pause_reason": "authentication"})
        pause_id = hub.reconnect_pause_id()
        self.assertTrue(HEX32.fullmatch(pause_id))
        self.assertEqual(hub.reconnect_pause_id(), pause_id)
        self.assertEqual(self.raw_file()["pause_id"], pause_id)
        self.assertTrue(hub.resume_after_unlock(pause_id, explicit=True))


class ActivityTests(HubCase):
    def test_busy_while_running_and_for_the_grace_period(self):
        hub, other = self.hub(), self.hub()
        with clock(T0):
            token = hub.begin("observe")
            self.assertTrue(HEX32.fullmatch(token))
            self.assertTrue(other.state()["busy"])
        with clock(T0 + 100):
            hub.end(token)
            self.assertTrue(other.state()["busy"])
        with clock(T0 + 100 + 649):
            self.assertTrue(other.state()["busy"])
        with clock(T0 + 100 + 650):
            state = other.state()
            self.assertFalse(state["busy"])
            self.assertTrue(state["operating"])          # the 15 s activity tail
        with clock(T0 + 100 + 14_999):
            self.assertTrue(other.state()["operating"])
        with clock(T0 + 100 + 15_000):
            self.assertFalse(other.state()["operating"])

    def test_a_crashed_tool_expires_after_busy_age(self):
        hub = self.hub()
        with clock(T0):
            hub.begin("batch")
        with clock(T0 + screen_hub.BUSY_AGE_MS - 1):
            self.assertTrue(hub.state()["busy"])
        with clock(T0 + screen_hub.BUSY_AGE_MS):
            self.assertFalse(hub.state()["busy"])

    def test_concurrent_actors_and_cap(self):
        hub = self.hub()
        with clock(T0):
            first, second = hub.begin("first"), hub.begin("second")
            hub.end(first)
            self.assertIn(second, self.raw_file()["actors"])
            self.assertNotIn(first, self.raw_file()["actors"])
            for _ in range(40):
                hub.begin("more")
            self.assertEqual(len(self.raw_file()["actors"]), screen_hub.MAX_ACTORS)

    def test_begin_returns_none_while_paused_and_end_tolerates_anything(self):
        hub = self.hub()
        hub.set_paused(True)
        self.assertIsNone(hub.begin("tap"))
        hub.end(None)
        hub.end("f" * 32)
        state = hub.state()
        self.assertFalse(state["busy"])
        hub.set_paused(False)
        token = hub.begin("tap")
        hub.set_paused(True)
        hub.end(token)                          # the pause cleared the actor: no finished_at
        self.assertEqual(self.raw_file()["finished_at"], 0)

    def test_gestures(self):
        hub = self.hub()
        with clock(T0):
            hub.set_viewport({"width": 390, "height": 844})
            hub.gesture("tap", point={"x": 120, "y": 240.5})
            hub.gesture("drag", from_point={"x": 195, "y": 557}, to_point={"x": 195, "y": 287}, duration_ms=449,
                        viewport={"width": 402, "height": 874, "units": "iPhone points"})
            hub.gesture("drag", from_point={"x": 1, "y": 2}, to_point={"x": 3, "y": 4})
            state = hub.state()
        self.assertEqual(state["events"], [
            {"id": 1, "kind": "tap", "at": T0, "point": {"x": 120, "y": 240.5},
             "viewport": {"width": 390, "height": 844}},
            {"id": 2, "kind": "drag", "at": T0, "from": {"x": 195, "y": 557}, "to": {"x": 195, "y": 287},
             "duration_ms": 449, "viewport": {"width": 402, "height": 874}},
            {"id": 3, "kind": "drag", "at": T0, "from": {"x": 1, "y": 2}, "to": {"x": 3, "y": 4},
             "duration_ms": 0, "viewport": {"width": 390, "height": 844}},
        ])
        self.assertTrue(state["operating"])
        with clock(T0):
            self.assertEqual([event["id"] for event in hub.state(2)["events"]], [3])
            self.assertEqual(hub.state(3)["events"], [])
            self.assertEqual(len(hub.state(-5)["events"]), 3)
        with clock(T0 + screen_hub.EVENT_AGE_MS):
            self.assertEqual(hub.state()["events"], [])

    def test_invalid_gestures_are_ignored(self):
        hub = self.hub()
        bad = [
            ("tap", {"point": {"x": float("nan"), "y": 1}}),
            ("tap", {"point": {"x": float("inf"), "y": 1}}),
            ("tap", {"point": {"x": -1, "y": 1}}),
            ("tap", {"point": {"x": 100_001, "y": 1}}),
            ("tap", {"point": {"x": True, "y": 1}}),
            ("tap", {"point": {"x": "1", "y": 1}}),
            ("tap", {"point": {"x": 1}}),
            ("tap", {"point": [1, 2]}),
            ("tap", {}),
            ("drag", {"from_point": {"x": 1, "y": 1}, "to_point": {"x": 2, "y": 2}, "duration_ms": 5001}),
            ("drag", {"from_point": {"x": 1, "y": 1}, "duration_ms": 300}),
            ("drag", {"from_point": {"x": 1, "y": 1}, "to_point": {"x": 2, "y": 2}, "duration_ms": -1}),
            ("type", {"point": {"x": 1, "y": 1}}),
            ("swipe", {"point": {"x": 1, "y": 1}}),
        ]
        for kind, arguments in bad:
            hub.gesture(kind, **arguments)
        self.assertEqual(hub.state()["events"], [])
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "screen-state.json")))

    def test_events_are_capped_and_ids_keep_growing(self):
        hub = self.hub()
        for index in range(45):
            hub.gesture("tap", point={"x": index, "y": 10})
        events = hub.state()["events"]
        self.assertEqual([event["id"] for event in events], list(range(14, 46)))
        self.assertEqual(self.raw_file()["last_event_id"], 45)

    def test_gestures_are_ignored_while_paused(self):
        hub = self.hub()
        hub.set_paused(True)
        hub.gesture("tap", point={"x": 1, "y": 1})
        self.assertEqual(self.raw_file()["events"], [])
        self.assertEqual(hub.state()["events"], [])
        self.assertFalse(hub.state()["operating"])

    def test_viewport(self):
        hub = self.hub()
        for bad in ({"width": 0, "height": 844}, {"width": -1, "height": 2}, {"width": "390", "height": 844},
                    None, [390, 844], {"width": float("nan"), "height": 1}):
            hub.set_viewport(bad)
        self.assertIsNone(hub.state()["viewport"])
        hub.set_viewport({"width": 393.5, "height": 852, "units": "iPhone points"})
        self.assertEqual(hub.state()["viewport"], {"width": 393.5, "height": 852})

    def test_concurrent_transactions_never_lose_an_event(self):
        hubs = [self.hub(), self.hub()]

        def tap(hub):
            for index in range(25):
                hub.gesture("tap", point={"x": index, "y": 1})

        threads = [threading.Thread(target=tap, args=(hubs[index % 2],)) for index in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        raw = self.raw_file()
        self.assertEqual(raw["last_event_id"], 100)
        self.assertEqual([event["id"] for event in raw["events"]], list(range(69, 101)))

    def test_external_seq_is_shared(self):
        hub, other = self.hub(), self.hub()
        self.assertEqual(hub.external_seq(), 0)
        hub.note_external_action()
        hub.note_external_action()
        self.assertEqual(other.external_seq(), 2)


class CaptureTests(HubCase):
    def capture_hub(self, **stream_kwargs):
        stream = self.stream(**stream_kwargs)
        return self.hub(stream), stream

    def test_frames_are_published_and_identical_frames_skipped(self):
        hub, stream = self.capture_hub(frames=[FRAME_A, FRAME_A, FRAME_A])
        viewer = hub.attach_viewer()
        eventually(lambda: hub.latest_frame() is not None)
        stream.peer.send(FRAME_A)
        stream.peer.send(FRAME_B)
        eventually(lambda: hub.latest_frame().jpeg == FRAME_B)
        frame = hub.latest_frame()
        self.assertEqual((frame.seq, frame.width, frame.height), (2, 1179, 2556))
        state = hub.state()
        self.assertEqual((state["seq"], state["frame_available"], state["frame_width"], state["frame_height"],
                          state["capturing"], state["viewers"]), (2, True, 1179, 2556, True, 1))
        self.assertEqual(stream.peer.request, MJPEG_REQUEST)
        hub.detach_viewer(viewer)

    def test_wait_frame(self):
        hub, stream = self.capture_hub(frames=[FRAME_A])
        hub.attach_viewer()
        first = hub.wait_frame(0, 2.0)
        self.assertEqual((first.seq, first.jpeg), (1, FRAME_A))
        started = time.monotonic()
        self.assertIsNone(hub.wait_frame(1, 0.1))
        self.assertLess(time.monotonic() - started, 1.0)
        timer = threading.Timer(0.05, stream.peer.send, args=(FRAME_B,))
        timer.start()
        self.addCleanup(timer.cancel)
        second = hub.wait_frame(1, 2.0)
        self.assertEqual((second.seq, second.jpeg), (2, FRAME_B))

    def test_waiters_wake_up_on_pause_and_the_frame_is_erased(self):
        hub, _ = self.capture_hub(frames=[FRAME_A])
        hub.attach_viewer()
        frame = hub.wait_frame(0, 2.0)
        results = []
        waiter = threading.Thread(target=lambda: results.append(hub.wait_frame(frame.seq, 5.0)))
        waiter.start()
        time.sleep(0.05)
        started = time.monotonic()
        hub.set_paused(True)
        waiter.join(2)
        self.assertEqual(results, [None])
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIsNone(hub.latest_frame())
        self.assertFalse(hub.state()["frame_available"])

    def test_a_late_capture_cannot_repopulate_a_paused_frame(self):
        hub, _ = self.capture_hub(frames=[FRAME_A])
        hub.attach_viewer()
        hub.wait_frame(0, 2.0)
        run = hub._run
        hub.set_paused(True)
        hub._publish(run, FRAME_B, 1179, 2556)
        self.assertIsNone(hub.latest_frame())
        self.assertIsNone(hub._frame)

    def test_lease_expiry_stops_capture_but_keeps_the_frame(self):
        with mock.patch.object(screen_hub, "LEASE_SECONDS", 0.2):
            hub, stream = self.capture_hub(frames=[FRAME_A])
            viewer = hub.attach_viewer()
            hub.wait_frame(0, 2.0)
            peer = stream.peer
            hub.detach_viewer(viewer)
            self.assertTrue(hub.state()["capturing"])        # the lease keeps it running a moment
            eventually(lambda: peer.eof.is_set(), message="the hub never closed its socket")
            eventually(lambda: not hub.state()["capturing"])
            self.assertEqual(hub.latest_frame().jpeg, FRAME_A)
            self.assertTrue(hub.state()["frame_available"])
            calls = stream.calls
            hub.attach_viewer()                             # a returning viewer reconnects
            eventually(lambda: stream.calls > calls)

    def test_close_erases_the_frame_and_stops_for_good(self):
        hub, stream = self.capture_hub(frames=[FRAME_A])
        hub.attach_viewer()
        hub.wait_frame(0, 2.0)
        peer = stream.peer
        hub.close()
        self.assertIsNone(hub.latest_frame())
        self.assertFalse(hub.state()["capturing"])
        eventually(lambda: peer.eof.is_set())
        calls = stream.calls
        hub.attach_viewer()
        time.sleep(0.1)
        self.assertEqual(stream.calls, calls)
        self.assertIsNone(hub.wait_frame(0, 0.05))

    def test_restart_erases_the_frame_and_starts_a_new_stream(self):
        hub, stream = self.capture_hub(frames=[FRAME_A])
        hub.device = {"model": "iPhone 16 Pro"}
        viewer = hub.attach_viewer()
        hub.wait_frame(0, 2.0)
        before = hub.state()["stream_id"]
        peer = stream.peer
        state = hub.restart()
        self.assertNotEqual(state["stream_id"], before)
        self.assertEqual((state["seq"], state["frame_available"], state["capturing"]), (0, False, False))
        self.assertEqual(state["device"], {"model": "iPhone 16 Pro"})
        self.assertFalse(state["paused"])
        eventually(lambda: peer.eof.is_set())
        hub.detach_viewer(viewer)
        hub.attach_viewer()                                  # the page reconnects to the new stream
        frame = hub.wait_frame(0, 2.0)
        self.assertEqual(frame.seq, 1)

    def test_no_opener_means_no_capture(self):
        hub = self.hub()
        before = threading.active_count()
        hub.attach_viewer()
        self.assertFalse(hub.state()["capturing"])
        self.assertIsNone(hub._run)
        self.assertEqual(threading.active_count(), before)

    def test_unconfigured_opener_backs_off_until_the_lease_ends(self):
        with mock.patch.object(screen_hub, "BACKOFF_START", 0.01), mock.patch.object(screen_hub, "BACKOFF_MAX", 0.02), \
                mock.patch.object(screen_hub, "LEASE_SECONDS", 0.1):
            hub, stream = self.capture_hub(script=["none"] * 1000)
            viewer = hub.attach_viewer()
            eventually(lambda: stream.calls >= 3)
            hub.detach_viewer(viewer)
            eventually(lambda: not hub.state()["capturing"])
            calls = stream.calls
            time.sleep(0.1)
            self.assertEqual(stream.calls, calls)
            self.assertFalse(hub.state()["frame_available"])

    def test_backoff_grows_and_resets_after_a_connection_that_produced_a_frame(self):
        waits = []
        original = ScreenHub._backoff_wait

        def recording(hub, run, seconds):
            waits.append(seconds)
            return original(hub, run, seconds)

        script = ["fail", "fail", "fail", "frames_close", "fail", "fail"]
        with mock.patch.object(screen_hub, "BACKOFF_START", 0.01), mock.patch.object(screen_hub, "BACKOFF_MAX", 0.04), \
                mock.patch.object(ScreenHub, "_backoff_wait", recording):
            hub, stream = self.capture_hub(frames=[FRAME_A], script=script)
            hub.attach_viewer()
            eventually(lambda: len(waits) >= 6)
            hub.close()
        self.assertEqual(waits[:6], [0.01, 0.02, 0.04, 0.01, 0.02, 0.04])
        self.assertEqual(hub._frame, None)          # erased by close()

    def test_a_failure_keeps_the_last_frame(self):
        with mock.patch.object(screen_hub, "BACKOFF_START", 0.01):
            hub, stream = self.capture_hub(frames=[FRAME_A], script=["frames_close"] + ["fail"] * 1000)
            hub.attach_viewer()
            frame = hub.wait_frame(0, 2.0)
            eventually(lambda: stream.calls >= 3)
            self.assertEqual(hub.latest_frame(), frame)

    def test_pause_from_another_process_stops_capture_and_blocks_restart(self):
        hub, stream = self.capture_hub(frames=[FRAME_A])
        other = self.hub()
        hub.attach_viewer()
        hub.wait_frame(0, 2.0)
        peer = stream.peer
        started = time.monotonic()
        other.set_paused(True)
        eventually(lambda: peer.eof.is_set(), timeout=1.0, message="capture did not stop")
        self.assertLess(time.monotonic() - started, 1.0)
        eventually(lambda: hub._frame is None, timeout=1.0)
        self.assertIsNone(hub.latest_frame())
        self.assertTrue(hub.state()["paused"])
        self.assertFalse(hub.state()["capturing"])
        calls = stream.calls
        hub.attach_viewer()
        time.sleep(0.15)
        self.assertEqual(stream.calls, calls)
        other.set_paused(False)
        hub.attach_viewer()
        eventually(lambda: stream.calls > calls)
        self.assertEqual(hub.wait_frame(0, 2.0).jpeg, FRAME_A)

    def test_pause_from_a_separate_process(self):
        hub, stream = self.capture_hub(frames=[FRAME_A])
        hub.attach_viewer()
        hub.wait_frame(0, 2.0)
        peer = stream.peer
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import screen_hub; "
                "hub = screen_hub.ScreenHub(sys.argv[2]); hub.set_paused(True, 'authentication'); "
                "hub.note_external_action(); hub.close()")
        result = subprocess.run([sys.executable, "-I", "-c", code, SERVER, self.state_dir], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
        eventually(lambda: peer.eof.is_set(), timeout=1.0, message="capture did not stop")
        self.assertIsNone(hub.latest_frame())
        self.assertEqual(hub.pause_status(), {"paused": True, "pause_reason": "authentication"})
        self.assertEqual(hub.external_seq(), 1)

    def test_frames_never_touch_the_disk(self):
        hub, stream = self.capture_hub(frames=[FRAME_A, FRAME_B])
        hub.attach_viewer()
        eventually(lambda: hub.latest_frame() is not None and hub.latest_frame().jpeg == FRAME_B)
        hub.gesture("tap", point={"x": 1, "y": 1})
        for name in os.listdir(self.state_dir):
            with open(os.path.join(self.state_dir, name), "rb") as handle:
                content = handle.read()
            self.assertNotIn(b"frame-a", content)
            self.assertNotIn(b"frame-b", content)
            self.assertNotIn(b"\xff\xd8", content)

    def test_viewer_count(self):
        hub = self.hub()
        first, second = hub.attach_viewer(), hub.attach_viewer()
        self.assertEqual(hub.viewer_count(), 2)
        hub.detach_viewer(first)
        hub.detach_viewer(first)
        hub.detach_viewer("unknown")
        self.assertEqual(hub.viewer_count(), 1)
        hub.detach_viewer(second)
        self.assertEqual(hub.viewer_count(), 0)
        self.assertEqual(hub.state()["viewers"], 0)


if __name__ == "__main__":
    unittest.main()
