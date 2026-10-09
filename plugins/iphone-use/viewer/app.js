/*
 * iPhone Screen preview page.
 *
 * The server pushes the preview state over server-sent events ("events") and the picture
 * as an MJPEG stream ("stream.mjpeg") that this page shows in its one <img>. The three
 * toolbar buttons post to "api/action". Every URL is relative to the page, which lives
 * under a private token path. Plain ES2017, no modules, no build step.
 */
(function () {
  "use strict";

  const FRAME_RETRY_MS = 2000;
  const OFFLINE_AFTER_ERRORS = 2;
  const HINT_AFTER_MS = 8000;
  const TOAST_MS = 1800;
  const ACTION_TIMEOUT_MS = 12000;
  const GESTURE_MIN_AGE_MS = -1000;
  const GESTURE_MAX_AGE_MS = 2500;
  const ASPECT_TOLERANCE = 0.08;
  const DEFAULT_SIZE = { width: 440, height: 956 };

  const LIVE_TEXT = {
    connecting: "Connecting…",
    live: "Live",
    paused: "Paused",
    offline: "Not connected"
  };
  const PAUSE_TEXT = {
    device_locked: "Waiting for unlock",
    authentication: "Paused for sign-in"
  };
  const PAUSE_TITLE = {
    device_locked: "Unlock the iPhone, then continue the task or click Refresh preview.",
    authentication: "The picture is hidden while you sign in on the iPhone.",
    unknown: "The picture is hidden for now. Click Refresh preview to try again."
  };
  const EMPTY_TEXT = {
    connecting: "Connecting to the iPhone…",
    offline: "Not connected to the iPhone",
    locked: "Waiting for the iPhone to be unlocked",
    authentication: "Hidden while you sign in on the iPhone",
    paused: "Preview paused",
    unavailable: "The picture is not available right now"
  };
  const DONE = {
    refresh: "Preview refreshed",
    home: "Went to the Home Screen",
    screenshot: "Screenshot copied to the clipboard"
  };
  const FAILED = {
    device_busy: "The iPhone is busy with another step; try again in a moment",
    preview_paused: "Paused while you sign in on the iPhone",
    clipboard_unavailable: "Couldn't put the screenshot on the clipboard",
    service_unreachable: "Not connected to the iPhone"
  };
  const FAILED_DEFAULT = "That didn't work; please try again";
  const REFRESH_UNREACHABLE = "Can't reach the iPhone right now";

  const root = document.getElementById("app");
  const modelText = document.getElementById("model");
  const liveText = document.getElementById("live-text");
  const stage = document.getElementById("stage");
  const device = document.getElementById("device");
  const screen = document.getElementById("screen");
  const image = document.getElementById("image");
  const empty = document.getElementById("empty");
  const emptyText = document.getElementById("empty-text");
  const cursors = document.getElementById("cursors");
  const toast = document.getElementById("toast");
  const hint = document.getElementById("hint");
  const tools = {
    refresh: document.getElementById("tool-refresh"),
    home: document.getElementById("tool-home"),
    screenshot: document.getElementById("tool-screenshot")
  };
  const reducedMotion = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

  let events = null;          // the EventSource
  let eventsClosed = false;   // the server refused us for good (e.g. a restarted server, old token)
  let eventErrors = 0;
  let offline = false;
  let hintTimer = null;
  let streamId = null;
  let generation = 0;
  let retryTimer = null;
  let hasPixels = false;
  let paused = false;
  let lastEventId = 0;
  let viewport = null;        // iPhone screen size in points (from the server)
  let pictureSize = null;     // decoded picture size (honours EXIF orientation)
  let frameSize = null;       // frame size reported by the server
  let acting = false;
  let toastTimer = null;
  const effects = new Set();

  /* --- small helpers ------------------------------------------------------------------- */

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function validSize(value) {
    return !!value && typeof value === "object" && isNumber(value.width) && isNumber(value.height)
      && value.width > 0 && value.height > 0;
  }

  function validPoint(value) {
    return !!value && typeof value === "object" && isNumber(value.x) && isNumber(value.y);
  }

  function sameSize(a, b) {
    return !!a && !!b && a.width === b.width && a.height === b.height;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function pageVisible() {
    return !document.hidden;
  }

  /* --- live state, empty states, toolbar ---------------------------------------------------- */

  function syncTools() {
    const isPaused = root.dataset.live === "paused";
    tools.refresh.disabled = acting || eventsClosed;
    tools.home.disabled = acting || isPaused || eventsClosed;
    tools.screenshot.disabled = acting || isPaused || eventsClosed;
  }

  function setLive(state, text, title) {
    root.dataset.live = state;
    liveText.textContent = text || LIVE_TEXT[state];
    liveText.title = title || "";
    syncTools();
  }

  function showEmpty(kind) {
    empty.dataset.state = kind;
    emptyText.textContent = EMPTY_TEXT[kind];
    if (!hasPixels) {
      image.hidden = true;
      empty.hidden = false;
    }
  }

  function showPixels() {
    hasPixels = true;
    image.hidden = false;
    empty.hidden = true;
  }

  function dropPixels(kind) {
    hasPixels = false;
    image.hidden = true;
    empty.hidden = false;
    showEmpty(kind);
  }

  function notify(text, failed) {
    toast.textContent = text;
    toast.dataset.tone = failed ? "error" : "ok";
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      toast.hidden = true;
    }, TOAST_MS);
  }

  /* --- chassis layout ------------------------------------------------------------------------ */

  function displaySize() {
    if (validSize(viewport)) return viewport;
    if (validSize(pictureSize)) return pictureSize;
    if (validSize(frameSize)) return frameSize;
    return DEFAULT_SIZE;
  }

  function fit() {
    const size = displaySize();
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    root.dataset.orientation = size.width > size.height ? "landscape" : "portrait";
    if (!(stageWidth > 0 && stageHeight > 0)) return;
    const shortSide = Math.min(size.width, size.height);
    const bezel = shortSide * 0.024;
    const outerWidth = size.width + 2 * bezel;
    const outerHeight = size.height + 2 * bezel;
    const scale = 0.96 * Math.min(stageWidth / outerWidth, stageHeight / outerHeight);
    device.style.width = (outerWidth * scale) + "px";
    device.style.height = (outerHeight * scale) + "px";
    device.style.setProperty("--bezel", (bezel * scale) + "px");
    device.style.setProperty("--screen-radius", (shortSide * 0.12 * scale) + "px");
  }

  /* --- the MJPEG picture --------------------------------------------------------------------- */

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function canStream() {
    return streamId !== null && !paused && !eventsClosed && pageVisible();
  }

  function connectStream() {
    clearRetry();
    if (!canStream()) return;
    generation += 1;
    image.src = "stream.mjpeg?g=" + generation;
  }

  function disconnectStream(kind) {
    clearRetry();
    if (image.getAttribute("src") !== null) image.removeAttribute("src");
    dropPixels(kind);
  }

  function scheduleRetry() {
    clearRetry();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connectStream();
    }, FRAME_RETRY_MS);
  }

  image.addEventListener("load", function () {
    if (image.getAttribute("src") === null || paused || eventsClosed) return;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      const decoded = { width: image.naturalWidth, height: image.naturalHeight };
      if (!sameSize(decoded, pictureSize)) {
        pictureSize = decoded;
        fit();
      }
    }
    showPixels();
    if (!offline) setLive("live");
  });

  image.addEventListener("error", function () {
    // Retry only while the server still talks to this page.
    if (image.getAttribute("src") === null || paused || eventsClosed || !pageVisible()) return;
    if (!hasPixels) showEmpty("unavailable");
    scheduleRetry();
  });

  /* --- gestures (taps and swipes the model made, in iPhone points) ------------------------- */

  function finishEffect(effect) {
    if (!effects.delete(effect)) return;
    if (effect.animation) effect.animation.cancel();
    if (effect.timer) clearTimeout(effect.timer);
    if (effect.node.parentNode) effect.node.parentNode.removeChild(effect.node);
  }

  function cancelEffects() {
    Array.from(effects).forEach(finishEffect);
  }

  function place(node, point, size) {
    node.style.left = (clamp(point.x / size.width, 0, 1) * 100) + "%";
    node.style.top = (clamp(point.y / size.height, 0, 1) * 100) + "%";
  }

  function showGesture(gesture) {
    if (!hasPixels || image.hidden) return;
    const size = validSize(gesture.viewport) ? gesture.viewport : viewport;
    if (!validSize(size)) return;
    const shown = displaySize();
    if (Math.abs((size.width / size.height) / (shown.width / shown.height) - 1) > ASPECT_TOLERANCE) return;
    const start = gesture.kind === "tap" ? gesture.point : gesture.from;
    if (!validPoint(start)) return;
    if (gesture.kind === "drag" && !validPoint(gesture.to)) return;

    const marker = document.createElement("div");
    marker.className = "cursor";
    place(marker, start, size);
    cursors.appendChild(marker);
    const effect = { node: marker, animation: null, timer: null };
    effects.add(effect);

    const movement = clamp(isNumber(gesture.duration_ms) && gesture.duration_ms > 0 ? gesture.duration_ms : 650, 600, 1000);
    const duration = gesture.kind === "drag" ? movement + 1000 : 1600;
    effect.timer = setTimeout(function () { finishEffect(effect); }, duration + 250);

    if ((reducedMotion && reducedMotion.matches) || typeof marker.animate !== "function") {
      if (gesture.kind === "drag") place(marker, gesture.to, size);
      marker.classList.add("still");
      return;
    }
    let frames;
    if (gesture.kind === "drag") {
      const dx = (gesture.to.x - start.x) / size.width * screen.clientWidth;
      const dy = (gesture.to.y - start.y) / size.height * screen.clientHeight;
      const moved = "translate(" + dx + "px, " + dy + "px)";
      frames = [
        { transform: "translate(0px, 0px) scale(.96)", opacity: 0, offset: 0 },
        { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 80 / duration },
        { transform: "translate(0px, 0px) scale(.92)", opacity: 1, offset: 200 / duration, easing: "cubic-bezier(.3,0,.2,1)" },
        { transform: moved + " scale(.92)", opacity: 1, offset: (movement + 200) / duration },
        { transform: moved + " scale(1.06)", opacity: 1, offset: (movement + 380) / duration },
        { transform: moved + " scale(1)", opacity: 1, offset: (duration - 200) / duration },
        { transform: moved + " scale(.98)", opacity: 0, offset: 1 }
      ];
    } else {
      frames = [
        { transform: "scale(.96)", opacity: 0, offset: 0 },
        { transform: "scale(1)", opacity: 1, offset: 0.06 },
        { transform: "scale(.9)", opacity: 1, offset: 0.16 },
        { transform: "scale(1.06)", opacity: 1, offset: 0.28 },
        { transform: "scale(1)", opacity: 1, offset: 0.4 },
        { transform: "scale(1)", opacity: 1, offset: 0.875 },
        { transform: "scale(.98)", opacity: 0, offset: 1 }
      ];
    }
    try {
      effect.animation = marker.animate(frames, { duration: duration, easing: "linear", fill: "forwards" });
      effect.animation.onfinish = function () { finishEffect(effect); };
    } catch (error) {
      marker.classList.add("still");
    }
  }

  /* --- applying a server state ---------------------------------------------------------------- */

  function enterPause(reason) {
    paused = true;
    cancelEffects();
    disconnectStream(reason === "device_locked" ? "locked" : reason === "authentication" ? "authentication" : "paused");
    root.dataset.busy = "false";
    root.dataset.operating = "false";
    setLive("paused", PAUSE_TEXT[reason] || LIVE_TEXT.paused, PAUSE_TITLE[reason] || PAUSE_TITLE.unknown);
  }

  function consume(state) {
    if (!state || typeof state !== "object" || eventsClosed) return;
    backOnline();
    if (state.device && typeof state.device.model === "string" && state.device.model) {
      modelText.textContent = state.device.model;
    }
    if (validSize(state.viewport) && !sameSize(viewport, state.viewport)) {
      viewport = { width: state.viewport.width, height: state.viewport.height };
      fit();
    }
    const reported = { width: state.frame_width, height: state.frame_height };
    if (validSize(reported) && !sameSize(frameSize, reported)) {
      frameSize = reported;
      if (!validSize(viewport) && !validSize(pictureSize)) fit();
    }
    if (state.paused === true) {
      enterPause(state.pause_reason);
      return;
    }

    const resumed = paused;
    paused = false;
    const newStream = typeof state.stream_id === "string" && state.stream_id !== streamId;
    if (newStream) streamId = state.stream_id;
    if (resumed || newStream) {
      connectStream();
    } else if (image.getAttribute("src") === null && !retryTimer) {
      connectStream();
    }

    root.dataset.busy = String(state.busy === true);
    root.dataset.operating = String(state.operating === true);
    if (state.frame_available === true || hasPixels) {
      setLive("live");
    } else {
      setLive("connecting");
      if (!hasPixels) showEmpty("connecting");
    }

    if (Array.isArray(state.events)) {
      const now = isNumber(state.server_time) ? state.server_time : Date.now();
      state.events.forEach(function (gesture) {
        if (!gesture || !Number.isInteger(gesture.id) || gesture.id <= lastEventId) return;
        lastEventId = gesture.id;
        const age = now - gesture.at;
        if (isNumber(age) && age >= GESTURE_MIN_AGE_MS && age <= GESTURE_MAX_AGE_MS
            && (gesture.kind === "tap" || gesture.kind === "drag")) {
          showGesture(gesture);
        }
      });
    }
  }

  /* --- connection to the preview server ------------------------------------------------------ */

  function showHint() {
    hintTimer = null;
    hint.hidden = false;
  }

  function goOffline(final) {
    offline = true;
    root.dataset.operating = "false";
    setLive("offline");
    if (!hasPixels) showEmpty("offline");
    if (final) {
      if (hintTimer) clearTimeout(hintTimer);
      showHint();
    } else if (!hintTimer && hint.hidden) {
      hintTimer = setTimeout(showHint, HINT_AFTER_MS);
    }
  }

  function backOnline() {
    eventErrors = 0;
    if (!offline) return;
    offline = false;
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    hint.hidden = true;
  }

  function serverGone() {
    // A non-200 answer (such as the 404 a restarted server gives an old token) closes the
    // EventSource for good: show offline now, stop picture retries and show the hint.
    eventsClosed = true;
    cancelEffects();
    clearRetry();
    if (image.getAttribute("src") !== null) image.removeAttribute("src");
    dropPixels("offline");
    goOffline(true);
  }

  function openEvents() {
    if (typeof EventSource !== "function") {
      serverGone();
      return;
    }
    events = new EventSource("events");
    events.addEventListener("state", function (message) {
      let state = null;
      try {
        state = JSON.parse(message.data);
      } catch (error) {
        return;
      }
      consume(state);
    });
    events.addEventListener("error", function () {
      if (events.readyState === EventSource.CLOSED) {
        serverGone();
        return;
      }
      eventErrors += 1;   // the browser reconnects by itself ("retry: 2000")
      if (eventErrors >= OFFLINE_AFTER_ERRORS) goOffline(false);
    });
  }

  /* --- toolbar ---------------------------------------------------------------------------------- */

  async function act(name) {
    const button = tools[name];
    if (acting || button.disabled) return;
    acting = true;
    button.dataset.busy = "true";
    syncTools();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, ACTION_TIMEOUT_MS) : null;
    try {
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name }),
        cache: "no-store",
        credentials: "same-origin"
      };
      if (controller) options.signal = controller.signal;
      const response = await fetch("api/action", options);
      let result = null;
      try {
        result = await response.json();
      } catch (error) {
        result = null;
      }
      if (!response.ok || !result || result.ok !== true) {
        const code = result && result.error && typeof result.error.code === "string" ? result.error.code : "";
        notify(FAILED[code] || FAILED_DEFAULT, true);
      } else if (name === "refresh") {
        if (result.service_ready === false) {
          notify(REFRESH_UNREACHABLE, true);
        } else {
          notify(DONE.refresh, false);
        }
        if (result.paused === true) {
          enterPause(result.pause_reason);
        } else if (!paused) {
          connectStream();
        }
      } else {
        notify(DONE[name], false);
      }
    } catch (error) {
      notify(FAILED_DEFAULT, true);
    } finally {
      if (timer) clearTimeout(timer);
      acting = false;
      delete button.dataset.busy;
      syncTools();
    }
  }

  Object.keys(tools).forEach(function (name) {
    tools[name].addEventListener("click", function () {
      act(name);
    });
  });

  /* --- page visibility: no hidden tab keeps the iPhone's screen capture running --------------- */

  function visibilityChanged() {
    root.dataset.visible = String(pageVisible());
    if (!pageVisible()) {
      cancelEffects();
      disconnectStream("connecting");
    } else if (!paused && !eventsClosed) {
      connectStream();
    }
  }

  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", function () {
    cancelEffects();
    disconnectStream("connecting");
  });
  window.addEventListener("pageshow", visibilityChanged);

  /* --- start ------------------------------------------------------------------------------------ */

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(fit).observe(stage);
  } else {
    window.addEventListener("resize", fit);
  }
  root.dataset.visible = String(pageVisible());
  dropPixels("connecting");
  setLive("connecting");
  fit();
  openEvents();
}());
