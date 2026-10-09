"""A fake usbmuxd that speaks the real framing and tunnels Connect to loopback TCP ports.

Devices map device ports to (host, port) targets, typically a FakeWDA or a test
server on 127.0.0.1. Everything binds an AF_UNIX socket under a short /tmp
directory (or 127.0.0.1:0), runs in daemon threads and is torn down by stop().
"""

import copy
import os
import plistlib
import select
import shutil
import socket
import struct
import tempfile
import threading

HEADER = struct.Struct("<IIII")
MAX_MESSAGE = 1 << 20
JOIN_SECONDS = 2.0
POLL_SECONDS = 0.1


def short_tmpdir(prefix="iu-") -> str:
    """A fresh private temp dir with a short path (AF_UNIX paths are limited to 104/108 bytes)."""
    return tempfile.mkdtemp(prefix=prefix, dir="/tmp")


def swap16(port):
    return ((port & 0xFF) << 8) | ((port >> 8) & 0xFF)


def _frame(payload, tag):
    body = plistlib.dumps(payload, fmt=plistlib.FMT_XML)
    return HEADER.pack(HEADER.size + len(body), 1, 8, tag) + body


def _close(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


class FakeUsbmuxd:
    """In-process usbmuxd: ListDevices, Connect (+ tunnel splice), Result 1 for anything else."""

    def __init__(self, devices=None, listen="unix", tunnel_preamble=b""):
        if listen not in ("unix", "tcp"):
            raise ValueError("listen must be 'unix' or 'tcp'")
        self.listen = listen
        self.tunnel_preamble = bytes(tunnel_preamble)
        self.silent = False  # True: read requests but never answer (timeout tests)
        self.connects = []
        self.address = None
        self.path = None
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._devices = []
        self._next_device_id = 1
        self._forced = []
        self._received = []
        self._listener = None
        self._tmpdir = None
        self._threads = []
        self._clients = set()
        self._tunnels = []
        for device in devices or ():
            self.add_device(**device)

    # -- lifecycle --

    def start(self) -> "FakeUsbmuxd":
        if self._listener is not None:
            return self
        if self.listen == "unix":
            self._tmpdir = short_tmpdir()
            self.path = os.path.join(self._tmpdir, "usbmuxd.sock")
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(self.path)
            self.address = "unix:" + self.path
        else:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            self.address = "127.0.0.1:%d" % listener.getsockname()[1]
        listener.listen(16)
        listener.settimeout(POLL_SECONDS)
        self._listener = listener
        self._spawn(self._accept_loop)
        return self

    def stop(self) -> None:
        self._stopping.set()
        listener, self._listener = self._listener, None
        if listener is not None:
            _close(listener)
        with self._lock:
            sockets = list(self._clients)
            for pair in self._tunnels:
                sockets.extend(pair)
        for sock in sockets:
            _close(sock)
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(JOIN_SECONDS)
        if self._tmpdir is not None:
            shutil.rmtree(self._tmpdir, ignore_errors=True)
            self._tmpdir = None

    def __enter__(self) -> "FakeUsbmuxd":
        return self.start()

    def __exit__(self, *exc_info) -> bool:
        self.stop()
        return False

    def env(self) -> dict:
        return {"USBMUXD_SOCKET_ADDRESS": self.address}

    # -- scenario control --

    def add_device(self, udid, ports=None, connection_type="USB", device_id=None, product_id=4776) -> int:
        with self._lock:
            if device_id is None:
                device_id = self._next_device_id
            self._next_device_id = max(self._next_device_id, device_id) + 1
            self._devices.append({
                "udid": udid,
                "ports": dict(ports or {}),
                "connection_type": connection_type,
                "device_id": device_id,
                "product_id": product_id,
            })
        return device_id

    def remove_device(self, udid) -> None:
        with self._lock:
            self._devices = [d for d in self._devices if d["udid"] != udid]

    def map_port(self, udid, device_port, target) -> None:
        with self._lock:
            for device in self._devices:
                if device["udid"] == udid:
                    device["ports"][device_port] = target

    def force_result(self, number, times=1) -> None:
        with self._lock:
            self._forced.extend([number] * times)

    def received(self) -> list:
        with self._lock:
            return copy.deepcopy(self._received)

    def active_tunnels(self) -> int:
        with self._lock:
            return len(self._tunnels)

    def close_tunnels(self) -> None:
        with self._lock:
            sockets = [sock for pair in self._tunnels for sock in pair]
        for sock in sockets:
            _close(sock)

    # -- internals --

    def _spawn(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        with self._lock:
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(thread)
        thread.start()

    def _accept_loop(self):
        while not self._stopping.is_set():
            listener = self._listener
            if listener is None:
                return
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.settimeout(POLL_SECONDS)
            with self._lock:
                if self._stopping.is_set():
                    _close(conn)
                    return
                self._clients.add(conn)
            self._spawn(self._serve, conn)

    def _recv_exact(self, conn, count):
        buffer = bytearray()
        while len(buffer) < count:
            if self._stopping.is_set():
                return None
            try:
                chunk = conn.recv(count - len(buffer))
            except socket.timeout:
                continue
            except OSError:
                return None
            if not chunk:
                return None
            buffer += chunk
        return bytes(buffer)

    def _read_message(self, conn):
        header = self._recv_exact(conn, HEADER.size)
        if header is None:
            return None
        length, version, message_type, tag = HEADER.unpack(header)
        if version != 1 or message_type != 8 or not HEADER.size <= length <= MAX_MESSAGE:
            return None
        body = self._recv_exact(conn, length - HEADER.size)
        if body is None:
            return None
        try:
            payload = plistlib.loads(body)
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        return tag, payload

    def _serve(self, conn):
        try:
            while not self._stopping.is_set():
                message = self._read_message(conn)
                if message is None:
                    return
                tag, payload = message
                with self._lock:
                    self._received.append(copy.deepcopy(payload))
                if self.silent:
                    continue
                kind = payload.get("MessageType")
                if kind == "ListDevices":
                    conn.sendall(_frame({"DeviceList": self._device_list()}, tag))
                elif kind == "Connect":
                    upstream = self._connect(conn, tag, payload)
                    if upstream is not None:
                        self._splice(conn, upstream)
                        return
                else:
                    conn.sendall(_frame({"MessageType": "Result", "Number": 1}, tag))
        except OSError:
            return
        finally:
            with self._lock:
                self._clients.discard(conn)
            _close(conn)

    def _device_list(self):
        with self._lock:
            devices = [dict(d) for d in self._devices]
        return [{
            "DeviceID": d["device_id"],
            "MessageType": "Attached",
            "Properties": {
                "SerialNumber": d["udid"],
                "DeviceID": d["device_id"],
                "ConnectionType": d["connection_type"],
                "ProductID": d["product_id"],
                "LocationID": 0,
            },
        } for d in devices]

    def _connect(self, conn, tag, payload):
        device_id = payload.get("DeviceID")
        port_number = payload.get("PortNumber")
        with self._lock:
            device = None
            for candidate in self._devices:
                if candidate["device_id"] == device_id:
                    device = dict(candidate, ports=dict(candidate["ports"]))
                    break
            forced = self._forced.pop(0) if self._forced else None
        valid_port = isinstance(port_number, int) and not isinstance(port_number, bool) and 0 <= port_number <= 0xFFFF
        device_port = swap16(port_number) if valid_port else None
        upstream = None
        if forced is not None:
            number = forced
        elif device is None:
            number = 2
        elif device_port is None:
            number = 1
        else:
            target = device["ports"].get(device_port)
            number = 3
            if target is not None:
                try:
                    upstream = socket.create_connection(tuple(target), timeout=2.0)
                    number = 0
                except OSError:
                    upstream = None
        with self._lock:
            self.connects.append((device["udid"] if device else None, device_port, number))
        reply = _frame({"MessageType": "Result", "Number": number}, tag)
        if upstream is None:
            conn.sendall(reply)
            return None
        # Register the tunnel before the client can see Result 0, so active_tunnels() and
        # close_tunnels() are exact as soon as connect() returns.
        pair = (conn, upstream)
        with self._lock:
            self._tunnels.append(pair)
        try:
            # The preamble rides in the same sendall as the reply: a client that reads past
            # the reply would swallow it.
            conn.sendall(reply + self.tunnel_preamble)
        except OSError:
            with self._lock:
                self._tunnels.remove(pair)
            _close(upstream)
            raise
        return upstream

    def _splice(self, client, upstream):
        pair = (client, upstream)
        try:
            client.settimeout(None)
            upstream.settimeout(None)
            sockets = [client, upstream]
            while not self._stopping.is_set():
                try:
                    readable, _, _ = select.select(sockets, [], [], POLL_SECONDS)
                except (OSError, ValueError):
                    return
                for source in readable:
                    target = upstream if source is client else client
                    try:
                        data = source.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    try:
                        target.sendall(data)
                    except OSError:
                        return
        finally:
            with self._lock:
                if pair in self._tunnels:
                    self._tunnels.remove(pair)
            _close(upstream)
            _close(client)
