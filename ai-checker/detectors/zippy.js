// ZipPy (Thinkst Applied Research, MIT) — compression-based AI-text detector.
// Line-for-line port of the browser build in thinkst/zippy (nlzmadetect/src/nlzmadetect.nim,
// compiled to inch/scripts/nlzmadetect.js), using the same LZMA-JS library and the same
// ai-generated.txt prelude. Behaviour of the compiled build is kept exactly, including that its
// regular expressions replace only the first match and that lengths are counted in UTF-8 bytes.
// Needs the global LZMA from vendor/lzma_worker-min.js.
(function (root) {
  'use strict';
  const COMPRESSION_PRESET = 2;
  const SHORT_SAMPLE_THRESHOLD = 350;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let PRELUDE_BYTES = null;
  let PRELUDE_RATIO = 0;

  const bytesOf = (s) => enc.encode(s);
  const strOf = (b) => dec.decode(b);
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };

  function compressStr(sBytes) {
    const inLen = PRELUDE_BYTES.length + sBytes.length;
    const combined = strOf(concat(PRELUDE_BYTES, sBytes)).replace(new RegExp('[^\\x00-\\x7F]'), '');
    const outLen = root.LZMA.compress(combined, COMPRESSION_PRESET).length;
    return outLen / inLen;
  }

  // Nim's round(x, places): half away from zero
  function nimRound(x, places) {
    const f = Math.pow(10, places);
    const y = x * f;
    return (y < 0 ? -Math.round(-y) : Math.round(y)) / f;
  }

  function init(preludeText) {
    PRELUDE_BYTES = bytesOf(preludeText);
    PRELUDE_RATIO = compressStr(new Uint8Array(0));
    return PRELUDE_RATIO;
  }

  function scoreString(sBytes, fuzziness) {
    const sampleRatio = compressStr(sBytes);
    const delta = PRELUDE_RATIO - sampleRatio;
    let determination = 'AI';
    if (delta < 0) determination = 'Human';
    if (nimRound(delta, fuzziness) === 0 && sBytes.length >= SHORT_SAMPLE_THRESHOLD) determination = 'AI';
    if (nimRound(delta, fuzziness) === 0 && sBytes.length < SHORT_SAMPLE_THRESHOLD) determination = 'Human';
    return [determination, Math.abs(delta) * 100.0];
  }

  // Nim rfind(s, char, start, last): last index of c in s[start..last], or -1
  function rfind(b, c, start, last) {
    for (let i = Math.min(last, b.length - 1); i >= start; i--) if (b[i] === c) return i;
    return -1;
  }

  function runOnTextChunked(text, chunkSize = 1024, fuzziness = 3) {
    if (!PRELUDE_BYTES) throw new Error('ZipPy not initialised');
    let inf = text;
    inf = inf.replace(new RegExp(' +'), ' ');
    inf = inf.replace(new RegExp('\\t'), '');
    inf = inf.replace(new RegExp('\\n+'), '\n');
    inf = inf.replace(new RegExp('\\n '), '\n');
    inf = inf.replace(new RegExp(' \\n'), '\n');
    const b = bytesOf(inf);
    let start = 0, send = 0;
    const chunks = [];
    const SPACE = 32;
    while (start + chunkSize < b.length && send !== -1) {
      send = rfind(b, SPACE, start, start + chunkSize);
      chunks.push(send >= start ? b.subarray(start, send + 1) : new Uint8Array(0));
      start = send + 1;
    }
    chunks.push(b.subarray(start, b.length));
    const scores = chunks.map((c) => scoreString(c, fuzziness));
    let ssum = 0;
    for (const [d, s] of scores) ssum += d === 'AI' ? -s : s;
    const sa = ssum / scores.length;
    return sa < 0 ? ['AI', Math.abs(sa)] : ['Human', Math.abs(sa)];
  }

  root.ZipPyBrowser = { init, runOnTextChunked, scoreString: (s, f = 3) => scoreString(bytesOf(s), f) };
})(typeof self !== 'undefined' ? self : globalThis);
