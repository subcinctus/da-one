import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import socket  # noqa: E402
import struct  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402

import screen_hub  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd  # noqa: E402
from fake_wda import MJPEG_CHUNKED_HEADER, MJPEG_HEADER, TINY_JPEG, FakeWDA, chunk_bytes, mjpeg_part  # noqa: E402
from screen_hub import (MJPEG_REQUEST, Dechunker, MJPEGError, MJPEGParser, open_mjpeg_socket,  # noqa: E402
                        read_mjpeg)
from usbmux import UsbmuxError  # noqa: E402
from wda_client import WDA_URL_ENV  # noqa: E402

UDID = "00008110-0000000000000001"


def synthetic_jpeg(width=440, height=956, payload=b"pixels"):
    """A parser-only JPEG: SOI, APP0, SOF0 with the given size, SOS, payload, EOI."""
    frame_header = bytes([8]) + struct.pack(">HH", height, width) + b"\x01\x01\x11\x00"
    return (b"\xff\xd8\xff\xe0\x00\x04AB\xff\xc0\x00\x0b" + frame_header + b"\xff\xda\x00\x02"
            + payload + b"\xff\xd9")


def exif_thumbnail_jpeg():
    """TINY_JPEG carrying a complete JPEG thumbnail (its own FF D8 ... FF D9) in an APP1 segment."""
    app1_payload = b"Exif\x00\x00" + TINY_JPEG
    app1 = b"\xff\xe1" + struct.pack(">H", len(app1_payload) + 2) + app1_payload
    return b"\xff\xd8" + app1 + TINY_JPEG[2:]


def collect(sock, count, **kwargs):
    """read_mjpeg until `count` frames arrived (or the stream ended)."""
    frames = []
    read_mjpeg(sock, lambda jpeg, width, height: frames.append((jpeg, width, height)),
               lambda: len(frames) < count, **kwargs)
    return frames


class Peer:
    """The far end of a socketpair: records the request, then sends scripted bytes."""

    def __init__(self, replies=(), close=False):
        self.ours, self.theirs = socket.socketpair()
        self.replies = list(replies)
        self.close_after = close
        self.request = b""
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            self.theirs.settimeout(5)
            while len(self.request) < len(MJPEG_REQUEST):
                data = self.theirs.recv(4096)
                if not data:
                    return
                self.request += data
            for reply in self.replies:
                self.theirs.sendall(reply)
            if self.close_after:
                self.theirs.shutdown(socket.SHUT_WR)
            while self.theirs.recv(4096):
                pass
        except OSError:
            pass

    def close(self):
        for sock in (self.ours, self.theirs):
            try:
                sock.close()
            except OSError:
                pass
        self.thread.join(2)


class ParserTests(unittest.TestCase):
    def test_content_length_framing_of_the_exact_wda_format(self):
        parser = MJPEGParser()
        frames = parser.feed(mjpeg_part(TINY_JPEG) * 3)
        self.assertEqual(frames, [(TINY_JPEG, (39, 84))] * 3)
        self.assertEqual(parser.buffered, 0)

    def test_response_header_followed_by_parts(self):
        parser = MJPEGParser()
        first, second = synthetic_jpeg(1179, 2556, b"one"), synthetic_jpeg(1179, 2556, b"two")
        frames = parser.feed(MJPEG_HEADER + mjpeg_part(first) + mjpeg_part(second))
        self.assertEqual(frames, [(first, (1179, 2556)), (second, (1179, 2556))])

    def test_exif_thumbnail_is_emitted_whole_by_content_length(self):
        jpeg = exif_thumbnail_jpeg()
        self.assertEqual(jpeg.count(b"\xff\xd9"), 2)
        self.assertEqual(MJPEGParser().feed(mjpeg_part(jpeg)), [(jpeg, (39, 84))])
        # Without Content-Length the SOI/EOI fallback would cut at the thumbnail's EOI: that
        # truncated frame is invalid and is dropped rather than shown.
        self.assertEqual(MJPEGParser().feed(jpeg), [])

    def test_soi_eoi_fallback_without_part_headers(self):
        first, second = synthetic_jpeg(), synthetic_jpeg(1170, 2532, b"second")
        parser = MJPEGParser()
        self.assertEqual(parser.feed(b"junk" + first + b"\r\n" + second),
                         [(first, (440, 956)), (second, (1170, 2532))])
        multipart = (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + first + b"\r\n--frame\r\n\r\n" + second
                     + b"\r\n")
        self.assertEqual(MJPEGParser().feed(multipart), [(first, (440, 956)), (second, (1170, 2532))])

    def test_byte_at_a_time_feeding_keeps_content_length_framing(self):
        exif = exif_thumbnail_jpeg()
        stream = MJPEG_HEADER + mjpeg_part(TINY_JPEG) + mjpeg_part(exif) + mjpeg_part(TINY_JPEG)
        parser, frames = MJPEGParser(), []
        for byte in stream:
            frames.extend(parser.feed(bytes([byte])))
        self.assertEqual(frames, [(TINY_JPEG, (39, 84)), (exif, (39, 84)), (TINY_JPEG, (39, 84))])
        self.assertLessEqual(parser.buffered, 3)

    def test_split_at_every_position(self):
        exif = exif_thumbnail_jpeg()
        stream = mjpeg_part(exif) + mjpeg_part(TINY_JPEG)
        expected = [(exif, (39, 84)), (TINY_JPEG, (39, 84))]
        for cut in range(len(stream) + 1):
            parser = MJPEGParser()
            frames = parser.feed(stream[:cut]) + parser.feed(stream[cut:])
            self.assertEqual(frames, expected, "split at %d" % cut)
            self.assertEqual(parser.buffered, 0)

    def test_header_names_are_case_insensitive(self):
        for name in (b"CONTENT-LENGTH", b"content-length", b"Content-Length"):
            part = (b"--BoundaryString\r\nContent-type: image/jpeg\r\n" + name + b":%d\r\n\r\n" % len(TINY_JPEG)
                    + TINY_JPEG + b"\r\n\r\n")
            self.assertEqual(MJPEGParser().feed(part), [(TINY_JPEG, (39, 84))])

    def test_buffered_stays_tiny_between_parts(self):
        parser = MJPEGParser()
        parser.feed(mjpeg_part(TINY_JPEG))
        self.assertEqual(parser.buffered, 0)
        parser.feed(b"\r\n\r")
        self.assertLessEqual(parser.buffered, 3)
        self.assertEqual(parser.feed(b"\n" + mjpeg_part(TINY_JPEG)), [(TINY_JPEG, (39, 84))])

    def test_garbage_is_trimmed_and_parsing_recovers(self):
        parser = MJPEGParser()
        garbage = bytes((index * 7 + 3) % 200 + 20 for index in range(200_000))   # no FF, no CR/LF pairs
        self.assertNotIn(b"\xff\xd8", garbage)
        self.assertEqual(parser.feed(garbage), [])
        self.assertLessEqual(parser.buffered, 3)
        self.assertEqual(parser.feed(mjpeg_part(TINY_JPEG)), [(TINY_JPEG, (39, 84))])

    def test_a_partial_part_header_is_kept_but_bounded(self):
        parser = MJPEGParser()
        parser.feed(b"junk junk --BoundaryString\r\nContent-type: image/jpeg\r\nContent-Le")
        self.assertEqual(parser.buffered, len(b"--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Le"))
        self.assertEqual(parser.feed(b"ngth: %d\r\n\r\n" % len(TINY_JPEG) + TINY_JPEG + b"\r\n\r\n"),
                         [(TINY_JPEG, (39, 84))])
        parser.feed(b"--" + b"x" * 20000)
        self.assertLessEqual(parser.buffered, 3)

    def test_unterminated_oversize_frame_resets_and_recovers(self):
        parser = MJPEGParser(max_bytes=1024)
        self.assertEqual(parser.feed(b"\xff\xd8" + b"A" * 200_000), [])
        self.assertLessEqual(parser.buffered, 1024 + 64 * 1024)
        raw = synthetic_jpeg()
        self.assertEqual(parser.feed(b"\xff\xd9--boundary\xff\xd8broken\xff\xd9" + raw), [(raw, (440, 956))])
        self.assertLessEqual(parser.buffered, 3)

    def test_oversized_content_length_part_is_skipped_without_buffering(self):
        parser = MJPEGParser(max_bytes=1024)
        big_body = synthetic_jpeg(payload=b"B" * 5000)
        stream = mjpeg_part(big_body) + mjpeg_part(TINY_JPEG)
        frames = []
        largest = 0
        for start in range(0, len(stream), 100):
            frames.extend(parser.feed(stream[start:start + 100]))
            largest = max(largest, parser.buffered)
        self.assertEqual(frames, [(TINY_JPEG, (39, 84))])
        self.assertLess(largest, len(TINY_JPEG) + 200)    # never the 5 KB body, only the small frame
        self.assertEqual(parser.buffered, 0)

    def test_invalid_parts_are_skipped(self):
        bad_sof = synthetic_jpeg(width=0)
        stream = (mjpeg_part(b"not a jpeg at all") + mjpeg_part(bad_sof) + mjpeg_part(TINY_JPEG[:100])
                  + mjpeg_part(TINY_JPEG))
        self.assertEqual(MJPEGParser().feed(stream), [(TINY_JPEG, (39, 84))])

    def test_many_frames_in_one_large_feed(self):
        frames = MJPEGParser().feed(mjpeg_part(TINY_JPEG) * 500)
        self.assertEqual(len(frames), 500)


class DechunkerTests(unittest.TestCase):
    def test_round_trip(self):
        data = mjpeg_part(TINY_JPEG) * 2
        dechunker = Dechunker()
        self.assertEqual(dechunker.feed(chunk_bytes(data) + b"0\r\n\r\n"), data)
        self.assertTrue(dechunker.finished)

    def test_byte_at_a_time(self):
        data = b"hello, chunked world" * 10
        dechunker = Dechunker()
        out = b"".join(dechunker.feed(bytes([byte])) for byte in chunk_bytes(data, 13) + b"0\r\n\r\n")
        self.assertEqual(out, data)
        self.assertTrue(dechunker.finished)

    def test_extensions_uppercase_hex_and_trailer(self):
        dechunker = Dechunker()
        out = dechunker.feed(b"5;name=value\r\nhello\r\nA\r\n0123456789\r\n0\r\nX-Trailer: 1\r\n\r\nIGNORED")
        self.assertEqual(out, b"hello0123456789")
        self.assertTrue(dechunker.finished)
        self.assertEqual(dechunker.feed(b"3\r\nabc\r\n"), b"")

    def test_unfinished_stream_is_not_finished(self):
        dechunker = Dechunker()
        self.assertEqual(dechunker.feed(b"3\r\nabc\r\n"), b"abc")
        self.assertFalse(dechunker.finished)

    def test_bad_framing_raises(self):
        for data in (b"zz\r\n", b"\r\n", b"-1\r\n", b"3\r\nabcXY", b"1" * 5000, b"3 garbage\r\n"):
            with self.assertRaises(MJPEGError, msg=repr(data[:20])):
                Dechunker().feed(data)


class ReadMjpegFakeWdaTests(unittest.TestCase):
    def start_fake(self, mode="normal", fps=50):
        fake = FakeWDA(mjpeg=True, mjpeg_fps=fps, mjpeg_mode=mode).start()
        self.addCleanup(fake.stop)
        sock = socket.create_connection(("127.0.0.1", fake.mjpeg_port), timeout=5)
        self.addCleanup(sock.close)
        return fake, sock

    def test_normal_stream_and_exact_request(self):
        fake, sock = self.start_fake()
        self.assertEqual(collect(sock, 3), [(TINY_JPEG, 39, 84)] * 3)
        self.assertEqual(fake.mjpeg_requests[0], MJPEG_REQUEST)

    def test_chunked_stream(self):
        _, sock = self.start_fake("chunked")
        self.assertEqual(collect(sock, 3), [(TINY_JPEG, 39, 84)] * 3)

    def test_split_stream(self):
        _, sock = self.start_fake("split")
        self.assertEqual(collect(sock, 2), [(TINY_JPEG, 39, 84)] * 2)

    def test_garbage_before_the_first_part(self):
        _, sock = self.start_fake("garbage")
        self.assertEqual(collect(sock, 2), [(TINY_JPEG, 39, 84)] * 2)

    def test_close_after_returns_on_eof(self):
        _, sock = self.start_fake("close_after:2")
        self.assertEqual(collect(sock, 100), [(TINY_JPEG, 39, 84)] * 2)

    def test_silent_server_is_a_startup_timeout(self):
        _, sock = self.start_fake("silent")
        started = time.monotonic()
        with self.assertRaises(MJPEGError) as caught:
            collect(sock, 1, startup_timeout=0.3)
        self.assertIn("startup", str(caught.exception))
        self.assertLess(time.monotonic() - started, 2.0)

    def test_stalled_stream_is_an_idle_timeout(self):
        _, sock = self.start_fake("stall_after:1")
        frames = []
        started = time.monotonic()
        with self.assertRaises(MJPEGError) as caught:
            read_mjpeg(sock, lambda jpeg, width, height: frames.append(jpeg), lambda: True, idle_timeout=0.3)
        self.assertEqual(str(caught.exception), "idle")
        self.assertEqual(frames, [TINY_JPEG])
        self.assertLess(time.monotonic() - started, 2.0)

    def test_distinct_frames_arrive_in_order(self):
        fake, sock = self.start_fake()
        first, second = synthetic_jpeg(payload=b"one"), synthetic_jpeg(payload=b"two")
        fake.mjpeg_frames = [first, second]
        frames = [jpeg for jpeg, _, _ in collect(sock, 6)]
        self.assertEqual(set(frames), {first, second})


class ReadMjpegScriptedTests(unittest.TestCase):
    def peer(self, replies=(), close=False):
        peer = Peer(replies, close)
        self.addCleanup(peer.close)
        return peer

    def test_non_200_status_is_an_error(self):
        for status in (b"HTTP/1.0 404 Not Found", b"HTTP/1.1 500 Internal Server Error", b"HTTP/2 200",
                       b"ICY 200 OK", b"HTTP/1.0 2000 OK"):
            peer = self.peer([status + b"\r\nContent-Type: text/plain\r\n\r\n"])
            with self.assertRaises(MJPEGError, msg=status):
                collect(peer.ours, 1)

    def test_http11_200_without_chunking(self):
        peer = self.peer([b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace\r\n\r\n"
                          + mjpeg_part(TINY_JPEG)], close=True)
        self.assertEqual(collect(peer.ours, 5), [(TINY_JPEG, 39, 84)])

    def test_chunked_body_ends_at_the_final_chunk(self):
        body = chunk_bytes(mjpeg_part(TINY_JPEG) * 2) + b"0\r\n\r\n"
        peer = self.peer([MJPEG_CHUNKED_HEADER + body])
        self.assertEqual(collect(peer.ours, 5), [(TINY_JPEG, 39, 84)] * 2)

    def test_close_before_the_answer_is_an_error(self):
        peer = self.peer([], close=True)
        with self.assertRaises(MJPEGError):
            collect(peer.ours, 1)

    def test_oversized_response_header_is_an_error(self):
        peer = self.peer([b"HTTP/1.0 200 OK\r\n" + b"X-Filler: " + b"a" * 20000])
        with self.assertRaises(MJPEGError):
            collect(peer.ours, 1)

    def test_stop_while_waiting_for_the_answer_returns_quietly(self):
        peer = self.peer([])
        stop_at = time.monotonic() + 0.3
        read_mjpeg(peer.ours, lambda *args: None, lambda: time.monotonic() < stop_at, startup_timeout=5)
        self.assertLess(time.monotonic() - stop_at, 1.0)
        self.assertEqual(peer.request, MJPEG_REQUEST)

    def test_nothing_is_sent_when_already_stopped(self):
        peer = self.peer([MJPEG_HEADER + mjpeg_part(TINY_JPEG)])
        frames = []
        read_mjpeg(peer.ours, lambda *args: frames.append(args), lambda: False)
        time.sleep(0.05)
        self.assertEqual((peer.request, frames), (b"", []))

    def test_frames_sent_with_the_header_are_not_lost(self):
        peer = self.peer([MJPEG_HEADER + mjpeg_part(TINY_JPEG) + mjpeg_part(TINY_JPEG)], close=True)
        self.assertEqual(collect(peer.ours, 5), [(TINY_JPEG, 39, 84)] * 2)

    def test_stop_between_frames(self):
        peer = self.peer([MJPEG_HEADER + mjpeg_part(TINY_JPEG) * 5])
        self.assertEqual(len(collect(peer.ours, 2)), 2)


class _TunnelTarget:
    """A TCP server behind FakeUsbmuxd: after the MJPEG request it sends the rest of the stream."""

    def __init__(self, rest):
        self.rest = rest
        self.request = b""
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(5)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            connection, _ = self.listener.accept()
        except OSError:
            return
        with connection:
            try:
                connection.settimeout(5)
                while len(self.request) < len(MJPEG_REQUEST):
                    data = connection.recv(4096)
                    if not data:
                        return
                    self.request += data
                connection.sendall(self.rest)
                while connection.recv(4096):
                    pass
            except OSError:
                pass

    def close(self):
        self.listener.close()
        self.thread.join(2)


class OpenMjpegSocketTests(unittest.TestCase):
    def test_unconfigured_returns_none(self):
        self.assertIsNone(open_mjpeg_socket({}, env={}))
        self.assertIsNone(open_mjpeg_socket({"udid": "bad udid!"}, env={"USBMUXD_SOCKET_ADDRESS": "/nonexistent"}))
        self.assertIsNone(open_mjpeg_socket(None, env={}))

    def test_bad_configured_url_raises_value_error(self):
        with self.assertRaises(ValueError):
            open_mjpeg_socket({"wda_url": "http://192.168.1.20:8100"}, env={})

    def test_loopback_url_uses_the_configured_mjpeg_port(self):
        fake = FakeWDA(mjpeg=True, mjpeg_fps=50).start()
        self.addCleanup(fake.stop)
        sock = open_mjpeg_socket({"mjpeg_port": fake.mjpeg_port}, env={WDA_URL_ENV: fake.url})
        self.addCleanup(sock.close)
        self.assertEqual(collect(sock, 2), [(TINY_JPEG, 39, 84)] * 2)

    def test_usbmux_tunnel_to_default_port_9100(self):
        fake = FakeWDA(mjpeg=True, mjpeg_fps=50).start()
        self.addCleanup(fake.stop)
        with FakeUsbmuxd() as usbmuxd:
            usbmuxd.add_device(UDID, ports={9100: ("127.0.0.1", fake.mjpeg_port)})
            sock = open_mjpeg_socket({"udid": UDID}, env=usbmuxd.env())
            try:
                self.assertEqual(collect(sock, 2), [(TINY_JPEG, 39, 84)] * 2)
            finally:
                sock.close()
            self.assertEqual(usbmuxd.connects, [(UDID, 9100, 0)])

    def test_usbmux_tunnel_to_a_configured_port_and_refusal(self):
        with FakeUsbmuxd() as usbmuxd:
            usbmuxd.add_device(UDID, ports={9200: None})
            with self.assertRaises(UsbmuxError) as caught:
                open_mjpeg_socket({"udid": UDID, "mjpeg_port": 9200}, env=usbmuxd.env())
            self.assertEqual(caught.exception.reason, "connection_refused")
            self.assertEqual(usbmuxd.connects, [(UDID, 9200, 3)])

    def test_bytes_arriving_with_the_usbmux_reply_are_not_lost(self):
        first = synthetic_jpeg(payload=b"first")
        second = synthetic_jpeg(payload=b"second")
        third = synthetic_jpeg(payload=b"third")
        stream = MJPEG_HEADER + mjpeg_part(first) + mjpeg_part(second) + mjpeg_part(third)
        cut = len(MJPEG_HEADER) + len(mjpeg_part(first)) + len(mjpeg_part(second)) // 2
        target = _TunnelTarget(stream[cut:])
        self.addCleanup(target.close)
        with FakeUsbmuxd(tunnel_preamble=stream[:cut]) as usbmuxd:
            usbmuxd.add_device(UDID, ports={9100: ("127.0.0.1", target.port)})
            sock = open_mjpeg_socket({"udid": UDID}, env=usbmuxd.env())
            try:
                frames = [jpeg for jpeg, _, _ in collect(sock, 3)]
            finally:
                sock.close()
        self.assertEqual(frames, [first, second, third])
        self.assertEqual(target.request, MJPEG_REQUEST)


class ConstantsTests(unittest.TestCase):
    def test_timeouts_and_request(self):
        self.assertEqual(screen_hub.STARTUP_TIMEOUT, 5.0)
        self.assertEqual(screen_hub.IDLE_TIMEOUT, 15.0)
        self.assertEqual(screen_hub.MAX_FRAME_BYTES, 4 * 1024 * 1024)
        self.assertEqual(MJPEG_REQUEST, b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: multipart/x-mixed-replace\r\n"
                                        b"Connection: close\r\n\r\n")


if __name__ == "__main__":
    unittest.main()
