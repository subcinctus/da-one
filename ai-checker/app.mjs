// Answer Rewrite Desk — main page logic.
// Checkers run in two workers (ZipPy, and the ONNX models); rewrites go through the Claude
// `sample` capability when the page runs inside Claude, or a copy/paste fallback elsewhere.

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const K = { draft: 'ard.draft', versions: 'ard.versions', voice: 'ard.voice', heavy: 'ard.heavy', seen: 'ard.seenExample' };

const DEFAULT_VOICE = 'Senior retail-lending executive in India with 30 years of experience (mortgages, sales, credit, collections). '
  + 'Writes plain, direct business English: short and medium sentences, concrete numbers and examples from practice, '
  + 'first person where it fits, no buzzwords.';

const EXAMPLE = `In today's dynamic lending landscape, growing a retail mortgage book requires a holistic approach that balances ambition with prudence. First and foremost, it is important to leverage data-driven underwriting to identify creditworthy segments, particularly in Tier 2 and Tier 3 cities where demand for affordable housing continues to rise. Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role in sourcing quality customers at scale.

Furthermore, robust early-warning systems and proactive collection strategies are crucial to keeping GNPA below 1.5%. By seamlessly integrating technology across the loan lifecycle, from sourcing to disbursement and servicing, lenders can reduce turnaround time while enhancing the overall customer experience. Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise that delivers long-term value for all stakeholders.`;

// ---------- checkers ----------
const CHECKERS = [
  { key: 'modernbert-raid-mage', name: 'ModernBERT detector', short: 'ModernBERT', kind: 'model', heavy: true,
    src: 'UCL research, EMNLP 2025', raid: '99.1% caught, 94.1% under attacks',
    about: 'Drayson, Yilmaz and Lampos (University College London) fine-tuned ModernBERT on the RAID and MAGE datasets. The strongest open-source checker that fits in a browser.',
    links: [['Paper', 'https://aclanthology.org/2025.emnlp-main.1506/'], ['GitHub', 'https://github.com/GeorgeDrayson/model_collapse']] },
  { key: 'e5-small-lora', name: 'e5-small LoRA', short: 'e5-small', kind: 'model',
    src: 'RAID leaderboard entry, MIT licence', raid: '93.9% caught, 85.7% under attacks',
    about: 'A 33M-parameter e5-small model fine-tuned with LoRA on RAID training data. Fast enough to score each sentence.',
    links: [['GitHub', 'https://github.com/menglinzhou/microsoft-hackathon-24']] },
  { key: 'bert-tiny-raid', name: 'BERT-tiny RAID', short: 'BERT-tiny', kind: 'model',
    src: 'RAID leaderboard entry, MIT licence', raid: '91.1% caught, 84.2% under attacks',
    about: 'A 4M-parameter BERT trained on a stratified sample of RAID. Very small and quick, so it is the first to finish.',
    links: [['RAID leaderboard', 'https://raid-bench.xyz/leaderboard']] },
  { key: 'zippy', name: 'ZipPy', short: 'ZipPy', kind: 'zippy',
    src: 'Thinkst Applied Research, MIT licence', raid: 'not on RAID; weakest of the four',
    about: 'Measures how well your text compresses together with a corpus of AI-written text. This is a faithful port of Thinkst’s own browser build and gives identical scores.',
    links: [['GitHub', 'https://github.com/thinkst/zippy']] },
];
const MODEL_KEYS = CHECKERS.filter((c) => c.kind === 'model').map((c) => c.key);

// ---------- state ----------
const state = {
  manifest: null,
  ready: {},          // key -> 'idle' | 'loading' | 'ready' | 'error'
  readyPromise: {},   // key -> Promise
  progress: {},       // key -> {loaded, total, stage}
  loadError: {},
  results: {},        // key -> {status, prob, pct, ms, error, text}
  lastCheck: null,    // {text, risk, at, words}
  prevRisk: null,
  sentences: [],      // [{start, end, text, heat}]
  hints: [],
  runId: 0,
  sample: null,       // Claude sample function, or null
  undo: [],
  focusSentence: -1,
  sentPending: false,
  mode: 'article',    // the human reference the scores are compared with (professional writing)
};

// ---------- workers ----------
function rpcWorker(url, opts) {
  let w = null, n = 0;
  const pending = new Map();
  const listeners = [];
  const start = () => {
    w = new Worker(url, opts);
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { listeners.forEach((f) => f(m)); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    };
    w.onerror = (e) => {
      const msg = e.message || 'The checker stopped unexpectedly.';
      for (const p of pending.values()) p.reject(new Error(msg));
      pending.clear();
      e.preventDefault?.();
      try { w.terminate(); } catch { /* ignore */ }
      w = null;  // the next call starts a fresh worker
    };
  };
  return {
    call(msg) {
      if (!w) start();
      return new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); w.postMessage({ ...msg, id }); });
    },
    onProgress(f) { listeners.push(f); },
    restart() { try { w?.terminate(); } catch { /* ignore */ } w = null; for (const p of pending.values()) p.reject(new Error('restarted')); pending.clear(); },
  };
}
const modelWorker = rpcWorker(new URL('workers/models.mjs', location.href), { type: 'module' });
const zippyWorker = rpcWorker(new URL('workers/zippy.js', location.href));
modelWorker.onProgress((m) => { state.progress[m.key] = m; renderLedger(); renderPills(); });

function heavyEnabled() {
  const saved = store.get(K.heavy, null);
  if (saved !== null) return saved;
  const small = matchMedia('(max-width: 700px)').matches;
  const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  return !(small || lowMem);
}

function ensureReady(key) {
  if (state.readyPromise[key]) return state.readyPromise[key];
  state.ready[key] = 'loading';
  renderPills(); renderLedger();
  const p = (key === 'zippy' ? Promise.resolve() : modelWorker.call({ type: 'load', key }))
    .then(() => { state.ready[key] = 'ready'; delete state.loadError[key]; })
    .catch((err) => {
      state.ready[key] = 'error';
      state.loadError[key] = friendlyLoadError(err);
      delete state.readyPromise[key];
      throw err;
    })
    .finally(() => { renderPills(); renderLedger(); });
  state.readyPromise[key] = p;
  return p;
}

function friendlyLoadError(err) {
  const m = String(err?.message || err);
  if (/HTTP \d|Could not download|cut short|Failed to fetch|NetworkError|network error|Load failed/i.test(m)) return 'The download failed. Check your connection and press Retry.';
  if (/CompileError|WebAssembly|wasm/i.test(m)) return 'This browser blocked WebAssembly, which this checker needs. Try Chrome, Edge or Safari.';
  if (/integrity/i.test(m)) return m;
  if (/memory|allocation|Out of memory/i.test(m)) return 'Not enough memory on this device. Turn off ModernBERT in Settings.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}

async function warmUp() {
  state.ready.zippy = 'ready';
  try {
    const r = await modelWorker.call({ type: 'manifest' });
    state.manifest = r.manifest;
    state.mode = state.manifest.calibration?.default_mode || 'article';
    renderCalibText();
  } catch (err) {
    for (const k of MODEL_KEYS) { state.ready[k] = 'error'; state.loadError[k] = friendlyLoadError(err); }
    renderPills(); renderLedger();
    return;
  }
  state.ready.zippy = 'ready';
  renderPills(); renderLedger();
  // load in the background, smallest first; checks start as soon as each checker is ready
  (async () => {
    const order = ['bert-tiny-raid', 'e5-small-lora'];
    if (heavyEnabled()) order.push('modernbert-raid-mage');
    for (const k of order) { try { await ensureReady(k); } catch { /* shown in the ledger */ } }
  })();
}

// ---------- calibration ----------
// Percentile of a score among human-written calibration samples (0–100), by linear interpolation of quantiles.
function humanPct(q, x) {
  if (!q || !q.length) return null;
  if (x <= q[0]) return 0;
  const n = q.length - 1;
  if (x >= q[n]) return 100;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= x) lo = mid; else hi = mid; }
  const span = q[hi] - q[lo];
  return (100 / n) * (lo + (span > 0 ? (x - q[lo]) / span : 0));
}
// Risk scale shown to the user: typical human writing sits low, the 5%-false-positive line sits at 65.
const RISK_KNOTS = [[0, 0], [50, 15], [80, 30], [90, 40], [95, 65], [99, 85], [100, 100]];
function riskFromPct(p) {
  for (let i = 1; i < RISK_KNOTS.length; i++) {
    const [x0, y0] = RISK_KNOTS[i - 1], [x1, y1] = RISK_KNOTS[i];
    if (p <= x1) return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
  }
  return 100;
}
const band = (r) => (r === null ? 'none' : r >= 65 ? 'high' : r >= 40 ? 'mid' : 'low');
const BAND_LABEL = { high: 'High: likely flagged', mid: 'Medium: could be flagged', low: 'Low: reads human', none: 'Not checked yet' };

const modeCal = () => state.manifest?.calibration?.modes?.[state.mode] || null;

// A checker's score as a percentile of human writing of the chosen kind (null without calibration).
function pctOf(key) {
  const r = state.results[key];
  const cal = modeCal()?.checkers?.[key];
  if (!r || r.status !== 'done' || !cal) return null;
  return humanPct(cal.human_q, r.raw);
}

function ensemble() {
  const cal = modeCal()?.ensemble;
  if (!cal) return null;
  const used = CHECKERS.map((c) => c.key).filter((k) => pctOf(k) !== null);
  // ZipPy alone is too weak to stand for the overall risk; wait for a trained checker
  if (!used.some((k) => k !== 'zippy')) return null;
  const combo = cal.combos[[...used].sort().join('+')];
  if (!combo) return null;
  let s = 0, w = 0;
  for (const k of used) { s += cal.weights[k] * pctOf(k); w += cal.weights[k]; }
  const pct = humanPct(combo.human_q, s / w);
  return { used, pct, risk: Math.round(riskFromPct(pct)), flagged: used.filter((k) => Math.round(pctOf(k)) >= 95) };
}
// A sentence is listed and highlighted from the 90th percentile of human 3-sentence windows (the same
// point where the overall risk turns Medium); "Very AI-like" from the 95th.
const SENT_FLAG = 90;
// Sentence highlights only matter when the answer as a whole looks AI-written.
const sentencesMatter = () => { const e = ensemble(); return !!e && e.risk >= 40; };
// Sentences to work on: those past the line, topped up with the most AI-like of the rest
// (at least two, or about 30% of the answer), so a high-risk answer always shows where to start.
function flaggedSentences() {
  if (!sentencesMatter()) return [];
  const scored = state.sentences.map((s, i) => ({ s, i })).filter((x) => x.s.heat !== null).sort((a, b) => b.s.heat - a.s.heat);
  const want = Math.min(scored.length, Math.max(2, Math.ceil(scored.length * 0.3)));
  const out = scored.filter((x) => x.s.heat >= SENT_FLAG);
  for (const x of scored) { if (out.length >= want) break; if (!out.includes(x)) out.push(x); }
  return out.map((x) => ({ i: x.i, level: x.s.heat >= 95 ? 'high' : x.s.heat >= SENT_FLAG ? 'mid' : 'rel' }));
}

// ---------- text helpers ----------
const words = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function splitSentences(text) {
  const out = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    for (const s of seg.segment(text)) {
      // Intl splits paragraphs too; trim whitespace but keep offsets exact
      const lead = s.segment.length - s.segment.trimStart().length;
      const body = s.segment.trim();
      if (/[\p{L}\p{N}]/u.test(body)) out.push({ start: s.index + lead, end: s.index + lead + body.length, text: body });
    }
  } else {
    const re = /[^.!?\n]+(?:[.!?]+["'’”)\]]*|\n|$)/g;
    let m;
    while ((m = re.exec(text))) {
      const lead = m[0].length - m[0].trimStart().length;
      const body = m[0].trim();
      if (/[\p{L}\p{N}]/u.test(body)) out.push({ start: m.index + lead, end: m.index + lead + body.length, text: body });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

const HINTS = ['delve', 'delves', 'delving', 'tapestry', 'testament to', "in today's", 'in today’s', 'fast-paced world', 'ever-evolving', 'ever-changing',
  'in the realm of', 'navigate the complexities', 'navigating the complexities', 'embark on', 'unlock the', 'unleash', 'game-changer', 'game changer',
  'cutting-edge', 'it is important to note', "it's important to note", 'it’s important to note', 'it is worth noting', 'it is crucial to',
  'plays a crucial role', 'plays a pivotal role', 'plays a vital role', 'pivotal', 'seamless', 'seamlessly', 'holistic', 'multifaceted', 'meticulous',
  'meticulously', 'intricate', 'underscore', 'underscores', 'showcase', 'showcasing', 'foster', 'fostering', 'elevate', 'in conclusion', 'in summary',
  'moreover', 'furthermore', 'additionally', 'first and foremost', 'ultimately', 'a myriad of', 'myriad', 'paramount', 'commendable', 'invaluable',
  'synergy', 'synergies', 'dynamic landscape', 'evolving landscape', 'lending landscape', 'landscape of', 'at the forefront', 'harness the power',
  'resilient franchise', 'all stakeholders', 'not just about', "it's not just", 'it is not just'];
const HINT_RE = new RegExp(`(^|[^\\p{L}])(${HINTS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}])`, 'giu');
function findHints(text) {
  const out = [];
  for (const m of text.matchAll(HINT_RE)) {
    const start = m.index + m[1].length;
    out.push({ start, end: start + m[2].length, text: m[2] });
  }
  return out;
}

// Facts that a rewrite must keep: amounts, percentages, dates, acronyms, names.
function extractFacts(text) {
  const nums = new Map(), terms = new Map();
  const numRe = /(?:₹|Rs\.?\s?|INR\s?|USD\s?|US\$|\$|€|£)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|per\s?cent|percent|bps|x\b|crores?|cr\b|lakhs?|lacs?|mn\b|million|bn\b|billion|thousand|k\b))?/gi;
  for (const m of text.matchAll(numRe)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const norm = raw.toLowerCase().replace(/rs\.?\s?|inr\s?/g, '₹').replace(/us\$|usd\s?/g, '$').replace(/,/g, '').replace(/\s+/g, '')
      .replace(/per\s?cent|percent/g, '%').replace(/crores?|cr$/g, 'crore').replace(/lakhs?|lacs?/g, 'lakh');
    nums.set(norm, raw);
  }
  for (const m of text.matchAll(/\b(?:FY|Q[1-4]|H[12])\s?'?\d{2,4}\b|\b[A-Z][A-Z0-9&]{1,}(?:-[A-Z0-9]+)*s?\b/g)) terms.set(m[0], m[0]);
  // capitalised words that do not start a sentence (names, places, products)
  const re = /[\p{L}][\p{L}'’-]*/gu;
  let prev = '';
  for (const m of text.matchAll(re)) {
    const w = m[0];
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    const starts = m.index === 0 || /[.!?:\n]\s*["“'‘(]?\s*$/.test(before) || /^\s*$/.test(text.slice(0, m.index));
    if (/^\p{Lu}\p{Ll}+/u.test(w) && !starts && w !== 'I' && !/^(I'm|I’ll|I've|I’m|I'd)$/.test(w)) terms.set(w, w);
    prev = w;
  }
  return { nums, terms };
}
function factCheck(before, after) {
  const a = extractFacts(before), b = extractFacts(after);
  const missingNums = [...a.nums.keys()].filter((k) => !b.nums.has(k)).map((k) => a.nums.get(k));
  const addedNums = [...b.nums.keys()].filter((k) => !a.nums.has(k)).map((k) => b.nums.get(k));
  const missingTerms = [...a.terms.keys()].filter((k) => !after.includes(k));
  const paras = (t) => t.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const wa = words(before), wb = words(after);
  return { missingNums, addedNums, missingTerms, parasBefore: paras(before), parasAfter: paras(after), wordsBefore: wa, wordsAfter: wb };
}

// Word-level diff (LCS) for the review dialog.
function diffWords(a, b) {
  const A = a.match(/\s+|[^\s]+/g) || [], B = b.match(/\s+|[^\s]+/g) || [];
  if (A.length * B.length > 9e6) return [{ op: 'del', s: a }, { op: 'ins', s: b }];
  const n = A.length, m = B.length, W = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const out = [];
  const push = (op, s) => { const last = out[out.length - 1]; if (last && last.op === op) last.s += s; else out.push({ op, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out;
}

// ---------- editor ----------
const editor = $('editor'), backdrop = $('backdrop');
function autosize() { editor.style.height = 'auto'; editor.style.height = editor.scrollHeight + 'px'; }

function renderBackdrop() {
  const text = editor.value;
  const marks = [];
  const level = new Map(flaggedSentences().map((f) => [f.i, f.level]));
  state.sentences.forEach((s, i) => {
    const lv = level.get(i);
    if (lv || i === state.focusSentence) marks.push({ start: s.start, end: s.end, cls: `s-${lv === 'high' ? 'high' : lv ? 'mid' : 'plain'}${i === state.focusSentence ? ' s-focus' : ''}`, kind: 'mark' });
  });
  const hints = findHints(text).map((h) => ({ ...h, cls: 'hint', kind: 'span' }));
  // build segments: sentence marks may contain hint spans
  const cuts = new Set([0, text.length]);
  for (const r of [...marks, ...hints]) { cuts.add(r.start); cuts.add(r.end); }
  const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let piece = esc(text.slice(a, b));
    const h = hints.find((r) => r.start <= a && r.end >= b);
    if (h) piece = `<span class="hint">${piece}</span>`;
    const mk = marks.find((r) => r.start <= a && r.end >= b);
    if (mk) piece = `<mark class="${mk.cls}">${piece}</mark>`;
    html += piece;
  }
  backdrop.innerHTML = html + (text.endsWith('\n') ? ' ' : '') + '​';
}

// Keep highlights on sentences that the user has not edited.
function relocateSentences() {
  const text = editor.value;
  let from = 0;
  state.sentences = state.sentences.map((s) => {
    const at = text.indexOf(s.text, Math.max(0, from - 20));
    if (at < 0) return null;
    from = at + s.text.length;
    return { ...s, start: at, end: at + s.text.length };
  }).filter(Boolean);
}

let saveTimer = 0;
function onEdit() {
  autosize();
  const t = editor.value;
  $('wordCount').textContent = words(t).toLocaleString('en-IN');
  $('charCount').textContent = t.length.toLocaleString('en-IN');
  relocateSentences();
  state.hints = findHints(t);
  renderBackdrop(); renderHints(); renderSentences();
  if (state.lastCheck && state.lastCheck.text !== t) markStale(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ok = store.set(K.draft, t);
    $('saveState').textContent = ok ? 'Saved on this device' : 'Not saved: this browser blocks storage';
  }, 350);
}

function setText(t, label) {
  const before = editor.value;
  if (before === t) return;
  state.undo.push({ text: before, label });
  if (state.undo.length > 50) state.undo.shift();
  $('undoBtn').disabled = false;
  editor.focus();
  let done = false;
  try {
    editor.select();
    done = document.execCommand && document.execCommand('insertText', false, t);
  } catch { done = false; }
  if (!done || editor.value !== t) editor.value = t;
  editor.setSelectionRange(0, 0);
  onEdit();
}

// ---------- versions ----------
function snapshot(label, risk = null) {
  const text = editor.value;
  if (!text.trim()) return;
  const list = store.get(K.versions, []);
  if (list[0] && list[0].text === text) { if (risk !== null) { list[0].risk = risk; store.set(K.versions, list); } return; }
  list.unshift({ at: Date.now(), text, words: words(text), risk, label });
  while (list.length > 40) list.pop();
  while (!store.set(K.versions, list) && list.length > 1) list.pop();
}

// ---------- rendering ----------
function renderPills() {
  const el = $('pills');
  el.innerHTML = CHECKERS.map((c) => {
    let st = state.ready[c.key] || 'idle';
    if (c.heavy && !heavyEnabled() && st === 'idle') st = 'off';
    const pr = state.progress[c.key];
    const title = st === 'loading' && pr ? `${c.name}: ${pr.stage === 'download' ? `downloading ${(pr.loaded / 1e6).toFixed(0)} of ${(pr.total / 1e6).toFixed(0)} MB` : 'starting'}`
      : st === 'ready' ? `${c.name} is ready` : st === 'error' ? `${c.name}: ${state.loadError[c.key] || 'failed'}` : st === 'off' ? `${c.name} is off (Settings)` : `${c.name} is waiting`;
    return `<span class="pill" data-state="${st}" title="${esc(title)}"><span class="dot"></span>${esc(c.short)}</span>`;
  }).join('');
}

function fmtPct(p) { const r = Math.round(p); const s = r % 100 >= 11 && r % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[r % 10] || 'th'); return `${r}${s}`; }

function renderLedger() {
  const el = $('ledger');
  el.innerHTML = CHECKERS.map((c) => {
    const r = state.results[c.key];
    const st = state.ready[c.key] || 'idle';
    let val = '<span class="chip none">Waiting</span>', bar = '', prog = '';
    if (c.heavy && !heavyEnabled() && st !== 'ready' && st !== 'loading') {
      val = `<button class="btn quiet" type="button" data-load="${c.key}">Turn on (160 MB)</button>`;
    } else if (st === 'error' && !(r && r.status === 'done')) {
      val = `<button class="btn quiet" type="button" data-retry="${c.key}">Retry</button>`;
      prog = `<div class="prog">${esc(state.loadError[c.key] || 'Could not start this checker.')}</div>`;
    } else if (st === 'loading' && !(r && r.status === 'done')) {
      const pr = state.progress[c.key];
      val = '<span class="chip none">Loading</span>';
      prog = `<div class="prog">${pr ? (pr.stage === 'download' ? `Downloading <span class="num">${(pr.loaded / 1e6).toFixed(1)}</span> of <span class="num">${(pr.total / 1e6).toFixed(1)}</span> MB (one time)` : pr.stage === 'verify' ? 'Checking the download…' : 'Starting…') : 'Starting…'}</div>`;
    }
    const pct = pctOf(c.key);
    if (r) {
      if (r.status === 'running') val = '<span class="chip none">Checking…</span>';
      else if (r.status === 'error') { val = '<span class="chip none">Failed</span>'; prog = `<div class="prog">${esc(r.error)}</div>`; }
      else if (r.status === 'done' && pct !== null) {
        const pr = Math.round(pct);
        const b = pr >= 95 ? 'high' : pr >= 85 ? 'mid' : 'low';
        val = `<span class="num">${fmtPct(pct)}</span> <span class="chip ${b}">${b === 'high' ? 'Flags AI' : b === 'mid' ? 'Borderline' : 'Reads human'}</span>`;
        bar = `<div class="bar" title="More AI-like than ${pr}% of the professional human writing it was compared with"><i class="${b}" style="width:${Math.max(2, pct)}%"></i><b style="left:95%"></b></div>`;
      } else if (r.status === 'done') {
        const ai = c.kind === 'zippy' ? r.determination === 'AI' : r.prob >= 0.5;
        val = `<span class="chip none">${ai ? 'Leans AI' : 'Leans human'} (uncalibrated)</span>`;
      }
    }
    const raw = r && r.status === 'done' ? (c.kind === 'zippy' ? `ZipPy says ${esc(r.determination)} (confidence ${r.score.toFixed(4)})` : `Raw AI probability ${(r.prob * 100).toFixed(1)}%`) + ` · ${(r.ms / 1000).toFixed(1)} s` : '';
    return `<div class="row" data-key="${c.key}">
      <div><div class="name">${esc(c.name)}</div><div class="src">${esc(c.src)}</div></div>
      <div class="val">${val}</div>${bar}${prog}
      <details><summary>Details</summary><p>${esc(c.about)}</p><p>RAID benchmark: ${esc(c.raid)} (at 5% false positives).${raw ? ' ' + raw + '.' : ''}</p>${measuredLine(c.key)}<p>${c.links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ')}</p></details>
    </div>`;
  }).join('');
}

function measuredLine(key) {
  const m = modeCal()?.checkers?.[key]?.measured;
  if (!m) return '';
  return `<p>On its own, on held-out test texts: caught ${Math.round(m.tpr * 100)}% of AI texts and flagged ${Math.round(m.fpr * 100)}% of human ones.</p>`;
}

function renderCalibText() {
  const a = modeCal();
  const el = $('calibText');
  if (!a || !el) return;
  el.textContent = `Scores are compared with ${a.human_samples} pieces of professional human writing: news, academic abstracts, Wikipedia, posts and stories. `
    + `On held-out test texts the combined score flagged ${Math.round(a.measured.tpr * 100)}% of AI-written texts (GPT-4, ChatGPT, Llama, Mistral, Cohere and others) and ${Math.round(a.measured.fpr * 100)}% of human ones. `
    + '"Flags AI" means more AI-like than 95% of that human writing.';
}

function markStale(stale) {
  $('verdictCard').style.opacity = stale ? '.62' : '1';
  if (stale) $('riskSub').textContent = 'The text has changed since the last check. Press Check to update.';
}

function renderVerdict() {
  const e = ensemble();
  const t = state.lastCheck?.text ?? editor.value;
  const w = words(t);
  const warn = $('shortWarn');
  if (w > 0 && w < 150) { warn.hidden = false; warn.textContent = `Only ${w} words. Short answers give less reliable scores; Turnitin will not score anything under 300 words.`; } else warn.hidden = true;
  if (!e) {
    $('riskScore').textContent = '–'; $('riskBand').className = 'band none'; $('riskBand').textContent = state.lastCheck ? 'Waiting for the checkers…' : BAND_LABEL.none;
    $('needle').style.left = '0%'; $('riskDelta').textContent = '';
    if (state.lastCheck) $('riskSub').textContent = 'The checkers download once (about 200 MB in total), then stay in this browser. Results appear as each one finishes.';
    return;
  }
  const b = band(e.risk);
  $('riskScore').textContent = e.risk;
  $('riskBand').className = `band ${b}`; $('riskBand').textContent = BAND_LABEL[b];
  $('needle').style.left = `${e.risk}%`;
  const d = state.prevRisk !== null && state.lastCheck && state.lastCheck.risk !== null ? e.risk - state.prevRisk : null;
  $('riskDelta').textContent = d === null || d === 0 ? '' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs last check`;
  $('riskDelta').className = `delta ${d < 0 ? 'down' : d > 0 ? 'up' : ''}`;
  const total = CHECKERS.filter((c) => state.results[c.key]?.status === 'done').length;
  const pending = CHECKERS.filter((c) => state.results[c.key]?.status === 'running' || (state.ready[c.key] === 'loading' && state.results[c.key]?.status !== 'done')).length;
  $('riskSub').textContent = `${e.flagged.length} of ${total} checkers flag this answer as AI-written, compared with professional human writing.${pending ? ' More results are coming.' : ''}`
    + (state.lastCheck ? ` ${w.toLocaleString('en-IN')} words.` : '');
}

function renderSentences() {
  const el = $('sentList');
  const flagged = flaggedSentences().map((f) => ({ ...state.sentences[f.i], i: f.i, level: f.level }));
  if (!state.lastCheck) { el.innerHTML = '<p class="empty">Flagged sentences appear here after a check.</p>'; return; }
  if (!flagged.length && state.sentPending) { el.innerHTML = '<p class="empty">Scoring each sentence…</p>'; return; }
  const e = ensemble();
  if (e && e.risk < 40) { el.innerHTML = '<p class="empty">Nothing to rewrite: the answer as a whole reads as human-written.</p>'; return; }
  if (!flagged.length) {
    el.innerHTML = state.sentences.some((s) => s.heat !== null) ? '<p class="empty">No sentence stands out. If the overall risk is still high, try Rephrase all, or edit the opening and closing lines by hand.</p>'
      : '<p class="empty">Sentence scores need e5-small and BERT-tiny. They appear once those checkers have run.</p>';
    return;
  }
  el.innerHTML = flagged.slice(0, 12).map((s) => {
    const b = s.level === 'high' ? 'high' : 'mid';
    const label = s.level === 'high' ? 'Very AI-like' : s.level === 'mid' ? 'Somewhat AI-like' : 'More AI-like than the rest';
    return `<div class="sent${s.i === state.focusSentence ? ' focus' : ''}" data-i="${s.i}">
      <q>${esc(s.text)}</q>
      <div class="acts"><span class="chip ${b}">${label}</span>
      <button class="btn quiet" type="button" data-act="select">Edit by hand</button>
      <button class="btn" type="button" data-act="suggest">Suggest rewrites</button></div>
      <div class="sugg" data-sugg></div>
    </div>`;
  }).join('');
}

function renderHints() {
  const el = $('hintList');
  const counts = new Map();
  for (const h of state.hints) { const k = h.text.toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); }
  el.innerHTML = counts.size ? [...counts.entries()].map(([k, n]) => `<button type="button" data-hint="${esc(k)}">${esc(k)}${n > 1 ? ` ×${n}` : ''}</button>`).join('') : '<span class="empty">None found.</span>';
}

// ---------- checking ----------
async function runCheck() {
  const text = editor.value;
  if (!text.trim()) { toast('Paste or type an answer first.'); editor.focus(); return; }
  const run = ++state.runId;
  if (state.lastCheck && state.lastCheck.risk !== null) state.prevRisk = state.lastCheck.risk;
  state.lastCheck = { text, risk: null, at: Date.now(), words: words(text) };
  snapshot('Checked');
  markStale(false);
  state.results = {};
  state.sentences = splitSentences(text).map((s) => ({ ...s, heat: null }));
  state.focusSentence = -1;
  renderBackdrop(); renderSentences(); renderVerdict(); renderLedger();
  setChecking(true);
  try {
    await runCheckInner(run, text);
  } finally {
    if (run === state.runId) setChecking(false);
  }
}

function setChecking(on) {
  $('checkBtn').firstChild.nodeValue = on ? 'Checking… ' : 'Check ';
  $('checkBtn').setAttribute('aria-busy', on ? 'true' : 'false');
}

async function runCheckInner(run, text) {
  const live = () => run === state.runId && editor.value === text;
  const finish = (key, r) => { if (run !== state.runId) return; state.results[key] = r; renderLedger(); renderVerdict(); renderSentences(); renderBackdrop(); };

  const zp = (async () => {
    finish('zippy', { status: 'running' });
    try {
      const r = await zippyWorker.call({ type: 'score', text });
      const signed = r.determination === 'AI' ? r.score : -r.score;
      finish('zippy', { status: 'done', determination: r.determination, score: r.score, prob: null, raw: signed, ms: r.ms });
    } catch (err) { finish('zippy', { status: 'error', error: friendlyLoadError(err) }); }
  })();

  const scoreDoc = async (key) => {
    finish(key, { status: 'running' });
    try {
      const r = await modelWorker.call({ type: 'score', key, texts: [text], run });
      finish(key, { status: 'done', prob: r.probs[0], raw: r.probs[0], ms: r.ms });
    } catch (err) {
      if (run === state.runId) finish(key, { status: 'error', error: friendlyLoadError(err) });
    }
  };
  const later = [];
  const models = (async () => {
    for (const key of ['bert-tiny-raid', 'e5-small-lora', 'modernbert-raid-mage']) {
      if (key === 'modernbert-raid-mage' && !heavyEnabled() && state.ready[key] !== 'ready') continue;
      if (state.ready[key] !== 'ready') { later.push(key); continue; }
      if (run !== state.runId) return;
      if (key === 'modernbert-raid-mage') await scoreSentences(run, text);  // sentences first: they use the two small checkers
      await scoreDoc(key);
    }
    if (state.sentPending === false && !state.sentences.some((x) => x.heat !== null)) await scoreSentences(run, text);
  })();

  await Promise.all([zp, models]);
  if (run !== state.runId) return;
  setChecking(false);
  settle(run);
  if (!live()) markStale(true);
  // checkers still downloading add their result when they are ready (smallest first), if the text has not changed
  (async () => {
    for (const key of later) {
      try { await ensureReady(key); } catch { continue; }
      if (!live()) return;
      await scoreDoc(key);
      if (key !== 'modernbert-raid-mage' && live()) await scoreSentences(run, text);
      settle(run);
    }
  })();
}

function settle(run) {
  if (run !== state.runId) return;
  const e = ensemble();
  if (e) { state.lastCheck.risk = e.risk; snapshot('Checked', e.risk); }
  renderVerdict(); renderLedger();
}

// Sentence heat: score 3-sentence windows with e5-small and BERT-tiny, average the human percentiles.
async function scoreSentences(run, text) {
  state.sentPending = true; renderSentences();
  try { await scoreSentencesInner(run, text); } finally { if (run === state.runId) { state.sentPending = false; renderSentences(); } }
}
async function scoreSentencesInner(run, text) {
  const S = state.sentences;
  if (!S.length || !state.manifest?.calibration?.windows) return;
  const wins = S.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(S.length - 1, i + 1);
    return text.slice(S[a].start, S[b].end);
  });
  const cal = state.manifest.calibration.windows;
  const heat = new Array(S.length).fill(0), cnt = new Array(S.length).fill(0);
  for (const key of ['e5-small-lora', 'bert-tiny-raid']) {
    if (state.ready[key] !== 'ready' || !cal[key]) continue;
    let probs;
    try { probs = (await modelWorker.call({ type: 'score', key, texts: wins, run })).probs; } catch { continue; }
    if (run !== state.runId) return;
    probs.forEach((p, i) => { heat[i] += humanPct(cal[key], p) * (key === 'e5-small-lora' ? 2 : 1); cnt[i] += key === 'e5-small-lora' ? 2 : 1; });
  }
  if (!cnt.some(Boolean)) return;
  // each sentence takes the strongest of the windows that contain it (its own, and its neighbours')
  const own = heat.map((h, i) => (cnt[i] ? h / cnt[i] : null));
  state.sentences = S.map((s, i) => {
    const vals = [own[i], own[i - 1], own[i + 1]].filter((v) => v !== null && v !== undefined);
    return { ...s, heat: own[i] === null ? null : 0.6 * own[i] + 0.4 * Math.max(...vals) };
  });
  if (editor.value === text) { renderBackdrop(); } else { relocateSentences(); renderBackdrop(); }
  renderSentences();
}

// ---------- Claude rewrites ----------
async function initSample() {
  try {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    const s = await window.claude.use('sample');
    if (s) state.sample = s;
  } catch { state.sample = null; }
}
const voice = () => (store.get(K.voice, '') || DEFAULT_VOICE).trim();
const STOCK = 'delve, pivotal, seamless, holistic, robust framework, moreover, furthermore, additionally, ultimately, in conclusion, first and foremost, in today’s fast-paced world, landscape, tapestry, testament, it is important to note, plays a crucial role';

function wholePrompt(mode) {
  const text = editor.value;
  let body = text;
  if (mode === 'flagged') {
    const fl = flaggedSentences().map((f) => state.sentences[f.i]).sort((a, b) => b.start - a.start);
    for (const s of fl) body = body.slice(0, s.start) + '⟦' + body.slice(s.start, s.end) + '⟧' + body.slice(s.end);
  }
  const task = mode === 'flagged'
    ? 'Detectors flagged the sentences wrapped in ⟦ ⟧ as machine-like. Rewrite those sentences so they read like the author wrote them. Copy every other sentence exactly as it is.'
    : 'Rewrite the whole answer so it reads like the author wrote it, sentence by sentence, keeping the same order of ideas.';
  return `You are helping an author revise their own answer before they submit it.
Author's voice: ${voice()}

${task}

Hard rules:
- Keep every fact, number, amount, percentage, date, name and acronym exactly as written. Do not add facts, claims or examples that are not in the answer.
- Keep the same paragraphs and roughly the same length.
- Keep the author's own wording wherever it already sounds natural; change what reads as generic or formulaic.
- Mix short, direct sentences with a few longer ones. Use contractions where they sound natural.
- Avoid stock phrases (${STOCK}), lists of three, "not only … but also", and summary closers such as "Ultimately" or "In conclusion".
- No headings, bullet points, quotation marks around the answer, or comments.
Return only the revised answer${mode === 'flagged' ? ', without the ⟦ ⟧ markers' : ''}.

Answer:
"""
${body}
"""`;
}

function sentencePrompt(i) {
  const S = state.sentences, s = S[i];
  return `You are helping an author revise one sentence of their own answer.
Author's voice: ${voice()}
Detectors flagged this sentence as machine-like. Write three alternative versions:
1. plainer and shorter;
2. more personal and concrete, in the first person if it fits (you may put one short placeholder in square brackets, such as [add a real example], where only the author can supply a detail);
3. restructured, with a different opening and rhythm.
Rules: keep every fact, number, date, name and acronym exactly as written; do not add new facts; fit the sentences around it; avoid stock phrases such as ${STOCK}.
Reply with only a JSON array of three strings.

Sentence before: ${JSON.stringify(S[i - 1]?.text || '')}
Sentence to rewrite: ${JSON.stringify(s.text)}
Sentence after: ${JSON.stringify(S[i + 1]?.text || '')}`;
}

function sampleErrorText(e) {
  switch (e?.code) {
    case 'not_granted': return 'Claude was not allowed for this page. You can still copy the request into Claude yourself.';
    case 'sampling_disabled': return 'Claude is not available for this account here. You can still copy the request into Claude yourself.';
    case 'rate_limited': return 'Claude is busy or your usage limit was reached. Try again in a few minutes.';
    case 'session_expired': return 'Your Claude session expired. Sign in again, then retry.';
    case 'refused': return 'Claude declined this request. Edit the text by hand or try Rephrase all.';
    case 'prompt_too_large': return 'The answer is too long to rewrite in one go. Rewrite it in parts.';
    case 'invalid_json': return 'Claude replied in an unexpected format. Try again.';
    default: return 'The rewrite was interrupted. Your text is unchanged. Try again.';
  }
}

const review = { ctl: null, proposed: '', original: '', label: '' };
function openOverlay(id) { const o = $(id); o.hidden = false; o.querySelector('[data-close], button')?.focus(); }
function closeOverlay(id) { $(id).hidden = true; }

async function startRewrite(mode) {
  const text = editor.value;
  if (!text.trim()) { toast('Paste or type an answer first.'); return; }
  if (mode === 'flagged' && !flaggedSentences().length) {
    toast(state.lastCheck ? 'No sentences are flagged. Use Rephrase all instead.' : 'Press Check first so the flagged sentences are known.');
    return;
  }
  review.ctl?.abort();  // only one rewrite at a time
  review.original = text; review.proposed = ''; review.label = mode === 'flagged' ? 'Rewrite of flagged sentences' : 'Full rephrase';
  $('reviewTitle').textContent = mode === 'flagged' ? 'Rewrite flagged sentences' : 'Rephrase the whole answer';
  $('reviewDiff').hidden = true; $('reviewFacts').hidden = true; $('acceptBtn').disabled = true; $('manualBox').hidden = true;
  const prompt = wholePrompt(mode);
  openOverlay('reviewOverlay');
  if (!state.sample) { showManual(prompt, 'One-click rewrites work when this page is opened from Claude. Here it takes two steps: copy the request into a Claude chat, then paste the reply back.'); return; }
  $('reviewIntro').textContent = 'Claude is writing a rewrite. Nothing changes in your answer until you press Use rewrite.';
  const stream = $('reviewStream'); stream.hidden = false; stream.textContent = 'Thinking…';
  const ctl = new AbortController(); review.ctl = ctl;
  $('stopBtn').hidden = false;
  try {
    const { text: out, truncated } = await state.sample(prompt, { signal: ctl.signal, cache: false, onText: ({ text: t }) => { stream.textContent = t; } });
    if (review.ctl !== ctl) return;
    showProposal(cleanRewrite(out), truncated ? 'Claude stopped early, so the end may be missing. Check the end of the text before using it.' : '');
  } catch (e) {
    if (review.ctl !== ctl) return;
    if (e?.code === 'cancelled') { $('reviewIntro').textContent = 'Stopped. Your answer is unchanged.'; stream.hidden = true; }
    else if (['not_granted', 'sampling_disabled', 'capability_disabled', 'not_declared'].includes(e?.code)) showManual(prompt, sampleErrorText(e));
    else { $('reviewIntro').textContent = sampleErrorText(e); stream.hidden = !e?.text; }
  } finally {
    if (review.ctl === ctl) { review.ctl = null; $('stopBtn').hidden = true; }
  }
}

function cleanRewrite(t) {
  let s = String(t || '').replace(/[⟦⟧]/g, '').trim();
  s = s.replace(/^(?:here(?:'s| is)[^\n]*:\s*\n+)/i, '');
  if (/^"""[\s\S]*"""$/.test(s)) s = s.slice(3, -3).trim();
  if (/^["“][\s\S]*["”]$/.test(s) && !/["“”]/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
}

function showManual(prompt, msg) {
  $('reviewIntro').textContent = msg;
  $('reviewStream').hidden = true;
  $('manualBox').hidden = false;
  $('promptOut').value = prompt;
  $('pasteBack').value = '';
}

function showProposal(text, note) {
  review.proposed = text;
  $('reviewStream').hidden = true;
  const d = diffWords(review.original, text);
  $('reviewDiff').innerHTML = d.map((p) => (p.op === 'eq' ? esc(p.s) : p.op === 'del' ? `<del>${esc(p.s)}</del>` : `<ins>${esc(p.s)}</ins>`)).join('');
  $('reviewDiff').hidden = false;
  const fc = factCheck(review.original, text);
  const issues = [];
  if (fc.missingNums.length) issues.push(`Numbers missing from the rewrite: ${fc.missingNums.join(', ')}`);
  if (fc.addedNums.length) issues.push(`Numbers the rewrite added: ${fc.addedNums.join(', ')}`);
  if (fc.missingTerms.length) issues.push(`Names or terms missing: ${fc.missingTerms.slice(0, 12).join(', ')}`);
  if (fc.parasBefore !== fc.parasAfter) issues.push(`Paragraphs changed from ${fc.parasBefore} to ${fc.parasAfter}`);
  const ch = fc.wordsBefore ? Math.round(100 * (fc.wordsAfter - fc.wordsBefore) / fc.wordsBefore) : 0;
  if (Math.abs(ch) > 25) issues.push(`Length changed by ${ch > 0 ? '+' : ''}${ch}% (${fc.wordsBefore} → ${fc.wordsAfter} words)`);
  const facts = $('reviewFacts');
  facts.hidden = false;
  facts.className = `facts ${issues.length ? 'bad' : 'ok'}`;
  facts.innerHTML = issues.length
    ? `<strong>Check these before you use it:</strong><ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<strong>Fact check passed.</strong> Every number, date, name and acronym from your answer is still there. ${fc.wordsBefore} → ${fc.wordsAfter} words.`;
  $('reviewIntro').textContent = (note ? note + ' ' : '') + 'Red is removed, green is added. Nothing changes until you press Use rewrite.';
  $('acceptBtn').disabled = !text.trim();
}

async function suggestFor(i, box) {
  const s = state.sentences[i];
  if (!s) return;
  if (!state.sample) {
    box.innerHTML = `<p class="small">Sentence options need the page to be opened from Claude. Edit the sentence by hand, or use Rewrite flagged to send the request to Claude in two steps.</p>`;
    return;
  }
  box.innerHTML = '<p class="small">Asking Claude for three options…</p>';
  try {
    const arr = await state.sample.json(sentencePrompt(i), { modelTier: 'quick', cache: false });
    const opts = (Array.isArray(arr) ? arr : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3);
    if (!opts.length) throw { code: 'invalid_json' };
    const labels = ['Plainer', 'More personal', 'Restructured'];
    box.innerHTML = opts.map((o, k) => {
      const fc = factCheck(s.text, o);
      const lost = [...fc.missingNums, ...fc.missingTerms];
      return `<button type="button" class="opt" data-opt="${k}"><span class="why">${labels[k] || 'Option'}${lost.length ? ` · drops ${esc(lost.slice(0, 3).join(', '))}` : ''}</span>${esc(o)}</button>`;
    }).join('') + '<button class="btn quiet" type="button" data-act="suggest">Try again</button>';
    box.dataset.opts = JSON.stringify(opts);
  } catch (e) {
    box.innerHTML = `<p class="small">${esc(sampleErrorText(e))}</p><button class="btn quiet" type="button" data-act="suggest">Try again</button>`;
  }
}

let recheckTimer = 0;
function applySentence(i, replacement) {
  const s = state.sentences[i];
  const text = editor.value;
  let at = text.slice(s.start, s.end) === s.text ? s.start : text.indexOf(s.text);
  if (at < 0) { toast('That sentence has changed since the check. Press Check again.'); return; }
  snapshot('Before sentence rewrite');
  const next = text.slice(0, at) + replacement + text.slice(at + s.text.length);
  state.sentences[i] = { start: at, end: at + replacement.length, text: replacement, heat: null };
  setText(next, 'Sentence rewrite');
  snapshot('Sentence rewrite');
  toast('Sentence replaced. Checking again…');
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(runCheck, 1200);
}

function selectRange(start, end) {
  editor.focus();
  editor.setSelectionRange(start, end);
  const lineH = 17 * 1.7;
  const before = editor.value.slice(0, start).split('\n').length;
  const r = editor.getBoundingClientRect();
  window.scrollTo({ top: window.scrollY + r.top + Math.max(0, before - 3) * lineH - 120, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// ---------- versions dialog ----------
function renderVersions() {
  const list = store.get(K.versions, []);
  const el = $('versionList');
  if (!list.length) { el.innerHTML = '<p class="empty">No versions yet. They are saved each time you check or accept a rewrite.</p>'; return; }
  el.innerHTML = list.map((v, i) => `<div class="ver">
      <div><strong>${esc(v.label || 'Saved')}</strong> <span class="meta">${new Date(v.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${v.words} words${v.risk !== null && v.risk !== undefined ? ` · risk ${v.risk}` : ''}</span></div>
      <div><button class="btn" type="button" data-restore="${i}">Restore</button></div>
      <div class="txt">${esc(v.text.slice(0, 300))}</div></div>`).join('');
}

// ---------- misc UI ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function wire() {
  editor.addEventListener('input', onEdit);
  editor.addEventListener('click', () => {
    const pos = editor.selectionStart;
    const flagged = new Set(flaggedSentences().map((f) => f.i));
    const i = state.sentences.findIndex((s, k) => flagged.has(k) && pos >= s.start && pos <= s.end);
    if (i !== state.focusSentence) { state.focusSentence = i; renderBackdrop(); renderSentences(); }
    if (i >= 0) document.querySelector(`.sent[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('resize', () => { autosize(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCheck(); }
    if (e.key === 'Escape') for (const id of ['reviewOverlay', 'versionsOverlay', 'settingsOverlay']) if (!$(id).hidden) { if (id === 'reviewOverlay') review.ctl?.abort(); closeOverlay(id); }
  });
  $('checkBtn').onclick = runCheck;
  $('fixFlaggedBtn').onclick = () => startRewrite('flagged');
  $('rephraseBtn').onclick = () => startRewrite('all');
  $('undoBtn').onclick = () => {
    const last = state.undo.pop();
    if (!last) return;
    const keep = state.undo.slice();
    setText(last.text, 'Undo');
    state.undo = keep;
    $('undoBtn').disabled = !state.undo.length;
    toast(`Undid: ${last.label}`);
  };
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(editor.value); toast('Copied to the clipboard.'); }
    catch { editor.focus(); editor.select(); toast('Press Ctrl+C (or ⌘C) to copy the selected text.'); }
  };
  $('clearExampleBtn').onclick = () => { $('exampleNote').hidden = true; store.set(K.seen, true); setText('', 'Clear example'); state.lastCheck = null; state.results = {}; state.sentences = []; renderAll(); editor.focus(); };
  editor.addEventListener('paste', () => { if (!$('exampleNote').hidden && editor.value === EXAMPLE) { $('exampleNote').hidden = true; store.set(K.seen, true); } });

  $('ledger').addEventListener('click', (e) => {
    const k = e.target.closest('[data-retry],[data-load]');
    if (!k) return;
    if (k.dataset.load) { store.set(K.heavy, true); $('heavyToggle').checked = true; }
    const key = k.dataset.retry || k.dataset.load;
    ensureReady(key).then(() => { if (state.lastCheck && state.lastCheck.text === editor.value) runCheck(); }).catch(() => {});
  });
  $('sentList').addEventListener('click', (e) => {
    const card = e.target.closest('.sent');
    if (!card) return;
    const i = Number(card.dataset.i);
    const s = state.sentences[i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    const opt = e.target.closest('[data-opt]');
    if (act === 'select' && s) { state.focusSentence = i; renderBackdrop(); selectRange(s.start, s.end); }
    else if (act === 'suggest') suggestFor(i, card.querySelector('[data-sugg]'));
    else if (opt) { const box = card.querySelector('[data-sugg]'); const opts = JSON.parse(box.dataset.opts || '[]'); if (opts[opt.dataset.opt]) applySentence(i, opts[opt.dataset.opt]); }
  });
  $('hintList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hint]');
    if (!b) return;
    const h = state.hints.find((x) => x.text.toLowerCase() === b.dataset.hint);
    if (h) selectRange(h.start, h.end);
  });

  for (const id of ['reviewOverlay', 'versionsOverlay', 'settingsOverlay']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id) || e.target.closest('[data-close]')) { if (id === 'reviewOverlay') { review.ctl?.abort(); } closeOverlay(id); }
    });
  }
  $('stopBtn').onclick = () => review.ctl?.abort();
  $('acceptBtn').onclick = () => {
    if (!review.proposed) return;
    snapshot('Before ' + review.label.toLowerCase());
    setText(review.proposed, review.label);
    snapshot(review.label);
    closeOverlay('reviewOverlay');
    toast('Rewrite applied. Checking again…');
    runCheck();
  };
  $('copyPromptBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('promptOut').value); toast('Request copied. Paste it into a Claude chat.'); }
    catch { $('promptOut').focus(); $('promptOut').select(); toast('Press Ctrl+C (or ⌘C) to copy.'); }
  };
  $('usePastedBtn').onclick = () => {
    const t = cleanRewrite($('pasteBack').value);
    if (!t) { toast('Paste the rewritten answer first.'); return; }
    $('manualBox').hidden = true;
    showProposal(t, '');
  };

  $('versionsBtn').onclick = () => { renderVersions(); openOverlay('versionsOverlay'); };
  $('versionList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const v = store.get(K.versions, [])[Number(b.dataset.restore)];
    if (!v) return;
    snapshot('Before restore');
    setText(v.text, 'Restore version');
    closeOverlay('versionsOverlay');
    toast('Version restored. Your previous text is saved in Versions.');
  });

  $('settingsBtn').onclick = () => {
    $('voiceInput').value = voice();
    $('heavyToggle').checked = heavyEnabled();
    $('clearConfirm').hidden = true;
    openOverlay('settingsOverlay');
  };
  $('saveSettingsBtn').onclick = () => {
    const v = $('voiceInput').value.trim();
    store.set(K.voice, v && v !== DEFAULT_VOICE ? v : '');
    const heavy = $('heavyToggle').checked;
    store.set(K.heavy, heavy);
    closeOverlay('settingsOverlay');
    renderPills(); renderLedger();
    if (heavy) ensureReady('modernbert-raid-mage').catch(() => {});
    toast('Settings saved.');
  };
  $('clearDataBtn').onclick = () => {
    if ($('clearConfirm').hidden) { $('clearConfirm').hidden = false; return; }
    for (const k of Object.values(K)) store.del(k);
    $('clearConfirm').hidden = true;
    toast('Saved data cleared from this device.');
  };
}

// Save at once when the tab is hidden or closed, so a pending autosave is never lost.
function flushDraft() {
  clearTimeout(saveTimer);
  const ok = store.set(K.draft, editor.value);
  if (!ok) $('saveState').textContent = 'Not saved: this browser blocks storage';
}
addEventListener('pagehide', flushDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });

function renderAll() { onEdit(); renderPills(); renderLedger(); renderVerdict(); renderSentences(); renderHints(); }

function boot() {
  const draft = store.get(K.draft, null);
  if (draft !== null && draft !== '') editor.value = draft;
  else if (!store.get(K.seen, false)) { editor.value = EXAMPLE; $('exampleNote').hidden = false; }
  wire();
  renderAll();
  initSample();
  warmUp().then(() => {
    // show the example's result straight away so the first view is a working one
    if (editor.value === EXAMPLE && !state.lastCheck) runCheck();
  });
}
boot();
