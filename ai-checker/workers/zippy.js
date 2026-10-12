// ZipPy runs in its own classic worker (it needs importScripts for Thinkst's LZMA-JS build).
// Messages in : {id, type: 'score', text}   Messages out: {id, ok, determination, score, ms} | {id, error}
importScripts('../vendor/lzma_worker-min.js', '../detectors/zippy.js');

const ready = fetch('../vendor/zippy-ai-generated.txt')
  .then((r) => { if (!r.ok) throw new Error('ZipPy corpus is missing.'); return r.text(); })
  .then((t) => self.ZipPyBrowser.init(t));

// lzma_worker-min.js installs its own onmessage in workers; this replaces it.
self.onmessage = async (e) => {
  const { id, type, text } = e.data || {};
  try {
    await ready;
    if (type !== 'score') throw new Error(`Unknown request: ${type}`);
    const t0 = performance.now();
    const [determination, score] = self.ZipPyBrowser.runOnTextChunked(text);
    self.postMessage({ id, ok: true, determination, score, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
