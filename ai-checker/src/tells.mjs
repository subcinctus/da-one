// AI-writing tells: words, stock phrases, formulas and structure that make an answer read as
// machine-written, each with exact offsets and a plain-English fix. Rule data lives in tells-data.mjs.
// Precision first: a formal Indian finance answer written by a person should come back (nearly) clean.
// No DOM access.
import { words, splitSentences } from './text.mjs';
import { AI_WORDS, WORD_EXCEPTIONS, LEVERAGE_VERB, PHRASES, OPENERS, CONTRASTS, ING_SKIP, AI_PARTICIPLES, AI_ADVERBS,
  TRIAD_DOMAIN, TRIAD_ABSTRACT, TRIAD_SUFFIX, TRIAD_LINKERS, TRIAD_VERBS, FORM_LABELS, SIGNOFF, HEDGES, STACKED_HEDGE,
  BAN_LIST } from './tells-data.mjs';

export { BAN_LIST };

const str = (t) => (typeof t === 'string' ? t : t == null ? '' : String(t));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WORD_INFO = new Map();
for (const [forms, weight, tip] of AI_WORDS) {
  const list = forms.split(' ');
  for (const f of list) WORD_INFO.set(f, { weight, tip, base: list[0] });
}
const WORD_RE = new RegExp(`\\b(?:${[...WORD_INFO.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|')})\\b`, 'gi');

const isLetter = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// True when position i begins a sentence or a line (skipping quotes, brackets and list markers such as
// "-", "•", "(a)" or "1)").
function atStart(text, i) {
  let j = i - 1;
  while (j >= 0 && /[ \t\r"'“‘(\[*•_#>-]/.test(text[j])) j--;
  if (text[j] === ')') {
    const line = text.slice(text.lastIndexOf('\n', j) + 1, j + 1);
    if (/^[ \t]*\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})\)$/i.test(line)) return true;
  }
  return j < 0 || /[\n.!?…]/.test(text[j]);
}

// True when the sentence starting at i is the last one of its paragraph (or line).
function lastInParagraph(text, i) {
  const nl = text.indexOf('\n', i);
  const para = text.slice(i, nl < 0 ? text.length : nl);
  const m = /[.!?…]["'’”)\]]*\s+(?=["'“‘(]?[\p{Lu}\p{N}₹])/u.exec(para);
  return !m || !/\p{L}/u.test(para.slice(m.index + m[0].length));
}

// ---------- word and phrase lists ----------
function findWords(text, add) {
  for (const m of text.matchAll(WORD_RE)) {
    const s = m.index, e = s + m[0].length, w = m[0].toLowerCase();
    if (text[s - 1] === '-' || (text[e] === '-' && isLetter(text[e + 1]))) continue;  // part of a compound
    // a name, e.g. "Vibrant Gujarat", also at the start of a sentence (or a Title Case heading)
    if (/^\p{Lu}/u.test(m[0]) && (!atStart(text, s) || /^[ \t]+\p{Lu}\p{Ll}/u.test(text.slice(e, e + 4)))) continue;
    const info = WORD_INFO.get(w);
    if (WORD_EXCEPTIONS[info.base]?.test(text.slice(e, e + 40))) continue;
    add(s, e, 'ai-word', 'vocabulary', `"${cap(w)}": a word AI overuses. ${info.tip}`, info.weight);
  }
  for (const m of text.matchAll(LEVERAGE_VERB)) {
    if (m[0].startsWith('May ')) continue;  // "In May leverage rose": the month
    const e = m.index + m[0].length;
    add(e - m[1].length, e, 'ai-word', 'vocabulary', '"Leverage" as a verb: a word AI overuses. Use "use".', 2);
  }
}

// Phrase and formula lists: [regex, rule, category, weight | (match) => weight, message]. A weight of 0
// skips the match. Leading punctuation is trimmed so riders like ", highlighting the" start at the verb.
// Formulas that run into the next sentence are cut at the end of the first one (see clip).
function findPhrases(text, list, add) {
  for (const [re, rule, cat, w, msg] of list) {
    for (const m of text.matchAll(re)) {
      const weight = typeof w === 'function' ? w(m) : w;
      if (!weight) continue;
      let s = m.index;
      const e = s + m[0].length;
      while (s < e && /[\s,;:]/.test(text[s])) s++;
      add(s, e, rule, cat, msg, weight);
    }
  }
}

function findOpeners(text, add) {
  for (const [re, rule, cat, w, msg, need] of OPENERS) {
    for (const m of text.matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      if (!atStart(text, s)) continue;
      if (need && !/^\s*,/.test(text.slice(e, e + 3))) continue;
      if (need === 'last' && !lastInParagraph(text, s)) continue;
      add(s, e, rule, cat, msg(cap(m[0])), w);
    }
  }
}

// ---------- triads: exactly three short items, "X, Y(,) and Z", used for rhythm ----------
const STOP = new Set('on in of to the a an our their its is are was were for with by from at as and or very more less most also'.split(' '));
const DELIM = /[,;:.!?\n—–()]/;
const ANCHOR = /,\s+([^,;:.!?\n—–()]{1,40}?),?\s+(and|or)\s+/g;

const tokens = (s, base) => [...s.matchAll(/\S+/g)].map((m) => ({ s: base + m.index, e: base + m.index + m[0].length, w: m[0] }));
const bare = (w) => w.toLowerCase().replace(/^["'“‘(]+|["'’”),]+$/g, '').replace(/['’]s$/, '');
const isAbstract = (w) => w.length > 4 && (TRIAD_ABSTRACT.has(w) || TRIAD_SUFFIX.test(w));
const domainWord = (w) => TRIAD_DOMAIN.has(w) || TRIAD_DOMAIN.has(w.replace(/e?s$/, ''));

function findTriads(text, add) {
  let count = 0;
  for (const m of text.matchAll(ANCHOR)) {
    const comma = m.index, yStart = comma + m[0].indexOf(m[1]);
    const Y = tokens(m[1], yStart);
    if (Y.length < 1 || Y.length > 3) continue;
    // X: back to the previous delimiter; a comma there means a longer list
    let j = comma - 1;
    while (j >= 0 && comma - j < 80 && !DELIM.test(text[j])) j--;
    const seg = tokens(text.slice(j + 1, comma), j + 1);
    if (text[j] === ',' && seg.length <= Y.length + 1) continue;
    let X = seg.slice(-Y.length);
    while (X.length > 1 && STOP.has(bare(X[0].w))) X = X.slice(1);
    // Z: forward to the next delimiter, same length as Y (one more for "more transparent")
    const zStart = m.index + m[0].length;
    let k = zStart;
    while (k < text.length && k - zStart < 80 && !DELIM.test(text[k])) k++;
    const after = tokens(text.slice(zStart, k), zStart);
    let Z = after.slice(0, Y.length + (after[0] && STOP.has(bare(after[0].w)) ? 1 : 0));
    while (Z.length > 1 && STOP.has(bare(Z[Z.length - 1].w))) Z = Z.slice(0, -1);
    if (!X.length || !Z.length) continue;
    if (X.length === 1 && TRIAD_LINKERS.has(bare(X[0].w))) continue;                             // "However, …"
    const items = [X, Y, Z];
    const all = items.flat();
    if (all.some((t) => TRIAD_VERBS.has(bare(t.w)))) continue;                                   // clauses, not items
    const head = after[Z.length];                                                                 // "current, previous and next quarter"
    if (head && domainWord(bare(head.w))) continue;
    if (all.some((t) => /[\d₹$€£%&@/]/.test(t.w))) continue;                                     // figures: factual list
    if (all.some((t) => /\p{Lu}/u.test(t.w) && !(t === X[0] && atStart(text, t.s)))) continue;   // names, acronyms
    if (all.some((t) => domainWord(bare(t.w)))) continue;                                         // products, teams, places
    const abstract = items.filter((it) => isAbstract(bare(it[it.length - 1].w))).length;
    if (abstract < 2) continue;
    count++;
    add(X[0].s, Z[Z.length - 1].e, 'triad', 'formula', 'Three-part list for rhythm. Keep the items that carry facts, or use two.', abstract === 3 ? 2 : 1);
  }
  return count;
}

// ---------- sentence-level structure ----------
const SUBJECT = /^(?:we|i|you|they|he|she|it|this|these|those|the|our|their|its|his|her|a|an|one|each|every|all|many|most|some|such|there|lenders?|banks?|nbfcs?|companies|firms|businesses|institutions|teams?|leaders|management|customers|borrowers)$/i;

const aiAdverb = (w) => !!w && AI_ADVERBS.has(w.toLowerCase());
const NOT_ADVERB = new Set('early only daily weekly monthly quarterly yearly family supply likely friendly costly timely elderly'.split(' '));

function findIngOpeners(text, sents, add) {
  let count = 0;
  for (const s of sents) {
    const lead = /^[-*•"'“‘(\s]*/.exec(s.text)[0].length;
    const body = s.text.slice(lead), base = s.start + lead;
    let m = /^By\s+(?:(\p{L}+ly)\s+)?(\p{L}{3,}ing)\b/u.exec(body);
    if (m) {
      count++;
      if (aiAdverb(m[1]) || AI_PARTICIPLES.has(m[2].toLowerCase())) {
        const comma = body.search(/,(?!\d)/);  // not the comma in ₹1,000
        const end = comma > 0 && comma < 140 ? comma : m[0].length;
        add(base, base + end, 'ing-opener', 'opener', '"By …ing" opener. Lead with who does what.', 2);
      }
      continue;
    }
    m = /^(?:(\p{L}+ly)\s+)?(\p{L}{2,}ing)\b([^,;:.!?\n]{0,100}),\s*["'“‘(]?(\p{L}+)/u.exec(body);
    if (!m || ING_SKIP.has(m[2].toLowerCase())) continue;
    if (m[1] && (NOT_ADVERB.has(m[1].toLowerCase()) || !/^\p{Lu}/u.test(m[1]))) continue;
    if (!SUBJECT.test(m[4]) && !/^\p{Lu}/u.test(m[4])) continue;  // "Lending to MSMEs, especially …" is a gerund subject
    count++;
    if (aiAdverb(m[1]) || AI_PARTICIPLES.has(m[2].toLowerCase())) {
      const end = m[0].length - m[4].length;
      add(base, base + body.lastIndexOf(',', end), 'ing-opener', 'opener', '"-ing" opener. Lead with who does what.', aiAdverb(m[1]) ? 2 : 1);
    }
  }
  return count;
}

function findHedges(text, sents, add) {
  const stacked = [];
  for (const m of text.matchAll(STACKED_HEDGE)) {
    stacked.push(m.index);
    add(m.index, m.index + m[0].length, 'hedge-stack', 'structure', 'Stacked hedges. Keep one, or give the number.', 2);
  }
  for (const s of sents) {
    if (stacked.some((i) => i >= s.start && i < s.end)) continue;
    const hits = [...s.text.matchAll(HEDGES)].filter((h) => h[0] !== 'May');  // the month
    if (hits.length < 3) continue;
    const last = hits[hits.length - 1];
    add(s.start + hits[0].index, s.start + last.index + last[0].length, 'hedge-stack', 'structure',
      `${hits.length} hedges in one sentence. Keep one qualifier, or give the number.`, 1);
  }
}

// Three or more very short sentences in a row ("No setup. No fees. No waiting.").
function findStaccato(sents, add) {
  let run = [];
  const flush = () => {
    if (run.length >= 3) for (const s of run) add(s.start, s.end, 'staccato', 'structure', 'String of very short sentences for drama. Join them into one plain sentence.', 1);
    run = [];
  };
  for (const s of sents) {
    // dialogue in quotes is fiction; figures and bullets are a factual list; "Thanks. Regards." is a sign-off
    const short = words(s.text) <= 4 && /[.!]$/.test(s.text) && !/["“”‘’'\d]/.test(s.text)
      && !/^(?:[-*•▪◦]|\(?\w\))/.test(s.text) && !SIGNOFF.test(s.text);
    if (short) run.push(s);
    else flush();
  }
  flush();
}

// A short question sentence ("The result?", "Why?") followed at once by its answer.
// No "i" flag: with it, \p{Lu} would match lower-case letters too.
const SELF_Q = /^(?:[Aa]nd |[Bb]ut |[Ss]o )?(?:[Ww]hy|[Hh]ow|[Tt]he (?:real )?[\w-]+(?: [\w-]+)?)\?$/u;
function findSelfAnswers(sents, add) {
  for (let i = 0; i + 1 < sents.length; i++) {
    const s = sents[i];
    const next = sents[i + 1].text;
    if (SELF_Q.test(s.text) && /^["'“‘]?[\p{Lu}\p{N}₹]/u.test(next) && !/\?["'’”]?$/.test(next)) {
      add(s.start, s.end, 'self-answer', 'structure', 'Question you answer at once. Just state the answer.', 2);
    }
  }
}

// ---------- punctuation ----------
const DASH_LIMIT = 1.0;  // dashes per 100 words; see styleStats
// Em dashes, spaced en dashes and double hyphens used as dashes; not ranges such as 2023–24 or 5—10.
function dashPositions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '—') { if (!(/\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || ''))) out.push([i, i + 1]); }
    else if (c === '–') { if (/\s/.test(text[i - 1] || '') && /\s/.test(text[i + 1] || '')) out.push([i, i + 1]); }
    else if (c === '-' && text[i + 1] === '-' && text[i + 2] !== '-' && text[i - 1] !== '-') {
      // " -- " or "word--word"; not a CLI flag such as --verbose
      const prev = text[i - 1] || '', next = text[i + 2] || '';
      if ((/\s/.test(next) && prev !== '' && prev !== '\n') || (isLetter(prev) && isLetter(next))) out.push([i, i + 2]);
      i++;
    }
  }
  return out;
}

// "Label: Explanation" lines (sloptotal's colon definitions) and lines that end in a colon. A sentence that
// carries on in lower case after a colon ("Our rule is simple: lend against property") is ordinary prose.
const LABEL_LINE = /^([ \t]*(?:[-*•▪◦]|\d{1,2}[.)])?[ \t]*)(?:\*\*|__)?([A-Za-z][A-Za-z'’ &/-]{0,48}?)(?:\*\*|__)?[ \t]?:(?:\*\*|__)?[ \t]+(\S.*)$/;
function colonScan(text) {
  const labels = [];
  let intros = 0, at = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;  // "." does not match \r
    const m = LABEL_LINE.exec(line);
    if (m) {
      const n = m[2].trim().split(/\s+/).length;
      const field = FORM_LABELS.has(m[2].trim().toLowerCase());  // "Subject:", "Q:", "Note:" are letter fields
      const marked = m[1].trim() !== '' || /^\s*(?:\*\*|__)/.test(line.slice(m[1].length));  // bullet or bold label
      if (!field && n <= 5 && m[3].length >= 12 && !/^(?:[\d₹$€£]|rs\.?\s|inr\b)/i.test(m[3]) && (marked || /^["'“‘(]?\p{Lu}/u.test(m[3]))) {
        const s = at + m[1].length;
        labels.push({ s, e: at + line.indexOf(':', m[1].length + m[2].length) + 1, bold: /^\s*(?:\*\*|__)/.test(line.slice(m[1].length)) });
      }
    } else if (/:\s*$/.test(line) && /\p{L}/u.test(line) && !FORM_LABELS.has(line.replace(/[\s*_:]+/g, ' ').trim().toLowerCase())) intros++;
    at += raw.length + 1;
  }
  return { labels, intros };
}

// ---------- assembly ----------
// Keep every finding inside the sentence it starts in, so the page can list it under that sentence
// ("It's not just a loan. It's a promise." shows as the first sentence).
function clip(found, sents) {
  for (const f of found) {
    let lo = 0, hi = sents.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sents[mid].start <= f.start) lo = mid; else hi = mid - 1; }
    const s = sents[lo];
    if (s && f.start >= s.start && f.start < s.end && f.end > s.end) f.end = s.end;
  }
}

const ABSORBS = new Set(['phrase', 'opener', 'closer', 'punctuation']);
function tidy(list) {
  // by start, longer first, and a word after any phrase with the same span
  list.sort((a, b) => a.start - b.start || b.end - a.end || (a.category === 'vocabulary') - (b.category === 'vocabulary') || b.weight - a.weight);
  const out = [], seen = new Set(), catEnd = {};
  let coverEnd = -1, formulaEnd = -1;
  for (const f of list) {
    if (f.category === 'vocabulary') {
      if (f.end <= coverEnd) continue;  // a stock phrase that already names the word ("plays a pivotal role") counts once
    } else if (ABSORBS.has(f.category) && !f.wide) {
      // a phrase inside a longer one of the same kind is the same tell ("It's worth noting that" ⊃ "worth noting")
      if (f.end <= (catEnd[f.category] ?? -1)) continue;
      catEnd[f.category] = Math.max(catEnd[f.category] ?? -1, f.end);
      coverEnd = Math.max(coverEnd, f.end);
    }
    const key = `${f.start}:${f.end}:${f.rule}`;
    if (seen.has(key)) continue;
    if (f.category === 'formula') {
      if (f.start < formulaEnd) continue;  // overlapping formulas are one tell
      formulaEnd = f.end;
    }
    seen.add(key);
    out.push({ start: f.start, end: f.end, rule: f.rule, category: f.category, message: f.message, weight: f.weight });
  }
  return out;
}

let memo = { text: null, res: null };
function analyse(text) {
  if (memo.text === text) return memo.res;
  const found = [];
  const add = (start, end, rule, category, message, weight, wide = false) => {
    if (end > start && weight > 0) found.push({ start, end, rule, category, message, weight, wide });
  };
  const wide = (start, end, rule, category, message, weight) => add(start, end, rule, category, message, weight, true);
  const sents = /\p{L}/u.test(text) ? splitSentences(text) : [];
  let triads = 0, ingOpeners = 0, dashes = [], colons = { labels: [], intros: 0 };
  if (sents.length) {
    findWords(text, add);
    findPhrases(text, PHRASES, add);
    findPhrases(text, CONTRASTS, wide);
    findOpeners(text, add);
    triads = findTriads(text, wide);
    ingOpeners = findIngOpeners(text, sents, wide);
    findHedges(text, sents, wide);
    findStaccato(sents, wide);
    findSelfAnswers(sents, add);
    dashes = dashPositions(text);
    colons = colonScan(text);
  }
  const nWords = words(text);
  const dashRate = nWords ? (dashes.length / nWords) * 100 : 0;
  if (dashes.length >= 2 && dashRate > DASH_LIMIT) {
    for (const [s, e] of dashes) add(s, e, 'em-dash', 'punctuation', `Dash-heavy (${dashRate.toFixed(1)} per 100 words). Use commas, brackets or full stops.`, 1);
  }
  for (const l of colons.labels) {
    if (colons.labels.length >= 2 || l.bold) add(l.s, l.e, 'label-colon', 'punctuation', '"Label:" lines read as an AI template. Write them as sentences.', 1);
  }
  clip(found, sents);
  const res = { findings: tidy(found), sents, nWords, triads, ingOpeners, dashes: dashes.length, dashRate, colonLines: colons.labels.length + colons.intros };
  memo = { text, res };
  return res;
}

export function findTells(text) {
  return analyse(str(text)).findings.map((f) => ({ ...f }));
}

// Human professional ranges behind the flags (see the module README and tests):
// - cvLen (burstiness): sentence-length SD / mean over sentences of 3+ words. In the project's labelled
//   pool (tools/sample_texts.json, texts with 6+ sentences) human writing has a 5th percentile of 0.28
//   and median 0.49; AI text has median 0.33 and 23% below 0.25 (2% of humans). Flag < 0.25 with 6+ sentences.
// - meanLen: business writing averages 12-28 words a sentence (Indian formal prose runs long, so the top is
//   generous); AI and human means overlap, so only an average above 30 is flagged, as hard to read.
// - contractionsPer100: formal business prose often has none, so a low rate is not evidence; never flagged.
// - emDashPer100: most professional writers use under 0.5 per 100 words; chat models often use 1-3. Flag > 1.0
//   with 2+ dashes (sloptotal saturates at 0.6).
// - colonLines: "Label: text" lines plus lines ending in a colon. Prose answers rarely have more than two;
//   flag 3+.
// - triads: rhetorical three-part lists. One is normal; flag 2+ when they come at least once per 200 words.
// - ingOpeners: participial sentence openers. Flag 2+ when they start at least a fifth of the sentences.
export function styleStats(text) {
  const t = str(text);
  const { sents, nWords, triads, ingOpeners, dashes, dashRate, colonLines } = analyse(t);
  const lens = sents.map((s) => words(s.text)).filter((n) => n >= 3);
  const n = lens.length;
  const meanLen = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(lens.reduce((a, x) => a + (x - meanLen) ** 2, 0) / (n - 1)) : 0;
  const cvLen = meanLen ? sd / meanLen : 0;
  const contractions = (t.match(/\b\p{L}+(?:n['’]t|['’](?:re|ve|ll|m|d))\b|\b(?:it|that|there|here|what|who|let|he|she|where|how)['’]s\b/giu) || []).length;
  const contractionsPer100 = nWords ? (contractions / nWords) * 100 : 0;
  const flags = [];
  if (n >= 6 && cvLen < 0.25) flags.push({ stat: 'cvLen', value: cvLen,
    message: `Sentences are all about the same length (variation ${cvLen.toFixed(2)}; people usually write 0.3–0.7). Mix short and long ones.` });
  if (n >= 3 && meanLen > 30) flags.push({ stat: 'meanLen', value: meanLen,
    message: `Sentences average ${Math.round(meanLen)} words; business writing usually averages 12–28. Split the longest.` });
  if (dashes >= 2 && dashRate > DASH_LIMIT) flags.push({ stat: 'emDashPer100', value: dashRate,
    message: `${dashRate.toFixed(1)} dashes per 100 words; most professional writers use under 0.5. Use commas or full stops.` });
  if (colonLines >= 3) flags.push({ stat: 'colonLines', value: colonLines,
    message: `${colonLines} "Label:" or list-intro lines. Answers written by people rarely have more than two; use sentences.` });
  if (triads >= 2 && (triads / Math.max(nWords, 1)) * 200 >= 1) flags.push({ stat: 'triads', value: triads,
    message: `${triads} three-part lists. People rarely group everything in threes; use one or two items.` });
  if (ingOpeners >= 2 && ingOpeners / Math.max(sents.length, 1) >= 0.2) flags.push({ stat: 'ingOpeners', value: ingOpeners,
    message: `${ingOpeners} sentences open with an "-ing" phrase. Lead with who does what.` });
  return { sentences: sents.length, meanLen, cvLen, contractionsPer100, emDashPer100: dashRate, colonLines, triads, ingOpeners, flags };
}

// Tells per sentence, aligned with `sentences` ([{start, end}], default splitSentences(text)). A tell counts
// for every sentence it overlaps.
export function tellsBySentence(text, sentences) {
  const t = str(text);
  const list = Array.isArray(sentences) ? sentences : splitSentences(t);
  const tells = analyse(t).findings;
  return list.map((s) => {
    const hit = s && Number.isFinite(s.start) && Number.isFinite(s.end) ? tells.filter((f) => f.start < s.end && f.end > s.start) : [];
    return { count: hit.length, weight: hit.reduce((a, f) => a + f.weight, 0), rules: [...new Set(hit.map((f) => f.rule))] };
  });
}
