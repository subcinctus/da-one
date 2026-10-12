// Runs the trained detectors (ONNX Runtime Web, WebAssembly, one thread) off the main thread.
// Messages in : {id, type: 'load', key} | {id, type: 'score', key, texts: string[]}
// Messages out: {type: 'progress', key, loaded, total, stage} | {id, ok: true, ...} | {id, error}
import * as ort from '../vendor/ort.wasm.min.mjs';
import { Tokenizer } from '../vendor/tokenizers.min.mjs';

const ROOT = new URL('../', import.meta.url);
const CACHE = 'answer-desk-models-v1';
const WINDOW = 510;  // content tokens per window ([CLS] and [SEP] make 512)
const STRIDE = 384;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: new URL('vendor/ort-wasm-simd-threaded.mjs', ROOT).href,
  wasm: new URL('vendor/ort-wasm-simd-threaded.wasm', ROOT).href,
};

let manifest = null;
let latestRun = 0;   // score requests from older checks are dropped when they reach the front of the queue
const loaded = new Map();   // key -> {session, tokenizer, spec}
const loading = new Map();  // key -> Promise

const post = (m) => self.postMessage(m);

// ONNX Runtime work (creating sessions, running them) goes through one queue; downloads do not.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }
}

// Fetch one file, from the browser cache when present, reporting byte progress.
async function fetchFile(rel, onBytes) {
  const url = new URL(rel, ROOT).href;
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onBytes(b.length); return b; }
    } catch { /* fall through to network */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${rel} (HTTP ${res.status}).`);
  // A compressed response (some static hosts gzip .wasm and .json) gives the compressed length,
  // while the body arrives decompressed, so the length check only applies to uncompressed responses.
  const enc = (res.headers.get('content-encoding') || 'identity').toLowerCase();
  const len = enc === 'identity' ? Number(res.headers.get('content-length')) || 0 : 0;
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.length; onBytes(value.length);
    }
    bytes = new Uint8Array(n); let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer()); onBytes(bytes.length);
  }
  if (len && bytes.length !== len) throw new Error(`Download of ${rel} was cut short.`);
  if (cache) { try { await cache.put(url, new Response(bytes.slice())); } catch { /* storage full or blocked: keep going */ } }
  return bytes;
}

async function forget(rels) {
  const cache = await openCache();
  if (!cache) return;
  for (const r of rels) { try { await cache.delete(new URL(r, ROOT).href); } catch { /* ignore */ } }
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function getManifest() {
  if (!manifest) {
    const res = await fetch(new URL('models/manifest.json', ROOT));
    if (!res.ok) throw new Error('Model list is missing (models/manifest.json).');
    manifest = await res.json();
  }
  return manifest;
}

async function loadModelBytes(spec, key) {
  const rels = spec.parts.map((p) => `models/${key}/${p}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let got = 0;
    const tick = (n) => { got += n; post({ type: 'progress', key, loaded: got, total: spec.size, stage: 'download' }); };
    const parts = [];
    for (const r of rels) parts.push(await fetchFile(r, tick));
    const bytes = new Uint8Array(spec.size);
    let o = 0;
    for (const p of parts) {
      if (o + p.length > bytes.length) { o = -1; break; }
      bytes.set(p, o); o += p.length;
    }
    post({ type: 'progress', key, loaded: spec.size, total: spec.size, stage: 'verify' });
    if (o === spec.size && (await sha256Hex(bytes)) === spec.sha256) return bytes;
    await forget(rels);  // corrupted or stale copy: drop it and download again once
  }
  throw new Error('The model file failed its integrity check twice. Check your connection and try again.');
}

async function load(key) {
  if (loaded.has(key)) return loaded.get(key);
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    const m = await getManifest();
    const spec = m.models[key];
    if (!spec) throw new Error(`Unknown checker: ${key}`);
    const [tj, tc] = await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async (f) => {
      const b = await fetchFile(`models/${key}/${f}`, () => {});
      return JSON.parse(new TextDecoder().decode(b));
    }));
    const tokenizer = new Tokenizer(tj, tc);
    let bytes = await loadModelBytes(spec, key);
    post({ type: 'progress', key, loaded: spec.size, total: spec.size, stage: 'start' });
    const session = await serial(() => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
    bytes = null;
    const entry = { session, tokenizer, spec };
    loaded.set(key, entry);
    return entry;
  })();
  loading.set(key, p);
  try { return await p; } finally { loading.delete(key); }
}

function windows(ids) {
  const out = [];
  if (ids.length === 0) return [[]];
  for (let start = 0; ; start += STRIDE) {
    out.push(ids.slice(start, start + WINDOW));
    if (start + WINDOW >= ids.length) break;
  }
  return out;
}

async function aiProb(entry, ids) {
  const { session, spec } = entry;
  const x = [spec.cls_id, ...ids, spec.sep_id];
  const n = x.length;
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(x, BigInt), [1, n]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
  };
  const out = await session.run(feeds);
  const lg = out.logits.data;
  // BERT-tiny-RAID outputs one "human" logit; the others output [human, AI] logits.
  return spec.output === 'sigmoid_human' ? 1 - 1 / (1 + Math.exp(-lg[0])) : 1 / (1 + Math.exp(lg[0] - lg[1]));
}

async function score(key, texts, run) {
  const entry = await load(key);
  return serial(() => scoreAll(entry, texts, run));
}

async function scoreAll(entry, texts, run) {
  const probs = [];
  for (const t of texts) {
    if (run && run < latestRun) throw new Error('superseded');
    const ids = entry.tokenizer.encode(t, { add_special_tokens: false }).ids;
    const ws = windows(ids);
    let sum = 0, wsum = 0;
    for (const w of ws) {
      const p = await aiProb(entry, w);
      const weight = Math.max(1, w.length);
      sum += p * weight; wsum += weight;
    }
    probs.push(sum / wsum);
  }
  return probs;
}

self.onmessage = async (e) => {
  const { id, type, key, texts, run } = e.data || {};
  if (run && run > latestRun) latestRun = run;
  try {
    if (type === 'manifest') {
      post({ id, ok: true, manifest: await getManifest() });
    } else if (type === 'load') {
      const t0 = performance.now();
      await load(key);
      post({ id, ok: true, ms: performance.now() - t0 });
    } else if (type === 'score') {
      const t0 = performance.now();
      const probs = await score(key, texts, run);
      post({ id, ok: true, probs, ms: performance.now() - t0 });
    } else {
      post({ id, error: `Unknown request: ${type}` });
    }
  } catch (err) {
    post({ id, error: (err && err.message) || String(err) });
  }
};
