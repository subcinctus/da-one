import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import plistlib  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import struct  # noqa: E402
import threading  # noqa: E402
import unittest  # noqa: E402

import usbmux  # noqa: E402
from fake_usbmuxd import FakeUsbmuxd, short_tmpdir  # noqa: E402
from usbmux import UsbmuxError  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F7A"
OTHER_UDID = "00008030-000A1B2C3D4E5F60"


class EchoServer:
    """Loopback TCP server that echoes every byte back (stands in for a device port)."""

    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.listener.settimeout(0.1)
        self.port = self.listener.getsockname()[1]
        self.stopping = threading.Event()
        self.connections = []
        self.threads = []
        self.accepted = 0
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    @property
    def target(self):
        return ("127.0.0.1", self.port)

    def _loop(self):
        while not self.stopping.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.accepted += 1
            self.connections.append(conn)
            worker = threading.Thread(target=self._echo, args=(conn,), daemon=True)
            self.threads.append(worker)
            worker.start()

    def _echo(self, conn):
        conn.settimeout(0.1)
        while not self.stopping.is_set():
            try:
                data = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            if not data:
                return
            try:
                conn.sendall(data)
            except OSError:
                return

    def close(self):
        self.stopping.set()
        try:
            self.listener.shutdown(socket.SHUT_RDWR)  # wakes a blocked accept() on Linux
        except OSError:
            pass
        self.listener.close()
        for conn in self.connections:
            try:
                conn.close()
            except OSError:
                pass
        self.thread.join(2)
        for worker in self.threads:
            worker.join(2)


class ScriptedDaemon:
    """A unix-socket 'usbmuxd' whose per-connection behaviour is a test function."""

    def __init__(self, handler):
        self.handler = handler
        self.tmpdir = short_tmpdir()
        self.path = os.path.join(self.tmpdir, "mux.sock")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(4)
        self.listener.settimeout(0.1)
        self.stopping = threading.Event()
        self.connections = []
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def env(self):
        return {"USBMUXD_SOCKET_ADDRESS": "unix:" + self.path}

    def _loop(self):
        while not self.stopping.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections.append(conn)
            conn.settimeout(2.0)
            try:
                self.handler(conn)
            except OSError:
                pass

    def close(self):
        self.stopping.set()
        try:
            self.listener.shutdown(socket.SHUT_RDWR)  # wakes a blocked accept() on Linux
        except OSError:
            pass
        self.listener.close()
        for conn in self.connections:
            try:
                conn.close()
            except OSError:
                pass
        self.thread.join(2)
        shutil.rmtree(self.tmpdir, ignore_errors=True)


def read_request(conn):
    header = usbmux.recv_exact(conn, 16)
    length, _, _, tag = struct.unpack("<IIII", header)
    return tag, plistlib.loads(usbmux.recv_exact(conn, length - 16))


def raw_frame(payload_bytes, tag=1, version=1, message_type=8, length=None):
    total = 16 + len(payload_bytes) if length is None else length
    return struct.pack("<IIII", total, version, message_type, tag) + payload_bytes


def refused_port(test):
    """A loopback port with nothing listening: briefly listened on, then closed, so connects are refused.

    (A bound-but-never-listening socket is refused on Linux but silently times out on macOS.)
    """
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("127.0.0.1", 0))
    holder.listen(1)
    port = holder.getsockname()[1]
    holder.close()
    return port


def plist_bytes(obj):
    return plistlib.dumps(obj, fmt=plistlib.FMT_XML)


class SwapAndAddressTests(unittest.TestCase):
    def test_swap16(self):
        self.assertEqual(usbmux.swap16(8100), 42015)
        self.assertEqual(usbmux.swap16(9100), 35875)
        self.assertEqual(usbmux.swap16(usbmux.swap16(12345)), 12345)

    def test_socket_address_variants(self):
        self.assertEqual(usbmux.socket_address({}), ("unix", "/var/run/usbmuxd"))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": ""}), ("unix", "/var/run/usbmuxd"))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "unix:/tmp/a.sock"}),
                         ("unix", "/tmp/a.sock"))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "UNIX:/tmp/b.sock"}),
                         ("unix", "/tmp/b.sock"))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "/tmp/c.sock"}), ("unix", "/tmp/c.sock"))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "127.0.0.1:27015"}),
                         ("tcp", ("127.0.0.1", 27015)))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "localhost:27015"}),
                         ("tcp", ("localhost", 27015)))
        self.assertEqual(usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": "[::1]:27015"}), ("tcp", ("::1", 27015)))

    def test_socket_address_rejects_non_loopback_and_garbage(self):
        for value in ("192.168.1.5:27015", "example.com:27015", "0.0.0.0:27015", "127.0.0.1", "127.0.0.1:",
                      "127.0.0.1:0", "127.0.0.1:70000", "127.0.0.1:abc", "unix:", "relative/path"):
            with self.subTest(value=value):
                with self.assertRaises(UsbmuxError) as caught:
                    usbmux.socket_address({"USBMUXD_SOCKET_ADDRESS": value})
                self.assertEqual(caught.exception.reason, "usbmuxd_unavailable")

    def test_socket_address_reads_process_environment_by_default(self):
        previous = os.environ.get("USBMUXD_SOCKET_ADDRESS")
        os.environ["USBMUXD_SOCKET_ADDRESS"] = "unix:/tmp/from-env.sock"
        try:
            self.assertEqual(usbmux.socket_address(), ("unix", "/tmp/from-env.sock"))
        finally:
            if previous is None:
                del os.environ["USBMUXD_SOCKET_ADDRESS"]
            else:
                os.environ["USBMUXD_SOCKET_ADDRESS"] = previous

    def test_usbmux_error_is_an_oserror_with_reason(self):
        error = UsbmuxError("timeout", "usbmuxd did not answer in time.")
        self.assertIsInstance(error, OSError)
        self.assertEqual(error.reason, "timeout")
        self.assertEqual(error.message, "usbmuxd did not answer in time.")
        self.assertEqual(str(error), "usbmuxd did not answer in time.")


class FramingTests(unittest.TestCase):
    def setUp(self):
        self.left, self.right = socket.socketpair()
        self.left.settimeout(1.0)
        self.right.settimeout(1.0)
        self.addCleanup(self.left.close)
        self.addCleanup(self.right.close)

    def test_encode_header_fields_and_round_trip(self):
        payload = {"MessageType": "ListDevices", "ProgName": "iphone-use", "kLibUSBMuxVersion": 3}
        data = usbmux.encode_message(payload, 7)
        length, version, message_type, tag = struct.unpack("<IIII", data[:16])
        self.assertEqual((length, version, message_type, tag), (len(data), 1, 8, 7))
        self.assertTrue(data[16:].startswith(b"<?xml"))
        self.assertEqual(plistlib.loads(data[16:]), payload)
        self.left.sendall(data)
        self.assertEqual(usbmux.read_message(self.right), (7, payload))

    def test_read_message_never_reads_past_the_reply(self):
        self.left.sendall(usbmux.encode_message({"Number": 0}, 2) + b"TUNNEL")
        self.assertEqual(usbmux.read_message(self.right), (2, {"Number": 0}))
        self.assertEqual(self.right.recv(64), b"TUNNEL")

    def assert_protocol_error(self, data):
        self.left.sendall(data)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.read_message(self.right)
        self.assertEqual(caught.exception.reason, "protocol_error")

    def test_bad_version(self):
        self.assert_protocol_error(raw_frame(plist_bytes({"a": 1}), version=2))

    def test_bad_type(self):
        self.assert_protocol_error(raw_frame(plist_bytes({"a": 1}), message_type=1))

    def test_length_too_small(self):
        self.assert_protocol_error(raw_frame(b"", length=8))

    def test_length_too_large(self):
        self.assert_protocol_error(raw_frame(b"", length=(1 << 20) + 1))

    def test_non_dict_payload(self):
        self.assert_protocol_error(raw_frame(plist_bytes(["not", "a", "dict"])))

    def test_garbage_payload(self):
        self.assert_protocol_error(raw_frame(b"this is not a plist"))

    def test_eof_mid_message(self):
        self.left.sendall(raw_frame(plist_bytes({"a": 1}))[:20])
        self.left.close()
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.read_message(self.right)
        self.assertEqual(caught.exception.reason, "protocol_error")

    def test_recv_exact_reads_exact_count(self):
        self.left.sendall(b"abcdef")
        self.assertEqual(usbmux.recv_exact(self.right, 4), b"abcd")
        self.assertEqual(usbmux.recv_exact(self.right, 2), b"ef")

    def test_encode_rejects_oversized_message(self):
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.encode_message({"blob": "x" * (1 << 20)}, 1)
        self.assertEqual(caught.exception.reason, "protocol_error")


class FindDeviceTests(unittest.TestCase):
    def test_exact_match_wins_over_normalized(self):
        devices = [
            {"device_id": 1, "udid": UDID.replace("-", "").lower(), "connection_type": "USB", "product_id": 1},
            {"device_id": 2, "udid": UDID, "connection_type": "USB", "product_id": 1},
        ]
        self.assertEqual(usbmux.find_device(UDID, devices)["device_id"], 2)

    def test_wifi_entries_never_match(self):
        # Finder's "Show this iPhone when on Wi-Fi": an exact Network entry must not hide a normalized USB one,
        # and a Network-only listing is "not connected over USB".
        usb = {"device_id": 1, "udid": UDID.replace("-", "").lower(), "connection_type": "USB", "product_id": 1}
        wifi = {"device_id": 2, "udid": UDID, "connection_type": "Network", "product_id": 1}
        self.assertEqual(usbmux.find_device(UDID, [wifi, usb])["device_id"], 1)
        self.assertIsNone(usbmux.find_device(UDID, [wifi]))
        self.assertIsNone(usbmux.find_device(UDID, [dict(wifi, connection_type="")]))

    def test_usb_preferred_among_exact_matches(self):
        devices = [
            {"device_id": 1, "udid": UDID, "connection_type": "Network", "product_id": 1},
            {"device_id": 2, "udid": UDID, "connection_type": "USB", "product_id": 1},
        ]
        self.assertEqual(usbmux.find_device(UDID, devices)["device_id"], 2)

    def test_normalized_match_prefers_usb(self):
        devices = [
            {"device_id": 1, "udid": "00008110001a2b3c4d5e6f7a", "connection_type": "Network", "product_id": 1},
            {"device_id": 2, "udid": "00008110001A2B3C4D5E6F7A", "connection_type": "USB", "product_id": 1},
        ]
        self.assertEqual(usbmux.find_device(UDID, devices)["device_id"], 2)

    def test_no_match(self):
        devices = [{"device_id": 1, "udid": OTHER_UDID, "connection_type": "USB", "product_id": 1}]
        self.assertIsNone(usbmux.find_device(UDID, devices))
        self.assertIsNone(usbmux.find_device(UDID, []))


class FakeDaemonTests(unittest.TestCase):
    def start_fake(self, **kwargs):
        fake = FakeUsbmuxd(**kwargs).start()
        self.addCleanup(fake.stop)
        return fake

    def start_echo(self):
        echo = EchoServer()
        self.addCleanup(echo.close)
        return echo

    def test_list_devices_fields_and_order(self):
        fake = self.start_fake()
        fake.add_device(UDID, device_id=7, product_id=4776)
        fake.add_device(OTHER_UDID, connection_type="Network", device_id=9, product_id=4779)
        fake.add_device(UDID, connection_type="Network", device_id=11)
        devices = usbmux.list_devices(timeout=2.0, env=fake.env())
        self.assertEqual(devices, [
            {"device_id": 7, "udid": UDID, "connection_type": "USB", "product_id": 4776},
            {"device_id": 9, "udid": OTHER_UDID, "connection_type": "Network", "product_id": 4779},
            {"device_id": 11, "udid": UDID, "connection_type": "Network", "product_id": 4776},
        ])
        request = fake.received()[0]
        self.assertEqual(request["MessageType"], "ListDevices")
        self.assertEqual(request["ProgName"], "iphone-use")
        self.assertEqual(request["ClientVersionString"], "iphone-use-0.1.0")
        self.assertEqual(request["kLibUSBMuxVersion"], 3)

    def test_list_devices_empty(self):
        fake = self.start_fake()
        self.assertEqual(usbmux.list_devices(timeout=2.0, env=fake.env()), [])

    def test_connect_tunnels_bytes_both_ways(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: echo.target})
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.addCleanup(sock.close)
        sock.sendall(b"hello over usb")
        received = b""
        while len(received) < 14:
            received += sock.recv(64)
        self.assertEqual(received, b"hello over usb")
        self.assertEqual(fake.connects, [(UDID, 8100, 0)])
        self.assertEqual(fake.active_tunnels(), 1)

    def test_tunnel_preamble_is_not_consumed(self):
        echo = self.start_echo()
        fake = self.start_fake(tunnel_preamble=b"HTTP/1.0 200 OK\r\n")
        fake.add_device(UDID, ports={9100: echo.target})
        sock = usbmux.connect(UDID, 9100, timeout=2.0, env=fake.env())
        self.addCleanup(sock.close)
        received = b""
        while len(received) < 17:
            received += sock.recv(64)
        self.assertEqual(received, b"HTTP/1.0 200 OK\r\n")

    def test_list_devices_then_connect_on_one_connection_with_swapped_port(self):
        echo = self.start_echo()
        fake = self.start_fake()
        device_id = fake.add_device(UDID, ports={8100: echo.target})
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        sock.close()
        requests = fake.received()
        self.assertEqual([r["MessageType"] for r in requests], ["ListDevices", "Connect"])
        connect = requests[1]
        self.assertEqual(connect["DeviceID"], device_id)
        self.assertEqual(connect["PortNumber"], 42015)
        self.assertEqual(connect["ProgName"], "iphone-use")
        self.assertEqual(connect["ClientVersionString"], "iphone-use-0.1.0")
        self.assertEqual(connect["kLibUSBMuxVersion"], 3)

    def test_connect_prefers_usb_entry(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: None}, connection_type="Network", device_id=3)
        fake.add_device(UDID, ports={8100: echo.target}, connection_type="USB", device_id=4)
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        sock.close()
        self.assertEqual(fake.received()[1]["DeviceID"], 4)

    def test_connect_over_wifi_only_is_device_not_found(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: echo.target}, connection_type="Network", device_id=3)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "device_not_found")
        self.assertEqual(fake.connects, [])

    def test_connect_matches_normalized_serial(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID.replace("-", ""), ports={8100: echo.target})
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        sock.close()
        self.assertEqual(fake.connects[0][2], 0)

    def test_refused_port(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: echo.target})
        fake.map_port(UDID, 8100, None)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "connection_refused")
        self.assertIn("8100", caught.exception.message)
        self.assertEqual(fake.connects, [(UDID, 8100, 3)])

    def test_unmapped_port_is_refused(self):
        fake = self.start_fake()
        fake.add_device(UDID, ports={})
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 9100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "connection_refused")

    def test_target_not_listening_is_refused(self):
        port = refused_port(self)
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: ("127.0.0.1", port)})
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "connection_refused")

    def test_unknown_device(self):
        fake = self.start_fake()
        fake.add_device(OTHER_UDID, ports={8100: ("127.0.0.1", 9)})
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "device_not_found")
        self.assertEqual([r["MessageType"] for r in fake.received()], ["ListDevices"])

    def test_forced_results(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: echo.target})
        for number, reason in ((2, "bad_device"), (1, "bad_command"), (5, "protocol_error")):
            with self.subTest(number=number):
                fake.force_result(number)
                with self.assertRaises(UsbmuxError) as caught:
                    usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
                self.assertEqual(caught.exception.reason, reason)
        # The forced results were used up; the next Connect works again.
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        sock.close()

    def test_device_removed_between_list_and_connect_gives_bad_device(self):
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: ("127.0.0.1", 9)})
        fake.force_result(2, times=1)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "bad_device")

    def test_missing_socket_path(self):
        tmpdir = short_tmpdir()
        self.addCleanup(shutil.rmtree, tmpdir, True)
        env = {"USBMUXD_SOCKET_ADDRESS": "unix:" + os.path.join(tmpdir, "absent.sock")}
        for call in (lambda: usbmux.connect(UDID, 8100, timeout=0.5, env=env),
                     lambda: usbmux.list_devices(timeout=0.5, env=env)):
            with self.assertRaises(UsbmuxError) as caught:
                call()
            self.assertEqual(caught.exception.reason, "usbmuxd_unavailable")

    def test_invalid_address_is_unavailable(self):
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=0.5, env={"USBMUXD_SOCKET_ADDRESS": "10.0.0.1:27015"})
        self.assertEqual(caught.exception.reason, "usbmuxd_unavailable")

    def test_silent_daemon_times_out(self):
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: ("127.0.0.1", 9)})
        fake.silent = True
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=0.2, env=fake.env())
        self.assertEqual(caught.exception.reason, "timeout")
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.list_devices(timeout=0.2, env=fake.env())
        self.assertEqual(caught.exception.reason, "timeout")

    def test_daemon_that_never_accepts_times_out(self):
        tmpdir = short_tmpdir()
        self.addCleanup(shutil.rmtree, tmpdir, True)
        path = os.path.join(tmpdir, "mute.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(path)
        listener.listen(4)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=0.2, env={"USBMUXD_SOCKET_ADDRESS": path})
        self.assertEqual(caught.exception.reason, "timeout")

    def test_invalid_udid_or_port_sends_nothing(self):
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: ("127.0.0.1", 9)})
        for udid, port in (("short", 8100), ("bad udid with spaces", 8100), (None, 8100), (UDID, 0),
                           (UDID, 65536), (UDID, True), (UDID, "8100")):
            with self.subTest(udid=udid, port=port):
                with self.assertRaises(ValueError):
                    usbmux.connect(udid, port, timeout=1.0, env=fake.env())
        self.assertEqual(fake.received(), [])

    def test_tcp_listen_mode(self):
        echo = self.start_echo()
        fake = self.start_fake(listen="tcp")
        self.assertTrue(fake.address.startswith("127.0.0.1:"))
        self.assertIsNone(fake.path)
        fake.add_device(UDID, ports={8100: echo.target})
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.addCleanup(sock.close)
        sock.sendall(b"ping")
        received = b""
        while len(received) < 4:
            received += sock.recv(16)
        self.assertEqual(received, b"ping")
        self.assertTrue(usbmux.daemon_available(fake.env()))

    def test_daemon_available(self):
        fake = self.start_fake()
        self.assertTrue(usbmux.daemon_available(fake.env()))
        self.assertTrue(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": fake.path}))
        tmpdir = short_tmpdir()
        self.addCleanup(shutil.rmtree, tmpdir, True)
        regular = os.path.join(tmpdir, "regular-file")
        with open(regular, "w") as handle:
            handle.write("x")
        self.assertFalse(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": regular}))
        self.assertFalse(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": os.path.join(tmpdir, "missing")}))
        self.assertFalse(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": "192.168.0.1:27015"}))
        port = refused_port(self)
        self.assertFalse(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": "127.0.0.1:%d" % port}))

    def test_close_tunnels_models_unplugging(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={8100: echo.target})
        sock = usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.addCleanup(sock.close)
        fake.close_tunnels()
        sock.settimeout(2.0)
        self.assertEqual(sock.recv(16), b"")

    def test_remove_device_and_map_port(self):
        echo = self.start_echo()
        fake = self.start_fake()
        fake.add_device(UDID, ports={})
        fake.map_port(UDID, 8100, echo.target)
        usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env()).close()
        fake.remove_device(UDID)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=2.0, env=fake.env())
        self.assertEqual(caught.exception.reason, "device_not_found")

    def test_fake_answers_unknown_message_with_bad_command(self):
        fake = self.start_fake()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
        sock.settimeout(2.0)
        sock.connect(fake.path)
        sock.sendall(usbmux.encode_message({"MessageType": "Listen"}, 5))
        self.assertEqual(usbmux.read_message(sock), (5, {"MessageType": "Result", "Number": 1}))

    def test_fake_constructor_devices_and_stop_cleanup(self):
        fake = FakeUsbmuxd(devices=[{"udid": UDID, "ports": {8100: None}}]).start()
        path = fake.path
        self.assertTrue(os.path.exists(path))
        self.assertEqual(usbmux.list_devices(timeout=2.0, env=fake.env())[0]["udid"], UDID)
        fake.stop()
        self.assertFalse(os.path.exists(path))
        self.assertFalse(usbmux.daemon_available({"USBMUXD_SOCKET_ADDRESS": path}))


class ScriptedReplyTests(unittest.TestCase):
    def start(self, handler):
        daemon = ScriptedDaemon(handler)
        self.addCleanup(daemon.close)
        return daemon

    def test_reply_tag_mismatch_is_protocol_error(self):
        def handler(conn):
            tag, _ = read_request(conn)
            conn.sendall(usbmux.encode_message({"DeviceList": []}, tag + 40))

        daemon = self.start(handler)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.list_devices(timeout=1.0, env=daemon.env())
        self.assertEqual(caught.exception.reason, "protocol_error")

    def test_malformed_device_entries_are_skipped(self):
        def handler(conn):
            tag, _ = read_request(conn)
            conn.sendall(usbmux.encode_message({"DeviceList": [
                "junk",
                {"DeviceID": 1, "Properties": {"SerialNumber": 12345}},
                {"DeviceID": "two", "Properties": {"SerialNumber": UDID}},
                {"DeviceID": True, "Properties": {"SerialNumber": UDID}},
                {"Properties": {"SerialNumber": OTHER_UDID, "DeviceID": 5, "ConnectionType": "USB"}},
                {"DeviceID": 6, "Properties": {"SerialNumber": UDID, "ProductID": "x"}},
            ]}, tag))

        daemon = self.start(handler)
        self.assertEqual(usbmux.list_devices(timeout=1.0, env=daemon.env()), [
            {"device_id": 5, "udid": OTHER_UDID, "connection_type": "USB", "product_id": None},
            {"device_id": 6, "udid": UDID, "connection_type": "", "product_id": None},
        ])

    def test_missing_device_list_is_protocol_error(self):
        def handler(conn):
            tag, _ = read_request(conn)
            conn.sendall(usbmux.encode_message({"MessageType": "Result", "Number": 0}, tag))

        daemon = self.start(handler)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.list_devices(timeout=1.0, env=daemon.env())
        self.assertEqual(caught.exception.reason, "protocol_error")

    def test_connect_reply_without_number_is_protocol_error(self):
        def handler(conn):
            tag, _ = read_request(conn)
            conn.sendall(usbmux.encode_message({"DeviceList": [
                {"DeviceID": 3, "Properties": {"SerialNumber": UDID, "ConnectionType": "USB"}}]}, tag))
            tag, _ = read_request(conn)
            conn.sendall(usbmux.encode_message({"MessageType": "Result"}, tag))

        daemon = self.start(handler)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=1.0, env=daemon.env())
        self.assertEqual(caught.exception.reason, "protocol_error")

    def test_daemon_closing_mid_handshake_is_protocol_error(self):
        def handler(conn):
            read_request(conn)
            conn.close()

        daemon = self.start(handler)
        with self.assertRaises(UsbmuxError) as caught:
            usbmux.connect(UDID, 8100, timeout=1.0, env=daemon.env())
        self.assertEqual(caught.exception.reason, "protocol_error")


if __name__ == "__main__":
    unittest.main()
