#!/usr/bin/env python3
"""End-to-end smoke test of the iPhone Use MCP server against a real WebDriverAgent (CI on an iOS Simulator).

    python3 scripts/ci_sim_smoke.py [--wda-url http://127.0.0.1:8100] [--artifacts DIR] [--skip-guard-checks]

Starts server/iphone_use.py the way Claude Code does (newline-delimited JSON-RPC 2.0 over stdio) with a fresh
state folder and IPHONE_USE_WDA_URL, then works the Settings app through the plugin's own tools: iphone_ready,
iphone_observe, Home, iphone_apps, iphone_launch_app, iphone_find, iphone_tap, iphone_swipe, iphone_batch,
iphone_type_text with exact read-back and iphone_metrics. Targets come from the screen tree, not from one iOS
version's labels. Unless --skip-guard-checks is given it first checks the patched WebDriverAgent's browser guard
over plain HTTP (a simulator's WebDriverAgent shares the Mac's loopback address).

Every tool call is printed with its outcome and time. A failed check prints the whole result and saves it, with
a fresh screenshot of the screen, in the artifacts folder; every screenshot the tools return is saved there too,
next to smoke-results.json. Exit code 0 means every check passed. Stdlib only, Python 3.9+.
"""

import argparse
import base64
import binascii
import collections
import http.client
import json
import os
import pathlib
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(PLUGIN_ROOT, "server")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from wda_client import validate_loopback_url  # noqa: E402

SERVER_SCRIPT = os.path.join(SERVER_DIR, "iphone_use.py")
DEFAULT_WDA_URL = "http://127.0.0.1:8100"
PROTOCOL_VERSION = "2025-06-18"
HANDSHAKE_TIMEOUT = 30.0
CALL_TIMEOUT = 180.0  # one tool call; the first session on a cold simulator can be slow
EXIT_TIMEOUT = 30.0
GUARD_TIMEOUT = 10.0
SETTINGS = "com.apple.Preferences"
SPRINGBOARD = "com.apple.springboard"
PREFERRED_ROW = "General"
ROW_LABEL_LIMIT = 40
TYPED_TEXT = "Wi"
EVIL_ORIGIN = "https://evil.example"
IMAGE_MAGIC = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff"}
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg"}
REQUIRED_TOOLS = ("iphone_ready", "iphone_observe", "iphone_press_button", "iphone_apps", "iphone_launch_app",
                  "iphone_find", "iphone_tap", "iphone_swipe", "iphone_batch", "iphone_type_text", "iphone_metrics")

Image = collections.namedtuple("Image", "mime_type data")


class CheckFailed(Exception):
    """A smoke check failed; result is the MCP tool result that showed it, when there is one."""

    def __init__(self, message, result=None):
        super().__init__(message)
        self.result = result


class Skipped(Exception):
    """A check that needs what an earlier, failed check should have produced."""


# --- the MCP server over stdio ---------------------------------------------------------------------------


class McpServer:
    """server/iphone_use.py as a child process speaking newline-delimited JSON-RPC over stdio."""

    def __init__(self, env):
        self.process = subprocess.Popen([sys.executable, SERVER_SCRIPT], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=PLUGIN_ROOT)
        self.lines = queue.Queue()
        self.stderr_chunks = []
        self.next_id = 0
        self.closed = False
        self.hung = False
        self.readers = [threading.Thread(target=self._read_stdout, daemon=True),
                        threading.Thread(target=self._read_stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _read_stdout(self):
        try:
            for line in iter(self.process.stdout.readline, b""):
                self.lines.put(line)
        except (OSError, ValueError):
            pass
        self.lines.put(None)

    def _read_stderr(self):
        try:
            for chunk in iter(lambda: self.process.stderr.read(4096), b""):
                self.stderr_chunks.append(chunk)
        except (OSError, ValueError):
            pass

    def stderr(self) -> str:
        return b"".join(self.stderr_chunks).decode("utf-8", "replace")

    def alive(self) -> bool:
        """True while the server runs and answers."""
        return not self.closed and not self.hung and self.process.poll() is None

    def send(self, message):
        if self.hung:
            raise CheckFailed("The MCP server stopped answering earlier in this run.")
        try:
            self.process.stdin.write(json.dumps(message).encode("utf-8") + b"\n")
            self.process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise CheckFailed("The MCP server is not running (%s); stderr: %s" % (exc, self.stderr()[-2000:]))

    def notify(self, method, params=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)

    def request(self, method, params=None, timeout=CALL_TIMEOUT) -> dict:
        """Send one request and return its response message."""
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            self.hung = True  # it answers one call at a time, so every later call would wait behind this one
            raise CheckFailed("No answer to %s within %d s." % (method, timeout)) from None
        if line is None:
            raise CheckFailed("The MCP server closed its output; stderr: %s" % self.stderr()[-2000:])
        try:
            reply = json.loads(line.decode("utf-8"))
        except ValueError:
            raise CheckFailed("The MCP server wrote a line that is not JSON: %r" % line[:300]) from None
        if (not isinstance(reply, dict) or reply.get("id") != message["id"] or reply.get("jsonrpc") != "2.0"
                or len({"result", "error"} & set(reply)) != 1):
            raise CheckFailed("Unexpected JSON-RPC message for %s: %s" % (method, json.dumps(reply)[:500]))
        return reply

    def close(self, timeout=EXIT_TIMEOUT):
        """End stdin (as Claude Code does on exit) and wait; returns the exit code, or None when it was killed."""
        self.closed = True
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            code = self.process.wait(timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(10)
            code = None
        for reader in self.readers:
            reader.join(5)
        for stream in (self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass
        return code


# --- screen-tree helpers ---------------------------------------------------------------------------------


def nodes_of(observation) -> list:
    nodes = observation.get("nodes") if isinstance(observation, dict) else None
    return [node for node in nodes if isinstance(node, dict)] if isinstance(nodes, list) else []


def _rect(node):
    rect = node.get("rect")
    if isinstance(rect, list) and len(rect) == 4 and all(isinstance(value, (int, float)) for value in rect):
        return rect
    return None


def center(node) -> tuple:
    x, y, width, height = _rect(node)
    return round(x + width / 2), round(y + height / 2)


def find_node(nodes, kind):
    """The first node of this type with a usable rect, or None."""
    for node in nodes:
        if node.get("type") == kind and _rect(node) is not None:
            return node
    return None


def choose_row(nodes, viewport):
    """A row to open on the main Settings page: General when listed, else the first plainly labelled Cell (or
    Button row) wholly on screen below the navigation bar. Rows like the Apple Account sign-in are skipped."""
    height = viewport.get("height", 0) if isinstance(viewport, dict) else 0

    def plain_row(node):
        label, rect = node.get("label"), _rect(node)
        return (isinstance(label, str) and 0 < len(label) <= ROW_LABEL_LIMIT and "\n" not in label
                and not label.startswith("Sign in") and node.get("enabled", True) is not False
                and node.get("in_viewport", True) is not False and rect is not None
                and rect[1] >= height * 0.12 and rect[1] + rect[3] <= height)

    for kind in ("Cell", "Button"):
        rows = [node for node in nodes if node.get("type") == kind and plain_row(node)]
        preferred = [node for node in rows if node["label"] == PREFERRED_ROW]
        if preferred or rows:
            return (preferred or rows)[0]
    return None


def back_target(nodes, viewport):
    """What to tap to leave a pushed page: its top-left navigation button (the back button) or, when there is
    none, its first static text (a title; tapping it does nothing)."""
    width = viewport.get("width", 0) if isinstance(viewport, dict) else 0
    height = viewport.get("height", 0) if isinstance(viewport, dict) else 0
    for node in nodes:
        rect = _rect(node)
        if (node.get("type") == "Button" and rect is not None and rect[0] < width * 0.3 and rect[1] < height * 0.2
                and node.get("enabled", True) is not False):
            return node
    return find_node(nodes, "StaticText")


def layout(observation) -> list:
    """(type, label, rect) of every node: equal layouts mean nothing moved."""
    return [(node.get("type"), node.get("label"), tuple(_rect(node) or ())) for node in nodes_of(observation)]


# --- the browser guard -----------------------------------------------------------------------------------


def _get_status(host, port, headers, timeout):
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request("GET", "/status", headers=headers)
        response = connection.getresponse()
        response.read()
        return response.status, response.getheader("Access-Control-Allow-Origin")
    finally:
        connection.close()


def check_browser_guard(host, port, timeout=GUARD_TIMEOUT) -> list:
    """The patched WebDriverAgent's browser guard, over plain HTTP: a request with a loopback Host and no Origin
    is answered; a web page's request (Origin or Sec-Fetch-Site) or a DNS-rebinding one (a foreign Host) gets 400; no answer lets
    other sites read it (Access-Control-Allow-Origin). Returns the problems found, empty when all is well."""
    problems = []
    cases = (("no Origin", {}, 200),
             ("Origin: " + EVIL_ORIGIN, {"Origin": EVIL_ORIGIN}, 400),
             ("Host: evil.example:%d" % port, {"Host": "evil.example:%d" % port}, 400),
             ("Sec-Fetch-Site: cross-site", {"Sec-Fetch-Site": "cross-site"}, 400),
             ("Host: localhost:%d" % port, {"Host": "localhost:%d" % port}, 200))
    for title, headers, expected in cases:
        try:
            status, allow_origin = _get_status(host, port, headers, timeout)
        except (OSError, http.client.HTTPException) as exc:
            problems.append("GET /status with %s got no HTTP answer (%s)." % (title, str(exc) or type(exc).__name__))
            print("   GET /status with %-28s -> no answer (expected %d)" % (title, expected), flush=True)
            continue
        print("   GET /status with %-28s -> %d (expected %d)%s" % (
            title, status, expected, "" if allow_origin is None else ", Access-Control-Allow-Origin: " + allow_origin),
            flush=True)
        if status != expected:
            problems.append("GET /status with %s answered %d, expected %d." % (title, status, expected))
        if allow_origin is not None:
            problems.append("GET /status with %s allows other sites to read it (Access-Control-Allow-Origin: %s)."
                            % (title, allow_origin))
    return problems


# --- the checks ------------------------------------------------------------------------------------------


def _image_of(tool, block, result) -> Image:
    if not isinstance(block, dict) or block.get("type") != "image":
        raise CheckFailed("%s: the second content block is not an image." % tool, result)
    mime_type = block.get("mimeType")
    try:
        data = base64.b64decode(block.get("data") or "", validate=True)
    except (binascii.Error, TypeError, ValueError):
        raise CheckFailed("%s: the image data is not base64." % tool, result) from None
    if mime_type not in IMAGE_MAGIC or not data.startswith(IMAGE_MAGIC[mime_type]):
        raise CheckFailed("%s: the image is not a %s file (starts with %r)." % (tool, mime_type, data[:8]), result)
    return Image(mime_type, data)


def describe(result):
    """A tool result for people: the parsed envelope and the image's type and size instead of its base64."""
    if not isinstance(result, dict) or not isinstance(result.get("content"), list):
        return result
    shown = {"isError": result.get("isError"), "content": []}
    for block in result["content"]:
        if isinstance(block, dict) and block.get("type") == "text":
            try:
                shown["content"].append({"type": "text", "envelope": json.loads(block.get("text", ""))})
            except ValueError:
                shown["content"].append(block)
        elif isinstance(block, dict) and block.get("type") == "image":
            shown["content"].append({"type": "image", "mimeType": block.get("mimeType"),
                                     "base64_characters": len(block.get("data") or "")})
        else:
            shown["content"].append(block)
    return shown


class Smoke:
    """Runs the checks in order; records every call and keeps the evidence of each failure."""

    def __init__(self, artifacts):
        self.artifacts = artifacts
        self.server = None
        self.calls = []
        self.failures = []
        self.last_result = None
        self.state = {}

    # -- running checks --

    def step(self, title, check, *args) -> bool:
        """Run one group of checks; a failure is recorded with its evidence and the run goes on."""
        print("== " + title, flush=True)
        try:
            check(*args)
            return True
        except Skipped as skipped:
            print("   skipped: %s" % skipped, flush=True)
        except CheckFailed as failure:
            self._record_failure(title, failure)
        return False

    def expect(self, condition, message):
        if not condition:
            raise CheckFailed(message, self.last_result)

    def needs(self, key):
        if key not in self.state:
            raise Skipped("an earlier check did not produce %s" % key)
        return self.state[key]

    def _record_failure(self, title, failure):
        number = len(self.failures) + 1
        self.failures.append({"check": title, "message": str(failure)})
        print("FAILED %s: %s" % (title, failure), flush=True)
        if failure.result is not None:
            shown = json.dumps(describe(failure.result), indent=2, ensure_ascii=False)
            print(shown, flush=True)
            (self.artifacts / ("failure-%02d.json" % number)).write_text(shown + "\n", encoding="utf-8")
        if self.server is not None and self.server.alive():
            print("   (a screenshot of the screen now, for the failure above)", flush=True)
            try:
                envelope, _ = self.call("iphone_observe", {"mode": "both"})
                (self.artifacts / ("failure-%02d-screen.json" % number)).write_text(
                    json.dumps(envelope, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            except CheckFailed as problem:
                print("   no screenshot: %s" % problem, flush=True)

    # -- tool calls --

    def call(self, tool, arguments=None):
        """tools/call -> (envelope, Image or None); one line per call. Malformed results raise CheckFailed."""
        arguments = arguments or {}
        index = len(self.calls) + 1
        started = time.monotonic()
        reply = self.server.request("tools/call", {"name": tool, "arguments": arguments}, CALL_TIMEOUT)
        seconds = time.monotonic() - started
        result = self.last_result = reply.get("result", reply)
        if "error" in reply:
            raise CheckFailed("%s: JSON-RPC error %s" % (tool, json.dumps(reply["error"])), reply)
        content = result.get("content") if isinstance(result, dict) else None
        if (not isinstance(content, list) or not 1 <= len(content) <= 2 or not isinstance(content[0], dict)
                or content[0].get("type") != "text"):
            raise CheckFailed("%s: the result is not one text block plus an optional image." % tool, result)
        try:
            envelope = json.loads(content[0].get("text", ""))
        except (TypeError, ValueError):
            raise CheckFailed("%s: the text block is not a JSON envelope." % tool, result) from None
        if not isinstance(envelope, dict) or envelope.get("ok") not in (True, False):
            raise CheckFailed("%s: the envelope has no ok field." % tool, result)
        image = _image_of(tool, content[1], result) if len(content) == 2 else None
        if result.get("isError") is not (envelope["ok"] is False and image is None):
            raise CheckFailed("%s: isError does not match the envelope." % tool, result)
        error = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
        outcome = "ok" if envelope["ok"] else "error %s" % error.get("code")
        record = {"index": index, "tool": tool, "arguments": arguments, "seconds": round(seconds, 3),
                  "outcome": outcome, "envelope": envelope}
        if image is not None:
            name = "%02d-%s%s" % (index, tool, IMAGE_EXTENSIONS[image.mime_type])
            (self.artifacts / name).write_bytes(image.data)
            record["image"] = name
        self.calls.append(record)
        print("[%2d] %-20s %-28s %6.2fs" % (index, tool, outcome, seconds), flush=True)
        return envelope, image

    def ok(self, tool, arguments=None):
        """A call that must succeed (ok=true)."""
        envelope, image = self.call(tool, arguments)
        if envelope["ok"] is not True:
            error = envelope.get("error") or {}
            raise CheckFailed("%s failed: %s: %s" % (tool, error.get("code"), error.get("message")),
                              self.last_result)
        return envelope, image

    def expect_ratio(self, image_info):
        ratio = image_info.get("pixel_to_point") if isinstance(image_info, dict) else None
        self.expect(isinstance(ratio, list) and len(ratio) == 2
                    and all(isinstance(value, (int, float)) and value > 0 for value in ratio),
                    "The image has no usable pixel_to_point.")

    # -- the tour of Settings --

    def browser_guard(self, host, port):
        problems = check_browser_guard(host, port)
        self.expect(not problems, " ".join(problems))

    def handshake(self):
        reply = self.server.request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                                   "clientInfo": {"name": "iphone-use-ci-smoke", "version": "1"}},
                                    HANDSHAKE_TIMEOUT)
        self.last_result = reply
        info = reply.get("result") or {}
        self.expect(info.get("protocolVersion") == PROTOCOL_VERSION, "initialize did not accept %s." % PROTOCOL_VERSION)
        self.expect((info.get("serverInfo") or {}).get("name") == "iphone-use", "The server is not iphone-use.")
        self.server.notify("notifications/initialized")
        reply = self.server.request("tools/list", timeout=HANDSHAKE_TIMEOUT)
        self.last_result = reply
        names = [tool.get("name") for tool in (reply.get("result") or {}).get("tools") or []]
        missing = [name for name in REQUIRED_TOOLS if name not in names]
        self.expect(not missing, "tools/list lacks %s." % ", ".join(missing))
        print("   %s %s, %d tools" % (info["serverInfo"]["name"], info["serverInfo"].get("version"), len(names)),
              flush=True)

    def ready(self):
        envelope, image = self.ok("iphone_ready", {"recover": False, "screenshot": True})
        self.expect(envelope.get("ready") is True and envelope.get("state") == "ready",
                    "iphone_ready did not report ready=true.")
        self.expect(image is not None, "iphone_ready(screenshot=true) returned no image.")
        observation = envelope.get("observation") or {}
        self.expect_ratio(observation.get("image"))
        print("   WebDriverAgent %s; %s in front" % ((envelope.get("proof") or {}).get("wda_version"),
                                                     observation.get("app")), flush=True)

    def observe(self):
        envelope, image = self.ok("iphone_observe", {"mode": "tree"})
        self.expect(nodes_of(envelope), "iphone_observe(mode=tree) returned no nodes.")
        self.expect(image is None, "iphone_observe(mode=tree) returned an image.")
        envelope, image = self.ok("iphone_observe", {"mode": "screenshot"})
        self.expect(image is not None, "iphone_observe(mode=screenshot) returned no image.")
        self.expect_ratio(envelope.get("image"))
        print("   screenshot: %s, %d bytes, pixel_to_point %s"
              % (image.mime_type, len(image.data), envelope["image"]["pixel_to_point"]), flush=True)

    def home(self):
        envelope, _ = self.ok("iphone_press_button", {"name": "home", "verify": True})
        self.expect(envelope.get("foreground_verified") is True and envelope.get("foreground_app") == SPRINGBOARD,
                    "Home was pressed but the Home Screen was not verified in front.")

    def app_lookup(self):
        envelope, _ = self.ok("iphone_apps", {"query": "Settings", "source": "catalog"})
        found = [row.get("bundle_id") for row in envelope.get("candidates") or [] if isinstance(row, dict)]
        self.expect(SETTINGS in found, "iphone_apps did not find %s (found %s)." % (SETTINGS, found))

    def _launch_settings(self, key):
        envelope, _ = self.ok("iphone_launch_app", {"bundle_id": SETTINGS, "verify": True, "observe": "tree"})
        observation = envelope.get("observation") or {}
        self.expect(envelope.get("foreground_verified") is True and observation.get("app") == SETTINGS,
                    "Settings was not verified in front.")
        self.expect(nodes_of(observation), "The Settings screen tree is empty.")
        self.state[key] = observation

    def launch(self):
        self._launch_settings("main")

    def find(self):
        main = self.needs("main")
        row = choose_row(nodes_of(main), main.get("viewport"))
        self.expect(row is not None, "No row to open on the Settings page (node types: %s)."
                    % sorted({str(node.get("type")) for node in nodes_of(main)}))
        selector = {"type": row["type"], "label": row["label"]}
        envelope, _ = self.ok("iphone_find", {"selector": selector})
        elements = envelope.get("elements") or []
        self.expect(envelope.get("matches", 0) >= 1 and elements and "tap" in elements[0],
                    "iphone_find did not find the %s %r listed in the tree." % (row["type"], row["label"]))
        print("   %s %r: %d match(es), tap point %s"
              % (row["type"], row["label"], envelope["matches"], elements[0]["tap"]), flush=True)
        self.state["row"] = selector
        if find_node(nodes_of(main), "SearchField") is None:
            print("   no SearchField on this Settings page; the typing check will be skipped", flush=True)
            return
        envelope, _ = self.ok("iphone_find", {"selector": {"type": "SearchField"}})
        self.expect(envelope.get("matches", 0) >= 1, "iphone_find did not find the SearchField listed in the tree.")
        self.state["search_on_main"] = True

    def open_row(self):
        envelope, _ = self.ok("iphone_tap", {"selector": self.needs("row"), "observe": "tree"})
        observation = envelope.get("observation") or {}
        self.expect(envelope.get("action_executed") is True, "iphone_tap did not report the tap as executed.")
        self.expect(nodes_of(observation), "iphone_tap(observe=tree) returned no screen tree.")
        self.state["opened"] = observation
        changed = layout(observation) != layout(self.state["main"])
        print("   the page %s" % ("changed" if changed else "looks unchanged"), flush=True)

    def swipe(self):
        before = self.needs("opened")
        envelope, _ = self.ok("iphone_swipe", {"direction": "up", "observe": "tree"})
        self.expect(envelope.get("action_executed") is True, "iphone_swipe did not report the gesture as executed.")
        moved = layout(envelope.get("observation")) != layout(before)
        print("   the content %s" % ("moved" if moved else "did not move (the page may fit on the screen)"),
              flush=True)

    def home_again(self):
        envelope, _ = self.ok("iphone_press_button", {"name": "home"})
        self.expect(envelope.get("action_executed") is True, "iphone_press_button did not report the press.")

    def relaunch(self):
        self._launch_settings("relaunched")

    def batch(self):
        page = self.needs("relaunched")
        target = back_target(nodes_of(page), page.get("viewport"))
        self.expect(target is not None, "The reopened Settings page has no button or text to tap.")
        x, y = center(target)
        print("   tapping the %s %r at %d,%d" % (target.get("type"), target.get("label"), x, y), flush=True)
        envelope, _ = self.ok("iphone_batch", {"steps": [
            {"op": "observe", "args": {"mode": "tree", "max_nodes": 50}},
            {"op": "tap", "args": {"x": x, "y": y, "observe": "tree"}}]})
        results = envelope.get("results") or []
        self.expect(envelope.get("complete") is True and envelope.get("completed_steps") == 2 and len(results) == 2,
                    "iphone_batch did not complete both steps.")
        self.expect(nodes_of(results[0]), "The batch's observe step returned no nodes.")
        self.expect(results[1].get("action_executed") is True and nodes_of(results[1].get("observation")),
                    "The batch's tap step did not report the tap with a screen tree.")
        self.state["back"] = results[1]["observation"]

    def type_search(self):
        if not self.state.get("search_on_main"):
            print("   skipped: the Settings page had no SearchField", flush=True)
            return
        search = find_node(nodes_of(self.needs("back")), "SearchField")
        if search is None:  # the page may still have been moving: look once more
            envelope, _ = self.ok("iphone_observe", {"mode": "tree"})
            search = find_node(nodes_of(envelope), "SearchField")
        self.expect(search is not None, "Settings did not return to its main page: no SearchField after the batch.")
        x, y = center(search)
        # observe=tree lets the field take keyboard focus (the read waits for the animation) before typing.
        envelope, _ = self.ok("iphone_tap", {"x": x, "y": y, "observe": "tree"})
        self.expect(envelope.get("action_executed") is True, "iphone_tap did not report the tap as executed.")
        envelope, _ = self.ok("iphone_type_text", {"text": TYPED_TEXT, "submit": False, "verify": True})
        self.expect(envelope.get("input_complete") is True and envelope.get("exact_readback") is True
                    and envelope.get("submitted") is False and envelope.get("characters") == len(TYPED_TEXT),
                    "iphone_type_text did not read %r back exactly." % TYPED_TEXT)

    def metrics(self):
        envelope, _ = self.ok("iphone_metrics")
        tools, requests = envelope.get("tools") or {}, (envelope.get("http") or {}).get("requests")
        self.expect(isinstance(tools.get("count"), int) and tools["count"] >= 10 and isinstance(requests, int),
                    "iphone_metrics has no tool and request totals.")
        print("   %d tool calls, %d WebDriverAgent requests" % (tools["count"], requests), flush=True)

    def clean_exit(self, code, stderr):
        self.last_result = None
        self.expect(code == 0, "The MCP server did not exit cleanly at the end of input (exit code %s)." % code)
        self.expect(not stderr.strip(), "The MCP server wrote to stderr: %s" % stderr[-2000:])

    def tour(self):
        """The whole run after the server started."""
        if not self.step("MCP handshake", self.handshake) or not self.step("iphone_ready", self.ready):
            return  # nothing else can work
        for title, check in (("iphone_observe tree and screenshot", self.observe),
                             ("iphone_press_button home (verified)", self.home),
                             ("iphone_apps Settings", self.app_lookup),
                             ("iphone_launch_app Settings", self.launch),
                             ("iphone_find from the tree", self.find),
                             ("iphone_tap a row by selector", self.open_row),
                             ("iphone_swipe up", self.swipe),
                             ("iphone_press_button home", self.home_again),
                             ("iphone_launch_app Settings again", self.relaunch),
                             ("iphone_batch observe and tap back", self.batch),
                             ("iphone_type_text into the search field", self.type_search),
                             ("iphone_metrics", self.metrics)):
            if self.server.alive():
                self.step(title, check)
            else:
                print("== %s\n   skipped: the MCP server is not answering" % title, flush=True)


def run(wda_url, artifacts, guard=True) -> int:
    host, port = validate_loopback_url(wda_url)
    print("iPhone Use smoke test against %s; artifacts in %s" % (wda_url, artifacts), flush=True)
    smoke = Smoke(artifacts)
    if guard:
        smoke.step("browser guard (direct HTTP)", smoke.browser_guard, host, port)
    else:
        print("== browser guard (direct HTTP)\n   skipped (--skip-guard-checks)", flush=True)
    state_dir = tempfile.mkdtemp(prefix="iphone-use-smoke-state-")
    env = dict(os.environ, IPHONE_USE_WDA_URL=wda_url, IPHONE_USE_STATE_DIR=state_dir, IPHONE_USE_NO_BROWSER="1",
               IPHONE_USE_PREVIEW_PORT="0", PYTHONDONTWRITEBYTECODE="1")
    try:
        smoke.server = McpServer(env)
        try:
            smoke.tour()
        finally:
            code = smoke.server.close()
            stderr = smoke.server.stderr()
            if stderr:
                (artifacts / "server-stderr.txt").write_text(stderr, encoding="utf-8")
        smoke.step("clean exit", smoke.clean_exit, code, stderr)
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
    passed = not smoke.failures
    (artifacts / "smoke-results.json").write_text(json.dumps(
        {"ok": passed, "wda_url": wda_url, "failures": smoke.failures, "calls": smoke.calls},
        indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("== %d tool calls, %d failed checks: %s" % (len(smoke.calls), len(smoke.failures),
                                                      "PASSED" if passed else "FAILED"), flush=True)
    for failure in smoke.failures:
        print("   - %s: %s" % (failure["check"], failure["message"]), flush=True)
    return 0 if passed else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Smoke-test the iPhone Use MCP server against a running WebDriverAgent (CI simulator).")
    parser.add_argument("--wda-url", default=DEFAULT_WDA_URL, help="loopback WebDriverAgent URL (default %(default)s)")
    parser.add_argument("--artifacts", help="folder for results, screenshots and failure evidence "
                                            "(default: a new temporary folder)")
    parser.add_argument("--skip-guard-checks", action="store_true",
                        help="skip the direct HTTP checks of the browser guard (for a WebDriverAgent without the "
                             "plugin's patches, such as the tests' fake)")
    args = parser.parse_args(argv)
    try:
        validate_loopback_url(args.wda_url)
    except ValueError as exc:
        parser.error(str(exc))
    artifacts = pathlib.Path(args.artifacts or tempfile.mkdtemp(prefix="iphone-use-smoke-")).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    return run(args.wda_url, artifacts, guard=not args.skip_guard_checks)


if __name__ == "__main__":
    sys.exit(main())
