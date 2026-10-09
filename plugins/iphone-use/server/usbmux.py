"""A small stdlib client for usbmuxd, the Mac's USB device service.

usbmuxd speaks a framed protocol on AF_UNIX /var/run/usbmuxd: a 16-byte
little-endian header (total length, version 1, message type 8 = plist, tag)
followed by an XML plist. ``connect()`` sends ListDevices and then Connect on the
same socket; after a successful Connect that socket *is* the raw TCP tunnel to
the device port, so replies are read by exact length and nothing past them is
ever consumed.
"""

import os
import plistlib
import re
import socket
import stat
import struct
import time
from typing import Optional

from version import VERSION

DEFAULT_SOCKET_PATH = "/var/run/usbmuxd"
ADDRESS_ENV = "USBMUXD_SOCKET_ADDRESS"
PROG_NAME = "iphone-use"
CLIENT_VERSION = "iphone-use-" + VERSION
LIB_USBMUX_VERSION = 3
RESULT_OK, RESULT_BADCOMMAND, RESULT_BADDEV, RESULT_CONNREFUSED = 0, 1, 2, 3
MAX_MESSAGE = 1 << 20
PROTOCOL_VERSION = 1
PLIST_MESSAGE = 8
HEADER = struct.Struct("<IIII")
UDID_RE = re.compile(r"[A-Za-z0-9-]{8,64}")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
DAEMON_PROBE_TIMEOUT = 0.5

LIST_DEVICES_TAG = 1
CONNECT_TAG = 2

UNAVAILABLE_MESSAGE = "The Mac's USB device service (usbmuxd) is not reachable."
TIMEOUT_MESSAGE = "usbmuxd did not answer in time."
NOT_FOUND_MESSAGE = "The iPhone is not connected over USB, or it has not trusted this Mac yet."
ADDRESS_MESSAGE = "USBMUXD_SOCKET_ADDRESS must be a socket path or a loopback host:port."


class UsbmuxError(OSError):
    """A usbmux failure. ``reason`` is one of:

    usbmuxd_unavailable, device_not_found, connection_refused, bad_device,
    bad_command, protocol_error, timeout, not_configured.
    """

    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason
        self.message = message

    def __str__(self):
        return self.message


def swap16(port: int) -> int:
    """Byte-swap a 16-bit port (usbmuxd wants network order stored as a host integer)."""
    return ((port & 0xFF) << 8) | ((port >> 8) & 0xFF)


def socket_address(env=None) -> tuple:
    """("unix", path) or ("tcp", (host, port)) from USBMUXD_SOCKET_ADDRESS (default /var/run/usbmuxd)."""
    environ = os.environ if env is None else env
    raw = environ.get(ADDRESS_ENV)
    if raw is None or not str(raw).strip():
        return ("unix", DEFAULT_SOCKET_PATH)
    raw = str(raw).strip()
    if raw.startswith(("unix:", "UNIX:")):
        path = raw[5:]
        if not path:
            raise UsbmuxError("usbmuxd_unavailable", ADDRESS_MESSAGE)
        return ("unix", path)
    if raw.startswith("/"):
        return ("unix", raw)
    host, separator, port_text = raw.rpartition(":")
    if not separator or not re.fullmatch(r"[0-9]{1,5}", port_text):
        raise UsbmuxError("usbmuxd_unavailable", ADDRESS_MESSAGE)
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    port = int(port_text)
    if host not in LOOPBACK_HOSTS or not 1 <= port <= 65535:
        raise UsbmuxError("usbmuxd_unavailable", ADDRESS_MESSAGE)
    return ("tcp", (host, port))


def daemon_available(env=None) -> bool:
    """True when the usbmuxd socket exists (unix) or accepts a connection within 0.5 s (tcp)."""
    try:
        kind, target = socket_address(env)
    except UsbmuxError:
        return False
    if kind == "unix":
        try:
            return stat.S_ISSOCK(os.stat(target).st_mode)
        except (OSError, ValueError):
            return False
    try:
        probe = socket.create_connection(target, timeout=DAEMON_PROBE_TIMEOUT)
    except OSError:
        return False
    probe.close()
    return True


def encode_message(payload: dict, tag: int) -> bytes:
    """Frame a plist message: 16-byte header (length, version 1, type 8, tag) + XML plist."""
    body = plistlib.dumps(payload, fmt=plistlib.FMT_XML)
    total = HEADER.size + len(body)
    if total > MAX_MESSAGE:
        raise UsbmuxError("protocol_error", "The usbmux message is too large.")
    return HEADER.pack(total, PROTOCOL_VERSION, PLIST_MESSAGE, tag) + body


def recv_exact(sock, count: int) -> bytes:
    """Read exactly count bytes (never more); EOF raises protocol_error."""
    buffer = bytearray()
    while len(buffer) < count:
        chunk = sock.recv(count - len(buffer))
        if not chunk:
            raise UsbmuxError("protocol_error", "usbmuxd closed the connection.")
        buffer += chunk
    return bytes(buffer)


def read_message(sock) -> tuple:
    """Read one framed reply and return (tag, payload dict)."""
    length, version, message_type, tag = HEADER.unpack(recv_exact(sock, HEADER.size))
    if version != PROTOCOL_VERSION or message_type != PLIST_MESSAGE:
        raise UsbmuxError("protocol_error", "usbmuxd sent a message in an unexpected format.")
    if length < HEADER.size or length > MAX_MESSAGE:
        raise UsbmuxError("protocol_error", "usbmuxd sent a message with an invalid length.")
    body = recv_exact(sock, length - HEADER.size)
    try:
        payload = plistlib.loads(body)
    except Exception:  # plistlib raises several unrelated types for malformed input
        raise UsbmuxError("protocol_error", "usbmuxd sent an unreadable message.") from None
    if not isinstance(payload, dict):
        raise UsbmuxError("protocol_error", "usbmuxd sent an unexpected message.")
    return tag, payload


def _request(message_type, **fields) -> dict:
    payload = {
        "MessageType": message_type,
        "ProgName": PROG_NAME,
        "ClientVersionString": CLIENT_VERSION,
        "kLibUSBMuxVersion": LIB_USBMUX_VERSION,
    }
    payload.update(fields)
    return payload


def _open_daemon(timeout, env):
    kind, target = socket_address(env)
    try:
        if kind == "unix":
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.settimeout(timeout)
                sock.connect(target)
            except BaseException:
                sock.close()
                raise
        else:
            sock = socket.create_connection(target, timeout=timeout)
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
    except socket.timeout:
        raise UsbmuxError("timeout", TIMEOUT_MESSAGE) from None
    except (OSError, ValueError):
        raise UsbmuxError("usbmuxd_unavailable", UNAVAILABLE_MESSAGE) from None
    sock.settimeout(timeout)
    return sock


def _deadline(timeout):
    return None if timeout is None else time.monotonic() + timeout


def _remaining(deadline):
    """Seconds left before deadline (None = no deadline); raises socket.timeout when used up."""
    if deadline is None:
        return None
    left = deadline - time.monotonic()
    if left <= 0:
        raise socket.timeout("usbmux deadline")
    return left


def _exchange(sock, payload, tag, deadline) -> dict:
    """Send one request and read exactly its reply, within the overall deadline."""
    sock.settimeout(_remaining(deadline))
    sock.sendall(encode_message(payload, tag))
    sock.settimeout(_remaining(deadline))
    reply_tag, reply = read_message(sock)
    if reply_tag != tag:
        raise UsbmuxError("protocol_error", "usbmuxd answered a different request.")
    return reply


def _parse_device_list(reply) -> list:
    entries = reply.get("DeviceList")
    if not isinstance(entries, list):
        raise UsbmuxError("protocol_error", "usbmuxd did not return a device list.")
    devices = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        properties = entry.get("Properties")
        if not isinstance(properties, dict):
            properties = {}
        serial = properties.get("SerialNumber")
        device_id = entry.get("DeviceID", properties.get("DeviceID"))
        if not isinstance(serial, str) or not isinstance(device_id, int) or isinstance(device_id, bool):
            continue
        connection_type = properties.get("ConnectionType")
        product_id = properties.get("ProductID")
        devices.append({
            "device_id": device_id,
            "udid": serial,
            "connection_type": connection_type if isinstance(connection_type, str) else "",
            "product_id": product_id if isinstance(product_id, int) and not isinstance(product_id, bool) else None,
        })
    return devices


def _translate(call):
    """Run call(); map socket timeouts and stray OSErrors to UsbmuxError."""
    try:
        return call()
    except UsbmuxError:
        raise
    except socket.timeout:
        raise UsbmuxError("timeout", TIMEOUT_MESSAGE) from None
    except OSError:
        raise UsbmuxError("usbmuxd_unavailable", "The connection to usbmuxd failed.") from None


def list_devices(timeout=5.0, env=None) -> list:
    """Attached devices in reply order: [{"device_id", "udid", "connection_type", "product_id"}]."""
    deadline = _deadline(timeout)
    sock = _open_daemon(timeout, env)
    try:
        reply = _translate(lambda: _exchange(sock, _request("ListDevices"), LIST_DEVICES_TAG, deadline))
    finally:
        sock.close()
    return _parse_device_list(reply)


def _normalize_udid(udid) -> str:
    return udid.upper().replace("-", "")


def find_device(udid, devices) -> Optional[dict]:
    """The USB entry for this UDID: exact SerialNumber match first, then case/dash-insensitive.

    Wi-Fi ("Network") entries never match: iPhone Use works only over the cable, and a tunnel over
    Wi-Fi would reach the iPhone's network address, where the USB-only helper is not listening.
    """
    usb = [d for d in devices if d.get("connection_type") == "USB"]
    exact = [d for d in usb if d.get("udid") == udid]
    if exact:
        return exact[0]
    wanted = _normalize_udid(udid)
    similar = [d for d in usb if isinstance(d.get("udid"), str) and _normalize_udid(d["udid"]) == wanted]
    return similar[0] if similar else None


def _check_target(udid, port):
    if not isinstance(udid, str) or not UDID_RE.fullmatch(udid):
        raise ValueError("The iPhone UDID must be 8-64 letters, digits or dashes.")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("The iPhone port must be an integer between 1 and 65535.")


def connect(udid, port, timeout=5.0, env=None) -> socket.socket:
    """Open a raw tunnel to TCP `port` on the iPhone with this UDID.

    Raises ValueError for a bad udid/port (before any I/O) and UsbmuxError for
    every usbmux failure. The returned socket still has `timeout` set.
    """
    _check_target(udid, port)
    deadline = _deadline(timeout)
    sock = _open_daemon(timeout, env)
    connected = False
    try:
        def handshake():
            reply = _exchange(sock, _request("ListDevices"), LIST_DEVICES_TAG, deadline)
            device = find_device(udid, _parse_device_list(reply))
            if device is None:
                raise UsbmuxError("device_not_found", NOT_FOUND_MESSAGE)
            request = _request("Connect", DeviceID=device["device_id"], PortNumber=swap16(port))
            return _exchange(sock, request, CONNECT_TAG, deadline)

        reply = _translate(handshake)
        number = reply.get("Number")
        message_type = reply.get("MessageType", "Result")
        if message_type != "Result" or not isinstance(number, int) or isinstance(number, bool):
            raise UsbmuxError("protocol_error", "usbmuxd sent an unexpected answer to Connect.")
        if number == RESULT_OK:
            sock.settimeout(timeout)
            connected = True
            return sock
        if number == RESULT_CONNREFUSED:
            raise UsbmuxError(
                "connection_refused",
                "Nothing is listening on iPhone port %d; the iPhone service is not running." % port,
            )
        if number == RESULT_BADDEV:
            raise UsbmuxError("bad_device", "usbmuxd no longer knows this iPhone; reconnect the cable.")
        if number == RESULT_BADCOMMAND:
            raise UsbmuxError("bad_command", "usbmuxd rejected the connection request.")
        raise UsbmuxError("protocol_error", "usbmuxd answered Connect with an unknown result (%d)." % number)
    finally:
        if not connected:
            sock.close()
