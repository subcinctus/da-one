// The owner's own writing samples, kept only in this browser (IndexedDB, with a localStorage fallback).
// Up to three are marked as voice examples for the rewriter; the others measure how the checkers score
// the owner's genuine writing. A sample is never used for both.

import { words } from './text.mjs';

const DB = 'answer-desk', STORE = 'samples', LS_KEY = 'ard.samples';
export const MAX_VOICE = 3;

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function tx(d, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const lsSet = (list) => { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); return true; } catch { return false; } };

export async function listSamples() {
  const d = await db();
  const list = d ? await tx(d, 'readonly', (s) => s.getAll()) : lsGet();
  return (list || []).sort((a, b) => a.added - b.added);
}

async function putAll(items) {
  const d = await db();
  if (d) { await tx(d, 'readwrite', (s) => { for (const it of items) s.put(it); }); return; }
  const list = lsGet();
  for (const it of items) { const i = list.findIndex((x) => x.id === it.id); if (i >= 0) list[i] = it; else list.push(it); }
  if (!lsSet(list)) throw new Error('This browser blocks storage, so samples cannot be saved.');
}

// Split pasted text on lines that hold only "---"; drop pieces under 40 words (too short to score).
export function splitPieces(text) {
  return String(text).split(/^\s*-{3,}\s*$/m).map((p) => p.trim()).filter((p) => words(p) >= 40);
}

export async function addSamples(text) {
  const pieces = splitPieces(text);
  const existing = new Set((await listSamples()).map((s) => s.text));
  const now = Date.now();
  const items = pieces.filter((p) => !existing.has(p)).map((p, i) => ({
    id: `${now}-${i}`, text: p, words: words(p), added: now + i, voice: false, risk: null,
  }));
  if (items.length) await putAll(items);
  return { added: items.length, skipped: pieces.length - items.length, tooShort: String(text).trim() && !pieces.length };
}

export async function updateSample(id, patch) {
  const list = await listSamples();
  const it = list.find((x) => x.id === id);
  if (!it) return null;
  if (patch.voice && !it.voice && list.filter((x) => x.voice).length >= MAX_VOICE) throw new Error(`Up to ${MAX_VOICE} voice examples.`);
  const next = { ...it, ...patch };
  if (next.voice) next.risk = null;  // voice examples are not used to measure scores
  await putAll([next]);
  return next;
}

export async function removeSample(id) {
  const d = await db();
  if (d) { await tx(d, 'readwrite', (s) => s.delete(id)); return; }
  lsSet(lsGet().filter((x) => x.id !== id));
}

export async function clearSamples() {
  const d = await db();
  if (d) await tx(d, 'readwrite', (s) => s.clear());
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

export const voiceSamples = async () => (await listSamples()).filter((s) => s.voice).map((s) => s.text);
export const checkSamples = async () => (await listSamples()).filter((s) => !s.voice);

// Summary of how the checkers scored the owner's own writing (samples with a stored risk).
export function personalSummary(samples) {
  const scored = samples.filter((s) => !s.voice && typeof s.risk === 'number');
  if (!scored.length) return null;
  const risks = scored.map((s) => s.risk).sort((a, b) => a - b);
  const high = risks.filter((r) => r >= 65).length, mid = risks.filter((r) => r >= 40 && r < 65).length;
  return { n: risks.length, high, mid, low: risks.length - high - mid, max: risks[risks.length - 1], median: risks[Math.floor(risks.length / 2)] };
}
