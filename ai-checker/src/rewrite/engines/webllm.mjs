// In-browser rewriter: Qwen3 through @mlc-ai/web-llm (Apache-2.0, vendored in vendor/web-llm/) on
// WebGPU, running in a module worker (workers/llm.mjs) so the page stays responsive. Picks the
// largest prebuilt Qwen3 (8B -> 4B -> 1.7B) the device can hold, with thinking turned off.
// Browser APIs used: navigator.gpu, Worker, dynamic import of the vendored library.
import { abortError } from '../loop.mjs';

export const WEBLLM_VERSION = '0.2.86';
// From web-llm 0.2.86's prebuiltAppConfig (vram_required_MB, 4k context). generate() re-reads the
// vendored library's own list, so this copy only serves probe() without loading 6.8 MB.
export const QWEN3_MODELS = Object.freeze([
  { model_id: 'Qwen3-8B-q4f16_1-MLC', vram_required_MB: 5695.78 },
  { model_id: 'Qwen3-8B-q4f32_1-MLC', vram_required_MB: 6852.55 },
  { model_id: 'Qwen3-4B-q4f16_1-MLC', vram_required_MB: 3431.59 },
  { model_id: 'Qwen3-4B-q4f32_1-MLC', vram_required_MB: 4327.71 },
  { model_id: 'Qwen3-1.7B-q4f16_1-MLC', vram_required_MB: 2036.66 },
  { model_id: 'Qwen3-1.7B-q4f32_1-MLC', vram_required_MB: 2635.44 },
].map(Object.freeze));
export const SIZES = ['8B', '4B', '1.7B'];
const QWEN3_ID = /^Qwen3-(\d+(?:\.\d+)?B)-(q4f16_1|q4f32_1)-MLC$/;
const MB = 1024 * 1024;
// WebGPU does not report graphics memory. A model fits when it needs at most twice the largest
// buffer the adapter allows and half the device memory the browser reports (Chrome caps that at
// 8 GB, so 8B needs a browser that reports 16 GB). Unknown memory counts as 8 GB.
export const FIT = Object.freeze({ bufferFactor: 2, memoryShare: 0.5, unknownMemoryGB: 8, minBufferMB: 256, minBindingMB: 128 });
const CHAT = { temperature: 0.8, top_p: 0.95, maxTokens: 400 };
const MAX_N = 16;

const str = (v) => (v == null ? '' : String(v));
export const modelLabel = (id) => str(id).replace(/-MLC$/, '').replace(/-q\d+f\d+(?:_\d+)?$/, '').replace(/^Qwen3-/, 'Qwen3 ');
const vramOf = (r) => Number(r?.vram_required_MB);
const gb = (mb) => `${(Math.ceil(mb / 102.4) / 10).toFixed(1)} GB`;

export class EngineError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'EngineError'; this.code = code; if (cause !== undefined) this.cause = cause; }
}

// The WebGPU facts chooseModel needs, from a GPUAdapter (and navigator.deviceMemory).
export function readLimits(adapter, nav = globalThis.navigator) {
  const lim = adapter?.limits || {}, info = adapter?.info || {};
  return {
    maxBufferSize: lim.maxBufferSize, maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
    shaderF16: !!adapter?.features?.has?.('shader-f16'),
    isFallbackAdapter: !!(info.isFallbackAdapter ?? adapter?.isFallbackAdapter),
    deviceMemory: nav?.deviceMemory, vendor: info.vendor || '',
  };
}

// The Qwen3 sizes web-llm offers in the quantisation this GPU can run, largest first.
function qwenList(configList, f16) {
  const quant = f16 ? 'q4f16_1' : 'q4f32_1';
  return [].concat(configList ?? []).map((r) => ({ r, m: QWEN3_ID.exec(str(r?.model_id)) }))
    .filter((x) => x.m && x.m[2] === quant && SIZES.includes(x.m[1]) && vramOf(x.r) > 0)
    .sort((a, b) => parseFloat(b.m[1]) - parseFloat(a.m[1])).map((x) => x.r);
}

// -> {model: id | null, vramMB, budgetMB, fits, reason, override}. Pure, so it is unit tested.
// limits: {maxBufferSize, maxStorageBufferBindingSize (bytes), shaderF16, isFallbackAdapter,
// deviceMemory (GB), vramMB (an explicit figure that replaces the estimate)}.
// override: a model id from configList, or a size ('8B', '4B', '1.7B').
export function chooseModel(limits = {}, configList = QWEN3_MODELS, { override } = {}) {
  const l = limits || {};
  const list = qwenList(configList, l.shaderF16 === true);
  const bufMB = Number(l.maxBufferSize) / MB, bindMB = Number(l.maxStorageBufferBindingSize) / MB;
  let budget = Number(l.vramMB) > 0 ? Number(l.vramMB) : Infinity;
  if (budget === Infinity) {
    if (bufMB > 0) budget = bufMB * FIT.bufferFactor;
    const mem = Number(l.deviceMemory) > 0 ? Number(l.deviceMemory) : FIT.unknownMemoryGB;
    budget = Math.min(budget, mem * 1024 * FIT.memoryShare);
  }
  const res = (model, reason, extra = {}) => ({ model: model ? model.model_id : null, vramMB: model ? vramOf(model) : null,
    budgetMB: Math.round(budget), fits: !!model && vramOf(model) <= budget, reason, override: false, ...extra });

  const ov = str(override).trim();
  if (ov) {
    const all = [].concat(configList ?? []).filter((r) => r && typeof r.model_id === 'string');
    const size = /^(\d+(?:\.\d+)?)\s*b?$/i.exec(ov);
    const hit = all.find((r) => r.model_id.toLowerCase() === ov.toLowerCase())
      || (size && list.find((r) => QWEN3_ID.exec(r.model_id)[1].toLowerCase() === `${size[1]}b`));
    if (hit) return res(hit, `${modelLabel(hit.model_id)} was chosen by hand.`, { override: true });
  }
  if (l.isFallbackAdapter) return res(null, 'WebGPU here runs on the processor, not a graphics card, which is far too slow for a language model.');
  if (bufMB > 0 && bufMB < FIT.minBufferMB) return res(null, 'This graphics card’s WebGPU limits are too small for the in-browser model.');
  if (bindMB > 0 && bindMB < FIT.minBindingMB) return res(null, 'This graphics card’s WebGPU limits are too small for the in-browser model.');
  if (!list.length) return res(null, 'This copy of WebLLM has no Qwen3 model for this graphics card.');
  const pick = list.find((r) => vramOf(r) <= budget);
  if (!pick) {
    const small = list[list.length - 1];
    return res(null, `This device does not have enough graphics memory for the smallest in-browser model (${modelLabel(small.model_id)} needs about ${gb(vramOf(small))}).`);
  }
  return res(pick, `${modelLabel(pick.model_id)} fits this device (needs about ${gb(vramOf(pick))}).`);
}

// Same-quantisation models smaller than `id`, to retry with when the GPU runs out of memory.
export function smallerModels(id, configList = QWEN3_MODELS) {
  const m = QWEN3_ID.exec(str(id));
  if (!m) return [];
  return qwenList(configList, m[2] === 'q4f16_1').filter((r) => parseFloat(QWEN3_ID.exec(r.model_id)[1]) < parseFloat(m[1])).map((r) => r.model_id);
}

// Through the worker, web-llm rejects with err.toString() ("DeviceLostError: The WebGPU device…"),
// a plain string, so read the name and message from either form.
const errMsg = (err) => str(typeof err === 'string' ? err : err?.message || err);
const errName = (err) => str(typeof err === 'string' ? (/^([A-Za-z]*Error):/.exec(err) || [])[1] : err?.name);
const isOOM = (err) => errName(err) === 'DeviceLostError' || /device (?:was )?lost|out of memory|\bOOM\b|allocation failed/i.test(errMsg(err));

function friendly(err) {
  if (err instanceof EngineError || err?.name === 'AbortError') return err;
  const msg = errMsg(err);
  if (isOOM(err)) return new EngineError('gpu-memory', 'The graphics card ran out of memory for the in-browser model. Close other tabs and apps, then try again.', err);
  if (errName(err) === 'ShaderF16SupportError' || /shader-f16/i.test(msg)) return new EngineError('gpu-feature', 'This graphics card cannot run the half-precision (q4f16_1) model; use a q4f32_1 model instead.', err);
  // not a bare "storage": WebGPU limit errors name maxStorageBufferBindingSize
  if (/quota|NotAllowedError|caches is not defined|no space left|disk (?:is )?full/i.test(msg)) return new EngineError('storage', 'The browser has no room to keep the model (it needs a few GB of disk). Free some space or allow site storage, then try again.', err);
  if (/failed to fetch|networkerror|network error|load failed|http status|\b40[34]\b/i.test(msg)) return new EngineError('download', 'Could not download the model. Check the connection (some office networks block huggingface.co) and try again.', err);
  // web-llm's ContextWindowSizeExceededError; not "…exceeds limit", which is a WebGPU limit
  if (errName(err) === 'ContextWindowSizeExceededError' || /context window/i.test(msg)) return new EngineError('too-long', 'The request is too long for the in-browser model (4,000 tokens). Try fewer writing samples or a shorter passage.', err);
  return new EngineError('webllm', `The in-browser model failed: ${msg}`, err);
}

// Resolve with p, but reject at once when `signal` aborts (running onAbort first). p's late
// result or rejection is swallowed.
function untilAborted(p, signal, onAbort) {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const stop = () => { try { onAbort?.(); } catch { /* ignore */ } reject(abortError(signal)); };
    if (signal.aborted) { Promise.resolve(p).catch(() => {}); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(p).then((v) => { signal.removeEventListener('abort', stop); if (signal.aborted) return; resolve(v); },
      (e) => { signal.removeEventListener('abort', stop); if (signal.aborted) return; reject(e); });
  });
}

// A worker whose script fails to load (or that crashes) never answers web-llm's messages: reject
// instead of waiting for ever.
function workerFailed(worker) {
  const p = new Promise((_, reject) => {
    const fail = (e) => {
      e?.preventDefault?.();
      reject(new EngineError('worker', `The in-browser model could not start in this browser${e?.message ? ` (${e.message})` : ''}. Reload the page and try again.`));
    };
    worker?.addEventListener?.('error', fail, { once: true });
    worker?.addEventListener?.('messageerror', fail, { once: true });
  });
  p.catch(() => {});
  return p;
}

// A promise that rejects when fired: a terminated worker never answers, so whoever waits on it
// (a load, a version being written) must be released this way.
function halter() {
  let fire;
  const p = new Promise((_, reject) => { fire = () => reject(new EngineError('stopped', 'The in-browser model was stopped.')); });
  p.catch(() => {});
  return { p, fire };
}

export function createWebLLMEngine(opts = {}) {
  // gen counts resets: a load that was stopped must not touch the state of a later one
  const st = { override: opts.model || null, engine: null, modelId: null, worker: null, loading: null, halt: halter(), gen: 0 };
  const gpu = () => ('gpu' in opts ? opts.gpu : globalThis.navigator?.gpu);
  const nav = () => ('navigator' in opts ? opts.navigator : globalThis.navigator);
  const loadLib = opts.loadLib || (() => import('../../../vendor/web-llm/index.js'));
  const makeWorker = opts.makeWorker || (() => new Worker(new URL('../../../workers/llm.mjs', import.meta.url), { type: 'module' }));

  async function limits() {
    const g = gpu();
    if (!g || typeof g.requestAdapter !== 'function') {
      throw new EngineError('no-webgpu', 'This browser has no WebGPU, which the in-browser model needs. Use a current Chrome or Edge on a laptop or desktop (Safari 26 also works).');
    }
    let adapter = null;
    try { adapter = await g.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* reported below */ }
    if (!adapter) throw new EngineError('no-adapter', 'WebGPU is present but no graphics card is available to it (it may be blocked or switched off). In Chrome, chrome://gpu shows why.');
    return readLimits(adapter, nav());
  }

  async function probe() {
    try {
      const lim = await limits();
      if (!opts.makeWorker && typeof Worker === 'undefined') throw new EngineError('no-worker', 'This browser cannot run the in-browser model (no module workers).');
      const c = chooseModel(lim, QWEN3_MODELS, { override: st.override });
      // what is loaded may be smaller than the first choice (it did not fit), and it works
      if (st.engine && st.modelId) return { ok: true, code: 'ok', model: st.modelId, budgetMB: c.budgetMB, detail: `${modelLabel(st.modelId)} runs in this browser. Loaded and ready.` };
      if (!c.model) return { ok: false, code: 'too-small', detail: c.reason };
      const warn = c.override && !c.fits ? ' It may not fit this device.' : '';
      return { ok: true, code: 'ok', model: c.model, budgetMB: c.budgetMB,
        detail: `${c.reason}${warn} The first use downloads it once and keeps it.` };
    } catch (err) {
      return { ok: false, code: err?.code || 'webllm', detail: str(err?.message || err) };
    }
  }

  // Download/compile progress, at most one log line per 10% of each stage.
  function progressReporter(report, id) {
    let last = '';
    return (r) => {
      const p = Math.max(0, Math.min(1, Number(r?.progress) || 0));
      const stage = /fetch|download/i.test(str(r?.text)) ? 'download' : 'load';
      const key = `${stage}:${Math.floor(p * 10)}`;
      const ev = { stage, progress: p, text: str(r?.text) };
      if (key !== last) { last = key; ev.message = `${stage === 'download' ? 'Downloading' : 'Loading'} ${modelLabel(id)}: ${Math.round(p * 100)}%`; }
      report(ev);
    };
  }

  function reset() {
    try { st.worker?.terminate?.(); } catch { /* ignore */ }
    const halt = st.halt;
    st.worker = null; st.engine = null; st.modelId = null; st.loading = null; st.halt = halter(); st.gen++;
    halt.fire();
  }

  async function load(onReport) {
    const gen = st.gen, alive = () => gen === st.gen;
    const stopped = () => new EngineError('stopped', 'The in-browser model was stopped.');
    const report = (p) => { if (alive()) onReport(p); };
    const lim = await limits();
    const lib = await loadLib();
    if (!alive()) throw stopped();
    const list = lib?.prebuiltAppConfig?.model_list || QWEN3_MODELS;
    const c = chooseModel(lim, list, { override: st.override });
    if (!c.model) throw new EngineError('too-small', c.reason);
    const order = [c.model, ...smallerModels(c.model, list)];
    for (let k = 0; k < order.length; k++) {
      const id = order[k];
      let worker;
      try { worker = makeWorker(); } catch (err) { throw friendly(err); }
      st.worker = worker;
      report({ stage: 'load', progress: 0, message: `Starting ${modelLabel(id)} in this browser…` });
      try {
        const eng = await Promise.race([
          lib.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: progressReporter(report, id), appConfig: lib.prebuiltAppConfig }),
          workerFailed(worker),
        ]);
        if (!alive()) throw stopped();
        st.engine = eng; st.modelId = id;
        return eng;
      } catch (err) {
        try { worker.terminate?.(); } catch { /* ignore */ }
        if (!alive()) throw stopped();
        st.worker = null;
        if (!isOOM(err) || k === order.length - 1) throw friendly(err);
        report({ stage: 'load', message: `${modelLabel(id)} did not fit in graphics memory; trying ${modelLabel(order[k + 1])}.` });
      }
    }
    throw new EngineError('too-small', 'No in-browser model fits this device.');
  }

  async function ready(report, signal) {
    if (st.engine) return st.engine;
    if (!st.loading) {
      const p = Promise.race([load(report), st.halt.p]);
      st.loading = p;
      p.catch(() => { if (st.loading === p) st.loading = null; });
    }
    // stopping mid-download ends the worker; the files already fetched stay in the browser cache
    return untilAborted(st.loading, signal, reset);
  }

  function request(req) {
    const messages = [];
    if (str(req.system).trim()) messages.push({ role: 'system', content: str(req.system) });
    messages.push({ role: 'user', content: str(req.user) });
    return {
      messages, n: 1, stream: false, top_p: CHAT.top_p,
      temperature: Number.isFinite(req.temperature) ? req.temperature : CHAT.temperature,
      max_tokens: Math.max(16, Math.min(2048, Math.trunc(Number(req.maxTokens)) || CHAT.maxTokens)),
      extra_body: { enable_thinking: false },  // web-llm's Qwen3 switch: an empty think block, no reasoning
    };
  }

  async function generate(requests, { signal, onProgress } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const reqs = [].concat(requests ?? []);
    if (!reqs.length) return [];
    const report = (p) => { try { onProgress?.(p); } catch { /* the page's logger must not stop a rewrite */ } };
    const eng = await ready(report, signal);
    const halt = st.halt, id = st.modelId;
    const count = (r) => Math.max(1, Math.min(MAX_N, Math.trunc(Number(r?.n)) || 1));
    const total = reqs.reduce((a, r) => a + count(r), 0);
    const out = reqs.map(() => []);
    let done = 0, good = 0, failed = 0, firstErr = null;
    report({ stage: 'generate', done, total, message: `Writing ${total} version${total === 1 ? '' : 's'} with ${modelLabel(id)} in this browser…` });
    outer: for (let k = 0; k < reqs.length; k++) {
      const req = reqs[k];
      for (let c = 0; c < count(req); c++) {
        if (signal?.aborted) throw abortError(signal);
        if (!req || typeof req !== 'object' || !str(req.user).trim()) { failed++; done++; continue; }
        try {
          const res = await untilAborted(Promise.race([eng.chat.completions.create(request(req)), halt.p]), signal, () => eng.interruptGenerate?.());
          const t = res?.choices?.[0]?.message?.content;
          if (typeof t === 'string' && t.trim()) { out[k].push(t.trim()); good++; } else failed++;
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw abortError(signal);
          if (err?.code === 'stopped') throw err;  // unloaded or switched model while writing
          failed++;
          firstErr = firstErr || err;
          if (isOOM(err)) { reset(); break outer; }  // the GPU device is gone: nothing more will run
        }
        done++;
        report({ stage: 'generate', done, total });
      }
    }
    if (!good && firstErr) throw friendly(firstErr);
    if (failed) report({ stage: 'generate', done, total, message: `${failed} of ${total} version${total === 1 ? '' : 's'} could not be written and ${failed === 1 ? 'was' : 'were'} skipped.` });
    return out;
  }

  return {
    id: 'webllm',
    label: 'In-browser model (Qwen3)',
    probe,
    generate,
    // model: a web-llm model id or a size ('8B', '4B', '1.7B'); empty for automatic
    configure({ model } = {}) {
      const next = str(model).trim() || null;
      if (next !== st.override) { st.override = next; if (st.engine || st.loading) reset(); }
    },
    // ending the worker frees the graphics memory; the downloaded files stay cached
    unload() { reset(); },
    get model() { return st.modelId; },
  };
}

export const engine = createWebLLMEngine();
export default engine;
