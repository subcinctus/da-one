// Answer Rewrite Desk — page logic (website version).
// Checkers run in workers (ONNX models in the browser, ZipPy). Rewrites run on this computer (a
// llama.cpp server, or a model inside the browser) or through copy/paste with a Claude chat. Every
// rewrite passes the fact, meaning and grammar guards before the owner sees it, and nothing in the
// answer changes until "Use rewrite".

import { words, esc, splitSentences, diffWords } from './src/text.mjs';
import { cleanText, auditText } from './src/normalize.mjs';
import { compareFacts } from './src/facts.mjs';
import { findTells, styleStats, tellScore } from './src/tells.mjs';
import { humanPct, band, BAND_LABEL, combine, smoothHeat } from './src/calibration.mjs';
import { gateCandidate } from './src/guards.mjs';
import { rewriteFlagged } from './src/rewrite/loop.mjs';
import { sentencePrompt, interviewQuestions, interviewPrompt, cleanOutput } from './src/rewrite/prompts.mjs';
import * as localMod from './src/rewrite/engines/local.mjs';
import * as webllmMod from './src/rewrite/engines/webllm.mjs';
import * as manualMod from './src/rewrite/engines/manual.mjs';
import * as mine from './src/mywriting.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const K = { draft: 'ard.draft', versions: 'ard.versions', voice: 'ard.voice', heavy: 'ard.heavy', seen: 'ard.seenExample', engine: 'ard.engine', local: 'ard.localUrl' };

// Used until the owner describes their own voice in Settings (kept in this browser only)
const DEFAULT_VOICE = 'Writes plain, direct English: short and medium sentences, concrete numbers and examples from experience, '
  + 'first person where it fits, no buzzwords.';

const EXAMPLE = `In today's dynamic lending landscape, growing a retail mortgage book requires a holistic approach that balances ambition with prudence. First and foremost, it is important to leverage data-driven underwriting to identify creditworthy segments, particularly in Tier 2 and Tier 3 cities where demand for affordable housing continues to rise. Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role in sourcing quality customers at scale.

Furthermore, robust early-warning systems and proactive collection strategies are crucial to keeping GNPA below 1.5%. By seamlessly integrating technology across the loan lifecycle, from sourcing to disbursement and servicing, lenders can reduce turnaround time while enhancing the overall customer experience. Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise that delivers long-term value for all stakeholders.`;

// ---------- checkers ----------
const CHECKERS = [
  { key: 'fakespot-roberta', name: 'Fakespot RoBERTa', short: 'Fakespot', size: 133,
    src: 'Mozilla Fakespot AI Labs, Apache-2.0', raid: 'trained on 14 sources incl. GPT-4o, Claude 3, Llama 3, Qwen 2.5',
    about: 'RoBERTa-base fine-tuned by Mozilla’s Fakespot team on the most varied training data of any small open detector. The strongest of these checkers on 2025–26 AI text in independent tests.',
    links: [['GitHub', 'https://github.com/FakespotAILabs/ApolloDFT']] },
  { key: 'modernbert-raid-mage', name: 'ModernBERT detector', short: 'ModernBERT', heavy: true, size: 160,
    src: 'UCL research, EMNLP 2025', raid: 'RAID 99.1% caught, 94.1% under attacks',
    about: 'Drayson, Yilmaz and Lampos (University College London) fine-tuned ModernBERT on the RAID and MAGE datasets. Strong on the RAID benchmark and against paraphrase attacks.',
    links: [['Paper', 'https://aclanthology.org/2025.emnlp-main.1506/'], ['GitHub', 'https://github.com/GeorgeDrayson/model_collapse']] },
  { key: 'tabularis-modernbert', name: 'Tabularis ModernBERT', short: 'Tabularis', heavy: true, size: 160,
    src: 'tabularis.ai, MIT licence', raid: 'RAID 98.98% caught under attacks',
    about: 'ModernBERT-base trained by tabularis.ai for AI-text detection, one of the top open entries on the RAID leaderboard.',
    links: [['RAID leaderboard', 'https://raid-bench.xyz/leaderboard']] },
  { key: 'sallulabs-minilm', name: 'SalluLabs MiniLM', short: 'MiniLM', size: 40,
    src: 'RAID leaderboard 2026, MIT licence', raid: 'RAID 95.6% caught under attacks (AUROC 98.9)',
    about: 'A 6-layer MiniLM distilled from a DeBERTa-v3-large teacher, trained on RAID, MAGE, DAIGT essays and chat text.',
    links: [['GitHub', 'https://github.com/salmannawaz786/sallulabs-ai-detector']] },
  { key: 'e5-small-lora', name: 'e5-small LoRA', short: 'e5-small', size: 36,
    src: 'RAID leaderboard entry, MIT licence', raid: 'RAID 93.9% caught, 85.7% under attacks',
    about: 'A 33M-parameter e5-small model fine-tuned with LoRA on RAID training data. Fast enough to score each sentence.',
    links: [['GitHub', 'https://github.com/menglinzhou/microsoft-hackathon-24']] },
  { key: 'bert-tiny-raid', name: 'BERT-tiny RAID', short: 'BERT-tiny', size: 5,
    src: 'RAID leaderboard entry, MIT licence', raid: 'RAID 91.1% caught, 84.2% under attacks',
    about: 'A 4M-parameter BERT trained on a stratified sample of RAID. Very small and quick, so it is the first to finish.',
    links: [['RAID leaderboard', 'https://raid-bench.xyz/leaderboard']] },
  { key: 'zippy', name: 'ZipPy', short: 'ZipPy', kind: 'zippy', group: 'compression',
    src: 'Thinkst Applied Research, MIT licence', raid: 'not on RAID; a weak signal on its own',
    about: 'Measures how well your text compresses together with a corpus of AI-written text. A faithful port of Thinkst’s own browser build.',
    links: [['GitHub', 'https://github.com/thinkst/zippy']] },
  { key: 'tells', name: 'AI-tell rules', short: 'Tells', kind: 'tells', group: 'rules',
    src: 'Rules from blader/humanizer, vale-ai-tells, stop-slop, berenslab and SlopTotal (MIT)',
    raid: 'not a model: counts stock AI phrasing (each rule weighted) per 100 words, plus style flags such as even sentence lengths',
    about: 'The same rules that list the AI tells under the answer, turned into one score and calibrated like the detectors. Strong on polished chat-model prose, weak on plainly written answers.',
    links: [['blader/humanizer', 'https://github.com/blader/humanizer'], ['vale-ai-tells', 'https://github.com/tbhb/vale-ai-tells']] },
];
const GUARD_MODELS = { nli: 'nli-deberta-xsmall', embed: 'minilm-l6' };
const byKey = (k) => CHECKERS.find((c) => c.key === k);
// checkers this build ships (models listed in the manifest), smallest first; ZipPy and the tell rules
// need no download and are always there
const visible = () => CHECKERS.filter((c) => c.kind || state.manifest?.models?.[c.key]);
const modelKeys = () => visible().filter((c) => !c.kind).sort((a, b) => a.size - b.size).map((c) => c.key);
// raw tell score of a text, in the same shape as a detector result
const tellResult = (text) => { const t0 = performance.now(); return { status: 'done', prob: null, raw: tellScore(text), ms: performance.now() - t0 }; };

// ---------- state ----------
const state = {
  manifest: null,
  ready: {}, readyPromise: {}, progress: {}, loadError: {},
  results: {},        // key -> {status, prob, raw, ms, error}
  lastCheck: null,    // {text, risk, at, words}
  prevRisk: null,
  sentences: [],      // [{start, end, text, heat, agree, of}]
  tells: [],
  runId: 0,
  undo: [],
  focusSentence: -1,
  sentPending: false,
  mode: 'article',
  personal: null,     // summary of how the checkers scored the owner's own writing
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
      const msg = e.message || 'A background task stopped unexpectedly.';
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
  };
}
const modelWorker = rpcWorker(new URL('workers/models.mjs', location.href), { type: 'module' });
const guardWorker = rpcWorker(new URL('workers/models.mjs', location.href), { type: 'module' });  // separate memory for the guard models
const zippyWorker = rpcWorker(new URL('workers/zippy.js', location.href));
const grammarWorker = rpcWorker(new URL('workers/grammar.mjs', location.href), { type: 'module' });
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
  if (/memory|allocation|Out of memory/i.test(m)) return 'Not enough memory on this device. Turn off the large checkers in Settings.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}

async function warmUp() {
  state.ready.zippy = 'ready';
  state.ready.tells = 'ready';
  try {
    const r = await modelWorker.call({ type: 'manifest' });
    state.manifest = r.manifest;
    state.mode = state.manifest.calibration?.default_mode || 'article';
    renderCalibText();
  } catch (err) {
    for (const c of CHECKERS) if (!c.kind) { state.ready[c.key] = 'error'; state.loadError[c.key] = friendlyLoadError(err); }
    renderPills(); renderLedger();
    return;
  }
  renderPills(); renderLedger();
  // load in the background, smallest first; checks start as soon as each checker is ready
  (async () => {
    for (const k of modelKeys()) {
      if (byKey(k).heavy && !heavyEnabled()) continue;
      try { await ensureReady(k); } catch { /* shown in the ledger */ }
    }
  })();
}

// ---------- calibration ----------
const modeCal = () => state.manifest?.calibration?.modes?.[state.mode] || null;
const windowCal = () => state.manifest?.calibration?.windows || {};

// A checker's score as a percentile of professional human writing (null without calibration).
function pctOf(key, res = state.results) {
  const r = res[key];
  const cal = modeCal()?.checkers?.[key];
  if (!r || r.status !== 'done' || !cal) return null;
  return humanPct(cal.human_q, r.raw);
}
function ensemble(res = state.results) {
  const cal = modeCal();
  if (!cal) return null;
  const pcts = {};
  // checkers the fit gave no weight are shown in the ledger but do not enter the combined score
  for (const c of visible()) { const p = pctOf(c.key, res); if (p !== null && (cal.ensemble?.weights?.[c.key] ?? 0) > 0) pcts[c.key] = p; }
  return combine(cal, pcts);
}
// Sentences are highlighted from the 90th percentile of human 3-sentence windows; "Very AI-like" from the 95th.
const SENT_FLAG = 90;
const sentencesMatter = () => { const e = ensemble(); return !!e && e.risk >= 40; };
// Sentences to work on: those past the line, topped up with the most AI-like of the rest (at least
// two, or about 30% of the answer), so a high-risk answer always shows where to start.
function flaggedSentences(all = false) {
  if (!sentencesMatter()) return [];
  const scored = state.sentences.map((s, i) => ({ s, i })).filter((x) => x.s.heat !== null).sort((a, b) => b.s.heat - a.s.heat);
  const out = scored.filter((x) => x.s.heat >= SENT_FLAG);
  const usual = Math.min(scored.length, Math.max(2, Math.ceil(scored.length * 0.3)));
  const want = all ? Math.max(usual, scored.filter((x) => x.s.heat >= 75).length) : usual;
  for (const x of scored) { if (out.length >= want) break; if (!out.includes(x)) out.push(x); }
  return out.map((x) => ({ i: x.i, level: x.s.heat >= 95 ? 'high' : x.s.heat >= SENT_FLAG ? 'mid' : 'rel' }));
}
// Checkers that score sentence windows: calibrated on human windows, loaded, and (for the rewrite
// guide) not the held-out validator.
const windowModels = () => modelKeys().filter((k) => windowCal()[k] && windowWeight(k) > 0 && state.ready[k] === 'ready');
const validatorKey = () => {
  const v = state.manifest?.calibration?.validator || 'fakespot-roberta';
  return state.manifest?.models?.[v] && modeCal()?.checkers?.[v] ? v : null;
};

// ---------- editor ----------
const editor = $('editor'), backdrop = $('backdrop');
function autosize() { editor.style.height = 'auto'; editor.style.height = editor.scrollHeight + 'px'; }

function renderBackdrop() {
  const text = editor.value;
  const marks = [];
  const level = new Map(flaggedSentences().map((f) => [f.i, f.level]));
  state.sentences.forEach((s, i) => {
    const lv = level.get(i);
    if (lv || i === state.focusSentence) marks.push({ start: s.start, end: s.end, cls: `s-${lv === 'high' ? 'high' : lv ? 'mid' : 'plain'}${i === state.focusSentence ? ' s-focus' : ''}` });
  });
  const spans = state.tells.filter((t) => t.end > t.start && t.end <= text.length);
  const cuts = new Set([0, text.length]);
  for (const r of [...marks, ...spans]) { cuts.add(r.start); cuts.add(r.end); }
  const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let piece = esc(text.slice(a, b));
    if (spans.some((r) => r.start <= a && r.end >= b)) piece = `<span class="tell">${piece}</span>`;
    const mk = marks.find((r) => r.start <= a && r.end >= b);
    if (mk) piece = `<mark class="${mk.cls}">${piece}</mark>`;
    html += piece;
  }
  backdrop.innerHTML = html + (text.endsWith('\n') ? ' ' : '') + '\u200b';
}

// Keep highlights on sentences that the user has not edited.
function relocateSentences() {
  const text = editor.value;
  let from = 0;
  state.sentences = state.sentences.map((s) => {
    const at = text.indexOf(s.text, from);
    if (at < 0) return null;
    from = at + s.text.length;
    return { ...s, start: at, end: at + s.text.length };
  }).filter(Boolean);
}

let saveTimer = 0, tellTimer = 0;
function onEdit() {
  autosize();
  const t = editor.value;
  $('wordCount').textContent = words(t).toLocaleString('en-IN');
  $('charCount').textContent = t.length.toLocaleString('en-IN');
  relocateSentences();
  renderCleanBanner(t);
  clearTimeout(tellTimer);
  tellTimer = setTimeout(() => { state.tells = safeTells(editor.value); renderBackdrop(); renderTells(); }, 250);
  renderBackdrop(); renderSentences();
  if (state.lastCheck && state.lastCheck.text !== t) markStale(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ok = store.set(K.draft, t);
    $('saveState').textContent = ok ? 'Saved on this device' : 'Not saved: this browser blocks storage';
  }, 350);
}
const safeTells = (t) => { try { return findTells(t); } catch { return []; } };

function renderCleanBanner(t) {
  const hits = auditText(t);
  const el = $('cleanBanner');
  if (!hits.length) { el.hidden = true; return; }
  const n = (k) => hits.filter((h) => h.kind === k).length;
  const parts = [];
  if (n('invisible')) parts.push(`${n('invisible')} invisible`);
  if (n('lookalike')) parts.push(`${n('lookalike')} look-alike letter${n('lookalike') > 1 ? 's' : ''}`);
  if (n('fullwidth')) parts.push(`${n('fullwidth')} wide character${n('fullwidth') > 1 ? 's' : ''}`);
  if (n('space')) parts.push(`${n('space')} unusual space${n('space') > 1 ? 's' : ''}`);
  $('cleanText').textContent = `This text contains ${parts.join(', ')}. "Humanizer" tools add these to fool detectors; Turnitin flags them and they can break copy/paste. Cleaning keeps every visible word.`;
  el.hidden = false;
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
function snapshot(label, risk = null, text = editor.value) {
  if (!text.trim()) return;
  const list = store.get(K.versions, []);
  if (list[0] && list[0].text === text) { if (risk !== null) { list[0].risk = risk; store.set(K.versions, list); } return; }
  list.unshift({ at: Date.now(), text, words: words(text), risk, label });
  while (list.length > 40) list.pop();
  while (!store.set(K.versions, list) && list.length > 1) list.pop();
}

// ---------- rendering ----------
function pillState(c) {
  let st = state.ready[c.key] || 'idle';
  if (c.heavy && !heavyEnabled() && st === 'idle') st = 'off';
  return st;
}
function renderPills() {
  $('pills').innerHTML = visible().map((c) => {
    const st = pillState(c);
    const pr = state.progress[c.key];
    const title = st === 'loading' && pr ? `${c.name}: ${pr.stage === 'download' ? `downloading ${(pr.loaded / 1e6).toFixed(0)} of ${(pr.total / 1e6).toFixed(0)} MB` : 'starting'}`
      : st === 'ready' ? `${c.name} is ready` : st === 'error' ? `${c.name}: ${state.loadError[c.key] || 'failed'}` : st === 'off' ? `${c.name} is off (Settings)` : `${c.name} is waiting`;
    return `<span class="pill" data-state="${st}" title="${esc(title)}"><span class="dot"></span>${esc(c.short)}</span>`;
  }).join('');
}

function fmtPct(p) { const r = Math.round(p); const s = r % 100 >= 11 && r % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[r % 10] || 'th'); return `${r}${s}`; }

function ledgerRow(c) {
  const r = state.results[c.key];
  const st = state.ready[c.key] || 'idle';
  let val = '<span class="chip none">Waiting</span>', bar = '', prog = '';
  if (c.heavy && !heavyEnabled() && st !== 'ready' && st !== 'loading') {
    val = `<button class="btn quiet" type="button" data-load="${c.key}">Turn on (${c.size} MB)</button>`;
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
      val = `<span class="num">${fmtPct(pct)}</span> <span class="chip ${b}">${b === 'high' ? 'Flags AI' : b === 'mid' ? 'Borderline' : 'Not flagged'}</span>`;
      bar = `<div class="bar" title="More AI-like than ${pr}% of the professional human writing it was compared with"><i class="${b}" style="width:${Math.max(2, pct)}%"></i><b style="left:95%"></b></div>`;
    } else if (r.status === 'done') {
      const ai = c.kind === 'zippy' ? r.determination === 'AI' : c.kind === 'tells' ? r.raw >= 2 : r.prob >= 0.5;
      val = `<span class="chip none">${ai ? 'Leans AI' : 'Leans human'} (not calibrated yet)</span>`;
    }
  }
  const raw = r && r.status === 'done' ? (c.kind === 'zippy' ? `ZipPy says ${esc(r.determination)} (confidence ${r.score.toFixed(4)})`
    : c.kind === 'tells' ? `Tell score ${r.raw.toFixed(2)}` : `Raw AI probability ${(r.prob * 100).toFixed(1)}%`) + ` · ${(r.ms / 1000).toFixed(1)} s` : '';
  const weight = modeCal()?.ensemble?.weights?.[c.key];
  const unused = weight === 0 ? '<div class="src">Not counted in the overall score: it added nothing on 2024–26 AI text in the calibration tests.</div>' : '';
  const held = c.key === validatorKey() ? ' This checker is held back during rewrites and only used to confirm the result, so a rewrite cannot simply be tuned to it.' : '';
  return `<div class="row" data-key="${c.key}">
      <div><div class="name">${esc(c.name)}</div><div class="src">${esc(c.src)}</div>${unused}</div>
      <div class="val">${val}</div>${bar}${prog}
      <details><summary>Details</summary><p>${esc(c.about)}${held}</p><p>${esc(c.raid)}.${raw ? ' ' + raw + '.' : ''}</p>${measuredLine(c.key)}<p>${c.links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ')}</p></details>
    </div>`;
}
function renderLedger() {
  const group = (title, list) => (list.length ? `<div class="group-title">${title}</div>${list.map(ledgerRow).join('')}` : '');
  $('ledger').innerHTML = group('Trained detectors', visible().filter((c) => !c.kind))
    + group('Writing-style rules', visible().filter((c) => c.kind === 'tells'))
    + group('Compression test', visible().filter((c) => c.kind === 'zippy'));
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
  el.textContent = `Scores are compared with ${a.human_samples} pieces of professional human writing. `
    + (a.measured ? `On held-out test texts the combined score flagged ${Math.round(a.measured.tpr * 100)}% of AI-written texts and ${Math.round(a.measured.fpr * 100)}% of human ones. ` : '')
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
  if (w > 0 && w < 150) { warn.hidden = false; warn.textContent = `Only ${w} words. Every detector is unreliable on short answers, and Turnitin calls scores under 300 words less accurate.`; } else warn.hidden = true;
  const pn = $('personalNote');
  if (state.personal) {
    pn.hidden = false;
    pn.textContent = `Your own writing (${state.personal.n} samples): ${state.personal.high} scored High and ${state.personal.mid} Medium; the highest was ${state.personal.max}. Scores in that range can happen to genuine writing like yours.`;
  } else pn.hidden = true;
  if (!e) {
    $('riskScore').textContent = '–'; $('riskBand').className = 'band none'; $('riskBand').textContent = state.lastCheck ? 'Waiting for the checkers…' : BAND_LABEL.none;
    $('needle').style.left = '0%'; $('riskDelta').textContent = '';
    if (state.lastCheck) $('riskSub').textContent = 'The checkers download once, then stay in this browser. Results appear as each one finishes.';
    return;
  }
  const b = band(e.risk);
  $('riskScore').textContent = e.risk;
  $('riskBand').className = `band ${b}`; $('riskBand').textContent = BAND_LABEL[b];
  $('needle').style.left = `${e.risk}%`;
  const d = state.prevRisk !== null && state.lastCheck && state.lastCheck.risk !== null ? e.risk - state.prevRisk : null;
  $('riskDelta').textContent = d === null || d === 0 ? '' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs last check`;
  $('riskDelta').className = `delta ${d < 0 ? 'down' : d > 0 ? 'up' : ''}`;
  const total = visible().filter((c) => state.results[c.key]?.status === 'done' && pctOf(c.key) !== null).length;
  const pending = visible().filter((c) => state.results[c.key]?.status === 'running' || (state.ready[c.key] === 'loading' && state.results[c.key]?.status !== 'done')).length;
  const flaggedAll = visible().filter((c) => { const p = pctOf(c.key); return p !== null && Math.round(p) >= 95; }).length;
  $('riskSub').textContent = `${flaggedAll} of ${total} checkers flag this answer as AI-written, compared with professional human writing.${pending ? ' More results are coming.' : ''}`
    + (state.lastCheck ? ` ${w.toLocaleString('en-IN')} words.` : '')
    // measured: these checkers miss most plainly written answers from the newest models (see How this works)
    + (b === 'low' && !pending ? ' A Low score is not a pass: these open checkers miss many plainly written answers from the newest AI models. Cross-check with GPTZero or Pangram below.' : '');
}

const TELL_GROUP = { vocabulary: 'Words', phrase: 'Stock phrases', opener: 'Openers', closer: 'Closers', formula: 'Formulas', structure: 'Structure', punctuation: 'Punctuation' };
function tellsIn(s) { return state.tells.filter((t) => t.start >= s.start && t.end <= s.end); }

function renderSentences() {
  const el = $('sentList');
  // an "Ask me" box in use (answers typed, a reply pasted, versions on the way) survives re-renders:
  // its node moves into the new card, so code still writing into it stays connected
  const live = new Map();
  for (const card of el.querySelectorAll('.sent')) {
    const box = card.querySelector('[data-sugg]');
    if (box && box.childElementCount && card.dataset.t) live.set(card.dataset.t, box);
  }
  const flagged = flaggedSentences().map((f) => ({ ...state.sentences[f.i], i: f.i, level: f.level }));
  for (const [i, s] of state.sentences.entries()) {
    if (live.has(s.text) && !flagged.some((f) => f.i === i)) flagged.push({ ...s, i, level: 'rel' });
  }
  if (!state.lastCheck) { el.innerHTML = '<p class="empty">Flagged sentences appear here after a check.</p>'; return; }
  if (!flagged.length && state.sentPending) { el.innerHTML = '<p class="empty">Scoring each sentence…</p>'; return; }
  const e = ensemble();
  if (e && e.risk < 40) { el.innerHTML = '<p class="empty">Nothing to rewrite: the answer as a whole reads as human-written.</p>'; return; }
  if (!flagged.length) {
    el.innerHTML = state.sentences.some((s) => s.heat !== null) ? '<p class="empty">No sentence stands out. If the overall risk is still high, work through "Why it reads as AI" below, or edit the opening and closing lines by hand.</p>'
      : '<p class="empty">Sentence scores appear once the checkers have run.</p>';
    return;
  }
  el.innerHTML = flagged.slice(0, 14).map((s) => {
    const b = s.level === 'high' ? 'high' : 'mid';
    const label = s.level === 'high' ? 'Very AI-like' : s.level === 'mid' ? 'Somewhat AI-like' : 'More AI-like than the rest';
    const reasons = tellsIn(s).slice(0, 4).map((t) => `<li>${esc(t.message)}</li>`).join('');
    const agree = s.of ? `<span class="agree">${s.agree} of ${s.of} checkers</span>` : '';
    return `<div class="sent${s.i === state.focusSentence ? ' focus' : ''}" data-i="${s.i}" data-t="${esc(s.text)}">
      <q>${esc(s.text)}</q>
      <div class="acts"><span class="chip ${b}">${label}</span>${agree}</div>
      ${reasons ? `<ul class="reasons">${reasons}</ul>` : ''}
      <div class="acts">
      <button class="btn quiet" type="button" data-act="select">Edit by hand</button>
      <button class="btn" type="button" data-act="rewrite">Rewrite this</button>
      <button class="btn" type="button" data-act="ask" title="Answer one or two questions so the rewrite can use your own example or figure">Ask me</button></div>
      <div class="sugg" data-sugg></div>
    </div>`;
  }).join('');
  for (const card of el.querySelectorAll('.sent')) {
    const old = live.get(card.dataset.t);
    if (old) card.querySelector('[data-sugg]').replaceWith(old);
  }
}

function renderTells() {
  const el = $('tellList');
  const groups = new Map();
  for (const t of state.tells) {
    const g = TELL_GROUP[t.category] || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  el.innerHTML = groups.size ? [...groups.entries()].map(([g, list]) => `<div class="group-title">${esc(g)} (${list.length})</div>`
    + list.slice(0, 8).map((t) => `<div class="tell-item"><button type="button" data-tell="${t.start}:${t.end}" title="${esc(t.message)}">${esc(editor.value.slice(t.start, t.end).slice(0, 48) || t.rule)}</button><span>${esc(t.message)}</span></div>`).join('')).join('')
    : '<span class="empty">Nothing found.</span>';
  let st = null;
  try { st = editor.value.trim() ? styleStats(editor.value) : null; } catch { st = null; }
  const flagged = new Set((st?.flags || []).map((f) => f.stat));
  const cells = st ? [
    ['cvLen', 'Sentence length variety', st.cvLen?.toFixed?.(2)],
    ['meanLen', 'Average sentence (words)', st.meanLen?.toFixed?.(1)],
    ['contractionsPer100', 'Contractions per 100 words', st.contractionsPer100?.toFixed?.(1)],
    ['emDashPer100', 'Em-dashes per 100 words', st.emDashPer100?.toFixed?.(1)],
  ].filter((c) => c[2] !== undefined) : [];
  $('styleStats').innerHTML = cells.map(([k, label, v]) => `<div class="stat${flagged.has(k) ? ' flag' : ''}" title="${esc((st.flags || []).find((f) => f.stat === k)?.message || '')}"><b>${esc(String(v))}</b>${esc(label)}</div>`).join('');
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
  state.tells = safeTells(text);
  state.focusSentence = -1;
  renderBackdrop(); renderSentences(); renderVerdict(); renderLedger(); renderTells();
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

  try { finish('tells', tellResult(text)); } catch (err) { finish('tells', { status: 'error', error: String(err?.message || err) }); }
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
    let sentencesDone = false;
    for (const key of modelKeys()) {
      if (byKey(key).heavy && !heavyEnabled() && state.ready[key] !== 'ready') continue;
      if (state.ready[key] !== 'ready') { later.push(key); continue; }
      if (run !== state.runId) return;
      // sentences first once the light window checkers are in, so highlights appear early
      if (!sentencesDone && byKey(key).heavy) { if (live()) await scoreSentences(run, text); sentencesDone = true; }
      await scoreDoc(key);
    }
    if (!sentencesDone && live()) await scoreSentences(run, text);
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
      if (windowCal()[key] && live()) await scoreSentences(run, text);
      settle(run);
    }
  })();
}

function settle(run) {
  if (run !== state.runId) return;
  const e = ensemble();
  if (e && state.lastCheck) { state.lastCheck.risk = e.risk; snapshot('Checked', e.risk, state.lastCheck.text); }
  renderVerdict(); renderLedger();
}

// Sentence heat: score 3-sentence windows with every window checker, as human percentiles.
async function scoreSentences(run, text) {
  state.sentPending = true; renderSentences();
  try { await scoreSentencesInner(run, text); } finally { if (run === state.runId) { state.sentPending = false; renderSentences(); } }
}
const windowsOf = (S, text) => S.map((_, i) => text.slice(S[Math.max(0, i - 1)].start, S[Math.min(S.length - 1, i + 1)].end));

async function windowPcts(texts, keys) {
  const per = {};
  for (const key of keys) {
    try { per[key] = (await modelWorker.call({ type: 'score', key, texts })).probs.map((p) => humanPct(windowCal()[key], p)); } catch { /* skip this checker */ }
  }
  return per;
}
const windowWeight = (k) => state.manifest?.calibration?.window_weights?.[k] ?? (k === 'e5-small-lora' ? 2 : 1);

async function scoreSentencesInner(run, text) {
  const S = state.sentences;
  const keys = windowModels();
  if (!S.length || !keys.length) return;
  const per = await windowPcts(windowsOf(S, text), keys);
  if (run !== state.runId) return;
  const used = Object.keys(per);
  if (!used.length) return;
  const own = S.map((_, i) => {
    let s = 0, w = 0;
    for (const k of used) { s += per[k][i] * windowWeight(k); w += windowWeight(k); }
    return w ? s / w : null;
  });
  const heat = smoothHeat(own);
  state.sentences = S.map((s, i) => ({ ...s, heat: heat[i], agree: used.filter((k) => per[k][i] >= SENT_FLAG).length, of: used.length }));
  if (editor.value !== text) relocateSentences();
  renderBackdrop(); renderSentences();
}

// ---------- rewrite engines ----------
const pickEngine = (m, id) => m.engine || m.default || Object.values(m).find((v) => v && typeof v === 'object' && v.id === id) || null;
const ENGINES = [
  { id: 'local', mod: localMod, title: 'Local rewriter on this computer', blurb: 'Humanizer 12B (or any model) running in llama.cpp, LM Studio or Ollama. The strongest free option; text stays on your computer.' },
  { id: 'webllm', mod: webllmMod, title: 'In-browser model (Qwen3)', blurb: 'Runs inside this browser with WebGPU. Nothing to install; the first use downloads 1–5 GB and keeps it.' },
  { id: 'manual', mod: manualMod, title: 'Claude chat (copy and paste)', blurb: 'Free with your Claude plan. Copy one request into Claude, paste the reply back; the checks and the choice still run here.' },
];
const engineStatus = {};

async function probeEngines() {
  await Promise.all(ENGINES.map(async (e) => {
    const eng = pickEngine(e.mod, e.id);
    if (!eng) { engineStatus[e.id] = { ok: false, detail: 'Not available in this build.' }; return; }
    if (e.id === 'local') eng.configure?.({ baseUrl: store.get(K.local, '') || undefined });
    engineStatus[e.id] = { ok: null, detail: 'Checking…' };
    renderEngines();
    try { engineStatus[e.id] = await eng.probe(); } catch (err) { engineStatus[e.id] = { ok: false, detail: String(err?.message || err) }; }
    renderEngines();
  }));
}
function chosenEngine() {
  const saved = store.get(K.engine, null);
  if (saved && engineStatus[saved]?.ok) return saved;
  return ['local', 'webllm', 'manual'].find((id) => engineStatus[id]?.ok) || 'manual';
}
function renderEngines() {
  const cur = $('engineList').querySelector('input:checked')?.value || chosenEngine();
  $('engineList').innerHTML = ENGINES.map((e) => {
    const st = engineStatus[e.id] || { ok: null, detail: '' };
    const cls = st.ok === true ? 'ok' : st.ok === false ? 'bad' : '';
    const setup = e.id === 'local' && st.ok === false ? ' <a href="#" data-guide>How to set it up</a>' : '';
    return `<label class="engine"><input type="radio" name="engine" value="${e.id}"${cur === e.id ? ' checked' : ''}${e.id !== 'manual' && st.ok === false ? ' disabled' : ''}>
      <span><span class="title">${esc(e.title)}</span><br><span class="small">${esc(e.blurb)}</span></span>
      <span class="status ${cls}">${esc(st.detail || '')}${setup}</span></label>`;
  }).join('');
}

// ---------- rewrite workbench ----------
const rw = { ctl: null, targets: [], result: null, original: '', engineId: null };

async function voiceExamples() { try { return await mine.voiceSamples(); } catch { return []; } }
const voice = () => (store.get(K.voice, '') || DEFAULT_VOICE).trim();

function openRewrite(targets = null) {
  if (!state.lastCheck || state.lastCheck.text !== editor.value) { toast('Press Check first so the flagged sentences are known.'); return; }
  const all = targets || flaggedSentences($('optAll').checked).map((f) => f.i);
  if (!all.length) { toast('No sentences are flagged. The answer already reads as human-written to these checkers.'); return; }
  rw.targets = all; rw.result = null; rw.original = editor.value; rw.picked = !!targets;
  rwIntro();
  showStage('setup');
  openOverlay('rewriteOverlay');
  renderEngines();
  probeEngines();
}

function rwIntro() {
  const n = rw.targets.length;
  $('rwIntro').textContent = `${n} sentence${n > 1 ? 's' : ''} will be rewritten. Everything else stays exactly as it is.`;
}
// the "only slightly AI-like" box changes the list unless the user picked one sentence
function refreshTargets() {
  if (rw.picked) return;
  const all = flaggedSentences($('optAll').checked).map((f) => f.i);
  if (all.length) { rw.targets = all; rwIntro(); }
}

function showStage(stage) {
  $('rwSetup').hidden = stage !== 'setup';
  $('rwRun').hidden = stage !== 'run';
  $('rwResult').hidden = stage !== 'result';
  $('startBtn').hidden = stage !== 'setup';
  $('usePastedBtn').hidden = true;
  $('manualBox').hidden = true;
  $('stopBtn').hidden = stage !== 'run';
  $('acceptBtn').hidden = stage !== 'result';
  $('keepMineBtn').hidden = stage !== 'result';
}

const logLine = (msg) => { const el = $('rwLog'); el.textContent += (el.textContent ? '\n' : '') + msg; el.scrollTop = el.scrollHeight; };
const setBar = (f) => { $('rwBar').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; };

// Guard models and grammar run on demand. Each is tried once on a short text first: a guard that
// cannot load is left out and said so, instead of failing every version (the loop fails closed).
const GUARD_NAMES = { nli: 'meaning check', embed: 'similarity check', grammar: 'grammar check' };
async function guardCtx(allow = [], note = () => {}) {
  const has = (k) => !!state.manifest?.models?.[k];
  const all = {
    nli: has(GUARD_MODELS.nli) ? async (premise, hypothesis) => (await guardWorker.call({ type: 'nli', key: GUARD_MODELS.nli, pairs: [[premise, hypothesis]] })).probs[0] : null,
    embed: has(GUARD_MODELS.embed) ? async (texts) => (await guardWorker.call({ type: 'embed', key: GUARD_MODELS.embed, texts })).vectors : null,
    grammar: async (text) => (await grammarWorker.call({ type: 'lint', texts: [text] })).lints[0],
  };
  const probe = { nli: (f) => f('The loan was approved.', 'The loan was approved.'), embed: (f) => f(['The loan was approved.']), grammar: (f) => f('The loan was approved.') };
  const ctx = { allow };
  await Promise.all(Object.entries(all).map(async ([k, f]) => {
    if (!f) { note(`The ${GUARD_NAMES[k]} is not in this build, so it is skipped.`); return; }
    try { await probe[k](f); ctx[k] = f; } catch (err) { note(`The ${GUARD_NAMES[k]} could not load (${err?.message || err}), so it is skipped.`); }
  }));
  return ctx;
}

async function guideScores(texts) {
  const v = validatorKey();
  const keys = windowModels().filter((k) => k !== v);
  if (!keys.length) throw new Error('no sentence checker is ready to compare the versions; wait for the checkers to load, then try again');
  const per = await windowPcts(texts, keys);
  const used = Object.keys(per);
  return texts.map((_, i) => {
    let s = 0, w = 0;
    for (const k of used) { s += per[k][i] * windowWeight(k); w += windowWeight(k); }
    return w ? s / w : 50;
  });
}
async function validatorScore(text) {
  const v = validatorKey();
  if (!v) return null;
  try {
    await ensureReady(v);
    const p = (await modelWorker.call({ type: 'score', key: v, texts: [text] })).probs[0];
    return humanPct(modeCal().checkers[v].human_q, p);
  } catch { return null; }
}

async function startRewrite() {
  refreshTargets();
  const engineId = $('engineList').querySelector('input:checked')?.value || 'manual';
  store.set(K.engine, engineId);
  rw.engineId = engineId;
  const S = state.sentences;
  const items = rw.targets.map((i) => ({ index: i, before: S[i - 1]?.text || '', sentence: S[i].text, after: S[i + 1]?.text || '' }));
  const samples = await voiceExamples();
  const n = Number($('optN').value), rounds = Number($('optRounds').value);
  if (engineId === 'manual') {
    const eng = pickEngine(manualMod, 'manual');
    $('promptOut').value = eng.buildRequest(items, { voice: voice(), samples, n });
    $('pasteBack').value = '';
    $('manualBox').hidden = false;
    $('startBtn').hidden = true;
    $('usePastedBtn').hidden = false;
    rw.manualItems = items;
    return;
  }
  const eng = pickEngine(engineId === 'local' ? localMod : webllmMod, engineId);
  const getCandidates = async (its, round) => {
    const reqs = [];
    for (const it of its) for (let v = 0; v < n; v++) {
      reqs.push({ ...sentencePrompt({ before: it.before, sentence: it.sentence, after: it.after, voice: voice(), samples, variant: (v + round) % 4 }), n: 1, maxTokens: 220, text: it.sentence, id: it.index });
    }
    let out;
    try {
      out = await eng.generate(reqs, { signal: rw.ctl.signal, onProgress: (p) => { if (p?.message) logLine(p.message); } });
    } catch (err) {
      // a rewriter that stops answering later on must not throw away what the earlier rounds found
      if (err?.name === 'AbortError' || round === 0) throw err;
      logLine(`The rewriter stopped answering in round ${round + 1} (${err?.message || err}). Keeping what the earlier rounds found.`);
      return new Map();
    }
    const map = new Map();
    reqs.forEach((r, k) => {
      const list = map.get(r.id) || [];
      for (const c of out[k] || []) { const t = cleanText(cleanOutput(c)).text.trim(); if (t) list.push(t); }
      map.set(r.id, list);
    });
    return map;
  };
  await runLoop(getCandidates, rounds);
}

async function runLoop(getCandidates, rounds) {
  rw.ctl?.abort();
  const ctl = new AbortController(); rw.ctl = ctl;
  showStage('run'); $('rwLog').textContent = ''; setBar(0);
  const text = rw.original;
  logLine('Loading the meaning and grammar checks…');
  try {
    const ctx = await guardCtx([], logLine);
    if (rw.ctl !== ctl) return;
    const res = await rewriteFlagged({
      text, sentences: state.sentences.map(({ start, end, text: t }) => ({ start, end, text: t })), targets: rw.targets,
      getCandidates, scoreGuide: guideScores, scoreValidator: validatorScore,
      gate: (orig, cand, extra) => gateCandidate(orig, cand, { ...ctx, ...extra }),
      rounds, targetPct: 85, signal: ctl.signal,
      onProgress: (p) => { if (p.message) logLine(p.message); if (p.total) setBar(p.done / p.total); },
    });
    if (rw.ctl !== ctl) return;
    setBar(1);
    await showRewriteResult(res);
  } catch (err) {
    if (rw.ctl !== ctl) return;
    if (err?.name === 'AbortError') { logLine('Stopped. Your answer is unchanged.'); }
    else logLine(`The rewrite stopped: ${err?.message || err}. Your answer is unchanged.`);
    $('stopBtn').hidden = true; $('keepMineBtn').hidden = false;
  } finally {
    if (rw.ctl === ctl) rw.ctl = null;
  }
}

async function usePasted() {
  const eng = pickEngine(manualMod, 'manual');
  const ids = rw.manualItems.map((it) => it.index);
  let parsed;
  try { parsed = eng.parseReply($('pasteBack').value, ids); } catch { parsed = new Map(); }
  const count = [...parsed.values()].reduce((a, l) => a + l.length, 0);
  if (!count) { toast('No versions found in the pasted reply. Paste Claude’s whole reply.'); return; }
  const cleaned = new Map([...parsed.entries()].map(([k, l]) => [k, l.map((t) => cleanText(cleanOutput(t)).text.trim()).filter(Boolean)]));
  await runLoop(async (its, round) => (round === 0 ? new Map(its.map((it) => [it.index, cleaned.get(it.index) || []])) : new Map()), 1);
}

// Why versions were thrown out, most common first: ": 3 changed the meaning, 2 changed a number".
const REASON_LABEL = {
  facts: 'changed a number, name or term', negation: 'changed a "not"', modal: 'changed a "may/will/must"',
  entailment: 'changed the meaning', contradiction: 'contradicted the original', similarity: 'drifted too far from the original',
  'edit-ratio': 'changed too much at once', length: 'was much shorter or longer', 'new-entity': 'added a new name',
  grammar: 'added a grammar slip', meta: 'talked about itself', 'unsafe-chars': 'had hidden characters', empty: 'was empty',
  layout: 'broke the sentence layout', error: 'could not be checked', gate: 'did not pass the guards',
};
function rejectionSummary(changes) {
  const n = new Map();
  for (const c of changes) for (const r of c.rejected || []) {
    const code = r.reasons?.[0]?.code || 'error';  // count each version once, by its first reason
    n.set(code, (n.get(code) || 0) + 1);
  }
  const parts = [...n.entries()].sort((a, b) => b[1] - a[1]).map(([code, k]) => `${k} ${REASON_LABEL[code] || code}`);
  return parts.length ? `: ${parts.join(', ')}` : '';
}

async function showRewriteResult(res) {
  rw.result = res;
  showStage('result');
  const changed = res.changes.filter((c) => c.after && c.after !== c.before);
  const d = diffWords(rw.original, res.text);
  $('reviewDiff').innerHTML = d.map((p) => (p.op === 'eq' ? esc(p.s) : p.op === 'del' ? `<del>${esc(p.s)}</del>` : `<ins>${esc(p.s)}</ins>`)).join('');
  const fc = compareFacts(rw.original, res.text);
  const issues = [];
  if (fc.missingNums.length) issues.push(`Numbers missing: ${fc.missingNums.join(', ')}`);
  if (fc.addedNums.length) issues.push(`Numbers added: ${fc.addedNums.join(', ')}`);
  if (fc.missingTerms.length) issues.push(`Names or terms missing: ${fc.missingTerms.slice(0, 12).join(', ')}`);
  if (fc.modals?.changed?.length) issues.push(`Changed "may/will/must" words: ${fc.modals.changed.map((m) => m.word).join(', ')}`);
  if (fc.parasBefore !== fc.parasAfter) issues.push(`Paragraphs changed from ${fc.parasBefore} to ${fc.parasAfter}`);
  const facts = $('reviewFacts');
  facts.hidden = false;
  facts.className = `facts ${issues.length ? 'bad' : 'ok'}`;
  facts.innerHTML = issues.length ? `<strong>Check these before you use it:</strong><ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<strong>Fact check passed.</strong> Every number, date, name, acronym, negation and "may/will" word from your answer is still there. ${fc.wordsBefore} → ${fc.wordsAfter} words.`;
  const rejected = res.changes.reduce((a, c) => a + (c.rejected?.length || 0), 0);
  const why = rejectionSummary(res.changes);
  const warn = res.warnings?.includes('goodhart') ? ' The held-back checker did not improve as much as the others: read the result critically, and consider editing by hand.' : '';
  $('rwSummary').textContent = changed.length
    ? `${changed.length} of ${res.changes.length} sentences changed; ${rejected} version${rejected === 1 ? ' was' : 's were'} thrown out by the guards${why}. Red is removed, green is added.${warn}`
    : `No version passed the guards and beat the original, so nothing changed${why ? ` (thrown out${why.slice(1)})` : ''}. Try "Ask me" on a sentence, or edit it by hand.`;
  $('acceptBtn').disabled = !changed.length;
  // before/after for every checker on the whole answer (the confirmation step)
  $('rwCompare').innerHTML = '<tr><th>Checker</th><th class="num">Before</th><th class="num">After</th></tr><tr><td colspan="3" class="small">Scoring the rewrite…</td></tr>';
  if (changed.length) {
    const after = {};
    for (const key of modelKeys().filter((k) => state.ready[k] === 'ready')) {
      try { after[key] = { status: 'done', raw: (await modelWorker.call({ type: 'score', key, texts: [res.text] })).probs[0] }; } catch { /* skip */ }
    }
    try { const z = await zippyWorker.call({ type: 'score', text: res.text }); after.zippy = { status: 'done', raw: z.determination === 'AI' ? z.score : -z.score }; } catch { /* skip */ }
    try { after.tells = tellResult(res.text); } catch { /* skip */ }
    const rows = visible().filter((c) => pctOf(c.key) !== null && after[c.key]).map((c) => {
      const a = pctOf(c.key), b = humanPct(modeCal().checkers[c.key].human_q, after[c.key].raw);
      return `<tr><td>${esc(c.name)}${c.key === validatorKey() ? ' <span class="small">(held back)</span>' : ''}</td><td class="num">${fmtPct(a)}</td><td class="num">${fmtPct(b)}</td></tr>`;
    });
    const eb = ensemble(), ea = ensemble(after);
    rows.push(`<tr><td><b>Overall risk</b></td><td class="num"><b>${eb?.risk ?? '–'}</b></td><td class="num"><b>${ea?.risk ?? '–'}</b></td></tr>`);
    $('rwCompare').innerHTML = '<tr><th>Checker (percentile vs human writing)</th><th class="num">Before</th><th class="num">After</th></tr>' + rows.join('');
  } else $('rwCompare').innerHTML = '';
}

function acceptRewrite() {
  if (!rw.result) return;
  snapshot('Before rewrite');
  setText(rw.result.text, 'Rewrite of flagged sentences');
  snapshot('Rewrite of flagged sentences');
  closeOverlay('rewriteOverlay');
  toast('Rewrite applied. Checking again…');
  runCheck();
}

// ---------- interview ("Ask me") ----------
function paragraphOf(i) {
  const text = editor.value, s = state.sentences[i];
  const from = s.start > 0 ? text.lastIndexOf('\n', s.start - 1) + 1 : 0;
  const endAt = text.indexOf('\n', s.end);
  const raw = text.slice(from, endAt < 0 ? text.length : endAt);
  const start = from + (raw.length - raw.trimStart().length);
  return { start, end: start + raw.trim().length, text: raw.trim() };
}

function askFor(i, box) {
  const s = state.sentences[i];
  if (!s) return;
  const para = paragraphOf(i);
  const qs = interviewQuestions(para.text, tellsIn(s));
  box.innerHTML = `<div class="qa">${qs.map((q, k) => `<label for="qa-${i}-${k}">${esc(q)}</label><input id="qa-${i}-${k}" data-q="${k}" placeholder="Your answer, in a few words">`).join('')}
    <div class="acts"><button class="btn" type="button" data-act="ask-go">Rewrite with my answers</button><span class="small">Only what you write here may be added. Your other facts stay as they are.</span></div></div>`;
}

async function askGo(i, box) {
  const para = paragraphOf(i);
  const answers = [...box.querySelectorAll('[data-q]')].map((el) => el.value.trim()).filter(Boolean);
  if (!answers.length) { toast('Answer at least one question first.'); return; }
  box.insertAdjacentHTML('beforeend', '<p class="small" data-status>Looking for a rewriter…</p>');
  await probeEngines();
  box.querySelector('[data-status]')?.remove();
  // Interview needs a model that follows instructions: Humanizer 12B only restyles text as it stands
  const canFollow = (id) => engineStatus[id]?.ok && (id !== 'local' || !engineStatus.local.humanizer || engineStatus.local.chatModel);
  const saved = store.get(K.engine, null);
  const webllmOk = saved === 'webllm' || !!pickEngine(webllmMod, 'webllm')?.model;  // never start a 1-5 GB download unasked
  const engineId = saved === 'manual' ? 'manual'
    : [saved, 'local', 'webllm'].find((id) => id && id !== 'manual' && canFollow(id) && (id !== 'webllm' || webllmOk)) || 'manual';
  const req = { ...interviewPrompt({ paragraph: para.text, answers, voice: voice() }), n: 3, maxTokens: 600 };
  if (engineId === 'manual') {
    box.insertAdjacentHTML('beforeend', `<div class="field"><label>Copy this into a Claude chat, then paste the reply below</label><textarea readonly>${esc(`${req.system}\n\n${req.user}`)}</textarea><textarea data-paste placeholder="Paste Claude's reply here"></textarea><button class="btn" type="button" data-act="ask-paste">Check this version</button></div>`);
    box.dataset.answers = JSON.stringify(answers);
    return;
  }
  box.insertAdjacentHTML('beforeend', '<p class="small" data-status>Writing versions with your answers…</p>');
  try {
    const eng = pickEngine(engineId === 'local' ? localMod : webllmMod, engineId);
    const status = (msg) => { const el = box.querySelector('[data-status]'); if (el && msg) el.textContent = msg; };
    const out = (await eng.generate([req], { onProgress: (p) => status(p?.message) }))[0] || [];
    await showAskCandidates(i, box, para, out, answers);
  } catch (err) { box.querySelector('[data-status]').textContent = `Could not write versions: ${err?.message || err}`; }
}

async function showAskCandidates(i, box, para, raw, answers) {
  const ctx = await guardCtx(answers);
  const cands = raw.map((t) => cleanText(cleanOutput(t)).text.trim()).filter(Boolean);
  const ok = [], bad = [];
  const breaks = (s) => (s.match(/\n/g) || []).length;
  for (const c of cands) {
    if (breaks(c) !== breaks(para.text)) { bad.push({ c, g: { ok: false, reasons: [{ code: 'layout', message: 'it changed the paragraph breaks' }] } }); continue; }
    const g = await gateCandidate(para.text, c, ctx);
    (g.ok ? ok : bad).push({ c, g });
  }
  const st = box.querySelector('[data-status]');
  if (st) st.remove();
  if (!ok.length) {
    box.insertAdjacentHTML('beforeend', `<p class="small">No version passed the checks: ${esc(bad.flatMap((b) => b.g.reasons.map((r) => r.message)).slice(0, 3).join(' · ') || 'empty reply')}.</p>`);
    return;
  }
  const scores = await guideScores(ok.map((x) => x.c));
  const best = ok.map((x, k) => ({ ...x, s: scores[k] })).sort((a, b) => a.s - b.s);
  box.dataset.opts = JSON.stringify(best.map((b) => b.c));
  box.dataset.para = JSON.stringify(para);
  box.insertAdjacentHTML('beforeend', best.map((b, k) => `<button type="button" class="opt" data-popt="${k}"><span class="why">Checker score ${Math.round(b.s)} (lower is more human)</span>${esc(b.c)}</button>`).join(''));
}

function applyParagraph(para, replacement) {
  const text = editor.value;
  const at = text.slice(para.start, para.end).trim() === para.text ? text.indexOf(para.text, para.start) : text.indexOf(para.text);
  if (at < 0) { toast('That paragraph has changed since the check. Press Check again.'); return; }
  snapshot('Before paragraph rewrite');
  setText(text.slice(0, at) + replacement + text.slice(at + para.text.length), 'Paragraph rewrite with your answers');
  snapshot('Paragraph rewrite with your answers');
  toast('Paragraph replaced. Checking again…');
  setTimeout(runCheck, 600);
}

function selectRange(start, end) {
  editor.focus();
  editor.setSelectionRange(start, end);
  const lineH = 17 * 1.7;
  const before = editor.value.slice(0, start).split('\n').length;
  const r = editor.getBoundingClientRect();
  window.scrollTo({ top: window.scrollY + r.top + Math.max(0, before - 3) * lineH - 120, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// ---------- my writing ----------
async function renderSamples() {
  let list = [];
  try { list = await mine.listSamples(); } catch { /* storage blocked */ }
  state.personal = mine.personalSummary(list);
  const el = $('sampleList');
  el.innerHTML = list.length ? list.map((s) => `<div class="sample" data-id="${esc(s.id)}">
      <div>${s.words} words${typeof s.risk === 'number' ? ` · risk <b>${s.risk}</b>` : ''}${s.voice ? ' · <b>voice example</b>' : ''}</div>
      <div class="acts"><label class="check"><input type="checkbox" data-voice${s.voice ? ' checked' : ''}> Voice example</label><button class="btn quiet" type="button" data-del>Remove</button></div>
      <div class="txt">${esc(s.text.slice(0, 400))}</div></div>`).join('') : '<p class="empty">No samples yet.</p>';
  const sum = $('samplesSummary');
  if (state.personal) {
    sum.hidden = false;
    sum.textContent = `${state.personal.n} of your samples checked: ${state.personal.high} High, ${state.personal.mid} Medium, ${state.personal.low} Low (median ${state.personal.median}, highest ${state.personal.max}). If your genuine writing scores High, the checkers are misreading your style, not catching AI.`;
  } else sum.hidden = true;
  renderVerdict();
}

async function checkSamples() {
  const list = await mine.checkSamples();
  if (!list.length) { toast('Add some samples first (and leave at least one unmarked as a voice example).'); return; }
  const keys = modelKeys().filter((k) => state.ready[k] === 'ready' && modeCal()?.checkers?.[k]);
  if (!keys.length) { toast('The checkers are still loading. Try again in a moment.'); return; }
  $('checkSamplesBtn').disabled = true;
  try {
    for (const [n, s] of list.entries()) {
      toast(`Checking sample ${n + 1} of ${list.length}…`);
      const res = {};
      for (const key of keys) {
        try { res[key] = { status: 'done', raw: (await modelWorker.call({ type: 'score', key, texts: [s.text] })).probs[0] }; } catch { /* skip */ }
      }
      try { const z = await zippyWorker.call({ type: 'score', text: s.text }); res.zippy = { status: 'done', raw: z.determination === 'AI' ? z.score : -z.score }; } catch { /* skip */ }
      try { res.tells = tellResult(s.text); } catch { /* skip */ }
      const e = ensemble(res);
      if (e) await mine.updateSample(s.id, { risk: e.risk });
    }
    await renderSamples();
    toast('Your samples have been checked.');
  } finally { $('checkSamplesBtn').disabled = false; }
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
function openOverlay(id) { const o = $(id); o.hidden = false; o.querySelector('[data-close], button')?.focus(); }
function closeOverlay(id) { if (id === 'rewriteOverlay') rw.ctl?.abort(); $(id).hidden = true; }
const OVERLAYS = ['rewriteOverlay', 'versionsOverlay', 'settingsOverlay', 'writingOverlay', 'guideOverlay'];

function wire() {
  editor.addEventListener('input', onEdit);
  editor.addEventListener('click', () => {
    const pos = editor.selectionStart;
    const flagged = new Set(flaggedSentences().map((f) => f.i));
    const i = state.sentences.findIndex((s, k) => flagged.has(k) && pos >= s.start && pos <= s.end);
    if (i !== state.focusSentence) {
      state.focusSentence = i; renderBackdrop();
      for (const c of $('sentList').querySelectorAll('.sent')) c.classList.toggle('focus', Number(c.dataset.i) === i);
    }
    if (i >= 0) document.querySelector(`.sent[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('resize', () => { autosize(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCheck(); }
    if (e.key === 'Escape') for (const id of OVERLAYS) if (!$(id).hidden) closeOverlay(id);
  });
  $('checkBtn').onclick = runCheck;
  $('rewriteBtn').onclick = () => openRewrite();
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
  $('cleanBtn').onclick = () => { const r = cleanText(editor.value); setText(r.text, 'Clean hidden characters'); toast('Cleaned. Undo brings the original back.'); };
  $('clearExampleBtn').onclick = () => { state.runId++; setChecking(false); $('exampleNote').hidden = true; store.set(K.seen, true); setText('', 'Clear example'); state.lastCheck = null; state.results = {}; state.sentences = []; renderAll(); editor.focus(); };
  editor.addEventListener('paste', () => { if (!$('exampleNote').hidden && editor.value === EXAMPLE) { $('exampleNote').hidden = true; store.set(K.seen, true); } });

  $('ledger').addEventListener('click', (e) => {
    const k = e.target.closest('[data-retry],[data-load]');
    if (!k) return;
    if (k.dataset.load) { store.set(K.heavy, true); $('heavyToggle').checked = true; }
    const key = k.dataset.retry || k.dataset.load;
    ensureReady(key).then(() => { if (state.lastCheck && state.lastCheck.text === editor.value) runCheck(); }).catch(() => {});
  });
  $('xcheck').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    try { await navigator.clipboard.writeText(editor.value); toast('Answer copied. Paste it into the site that just opened.'); } catch { toast('Copy the answer with Copy text, then paste it there.'); }
    window.open(b.dataset.x, '_blank', 'noopener');
  });
  $('sentList').addEventListener('click', (e) => {
    const card = e.target.closest('.sent');
    if (!card) return;
    const i = Number(card.dataset.i);
    const s = state.sentences[i];
    const box = card.querySelector('[data-sugg]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    const popt = e.target.closest('[data-popt]');
    if (act === 'select' && s) { state.focusSentence = i; renderBackdrop(); selectRange(s.start, s.end); }
    else if (act === 'rewrite') openRewrite([i]);
    else if (act === 'ask') askFor(i, box);
    else if (act === 'ask-go') askGo(i, box);
    else if (act === 'ask-paste') {
      const para = paragraphOf(i);
      showAskCandidates(i, box, para, [box.querySelector('[data-paste]').value], JSON.parse(box.dataset.answers || '[]'))
        .catch((err) => toast(`Could not check this version: ${err?.message || err}`));
    } else if (popt) {
      const opts = JSON.parse(box.dataset.opts || '[]');
      const para = JSON.parse(box.dataset.para || 'null');
      if (para && opts[popt.dataset.popt]) applyParagraph(para, opts[popt.dataset.popt]);
    }
  });
  $('tellList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tell]');
    if (!b) return;
    const [a, z] = b.dataset.tell.split(':').map(Number);
    selectRange(a, z);
  });

  for (const id of OVERLAYS) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id) || e.target.closest('[data-close]')) closeOverlay(id);
    });
  }
  $('engineList').addEventListener('click', (e) => {
    if (e.target.closest('[data-guide]')) { e.preventDefault(); openGuide(); }
  });
  $('startBtn').onclick = () => startRewrite().catch((err) => { showStage('run'); logLine(`Could not start: ${err?.message || err}`); });
  $('usePastedBtn').onclick = () => usePasted();
  $('optAll').addEventListener('change', refreshTargets);
  $('stopBtn').onclick = () => rw.ctl?.abort();
  $('acceptBtn').onclick = acceptRewrite;
  $('copyPromptBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('promptOut').value); toast('Request copied. Paste it into a Claude chat.'); }
    catch { $('promptOut').focus(); $('promptOut').select(); toast('Press Ctrl+C (or ⌘C) to copy.'); }
  };
  $('guideRecheckBtn').onclick = async () => { closeOverlay('guideOverlay'); if (!$('rewriteOverlay').hidden) await probeEngines(); else toast('Open Rewrite flagged to use it.'); };

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

  $('myWritingBtn').onclick = async () => { await renderSamples(); openOverlay('writingOverlay'); };
  $('addSampleBtn').onclick = async () => {
    try {
      const r = await mine.addSamples($('sampleInput').value);
      $('sampleInput').value = '';
      toast(r.added ? `Added ${r.added} sample${r.added > 1 ? 's' : ''}.` : r.tooShort ? 'Each piece needs at least 40 words.' : 'Nothing new to add.');
      await renderSamples();
    } catch (err) { toast(String(err?.message || err)); }
  };
  $('checkSamplesBtn').onclick = () => checkSamples().catch((err) => toast(String(err?.message || err)));
  $('sampleList').addEventListener('click', async (e) => {
    const row = e.target.closest('.sample');
    if (!row) return;
    try {
      if (e.target.closest('[data-del]')) await mine.removeSample(row.dataset.id);
      else if (e.target.closest('[data-voice]')) await mine.updateSample(row.dataset.id, { voice: e.target.checked });
      else return;
    } catch (err) { toast(String(err?.message || err)); }
    await renderSamples();
  });

  $('settingsBtn').onclick = () => {
    $('voiceInput').value = voice();
    $('heavyToggle').checked = heavyEnabled();
    $('portInput').value = store.get(K.local, '') || '';
    $('clearConfirm').hidden = true;
    openOverlay('settingsOverlay');
  };
  $('saveSettingsBtn').onclick = () => {
    const v = $('voiceInput').value.trim();
    store.set(K.voice, v && v !== DEFAULT_VOICE ? v : '');
    const heavy = $('heavyToggle').checked;
    store.set(K.heavy, heavy);
    store.set(K.local, $('portInput').value.trim());
    closeOverlay('settingsOverlay');
    renderPills(); renderLedger();
    if (heavy) for (const c of visible()) if (c.heavy) ensureReady(c.key).catch(() => {});
    toast('Settings saved.');
  };
  $('clearDataBtn').onclick = async () => {
    if ($('clearConfirm').hidden) { $('clearConfirm').hidden = false; return; }
    for (const k of Object.values(K)) store.del(k);
    try { await mine.clearSamples(); } catch { /* ignore */ }
    state.personal = null;
    $('clearConfirm').hidden = true;
    renderVerdict();
    toast('Saved data cleared from this device.');
  };
}

function openGuide() {
  // the model card's own command (Q8_0 needs about 14 GB free; on 16 GB Macs use humanizer-12b-Q6_K.gguf)
  const cmd = localMod.SETUP_COMMAND || 'llama-server --hf-repo jialinyyzz/humanizer --hf-file humanizer-12b-Q8_0.gguf -c 8192 -np 1 -ngl 99 --port 8080';
  $('serverCmd').textContent = cmd;
  openOverlay('guideOverlay');
}

// Save at once when the tab is hidden or closed, so a pending autosave is never lost.
function flushDraft() {
  clearTimeout(saveTimer);
  const ok = store.set(K.draft, editor.value);
  if (!ok) $('saveState').textContent = 'Not saved: this browser blocks storage';
}
addEventListener('pagehide', flushDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });

function renderAll() { onEdit(); state.tells = safeTells(editor.value); renderPills(); renderLedger(); renderVerdict(); renderSentences(); renderTells(); renderBackdrop(); }

function boot() {
  const draft = store.get(K.draft, null);
  if (draft !== null && draft !== '') editor.value = draft;
  else if (!store.get(K.seen, false)) { editor.value = EXAMPLE; $('exampleNote').hidden = false; }
  wire();
  renderAll();
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
  mine.listSamples().then((l) => { state.personal = mine.personalSummary(l); renderVerdict(); }).catch(() => {});
  warmUp().then(() => {
    // show the example's result straight away so the first view is a working one
    if (editor.value === EXAMPLE && !state.lastCheck) runCheck();
  });
}
boot();
