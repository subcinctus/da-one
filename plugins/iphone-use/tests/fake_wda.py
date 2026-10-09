"""A high-fidelity fake WebDriverAgent (WDA 16.14.0) for tests.

It is a real HTTP/1.1 server on 127.0.0.1 (ephemeral port) that reproduces what the
plugin depends on (scratchpad notes/wda_api.md, DESIGN.md section 12.1):

* framing: keep-alive, exact Content-Length, pretty-printed JSON, Transfer-Encoding
  rejected with 400 and a closed connection;
* routing by scope: session-only, sessionless-only and both variants, 404 `unknown
  command` for the wrong scope and 404 `invalid session id` for a stale session;
* one active session; a new session resets settings and the element cache;
* a device model (apps, foreground, lock state, window size, node trees) behind
  `/source`, `/elements`, element routes, taps, drags, typing, buttons and apps;
* a predicate evaluator written independently of `wda_tree.predicate`, so the
  plugin's escaping is checked against a second implementation;
* fault injection (`inject`), a request log (`requests`, `routes()`, `actions()`),
  and an optional MJPEG port speaking WDA's exact stream format.

Everything runs in daemon threads and is torn down by `stop()`. Nothing is printed.
"""

import base64
import collections
import itertools
import json
import math
import os
import re
import select
import socket
import sys
import threading
import time
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import parse_qsl, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from wda_image import solid_png  # noqa: E402

# Captured at import so a test that patches the time module elsewhere cannot stall the fake.
_monotonic = time.monotonic

ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
# A 313-byte 39x84 baseline JPEG (SOF0) that starts FFD8FFE0 and ends FFD9 (notes/wda_api 9.3).
TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNi"
    "UFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8"
    "fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCABUACcDASIAAhEBAxEB/8QAFQABAQAAAAAA"
    "AAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEA"
    "AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYBUTQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q=="
)
DEFAULT_SIZE = (390, 844)
DEFAULT_SCALE = 3
SETTINGS_DEFAULTS = {"shouldUseCompactResponses": True, "elementResponseAttributes": "type,label",
                     "waitForIdleTimeout": 10, "animationCoolOffTimeout": 2, "maxTypingFrequency": 60,
                     "snapshotMaxDepth": 50, "mjpegServerFramerate": 10, "mjpegServerScreenshotQuality": 25,
                     "mjpegScalingFactor": 100}
# The 16-node Settings screen of notes/wda_api 6.7.1, verbatim. settings_app() must serialize to exactly this.
SETTINGS_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0" traits="" processId="412" bundleId="com.apple.Preferences">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0" traits="">
    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="0" traits="">
      <XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Settings" enabled="true" visible="true" accessible="false" x="0" y="47" width="390" height="96" index="0" traits="">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Settings" name="Settings" label="Settings" enabled="true" visible="true" accessible="true" x="16" y="91" width="117" height="41" index="0" traits="Header"/>
      </XCUIElementTypeNavigationBar>
      <XCUIElementTypeSearchField type="XCUIElementTypeSearchField" value="Search" name="Search" label="Search" enabled="true" visible="true" accessible="true" x="16" y="143" width="358" height="36" index="1" placeholderValue="Search" traits="SearchField"/>
      <XCUIElementTypeTable type="XCUIElementTypeTable" enabled="true" visible="true" accessible="false" x="0" y="0" width="390" height="844" index="2" traits="">
        <XCUIElementTypeCell type="XCUIElementTypeCell" name="com.apple.settings.primaryAppleAccount" label="Sign in to your iPhone, Set up iCloud, the App Store, and more." enabled="true" visible="true" accessible="true" x="16" y="195" width="358" height="76" index="0" traits="Button"/>
        <XCUIElementTypeCell type="XCUIElementTypeCell" enabled="true" visible="true" accessible="false" x="16" y="303" width="358" height="44" index="1" traits="">
          <XCUIElementTypeImage type="XCUIElementTypeImage" name="airplane" label="Airplane Mode" enabled="true" visible="true" accessible="false" x="32" y="311" width="29" height="29" index="0" traits="Image"/>
          <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" value="0" name="Airplane Mode" label="Airplane Mode" enabled="true" visible="true" accessible="true" x="16" y="303" width="358" height="44" index="1" traits="Button, ToggleButton"/>
        </XCUIElementTypeCell>
        <XCUIElementTypeCell type="XCUIElementTypeCell" value="Home-5G" name="com.apple.settings.wi-fi" label="Wi-Fi" enabled="true" visible="true" accessible="true" x="16" y="347" width="358" height="44" index="2" traits="Button"/>
        <XCUIElementTypeCell type="XCUIElementTypeCell" name="com.apple.settings.privacyAndSecurity" label="Privacy &amp; Security&#10;Location, Camera" enabled="false" visible="true" accessible="true" x="16" y="391" width="358" height="44" index="3" traits="Button, NotEnabled"/>
        <XCUIElementTypeCell type="XCUIElementTypeCell" name="com.apple.settings.general" label="General" enabled="true" visible="false" accessible="true" x="16" y="1210" width="358" height="44" index="4" traits="Button"/>
      </XCUIElementTypeTable>
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" value="Email" label="" enabled="true" visible="true" accessible="true" x="16" y="760" width="358" height="34" index="3" placeholderValue="Email" traits=""/>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Done" label="Done" enabled="true" visible="true" accessible="true" x="318" y="56" width="56" height="34" index="4" traits="Button"/>
    </XCUIElementTypeOther>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>
"""
TEXT_INPUT_TYPES = ("XCUIElementTypeTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView",
                    "XCUIElementTypeSecureTextField")

TYPE_PREFIX = "XCUIElementType"
APPLICATION = "XCUIElementTypeApplication"
WINDOW = "XCUIElementTypeWindow"
STATIC_TEXT = "XCUIElementTypeStaticText"
TEXT_FIELD = "XCUIElementTypeTextField"
SECURE_TEXT_FIELD = "XCUIElementTypeSecureTextField"
TEXT_VIEW = "XCUIElementTypeTextView"
ALWAYS_LABELLED = (TEXT_FIELD, SECURE_TEXT_FIELD)
CONTAINER_TYPES = (APPLICATION, WINDOW, "XCUIElementTypeOther", "XCUIElementTypeNavigationBar",
                   "XCUIElementTypeTable", "XCUIElementTypeCollectionView", "XCUIElementTypeScrollView")
DEFAULT_TRAITS = {
    "XCUIElementTypeButton": "Button", "XCUIElementTypeCell": "Button", "XCUIElementTypeIcon": "Button",
    "XCUIElementTypeLink": "Link", "XCUIElementTypeStaticText": "StaticText", "XCUIElementTypeImage": "Image",
    "XCUIElementTypeSearchField": "SearchField", "XCUIElementTypeSwitch": "Button, ToggleButton",
    "XCUIElementTypeKey": "KeyboardKey",
}
SPRINGBOARD = "com.apple.springboard"
WDA_VERSION = "16.14.0"
IOS_VERSION = "18.0"
CAPABILITY_SETTINGS = ("shouldUseCompactResponses", "elementResponseAttributes", "maxTypingFrequency",
                       "waitForIdleTimeout")
SUPPORTED_BUTTONS = ("home", "volumeup", "volumedown")

# WDA error code -> HTTP status (notes/wda_api 3.2) and the default message.
ERROR_STATUS = {
    "unknown error": 500, "unable to capture screen": 500, "no such element": 404,
    "invalid element state": 400, "invalid argument": 400, "stale element reference": 404,
    "invalid selector": 400, "no such alert": 404, "unexpected alert open": 500, "unknown method": 405,
    "session not created": 500, "invalid coordinates": 400, "unsupported operation": 500,
    "unknown command": 404, "timeout": 408, "element not visible": 400, "invalid session id": 404,
}
ERROR_MESSAGES = {
    "unknown error": "An unknown server-side error occurred while processing the command",
    "unable to capture screen": "A screen capture was made impossible",
    "no such element": "An element could not be located on the page using the given search parameters",
    "invalid element state": "An element command could not be completed because the element is in an invalid state",
    "invalid argument": "The arguments passed to the command are either invalid or malformed",
    "stale element reference": "An element command failed because the referenced element is no longer attached "
                               "to the DOM",
    "invalid selector": "Argument was an invalid selector (e.g. XPath/Class Chain)",
    "no such alert": "An attempt was made to operate on a modal dialog when one was not open",
    "unexpected alert open": "A modal dialog was open, blocking this operation",
    "unknown method": "Method is not implemented",
    "session not created": "A new session could not be created",
    "invalid coordinates": "The coordinates provided to an interactions operation are invalid",
    "unsupported operation": "The requested operation is not supported",
    "unknown command": "The requested resource could not be found, or a request was received using an HTTP "
                       "method that is not supported by the mapped resource",
    "timeout": "An operation did not complete before its timeout expired",
    "element not visible": "An element command could not be completed because the element is not visible on "
                           "the page",
    "invalid session id": "A session is either terminated or not started",
}
REASONS = {200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
           413: "Request Entity Too Large", 500: "Internal Server Error", 501: "Not Implemented"}
JSON_CONTENT_TYPE = "application/json;charset=UTF-8"
HEALTH_PAGE = b"<!DOCTYPE html><html><title>Health Check</title><body><p>I-AM-ALIVE</p></body></html>"
MAX_HEADER_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024 * 1024

MJPEG_HEADER = (b"HTTP/1.0 200 OK\r\nServer: WDA MJPEG Server\r\nConnection: close\r\nMax-Age: 0\r\n"
                b"Expires: 0\r\nCache-Control: no-cache, private\r\nPragma: no-cache\r\n"
                b"Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n")
MJPEG_CHUNKED_HEADER = (b"HTTP/1.1 200 OK\r\nServer: WDA MJPEG Server\r\nTransfer-Encoding: chunked\r\n"
                        b"Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n")
MJPEG_GARBAGE = b"\x00\x01junk-before-the-first-part\r\nmore junk\r\n"
MJPEG_PIECE = 7
MJPEG_MODES = ("normal", "silent", "chunked", "split", "garbage")
MJPEG_COUNTED_MODES = ("close_after", "stall_after")


def mjpeg_part(jpeg):
    """One frame exactly as WDA writes it (note the lower-case 't' in Content-type)."""
    return (b"--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg)
            + jpeg + b"\r\n\r\n")


def _parse_mjpeg_mode(mode):
    """("normal"|"silent"|"chunked"|"split"|"garbage"|"close_after"|"stall_after", count or None)."""
    mode = str(mode or "normal")
    kind, _, count = mode.partition(":")
    if kind in MJPEG_COUNTED_MODES:
        if not re.fullmatch(r"[0-9]+", count):
            raise ValueError("mjpeg_mode %r needs a frame count, e.g. %s:2" % (mode, kind))
        return kind, int(count)
    if kind not in MJPEG_MODES or count:
        raise ValueError("unknown mjpeg_mode %r" % mode)
    return kind, None


def chunk_bytes(data, size=MJPEG_PIECE):
    """HTTP/1.1 chunked framing of `data` in chunks of at most `size` bytes (no terminator)."""
    out = []
    for start in range(0, len(data), size):
        piece = data[start:start + size]
        out.append(b"%x\r\n" % len(piece) + piece + b"\r\n")
    return b"".join(out)


_COUNTER_LOCK = threading.Lock()
_NODE_NUMBERS = itertools.count(1)
_PIDS = itertools.count(501)
_UNSET = object()


def _next(counter):
    with _COUNTER_LOCK:
        return next(counter)


def _full_type(kind):
    kind = str(kind)
    return kind if kind.startswith(TYPE_PREFIX) else TYPE_PREFIX + kind


def _number(value):
    """JSON-friendly number: whole floats become ints (WDA prints 390, not 390.0)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _integral_rect(rect):
    """CGRectIntegral: floor the origin, ceil the far edge; infinite frames become -1,-1,0,0."""
    x, y, w, h = (float(v) for v in rect)
    if not all(math.isfinite(v) for v in (x, y, w, h)):
        return (-1, -1, 0, 0)
    left, top = math.floor(x), math.floor(y)
    right, bottom = math.ceil(x + w), math.ceil(y + h)
    return (left, top, right - left, bottom - top)


# ---------------------------------------------------------------------------
# Device model
# ---------------------------------------------------------------------------

class Node:
    """One accessibility element of the fake device.

    `type` may be short ("Button") or full; it is stored full. `name` is the
    accessibility identifier (WDA's `name` falls back to the label); `identifier` is an
    alias for it. `on_tap(fake, node)` runs for hit-tested taps and element clicks.
    `accessible` and `traits` default to plausible values derived from the type.
    """

    def __init__(self, type, label=None, name=None, value=None, rect=(0, 0, 0, 0), enabled=True, visible=True,
                 hittable=True, placeholder=None, children=None, on_tap=None, identifier=None,
                 accessible=None, traits=None):
        self.type = _full_type(type)
        self.label = label
        self.name = identifier if identifier is not None else name
        self.value = value
        self.rect = tuple(rect)
        self.enabled = bool(enabled)
        self.visible = bool(visible)
        self.hittable = bool(hittable)
        self.placeholder = placeholder
        self.children = list(children or [])
        self.on_tap = on_tap
        self.accessible = accessible
        self.traits = traits
        self.focused = False
        self.id = "%08X-0000-0000-9C01-000000000000" % _next(_NODE_NUMBERS)

    @property
    def identifier(self):
        return self.name

    @identifier.setter
    def identifier(self, value):
        self.name = value

    def __repr__(self):
        return "Node(%s, label=%r, name=%r)" % (self.type[len(TYPE_PREFIX):], self.label, self.name)

    def add(self, *nodes):
        self.children.extend(nodes)
        return self

    def walk(self):
        """Pre-order iterator over this node and its descendants (self first)."""
        stack = [self]
        while stack:
            node = stack.pop()
            yield node
            stack.extend(reversed(node.children))

    def find(self, label=None, type=None, name=None):
        """First node in pre-order matching every given criterion, or None."""
        wanted_type = _full_type(type) if type is not None else None
        for node in self.walk():
            if label is not None and node.label != label:
                continue
            if wanted_type is not None and node.type != wanted_type:
                continue
            if name is not None and name not in (node.name, node.wd_name):
                continue
            return node
        return None

    @property
    def wd_value(self):
        """WDA's `value`: StaticText falls back to the label, text inputs to the placeholder."""
        if self.type == STATIC_TEXT:
            value = self.value if self.value not in (None, "") else self.label
        elif self.type in TEXT_INPUT_TYPES:
            if self.value not in (None, ""):
                text = str(self.value)
                value = "•" * len(text) if self.type == SECURE_TEXT_FIELD else text
            else:
                value = self.placeholder
        else:
            value = self.value
        if value is None or value == "":
            return None
        return str(value)

    @property
    def wd_name(self):
        """WDA's `name`: the accessibility identifier, else the label, else None."""
        return self.name or self.label or None

    @property
    def wd_label(self):
        """WDA's `label`: empty becomes None, except text fields always report a string."""
        if self.type in ALWAYS_LABELLED:
            return self.label or ""
        return self.label or None

    @property
    def is_accessible(self):
        if self.accessible is not None:
            return bool(self.accessible)
        return not self.children and self.type not in CONTAINER_TYPES

    @property
    def trait_text(self):
        if self.traits is not None:
            return self.traits
        if not self.is_accessible:
            return ""
        traits = [DEFAULT_TRAITS[self.type]] if self.type in DEFAULT_TRAITS else []
        if not self.enabled:
            traits.append("NotEnabled")
        return ", ".join(traits)


class App:
    """An installed app: bundle id, process id and its current root node (or pages)."""

    def __init__(self, bundle_id, root, pid=None):
        self.bundle_id = bundle_id
        self.root = root
        self.pid = pid if pid is not None else _next(_PIDS)
        self.pages = None
        self.page = 0

    def __repr__(self):
        return "App(%r)" % (self.bundle_id,)


def _open_app(bundle_id):
    def on_tap(fake, node):
        if bundle_id in fake.apps:
            fake.foreground = bundle_id
    return on_tap


def settings_app(size=DEFAULT_SIZE):
    """The 16-node Settings screen of notes/wda_api 6.7.1 (bundle com.apple.Preferences)."""
    width, height = size
    full = (0, 0, width, height)
    row = width - 32  # 358 on a 390-point-wide phone
    airplane_cell = Node("Cell", rect=(16, 303, row, 44), accessible=False, traits="", children=[
        Node("Image", label="Airplane Mode", identifier="airplane", rect=(32, 311, 29, 29), accessible=False,
             traits="Image"),
        Node("Switch", label="Airplane Mode", value="0", rect=(16, 303, row, 44), traits="Button, ToggleButton"),
    ])
    table = Node("Table", rect=full, accessible=False, traits="", children=[
        Node("Cell", label="Sign in to your iPhone, Set up iCloud, the App Store, and more.",
             identifier="com.apple.settings.primaryAppleAccount", rect=(16, 195, row, 76), traits="Button"),
        airplane_cell,
        Node("Cell", label="Wi-Fi", value="Home-5G", identifier="com.apple.settings.wi-fi",
             rect=(16, 347, row, 44), traits="Button"),
        Node("Cell", label="Privacy & Security\nLocation, Camera",
             identifier="com.apple.settings.privacyAndSecurity", enabled=False, rect=(16, 391, row, 44),
             traits="Button, NotEnabled"),
        Node("Cell", label="General", identifier="com.apple.settings.general", visible=False,
             rect=(16, 1210, row, 44), traits="Button"),
    ])
    content = Node("Other", rect=full, accessible=False, traits="", children=[
        Node("NavigationBar", identifier="Settings", rect=(0, 47, width, 96), accessible=False, traits="",
             children=[Node("StaticText", label="Settings", rect=(16, 91, 117, 41), accessible=True,
                            traits="Header")]),
        Node("SearchField", label="Search", placeholder="Search", rect=(16, 143, row, 36), traits="SearchField"),
        table,
        Node("TextField", label="", placeholder="Email", rect=(16, 760, row, 34), traits=""),
        Node("Button", label="Done", rect=(width - 72, 56, 56, 34), traits="Button"),
    ])
    window = Node("Window", rect=full, accessible=False, traits="", children=[content])
    root = Node("Application", label="Settings", rect=full, accessible=False, traits="", children=[window])
    return App("com.apple.Preferences", root, pid=412)


def springboard_app(size=DEFAULT_SIZE):
    """The Home Screen: Application "SpringBoard" with Settings, Notes and Messages icons."""
    width, height = size
    icons = []
    for index, (label, bundle_id) in enumerate((("Settings", "com.apple.Preferences"),
                                                ("Notes", "com.apple.mobilenotes"),
                                                ("Messages", "com.apple.MobileSMS"))):
        icons.append(Node("Icon", label=label, rect=(27 + index * 90, 100, 64, 76), on_tap=_open_app(bundle_id)))
    window = Node("Window", rect=(0, 0, width, height), children=icons)
    root = Node("Application", label="SpringBoard", rect=(0, 0, width, height), children=[window])
    return App(SPRINGBOARD, root, pid=58)


def form_app(size=DEFAULT_SIZE):
    """A sign-in style form: email, password, multi-line message, Send and Cancel."""
    width, height = size
    content = Node("Other", rect=(0, 0, width, height), children=[
        Node("TextField", label="", placeholder="Email", name="email", rect=(16, 120, 358, 44)),
        Node("SecureTextField", label="", placeholder="Password", name="password", rect=(16, 180, 358, 44)),
        Node("TextView", name="message", rect=(16, 240, 358, 160)),
        Node("Button", label="Send", rect=(16, 420, 170, 44)),
        Node("Button", label="Cancel", rect=(204, 420, 170, 44)),
    ])
    window = Node("Window", rect=(0, 0, width, height), children=[content])
    root = Node("Application", label="Form", rect=(0, 0, width, height), children=[window])
    return App("com.example.form", root)


def list_app(pages=3, rows=8, size=DEFAULT_SIZE):
    """(App "com.example.list", [page roots]): Cells "Row <n>", `rows` per page.

    Each drag shows the next page (labels advance by `rows`); StaticText "End of list"
    appears only on the last page. The returned App already has the pages set.
    """
    width, height = size
    roots = []
    for page in range(pages):
        children = []
        for row in range(rows):
            number = page * rows + row + 1
            children.append(Node("Cell", label="Row %d" % number, rect=(0, 100 + row * 60, width, 60)))
        if page == pages - 1:
            children.append(Node("StaticText", label="End of list", rect=(16, 110 + rows * 60, width - 32, 30)))
        table = Node("Table", rect=(0, 0, width, height), children=children)
        window = Node("Window", rect=(0, 0, width, height), children=[table])
        roots.append(Node("Application", label="List", rect=(0, 0, width, height), children=[window]))
    app = App("com.example.list", roots[0])
    app.pages = roots
    return app, roots


def _node_from_element(element):
    attributes = element.attrib
    kind = _full_type(attributes.get("type") or element.tag)
    label = attributes.get("label")
    name = attributes.get("name")
    value = attributes.get("value")
    placeholder = attributes.get("placeholderValue")
    if kind in TEXT_INPUT_TYPES and value is not None and value == placeholder:
        value = None  # an empty field reports its placeholder as the value
    if kind == STATIC_TEXT and value is not None and value == label:
        value = None  # StaticText reports its label as the value
    rect = []
    for key in ("x", "y", "width", "height"):
        number = float(attributes.get(key, 0))
        rect.append(int(number) if number.is_integer() else number)
    accessible = attributes.get("accessible")
    node = Node(
        kind,
        label=label,
        identifier=name if name is not None and name != label else None,
        value=value,
        rect=tuple(rect),
        enabled=attributes.get("enabled", "true") != "false",
        visible=attributes.get("visible", "true") != "false",
        placeholder=placeholder,
        accessible=None if accessible is None else accessible == "true",
        traits=attributes.get("traits"),
    )
    node.children = [_node_from_element(child) for child in element]
    return node


def parse_xml(xml_text):
    """Build a Node tree from WDA-style `/source` XML (an outer wrapper element is skipped)."""
    root = ET.fromstring(xml_text)
    if not (root.get("type") or root.tag).startswith(TYPE_PREFIX) and len(root) == 1:
        root = root[0]
    return _node_from_element(root)


# ---------------------------------------------------------------------------
# /source serialization
# ---------------------------------------------------------------------------

_XML_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\n": "&#10;", "\t": "&#9;",
                "\r": "&#13;"}


def _xml_legal(code):
    return (0x20 <= code <= 0xD7FF or 0xE000 <= code <= 0xFFFD or 0x10000 <= code <= 0x10FFFF
            or code in (0x9, 0xA, 0xD))


def xml_attribute(text):
    """libxml2-style attribute escaping; characters illegal in XML 1.0 are deleted."""
    out = []
    for character in str(text):
        if character in _XML_ESCAPES:
            out.append(_XML_ESCAPES[character])
        elif _xml_legal(ord(character)):
            out.append(character)
    return "".join(out)


def _bool_text(value):
    return "true" if value else "false"


# ---------------------------------------------------------------------------
# Independent NSPredicate evaluator (deliberately does not import wda_tree)
# ---------------------------------------------------------------------------

class PredicateSyntaxError(Exception):
    pass


class PredicateAttributeError(Exception):
    def __init__(self, attribute):
        super().__init__(attribute)
        self.attribute = attribute


PREDICATE_ATTRIBUTES = {
    "label": lambda node: node.wd_label,
    "name": lambda node: node.wd_name,
    "value": lambda node: node.wd_value,
    "type": lambda node: node.type,
    "enabled": lambda node: node.enabled,
    "visible": lambda node: node.visible,
    "hittable": lambda node: node.hittable,
    "placeholderValue": lambda node: node.placeholder,
}
_COMPARISON_WORDS = ("CONTAINS", "BEGINSWITH", "ENDSWITH", "LIKE", "MATCHES")
_BOOLEAN_WORDS = {"TRUE": True, "YES": True, "FALSE": False, "NO": False}
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_MODIFIER = re.compile(r"\[(c|d|cd|dc)\]", re.IGNORECASE)


def _read_string(text, start):
    """Read a quoted literal starting at text[start]; returns (value, next index)."""
    quote = text[start]
    index = start + 1
    out = []
    while True:
        if index >= len(text):
            raise PredicateSyntaxError("unterminated string")
        character = text[index]
        if character == quote:
            return "".join(out), index + 1
        if character in "\r\n":
            raise PredicateSyntaxError("raw line break inside a string")
        if character == "\\":
            escaped = text[index + 1:index + 2]
            if escaped in ("\\", "'", '"'):
                out.append(escaped)
                index += 2
                continue
            if escaped == "u":
                digits = text[index + 2:index + 6]
                if len(digits) == 4 and all(d in "0123456789abcdefABCDEF" for d in digits):
                    out.append(chr(int(digits, 16)))
                    index += 6
                    continue
            raise PredicateSyntaxError("bad escape")
        out.append(character)
        index += 1


def _tokenize(text):
    tokens = []
    index = 0
    while index < len(text):
        character = text[index]
        if character in " \t\r\n":
            index += 1
            continue
        if character in "'\"":
            value, index = _read_string(text, index)
            tokens.append(("LITERAL", value))
            continue
        pair = text[index:index + 2]
        if pair in ("==", "!=", "<>"):
            tokens.append(("OP", "!=" if pair == "<>" else pair))
            index += 2
            continue
        if pair == "&&":
            tokens.append(("AND", pair))
            index += 2
            continue
        if pair == "||":
            tokens.append(("OR", pair))
            index += 2
            continue
        if character == "=":
            tokens.append(("OP", "=="))
            index += 1
            continue
        if character == "!":
            tokens.append(("NOT", character))
            index += 1
            continue
        if character in "()":
            tokens.append((character, character))
            index += 1
            continue
        if character == "[":
            match = _MODIFIER.match(text, index)
            if not match:
                raise PredicateSyntaxError("bad modifier")
            tokens.append(("MOD", match.group(1).lower()))
            index = match.end()
            continue
        match = _NUMBER.match(text, index)
        if match:
            number = float(match.group()) if "." in match.group() else int(match.group())
            tokens.append(("LITERAL", number))
            index = match.end()
            continue
        match = _IDENTIFIER.match(text, index)
        if match:
            word = match.group()
            upper = word.upper()
            if upper in ("AND", "OR", "NOT", "TRUEPREDICATE", "FALSEPREDICATE"):
                tokens.append((upper, word))
            elif upper in _COMPARISON_WORDS:
                tokens.append(("OP", upper))
            elif upper in _BOOLEAN_WORDS:
                tokens.append(("LITERAL", _BOOLEAN_WORDS[upper]))
            else:
                tokens.append(("IDENT", word))
            index = match.end()
            continue
        raise PredicateSyntaxError("unexpected character")
    return tokens


class _PredicateParser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.position = 0

    def _peek(self):
        if self.position < len(self.tokens):
            return self.tokens[self.position][0]
        return None

    def _take(self, kind=None):
        if self.position >= len(self.tokens):
            raise PredicateSyntaxError("unexpected end")
        token = self.tokens[self.position]
        if kind is not None and token[0] != kind:
            raise PredicateSyntaxError("expected " + kind)
        self.position += 1
        return token

    def parse(self):
        expression = self._or()
        if self.position != len(self.tokens):
            raise PredicateSyntaxError("trailing tokens")
        return expression

    def _or(self):
        left = self._and()
        while self._peek() == "OR":
            self._take()
            left = ("or", left, self._and())
        return left

    def _and(self):
        left = self._not()
        while self._peek() == "AND":
            self._take()
            left = ("and", left, self._not())
        return left

    def _not(self):
        if self._peek() == "NOT":
            self._take()
            return ("not", self._not())
        return self._primary()

    def _primary(self):
        kind = self._peek()
        if kind == "(":
            self._take()
            expression = self._or()
            self._take(")")
            return expression
        if kind == "TRUEPREDICATE":
            self._take()
            return ("const", True)
        if kind == "FALSEPREDICATE":
            self._take()
            return ("const", False)
        attribute = self._take("IDENT")[1]
        operator = self._take("OP")[1]
        modifiers = ""
        if self._peek() == "MOD":
            modifiers = self._take()[1]
        literal = self._take("LITERAL")[1]
        return ("compare", attribute, operator, modifiers, literal)


def _attributes_of(expression, found):
    if expression[0] == "compare":
        found.append(expression[1])
    elif expression[0] in ("and", "or"):
        _attributes_of(expression[1], found)
        _attributes_of(expression[2], found)
    elif expression[0] == "not":
        _attributes_of(expression[1], found)
    return found


def _fold(text, modifiers):
    if "c" in modifiers:
        text = text.casefold()
    if "d" in modifiers:
        text = "".join(ch for ch in unicodedata.normalize("NFD", text) if not unicodedata.combining(ch))
    return text


def _like_pattern(pattern):
    out = []
    for character in pattern:
        if character == "*":
            out.append(".*")
        elif character == "?":
            out.append(".")
        else:
            out.append(re.escape(character))
    return "".join(out)


def _compare(actual, operator, modifiers, literal):
    """NSPredicate-style comparison: nil or mismatched types are unequal (so only `!=` holds)."""
    if isinstance(actual, bool):
        if isinstance(literal, bool):
            expected = literal
        elif isinstance(literal, (int, float)) and literal in (0, 1):
            expected = bool(literal)
        else:
            return operator == "!="
        if operator == "==":
            return actual == expected
        if operator == "!=":
            return actual != expected
        return False
    if not isinstance(literal, str) or actual is None:
        return operator == "!="
    left = _fold(str(actual), modifiers)
    right = _fold(literal, modifiers)
    if operator == "==":
        return left == right
    if operator == "!=":
        return left != right
    if operator == "CONTAINS":
        return right in left
    if operator == "BEGINSWITH":
        return left.startswith(right)
    if operator == "ENDSWITH":
        return left.endswith(right)
    if operator == "LIKE":
        return re.fullmatch(_like_pattern(right), left, re.DOTALL) is not None
    if operator == "MATCHES":
        try:
            return re.fullmatch(right, left) is not None
        except re.error:
            return False
    return False


def _evaluate(expression, node):
    kind = expression[0]
    if kind == "const":
        return expression[1]
    if kind == "not":
        return not _evaluate(expression[1], node)
    if kind == "and":
        return _evaluate(expression[1], node) and _evaluate(expression[2], node)
    if kind == "or":
        return _evaluate(expression[1], node) or _evaluate(expression[2], node)
    _, attribute, operator, modifiers, literal = expression
    return _compare(PREDICATE_ATTRIBUTES[attribute](node), operator, modifiers, literal)


def compile_predicate(text):
    """Compile an NSPredicate format string into `matches(node) -> bool`.

    Raises PredicateSyntaxError (WDA: "Unable to parse the format string") or
    PredicateAttributeError (WDA: "The attribute 'x' is unknown").
    """
    expression = _PredicateParser(_tokenize(text)).parse()
    for attribute in _attributes_of(expression, []):
        if attribute not in PREDICATE_ATTRIBUTES:
            raise PredicateAttributeError(attribute)
    return lambda node: _evaluate(expression, node)


# ---------------------------------------------------------------------------
# Request log and fault injection
# ---------------------------------------------------------------------------

_RequestTuple = collections.namedtuple("Request", "method path route query body sid")


class Request(_RequestTuple):
    """One request the fake received.

    `path` is the raw path without the query; `route` has the session prefix removed and
    element ids replaced by ":id" ("/session/X/element/ABC/click" -> "/element/:id/click").
    For convenience a Request also compares equal to the strings "METHOD route" and
    "route", so `fake.actions() == ["POST /wda/tap"]` works as well as `.route` access.
    """

    __slots__ = ()

    def __eq__(self, other):
        if isinstance(other, str):
            return other == self.method + " " + self.route or other == self.route
        return tuple.__eq__(self, other)

    def __ne__(self, other):
        result = self.__eq__(other)
        return result if result is NotImplemented else not result

    __hash__ = tuple.__hash__

    def __str__(self):
        return self.method + " " + self.route


class _Injection:
    def __init__(self, method, route, status, error, message, value, delay, drop, execute, raw, times):
        self.method = method.upper() if method else None
        self.route = route
        self.status = status
        self.error = error
        self.message = message
        self.value = value
        self.delay = float(delay or 0.0)
        self.drop = bool(drop)
        self.execute = bool(execute)
        self.raw = raw
        self.remaining = times

    def matches(self, request):
        if self.remaining is not None and self.remaining <= 0:
            return False
        if self.method is not None and self.method != request.method:
            return False
        return self.route is None or self.route == request.route

    @property
    def replaces_response(self):
        return self.drop or self.raw is not None or self.error is not None or self.status is not None


class _Fault(Exception):
    """A WDA error response raised inside a handler."""

    def __init__(self, code, message=None, status=None):
        super().__init__(code)
        self.code = code
        self.message = message if message is not None else ERROR_MESSAGES.get(code, code)
        self.status = status if status is not None else ERROR_STATUS.get(code, 500)


class _Raw:
    """A non-JSON response (e.g. GET /health)."""

    def __init__(self, status, payload, content_type=None):
        self.status = status
        self.payload = payload
        self.content_type = content_type


class _BadRequest(Exception):
    pass


_SESSION_PATH = re.compile(r"^/session/([^/]+)(/.*)?$", re.IGNORECASE)

# (method, pattern, scopes, handler name, standalone). Scopes: N = without a session prefix,
# S = under /session/{sid}, SID = the /session/{sid} resource itself.
_ROUTES = [
    ("GET", r"/status", "N", "_status", True),
    ("POST", r"/session", "N", "_create_session", False),
    ("GET", r"/session/:sid", "SID", "_get_session", False),
    ("DELETE", r"/session/:sid", "SID", "_delete_session", True),
    ("POST", r"/wda/homescreen", "N", "_homescreen", False),
    ("GET", r"/health", "N", "_health", False),
    ("GET", r"/wda/healthcheck", "N", "_healthcheck", False),
    ("POST", r"/wda/unlock", "N", "_unlock", False),
    ("GET", r"/source", "NS", "_source", False),
    ("GET", r"/screenshot", "NS", "_screenshot", True),
    ("GET", r"/window/size", "NS", "_window_size", False),
    ("GET", r"/wda/activeAppInfo", "NS", "_active_app_info", False),
    ("GET", r"/wda/locked", "NS", "_locked", False),
    ("GET", r"/wda/screen", "NS", "_screen", False),
    ("POST", r"/appium/settings", "S", "_post_settings", False),
    ("GET", r"/appium/settings", "S", "_get_settings", False),
    ("POST", r"/elements", "S", "_find_elements", False),
    ("POST", r"/element", "S", "_find_element", False),
    ("GET", r"/element/active", "S", "_active_element", False),
    ("POST", r"/element/([^/]+)/elements", "S", "_find_child_elements", False),
    ("POST", r"/element/([^/]+)/element", "S", "_find_child_element", False),
    ("GET", r"/element/([^/]+)/rect", "S", "_element_rect", False),
    ("GET", r"/element/([^/]+)/attribute/([^/]+)", "S", "_element_attribute", False),
    ("GET", r"/element/([^/]+)/text", "S", "_element_text", False),
    ("GET", r"/element/([^/]+)/enabled", "S", "_element_enabled", False),
    ("GET", r"/element/([^/]+)/displayed", "S", "_element_displayed", False),
    ("GET", r"/element/([^/]+)/name", "S", "_element_tag", False),
    ("POST", r"/element/([^/]+)/click", "S", "_click", False),
    ("POST", r"/element/([^/]+)/clear", "S", "_clear", False),
    ("POST", r"/element/([^/]+)/value", "S", "_set_value", False),
    ("POST", r"/wda/keys", "S", "_keys", False),
    ("POST", r"/wda/tap", "S", "_tap", False),
    ("POST", r"/wda/dragfromtoforduration", "S", "_drag", False),
    ("POST", r"/wda/pressButton", "S", "_press_button", False),
    ("POST", r"/wda/apps/activate", "S", "_activate", False),
    ("POST", r"/wda/apps/launch", "S", "_activate", False),
    ("POST", r"/wda/apps/terminate", "S", "_terminate", False),
    ("POST", r"/wda/apps/state", "S", "_app_state", False),
]
_COMPILED_ROUTES = [(method, re.compile(pattern, re.IGNORECASE), scopes, handler, standalone)
                    for method, pattern, scopes, handler, standalone in _ROUTES if scopes != "SID"]
_NOT_ACTIONS = ("/elements", "/element", "/element/:id/element", "/element/:id/elements",
                "/appium/settings", "/session")


def _route_of(inner_path):
    """Replace element ids with ':id' (the segment after 'element', unless it is 'active')."""
    parts = inner_path.split("/")
    out = []
    for index, part in enumerate(parts):
        if index > 0 and parts[index - 1].lower() == "element" and part and part.lower() != "active":
            out.append(":id")
        else:
            out.append(part)
    return "/".join(out)


def _parse_head(head):
    """(method, target, headers) from a request head, or raise _BadRequest."""
    lines = head.decode("latin-1").split("\r\n")
    request_line = lines[0].split(" ")
    if len(request_line) < 2 or not request_line[0] or not request_line[1]:
        raise _BadRequest()
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            raise _BadRequest()
        name, _, value = line.partition(":")
        if not name or name != name.rstrip():
            raise _BadRequest()
        key = name.lower()
        if key in ("content-length", "transfer-encoding") and key in headers:
            raise _BadRequest()
        headers[key] = value.strip()
    return request_line[0].upper(), request_line[1], headers


class _MjpegClient:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.chunked = False
        self.started = False
        self.terminated = False

    def finish_chunked(self):
        """Write the chunked-body terminator once (only ever on FakeWDA.stop())."""
        with self.lock:
            if not (self.chunked and self.started) or self.terminated:
                return
            self.terminated = True
            try:
                self.sock.sendall(b"0\r\n\r\n")
            except OSError:
                pass


# ---------------------------------------------------------------------------
# The fake server
# ---------------------------------------------------------------------------

class FakeWDA:
    """The fake WebDriverAgent. Use as a context manager or call start()/stop().

    Device-model attributes are guarded by `self.lock` (an RLock); tests may also set
    them directly. Normal routes run one at a time (WDA's main queue); `/status`,
    `/screenshot` and `DELETE /session/:sid` bypass that queue.
    """

    def __init__(self, apps=None, foreground=None, size=DEFAULT_SIZE, scale=DEFAULT_SCALE, mjpeg=False,
                 mjpeg_fps=10, mjpeg_mode="normal"):
        self.lock = threading.RLock()
        self._queue_lock = threading.Lock()
        self._conn_lock = threading.Lock()
        self.size = (size[0], size[1])
        self.scale = scale
        if apps is None:
            apps = [settings_app(self.size), springboard_app(self.size), form_app(self.size)]
        self.apps = collections.OrderedDict((app.bundle_id, app) for app in apps)
        if foreground is None:
            foreground = next(iter(self.apps)) if self.apps else SPRINGBOARD
        self.foreground = foreground
        self.locked = False
        self.status_ready = True
        self.foreground_sequence = []
        self.rich_elements = True
        self.root_attributes = True
        self.wrapper_root = None
        self.home_effective = True
        self.activate_effective = True
        self.settings = dict(SETTINGS_DEFAULTS)
        self.settings_history = []
        self.active_sid = None
        self.taps = []
        self.drags = []
        self.typed = []
        self.submits = []
        self.buttons = []
        self.on_drag = None
        self.handler_errors = []
        self.requests = []
        self.mjpeg = bool(mjpeg)
        self.mjpeg_fps = mjpeg_fps
        _parse_mjpeg_mode(mjpeg_mode)  # fail fast on a typo
        self.mjpeg_mode = mjpeg_mode
        self.mjpeg_frames = None
        self.mjpeg_requests = []
        self.port = None
        self.mjpeg_port = None
        self._screenshot_png = None
        self._screenshot_cache = (None, None)
        self._issued = set()
        self._injections = []
        self._empty_roots = {}
        self._stopping = threading.Event()
        self._listeners = []
        self._threads = []
        self._connections = set()
        self._mjpeg_clients = {}

    # --- lifecycle -----------------------------------------------------------

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def start(self):
        if self._listeners:
            return self
        self._stopping.clear()
        listener = self._listen()
        self.port = listener.getsockname()[1]
        self._listeners.append(listener)
        self._spawn(self._accept_loop, listener, self._serve_connection)
        if self.mjpeg:
            mjpeg_listener = self._listen()
            self.mjpeg_port = mjpeg_listener.getsockname()[1]
            self._listeners.append(mjpeg_listener)
            self._spawn(self._accept_loop, mjpeg_listener, self._serve_mjpeg)
        return self

    def stop(self):
        self._stopping.set()
        for listener in self._listeners:
            try:
                listener.close()
            except OSError:
                pass
        self._listeners = []
        with self._conn_lock:
            connections = list(self._connections)
            mjpeg_clients = list(self._mjpeg_clients.values())
        for client in mjpeg_clients:
            client.finish_chunked()
        for connection in connections:
            self._abort(connection)
        deadline = _monotonic() + 2.0
        with self._conn_lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(max(0.0, deadline - _monotonic()))
        with self._conn_lock:
            self._threads = [thread for thread in self._threads if thread.is_alive()]

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc_info):
        self.stop()

    def _listen(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(64)
        listener.settimeout(0.05)
        return listener

    def _spawn(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        with self._conn_lock:
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(thread)
        thread.start()

    def _accept_loop(self, listener, handler):
        while not self._stopping.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            connection.settimeout(None)
            try:
                connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            with self._conn_lock:
                if self._stopping.is_set():
                    connection.close()
                    return
                self._connections.add(connection)
            self._spawn(handler, connection)

    def _abort(self, connection):
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            connection.close()
        except OSError:
            pass

    def _forget(self, connection):
        with self._conn_lock:
            self._connections.discard(connection)
            self._mjpeg_clients.pop(connection, None)
        try:
            connection.close()
        except OSError:
            pass

    # --- log -----------------------------------------------------------------

    def calls(self, route=None, method=None):
        with self.lock:
            requests = list(self.requests)
        return [r for r in requests
                if (route is None or r.route == route) and (method is None or r.method == method.upper())]

    def routes(self):
        with self.lock:
            return [request.method + " " + request.route for request in self.requests]

    def actions(self):
        """The phone mutations: POST requests except element lookups, settings and session creation."""
        with self.lock:
            return [r for r in self.requests if r.method == "POST" and r.route not in _NOT_ACTIONS]

    def clear_log(self):
        with self.lock:
            del self.requests[:]

    # --- scenario helpers ----------------------------------------------------

    def app(self, bundle_id):
        with self.lock:
            return self.apps[bundle_id]

    def set_foreground(self, bundle_id):
        with self.lock:
            if bundle_id not in self.apps:
                raise KeyError("app not installed in the fake: %s" % bundle_id)
            self.foreground = bundle_id

    def set_tree(self, bundle_id, root):
        with self.lock:
            app = self.apps.get(bundle_id)
            if app is None:
                self.apps[bundle_id] = App(bundle_id, root)
            else:
                app.root = root
                app.pages = None
                app.page = 0

    def set_pages(self, bundle_id, roots):
        roots = list(roots)
        with self.lock:
            app = self.apps.get(bundle_id)
            if app is None:
                app = self.apps[bundle_id] = App(bundle_id, roots[0])
            app.pages = roots
            app.page = 0
            app.root = roots[0]

    def focused_node(self):
        with self.lock:
            for node in self._root().walk():
                if node.focused:
                    return node
        return None

    def node(self, label=None, name=None, type=None):
        with self.lock:
            return self._root().find(label=label, type=type, name=name)

    def invalidate_session(self):
        """Another client created a session: our sid dies, settings and element ids reset."""
        with self.lock:
            self.active_sid = str(uuid.uuid4()).upper()
            self._issued.clear()
            self.settings = dict(SETTINGS_DEFAULTS)

    def inject(self, method, route, status=None, error=None, message=None, value=_UNSET, delay=0.0, drop=False,
               execute=False, raw=None, times=1):
        """Change how the next `times` matching requests (None = all) are answered.

        method/route match the logged Request (None matches anything). delay: wait first
        (holding the command queue for normal routes). error: a WDA error body, HTTP
        status from the error table unless `status` is given. status alone: that status
        with {"value": value}. drop: close the connection without answering. raw: these
        bytes are the whole 200 body. value alone: the command runs and its value is
        replaced. With error/status/raw/drop the command does not run unless execute=True
        ("executed but the answer was lost").
        """
        rule = _Injection(method, route, status, error, message, value, delay, drop, execute, raw, times)
        with self.lock:
            self._injections.append(rule)
        return self

    @property
    def screenshot_png(self):
        with self.lock:
            if self._screenshot_png is not None:
                return self._screenshot_png
            key = (self.size, self.scale)
            if self._screenshot_cache[0] != key:
                width = int(round(self.size[0] * self.scale))
                height = int(round(self.size[1] * self.scale))
                self._screenshot_cache = (key, solid_png(width, height))
            return self._screenshot_cache[1]

    @screenshot_png.setter
    def screenshot_png(self, data):
        with self.lock:
            self._screenshot_png = data

    def mjpeg_clients(self):
        with self._conn_lock:
            return len(self._mjpeg_clients)

    # --- device model internals ----------------------------------------------

    def _foreground_app(self):
        return self.apps.get(self.foreground)

    def _root(self):
        app = self._foreground_app()
        if app is not None:
            return app.root
        root = self._empty_roots.get(self.foreground)
        if root is None:
            root = self._empty_roots[self.foreground] = Node("Application", label=None)
        return root

    def _rect_of(self, node, root=None):
        root = root if root is not None else self._root()
        if node is root and all(float(v) == 0 for v in node.rect):
            return (0, 0, self.size[0], self.size[1])
        return node.rect

    def _focus(self, node):
        for other in self._root().walk():
            other.focused = False
        node.focused = True

    def _issue(self, node):
        self._issued.add(node.id)
        return self._item(node)

    def _item(self, node):
        item = {ELEMENT_KEY: node.id, "ELEMENT": node.id}
        if self.settings.get("shouldUseCompactResponses", True) or not self.rich_elements:
            return item
        wanted = str(self.settings.get("elementResponseAttributes") or "")
        for attribute in (part.strip() for part in wanted.split(",")):
            if attribute == "type":
                item["type"] = node.type
            elif attribute == "label":
                item["label"] = node.wd_label
            elif attribute == "name":
                item["name"] = node.type  # WDA's "name" is the W3C tag name, i.e. the type
            elif attribute == "text":
                item["text"] = node.wd_value or node.wd_label or None
            elif attribute == "rect":
                item["rect"] = self._rect_dict(node)
            elif attribute == "enabled":
                item["enabled"] = node.enabled
            elif attribute == "displayed":
                item["displayed"] = node.visible
            elif attribute == "selected":
                item["selected"] = False
            elif attribute.startswith("attribute/"):
                try:
                    item[attribute] = self._attribute(node, attribute[len("attribute/"):])
                except _Fault:
                    pass
        return item

    def _rect_dict(self, node):
        x, y, w, h = _integral_rect(self._rect_of(node))
        return {"x": x, "y": y, "width": w, "height": h}

    def _attribute(self, node, name):
        if name == "hittable":
            return node.hittable
        if name == "type":
            return node.type
        if name == "value":
            return node.wd_value
        if name == "name":
            return node.wd_name
        if name == "label":
            return node.wd_label
        if name == "enabled":
            return node.enabled
        if name == "visible":
            return node.visible
        if name == "placeholderValue":
            return node.placeholder
        if name == "accessible":
            return node.is_accessible
        if name == "focused":
            return node.focused
        raise _Fault("unknown error", "The attribute '%s' is unknown. Valid attribute names are: (hittable, "
                                      "type, value, name, label, enabled, visible, placeholderValue, accessible, "
                                      "focused)" % name)

    def _node_by_id(self, element_id):
        if element_id not in self._issued:
            raise _Fault("stale element reference",
                         'The element identified by "%s" is either not present or it has expired from the '
                         "internal cache. Try to find it again" % element_id)
        for node in self._root().walk():
            if node.id == element_id:
                return node
        raise _Fault("stale element reference",
                     'The previously found element "%s" is not present in the current view anymore. Make sure '
                     "the application UI has the expected state" % element_id)

    def _search(self, root, body):
        if not isinstance(body, dict):
            raise _Fault("invalid argument", "The request body must be a JSON object")
        using = body.get("using")
        value = body.get("value")
        if not isinstance(using, str) or not isinstance(value, str):
            raise _Fault("invalid argument", "Both 'using' and 'value' must be strings")
        if using == "predicate string":
            try:
                matches = compile_predicate(value)
            except PredicateSyntaxError:
                raise _Fault("unknown error", 'Unable to parse the format string "%s"' % value) from None
            except PredicateAttributeError as exc:
                raise _Fault("unknown error", "The attribute '%s' is unknown. Valid attribute names are: (%s)"
                             % (exc.attribute, ", ".join(sorted(PREDICATE_ATTRIBUTES)))) from None
            return [node for node in root.walk() if matches(node)]
        if using == "class name":
            if not value.startswith(TYPE_PREFIX):
                raise _Fault("invalid argument", "Invalid argument for class used '%s'. Did you mean %s%s?"
                             % (value, TYPE_PREFIX, value))
            return [node for node in root.walk() if node.type == value]
        if using in ("accessibility id", "id", "name"):
            return [node for node in root.walk() if node.wd_name == value]
        raise _Fault("invalid argument", "Invalid locator requested: %s" % using)

    def _type_into(self, node, text):
        current = node.value if isinstance(node.value, str) else ""
        single_line = node.type != TEXT_VIEW
        for index, piece in enumerate(text.split("\n")):
            if index > 0:
                if single_line:
                    self.submits.append(current)
                else:
                    current += "\n"
            current += piece
        node.value = current

    def _hit_test(self, x, y):
        root = self._root()
        hits = []
        order = 0
        stack = [(root, 0)]
        while stack:
            node, depth = stack.pop()
            rx, ry, rw, rh = (float(v) for v in self._rect_of(node, root))
            if node.visible and rw > 0 and rh > 0 and rx <= x < rx + rw and ry <= y < ry + rh:
                hits.append((depth, order, node))
            order += 1
            stack.extend((child, depth + 1) for child in reversed(node.children))
        for _, _, node in sorted(hits, key=lambda hit: (hit[0], hit[1]), reverse=True):
            if node.on_tap is not None:
                node.on_tap(self, node)
                return node
            if node.type in TEXT_INPUT_TYPES:
                self._focus(node)
                return node
        return None

    # --- XML -----------------------------------------------------------------

    def source_xml(self, excluded=(), wrapper=None):
        """The foreground tree serialized exactly like WDA's `/source?format=xml`."""
        with self.lock:
            excluded = {name.lower() for name in excluded}
            app = self._foreground_app()
            root = self._root()
            max_depth = self.settings.get("snapshotMaxDepth", 50)
            if not isinstance(max_depth, int) or isinstance(max_depth, bool) or max_depth < 0:
                max_depth = 50
            lines = []
            depth = 0
            if wrapper:
                lines.append("<%s>" % wrapper)
                depth = 1
            self._write_xml(root, root, app, 0, depth, depth, max_depth, excluded, lines)
            if wrapper:
                lines.append("</%s>" % wrapper)
            return '<?xml version="1.0" encoding="UTF-8"?>\n' + "\n".join(lines) + "\n"

    def _xml_attributes(self, node, root, app, index, excluded):
        attributes = [("type", node.type)]
        value = node.wd_value
        if value:
            attributes.append(("value", value))
        name = node.wd_name
        if name:
            attributes.append(("name", name))
        label = node.wd_label
        if label or node.type in ALWAYS_LABELLED:
            attributes.append(("label", label or ""))
        attributes.append(("enabled", _bool_text(node.enabled)))
        attributes.append(("visible", _bool_text(node.visible)))
        attributes.append(("accessible", _bool_text(node.is_accessible)))
        x, y, w, h = _integral_rect(self._rect_of(node, root))
        attributes.extend([("x", str(x)), ("y", str(y)), ("width", str(w)), ("height", str(h))])
        attributes.append(("index", str(index)))
        if node.type in TEXT_INPUT_TYPES and node.placeholder is not None:
            attributes.append(("placeholderValue", node.placeholder))
        attributes.append(("traits", node.trait_text))
        attributes = [(key, text) for key, text in attributes if key == "type" or key.lower() not in excluded]
        if node is root and node.type == APPLICATION and self.root_attributes:
            attributes.append(("processId", str(app.pid if app is not None else 0)))
            attributes.append(("bundleId", app.bundle_id if app is not None else str(self.foreground)))
        return " ".join('%s="%s"' % (key, xml_attribute(text)) for key, text in attributes)

    def _write_xml(self, node, root, app, index, depth, base, max_depth, excluded, lines):
        indent = "  " * depth
        attributes = self._xml_attributes(node, root, app, index, excluded)
        children = node.children if depth - base < max_depth else []
        if not children:
            lines.append("%s<%s %s/>" % (indent, node.type, attributes))
            return
        lines.append("%s<%s %s>" % (indent, node.type, attributes))
        for child_index, child in enumerate(children):
            self._write_xml(child, root, app, child_index, depth + 1, base, max_depth, excluded, lines)
        lines.append("%s</%s>" % (indent, node.type))

    def _json_tree(self, node, root):
        x, y, w, h = _integral_rect(self._rect_of(node, root))
        tree = {"type": node.type[len(TYPE_PREFIX):] if node.type.startswith(TYPE_PREFIX) else node.type,
                "rawIdentifier": node.name, "name": node.wd_name, "value": node.wd_value, "label": node.wd_label,
                "rect": {"x": x, "y": y, "width": w, "height": h},
                "frame": "{{%s, %s}, {%s, %s}}" % (x, y, w, h),
                "isEnabled": "1" if node.enabled else "0", "isVisible": "1" if node.visible else "0",
                "isAccessible": "1" if node.is_accessible else "0"}
        if node.children:
            tree["children"] = [self._json_tree(child, root) for child in node.children]
        return tree

    # --- connection handling -------------------------------------------------

    def _serve_connection(self, connection):
        pending = b""
        try:
            while not self._stopping.is_set():
                while b"\r\n\r\n" not in pending:
                    if len(pending) > MAX_HEADER_BYTES:
                        self._send(connection, self._error(400, "invalid argument",
                                                           "The request headers are too large", close=True))
                        return
                    chunk = connection.recv(65536)
                    if not chunk:
                        return
                    pending += chunk
                head, pending = pending.split(b"\r\n\r\n", 1)
                try:
                    method, target, headers = _parse_head(head)
                    length = headers.get("content-length")
                    if length is not None and not re.fullmatch(r"[0-9]+", length):
                        raise _BadRequest()
                except _BadRequest:
                    self._send(connection, self._error(400, "invalid argument",
                                                       "The request could not be parsed as valid HTTP", close=True))
                    return
                if "transfer-encoding" in headers:
                    self._record(method, target, None)
                    self._send(connection, self._error(400, "invalid argument", "Transfer-Encoding is not supported",
                                                       close=True))
                    return
                length = int(length or 0)
                if length > MAX_BODY_BYTES:
                    self._send(connection, self._error(400, "invalid argument",
                                                       "The request body exceeds the configured size limit",
                                                       close=True))
                    return
                while len(pending) < length:
                    chunk = connection.recv(65536)
                    if not chunk:
                        return
                    pending += chunk
                body, pending = pending[:length], pending[length:]
                close = headers.get("connection", "").lower() == "close"
                if not self._dispatch(connection, method, target, body, close):
                    return
                if close:
                    return
        except OSError:
            return
        finally:
            self._forget(connection)

    def _record(self, method, target, body):
        split = urlsplit(target)
        path = split.path
        query = dict(parse_qsl(split.query, keep_blank_values=True))
        match = _SESSION_PATH.match(path)
        if match and match.group(2):
            sid, inner, scope = match.group(1), match.group(2), "S"
            route = _route_of(inner)
        elif match:
            sid, inner, scope = match.group(1), path, "SID"
            route = "/session/:sid"
        else:
            sid, inner, scope = None, path, "N"
            route = _route_of(inner)
        request = Request(method, path, route, query, body, sid)
        with self.lock:
            self.requests.append(request)
        return request, inner, scope

    def _match(self, method, inner, scope):
        if scope == "SID":
            for route_method, pattern, scopes, handler, standalone in _ROUTES:
                if scopes == "SID" and route_method == method:
                    return handler, standalone, ()
            return None
        for route_method, pattern, scopes, handler, standalone in _COMPILED_ROUTES:
            if route_method != method or scope not in scopes:
                continue
            found = pattern.fullmatch(inner)
            if found:
                return handler, standalone, found.groups()
        return None

    def _take_injection(self, request):
        with self.lock:
            for rule in self._injections:
                if rule.matches(request):
                    if rule.remaining is not None:
                        rule.remaining -= 1
                    self._injections = [r for r in self._injections if r.remaining is None or r.remaining > 0]
                    return rule
        return None

    def _dispatch(self, connection, method, target, body_bytes, close):
        """Answer one request; returns False when the connection must be closed."""
        body = None
        if body_bytes:
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                body = None
        request, inner, scope = self._record(method, target, body)
        if method == "OPTIONS":
            return self._send(connection, self._json(200, None, close))
        found = self._match(method, inner, scope)
        if found is None:
            message = "Unhandled endpoint: %s with parameters %s" % (
                request.path, json.dumps(body if isinstance(body, dict) else {}, sort_keys=True))
            return self._send(connection, self._error(404, "unknown command", message, close))
        handler_name, standalone, params = found
        if scope == "SID":
            params = (request.sid,)
        with self.lock:
            stale = scope == "S" and request.sid != self.active_sid
        if stale:
            return self._send(connection, self._error(404, "invalid session id", "Session does not exist", close))
        rule = self._take_injection(request)
        queue = None if standalone else self._queue_lock
        if queue is not None:
            queue.acquire()
        try:
            if rule is not None and rule.delay > 0:
                self._stopping.wait(rule.delay)
            if self._stopping.is_set():
                return False
            handler = getattr(self, handler_name)
            arguments = body if isinstance(body, dict) else {}
            with self.lock:
                if scope == "S" and request.sid != self.active_sid:
                    response = self._error(404, "invalid session id", "Session %s was deleted while this request "
                                           "was still pending" % request.sid, close)
                    return self._send(connection, response)
                if rule is not None and rule.replaces_response:
                    if rule.execute:
                        self._run(handler, params, request.query, arguments, body)
                    if rule.drop:
                        self._abort(connection)
                        return False
                    response = self._injected(rule, close)
                else:
                    outcome = self._run(handler, params, request.query, arguments, body)
                    if rule is not None and rule.value is not _UNSET:
                        outcome = rule.value
                    response = self._response(outcome, close)
            return self._send(connection, response)
        finally:
            if queue is not None:
                queue.release()

    def _run(self, handler, params, query, arguments, body):
        if body is not None and not isinstance(body, dict):
            return _Fault("unknown error", "The request body must be a JSON object, not %s" % type(body).__name__)
        try:
            return handler(params, query, arguments)
        except _Fault as fault:
            return fault
        except Exception as exc:  # e.g. a test's on_tap callback failed: answer like WDA, never print
            self.handler_errors.append(exc)
            return _Fault("unknown error", "FakeWDA handler raised %s: %s" % (type(exc).__name__, exc))

    def _response(self, outcome, close):
        if isinstance(outcome, _Fault):
            return self._error(outcome.status, outcome.code, outcome.message, close)
        if isinstance(outcome, _Raw):
            return self._http(outcome.status, outcome.payload, outcome.content_type, close)
        return self._json(200, outcome, close)

    def _injected(self, rule, close):
        if rule.raw is not None:
            return self._http(200, bytes(rule.raw), JSON_CONTENT_TYPE, close)
        if rule.error is not None:
            status = rule.status if rule.status is not None else ERROR_STATUS.get(rule.error, 500)
            message = rule.message if rule.message is not None else ERROR_MESSAGES.get(rule.error, rule.error)
            return self._error(status, rule.error, message, close)
        value = None if rule.value is _UNSET else rule.value
        return self._json(rule.status, value, close)

    def _http(self, status, payload, content_type=None, close=False):
        lines = ["HTTP/1.1 %d %s" % (status, REASONS.get(status, "Status")),
                 "Server: WebDriverAgent/1.0",
                 "Access-Control-Allow-Origin: *",
                 "Access-Control-Allow-Headers: Content-Type, X-Requested-With"]
        if content_type:
            lines.append("Content-Type: " + content_type)
        lines.append("Content-Length: %d" % len(payload))
        if close:
            lines.append("Connection: close")
        return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + payload, close

    def _json(self, status, value, close=False):
        with self.lock:
            envelope = {"value": value, "sessionId": self.active_sid}
        payload = json.dumps(envelope, indent=2, ensure_ascii=False, separators=(",", " : ")).encode("utf-8")
        return self._http(status, payload, JSON_CONTENT_TYPE, close)

    def _error(self, status, code, message, close=False):
        return self._json(status, {"error": code, "message": message, "traceback": ""}, close)

    def _send(self, connection, response):
        data, close = response
        try:
            connection.sendall(data)
        except OSError:
            return False
        return not close

    # --- handlers: sessions and settings ---------------------------------------

    def _status(self, params, query, body):
        return {"ready": self.status_ready,
                "message": "WebDriverAgent is ready to accept commands",
                "state": "success",
                "os": {"name": "iOS", "version": IOS_VERSION, "sdkVersion": IOS_VERSION, "testmanagerdVersion": 34},
                "ios": {"ip": None},
                "build": {"time": "Oct  8 2026 10:12:44",
                          "productBundleIdentifier": "com.facebook.WebDriverAgentRunner",
                          "version": WDA_VERSION},
                "device": "iphone"}

    def _create_session(self, params, query, body):
        self.active_sid = None  # the old session dies first, even if creation then fails
        self._issued.clear()
        capabilities = body.get("capabilities")
        if not isinstance(capabilities, dict):
            raise _Fault("session not created", "'capabilities' is mandatory to create a new session")
        merged = {}
        always = capabilities.get("alwaysMatch")
        if isinstance(always, dict):
            merged.update(always)
        first = capabilities.get("firstMatch")
        if isinstance(first, list) and first and isinstance(first[0], dict):
            merged.update(first[0])
        merged = {(key[len("appium:"):] if key.startswith("appium:") else key): value
                  for key, value in merged.items()}
        self.settings = dict(SETTINGS_DEFAULTS)
        for key in CAPABILITY_SETTINGS:
            if merged.get(key) is not None:
                self.settings[key] = merged[key]
        self.active_sid = str(uuid.uuid4()).upper()
        return {"sessionId": self.active_sid, "capabilities": {"device": "iphone", "sdkVersion": IOS_VERSION}}

    def _get_session(self, params, query, body):
        if params[0] != self.active_sid:
            raise _Fault("invalid session id", "Session does not exist")
        return {"sessionId": self.active_sid, "capabilities": {"device": "iphone", "sdkVersion": IOS_VERSION}}

    def _delete_session(self, params, query, body):
        if params[0] != self.active_sid:
            raise _Fault("invalid session id", "Session does not exist")
        self.active_sid = None
        self._issued.clear()
        return None

    def _post_settings(self, params, query, body):
        settings = body.get("settings", {})
        if not isinstance(settings, dict):
            raise _Fault("invalid argument", "settings must be a dictionary")
        self.settings_history.append(dict(settings))
        for key, value in settings.items():
            if value is not None:
                self.settings[key] = value
        return dict(self.settings)

    def _get_settings(self, params, query, body):
        return dict(self.settings)

    # --- handlers: device state ------------------------------------------------

    def _health(self, params, query, body):
        return _Raw(200, HEALTH_PAGE)

    def _healthcheck(self, params, query, body):
        return None

    def _unlock(self, params, query, body):
        return None

    def _source(self, params, query, body):
        fmt = query.get("format", "xml").lower()
        excluded = [part.strip() for part in query.get("excluded_attributes", "").split(",") if part.strip()]
        wrapper = query.get("scope") or self.wrapper_root
        if fmt == "xml":
            return self.source_xml(excluded, wrapper)
        root = self._root()
        if fmt == "json":
            return self._json_tree(root, root)
        if fmt == "description":
            return "\n".join("%s, {{%s}}, label: '%s'" % (node.type, ", ".join(str(v) for v in node.rect),
                                                         node.wd_label or "") for node in root.walk())
        raise _Fault("invalid argument", "Unknown source format '%s'. Only (xml, json, description) source "
                                         "formats are supported." % fmt)

    def _screenshot(self, params, query, body):
        return base64.b64encode(self.screenshot_png).decode("ascii")

    def _window_size(self, params, query, body):
        return {"width": _number(self.size[0]), "height": _number(self.size[1])}

    def _active_app_info(self, params, query, body):
        if self.foreground_sequence:
            if len(self.foreground_sequence) > 1:
                bundle_id = self.foreground_sequence.pop(0)
            else:
                bundle_id = self.foreground_sequence[0]
        else:
            bundle_id = self.foreground
        app = self.apps.get(bundle_id)
        return {"pid": app.pid if app is not None else 0, "bundleId": bundle_id, "name": "",
                "processArguments": {}}

    def _locked(self, params, query, body):
        return bool(self.locked)

    def _screen(self, params, query, body):
        width, height = (_number(v) for v in self.size)
        return {"screenSize": {"width": width, "height": height},
                "statusBarSize": {"width": width, "height": 47}, "displayId": 1, "scale": self.scale}

    # --- handlers: elements ----------------------------------------------------

    def _find_elements(self, params, query, body):
        return [self._issue(node) for node in self._search(self._root(), body)]

    def _find_element(self, params, query, body):
        matches = self._search(self._root(), body)
        if not matches:
            raise _Fault("no such element", "unable to find an element using '%s', value '%s'"
                         % (body.get("using"), body.get("value")))
        return self._issue(matches[0])

    def _find_child_elements(self, params, query, body):
        return [self._issue(node) for node in self._search(self._node_by_id(params[0]), body)]

    def _find_child_element(self, params, query, body):
        matches = self._search(self._node_by_id(params[0]), body)
        if not matches:
            raise _Fault("no such element", "unable to find an element using '%s', value '%s'"
                         % (body.get("using"), body.get("value")))
        return self._issue(matches[0])

    def _active_element(self, params, query, body):
        for node in self._root().walk():
            if node.focused:
                return self._issue(node)
        raise _Fault("no such element", "unable to find an element using '(null)', value '(null)'")

    def _element_rect(self, params, query, body):
        return self._rect_dict(self._node_by_id(params[0]))

    def _element_attribute(self, params, query, body):
        return self._attribute(self._node_by_id(params[0]), params[1])

    def _element_text(self, params, query, body):
        node = self._node_by_id(params[0])
        return node.wd_value or node.wd_label or ""

    def _element_enabled(self, params, query, body):
        return self._node_by_id(params[0]).enabled

    def _element_displayed(self, params, query, body):
        return self._node_by_id(params[0]).visible

    def _element_tag(self, params, query, body):
        return self._node_by_id(params[0]).type

    def _click(self, params, query, body):
        node = self._node_by_id(params[0])
        if node.on_tap is not None:
            node.on_tap(self, node)
        elif node.type in TEXT_INPUT_TYPES:
            self._focus(node)
        return None

    def _clear(self, params, query, body):
        node = self._node_by_id(params[0])
        if node.type in TEXT_INPUT_TYPES:
            self._focus(node)
            node.value = None
        return None

    def _set_value(self, params, query, body):
        node = self._node_by_id(params[0])
        value = body.get("value")
        if isinstance(value, list):
            text = "".join(str(part) for part in value)
        elif isinstance(value, str):
            text = value
        elif isinstance(body.get("text"), str):
            text = body["text"]
        else:
            raise _Fault("invalid argument", "Neither 'value' nor 'text' parameter is provided")
        self._focus(node)
        self.typed.append(text)
        self._type_into(node, text)
        return None

    # --- handlers: gestures, keys, buttons, apps --------------------------------

    def _keys(self, params, query, body):
        value = body.get("value")
        if not isinstance(value, list):
            raise _Fault("unknown error", "-[__NSCFString componentsJoinedByString:]: unrecognized selector sent "
                                          "to instance")
        text = "".join(str(part) for part in value)
        self.typed.append(text)
        for node in self._root().walk():
            if node.focused:
                self._type_into(node, text)
                break
        return None

    def _tap(self, params, query, body):
        has_x = body.get("x") is not None
        has_y = body.get("y") is not None
        if has_x != has_y:
            raise _Fault("invalid argument", "Both x and y coordinates must be provided")
        if has_x:
            x, y = body["x"], body["y"]
            for number in (x, y):
                if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                    raise _Fault("invalid argument", "Coordinates must be numbers")
        else:
            x, y = self.size[0] / 2, self.size[1] / 2
        self.taps.append((x, y))
        self._hit_test(float(x), float(y))
        return None

    def _drag(self, params, query, body):
        drag = {}
        for key in ("fromX", "fromY", "toX", "toY", "duration"):
            number = body.get(key)
            number = 0 if number is None else number
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                raise _Fault("invalid argument", "Drag coordinates and durations must be finite numbers")
            drag[key] = number
        if drag["duration"] < 0:
            raise _Fault("invalid argument", "Drag press and hold durations must be non-negative numbers of seconds")
        self.drags.append(drag)
        app = self._foreground_app()
        if app is not None and app.pages:
            app.page = min(app.page + 1, len(app.pages) - 1)
            app.root = app.pages[app.page]
        if self.on_drag is not None:
            self.on_drag(self, drag)
        return None

    def _press_button(self, params, query, body):
        name = body.get("name")
        lowered = name.lower() if isinstance(name, str) else name
        if lowered not in SUPPORTED_BUTTONS:
            raise _Fault("unknown error",
                         'Error Domain=com.facebook.WebDriverAgent Code=1 "The button \'%s\' is not supported. The '
                         'device under test only supports the following buttons: (\n    home,\n    volumedown,\n'
                         '    volumeup\n)" UserInfo={}' % (name,))
        self.buttons.append(lowered)
        if lowered == "home" and self.home_effective:
            self.foreground = SPRINGBOARD
        return None

    def _homescreen(self, params, query, body):
        if self.home_effective:
            self.foreground = SPRINGBOARD
        return None

    def _bundle(self, body):
        bundle_id = body.get("bundleId")
        if not isinstance(bundle_id, str) or not bundle_id:
            raise _Fault("unknown error", "*** -[NSProxy doesNotRecognizeSelector:]: bundleId is required")
        return bundle_id

    def _require_installed(self, bundle_id):
        if bundle_id not in self.apps:
            raise _Fault("invalid argument", "The application '%s' is not installed on the device under test"
                         % bundle_id)

    def _activate(self, params, query, body):
        bundle_id = self._bundle(body)
        self._require_installed(bundle_id)
        if self.activate_effective:
            self.foreground = bundle_id
        return None

    def _terminate(self, params, query, body):
        bundle_id = self._bundle(body)
        self._require_installed(bundle_id)
        if bundle_id == self.foreground:
            self.foreground = SPRINGBOARD
            return True
        return False

    def _app_state(self, params, query, body):
        bundle_id = self._bundle(body)
        if bundle_id == self.foreground:
            return 4
        return 3 if bundle_id in self.apps else 1

    # --- MJPEG -----------------------------------------------------------------

    def _mjpeg_wait(self, client, seconds):
        """Wait up to `seconds`; True when the client closed or the fake is stopping."""
        deadline = _monotonic() + seconds
        while True:
            if self._stopping.is_set():
                return True
            remaining = deadline - _monotonic()
            if remaining <= 0:
                return False
            readable, _, _ = select.select([client.sock], [], [], min(remaining, 0.05))
            if readable:
                data = client.sock.recv(65536)  # later request bytes are ignored, like WDA
                if not data:
                    return True

    def _mjpeg_write(self, client, data, split):
        if client.chunked:
            data = chunk_bytes(data)
        pieces = [data[i:i + MJPEG_PIECE] for i in range(0, len(data), MJPEG_PIECE)] if split else [data]
        with client.lock:
            for piece in pieces:
                client.sock.sendall(piece)

    def _serve_mjpeg(self, connection):
        client = _MjpegClient(connection)
        with self._conn_lock:
            self._mjpeg_clients[connection] = client
        try:
            while True:  # WDA sends nothing until the client sends something
                readable, _, _ = select.select([connection], [], [], 0.05)
                if self._stopping.is_set():
                    return
                if readable:
                    break
            first = connection.recv(65536)
            if not first:
                return
            with self.lock:
                self.mjpeg_requests.append(first)
            kind, count = _parse_mjpeg_mode(self.mjpeg_mode)
            if kind == "silent":
                while not self._mjpeg_wait(client, 1.0):
                    pass
                return
            split = kind == "split"
            with client.lock:
                if kind == "chunked":
                    connection.sendall(MJPEG_CHUNKED_HEADER)
                    client.chunked = True
                else:
                    self._send_pieces(connection, MJPEG_HEADER, split)
                client.started = True
            if kind == "garbage":
                self._mjpeg_write(client, MJPEG_GARBAGE, False)
            fps = self.mjpeg_fps if self.mjpeg_fps and self.mjpeg_fps > 0 else 10
            interval = 1.0 / fps
            sent = 0
            while not self._stopping.is_set():
                if kind == "close_after" and sent >= count:
                    self._abort(connection)
                    return
                if kind == "stall_after" and sent >= count:
                    while not self._mjpeg_wait(client, 1.0):
                        pass
                    return
                frames = list(self.mjpeg_frames or [TINY_JPEG])
                self._mjpeg_write(client, mjpeg_part(frames[sent % len(frames)]), split)
                sent += 1
                if self._mjpeg_wait(client, interval):
                    return
        except (OSError, ValueError):
            return
        finally:
            if self._stopping.is_set():
                client.finish_chunked()
            self._forget(connection)

    @staticmethod
    def _send_pieces(connection, data, split):
        if not split:
            connection.sendall(data)
            return
        for start in range(0, len(data), MJPEG_PIECE):
            connection.sendall(data[start:start + MJPEG_PIECE])
