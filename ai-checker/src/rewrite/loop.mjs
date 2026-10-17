// Rewrite loop for flagged sentences. Asks the engine for versions of each target sentence, throws
// out every version the guards reject, and keeps the one that lowers the guide checkers' score of
// its 3-sentence window the most. The validator checker is held back: it scores the whole answer
// once before and once after, never during selection, so a rewrite cannot simply be tuned to it.
// Everything is injected (engine, checkers, guards), so the module is pure. No DOM access.
import { splitSentences } from '../text.mjs';

export const MIN_GAIN = 2;          // guide points a version must beat the current sentence by
export const GOODHART_GUIDE = 10;   // a guide-average gain this large...
export const GOODHART_VALIDATOR = 3; // ...should move the held-back validator by at least this much
const EPS = 1e-9;                   // float slack for the thresholds above
const BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
const END = /[.!?…]["'’”)\]]*$/;
// Leading list marker: a bullet symbol, or "-", "*", "–", "—", "##", "1.", "1)", "(1)", "a)", "(a)",
// "(iv)" followed by a space. Not ">", "+" or "#": "> 90%", "+12%" and "# of" are wording.
const MARKER = /^(?:[•◦▪▫‣⁃·●○■□►▸▹→➔➢➤✓✔]+[^\S\r\n]*|(?:[-*–—]|#{2,6}|\d{1,3}[.)]|\(\d{1,3}\)|\(?(?:[a-z]|[ivx]{2,5})\))[^\S\r\n]+)/i;
const HAS_WORD = /[\p{L}\p{N}]/u;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const toNum = (x, d) => (x === null || x === '' || !Number.isFinite(Number(x)) ? d : Number(x));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Always an error named AbortError, whatever reason the caller aborted with.
export function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error && r.name === 'AbortError') return r;
  const e = new Error('The rewrite was stopped.');
  e.name = 'AbortError';
  if (r !== undefined) e.cause = r;
  return e;
}

// Await `p` but reject as soon as `signal` aborts: an engine may ignore the signal. Handlers stay
// attached to `p`, so its late rejection is never unhandled.
function until(p, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(abortError(signal));
    signal?.addEventListener?.('abort', fail, { once: true });
    const off = () => signal?.removeEventListener?.('abort', fail);
    Promise.resolve(p).then((v) => { off(); if (signal?.aborted) fail(); else resolve(v); },
      (e) => { off(); if (signal?.aborted) fail(); else reject(e); });
    if (signal?.aborted) fail();
  });
}

// Offsets must describe `text` exactly: replacing a stale span would corrupt the answer.
function fitSentences(text, list) {
  if (!Array.isArray(list)) throw new TypeError('rewriteFlagged: sentences must be an array');
  let last = 0;
  return list.map((s, k) => {
    const start = s?.start, end = s?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < last || end < start || end > text.length) {
      throw new RangeError(`rewriteFlagged: sentence ${k} has offsets that do not fit the text`);
    }
    const t = text.slice(start, end);
    if (s.text != null && s.text !== t) throw new RangeError(`rewriteFlagged: sentence ${k} does not match the text at its offsets`);
    last = end;
    // versions are trimmed, so a span must be too, or "rate. Next" would become "rate.Next"
    const lead = t.length - t.trimStart().length, body = t.trim();
    return { start: start + lead, end: start + lead + body.length, text: body };
  });
}

// prev + middle + next, with the original spacing between them (as the page's sentence heat does).
export function windowOf(text, S, i, middle = S[i].text) {
  const a = S[Math.max(0, i - 1)].start, b = S[Math.min(S.length - 1, i + 1)].end;
  return text.slice(a, S[i].start) + middle + text.slice(S[i].end, b);
}

// Replace sentences right-to-left so earlier offsets stay valid, then shift every offset.
export function applyChanges(text, S, accepted) {
  if (!accepted.size) return { text, sentences: S };
  let out = text;
  for (const i of [...accepted.keys()].sort((a, b) => S[b].start - S[a].start || b - a)) {
    out = out.slice(0, S[i].start) + accepted.get(i) + out.slice(S[i].end);
  }
  let shift = 0;
  const sentences = S.map((s, i) => {
    const t = accepted.has(i) ? accepted.get(i) : s.text, start = s.start + shift;
    shift += t.length - (s.end - s.start);
    return { start, end: start + t.length, text: t };
  });
  return { text: out, sentences };
}

// A list marker is layout, not wording, and the guards do not look at it: a version keeps the
// original's marker ("• Growth held up." for "• Growth was robust.") and never brings its own.
const markerOf = (s) => MARKER.exec(s)?.[0] ?? '';
export function keepMarker(original, c) {
  const body = c.slice(markerOf(c).length).trimStart();
  return body ? markerOf(original) + body : c;
}

// Trimmed, de-duplicated strings, with the original's list marker, that differ from both the
// current version and the original.
function pick(got, i, current, original) {
  const list = got instanceof Map ? got.get(i) ?? got.get(String(i)) : got?.[i];
  const seen = new Set(), out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const t = typeof c === 'string' && c.trim() ? keepMarker(original, c.trim()) : '';
    if (t && t !== current && t !== original && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Layout checks the sentence-level guards cannot see: a version must not split the paragraph or
// run into the next sentence.
function layoutReasons(original, c) {
  const out = [];
  if (BREAK.test(c) && !BREAK.test(original)) out.push({ code: 'layout', message: 'Adds a line break inside the sentence.' });
  if (END.test(original) && !END.test(c)) out.push({ code: 'layout', message: 'Drops the full stop at the end of the sentence.' });
  return out;
}

async function runGate(gate, original, c, context, signal) {
  const layout = layoutReasons(original, c);
  if (layout.length) return { ok: false, reasons: layout };
  try {
    const g = await until(gate(original, c, { context }), signal);
    const reasons = Array.isArray(g?.reasons) ? g.reasons : [];
    if (g?.ok === true) return { ok: true, reasons };
    return { ok: false, reasons: reasons.length ? reasons : [{ code: 'gate', message: 'Did not pass the guards.' }] };
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (err?.name === 'AbortError') throw err;
    // a guard that cannot run fails closed
    return { ok: false, reasons: [{ code: 'error', message: `A guard could not run: ${err?.message || err}` }] };
  }
}

// The held-back checker is advisory: if it fails, the result simply has no confirmation.
async function held(fn, text, signal) {
  try {
    const v = await until(fn(text), signal);
    return isNum(v) ? v : null;
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

/**
 * Rewrite the target sentences of `text`. See src/README.md for the contract.
 * getCandidates(items, round) gets items {index, before, sentence, after, original, score, previous}
 * where `sentence` is the current best version, `score` its window score (null in round 0) and
 * `previous` every version tried so far as {candidate, score, ok, round}. `round` is 0-based here
 * and in onProgress. Throws an error named AbortError when `signal` aborts; never returns partial text.
 */
export async function rewriteFlagged({ text, sentences, targets = [], getCandidates, scoreGuide, scoreValidator, gate,
  rounds = 3, targetPct = 85, signal, onProgress } = {}) {
  if (typeof text !== 'string') throw new TypeError('rewriteFlagged: text must be a string');
  for (const [name, f] of [['getCandidates', getCandidates], ['scoreGuide', scoreGuide], ['gate', gate]]) {
    if (typeof f !== 'function') throw new TypeError(`rewriteFlagged: ${name} must be a function`);
  }
  const halt = () => { if (signal?.aborted) throw abortError(signal); };
  halt();
  let S = fitSentences(text, sentences ?? splitSentences(text));
  const maxRounds = Math.max(0, Math.floor(toNum(rounds, 3)));
  const goal = toNum(targetPct, 85);
  const order = [...new Set(Array.from(targets ?? []))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < S.length && HAS_WORD.test(S[i].text)).sort((a, b) => a - b);
  const total = order.length * maxRounds;
  let done = 0, cur = text, active = order, last = 0;
  const tell = (round, message) => {
    try { onProgress?.({ round, done, total, message }); } catch { /* a progress UI bug must not stop the rewrite */ }
  };
  const st = new Map(order.map((i) => [i, {
    original: S[i].text, cur: S[i].text, score: null, guideBefore: null, rejected: [], previous: [], gates: new Map(), rounds: 0,
  }]));
  const near = (j) => S[j]?.text ?? '';

  for (let round = 0; round < maxRounds && active.length; round++) {
    last = round;
    const R = `Round ${round + 1} of ${maxRounds}`;
    const items = active.map((i) => {
      const s = st.get(i);
      return { index: i, before: near(i - 1), sentence: s.cur, after: near(i + 1), original: s.original,
        score: s.score, previous: s.previous.map((p) => ({ ...p })) };
    });
    tell(round, `${R}: asking for new versions of ${plural(active.length, 'sentence')}…`);
    halt();
    const got = await until(getCandidates(items, round), signal);

    // Guards first: only versions that keep every fact are worth scoring.
    const lists = new Map(active.map((i) => [i, pick(got, i, st.get(i).cur, st.get(i).original)]));
    const count = [...lists.values()].reduce((a, l) => a + l.length, 0);
    tell(round, `${R}: checking ${plural(count, 'version')} against the fact and meaning guards…`);
    const pool = new Map();
    let passed = 0;
    for (const i of active) {
      const s = st.get(i), ok = [];
      s.rounds++;
      for (const c of lists.get(i)) {
        let g = s.gates.get(c);
        if (!g) {
          halt();
          g = await runGate(gate, s.original, c, { index: i, round, before: near(i - 1), after: near(i + 1) }, signal);
          s.gates.set(c, g);
          if (!g.ok) {
            s.rejected.push({ candidate: c, reasons: g.reasons, round });
            s.previous.push({ candidate: c, score: null, ok: false, round });
          }
        }
        if (g.ok) ok.push(c);
      }
      passed += ok.length;
      pool.set(i, ok);
    }

    // One guide call per round: each sentence's own window (neighbours may have changed) plus every
    // version that passed. Round 0 always scores the own windows so guideBefore is known.
    const own = round === 0 ? active : active.filter((i) => pool.get(i).length);
    const fresh = new Map(), scored = new Map(own.map((i) => [i, []]));
    if (own.length) {
      if (passed) tell(round, `${R}: scoring ${plural(passed, 'version')} that passed the guards…`);
      const texts = [], slots = [];
      for (const i of own) { texts.push(windowOf(cur, S, i, st.get(i).cur)); slots.push([i, null]); }
      for (const i of own) for (const c of pool.get(i)) { texts.push(windowOf(cur, S, i, c)); slots.push([i, c]); }
      halt();
      const out = await until(scoreGuide(texts), signal);
      slots.forEach(([i, c], k) => {
        const v = isNum(out?.[k]) ? out[k] : null, s = st.get(i);
        if (c !== null) { scored.get(i).push({ c, v }); s.previous.push({ candidate: c, score: v, ok: true, round }); return; }
        fresh.set(i, v);
        if (round === 0) s.guideBefore = v;
        if (v !== null || round === 0) s.score = v;
      });
    }

    // Lowest window score that beats the current version by MIN_GAIN; ties keep the earlier version.
    const accepted = new Map(), next = [];
    for (const i of active) {
      const s = st.get(i), base = fresh.get(i);
      let best = null;
      if (isNum(base)) {
        for (const { c, v } of scored.get(i) || []) if (isNum(v) && base - v >= MIN_GAIN - EPS && (!best || v < best.v)) best = { c, v };
      }
      if (best) { accepted.set(i, best.c); s.cur = best.c; s.score = best.v; }
      if (best && s.score > goal && round + 1 < maxRounds) { next.push(i); done += 1; } else done += maxRounds - round;
    }
    ({ text: cur, sentences: S } = applyChanges(cur, S, accepted));
    const still = next.length ? `; ${plural(next.length, 'sentence')} still above ${goal}` : '';
    tell(round, accepted.size ? `${R}: ${plural(accepted.size, 'sentence')} improved${still}.`
      : `${R}: no version passed the guards and beat the current sentence.`);
    active = next;
  }

  halt();
  const changed = cur !== text;
  const changes = order.map((i) => {
    const s = st.get(i);
    return { index: i, before: s.original, after: s.cur, guideBefore: s.guideBefore, guideAfter: s.score, rejected: s.rejected, rounds: s.rounds };
  });
  // The validator only runs when something changed: exactly twice, after selection is over.
  let validator = { before: null, after: null };
  if (changed && typeof scoreValidator === 'function') {
    tell(last, 'Confirming the result with the held-back checker…');
    const before = await held(scoreValidator, text, signal);
    const after = await held(scoreValidator, cur, signal);
    validator = { before, after };
  }
  halt();

  const warnings = [];
  if (!changed) warnings.push('no-change');
  else if (!isNum(validator.before) || !isNum(validator.after)) warnings.push('no-validator');
  else {
    const pairs = changes.filter((c) => isNum(c.guideBefore) && isNum(c.guideAfter));
    const gain = pairs.length ? mean(pairs.map((c) => c.guideBefore)) - mean(pairs.map((c) => c.guideAfter)) : 0;
    if (gain >= GOODHART_GUIDE - EPS && validator.before - validator.after < GOODHART_VALIDATOR - EPS) warnings.push('goodhart');
  }
  const n = changes.filter((c) => c.after !== c.before).length;
  tell(last, changed ? `Done: ${n} of ${plural(order.length, 'sentence')} changed.` : 'Done: nothing changed.');
  return { text: cur, changes, validator, warnings };
}
