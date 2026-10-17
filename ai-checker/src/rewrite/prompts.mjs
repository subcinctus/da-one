// Prompts for the rewriters: chat models (llama-server / LM Studio / WebLLM), a Claude chat via
// copy/paste, the humanizer completion model, and Interview mode ("Ask me"); plus the parsers that
// turn their replies back into plain sentences. Every prompt frames the job as the author editing
// their own draft for clarity and voice. None mentions checkers or evasion: that framing draws
// refusals and stiffer writing. The humanizer wrapper is copied verbatim from
// sgaofen/humanizer-local-model (Apache-2.0); see that section. No DOM access.
import { words, splitSentences } from '../text.mjs';
import { extractFacts } from '../facts.mjs';
import { BAN_LIST } from '../tells.mjs';

export const VARIANTS = ['plainer', 'more personal', 'restructured', 'your voice'];
const MAX_SAMPLES = 3, SAMPLE_CHARS = 700, CONTEXT_CHARS = 600, MAX_BANS = 40;

// ---------- shared pieces ----------
const str = (v) => (v == null ? '' : String(v));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clip(s, max) {
  const t = str(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')} …`;
}
// The "before" context keeps its end, the part next to the sentence.
function clipTail(s, max) {
  const t = str(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const m = /[.?!] (?=\S)/.exec(cut);
  return m && m.index < max / 2 ? cut.slice(m.index + 2) : `… ${cut.replace(/^\S*\s+/, '')}`;
}

const sampleTexts = (samples) => [].concat(samples ?? [])
  .map((s) => str(typeof s === 'string' ? s : s?.text).trim()).filter(Boolean)
  .slice(0, MAX_SAMPLES).map((s) => clip(s, SAMPLE_CHARS));

function samplesBlock(samples) {
  const list = sampleTexts(samples);
  if (!list.length) return '';
  return `Samples of my own writing, for voice only (match the tone and rhythm; never reuse their content or facts):\n${
    list.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join('\n')}\n--- End of samples ---`;
}

// Ban-list entries like "not just … but" or "leverage (as a verb)" match on their plain parts.
const banParts = (p) => str(p).toLowerCase().replace(/\([^)]*\)/g, ' ').split('…')
  .map((x) => x.replace(/[\s,]+$/, '').trim()).filter(Boolean);
function hasBan(text, p) {
  const parts = banParts(p);
  return parts.length > 0 && parts.every((x) => new RegExp(`(?:^|[^\\p{L}])${escRe(x)}(?![\\p{L}])`, 'u').test(text));
}
// Phrases the text already uses come first, so a short list still covers what matters here.
export function pickBans(text, list = BAN_LIST, max = MAX_BANS) {
  const t = str(text).toLowerCase().replace(/[’‘]/g, "'");
  const uniq = [...new Set([].concat(list ?? []).map((p) => str(p).trim()).filter(Boolean))];
  const hits = uniq.filter((p) => hasBan(t, p));
  return [...hits, ...uniq.filter((p) => !hits.includes(p))].slice(0, max);
}
const banLine = (bans) => (bans.length ? `Avoid these words and phrases: ${bans.map((b) => b.replace(/,$/, '')).join('; ')}.` : null);

// The facts in a passage, written as the author wrote them, so small models see what to keep.
export function keepList(text) {
  const t = str(text);
  try {
    const f = extractFacts(t);
    const out = [];
    for (const v of f.nums.values()) out.push(...v.raw);
    for (const term of f.terms.keys()) {
      const m = t.match(new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escRe(term)}(?:e?s)?)(?![\\p{L}\\p{N}])`, 'u'));
      out.push(m ? m[1] : term);
    }
    // "won't" counts as n't + will and "cannot" as cannot + can: list the words actually written
    const written = (w) => (w === "n't" ? (t.match(/\p{L}+n['’]t(?!\p{L})/giu) || []).map((x) => x.toLowerCase())
      : new RegExp(`(?:^|[^\\p{L}'’])${escRe(w)}(?![\\p{L}'’])`, 'iu').test(t) ? [w] : []);
    for (const w of [...f.negations.keys(), ...f.modals.keys()]) out.push(...written(w));
    return [...new Set(out.map((x) => str(x).trim()).filter(Boolean))];
  } catch { return []; }
}
const keepLine = (text) => { const k = keepList(text); return k.length ? `Keep exactly as written: ${k.join(', ')}.` : null; };

const isQwen3 = (model) => /qwen[-_ ]?3/i.test(str(model));
// Qwen3 thinks by default; the soft switch at the end of the user turn turns it off.
export function forModel(req, model) {
  if (!isQwen3(model) || /\/no_think\s*$/.test(req.user)) return req;
  return { ...req, user: `${req.user}\n\n/no_think` };
}

const aboutLine = (voice) => { const v = str(voice).trim(); return v ? `About the author: ${v}` : null; };
// Lines joined with \n; null drops a line, '' keeps a blank one.
const join = (...parts) => parts.filter((x) => x != null).join('\n');
const rule = (r) => (r == null ? null : `- ${r}`);

const KEEP_RULES = [
  'Keep every number, amount, percentage, date and period exactly as written, in the same form (₹, Rs or INR amounts, lakh and crore, Indian digit grouping, %, bps, FY and quarter labels).',
  'Keep every name, acronym and technical term.',
  'Keep the meaning and the level of certainty: keep every negation (not, no, never, without, cannot) and every may, might, will, would, must, should, could, can and shall.',
];
const STYLE_RULE = 'Write the way an experienced practitioner talks to a peer: plain, concrete words and a natural rhythm, with sentence lengths that vary. Keep the spelling style of the draft (Indian/British English).';

// ---------- one sentence, chat models ----------
const VARIANT_ASK = [
  () => 'Make it plainer and more direct: everyday words, active voice, no filler or stock phrases.',
  () => 'Make it more personal: say it the way the author would from experience, with "we" or "I" where it fits. If a real example would make the point, write a bracketed placeholder such as [your example] instead of inventing one.',
  () => 'Restructure it: change the order of the ideas or the way it opens, or split it into two sentences. Do not just swap words.',
  (hasSamples) => (hasSamples
    ? "Write it in the author's own voice, following the samples: their sentence length, word choice and rhythm. Borrow only the style, never the content."
    : "Write it in the author's own voice as described: plain, direct and specific."),
];

function variantIndex(v) {
  if (typeof v === 'string') { const i = VARIANTS.indexOf(v.toLowerCase()); return i < 0 ? 0 : i; }
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? ((n % 4) + 4) % 4 : 0;
}

// A concrete length cue from the neighbours, so the rewrite varies the rhythm of the paragraph.
export function lengthHint(before, sentence, after) {
  const sw = words(str(sentence));
  const nbs = [before, after].map((x) => words(str(x))).filter((n) => n > 0);
  const nb = nbs.length ? Math.round(nbs.reduce((a, b) => a + b, 0) / nbs.length) : 0;
  if (sw >= 30) return 'It is long: two shorter sentences may read better.';
  if (nb >= 20) return `The sentences around it run about ${nb} words, so a noticeably shorter sentence will vary the rhythm.`;
  if (nb > 0 && nb <= 10 && sw <= 12) return 'The sentences around it are short, so a fuller sentence is fine here, as long as it adds nothing new.';
  return 'Let its length differ from the sentences around it.';
}

export function sentencePrompt({ before = '', sentence = '', after = '', voice = '', samples = [], variant = 0, banList = BAN_LIST, model } = {}) {
  const v = variantIndex(variant);
  const hasSamples = sampleTexts(samples).length > 0;
  const b = clipTail(before, CONTEXT_CHARS), a = clip(after, CONTEXT_CHARS), s = str(sentence).trim();
  const addNothing = 'Add nothing that is not in the sentence: no new facts, figures, names, examples or anecdotes. Leave nothing out.'
    + (v === 1 ? ' The one exception: a bracketed placeholder such as [your example] for the author to fill in.' : '');
  const system = join(
    "You are helping an executive edit their own draft answer so that it reads clearly and in the author's natural voice.",
    aboutLine(voice),
    '',
    'Rules:',
    '- Rewrite only the sentence between ⟦ and ⟧. The sentences before and after are context: do not repeat, merge or change them.',
    ...KEEP_RULES.map(rule),
    rule(addNothing),
    rule(STYLE_RULE),
    rule(banLine(pickBans(`${b} ${s} ${a}`, banList))),
    '- Reply with the rewritten sentence only, with no quotation marks, labels, options or explanation.',
  );
  const context = b || a
    ? join('Context (do not rewrite):', b ? `Before: ${b}` : 'Before: (this is the first sentence)', a ? `After: ${a}` : 'After: (this is the last sentence)')
    : 'Context: the sentence stands alone.';
  const user = [
    samplesBlock(samples),
    context,
    `Sentence to rewrite:\n⟦${s}⟧`,
    join(keepLine(s), `${VARIANT_ASK[v](hasSamples)} ${lengthHint(b, s, a)}`, 'Reply with the rewritten sentence only.'),
  ].filter(Boolean).join('\n\n');
  return forModel({ system, user }, model);
}

// ---------- many sentences in one request, for a Claude chat (copy/paste) ----------
const BATCH_ASK = [
  'plainer and more direct',
  'more personal, the way I would say it from experience (a bracketed placeholder such as [your example] is allowed where a real example would help; never make one up)',
  'restructured: a different order or opening, or split into two sentences',
];
const voiceAsk = (hasSamples) => (hasSamples ? 'in my own voice, following my writing samples (style only, never their content)'
  : 'in my own voice: plain, direct and specific');
const itemId = (it) => str(it?.id ?? it?.index);

export function batchVariantsPrompt({ items = [], voice = '', samples = [], n = 4, banList = BAN_LIST } = {}) {
  const list = [].concat(items ?? []).filter(Boolean);
  const count = Math.max(1, Math.min(8, Math.trunc(Number(n)) || 4));
  const ids = list.map(itemId);
  const all = list.map((it) => `${str(it.before)} ${str(it.sentence)} ${str(it.after)}`).join(' ');
  const bans = pickBans(all, banList, Infinity);
  const shape = `{${ids.map((id) => `${JSON.stringify(id)}: [${Array.from({ length: Math.min(count, 2) }, (_, k) => `"version ${k + 1}"`).join(', ')}${count > 2 ? ', …' : ''}]`).join(', ')}}`;
  const asks = [...BATCH_ASK, voiceAsk(sampleTexts(samples).length > 0)];
  const versions = Array.from({ length: Math.min(count, 4) }, (_, k) => `- Version ${k + 1}: ${asks[k]}.`);
  if (count > 4) versions.push('- Further versions: repeat this cycle with different wording.');
  const sentences = list.map((it) => {
    const ctx = [it.before && `Before: ${clipTail(it.before, CONTEXT_CHARS)}`, it.after && `After: ${clip(it.after, CONTEXT_CHARS)}`].filter(Boolean);
    return join(`[id ${JSON.stringify(itemId(it))}]`, `Sentence: ${str(it.sentence).trim()}`, ...ctx, keepLine(it.sentence));
  });
  return [
    'I am revising a draft answer that I wrote, and I would like help rewording some of its sentences so that they read clearly and in my own natural voice.',
    str(voice).trim() && `About me: ${str(voice).trim()}`,
    samplesBlock(samples),
    `For each sentence below, write ${count} different version${count > 1 ? 's' : ''}:\n${versions.join('\n')}`,
    join('Rules for every version:',
      '- Rewrite only the sentence itself; the sentences before and after are context.',
      ...KEEP_RULES.map(rule),
      '- Add no new facts, figures, names, examples or anecdotes, and leave nothing out.',
      `- ${STYLE_RULE.replace('the draft', 'my draft')}`,
      rule(banLine(bans))),
    `Reply with one JSON object and nothing else. Use exactly these keys: ${ids.map((id) => JSON.stringify(id)).join(', ') || '(none)'}. Each value is a list of ${count} strings, one per version, in the order above:\n${shape}`,
    `Sentences:\n\n${sentences.join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
}

// ---------- parsing a chat reply into variants ----------
const OPENERS = { '"': '"', '“': '”"“', '”': '”"', '„': '“”"', "'": "'’", '‘': '’\'' };
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
const BARE_KEY = /[^:：,{}[\]\n]*/y, BARE_VALUE = /[^,\]}\n]*/y;  // sticky: no slicing on long replies
const sticky = (re, s, i) => { re.lastIndex = i; return re.exec(s)[0]; };
const ws = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
const skipSep = (s, i) => { while (i < s.length && /[\s,]/.test(s[i])) i++; return i; };
// A quote closes a string only where JSON could go on: before , : ] } another quote, or the end.
const closesAt = (s, k) => { k = ws(s, k); return k >= s.length || ',:：]}"“”'.includes(s[k]); };

// Before ] } or the end a quote always closes; inside a “curly” string, an inner “…” pair may sit before a comma.
const hardEnd = (s, k) => { k = ws(s, k); return k >= s.length || s[k] === ']' || s[k] === '}'; };

function readString(s, i) {
  const open = s[i], close = OPENERS[open];
  let out = '', depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) {
      const e = s[j + 1];
      if (e === 'u' && /^[0-9a-f]{4}$/i.test(s.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 5; } else { out += ESCAPES[e] ?? e; j++; }
    } else if (close.includes(c) && closesAt(s, j + 1) && (depth === 0 || hardEnd(s, j + 1))) return { value: out, end: j + 1 };
    else {
      if (open === '“' && c === '“') depth++;
      else if (open === '“' && c === '”' && depth > 0) depth--;
      out += c;
    }
  }
  return { value: out, end: s.length, partial: true };
}

// Lenient JSON: smart or single quotes, bare keys, missing or trailing commas, a cut-off end.
// Unquoted values are never text: "[your example]" or "// note" in a reply is not a version.
function readValue(s, i, depth = 0) {
  if (depth > 24) throw new Error('too deep');
  i = ws(s, i);
  const c = s[i];
  if (c === '{' || c === '[') {
    const obj = c === '{', out = obj ? Object.create(null) : [];
    let j = i + 1;
    for (;;) {
      j = skipSep(s, j);
      if (j >= s.length) return { value: out, end: j, partial: true };
      if (s[j] === '}' || s[j] === ']') return { value: out, end: j + 1 };
      let key = null;
      if (obj) {
        let k;
        if (s[j] in OPENERS) ({ value: key, end: k } = readString(s, j));
        else { const m = sticky(BARE_KEY, s, j); key = m.trim(); k = j + m.length; }
        k = ws(s, k);
        if (s[k] !== ':' && s[k] !== '：') {
          if (k > j) { j = k; continue; }
          const skip = readValue(s, j, depth + 1); j = Math.max(skip.end, j + 1); continue;
        }
        j = k + 1;
      }
      const v = readValue(s, j, depth + 1);
      const cut = v.partial && typeof v.value === 'string';
      if (!cut) { if (obj) out[key] = key in out && Array.isArray(out[key]) && Array.isArray(v.value) ? out[key].concat(v.value) : v.value; else out.push(v.value); }
      j = Math.max(v.end, j + 1);
      if (v.partial) return { value: out, end: j, partial: true };
    }
  }
  if (c in OPENERS) return readString(s, i);
  const m = sticky(BARE_VALUE, s, i);
  const raw = m.trim();
  const value = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
  return { value, end: i + Math.max(1, m.length) };
}

// End of a strict-JSON value starting at i (straight quotes only), or -1.
function balancedEnd(s, i) {
  const stack = [];
  let inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) return -1;
      if (!stack.length) return j + 1;
    }
  }
  return -1;
}

function parseStrict(s, i) {
  const end = balancedEnd(s, i);
  if (end < 0) return null;
  try { return { value: JSON.parse(s.slice(i, end)), end }; } catch { return null; }
}
const parseAt = (s, i) => { try { return readValue(s, i); } catch { return null; } };

const ID_FIELDS = ['id', 'key', 'index', 'idx', 'sentence_id', 'sentenceId', 'item'];
const VARIANT_FIELDS = ['variants', 'versions', 'rewrites', 'rewrite', 'rewritten', 'options', 'candidates', 'alternatives', 'suggestions', 'outputs', 'output', 'text', 'version'];
const ECHO_FIELDS = ['sentence', 'original_sentence', 'original sentence'];
const NOT_VARIANTS = new Set([...ID_FIELDS.map((f) => f.toLowerCase()), ...ECHO_FIELDS, 'original', 'before', 'after', 'context', 'source',
  'input', 'note', 'notes', 'explanation', 'comment', 'label', 'style', 'emphasis', 'type', 'reason']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idField = (o) => ID_FIELDS.find((f) => typeof o[f] === 'string' || typeof o[f] === 'number');

function textsOf(v, depth = 0) {
  if (depth > 6 || v == null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap((x) => textsOf(x, depth + 1));
  if (isObj(v)) {
    const f = VARIANT_FIELDS.find((k) => k in v);
    if (f) return textsOf(v[f], depth + 1);
    const got = Object.entries(v).filter(([k]) => !NOT_VARIANTS.has(k.toLowerCase())).flatMap(([, x]) => textsOf(x, depth + 1));
    // {"id": 3, "sentence": "…"} with nothing else: "sentence" is the version, not an echo of the original
    const echo = ECHO_FIELDS.find((k) => typeof v[k] === 'string');
    return got.length || !echo ? got : [v[echo]];
  }
  return [];
}

function matchId(key, want) {
  if (key == null) return undefined;
  const raw = str(key).trim();
  // "Sentence 3", "id_7", "s7", "#3" name an id; "note" or "summary" do not
  const bare = raw.replace(/^["'“”‘’[(#\s]+|["'“”‘’\])\s:.]+$/g, '').replace(/^(?:id|sentence|item|no\.?|number|s)\s*[#:._ -]?\s*(?=\d)/i, '').trim();
  if (!want.length) return bare || undefined;
  return want.find((id) => str(id) === raw) ?? (bare ? want.find((id) => str(id).toLowerCase() === bare.toLowerCase()) : undefined);
}

function collect(v, want, out, depth = 0) {
  if (depth > 5 || v == null || typeof v !== 'object') return;
  const add = (id, x) => { if (id !== undefined) out.set(id, (out.get(id) || []).concat(textsOf(x))); };
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => isObj(x) && idField(x))) { for (const x of v) add(matchId(x[idField(x)], want), x); return; }
    if (v.length && want.length && v.every(Array.isArray)) { v.slice(0, want.length).forEach((x, k) => add(want[k], x)); return; }
    if (v.length && v.every((x) => typeof x === 'string')) { if (want.length === 1) add(want[0], v); return; }
    for (const x of v) collect(x, want, out, depth + 1);
    return;
  }
  const entries = Object.entries(v);
  // without ids, any key holding text counts as one (a wrapper like {"results": {…}} does not)
  const hits = entries.map(([k, x]) => [matchId(k, want), x])
    .filter(([id, x]) => id !== undefined && (want.length || Array.isArray(x) || typeof x === 'string'));
  if (hits.length) { for (const [id, x] of hits) add(id, x); return; }
  const f = idField(v);
  if (f && matchId(v[f], want) !== undefined) { add(matchId(v[f], want), v); return; }
  const size = out.size;
  for (const [, x] of entries) collect(x, want, out, depth + 1);
  if (out.size > size || !want.length) return;
  // keys that match no id (say "1", "2" for ids 4 and 9): take them in order when the counts agree
  if (want.length === 1 && entries.every(([, x]) => typeof x === 'string')) { add(want[0], entries.map(([, x]) => x)); return; }
  const lists = entries.filter(([, x]) => Array.isArray(x) || typeof x === 'string');
  if (lists.length === want.length && lists.length === entries.length) lists.forEach(([, x], k) => add(want[k], x));
}

// Fallback for prose replies: an id on its own line, then bulleted, numbered or quoted versions.
function collectLines(text, want, out) {
  let cur = want.length === 1 ? want[0] : undefined;  // one sentence needs no heading
  for (const line of text.split('\n')) {
    const plain = line.replace(/\*\*|__/g, '').replace(/^#{1,6}\s*/, '').trim();
    if (!plain || plain.startsWith('```')) continue;
    const head = plain.match(/^\[?(?:id|sentence|item)?\s*#?\s*["“]?([\w-]+)["”]?\s*\]?\s*[:.)\-–—]?$/i);
    const id = head ? matchId(head[1], want) : undefined;
    if (id !== undefined) { cur = id; continue; }
    const item = plain.match(/^(?:[-*•]|\d+[.)]|\(?[a-d]\)|v(?:ersion)?\s*\d+\s*[:.)\-–—])\s*(.+)$/i) || plain.match(/^(["“].+["”]),?$/);
    if (cur !== undefined && item) out.set(cur, (out.get(cur) || []).concat(item[1]));
  }
}

const TEMPLATE_ECHO = /^(?:v(?:ersion)?\s*\d+|\.{3}|…|<[^>]*>|version \d+ text)$/i;

// Every JSON value in the text that yields variants. Strict JSON first, so "[your example]" in the
// prose around it is never read as a list; the lenient reader only fills ids still missing.
function scan(text, want, strict) {
  const found = new Map();
  for (let i = 0, tries = 0; i < text.length && tries < 400; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    tries++;
    const r = strict ? parseStrict(text, i) : parseAt(text, i);
    if (!r) continue;
    const got = new Map();
    collect(r.value, want, got);
    if (![...got.values()].some((l) => l.length)) continue;
    for (const [id, l] of got) found.set(id, (found.get(id) || []).concat(l));
    i = Math.max(i, r.end - 1);
  }
  return found;
}

export function parseVariantsReply(reply, ids = []) {
  const text = str(reply).replace(/\r\n?/g, '\n');
  const want = ids == null ? [] : typeof ids === 'object' && typeof ids[Symbol.iterator] === 'function' ? [...ids] : [ids];
  const found = scan(text, want, true);
  const missing = (id) => !(found.get(id) || []).length;
  if (!found.size || want.some(missing)) {
    for (const [id, l] of scan(text, want, false)) if (want.length ? missing(id) : !found.has(id)) found.set(id, l);
  }
  if (!found.size && want.length) collectLines(text, want, found);
  const out = new Map(want.map((id) => [id, []]));
  for (const [id, list] of found) {
    const seen = new Set(out.get(id) || []);
    for (const t of list.map(cleanOutput)) if (t && /\p{L}/u.test(t) && !TEMPLATE_ECHO.test(t) && !seen.has(t)) seen.add(t);
    out.set(id, [...seen]);
  }
  return out;
}

// ---------- humanizer (sgaofen/humanizer-local-model, Apache-2.0) ----------
// A completion model fine-tuned from google/gemma-4-12B; it was trained on this exact wrapper, byte
// for byte. Source: humanizer/promptfmt.py build_prompt() (INSTR, SEP) and the README "Prompt
// format" section, github.com/sgaofen/humanizer-local-model. Check: the first 16 hex characters of
// sha256(humanizerPrompt('X')) must be cc51d66b4c593fbe. Use /completion, stop on EOS only.
export const HUMANIZER_INSTR = 'Rewrite the text below so it reads like a person wrote it, not a language model.\n\n'
  + 'Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\n'
  + 'throat-clearing, and any sentence that only announces what comes next.\n'
  + 'Prefer the concrete word over the abstract one. It is fine to sound uneven.\n\n'
  + 'Every fact, number, unit, date, name and quotation must survive unchanged.';
export const HUMANIZER_SEP = '\n\n### Rewritten:\n\n';
// The README's sampling (llama-server turns on top-k 40 and min-p 0.05 unless told not to).
export const HUMANIZER_SAMPLING = Object.freeze({ temperature: 1.0, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1.0 });
// Python's str.strip() whitespace, which differs from String.prototype.trim (U+001C–U+001F, U+0085; not U+FEFF).
// Index scans, not /\s+$/: a regex anchored at the end is quadratic on long inner runs of spaces.
const PY_WS = /[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
function pyStrip(s) {
  let a = 0, b = s.length;
  while (a < b && PY_WS.test(s[a])) a++;
  while (b > a && PY_WS.test(s[b - 1])) b--;
  return s.slice(a, b);
}

export const humanizerPrompt = (text) => `${HUMANIZER_INSTR}\n\n${pyStrip(str(text))}${HUMANIZER_SEP}`;

// ---------- Interview mode ("Ask me") ----------
const VAGUE_QTY = /\b(?:significant(?:ly)?|substantial(?:ly)?|considerabl[ey]|sizeable|sizable|huge|massive|sharp(?:ly)?|steep(?:ly)?|rapid(?:ly)?|manifold|multi-?fold|several|numerous|many|a (?:large|growing|significant|substantial|good|fair) (?:number|share|portion|proportion|part|chunk)|the majority of|a majority of|most of (?:our|the)|a lot of|lots of|multiple|various|(?:strong|healthy|robust|steady|solid|good) (?:growth|demand|traction|performance|returns|uptake)|(?:high|higher|low|lower|better|improved) (?:volumes?|growth|demand|yields?|margins?|costs?|delinquenc(?:y|ies)|collections?|efficiency|productivity))\b(?:\s+[\p{L}\p{N}-]+){0,2}/iu;
// bare "lower" only as a verb ("lower our costs"), not "lower income groups"
const CHANGE = /\b(?:reduc(?:e|es|ed|ing)|cut(?:s|ting)?|lower(?:s|ed|ing|(?=\s+(?:the|our|its|their)\s))|improv(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|boost(?:s|ed|ing)?|grow(?:s|n)?|grew|rais(?:e|es|ed|ing)|r[io]se|fell|declin(?:e|es|ed|ing)|drop(?:s|ped|ping)?|shorten(?:s|ed|ing)?|speed(?:s|ing)? up)\b(?:\s+(?:the |our |its |their )?[\p{L}-]+){1,2}/iu;
const GENERIC = /\b(?:in today['’]s|landscape|holistic|seamless(?:ly)?|data-driven|best practices?|end-to-end|customer-centric|world-class|best-in-class|cutting-edge|plays? (?:a|an) (?:[\w-]+ )?(?:pivotal|crucial|key|vital|critical|central|important) role|key to|is (?:crucial|vital|essential|critical|paramount)|at scale|drive (?:growth|value|efficiency)|enhanc(?:e|es|ing) (?:the )?(?:overall )?(?:customer )?experience|foster(?:s|ing)?|unlock(?:s|ing)?|empower(?:s|ing)?|(?:to|can|will|we|and) leverage(?! ratio))\b/i;
const OPINION = /\b(?:ultimately|in conclusion|at the end of the day|going forward|the way forward|not (?:just|only|merely) (?:about )?[^.;]{1,60}?[;,]?\s+(?:but|it is|it['’]s)|it is (?:important|crucial|essential|vital|imperative)|long-term value|all (?:our |its |their )?stakeholders|the need of the hour|the future (?:looks|is)|success (?:depends|lies|hinges)|the key is)\b/i;
const CONCRETE = /\d|\b(?:for example|for instance|e\.g\.|last (?:year|quarter|month)|in (?:FY|Q)\s?\d)\b/i;
const TOPICS = ['collections', 'collection', 'underwriting', 'DSAs', 'builders', 'branches', 'affordable housing', 'Tier 2', 'Tier 3',
  'MSME', 'LAP', 'home loans', 'mortgages', 'GNPA', 'NPA', 'early-warning systems', 'early warning', 'sourcing', 'disbursement',
  'turnaround time', 'customer experience', 'pricing', 'LTV', 'co-lending', 'credit', 'technology'];

// Acronyms match only in capitals ("the final lap" is not LAP); the topic is named as listed.
function topicOf(text) {
  let best = null;
  for (const t of TOPICS) {
    const m = new RegExp(`(?:^|[^\\p{L}])${escRe(t)}(?![\\p{L}])`, /^[A-Z]{2,}s?$/.test(t) ? 'u' : 'iu').exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, word: t };
  }
  return best && best.word;
}

// "will not lower our standards" or "never cut rates" is no figure to ask for
const negatedAt = (t, i) => /(?:\b(?:not|never|no|cannot)|n['’]t)\s+(?:[\p{L}-]+\s+)?$/iu.test(t.slice(Math.max(0, i - 40), i));

const TAIL_STOP = /\s+(?:in|of|the|a|an|and|or|to|for|with|at|on|by|from|that|which|while|as|is|are|was|were)$/i;
function shortQuote(s) {
  let w = s.trim().split(/\s+/).slice(0, 6).join(' ').replace(/[\s,;:.]+$/, '');
  while (TAIL_STOP.test(w)) w = w.replace(TAIL_STOP, '');
  return `“${w}”`;
}

// Which kind of detail the paragraph lacks: a real example, an actual figure, or the author's own view.
function needs(paragraph, tells) {
  const score = { number: 0, example: 0, opinion: 0 };
  for (const t of [].concat(tells ?? []).filter(Boolean)) {
    const w = Number(t.weight) > 0 ? Number(t.weight) : 1;
    const desc = `${str(t.rule)} ${str(t.message)}`.toLowerCase();
    // opinion first: the stakeholders tell says "Vague send-off", which is no missing figure
    if (t.category === 'closer' || t.category === 'formula' || /opinion|sendoff|send-off|sum-up|stakeholder|important-to|urgency|emphasis/.test(desc)) score.opinion += w;
    else if (/number|figure|give the fact|how (?:much|many)|quantif/.test(desc)) score.number += w;
    else if (t.category && t.category !== 'punctuation') score.example += w;  // dashes and colons lack no detail
  }
  // a vague amount or an unquantified change, in a sentence that gives no figure
  const plain = splitSentences(paragraph).map((s) => s.text).filter((t) => !/\d/.test(t));
  let phrase = null, change = false;
  for (const re of [VAGUE_QTY, CHANGE]) {
    const m = plain.map((t) => { const x = t.match(re); return x && !(re === CHANGE && negatedAt(t, x.index)) ? x : null; }).find(Boolean);
    if (m) { phrase = m[0]; change = re === CHANGE; score.number += 2; break; }
  }
  if (GENERIC.test(paragraph)) score.example += 1;
  if (!CONCRETE.test(paragraph)) score.example += 1;
  if (OPINION.test(paragraph)) score.opinion += 2;
  return { score, phrase, change };
}

export function interviewQuestions(paragraph, tells = []) {
  const p = str(paragraph).trim();
  const { score, phrase, change } = needs(p, tells);
  const topic = topicOf(p);
  const ask = {
    number: phrase
      ? (change ? `You wrote ${shortQuote(phrase)}. By how much, from what to what, and over what period?`
        : `You wrote ${shortQuote(phrase)}. What is the actual figure (amount, % or count, and the period)?`)
      : 'What is the actual figure behind this point (amount, % or count, and the period)?',
    example: `What is one real example from your own ${topic ? `work on ${topic}` : 'lending work'} that shows this? A case, a branch or a decision is enough.`,
    opinion: `What is your own view on ${topic || 'this'}, in a sentence: what have you seen work, or not work, in practice?`,
  };
  // a missing figure is the most useful thing to ask for; then whichever of the other two weighs more
  const picked = phrase || score.number >= 2 ? ['number'] : [];
  for (const k of ['example', 'opinion'].sort((a, b) => score[b] - score[a])) if (score[k] > 0) picked.push(k);
  return (picked.length ? picked : ['example']).slice(0, 2).map((k) => ask[k]);
}

export function interviewPrompt({ paragraph = '', answers = [], voice = '', banList = BAN_LIST, model } = {}) {
  const p = str(paragraph).trim();
  const list = [].concat(answers ?? []).map((a) => (isObj(a) ? [str(a.q ?? a.question).trim(), str(a.a ?? a.answer).trim()] : ['', str(a).trim()]))
    .filter(([, a]) => a);
  const system = join(
    "You are helping an executive revise one paragraph of their own draft answer, using details they have just supplied, so that it reads clearly and in the author's natural voice.",
    aboutLine(voice),
    '',
    'Rules:',
    "- The author's answers are the only new facts you may add. Use their numbers, names and units exactly as given.",
    ...KEEP_RULES.map((r) => rule(r.replace('Keep every', 'Keep every existing'))),
    '- Invent nothing else: no other examples, figures, names, results or anecdotes, and no placeholders.',
    '- Put the specifics in place of generic or stock wording rather than adding them on top, so the paragraph stays about the same length.',
    `- ${STYLE_RULE} Use "we" or "I" where it fits.`,
    rule(banLine(pickBans(p, banList))),
    '- Reply with the rewritten paragraph only: one paragraph, with no title, quotation marks or explanation.',
  );
  const user = [
    `My paragraph:\n${p}`,
    keepLine(p),
    `My answers (the only new facts you may use):\n${list.length ? list.map(([q, a]) => (q ? `- ${q} ${a}` : `- ${a}`)).join('\n') : '- (none)'}`,
    'Rewrite the paragraph with these details. Reply with the paragraph only.',
  ].filter(Boolean).join('\n\n');
  return forModel({ system, user }, model);
}

// ---------- cleaning a model's reply down to the rewrite itself ----------
const PLEASANTRY = /^(?:(?:sure|certainly|of course|okay|ok|absolutely|great|got it|no problem|alright)\b[!.,:]?\s*)?(?:(?:here you go|here it is|happy to help|glad to help)[!.:]?)?\s*$/i;
const LEAD = '(?:(?:sure|certainly|of course|okay|ok|absolutely|great|got it|no problem|alright)\\b[!,.]*\\s*)?';
// Nouns that only ever mean the rewrite, and ones that need an adjective or a line of their own,
// so "Here are the options: raise the cap" or "Here is the text of our policy: …" survive.
const NOUN = '(?:rewrit\\w*|revis\\w*|version\\w*|edit(?:s|ed)?|variant\\w*|alternative\\w*|rephras\\w*|reword\\w*|way to (?:put|say|phrase|write) (?:it|this))';
const GEN_NOUN = '(?:sentences?|text|paragraphs?|drafts?|attempt)';
// Words that are labels on their own ("Revised: …"); others only with a noun ("New version: …"),
// so a real sentence such as "New: the bank opened 12 branches" or "Option 2: …" survives.
const LABEL_ADJ = '(?:rewritten|revised|rephrased|reworded|restructured|plainer|more personal|edited|polished)';
const ADJ = '(?:rewritten|revised|edited|improved|updated|new|final|plainer|clearer|simpler|shorter|restructured|reworded|rephrased|more personal|personal|polished|natural)';
const HERE = `here(?:'s|’s| is| are)\\b(?:[^:：\\n]{0,80}?\\b(?:${NOUN}|${ADJ} ${GEN_NOUN})\\b[^:：\\n]{0,60}?\\s*[:：]\\s*`
  + `|(?=[^:：\\n]{0,80}?\\b${GEN_NOUN}\\b)[^:：\\n]{0,120}[:：]\\s*$)`;
const PREAMBLE = new RegExp(`^${LEAD}(?:${HERE}|(?:(?:the |my |a |an )?(?:${ADJ} (?:sentence|version|text|paragraph|draft|answer|rewrite)|${LABEL_ADJ})(?: ?#?\\d+)?(?: \\([^)\\n]{0,40}\\))?`
  + '|(?:rewrite|revision|version|variant)(?: ?#?\\d+| [a-d])?(?: \\([^)\\n]{0,40}\\))?'
  + '|(?:in )?your voice)\\s*[:：]\\s*)', 'i');
const LABEL_LINE = /^(?:output|answer|result|response|sentence|paragraph|option|rewrite|version|variant)(?: ?#?\d+| [a-d])?\s*[:：]\s*$/i;
// A leading block that talks about the rewrite. It must name the rewrite (or end in a colon), so
// a real opening such as "I made collections our first priority." or "The following year, …" stays.
const META_START = /^(?:i(?:'ve|’ve| have)? (?:rewritten|revised|reworded|rephrased|edited|made|kept|changed|tried|tightened|simplified)|this (?:version|rewrite) (?:keeps|is|reads|uses|removes|cuts|drops|sounds|avoids|stays|makes|replaces|changes|splits)|below is|the following)\b/i;
const META_REF = /\b(?:sentences?|versions?|rewrites?|rewritten|rephras\w*|reword\w*|wording|phrasing|paragraphs?|tone|draft|edits?|your|plainer|clearer|more (?:natural|personal|direct|concise))\b|[:：]\s*$/i;
const isMeta = (b) => { const m = b.match(META_START); return !!m && (/^this/i.test(m[0]) || META_REF.test(b.slice(m[0].length))); };
// A trailing line that explains the edit; "Note that RBI …" or "I used to approve …" stay.
const NOTE_LINE = /^\(?\s*(?:(?:notes?|explanation|changes?(?: made)?|why|rationale|reasons?|word count)\s*[:：]|i (?:changed|kept|removed|replaced|made|used|split|added|cut|dropped|swapped)\b.*\b(?:sentences?|versions?|wording|phrasing|draft|tone|rewrite)\b)/i;
const WRAPS = [['"', '"', /"/], ['“', '”', /[“”]/], ['”', '”', /[“”]/], ['„', '“', /[„“”]/], ["'", "'", /'/], ['‘', '’', /[‘’']/],
  ['`', '`', /`/], ['«', '»', /[«»]/], ['⟦', '⟧', /[⟦⟧]/]];
const PAIRED = { '“': '”', '«': '»' };
// True when every opening quote in s is closed in order ("“Nagpur rule”" yes, "Growth” … “volume" no).
function paired(s, o, c) {
  let d = 0;
  for (const ch of s) if (ch === o) d++; else if (ch === c && --d < 0) return false;
  return d === 0;
}

function stripThink(t) {
  t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const close = /<\/think(?:ing)?>/gi;
  let m, last = -1;
  while ((m = close.exec(t))) last = m.index + m[0].length;
  if (last >= 0) t = t.slice(last);  // the opening tag was in the prompt template
  const open = t.search(/<think(?:ing)?>/i);
  return open >= 0 ? t.slice(0, open) : t;  // thinking ran out of tokens: nothing usable after it
}

function unfence(t) {
  const m = t.match(/```(?:[\w-]*[^\S\n]*\n)?([\s\S]*?)\n?```/);
  if (m && m[1].trim()) return m[1];
  return t.replace(/^```[\w-]*[^\S\n]*\n?/, '').replace(/\n?```\s*$/, '');
}

function dropPreamble(t) {
  for (let k = 0; k < 4; k++) {
    const lines = t.split('\n');
    const first = lines[0].replace(/^#{1,6}\s+/, '').trim();
    const rest = lines.slice(1).join('\n').trim();
    const m = first.match(PREAMBLE);
    if (m) { const tail = first.slice(m[0].length).trim(); t = tail ? [tail, ...lines.slice(1)].join('\n') : rest; continue; }
    if (rest && (PLEASANTRY.test(first) || LABEL_LINE.test(first) || !first)) { t = rest; continue; }
    break;
  }
  return t.trim();
}

// A reply that came back as JSON anyway ({"rewrite": "…"}): take its first text.
function fromJson(t) {
  if (!/^[{[]/.test(t)) return t;
  try { const v = JSON.parse(t); const s = typeof v === 'string' ? v : textsOf(v)[0]; return typeof s === 'string' && s.trim() ? s : t; } catch { return t; }
}

function unwrap(t) {
  t = t.trim();
  const tag = t.match(/^<(rewrite|rewritten|sentence|target|output|answer|paragraph|revised|text|result)>\s*([\s\S]*?)\s*<\/\1>$/i);
  if (tag) return tag[2];
  for (const [o, c, family] of WRAPS) {
    if (!t.startsWith(o)) continue;
    let inner, tail = '';
    if (t.length >= o.length + c.length && t.endsWith(c)) inner = t.slice(o.length, t.length - c.length);
    else if (t.length > o.length + c.length && /[.!?]$/.test(t) && t.slice(0, -1).endsWith(c)) { inner = t.slice(o.length, t.length - 1 - c.length); tail = t.slice(-1); }
    else continue;
    // apostrophes inside words (don't, lender’s) are not quotes; “nested” curly pairs are fine
    if (family.test(inner.replace(/(\p{L})['’](\p{L})/gu, '$1$2')) && !(PAIRED[o] === c && paired(inner, o, c))) continue;
    inner = inner.trim();
    return tail && !/[.!?]$/.test(inner) ? inner + tail : inner;
  }
  return t;
}

export function cleanOutput(text) {
  let t = stripThink(str(text).replace(/\r\n?/g, '\n'));
  t = t.replace(/(^|\s)\/(?:no_)?think\b/gi, '$1').trim();
  t = unfence(t).trim();
  t = fromJson(t).trim();
  t = t.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '$1').replace(/__([^_\n][\s\S]*?)__/g, '$1').replace(/\*\*/g, '')
    .replace(/(^|[\s(“"‘'])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s).,;:!?”"’'])/g, '$1$2');
  t = dropPreamble(t);
  const blocks = t.split(/\n[^\S\n]*\n/).map((b) => b.trim()).filter(Boolean);
  while (blocks.length > 1 && isMeta(blocks[0])) blocks.shift();
  t = dropPreamble(blocks[0] || '');
  const lines = t.split('\n');
  while (lines.length > 1 && NOTE_LINE.test(lines[lines.length - 1].trim())) lines.pop();
  // [^()] and no leading \s*: linear on long runs of spaces or brackets
  t = lines.join('\n').replace(/\((?:note|i (?:kept|changed|removed|replaced|used|split))\b[^()]*\)\s*$/i, '').trimEnd();
  for (let k = 0; k < 3; k++) { const prev = t; t = dropPreamble(unwrap(t)); if (t === prev) break; }
  return t.split('\n').map((l) => l.trimEnd()).join('\n').trim();
}
