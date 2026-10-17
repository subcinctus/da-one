// Rewrite guards: a candidate reaches the owner only if it keeps the facts, the meaning and the
// grammar of the original. The cheap checks always run and all report; the injected model checks
// (grammar, embeddings, NLI) run cheapest first and only while nothing has failed. No DOM access.
import { words } from './text.mjs';
import { auditText } from './normalize.mjs';
import { compareFacts } from './facts.mjs';

export const DEFAULT_LIMITS = Object.freeze({ entailment: 0.80, contradiction: 0.10, cosine: 0.85, maxEditRatio: 0.80,
  minLengthRatio: 0.6, maxLengthRatio: 1.6 });

const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const nfc = (x) => str(x).normalize('NFC'); // a decomposed "Société" is the same word
const errText = (e) => str((e && e.message) || e) || 'unknown error';
const f2 = (x) => Number(x).toFixed(2);
const pct = (x) => `${Math.round(x * 100)}%`;
const list = (a, n = 6) => a.slice(0, n).join(', ') + (a.length > n ? ` and ${a.length - n} more` : '');

function limitsOf(over) {
  const L = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(L)) if (over && Number.isFinite(over[k])) L[k] = over[k];
  return L;
}

// ---------- edit ratio ----------
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’.,-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
const tokens = (t) => (nfc(t).toLowerCase().replace(/’/g, "'").match(WORD_RE) || []);

// Multiset difference: a lower bound of Levenshtein, used only when the full table is too big.
function bagDistance(A, B) {
  const c = new Map();
  for (const w of A) c.set(w, (c.get(w) || 0) + 1);
  let extra = 0;
  for (const w of B) { const n = c.get(w) || 0; if (n) c.set(w, n - 1); else extra++; }
  let missing = 0;
  for (const n of c.values()) missing += n;
  return Math.max(missing, extra);
}

function levenshtein(A, B) {
  if (!A.length || !B.length) return A.length + B.length;
  if (A.length * B.length > 2.5e7) return bagDistance(A, B);
  let prev = new Uint32Array(B.length + 1).map((_, j) => j), cur = new Uint32Array(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[B.length];
}

// Word-level Levenshtein distance / max word count (case and punctuation ignored).
export function editRatio(a, b) {
  const A = tokens(a), B = tokens(b), max = Math.max(A.length, B.length);
  if (!max) return 0;
  let p = 0, s = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return levenshtein(A.slice(p, A.length - s), B.slice(p, B.length - s)) / max;
}

// ---------- model self-talk ----------
// Counted against the original, so an answer that really says "Here is our plan" may keep it.
const META = [
  /^\s*(?:sure|certainly|of course|okay|ok|absolutely|great|got it|no problem|alright)\b\s*[!,.:]/i,
  /\bhere(?:'s|’s| is| are)\b/gi,
  /\bas an ai\b(?![-\u2010\u2011])/gi, // not "as an AI-first lender"
  /\b(?:large )?language model\b/gi,
  // "a revised draft of the policy" is business English; only the model calls its output that
  /\b(?:rewritten|rephrased|reworded|paraphrased|humani[sz]ed) (?:version|sentence|text|paragraph|draft)s?\b/gi,
  /\b(?:revised|edited|polished) (?:sentence|paragraph)s?\b|\bmy (?:revised|edited|improved|polished|updated) (?:version|text|draft)s?\b/gi,
  /\bI(?:'ve|’ve| have)? (?:rewritten|rephrased|reworded|paraphrased|humani[sz]ed)\b/gi,
  /\b(?:this|the above|the following|my) (?:rewrite|rewritten|rephrased|reworded)\b/gi,
  /\b(?:the|your) original (?:sentence|text|paragraph|answer|version|wording)\b/gi,
  /\b(?:i hope this helps|hope this helps|let me know if|feel free to)\b/gi,
  // the model's sign-off ("Happy to help!", "I'm glad to help"), not "we are happy to help more MSMEs"
  /(?:^|[.!?\n])[ \t]*(?:happy|glad) to help\b|\bI(?:'m|’m| am|'d be|’d be| would be|'ll be|’ll be| will be) (?:happy|glad) to help\b/gi,
  /\bI(?:'m|’m| am) sorry,? but\b|\bI (?:cannot|can't|can’t) (?:help|assist|rewrite|comply)\b/gi,
  /(?:^|\n)[ \t]*(?:\*\*)?(?:original|rewrite|rewritten|revised|edited|improved|version|option|variant|output)(?:[ \t]+(?:version|sentence|text|paragraph|draft))?(?:[ \t]*#?\d+)?(?:\*\*)?[ \t]*[:：]/gi,
  /<\/?think(?:ing)?>|```/gi,
  /\bword count\b/gi,
];
const hitsOf = (re, t) => (re.global ? t.match(re) || [] : (t.match(re) || []).slice(0, 1));

function metaPhrases(orig, cand) {
  const out = [];
  for (const re of META) {
    const c = hitsOf(re, cand);
    if (c.length > hitsOf(re, orig).length) out.push(c[0].replace(/^[\s.!?]+/, '').trim());
  }
  return out;
}

// ---------- new names and acronyms ----------
const NAME_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’&][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
// Function words, currency and unit words, and months: the facts check owns amounts and dates.
const NOT_NAMES = new Set(("i ok not no never nor none cannot may might will would must should could can shall "
  + 'rs re inr usd eur gbp cr crs mn mln bn tn bps bp pct pp ppt ppts lakh lakhs lac lacs crore crores fy cy '
  + 'jan feb mar apr jun jul aug sep sept oct nov dec january february march april june july august september '
  + 'october november december').split(' '));
const bare = (t) => t.replace(/’/g, "'").replace(/'s$/i, '');
const keyOf = (t) => bare(t).replace(/(\p{Lu}{2,})s$/u, '$1').toLowerCase(); // DSAs → dsa

// Lower-case keys of the words in `texts` (only those written in lower case when `lowerOnly`).
function vocab(texts, lowerOnly = false) {
  const v = new Set();
  for (const t of texts) {
    for (const m of nfc(t).matchAll(NAME_RE)) {
      const b = bare(m[0]);
      if (!lowerOnly || b === b.toLowerCase()) { v.add(keyOf(m[0])); v.add(b.toLowerCase()); }
    }
  }
  return v;
}

// Sentence starts are capitalised anyway; only the words after them can be told apart as names.
function isInitial(t, i) {
  let j = i - 1;
  while (j >= 0 && /[\s"'“”‘’([{*•#>\-–—]/.test(t[j])) { if (t[j] === '\n') return true; j--; }
  return j < 0 || /[.!?:…]/.test(t[j]);
}

// "Tier-II and III" is "Tier 2 and 3": the facts check owns tier terms, so II and III are no acronyms.
const TIERS = /\btier[ \u00a0-]?(?:\d|iv|i{1,3})\b(?:[ \u00a0]*(?:,|\/|&|and|or|to|-|–)[ \u00a0]*(?:tier[ \u00a0-]?)?(?:\d|iv|i{1,3})\b)*/gi;

function newEntities(orig, text, allow) {
  const known = vocab([orig, ...allow]), out = new Map(), cand = nfc(text);
  const tiers = [...cand.matchAll(TIERS)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of cand.matchAll(NAME_RE)) {
    const t = bare(m[0]), low = t.toLowerCase();
    if (/\p{N}/u.test(t) || NOT_NAMES.has(low) || /n't$|'(?:ll|d|re|ve|m)$/.test(low)) continue;
    if (tiers.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const caps = (t.match(/\p{Lu}/gu) || []).length;
    const acronym = caps >= 2 || (caps === 1 && !/^\p{Lu}/u.test(t)); // RBI, NBFC, eKYC
    const name = caps === 1 && /^\p{Lu}/u.test(t) && t.length > 1 && !isInitial(cand, m.index);
    if (!acronym && !name) continue;
    const k = keyOf(t);
    if (!known.has(k) && !known.has(low) && !out.has(k)) out.set(k, t);
  }
  return [...out.values()];
}

// ---------- grammar ----------
// Readability, style and enhancement lints are preferences, not errors.
const LINT_SKIP = new Set(['readability', 'style', 'enhancement']);
const norm = (s) => str(s).toLowerCase().replace(/\s+/g, ' ').trim();

function lintsOf(lints, text) {
  return lints.filter((l) => l && typeof l === 'object' && !LINT_SKIP.has(norm(l.kind))).map((l) => {
    const s = Number.isFinite(l.start) ? l.start : -1, e = Number.isFinite(l.end) ? l.end : s;
    const span = typeof l.problem === 'string' ? l.problem : s >= 0 ? text.slice(s, e) : '';
    const near = s >= 0 ? text.slice(Math.max(0, s - 30), e + 30) : span;
    return { kind: str(l.kind), message: str(l.message), k: norm(l.kind), msg: norm(l.message), span: norm(span),
      near: new Set(tokens(near)), text: span.trim() };
  });
}

const overlap = (a, b) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(a.size, b.size, 1);
};
// Lints of the candidate that no lint of the original explains, matched by kind, message and the
// text around them (never by offset), strongest match first, each original lint used once.
const SAME = [
  (a, b) => a.k === b.k && a.msg === b.msg && a.span === b.span,
  (a, b) => a.k === b.k && a.span !== '' && a.span === b.span,
  (a, b) => a.k === b.k && a.msg === b.msg && overlap(a.near, b.near) >= 0.5,
];
function addedLints(before, after) {
  const used = new Set();
  let left = after;
  for (const same of SAME) {
    left = left.filter((a) => {
      const j = before.findIndex((b, k) => !used.has(k) && same(a, b));
      if (j >= 0) used.add(j);
      return j < 0;
    });
  }
  return left;
}

// Harper does not know fiscal codes (FY24, Q1FY25), unit words (cr), possessives (RBI's) or the
// author's names (Nashik). Those are facts: the facts and new-entity checks own them, so a spelling
// lint on them is no grammar regression. Real misspellings ("recieve") and names put in lower case
// ("mumbai" for "Mumbai") are still new lints. Its en-dash lint on number ranges (FY 2023-24,
// 10-12%) is typography, and the numbers are facts too.
function ownedElsewhere(l, known, lowerKnown) {
  if (l.k === 'formatting' && /^[-\u2010-\u2014]$/.test(l.text)) return true;
  if (l.k !== 'spelling' || !l.text) return false;
  if (/\p{N}/u.test(l.text)) return true;
  const ws = nfc(l.text).match(NAME_RE) || [];
  return ws.length > 0 && ws.every((w) => {
    const b = bare(w), low = b.toLowerCase(), set = b === low ? lowerKnown : known;
    return NOT_NAMES.has(low) || set.has(keyOf(w)) || set.has(low);
  });
}

// The original is linted once per grammar function, not once per candidate.
const lintMemo = new WeakMap();
function originalLints(fn, text) {
  let m = lintMemo.get(fn);
  if (!m) lintMemo.set(fn, (m = new Map()));
  if (!m.has(text)) {
    if (m.size >= 32) m.delete(m.keys().next().value);
    const p = Promise.resolve().then(() => fn(text));
    // a failed or malformed result is not kept: the next candidate tries again
    const drop = () => { if (m.get(text) === p) m.delete(text); };
    p.then((r) => { if (!Array.isArray(r)) drop(); }, drop);
    m.set(text, p);
  }
  return m.get(text);
}

// ---------- model checks ----------
function cosine(a, b) {
  if (!a || !b || typeof a.length !== 'number' || !a.length || a.length !== b.length) throw new Error('the embeddings are missing');
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const c = d / Math.sqrt(na * nb);
  if (!Number.isFinite(c)) throw new Error('the embeddings are empty');
  return c;
}

const isProb = (x) => Number.isFinite(x) && x >= -1e-6 && x <= 1 + 1e-6;
// Label names as the model card spells them (entailment or ENTAILMENT).
const label = (r, k) => {
  const hit = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r).find((x) => x.toLowerCase() === k) : undefined;
  return hit === undefined ? NaN : Number(r[hit]);
};
async function nliPair(nli, premise, hypothesis) {
  const r = await nli(premise, hypothesis);
  const out = { entailment: label(r, 'entailment'), contradiction: label(r, 'contradiction'), neutral: label(r, 'neutral') };
  if (!isProb(out.entailment) || !isProb(out.contradiction)) throw new Error('the meaning model gave no probabilities');
  if (!isProb(out.neutral)) out.neutral = Math.max(0, 1 - out.entailment - out.contradiction);
  return out;
}

// In Interview mode the author's answers are part of the source a rewrite may draw on.
const withAllow = (orig, allow) => (allow.length
  ? [orig, ...allow].map((s) => s.trim()).filter(Boolean).map((s) => (/[.!?…]["'”’)]*$/.test(s) ? s : `${s}.`)).join(' ')
  : orig);

// ---------- checks ----------
const CHAR_KIND = { invisible: 'invisible', lookalike: 'lookalike', fullwidth: 'fullwidth', space: 'unusual space' };

function checkChars(g) {
  const hits = auditText(g.cand);
  g.metrics.unsafeChars = hits.length;
  if (!hits.length) return;
  const by = new Map();
  for (const h of hits) by.set(h.kind, (by.get(h.kind) || 0) + 1);
  const codes = [...new Set(hits.map((h) => `U+${h.code.toString(16).toUpperCase().padStart(4, '0')}`))];
  g.fail('unsafe-chars', `Contains hidden or lookalike characters (${[...by].map(([k, n]) => `${n} ${CHAR_KIND[k] || k}`).join(', ')}: ${list(codes, 4)}).`);
}

function checkMeta(g) {
  const found = metaPhrases(g.orig, g.cand);
  g.metrics.meta = found;
  if (found.length) g.fail('meta', `Talks about the rewrite instead of being one: ${list(found.map((f) => `“${f}”`), 3)}.`);
}

function checkFacts(g) {
  const fc = compareFacts(g.orig, g.cand, { allow: g.allow });
  const ents = newEntities(g.orig, g.cand, g.allow);
  g.metrics.facts = fc;
  g.metrics.newEntities = ents;
  const entKeys = new Set(ents.map(keyOf));
  const addedTerms = fc.addedTerms.filter((t) => !entKeys.has(keyOf(t)));
  const parts = [];
  if (fc.missingNums.length) parts.push(`numbers missing: ${list(fc.missingNums)}`);
  if (fc.addedNums.length) parts.push(`numbers added: ${list(fc.addedNums)}`);
  if (fc.missingTerms.length) parts.push(`names or terms missing: ${list(fc.missingTerms)}`);
  if (addedTerms.length) parts.push(`names or terms added: ${list(addedTerms)}`);
  const neg = fc.negations, negOk = neg.ok ?? neg.before === neg.after, modal = fc.modals.changed;
  if (parts.length) g.fail('facts', `Facts changed: ${parts.join('; ')}.`);
  else if (!fc.ok && negOk && !modal.length && !fc.addedTerms.length) g.fail('facts', 'Facts changed.');
  if (!negOk) g.fail('negation', `Changes a negation (not, no, never…): ${neg.before} before, ${neg.after} after.`);
  if (modal.length) g.fail('modal', `Changes may/will/must words: ${modal.map((m) => `“${m.word}” ${m.before} → ${m.after}`).join(', ')}.`);
  if (ents.length) g.fail('new-entity', `Adds names or acronyms that are not in your answer: ${list(ents)}.`);
}

function checkLength(g) {
  const wb = words(g.orig), wa = words(g.cand), extra = g.allow.length ? words(g.allow.join(' ')) : 0;
  Object.assign(g.metrics, { wordsBefore: wb, wordsAfter: wa, lengthRatio: wb ? wa / wb : null });
  if (wa > g.L.maxLengthRatio * wb + extra) g.fail('length', `Too long: ${wa} words for ${wb} (limit ${f2(g.L.maxLengthRatio)}×).`);
  else if (wa < g.L.minLengthRatio * wb) g.fail('length', `Too short: ${wa} words for ${wb} (limit ${f2(g.L.minLengthRatio)}×).`);
}

function checkEdits(g) {
  const r = editRatio(g.orig, g.cand);
  g.metrics.editRatio = r;
  if (r > g.L.maxEditRatio) g.fail('edit-ratio', `Changes too much of the wording (${pct(r)} of words, limit ${pct(g.L.maxEditRatio)}).`);
}

// A grammar checker that fails to load must not block every rewrite: the facts and meaning checks
// still guard the answer, so this one is skipped (and reported) instead.
async function checkGrammar(g) {
  const fn = g.ctx.grammar;
  try {
    const [b, a] = await Promise.all([originalLints(fn, g.orig), fn(g.cand)]);
    if (!Array.isArray(b) || !Array.isArray(a)) throw new Error('the grammar checker returned no list');
    const before = lintsOf(b, g.orig), after = lintsOf(a, g.cand), src = [g.orig, ...g.allow];
    const known = vocab(src), lowerKnown = vocab(src, true);
    const added = addedLints(before, after).filter((l) => !ownedElsewhere(l, known, lowerKnown));
    g.metrics.grammar = { before: before.length, after: after.length,
      added: added.map(({ kind, message, text }) => ({ kind, message, text })) };
    if (added.length) {
      g.fail('grammar', `Adds grammar issues: ${list(added.map((l) => (l.text ? `${l.message} (“${l.text}”)` : l.message)), 3)}.`);
    }
  } catch (err) {
    g.metrics.errors.grammar = errText(err);
    g.skip('grammar', 'error');
  }
}

async function checkSimilarity(g) {
  try {
    const v = await g.ctx.embed([g.ref, g.cand]);
    g.metrics.cosine = cosine(v && v[0], v && v[1]);
  } catch (err) {
    g.metrics.errors.similarity = errText(err);
    g.fail('similarity', `The meaning check could not run (${errText(err)}).`);
    return;
  }
  if (g.metrics.cosine < g.L.cosine) g.fail('similarity', `Meaning drifts from your answer (similarity ${f2(g.metrics.cosine)}, need ${f2(g.L.cosine)}).`);
}

// Both directions: original ⊨ rewrite (nothing added or changed) and rewrite ⊨ original (nothing lost).
async function checkNli(g) {
  const m = g.metrics, L = g.L, nli = { forward: null, backward: null };
  m.nli = nli;
  const judge = (r, dir) => {
    const before = g.reasons.length;
    if (r.entailment < L.entailment) {
      g.fail('entailment', dir === 'forward'
        ? `The rewrite says something your answer does not (meaning match ${f2(r.entailment)}, need ${f2(L.entailment)}).`
        : `The rewrite leaves out part of what your answer says (meaning match ${f2(r.entailment)}, need ${f2(L.entailment)}).`);
    }
    if (r.contradiction >= L.contradiction) g.fail('contradiction', `The rewrite contradicts your answer (contradiction ${f2(r.contradiction)}, limit ${f2(L.contradiction)}).`);
    return g.reasons.length === before;
  };
  try {
    nli.forward = await nliPair(g.ctx.nli, g.ref, g.cand);
    if (judge(nli.forward, 'forward')) {
      nli.backward = await nliPair(g.ctx.nli, g.cand, g.orig);
      judge(nli.backward, 'backward');
    }
  } catch (err) {
    m.errors.nli = errText(err);
    g.fail('entailment', `The meaning check could not run (${errText(err)}).`);
  }
  const done = [nli.forward, nli.backward].filter(Boolean);
  if (done.length) {
    m.entailment = Math.min(...done.map((r) => r.entailment));
    m.contradiction = Math.max(...done.map((r) => r.contradiction));
  }
}

const CHEAP = [['unsafe-chars', checkChars], ['meta', checkMeta], ['facts', checkFacts], ['length', checkLength], ['edit-ratio', checkEdits]];
const MODEL_CHECKS = [['grammar', checkGrammar], ['similarity', checkSimilarity, 'embed'], ['nli', checkNli]];

export async function gateCandidate(original, candidate, ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const orig = str(original), cand = str(candidate);
  const allow = [].concat(c.allow ?? []).map(str).filter((s) => s.trim());
  const reasons = [];
  const metrics = { wordsBefore: words(orig), wordsAfter: words(cand), lengthRatio: null, editRatio: null, unsafeChars: 0,
    meta: [], facts: null, newEntities: [], grammar: null, cosine: null, entailment: null, contradiction: null, nli: null,
    skipped: [], errors: {} };
  const g = { orig, cand, allow, ctx: c, L: limitsOf(c.limits), ref: withAllow(orig, allow), reasons, metrics,
    fail: (code, message) => reasons.push({ code, message }),
    skip: (check, why) => metrics.skipped.push({ check, why }) };

  // cheap checks: all of them run (except on an empty rewrite), so the owner sees every reason at once
  if (!/[\p{L}\p{N}]/u.test(cand)) g.fail('empty', 'The rewrite is empty.');
  else {
    for (const [code, fn] of CHEAP) {
      try { fn(g); } catch (err) { metrics.errors[code] = errText(err); g.fail(code, `This check could not run (${errText(err)}).`); }
    }
  }
  // model checks: cheapest first, none once something has failed
  for (const [check, fn, key = check] of MODEL_CHECKS) {
    if (typeof c[key] !== 'function') g.skip(check, 'unavailable');
    else if (reasons.length) g.skip(check, 'earlier-failure');
    else await fn(g);
  }
  return { ok: reasons.length === 0, reasons, metrics };
}
