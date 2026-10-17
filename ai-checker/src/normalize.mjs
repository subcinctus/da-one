// Input clean-up: invisible characters, lookalike letters, fullwidth forms and unusual spaces.
// cleanText is applied to the editor (with notice and undo); forDetector feeds the checkers.
// Offsets are UTF-16 indexes into the original string, like the rest of the page.

import { LOOKALIKES } from './confusables-data.mjs';

// lookalike -> {to, sc, strict}
const LOOK = new Map();
for (const [sc, g] of Object.entries(LOOKALIKES)) {
  for (const strict of [true, false]) {
    for (const pair of g[strict ? 'strict' : 'loose'].split(' ').filter(Boolean)) {
      const [from, to] = Array.from(pair);
      LOOK.set(from, { to, sc, strict });
    }
  }
}
const SCRIPT_RE = {
  Cyrl: /\p{Script=Cyrillic}/u, Grek: /\p{Script=Greek}/u, Armn: /\p{Script=Armenian}/u,
  Cher: /\p{Script=Cherokee}/u, Lisu: /\p{Script=Lisu}/u, Copt: /\p{Script=Coptic}/u,
};

const LETTER = /\p{L}/u;
const WORD_CH = /[\p{L}\p{M}\p{Nd}]/u;
const LOWER = /\p{Ll}/u;
// Latin letters of ordinary orthographies (accented letters, sharp s ...); not IPA or small capitals.
const isBase = (ch) => /^[A-Za-z]$/.test(ch) || (/^[\u{C0}-\u{24F}\u{1E00}-\u{1EFF}]$/u.test(ch) && LETTER.test(ch));

// Visible Cf signs (Arabic number sign, Syriac abbreviation mark, Kaithi number sign ...).
const PREPENDED = new Set([0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6DD, 0x70F, 0x890, 0x891, 0x8E2, 0x110BD, 0x110CD]);
const JOINERS = new Set([0x200C, 0x200D, 0x180E]);
const HANGUL_FILLERS = new Set([0x115F, 0x1160, 0x3164, 0xFFA0]);
const isVS = (cp) => (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)
  || (cp >= 0x180B && cp <= 0x180D) || cp === 0x180F;
const isFwPunct = (cp) => cp >= 0xFF01 && cp <= 0xFF5E && !/[A-Za-z0-9]/.test(String.fromCharCode(cp - 0xFEE0));
// Invisible but not Cf: unassigned default-ignorable code points and the Khmer inherent vowels
// U+17B4/U+17B5 (discouraged, render as nothing), all used to hide data in text.
const isHidden = (cp) => cp === 0x2065 || cp === 0x17B4 || cp === 0x17B5 || (cp >= 0xFFF0 && cp <= 0xFFF8)
  || (cp >= 0xE0000 && cp <= 0xE0FFF && !(cp >= 0xE0100 && cp <= 0xE01EF));
const KEEP_CC = new Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85]);
// Characters removed whatever their neighbours are.
const gone = ({ ch, cp }) => isHidden(cp) || (/\p{Cc}/u.test(ch) && !KEEP_CC.has(cp))
  || (/\p{Cf}/u.test(ch) && !JOINERS.has(cp) && !PREPENDED.has(cp));

// Scripts that never need joiners or variation selectors between letters.
const SIMPLE = new RegExp(`[${['Latin', 'Greek', 'Cyrillic', 'Armenian', 'Cherokee', 'Coptic', 'Lisu', 'Common', 'Inherited']
  .map((sc) => `\\p{Script=${sc}}`).join('')}]`, 'u');
// Letters and marks of scripts that use ZWJ/ZWNJ (Indic, Arabic ...). None of them is removed
// later, so a decision based on them still holds on a second pass.
const complexLetter = (c) => !!c && /[\p{L}\p{M}]/u.test(c.ch) && !SIMPLE.test(c.ch) && !LOOK.has(c.ch)
  && !HANGUL_FILLERS.has(c.cp) && !isVS(c.cp) && !isHidden(c.cp);
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI = /\p{Emoji}/u;
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{20E3}]/u;
// U+3000 is left out: it becomes a normal space, so it must not count as CJK context.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u{3001}-\u{303F}\u{30FC}\u{FF61}-\u{FF9F}]/u;

function codePoints(s) {
  const cs = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
    cs.push({ i, ch, cp, out: ch, kind: null });
    i += ch.length;
  }
  return cs;
}

// Fullwidth punctuation is normal typography right next to Chinese, Japanese or Korean text.
function nearCJK(cs, k) {
  for (const step of [-1, 1]) {
    for (let j = k + step, n = 0; j >= 0 && j < cs.length && n < 8; j += step, n++) {
      const { ch, cp } = cs[j];
      if (isFwPunct(cp) || isVS(cp) || HANGUL_FILLERS.has(cp) || JOINERS.has(cp) || gone(cs[j])) continue;
      if (CJK.test(ch)) return true;
      break;
    }
  }
  return false;
}

// The next character that survives clean-up, so that a second pass decides the same way.
function nextKept(cs, k) {
  let j = k + 1;
  while (j < cs.length && gone(cs[j])) j++;
  return cs[j];
}

// Variation selectors belong after emoji, symbols, CJK ideographs and keycap digits, never after
// Latin-like letters, spaces or another selector (hidden-data tricks). The emoji selectors
// FE0E/FE0F only have a meaning after emoji (emoji-variation-sequences.txt).
function keepVS(cs, k, prev) {
  const { cp } = cs[k];
  if (!prev || /\s/.test(prev.ch) || isVS(prev.cp)) return false;
  if (cp >= 0xE0100) return /\p{Script=Han}/u.test(prev.ch);
  if (/[0-9#*]/.test(prev.ch)) return nextKept(cs, k)?.ch === '\u{20E3}';
  if (cp === 0xFE0E || cp === 0xFE0F) return EMOJI.test(prev.ch);
  if (PICTO.test(prev.ch)) return true;
  return prev.cp >= 0x80 && !LOOK.has(prev.ch) && !(LETTER.test(prev.ch) && SIMPLE.test(prev.ch));
}

// Returns [replacement, kind] or null to keep the character. `prev` is the last character kept and
// `next` the next one kept, so a second pass gives the same result.
function classify(cs, k, prev) {
  const { ch, cp } = cs[k];
  if (cp >= 0x20 && cp < 0x7F) return null;
  if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return null;
  if (cp === 0x0B || cp === 0x0C || cp === 0x85 || cp === 0x2028 || cp === 0x2029) return ['\n', 'space'];
  if (/\p{Zs}/u.test(ch) || cp === 0x2800) return [' ', 'space'];
  if (cp >= 0xFF01 && cp <= 0xFF5E) return isFwPunct(cp) && nearCJK(cs, k) ? null : [String.fromCharCode(cp - 0xFEE0), 'fullwidth'];
  if (/\p{Cc}/u.test(ch) || isHidden(cp)) return ['', 'invisible'];
  if (/\p{Cf}/u.test(ch)) {
    if (PREPENDED.has(cp)) return null;
    if (JOINERS.has(cp)) {
      const next = nextKept(cs, k);
      // inside an Indic or Arabic-script word, or after a virama at its end (the Malayalam
      // chillu "ന്\u200d" is na + virama + ZWJ)
      const wordEnd = !next || !/[\p{L}\p{M}\p{N}]/u.test(next.ch);
      if (complexLetter(prev) && (complexLetter(next) || (wordEnd && /\p{M}/u.test(prev.ch)))) return null;
      // emoji ZWJ sequence: emoji (or its modifier / selector) + ZWJ + pictograph
      if (cp === 0x200D && prev && next && EMOJI_PART.test(prev.ch) && PICTO.test(next.ch)) return null;
    }
    return ['', 'invisible'];
  }
  if (isVS(cp)) return keepVS(cs, k, prev) ? null : ['', 'invisible'];
  if (cp === 0x34F) return prev && /\p{M}/u.test(prev.ch) ? null : ['', 'invisible']; // grapheme joiner
  if (HANGUL_FILLERS.has(cp)) {
    const hangul = (c) => !!c && !HANGUL_FILLERS.has(c.cp) && /\p{Script=Hangul}/u.test(c.ch);
    return hangul(prev) || hangul(nextKept(cs, k)) ? null : ['', 'invisible'];
  }
  return null;
}

// Emoji subdivision flag (black flag, tag letters of a subdivision code such as "gbeng", cancel
// tag): returns the last index kept. Any other tag text is hidden data and is removed.
function flagTags(cs, k) {
  let j = k + 1, code = '';
  while (j < cs.length && cs[j].cp >= 0xE0020 && cs[j].cp <= 0xE007E && code.length < 8) code += String.fromCharCode(cs[j++].cp - 0xE0000);
  return cs[j]?.cp === 0xE007F && /^(?:[a-z]{2}|[0-9]{3})[0-9a-z]{1,4}$/.test(code) ? j : k;
}

function wordsOf(cs) {
  const words = [];
  let cur = null;
  for (const c of cs) {
    if (c.out === '') continue; // removed characters do not split words
    if (!WORD_CH.test(c.out)) { cur = null; continue; }
    if (!cur) words.push(cur = []);
    cur.push(c);
  }
  return words.map((w) => {
    const letters = w.filter((c) => LETTER.test(c.out));
    const x = { letters, base: 0, foreign: 0, look: 0, scripts: new Set(), strict: true };
    for (const c of letters) {
      const e = LOOK.get(c.out);
      if (e) { x.look++; x.scripts.add(e.sc); x.strict = x.strict && e.strict; }
      else if (isBase(c.out)) x.base++;
      else x.foreign++;
    }
    return x;
  });
}

// I and l share one TR39 skeleton; pick from the neighbouring letters: l next to lowercase letters
// (heΙΙo) or before a lowercase vowel at the start of a word (Ιoan, Ιakh), otherwise I (Ιt, ΙNDIA).
function caseIL(src, prev, next) {
  const skel = (ch) => LOOK.get(ch)?.to ?? ch;
  const lower = (ch) => !!ch && (LOWER.test(ch) || (LOOK.has(ch) && /^[a-km-z]$/.test(skel(ch))));
  if (prev) return lower(prev) || lower(next) ? 'l' : 'I';
  return lower(next) && (LOWER.test(src) || /^[aeiou]$/.test(skel(next))) ? 'l' : 'I';
}

function mapWord(x, loose) {
  const { letters } = x;
  letters.forEach((c, n) => {
    const e = LOOK.get(c.out);
    if (!e || !(e.strict || loose)) return;
    c.out = /[Il]/.test(e.to) && e.sc !== 'Zyyy' ? caseIL(c.out, letters[n - 1]?.out, letters[n + 1]?.out) : e.to;
    c.kind = 'lookalike';
  });
}

// A run of whole-lookalike words next to a genuine word of the same script is that language.
// The answer is stored for the whole run so long runs stay linear.
function nearGenuine(info, n, sc, memo) {
  const re = SCRIPT_RE[sc];
  if (!re) return false;
  if (memo.has(n)) return memo.get(n);
  const same = (x) => x.look && !x.base && !x.foreign && x.scripts.size === 1 && x.scripts.has(sc);
  const genuine = (x) => !!x && x.letters.some((c) => !LOOK.has(c.out) && re.test(c.out));
  let a = n - 1, b = n + 1;
  while (a >= 0 && same(info[a])) a--;
  while (b < info.length && same(info[b])) b++;
  const r = genuine(info[a]) || genuine(info[b]);
  for (let j = a + 1; j < b; j++) memo.set(j, r);
  return r;
}

function mapLookalikes(cs) {
  const info = wordsOf(cs);
  const styled = (x) => x.scripts.size === 1 && x.scripts.has('Zyyy');
  // mixed scripts or styled math letters: always mapped, so they count as Latin below
  const mixed = (x) => x.look && !x.foreign && (x.base || x.scripts.size > 1 || styled(x));
  let total = 0, latin = 0;
  for (const x of info) {
    total += x.letters.length;
    if (mixed(x) || (x.base && x.base >= x.foreign)) latin += x.letters.length;
  }
  const mostlyLatin = total > 0 && latin / total >= 0.8;
  const memo = new Map();
  info.forEach((x, n) => {
    if (mixed(x)) mapWord(x, x.letters.length >= 4); // loose lookalikes only in longer words
    else if (x.look && !x.foreign && x.strict && mostlyLatin && !nearGenuine(info, n, [...x.scripts][0], memo)) mapWord(x, false);
  });
}

function analyse(text) {
  const cs = codePoints(String(text ?? ''));
  let prev;
  for (let k = 0; k < cs.length; k++) {
    if (cs[k].cp === 0x1F3F4) k = flagTags(cs, k);
    else {
      const r = classify(cs, k, prev);
      if (r) [cs[k].out, cs[k].kind] = r;
    }
    if (cs[k].out) prev = { ch: cs[k].out, cp: cs[k].out.codePointAt(0) };
  }
  mapLookalikes(cs);
  return cs;
}

const COUNT_KEY = { invisible: 'invisible', lookalike: 'lookalike', fullwidth: 'fullwidth', space: 'spaces' };

export function cleanText(text) {
  const src = String(text ?? '');
  const counts = { invisible: 0, lookalike: 0, fullwidth: 0, spaces: 0 };
  const parts = [];
  for (const c of analyse(src)) {
    parts.push(c.out);
    if (c.kind) counts[COUNT_KEY[c.kind]]++;
  }
  const out = parts.join('');
  return { text: out, changed: out !== src, counts };
}

export const forDetector = (text) => cleanText(text).text.normalize('NFKC');

export const auditText = (text) => analyse(text).filter((c) => c.kind)
  .map((c) => ({ index: c.i, char: c.ch, code: c.cp, kind: c.kind }));
