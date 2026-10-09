"""Live preview capture and the preview state shared by every iPhone Use process.

Two jobs live here:

* Reading WebDriverAgent's MJPEG screen stream (device port 9100) over a usbmux tunnel
  (or loopback TCP) into one in-memory "latest frame". Capture runs only while somebody
  watches the preview page, plus a short lease afterwards. Frames never touch the disk,
  logs or stdout, and a pause erases the frame at once.
* The small cross-process state file ``screen-state.json``: pause state, running tools,
  recent tap/drag gestures, the screen size in points and a counter of the user's own
  toolbar actions. Every MCP process and the preview page see the same state. The file
  never holds operation names, app ids, typed text, selectors or pixels.
"""

import collections
import contextlib
import copy
import json
import math
import os
import pathlib
import re
import socket
import threading
import time
import uuid
from typing import Optional

import privstate
import wda_client
from wda_image import jpeg_dimensions

STATE_FILE = "screen-state.json"
LOCK_FILE = ".screen-state.lock"
MAX_FRAME_BYTES = 4 * 1024 * 1024
LEASE_SECONDS = 5.0            # capture continues this long after the last viewer detaches
EVENT_AGE_MS = 10_000          # gesture events older than this are dropped on read
BUSY_AGE_MS = 120_000          # an actor older than this belongs to a crashed tool call
ACTIVITY_GRACE_MS = 650        # busy stays true this long after the last tool ended
OPERATING_TAIL_MS = 15_000     # the "operating" glow stays on this long after activity
MAX_EVENTS = 32
MAX_ACTORS = 32
STARTUP_TIMEOUT = 5.0          # MJPEG response headers must arrive within this
IDLE_TIMEOUT = 15.0            # WDA sends nothing for up to 10 s while its capture backs off
BACKOFF_START = 0.5
BACKOFF_MAX = 2.0
MJPEG_REQUEST = (b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: multipart/x-mixed-replace\r\n"
                 b"Connection: close\r\n\r\n")
Frame = collections.namedtuple("Frame", "seq jpeg width height at")

PAUSE_REASONS = ("authentication", "device_locked")
CAPTURE_THREAD_NAME = "iphone-preview-capture"
RECV_SIZE = 65536
RECV_TICK = 0.25               # socket timeout while streaming: how often keep_going() is checked
BACKOFF_TICK = 0.05
MAX_RESPONSE_HEAD = 16 * 1024  # MJPEG response header block limit
FEED_SLICE = 64 * 1024         # parser input is processed in slices of this size
RESET_SLACK = 64 * 1024        # parser buffer may exceed max_bytes by this much before a reset
PART_HEADER_LIMIT = 16 * 1024  # bytes kept while waiting for the end of a part header block
KEEP_TAIL = 3                  # bytes kept on a reset ("\r\n\r" or a split FF D8 marker)
MAX_NUMBER = 100_000
MAX_DURATION_MS = 5000
DEVICE_MODEL_LIMIT = 60

_HEX32_RE = re.compile(r"[0-9a-f]{32}")
_CONTENT_LENGTH_RE = re.compile(rb"(?im)^[ \t]*content-length[ \t]*:[ \t]*([0-9]{1,12})[ \t]*\r?$")
_STATUS_OK_RE = re.compile(rb"HTTP/1\.[01] 200(?:[ \t]|$)")
_CHUNKED_RE = re.compile(rb"(?im)^transfer-encoding[ \t]*:[^\r\n]*\bchunked\b")
_CHUNK_SIZE_RE = re.compile(rb"[0-9A-Fa-f]{1,16}")
MAX_CHUNK_LINE = 4096


# ---------------------------------------------------------------------------------------------
# MJPEG parsing
# ---------------------------------------------------------------------------------------------


class MJPEGError(Exception):
    """The MJPEG stream did not start, answered wrongly, or stopped sending."""


class Dechunker:
    """Strips HTTP/1.1 chunked transfer framing from a byte stream, incrementally.

    WebDriverAgent never chunks its MJPEG body, but a proxy or another server might.
    Bad size lines or a missing CRLF after a chunk raise MJPEGError. After the final
    zero-size chunk (and its trailer) `finished` is true and further input is ignored.
    """

    def __init__(self):
        self._state = "size"       # size -> data -> data_end -> size ... -> trailer -> done
        self._line = bytearray()
        self._remaining = 0
        self._data_end = bytearray()

    @property
    def finished(self) -> bool:
        return self._state == "done"

    def feed(self, data) -> bytes:
        data = bytes(data)
        out = bytearray()
        position = 0
        total = len(data)
        while position < total and self._state != "done":
            if self._state == "data":
                take = min(self._remaining, total - position)
                out += data[position:position + take]
                position += take
                self._remaining -= take
                if self._remaining == 0:
                    self._state = "data_end"
                    self._data_end = bytearray()
            elif self._state == "data_end":
                take = min(2 - len(self._data_end), total - position)
                self._data_end += data[position:position + take]
                position += take
                if len(self._data_end) == 2:
                    if bytes(self._data_end) != b"\r\n":
                        raise MJPEGError("chunk data is not followed by CRLF")
                    self._state = "size"
            else:  # "size" or "trailer": line based
                newline = data.find(b"\n", position)
                if newline < 0:
                    self._line += data[position:]
                    position = total
                    if len(self._line) > MAX_CHUNK_LINE:
                        raise MJPEGError("chunk size line is too long")
                    break
                self._line += data[position:newline]
                position = newline + 1
                if len(self._line) > MAX_CHUNK_LINE:
                    raise MJPEGError("chunk size line is too long")
                line = bytes(self._line).rstrip(b"\r")
                self._line = bytearray()
                if self._state == "size":
                    self._start_chunk(line)
                elif line == b"":
                    self._state = "done"
        return bytes(out)

    def _start_chunk(self, line):
        size_text = line.split(b";", 1)[0].strip()
        if not _CHUNK_SIZE_RE.fullmatch(size_text):
            raise MJPEGError("invalid chunk size line")
        size = int(size_text, 16)
        if size == 0:
            self._state = "trailer"
        else:
            self._remaining = size
            self._state = "data"


class MJPEGParser:
    """Turns an MJPEG multipart body into complete, valid JPEG frames.

    Parts are framed by their Content-Length header (exact; JPEGs may embed an EXIF
    thumbnail with its own FF D8 ... FF D9). Parts without Content-Length fall back to
    SOI/EOI scanning. The declared multipart boundary is never trusted (WDA declares
    one boundary and writes another). Only data that starts with FF D8 and has a
    readable frame header is emitted; everything else is skipped silently. Memory stays
    bounded: oversized parts are discarded without buffering and garbage is trimmed.
    """

    def __init__(self, max_bytes=MAX_FRAME_BYTES):
        self.max_bytes = int(max_bytes)
        self._buffer = bytearray()
        self._need = None       # bytes of a Content-Length body still to collect
        self._skip = 0          # bytes of an oversized body still to discard

    @property
    def buffered(self) -> int:
        """Bytes held right now (0 to 3 between complete parts)."""
        return len(self._buffer)

    def feed(self, data) -> list:
        """Add bytes; return [(jpeg_bytes, (width, height)), ...] for every completed frame."""
        frames = []
        view = memoryview(data)
        for start in range(0, len(view), FEED_SLICE):
            piece = view[start:start + FEED_SLICE]
            if self._skip:
                dropped = min(self._skip, len(piece))
                self._skip -= dropped
                piece = piece[dropped:]
                if not len(piece):
                    continue
            self._buffer += piece
            self._drain(frames)
        return frames

    def _drain(self, frames):
        buffer = self._buffer
        while True:
            if self._skip:
                dropped = min(self._skip, len(buffer))
                del buffer[:dropped]
                self._skip -= dropped
                if self._skip:
                    return
            if self._need is not None:
                if len(buffer) < self._need:
                    return
                part = bytes(buffer[:self._need])
                del buffer[:self._need]
                self._need = None
                self._emit(part, frames)
                continue
            header_end = buffer.find(b"\r\n\r\n")
            soi = buffer.find(b"\xff\xd8")
            if header_end >= 0 and (soi < 0 or header_end < soi):
                block = bytes(buffer[:header_end])
                del buffer[:header_end + 4]
                self._start_part(block)
                continue
            if soi >= 0:
                if soi:
                    del buffer[:soi]
                eoi = buffer.find(b"\xff\xd9", 2)
                if eoi < 0:
                    if len(buffer) > self.max_bytes + RESET_SLACK:
                        self._reset()
                    return
                part = bytes(buffer[:eoi + 2])
                del buffer[:eoi + 2]
                self._emit(part, frames)
                continue
            # Neither a complete header block nor a JPEG start. A part header that is still
            # arriving starts with its "--boundary" line: keep from the last "--" (at most
            # PART_HEADER_LIMIT bytes), otherwise only the last 3 bytes.
            boundary = buffer.rfind(b"--")
            if boundary >= 0 and len(buffer) - boundary <= PART_HEADER_LIMIT:
                del buffer[:boundary]
            else:
                self._reset()
            return

    def _start_part(self, block):
        match = _CONTENT_LENGTH_RE.search(block)
        if match is None:
            return
        length = int(match.group(1))
        if length <= 0:
            return
        if length > self.max_bytes:
            self._skip = length          # drop an oversized frame without buffering it
        else:
            self._need = length

    def _reset(self):
        tail = bytes(self._buffer[-KEEP_TAIL:])
        self._buffer = bytearray(tail)
        self._need = None

    @staticmethod
    def _emit(part, frames):
        if not part.startswith(b"\xff\xd8"):
            return
        dimensions = jpeg_dimensions(part)
        if dimensions is not None:
            frames.append((part, dimensions))


def _read_response_head(sock, keep_going, startup_timeout):
    """(header_block, leftover_bytes) of the MJPEG response, or (None, b"") when stopped."""
    deadline = time.monotonic() + startup_timeout
    buffer = bytearray()
    while True:
        end = buffer.find(b"\r\n\r\n")
        if end >= 0:
            return bytes(buffer[:end]), bytes(buffer[end + 4:])
        if len(buffer) > MAX_RESPONSE_HEAD:
            raise MJPEGError("the stream's response header is too large")
        if not keep_going():
            return None, b""
        if time.monotonic() >= deadline:
            raise MJPEGError("startup timeout")
        try:
            chunk = sock.recv(RECV_SIZE)
        except socket.timeout:
            continue
        if not chunk:
            raise MJPEGError("the stream closed before answering")
        buffer += chunk


def read_mjpeg(sock, on_frame, keep_going, startup_timeout=STARTUP_TIMEOUT, idle_timeout=IDLE_TIMEOUT) -> None:
    """Request WDA's MJPEG stream on `sock` and call on_frame(jpeg, width, height) per frame.

    WDA sends nothing until it receives some bytes, so the request goes first. Bytes
    that arrived together with the response header (or even with the usbmux reply) are
    parsed first, so no frame byte is lost. Returns on EOF or when keep_going() turns
    false; raises MJPEGError on a startup timeout, a non-200 answer or `idle_timeout`
    seconds without any byte. Socket errors propagate as OSError.
    """
    if not keep_going():
        return
    sock.sendall(MJPEG_REQUEST)
    sock.settimeout(RECV_TICK)
    head, leftover = _read_response_head(sock, keep_going, startup_timeout)
    if head is None:
        return
    status_line = head.split(b"\r\n", 1)[0]
    if not _STATUS_OK_RE.match(status_line):
        raise MJPEGError("the screen stream did not answer 200")
    dechunker = Dechunker() if _CHUNKED_RE.search(head) else None
    parser = MJPEGParser()

    def consume(data):
        if dechunker is not None:
            data = dechunker.feed(data)
        for jpeg, (width, height) in parser.feed(data):
            if not keep_going():
                return
            on_frame(jpeg, width, height)

    consume(leftover)
    last_bytes = time.monotonic()
    while keep_going():
        if dechunker is not None and dechunker.finished:
            return
        try:
            chunk = sock.recv(RECV_SIZE)
        except socket.timeout:
            if time.monotonic() - last_bytes >= idle_timeout:
                raise MJPEGError("idle")
            continue
        if not chunk:
            return
        last_bytes = time.monotonic()
        consume(chunk)


def open_mjpeg_socket(config, env=None, timeout=5.0) -> Optional[socket.socket]:
    """A raw socket to the configured iPhone's MJPEG port, or None when nothing is configured.

    The transport rules of wda_client apply: usbmux tunnels only to the configured UDID,
    TCP only to a loopback URL. A bad URL raises ValueError; connection problems raise
    OSError (UsbmuxError is one).
    """
    transport = wda_client.resolve_transport(config, env)
    if transport.kind == "none":
        return None
    port = privstate.config_int(config, "mjpeg_port", wda_client.DEFAULT_MJPEG_PORT)
    return transport.open_socket(port, timeout)


# ---------------------------------------------------------------------------------------------
# Shared state normalization (screen-state.json)
# ---------------------------------------------------------------------------------------------


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_hex32(value) -> bool:
    return isinstance(value, str) and _HEX32_RE.fullmatch(value) is not None


def _number(value, maximum=MAX_NUMBER):
    """A finite int/float (not bool) in 0..maximum as float, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(number) or not 0 <= number <= maximum:
        return None
    return number


def _point(value):
    if not isinstance(value, dict):
        return None
    x, y = _number(value.get("x")), _number(value.get("y"))
    if x is None or y is None:
        return None
    return {"x": x, "y": y}


def _viewport(value):
    """{"width", "height"} from a mapping with non-zero numeric width and height (other keys ignored)."""
    if not isinstance(value, dict):
        return None
    width, height = _number(value.get("width")), _number(value.get("height"))
    if not width or not height:
        return None
    return {"width": width, "height": height}


def _clean_event(item, now):
    if not isinstance(item, dict):
        return None
    kind = item.get("kind")
    identifier = item.get("id")
    at = item.get("at")
    if kind not in ("tap", "drag") or not _is_int(identifier) or identifier < 0 or not _is_int(at):
        return None
    if not 0 <= now - at < EVENT_AGE_MS:
        return None
    event = {"id": identifier, "kind": kind, "at": at}
    if kind == "tap":
        point = _point(item.get("point"))
        if point is None:
            return None
        event["point"] = point
    else:
        origin, target = _point(item.get("from")), _point(item.get("to"))
        duration = _number(item.get("duration_ms"), MAX_DURATION_MS)
        if origin is None or target is None or duration is None:
            return None
        event.update({"from": origin, "to": target, "duration_ms": duration})
    viewport = _viewport(item.get("viewport"))
    if viewport is not None:
        event["viewport"] = viewport
    return event


def normalize_state(raw, now) -> dict:
    """The shared state in its one valid shape (also what gets written back).

    Expired actors (older than BUSY_AGE_MS), expired or malformed gesture events, an
    expired finished_at and every unknown key are dropped. Never returns references
    into `raw`.
    """
    raw = raw if isinstance(raw, dict) else {}
    paused = raw.get("paused") is True
    pause_reason = None
    pause_id = None
    if paused:
        pause_reason = raw.get("pause_reason")
        if pause_reason not in PAUSE_REASONS:
            pause_reason = "unknown"
        if _is_hex32(raw.get("pause_id")):
            pause_id = raw["pause_id"]

    actors = {}
    raw_actors = raw.get("actors")
    if isinstance(raw_actors, dict):
        for key, at in raw_actors.items():
            if _is_hex32(key) and _is_int(at) and 0 <= now - at < BUSY_AGE_MS:
                actors[key] = at
    if len(actors) > MAX_ACTORS:
        actors = dict(list(actors.items())[-MAX_ACTORS:])

    events = []
    raw_events = raw.get("events")
    if isinstance(raw_events, list):
        for item in raw_events[-MAX_EVENTS:]:
            event = _clean_event(item, now)
            if event is not None:
                events.append(event)

    last_event_id = raw.get("last_event_id")
    if not _is_int(last_event_id) or last_event_id < 0:
        last_event_id = 0
    if events:
        last_event_id = max(last_event_id, max(event["id"] for event in events))

    finished_at = raw.get("finished_at")
    if not _is_int(finished_at) or not 0 <= now - finished_at < ACTIVITY_GRACE_MS:
        finished_at = 0
    last_activity_at = raw.get("last_activity_at")
    if not _is_int(last_activity_at) or last_activity_at < 0:
        last_activity_at = 0
    external_seq = raw.get("external_seq")
    if not _is_int(external_seq) or external_seq < 0:
        external_seq = 0

    return {"paused": paused, "pause_reason": pause_reason, "pause_id": pause_id,
            "actors": actors, "events": events, "last_event_id": last_event_id,
            "finished_at": finished_at, "last_activity_at": last_activity_at,
            "viewport": _viewport(raw.get("viewport")), "external_seq": external_seq}


def _wire_number(value):
    """Integral floats as ints for the page (390.0 -> 390)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _wire_size(size):
    if size is None:
        return None
    return {"width": _wire_number(size["width"]), "height": _wire_number(size["height"])}


def _wire_point(point):
    return {"x": _wire_number(point["x"]), "y": _wire_number(point["y"])}


def _wire_event(event):
    wire = {"id": event["id"], "kind": event["kind"], "at": event["at"]}
    if event["kind"] == "tap":
        wire["point"] = _wire_point(event["point"])
    else:
        wire["from"] = _wire_point(event["from"])
        wire["to"] = _wire_point(event["to"])
        wire["duration_ms"] = _wire_number(event["duration_ms"])
    if "viewport" in event:
        wire["viewport"] = _wire_size(event["viewport"])
    return wire


def _wire_device(device):
    if isinstance(device, dict) and isinstance(device.get("model"), str) and device["model"].strip():
        return {"model": device["model"].strip()[:DEVICE_MODEL_LIMIT]}
    return None


def _close_quietly(sock):
    try:
        sock.close()
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------
# ScreenHub
# ---------------------------------------------------------------------------------------------


class _CaptureRun:
    """The private handles of one capture thread: its stop flag and its own socket."""

    def __init__(self):
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.sock = None
        self.thread = None
        self.produced = False

    def interrupt(self):
        """Wake a blocked recv on this run's socket (the capture thread closes it itself)."""
        with self.lock:
            sock = self.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


class ScreenHub:
    """The preview's frame source and the shared preview state, for one MCP process.

    Thread-safe. Methods raise on real problems (for example an unwritable state
    folder); callers that only emit telemetry wrap their calls.
    """

    def __init__(self, state_dir, opener=None):
        self.state_dir = pathlib.Path(state_dir)
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.opener = opener            # callable() -> socket | None; None = no capture at all
        self.device = None              # {"model": "iPhone 16 Pro"} set by the runtime, or None
        self.stream_id = uuid.uuid4().hex
        self._state_path = self.state_dir / STATE_FILE
        self._lock_path = self.state_dir / LOCK_FILE
        self._lock = threading.RLock()
        self._frame_changed = threading.Condition(self._lock)
        self._frame = None
        self._seq = 0
        self._wake = 0                  # bumped when frame waiters must give up (pause, restart, close)
        self._viewers = {}
        self._lease_until = 0.0
        self._run = None
        self._closed = False
        self._cache = None              # ((st_ino, st_mtime_ns, st_size), parsed raw dict)

    # --- shared state file ----------------------------------------------------------------

    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)

    def _raw_state(self) -> dict:
        """The parsed state file; re-parsed only when its inode, mtime or size changed."""
        try:
            status = os.stat(str(self._state_path))
        except OSError:
            return {}
        signature = (status.st_ino, status.st_mtime_ns, status.st_size)
        cached = self._cache
        if cached is not None and cached[0] == signature:
            return cached[1]
        try:
            with open(str(self._state_path), "rb") as handle:
                raw = json.loads(handle.read().decode("utf-8"))
        except (OSError, ValueError, RecursionError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        self._cache = (signature, raw)
        return raw

    def _read_state(self, now=None) -> dict:
        return normalize_state(self._raw_state(), self._now() if now is None else now)

    def _file_paused(self) -> bool:
        return self._raw_state().get("paused") is True

    def _remember(self, state):
        try:
            status = os.stat(str(self._state_path))
        except OSError:
            self._cache = None
            return
        self._cache = ((status.st_ino, status.st_mtime_ns, status.st_size), copy.deepcopy(state))

    @contextlib.contextmanager
    def _transaction(self):
        """Read, normalize, let the caller mutate, write back (only if changed); all under flock."""
        with privstate.FileLock(self._lock_path):
            state = normalize_state(self._raw_state(), self._now())
            before = copy.deepcopy(state)
            yield state
            if state != before:
                privstate.write_json_private(self._state_path, state)
                self._remember(state)

    # --- wire state -----------------------------------------------------------------------

    def state(self, last_event_id=0) -> dict:
        """What the preview page and iphone_screen see (never pixels, never the pause id)."""
        if not _is_int(last_event_id) or last_event_id < 0:
            last_event_id = 0
        now = self._now()
        shared = self._read_state(now)
        paused = shared["paused"]
        with self._lock:
            if paused:
                self._erase_frame_locked()
            frame = self._frame
            seq = self._seq
            stream_id = self.stream_id
            viewers = len(self._viewers)
            capturing = self._run is not None
            device = _wire_device(self.device)
        busy = bool(shared["actors"] or shared["finished_at"]) and not paused
        last_activity = shared["last_activity_at"]
        recent = bool(last_activity) and 0 <= now - last_activity < OPERATING_TAIL_MS
        events = [] if paused else [_wire_event(event) for event in shared["events"]
                                    if event["id"] > last_event_id]
        return {"server_time": now, "stream_id": stream_id, "seq": seq,
                "frame_available": frame is not None,
                "frame_width": frame.width if frame is not None else None,
                "frame_height": frame.height if frame is not None else None,
                "device": device, "viewport": _wire_size(shared["viewport"]),
                "busy": busy, "operating": not paused and (busy or recent),
                "paused": paused, "pause_reason": shared["pause_reason"],
                "capturing": capturing and not paused, "viewers": viewers,
                "events": events}

    # --- frames ---------------------------------------------------------------------------

    def _erase_frame_locked(self):
        if self._frame is not None:
            self._frame = None
            self._frame_changed.notify_all()

    def latest_frame(self) -> Optional[Frame]:
        """The newest frame, or None (none yet, paused, or closed)."""
        paused = self._file_paused()
        with self._lock:
            if paused or self._closed:
                self._erase_frame_locked()
                return None
            return self._frame

    def wait_frame(self, after_seq, timeout) -> Optional[Frame]:
        """A frame whose seq differs from after_seq, waiting up to timeout seconds.

        None on timeout, pause, restart or close.
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._lock:
            wake = self._wake
            while True:
                if self._closed or self._wake != wake:
                    return None
                frame = self._frame
                if frame is not None and frame.seq != after_seq:
                    if self._file_paused():
                        self._erase_frame_locked()
                        return None
                    return frame
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._frame_changed.wait(remaining)

    # --- viewers and capture ----------------------------------------------------------------

    def attach_viewer(self) -> str:
        """Register a page that shows the stream; starts capture unless paused or unconfigured."""
        token = uuid.uuid4().hex
        with self._lock:
            self._viewers[token] = time.monotonic()
        self._ensure_capture()
        return token

    def detach_viewer(self, token) -> None:
        """Forget a viewer; capture continues LEASE_SECONDS after the last one left."""
        with self._lock:
            if self._viewers.pop(token, None) is None:
                return
            if not self._viewers:
                self._lease_until = time.monotonic() + LEASE_SECONDS

    def viewer_count(self) -> int:
        with self._lock:
            return len(self._viewers)

    def _wanted_locked(self) -> bool:
        return bool(self._viewers) or time.monotonic() < self._lease_until

    def _live_locked(self, run) -> bool:
        if self._closed or run.stop.is_set() or self._run is not run:
            return False
        if not self._wanted_locked():
            return False
        return not self._file_paused()

    def _keep_going(self, run) -> bool:
        with self._lock:
            return self._live_locked(run)

    def _ensure_capture(self):
        with self._lock:
            if self._closed or self.opener is None or self._run is not None:
                return
            if not self._wanted_locked() or self._file_paused():
                return
            run = _CaptureRun()
            run.thread = threading.Thread(target=self._capture_loop, args=(run,), name=CAPTURE_THREAD_NAME,
                                          daemon=True)
            self._run = run
            run.thread.start()

    def _halt(self, erase, new_stream=False):
        """Stop the current capture run (it exits on its own) and optionally erase the frame.

        With new_stream the stream id changes and seq restarts, in the same step.
        """
        with self._lock:
            run = self._run
            self._run = None
            if run is not None:
                run.stop.set()
            if erase:
                self._frame = None
            if new_stream:
                self.stream_id = uuid.uuid4().hex
                self._seq = 0
            self._wake += 1
            self._frame_changed.notify_all()
        if run is not None:
            run.interrupt()
        return run

    def _capture_loop(self, run):
        backoff = BACKOFF_START
        while True:
            with self._lock:
                if not self._live_locked(run):
                    if self._run is run:
                        self._run = None
                    if self._file_paused():
                        self._erase_frame_locked()
                    return
            run.produced = False
            self._capture_once(run)
            if run.produced:
                backoff = BACKOFF_START
            self._backoff_wait(run, backoff)
            backoff = min(BACKOFF_MAX, backoff * 2)

    def _capture_once(self, run):
        sock = None
        try:
            sock = self.opener()
            if sock is None:
                return
            with run.lock:
                if run.stop.is_set():
                    return
                run.sock = sock
            read_mjpeg(sock, lambda jpeg, width, height: self._publish(run, jpeg, width, height),
                       lambda: self._keep_going(run), STARTUP_TIMEOUT, IDLE_TIMEOUT)
        except Exception:  # noqa: BLE001 - keep the last frame through any stream gap; back off
            pass
        finally:
            if sock is not None:
                with run.lock:
                    run.sock = None
                _close_quietly(sock)

    def _backoff_wait(self, run, seconds):
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self._keep_going(run):
                return
            run.stop.wait(min(BACKOFF_TICK, remaining))

    def _publish(self, run, jpeg, width, height):
        with self._lock:
            if self._closed or run.stop.is_set() or self._run is not run:
                return
            if self._file_paused():
                self._erase_frame_locked()
                return
            run.produced = True
            current = self._frame
            if current is not None and current.jpeg == jpeg:
                return
            self._seq += 1
            self._frame = Frame(self._seq, bytes(jpeg), int(width), int(height), self._now())
            self._frame_changed.notify_all()

    def restart(self) -> dict:
        """Drop the frame and announce a new stream (new stream_id, seq 0); viewers reconnect."""
        self._halt(erase=True, new_stream=True)
        return self.state()

    def close(self) -> None:
        """Stop capture for good and erase the frame (the process is shutting down)."""
        with self._lock:
            self._closed = True
            self._viewers.clear()
        run = self._halt(erase=True)
        if run is not None and run.thread is not None and run.thread is not threading.current_thread():
            run.thread.join(1.0)

    # --- pause ------------------------------------------------------------------------------

    def paused(self) -> bool:
        return self._file_paused()

    def pause_status(self) -> dict:
        shared = self._read_state()
        return {"paused": shared["paused"], "pause_reason": shared["pause_reason"]}

    def set_paused(self, paused, reason="authentication") -> dict:
        """Pause (hide the picture, stop capture, erase the frame) or resume unconditionally.

        Pausing with device_locked never weakens an existing pause for another reason.
        Every applied pause gets a fresh private pause id.
        """
        if reason not in PAUSE_REASONS:
            raise ValueError("Unknown preview pause reason.")
        with self._transaction() as state:
            if paused:
                downgrade = (reason == "device_locked" and state["paused"]
                             and state["pause_reason"] != "device_locked")
                if not downgrade:
                    state.update(paused=True, pause_reason=reason, pause_id=uuid.uuid4().hex)
                state["actors"] = {}
                state["events"] = []
                state["finished_at"] = 0
            else:
                state.update(paused=False, pause_reason=None, pause_id=None)
        if paused:
            self._halt(erase=True)
        else:
            self._ensure_capture()
        return self.state()

    def locked_pause_id(self) -> Optional[str]:
        """The current pause id, only when the preview is paused because the phone is locked."""
        shared = self._read_state()
        return shared["pause_id"] if shared["pause_reason"] == "device_locked" else None

    def reconnect_pause_id(self) -> Optional[str]:
        """The current pause id; a legacy pause without one gets one now."""
        with self._transaction() as state:
            if state["paused"] and not state["pause_id"]:
                state["pause_id"] = uuid.uuid4().hex
            return state["pause_id"]

    def resume_after_unlock(self, expected_id, explicit=False) -> bool:
        """Resume only the pause that existed when expected_id was read.

        Without `explicit` only a device_locked pause is lifted. A pause created after
        expected_id was read has a new id and survives.
        """
        if not expected_id:
            return False
        resumed = False
        with self._transaction() as state:
            if (state["paused"] and state["pause_id"] == expected_id
                    and (explicit or state["pause_reason"] == "device_locked")):
                state.update(paused=False, pause_reason=None, pause_id=None)
                resumed = True
        if resumed:
            self._ensure_capture()
        return resumed

    # --- activity -------------------------------------------------------------------------

    def begin(self, op) -> Optional[str]:
        """Register a running tool call; returns its actor token (None while paused).

        The operation name is deliberately discarded.
        """
        token = uuid.uuid4().hex
        with self._transaction() as state:
            if state["paused"]:
                return None
            state["actors"][token] = self._now()
            if len(state["actors"]) > MAX_ACTORS:
                state["actors"] = dict(list(state["actors"].items())[-MAX_ACTORS:])
        return token

    def end(self, token) -> None:
        """The tool call behind `token` finished."""
        if not token:
            return
        with self._transaction() as state:
            if state["actors"].pop(token, None) is not None and not state["paused"]:
                now = self._now()
                state["finished_at"] = now
                state["last_activity_at"] = now

    def gesture(self, kind, point=None, from_point=None, to_point=None, duration_ms=None, viewport=None) -> None:
        """Record a tap or drag (iPhone points) for the page to animate; invalid input is ignored."""
        if kind == "tap":
            cleaned = _point(point)
            if cleaned is None:
                return
            payload = {"point": cleaned}
        elif kind == "drag":
            origin, target = _point(from_point), _point(to_point)
            duration = _number(0 if duration_ms is None else duration_ms, MAX_DURATION_MS)
            if origin is None or target is None or duration is None:
                return
            payload = {"from": origin, "to": target, "duration_ms": duration}
        else:
            return
        given_viewport = _viewport(viewport)
        with self._transaction() as state:
            if state["paused"]:
                return
            now = self._now()
            state["last_event_id"] += 1
            event = {"id": state["last_event_id"], "kind": kind, "at": now}
            event.update(payload)
            event_viewport = given_viewport or state["viewport"]
            if event_viewport is not None:
                event["viewport"] = dict(event_viewport)
            state["events"] = (state["events"] + [event])[-MAX_EVENTS:]
            state["last_activity_at"] = now

    def set_viewport(self, viewport) -> None:
        """Remember the iPhone screen size in points (only width and height are read)."""
        cleaned = _viewport(viewport)
        if cleaned is None:
            return
        with self._transaction() as state:
            state["viewport"] = cleaned

    def external_seq(self) -> int:
        """How many user actions (toolbar Home) happened outside the model's tool calls."""
        return self._read_state()["external_seq"]

    def note_external_action(self) -> None:
        with self._transaction() as state:
            state["external_seq"] += 1
