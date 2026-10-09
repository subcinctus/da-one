import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import html.parser  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402

import viewer_server  # noqa: E402

VIEWER = os.path.join(os.path.dirname(HERE), "viewer")
FILES = ("index.html", "app.js", "style.css")
FORBIDDEN_TOKENS = ("functions.exec", "view_image", "widget", "side panel", "pua_", "PUA")
BUTTONS = {"tool-refresh": "Refresh preview", "tool-home": "Go to Home Screen",
           "tool-screenshot": "Copy screenshot to clipboard"}
NODE = shutil.which("node")


def read(name):
    with open(os.path.join(VIEWER, name), encoding="utf-8") as handle:
        return handle.read()


def strip_js_comments(source):
    """app.js without /* */ and // comments (string literals in app.js contain neither)."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", source)


class _Page(html.parser.HTMLParser):
    """Collects every element with its attributes, parent chain and direct text."""

    VOID = {"meta", "link", "img", "br", "hr", "input", "source", "path", "rect", "circle"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements = []
        self.stack = []
        self.script_bodies = []
        self.in_script = False
        self.title = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        element = {"tag": tag, "attrs": dict(attrs), "parents": [item["tag"] + "#" + item["attrs"].get("id", "")
                                                                for item in self.stack], "text": ""}
        self.elements.append(element)
        if tag not in self.VOID:
            self.stack.append(element)
        if tag == "script":
            self.in_script = True
            self.script_bodies.append("")
        if tag == "title":
            self.in_title = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID and self.stack and self.stack[-1]["tag"] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False
        if tag == "title":
            self.in_title = False
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.in_script:
            self.script_bodies[-1] += data
        if self.in_title:
            self.title += data
        if self.stack:
            self.stack[-1]["text"] += data


def parse_page():
    page = _Page()
    page.feed(read("index.html"))
    page.close()
    return page


class IndexHtmlTests(unittest.TestCase):
    def setUp(self):
        self.page = parse_page()
        self.by_id = {element["attrs"]["id"]: element for element in self.page.elements if "id" in element["attrs"]}

    def tags(self, name):
        return [element for element in self.page.elements if element["tag"] == name]

    def test_title_assets_and_scripts(self):
        self.assertEqual(self.page.title, "iPhone Screen")
        scripts = self.tags("script")
        self.assertEqual(len(scripts), 1)
        self.assertEqual(scripts[0]["attrs"].get("src"), "app.js")
        self.assertIn("defer", scripts[0]["attrs"])
        self.assertEqual([body.strip() for body in self.page.script_bodies], [""])
        links = self.tags("link")
        self.assertEqual([(link["attrs"].get("rel"), link["attrs"].get("href")) for link in links],
                         [("stylesheet", "style.css")])
        self.assertEqual(self.tags("style"), [])

    def test_exactly_one_image(self):
        images = self.tags("img")
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["attrs"].get("id"), "image")
        self.assertEqual(images[0]["attrs"].get("alt"), "Live iPhone screen")
        self.assertNotIn("src", images[0]["attrs"])

    def test_exactly_three_labelled_buttons(self):
        buttons = self.tags("button")
        self.assertEqual(len(buttons), 3)
        self.assertEqual({button["attrs"].get("id"): button["attrs"].get("aria-label") for button in buttons}, BUTTONS)
        for button in buttons:
            self.assertEqual(button["attrs"].get("type"), "button")
            self.assertIn("nav#toolbar", button["parents"])

    def test_no_forms_links_frames_inline_styles_or_handlers(self):
        for tag in ("form", "input", "a", "iframe", "object", "embed", "textarea", "select", "base", "style"):
            self.assertEqual(self.tags(tag), [], tag)
        for element in self.page.elements:
            for name in element["attrs"]:
                self.assertNotEqual(name, "style", element["tag"])
                self.assertFalse(name.startswith("on"), (element["tag"], name))
                self.assertNotIn(name, ("href", "src", "action", "formaction", "srcset")
                                 if element["tag"] not in ("link", "script") else ())

    def test_structure(self):
        app = self.by_id["app"]
        self.assertEqual(app["tag"], "main")
        for attribute in ("data-live", "data-operating", "data-orientation"):
            self.assertIn(attribute, app["attrs"])
        expected = {
            "status": ("header", "main#app"), "model": ("span", "header#status"),
            "live": ("span", "header#status"), "live-text": ("span", "span#live"),
            "stage": ("section", "main#app"), "device": ("div", "section#stage"), "screen": ("div", "div#device"),
            "image": ("img", "div#screen"), "empty": ("div", "div#screen"), "empty-text": ("span", "div#empty"),
            "cursors": ("div", "div#screen"), "toast": ("div", "main#app"), "toolbar": ("nav", "main#app"),
            "hint": ("p", "main#app"),
        }
        for element_id, (tag, parent) in expected.items():
            element = self.by_id[element_id]
            self.assertEqual(element["tag"], tag, element_id)
            self.assertEqual(element["parents"][-1], parent, element_id)
        self.assertEqual(self.by_id["model"]["text"], "iPhone")
        self.assertEqual(self.by_id["toast"]["attrs"].get("aria-live"), "polite")
        self.assertIn("hidden", self.by_id["hint"]["attrs"])
        self.assertEqual(self.by_id["hint"]["text"].strip(),
                         "The preview stopped. Ask Claude to open the iPhone screen again.")
        classes = [(element["attrs"].get("class"), element["parents"][-1]) for element in self.page.elements
                   if element["tag"] == "div" and element["attrs"].get("class") in ("glow", "island")]
        self.assertEqual(sorted(classes), [("glow", "div#screen"), ("island", "div#screen")])
        svgs = [element for element in self.page.elements if element["tag"] == "svg"
                and element["parents"][-1] == "div#empty"]
        self.assertEqual(len(svgs), 1)
        icons = {element["attrs"].get("data-icon") for element in self.page.elements if element["tag"] == "g"}
        self.assertEqual(icons, {"connecting", "offline", "locked", "authentication", "paused", "unavailable"})

    def test_static_whitelist_matches_the_files(self):
        self.assertEqual(sorted(name for name, _ in viewer_server.STATIC_FILES.values()), sorted(FILES))
        for filename, _ in viewer_server.STATIC_FILES.values():
            self.assertTrue(os.path.isfile(os.path.join(VIEWER, filename)), filename)
        self.assertEqual(sorted(os.listdir(VIEWER)), sorted(FILES))


class AllFilesTests(unittest.TestCase):
    def test_no_remote_urls_codex_tokens_or_cjk(self):
        for name in FILES:
            text = read(name)
            self.assertNotRegex(text, r"(?i)https?://", name)
            self.assertNotIn("//cdn", text, name)
            for token in FORBIDDEN_TOKENS:
                self.assertNotIn(token, text, (name, token))
            self.assertIsNone(re.search(r"[　-鿿가-힯＀-￯]", text), name)

    def test_files_are_utf8_without_bom(self):
        for name in FILES:
            with open(os.path.join(VIEWER, name), "rb") as handle:
                data = handle.read()
            self.assertFalse(data.startswith(b"\xef\xbb\xbf"), name)
            data.decode("utf-8")


class AppJsTests(unittest.TestCase):
    def setUp(self):
        self.source = read("app.js")
        self.code = strip_js_comments(self.source)

    def test_no_dangerous_apis(self):
        for pattern in (r"\beval\s*\(", r"\bnew\s+Function\b", r"\bFunction\s*\(", r"\.innerHTML\b",
                        r"\.outerHTML\b", r"insertAdjacentHTML", r"document\.write", r"\bconsole\.",
                        r"setAttribute\(\s*[\"']style", r"\.cssText\b", r"\blocalStorage\b", r"\bsessionStorage\b",
                        r"\bimport\s*\(", r"^\s*import\s", r"^\s*export\s", r"\bXMLHttpRequest\b", r"\bWebSocket\b",
                        r"\bwindow\.open\b", r"\blocation\.(href|assign|replace)\b", r"\bpostMessage\b"):
            self.assertIsNone(re.search(pattern, self.code, re.M), pattern)

    def test_plain_es2017(self):
        for pattern in (r"\?\.", r"\?\?", r"\.\.\.", r"catch\s*\{", r"\bfor\s+await\b", r"async\s+function\s*\*",
                        r"#[A-Za-z_]\w*\s*[=;(]", r"\bstatic\s*\{", r"\(\?<[=!A-Za-z]", r"\.flat(Map)?\(",
                        r"fromEntries", r"matchAll", r"replaceAll", r"\.at\(", r"\bglobalThis\b", r"allSettled",
                        r"Promise\.any", r"\bstructuredClone\b", r"\bclass\s"):
            self.assertIsNone(re.search(pattern, self.code), pattern)
        self.assertTrue(self.code.lstrip().startswith("(function () {"))
        self.assertIn('"use strict";', self.code)

    def test_every_url_is_relative(self):
        fetches = re.findall(r"\bfetch\(\s*\"([^\"]*)\"", self.code)
        self.assertEqual(fetches, ["api/action"])
        sources = re.findall(r"new\s+EventSource\(\s*\"([^\"]*)\"", self.code)
        self.assertEqual(sources, ["events"])
        assigned = re.findall(r"\.src\s*=\s*\"([^\"]*)\"", self.code)
        self.assertEqual(assigned, ["stream.mjpeg?g="])
        self.assertEqual(len(re.findall(r"\bfetch\(", self.code)), 1)
        self.assertIsNone(re.search(r"[\"'`]/(?!/)", self.code))       # no absolute paths

    def test_post_uses_json_content_type(self):
        self.assertRegex(self.code, r"method:\s*\"POST\"")
        self.assertRegex(self.code, r"\"Content-Type\":\s*\"application/json\"")
        self.assertRegex(self.code, r"ACTION_TIMEOUT_MS\s*=\s*12000")
        self.assertIn("AbortController", self.code)

    def test_event_source_closed_handling(self):
        self.assertIn("EventSource.CLOSED", self.code)
        self.assertIn('removeAttribute("src")', self.code)

    def test_user_facing_texts(self):
        for text in ("Connecting…", "Live", "Paused", "Not connected", "Waiting for unlock", "Paused for sign-in",
                     "Preview refreshed", "Can't reach the iPhone right now", "Went to the Home Screen",
                     "Screenshot copied to the clipboard",
                     "The iPhone is busy with another step; try again in a moment",
                     "Paused while you sign in on the iPhone", "Couldn't put the screenshot on the clipboard",
                     "Not connected to the iPhone", "That didn't work; please try again"):
            self.assertIn('"%s"' % text, self.source, text)
        for code in ("device_busy", "preview_paused", "clipboard_unavailable", "service_unreachable"):
            self.assertRegex(self.source, r"\b%s:" % code)

    def test_text_is_set_with_text_content_only(self):
        self.assertNotRegex(self.code, r"\.(innerText|outerText)\s*=")
        self.assertRegex(self.code, r"\.textContent\s*=")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_node_syntax_check(self):
        result = subprocess.run([NODE, "--check", os.path.join(VIEWER, "app.js")], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))


class StyleCssTests(unittest.TestCase):
    def setUp(self):
        self.css = read("style.css")

    def test_no_blur_imports_or_urls(self):
        self.assertNotRegex(self.css, r"(?i)blur\(")
        self.assertNotRegex(self.css, r"(?i)backdrop-filter")
        self.assertNotRegex(self.css, r"(?i)@import")
        self.assertNotRegex(self.css, r"(?i)url\(")
        self.assertNotRegex(self.css, r"(?i)expression\(")
        self.assertNotRegex(self.css, r"(?i)@font-face")

    def test_theme_background_and_hidden(self):
        self.assertRegex(self.css, r"@media \(prefers-color-scheme: dark\)")
        self.assertRegex(self.css, r"@media \(prefers-reduced-motion: reduce\)")
        self.assertRegex(self.css, r"(?s)\[hidden\]\s*\{\s*display:\s*none\s*!important;")
        body = re.search(r"(?s)html,\s*body\s*\{(.*?)\}", self.css)
        self.assertIsNotNone(body)
        self.assertRegex(body.group(1), r"background:\s*var\(--canvas\)")
        self.assertRegex(self.css, r"object-fit:\s*contain")

    def test_glow_animations_change_opacity_only(self):
        keyframes = re.findall(r"(?s)@keyframes\s+([\w-]+)\s*\{(.*?\})\s*\}", self.css)
        names = {name for name, _ in keyframes}
        self.assertTrue({"glow-breathe", "glow-swap"} <= names)
        for name, body in keyframes:
            properties = set(re.findall(r"([a-z-]+)\s*:", body))
            self.assertEqual(properties, {"opacity"}, name)
        self.assertRegex(self.css, r"#app\[data-operating=\"true\"\] \.glow")


HARNESS = r"""
"use strict";
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync(process.argv[2], "utf8");

const failures = [];
let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

// Fake timers: nothing runs until the scenario advances the clock.
let clockMs = 0;
let nextTimer = 1;
const timers = new Map();
function fakeSetTimeout(fn, ms) {
  const id = nextTimer++;
  timers.set(id, { fn: fn, at: clockMs + (ms || 0) });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
function advance(ms) {
  const end = clockMs + ms;
  for (;;) {
    let due = null;
    for (const entry of timers) {
      if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
    }
    if (!due) break;
    timers.delete(due[0]);
    clockMs = due[1].at;
    due[1].fn();
  }
  clockMs = end;
}

class FakeStyle {
  constructor() { this.properties = {}; }
  setProperty(name, value) { this.properties[name] = String(value); }
}
class FakeClassList {
  constructor() { this.items = new Set(); }
  add(name) { this.items.add(name); }
  contains(name) { return this.items.has(name); }
}
class FakeElement {
  constructor(id, tag) {
    this.id = id; this.tagName = tag; this.dataset = {}; this.style = new FakeStyle();
    this.hidden = false; this.textContent = ""; this.title = ""; this.disabled = false;
    this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = {};
    this.classList = new FakeClassList(); this.className = ""; this.clientWidth = 400; this.clientHeight = 800;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { (this.listeners[type] || []).slice().forEach(function (fn) { fn({ type: type }); }); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(function (c) { return c !== child; }); child.parentNode = null; return child; }
}
class FakeImage extends FakeElement {
  constructor(id) { super(id, "img"); this.history = []; this.naturalWidth = 0; this.naturalHeight = 0; this.hidden = true; }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); this.history.push(String(value)); }
}

const ids = ["app", "model", "live-text", "stage", "device", "screen", "empty", "empty-text", "cursors", "toast",
             "hint", "tool-refresh", "tool-home", "tool-screenshot"];
const elements = {};
ids.forEach(function (id) { elements[id] = new FakeElement(id, "div"); });
elements.image = new FakeImage("image");
elements.hint.hidden = true;
elements.toast.hidden = true;

const documentListeners = {};
const document = {
  hidden: false,
  getElementById: function (id) { return elements[id] || null; },
  createElement: function (tag) { return new FakeElement(null, tag); },
  addEventListener: function (type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); }
};
const windowListeners = {};

const sources = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; sources.push(this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  emit(type, data) {
    const event = data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) };
    (this.listeners[type] || []).forEach(function (fn) { fn(event); });
  }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

const fetches = [];
function fakeFetch(url, options) {
  return new Promise(function (resolve, reject) { fetches.push({ url: url, options: options, resolve: resolve, reject: reject }); });
}
function respond(index, status, body) {
  fetches[index].resolve({ ok: status === 200, status: status, json: function () { return Promise.resolve(body); } });
}

const sandbox = {
  document: document,
  EventSource: FakeEventSource,
  fetch: fakeFetch,
  AbortController: function () { this.signal = {}; this.abort = function () {}; },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  matchMedia: function () { return { matches: false }; },
  addEventListener: function (type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "app.js" });

function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }
async function settle() { for (let i = 0; i < 6; i += 1) await flush(); }

const app = elements.app;
const image = elements.image;
const live = elements["live-text"];
const tools = { refresh: elements["tool-refresh"], home: elements["tool-home"], screenshot: elements["tool-screenshot"] };
function state(extra) {
  const base = { server_time: 100000, stream_id: "s1", seq: 0, frame_available: false, frame_width: null,
                 frame_height: null, device: null, viewport: { width: 390, height: 844 }, busy: false,
                 operating: false, paused: false, pause_reason: null, capturing: false, viewers: 0, events: [] };
  return Object.assign(base, extra || {});
}

(async function scenario() {
  check(sources.length === 1 && sources[0].url === "events", "one EventSource on 'events'");
  check(image.getAttribute("src") === null, "no stream before the first state");
  check(app.dataset.live === "connecting" && live.textContent === "Connecting…", "starts connecting");
  check(elements.empty.hidden === false && elements.empty.dataset.state === "connecting", "connecting placeholder");
  const events = sources[0];

  events.emit("state", state());
  check(image.getAttribute("src") === "stream.mjpeg?g=1", "first state connects the stream");
  check(app.dataset.live === "connecting", "no frame yet: still connecting");
  check(elements.device.style.properties["--bezel"] !== undefined, "chassis is fitted");

  image.naturalWidth = 1179; image.naturalHeight = 2556;
  image.fire("load");
  check(image.hidden === false && elements.empty.hidden === true, "pixels are shown after load");
  check(app.dataset.live === "live" && live.textContent === "Live", "live after the first picture");

  events.emit("state", state({ frame_available: true, operating: true, busy: true, device: { model: "iPhone 16 Pro" } }));
  check(app.dataset.operating === "true" && app.dataset.busy === "true", "operating glow on");
  check(elements.model.textContent === "iPhone 16 Pro", "model in the header");
  check(image.history.length === 1, "unchanged stream id does not reconnect");

  events.emit("state", state({ frame_available: true, events: [
    { id: 1, kind: "tap", at: 99900, point: { x: 195, y: 422 }, viewport: { width: 390, height: 844 } },
    { id: 2, kind: "tap", at: 90000, point: { x: 10, y: 10 } },
    { id: 3, kind: "drag", at: 99950, from: { x: 195, y: 557 }, to: { x: 195, y: 287 }, duration_ms: 449 },
    { id: 4, kind: "tap", at: 99990, point: { x: 10, y: 10 }, viewport: { width: 844, height: 390 } }
  ] }));
  const markers = elements.cursors.children;
  check(markers.length === 2, "recent gestures with a matching aspect are shown (got " + markers.length + ")");
  check(markers.length > 0 && markers[0].style.left === "50%" && markers[0].style.top === "50%", "tap placed in points");
  check(markers.length > 1 && Math.abs(parseFloat(markers[1].style.top) - 287 / 844 * 100) < 1e-9,
        "without animation support a drag marker sits at its end point");
  events.emit("state", state({ frame_available: true, events: [
    { id: 1, kind: "tap", at: 99990, point: { x: 1, y: 1 } }] }));
  check(elements.cursors.children.length === 2, "event ids are shown once");
  advance(3000);
  check(elements.cursors.children.length === 0, "markers are removed after their animation time");

  events.emit("state", state({ paused: true, pause_reason: "device_locked" }));
  check(image.getAttribute("src") === null && image.hidden === true, "pause removes the picture at once");
  check(elements.empty.dataset.state === "locked" && live.textContent === "Waiting for unlock", "locked placeholder");
  check(app.dataset.live === "paused" && app.dataset.operating === "false", "paused, no glow");
  check(tools.home.disabled && tools.screenshot.disabled && !tools.refresh.disabled, "home and copy disabled while paused");
  events.emit("state", state({ paused: true, pause_reason: "authentication" }));
  check(elements.empty.dataset.state === "authentication" && live.textContent === "Paused for sign-in", "sign-in placeholder");

  events.emit("state", state({ frame_available: true }));
  check(image.getAttribute("src") === "stream.mjpeg?g=2", "resume reconnects with a new generation");
  check(!tools.home.disabled, "home enabled again");
  events.emit("state", state({ frame_available: true, stream_id: "s2" }));
  check(image.getAttribute("src") === "stream.mjpeg?g=3", "a new stream id reconnects");

  image.fire("error");
  check(image.getAttribute("src") === "stream.mjpeg?g=3", "no instant retry after an error");
  advance(2000);
  check(image.getAttribute("src") === "stream.mjpeg?g=4", "the picture is retried after 2 s");

  document.hidden = true;
  documentListeners.visibilitychange.forEach(function (fn) { fn(); });
  check(image.getAttribute("src") === null, "a hidden tab drops the stream");
  document.hidden = false;
  documentListeners.visibilitychange.forEach(function (fn) { fn(); });
  check(image.getAttribute("src") === "stream.mjpeg?g=5", "a visible tab reconnects");
  image.fire("load");

  tools.home.fire("click");
  await settle();
  check(fetches.length === 1 && fetches[0].url === "api/action", "one POST to api/action");
  const options = fetches[0].options;
  check(options.method === "POST" && options.headers["Content-Type"] === "application/json", "JSON POST");
  check(options.body === JSON.stringify({ action: "home" }), "action body");
  check(tools.refresh.disabled && tools.home.disabled && tools.screenshot.disabled, "buttons disabled in flight");
  tools.screenshot.fire("click");
  check(fetches.length === 1, "no second request while one is in flight");
  respond(0, 200, { ok: true, action: "home" });
  await settle();
  check(elements.toast.hidden === false && elements.toast.textContent === "Went to the Home Screen", "home toast");
  check(!tools.home.disabled, "buttons enabled again");
  advance(1800);
  check(elements.toast.hidden === true, "toast hides after 1.8 s");

  tools.screenshot.fire("click");
  await settle();
  respond(1, 200, { ok: false, error: { code: "device_busy", message: "busy" } });
  await settle();
  check(elements.toast.textContent === "The iPhone is busy with another step; try again in a moment"
        && elements.toast.dataset.tone === "error", "busy toast");

  tools.refresh.fire("click");
  await settle();
  respond(2, 200, { ok: true, action: "refresh", service_ready: false, paused: false, pause_reason: null });
  await settle();
  check(elements.toast.textContent === "Can't reach the iPhone right now" && elements.toast.dataset.tone === "error",
        "refresh without the phone");

  tools.home.fire("click");
  await settle();
  respond(3, 403, { ok: false, error: { code: "forbidden" } });
  await settle();
  check(elements.toast.textContent === "That didn't work; please try again", "default failure toast");

  events.readyState = 0;
  events.emit("error");
  check(app.dataset.live !== "offline", "one error is not offline yet");
  events.emit("error");
  check(app.dataset.live === "offline" && live.textContent === "Not connected", "offline after two errors");
  check(image.getAttribute("src") !== null, "a network blip keeps the picture");
  check(elements.hint.hidden === true, "no hint yet");
  advance(8000);
  check(elements.hint.hidden === false, "hint after 8 s offline");
  events.emit("state", state({ frame_available: true, stream_id: "s2" }));
  check(elements.hint.hidden === true && app.dataset.live === "live", "back online hides the hint");

  events.readyState = 2;
  events.emit("error");
  check(app.dataset.live === "offline" && elements.hint.hidden === false, "a closed EventSource shows offline and the hint at once");
  check(image.getAttribute("src") === null && elements.empty.dataset.state === "offline", "a dead server drops the picture");
  check(tools.refresh.disabled && tools.home.disabled, "toolbar disabled for a dead server");
  const before = image.history.length;
  image.fire("error");
  advance(10000);
  events.emit("state", state({ frame_available: true, stream_id: "s3" }));
  check(image.history.length === before, "no retries once the server is gone");

  process.stdout.write(JSON.stringify({ checks: checks, failures: failures }));
}()).catch(function (error) {
  process.stdout.write(JSON.stringify({ checks: checks, failures: failures.concat(["crash: " + (error && error.stack)]) }));
});
"""


@unittest.skipUnless(NODE, "node is not installed")
class AppBehaviourTests(unittest.TestCase):
    """Runs app.js in Node against a tiny fake DOM, EventSource, fetch and clock."""

    def test_page_behaviour(self):
        directory = tempfile.mkdtemp(dir="/tmp")
        self.addCleanup(shutil.rmtree, directory, True)
        harness = os.path.join(directory, "harness.js")
        with open(harness, "w", encoding="utf-8") as handle:
            handle.write(HARNESS)
        result = subprocess.run([NODE, harness, os.path.join(VIEWER, "app.js")], cwd=directory,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        report = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(report["failures"], [])
        self.assertGreater(report["checks"], 40)


if __name__ == "__main__":
    unittest.main()
