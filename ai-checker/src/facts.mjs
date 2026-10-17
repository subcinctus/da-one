// Facts a rewrite must keep: amounts, percentages, dates, fiscal periods, acronyms, names,
// negations and modal verbs. Numbers get a value-based canon so that equivalent spellings match:
// ₹1,00,000 = Rs 100000 = INR 1 lakh → inr:100000, FY24 = FY2023-24 → fy:2024. No DOM access.
import { words, paragraphs } from './text.mjs';

const HS = '[ \\u00a0\\u202f]';
const SP = `${HS}*`;
const NL = '(?![\\p{L}])';
const END = '(?![\\p{L}\\p{N}])';
const SENT = '\u0001'; // stands in for characters an earlier pass has claimed

const isAlnum = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const isLetter = (c) => !!c && /\p{L}/u.test(c);
const fmt = (v) => String(Number(v.toPrecision(15))); // 0.07 * 1e7 → "700000", not 700000.0000000001
const pad = (n) => String(n).padStart(2, '0');
const year2 = (yy) => (+yy >= 70 ? 1900 : 2000) + +yy;
const R = (src, flags = 'giu') => new RegExp(src, flags);
const N = (...canons) => (canons.every(Boolean) ? { nums: canons } : null);

// ---------- dates ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const ORD = '(?:st|nd|rd|th)?';
// lower-case "may" and "march" are ordinary words, so a month must be capitalised
const monthOf = (s) => (/^\p{Lu}/u.test(s) ? MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1 : 0);
const yearOf = (y4, ...y2) => (y4 ? +y4 : year2(y2.find(Boolean)));
function validDate(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return mo >= 1 && mo <= 12 && d >= 1 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const ymd = (y, mo, d) => (validDate(y, mo, d) ? `date:${y}-${pad(mo)}-${pad(d)}` : null);
const ym = (y, mo) => (mo ? `date:${y}-${pad(mo)}` : null);
const md = (mo, d) => (validDate(2024, mo, d) ? `date:--${pad(mo)}-${pad(d)}` : null);

// ---------- fiscal years ----------
function fyFacts(m) {
  const a = m[1].length === 2 ? year2(m[1]) : +m[1];
  if (!m[3]) return N(`fy:${a}`);
  let b = +m[3];
  if (m[3].length === 2) { b += a - (a % 100); if (b < a) b += 100; }
  // FY2023-24 is one year (ending March 2024); FY24-FY25 or FY22-25 are two
  return !m[2] && b === a + 1 ? N(`fy:${b}`) : N(`fy:${a}`, `fy:${b}`);
}

// ---------- numbers ----------
const CURS = new Map([['₹', 'inr'], ['₨', 'inr'], ['rs', 'inr'], ['re', 'inr'], ['inr', 'inr'], ['rupee', 'inr'], ['rupees', 'inr'],
  ['us$', 'usd'], ['usd', 'usd'], ['$', 'usd'], ['dollar', 'usd'], ['dollars', 'usd'],
  ['€', 'eur'], ['eur', 'eur'], ['euro', 'eur'], ['euros', 'eur'], ['£', 'gbp'], ['gbp', 'gbp']]);
const SCALE = new Map([['hundred', 1e2], ['hundreds', 1e2], ['thousand', 1e3], ['thousands', 1e3], ['k', 1e3],
  ['lakh', 1e5], ['lakhs', 1e5], ['lac', 1e5], ['lacs', 1e5], ['crore', 1e7], ['crores', 1e7], ['cr', 1e7], ['crs', 1e7],
  ['million', 1e6], ['millions', 1e6], ['mn', 1e6], ['mln', 1e6], ['billion', 1e9], ['billions', 1e9], ['bn', 1e9],
  ['trillion', 1e12], ['trillions', 1e12], ['tn', 1e12]]);
const WORD_VAL = new Map('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
  .split(' ').map((w, i) => [w, i]).concat('twenty thirty forty fifty sixty seventy eighty ninety'.split(' ').map((w, i) => [w, 20 + 10 * i])));

const CUR = '₹|₨|rupees?|rs\\.?|re\\.?|inr|us\\$|usd|\\$|€|eur|£|gbp';
// Indian (1,00,00,000) or Western (10,000,000) grouping; anything else ("1,2,3") is a list
const DIG = '\\d{1,3}(?:,\\d{2,3}){0,7},\\d{3}(?!\\d)(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const W1 = 'one|two|three|four|five|six|seven|eight|nine';
const W99 = `(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:${W1})${NL})?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|zero|${W1})`;
const WORDS = `${W99}(?:${HS}+hundred(?:(?:${HS}+and)?${HS}+${W99})?)?`
  + `|an?(?=${HS}+(?:lakhs?|lacs?|crores?|hundred|thousand|million|billion|trillion)${NL})`; // a lakh, a crore
const UNIT = ['%', `per[ -]?cent${NL}`, `percent${NL}`, `pct${NL}`, 'p\\.c\\.', `pc${NL}`,
  `percentage[ -]points?${NL}`, `ppts?${NL}`, `pp${NL}`, `bps${NL}`, `bp${NL}`, `basis[ -]points?${NL}`,
  `[x×]${END}`,
  `(?:lakhs?|lacs?|hundreds?|thousands?)[ \\u00a0\\u202f-]+(?:crores?|crs?)${NL}`,
  `(?:lakhs?|lacs?|crores?|crs?|hundreds?|thousands?|millions?|mn|mln|billions?|bn|trillions?|tn|mm|[klmb])${NL}`,
  `(?:st|nd|rd|th)${NL}`, `['’]?s${NL}`].join('|');
// groups: 1 currency, 2 sign, 3 digits, 4 number words, 5 range end, 6 space or hyphen ("₹500-crore"), 7 unit,
// 8 currency word
const NUM_RE = R(`(?:(${CUR})${SP})?([-−](?=\\d))?(?:(${DIG})|(${WORDS}))`
  + `(?:(?:${SP}[-–]${SP}|${HS}+to${HS}+)(${DIG}))?(-(?=\\p{L})|${SP})(${UNIT})?(?:${SP}(rupees?|dollars?|euros?|inr|usd|eur)${NL})?`, 'dgiu');

function wordValue(w) {
  if (/^an?$/i.test(w)) return 1;
  let v = 0;
  for (const t of w.toLowerCase().split(/[\s-]+/)) {
    if (t === 'hundred') v = (v || 1) * 100;
    else if (t !== 'and') v += WORD_VAL.get(t);
  }
  return v;
}

// {k, mult} for a unit, or null when it is not one here ("5 x 4", "5 m" without a currency, …)
function unitOf(u, attached, cur, digits, next) {
  if (!u) return null;
  const l = u.toLowerCase();
  if (l === '%' || /^(per[ -]?cent|percent|pct|p\.c\.|pc)$/.test(l)) return { k: 'pct' };
  if (/^(percentage[ -]points?|ppts?|pp)$/.test(l)) return { k: 'pp' };
  if (/^(bps|bp|basis[ -]points?)$/.test(l)) return { k: 'bps' };
  // 3x, 2nd, 5L, 10k touch the number; with a currency "₹25 L" is 25 lakh too (but not "Rs 50 L&T")
  const spacedMoney = cur && /^[LKMB]$/.test(u) && !/[&'’\p{N}]/u.test(next || '');
  if (!attached && l.length <= 2 && !/^(cr|mn|bn|tn)$/.test(l) && !spacedMoney) return null;
  if (/^[x×]$/.test(l)) return digits ? { k: 'x' } : null;
  if (/^(st|nd|rd|th)$/.test(l)) return digits ? { k: 'ord' } : null;
  if (/^['’]?s$/.test(l)) return digits ? { k: 'n', mult: 1 } : null; // 1990s
  const parts = l.split(/[ \u00a0\u202f-]+/);
  if (parts.length === 2) return { k: 'n', mult: SCALE.get(parts[0]) * SCALE.get(parts[1]) }; // 1.5 lakh crore
  if (/^(l|m|mm|b)$/.test(l)) {
    if (u !== u.toUpperCase() && !cur) return null; // 5l, 5m, 5b are litres, metres, … unless it is money
    return { k: 'n', mult: l === 'l' ? 1e5 : l === 'b' ? 1e9 : 1e6 };
  }
  return SCALE.has(l) ? { k: 'n', mult: SCALE.get(l) } : null;
}

function numFacts(m, work, text) {
  const ix = m.indices, cur = m[1], wd = m[4];
  let start = (ix[1] || ix[2] || ix[3] || ix[4])[0], sign = !!m[2];
  // a minus sign follows a space or an opening bracket; "COVID-19" and "5%-6%" have hyphens
  if (sign && !/[\s([{"'“‘=:]/.test(work[ix[2][0] - 1] || ' ')) { sign = false; if (!cur) start++; }
  if (isAlnum(work[start - 1])) return null; // B2B, G20, "are 5"
  const after = work.slice(ix[4] ? ix[4][1] : 0);
  if (wd && (isLetter(after[0]) || /^-(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)/i.test(after))) return null;
  const unit = unitOf(m[7], !m[6], cur, !!m[3], m[7] && work[ix[7][1]]);
  if (wd && /^(?:one|an?)$/i.test(wd) && !unit) return null; // "one of the", "no one"
  // "half a lakh" is 50,000, not a lakh
  const half = /^an?$/i.test(wd || '') && !cur && /(?:^|[^\p{L}\p{N}])half[ \u00a0]+$/iu.test(work.slice(Math.max(0, start - 8), start));
  if (half) start = work.slice(0, start).search(/half[ \u00a0]+$/i);
  let cls = cur ? CURS.get(cur.toLowerCase().replace(/\.$/, '')) : 'n';
  let end = unit ? ix[7][1] : (ix[5] || ix[3] || ix[4])[1];
  if (!cur && m[8] && (!unit || unit.k === 'n')) { cls = CURS.get(m[8].toLowerCase()); end = ix[8][1]; }
  const canon = (v) => {
    switch (unit && unit.k) {
      case 'pct': return `pct:${fmt(v)}`;
      case 'pp': return `bps:${fmt(v * 100)}`;
      case 'bps': return `bps:${fmt(v)}`;
      case 'x': return `x:${fmt(v)}`;
      case 'ord': return `ord:${fmt(v)}`;
      default: return `${cls}:${fmt(v * ((unit && unit.mult) || 1))}`;
    }
  };
  const value = (s) => parseFloat(s.replace(/,/g, ''));
  // "in 2024 – 12% higher": a spaced dash after a year separates two facts, it is not a range
  if (m[5] && !cur && /^(?:19|20)\d\d$/.test(m[3] || '') && unit && unit.k !== 'n' && /\s/.test(work.slice(ix[3][1], ix[5][0]))) {
    return { start, end: ix[3][1], nums: [`n:${sign ? '-' : ''}${m[3]}`] };
  }
  const first = (m[3] ? value(m[3]) : wordValue(wd)) * (sign ? -1 : 1) * (half ? 0.5 : 1);
  return { start, end, nums: m[5] ? [canon(first), canon(value(m[5]))] : [canon(first)] };
}

// ---------- passes, in order; each claims its text so later passes cannot count it again ----------
const TIER_N = '(?:\\d|iv|i{1,3}|one|two|three|four)';
const TIER_AMT = `(?!${SP}(?:%|per[ -]?cent|percent|pc|pct|lakhs?|lacs?|crores?|crs?|mn|millions?|bn|billions?|thousands?|bps|basis|x)(?![\\p{L}]))`;
const TIER_RE = R(`tier[ \\u00a0-]?${TIER_N}(?:${SP}(?:,|/|&|and|or|to|-|–)${SP}(?:tier[ \\u00a0-]?${TIER_N}|\\d${TIER_AMT})(?![\\p{L}\\p{N}]|[.,]\\d))*(?![\\p{L}\\p{N}]|[.,]\\d)`);
const TIER_VAL = new Map([['i', 1], ['ii', 2], ['iii', 3], ['iv', 4], ['one', 1], ['two', 2], ['three', 3], ['four', 4]]);

const PASSES = [
  // list markers ("1." or "(2)") are not facts
  [/^[ \t]*\(?\d{1,2}[.)](?=[ \t])/gmu, () => ({})],
  // inline "(1) … (2) …" or "1) … 2) …" only next to a neighbour: "branches (12) opened" keeps its number
  [/\(?(\d{1,2})\)(?=[ \t])/gu, (m, w, text) => {
    const has = (k) => k > 0 && new RegExp(`(?:^|\\D)${k}\\)`).test(text);
    return has(+m[1] - 1) || has(+m[1] + 1) ? {} : null;
  }],
  // "Tier 2", "tier-II", "Tier 2 and 3" are terms, not numbers
  [TIER_RE, (m) => ({ terms: [...m[0].matchAll(/(?:tier[ \u00a0-]?)?(\d|iv|i{1,3}|one|two|three|four)(?![\p{L}])/giu)]
    .map((t) => `Tier ${TIER_VAL.get(t[1].toLowerCase()) || t[1]}`) })],
  [/(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}])/gu, (m) => N(ymd(+m[1], +m[2], +m[3]))],
  [/(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\p{L}\p{N}])/gu, (m) => {
    let d = +m[1], mo = +m[3];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // dd/mm as written in India; mm/dd only when dd/mm is impossible
    return N(ymd(m[4].length === 2 ? year2(m[4]) : +m[4], mo, d));
  }],
  [R(`(\\d{1,2})${ORD}(?:${HS}+of)?[ \\u00a0-]+${MON},?(?:[ \\u00a0-]+(\\d{4})|-(\\d{2})|${SP}['’](\\d{2}))${END}`),
    (m) => N(ymd(yearOf(m[3], m[4], m[5]), monthOf(m[2]), +m[1]))],
  [R(`${MON}${HS}+(\\d{1,2})${ORD},?${HS}+(\\d{4})${END}`), (m) => N(ymd(+m[3], monthOf(m[1]), +m[2]))],
  [R(`${MON},?(?:[ \\u00a0-]+(\\d{4})|-(\\d{2})|${SP}['’]${SP}(\\d{2}))${END}`), (m) => N(ym(yearOf(m[2], m[3], m[4]), monthOf(m[1])))],
  [R(`(\\d{1,2})${ORD}(?:${HS}+of)?[ \\u00a0-]+${MON}${NL}`), (m) => N(md(monthOf(m[2]), +m[1]))],
  [R(`${MON}${HS}+(\\d{1,2})${ORD}${END}`), (m) => N(md(monthOf(m[1]), +m[2]))],
  // Q1, 1Q, H2, 9M, also glued to a fiscal year (Q1FY24)
  [/(?:([QH])([1-4])|([1-4])([QH]))(?=[ \u00a0'’-]?FY|[^\p{L}\p{N}]|$)/gu, (m) => {
    const p = m[1] || m[4], n = +(m[2] || m[3]);
    return p === 'H' && n > 2 ? null : N(`${p.toLowerCase()}:${n}`);
  }],
  [/(\d{1,2})M(?=[ \u00a0]?FY)/gu, (m) => N(`months:${+m[1]}`)],
  [/(?:F\.?Y\.?|financial year|fiscal year|fiscal)[ \u00a0'’-]*(\d{4}|\d{2})(?:[ \u00a0]?[-–—/][ \u00a0]?(FY[ \u00a0'’]?)?(\d{4}|\d{2})(?![\p{N}]|[ \u00a0]*(?:%|per[ -]?cent|percent|pc(?![\p{L}])|bps|x(?![\p{L}]))))?(?![\p{L}\p{N}])/giu, fyFacts],
  [/CY[ \u00a0'’]?(\d{4}|\d{2})(?![\p{L}\p{N}])/gu, (m) => N(`cy:${m[1].length === 2 ? year2(m[1]) : +m[1]}`)],
  // a bare "2023-24" is the fiscal year in Indian usage
  [/(\d{4})[ \u00a0]?[-–—/][ \u00a0]?(\d{4}|\d{2})(?![\p{L}\p{N}]|[ \u00a0]*(?:%|per[ -]?cent|percent|pc(?![\p{L}])|bps|x(?![\p{L}])))/gu, (m) => {
    const a = +m[1];
    let b = +m[2];
    if (m[2].length === 2) { b += a - (a % 100); if (b < a) b += 100; }
    return a >= 1900 && a < 2100 && b === a + 1 ? N(`fy:${b}`) : null;
  }],
];

// ---------- words: terms, negations, modals ----------
const NEG = new Set(['not', 'no', 'never', 'without', 'none', 'nor', 'cannot', 'neither', 'nothing', 'nobody', 'nowhere']);
const MODAL = new Set(['may', 'might', 'will', 'would', 'must', 'should', 'could', 'can', 'shall']);
const NT_MODAL = new Map([['ca', 'can'], ['wo', 'will'], ['sha', 'shall'], ['could', 'could'], ['would', 'would'],
  ['should', 'should'], ['must', 'must'], ['might', 'might'], ['may', 'may']]);
// contractions typed without the apostrophe
const BARE_NT = new Map([['dont', ''], ['doesnt', ''], ['didnt', ''], ['isnt', ''], ['arent', ''], ['wasnt', ''],
  ['werent', ''], ['hasnt', ''], ['havent', ''], ['hadnt', ''], ['neednt', ''], ['aint', ''], ['cant', 'can'],
  ['wont', 'will'], ['shant', 'shall'], ['couldnt', 'could'], ['wouldnt', 'would'], ['shouldnt', 'should'],
  ['mustnt', 'must'], ['mightnt', 'might']]);
const STOP = new Set(("the a an this that these those it its we our ours us you your yours they their theirs them he she "
  + "his her hers him i me my mine i'm i've i'll i'd in on at for with by from to of into onto over under about after "
  + 'before during since until upon within across through and but or so yet as if when while where whereas whether '
  + 'what which who whom whose why how however moreover furthermore additionally also thus hence therefore then there '
  + 'here yes please dear hi hello thanks thank regards sincerely sir madam all each every some any many most more '
  + 'much few both either other another such first second third fourth fifth next last finally lastly overall '
  + 'ultimately one mr mrs ms dr shri smt sri').split(' '));
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’&][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
const ABBR_RE = /(?:^|[^\p{L}])(?:e\.g|i\.e|vs|viz|cf|approx|mr|mrs|ms|dr|rs|re|no|nos|st|sr|jr|shri|smt|prof|govt|dept|pvt|co|inc|corp|\p{Lu})\.$/iu;

// A colon after a short label ("Note: Growth was fine") starts a sentence, unless a list of names
// follows ("Markets: Pune and Nashik"); after a clause ("three states: Maharashtra, …") it never does.
function afterLabel(text, j, e) {
  const head = text.slice(Math.max(0, j - 80), j).split(/[.!?;\n]/).pop();
  if ((head.match(/[\p{L}\p{N}]+/gu) || []).length > 4) return false;
  return !/^[ \u00a0]*(?:[,/&;)]|(?:and|or)[ \u00a0]|\.?[ \u00a0]*(?:\n|$))/.test(text.slice(e, e + 6));
}

// Does the word at i start a sentence, a line, a list item or a clause after a colon?
function isInitial(text, i, e = i) {
  let j = i - 1;
  while (j >= 0 && /[\s"'“”‘’([*•#>\-–—]/.test(text[j])) { if (text[j] === '\n') return true; j--; }
  if (j < 0) return true;
  const c = text[j];
  if (c === '!' || c === '?') return true;
  if (c === ':') return afterLabel(text, j, e);
  if (c === '.') return !ABBR_RE.test(text.slice(Math.max(0, j - 8), j + 1));
  if (c === ')') return /(?:^|\s)\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})\)$/i.test(text.slice(Math.max(0, j - 7), j + 1));
  return false;
}

function negModal(word) {
  const low = word.replace(/'ve$/, ''); // should've, could've
  if (low.endsWith("n't")) return ["n't", NT_MODAL.get(low.slice(0, -3)) || null];
  if (BARE_NT.has(low)) return ["n't", BARE_NT.get(low) || null];
  if (low === 'cannot') return ['cannot', 'can'];
  if (NEG.has(low)) return [low, null];
  if (low.endsWith("'ll")) return [null, 'will'];
  if (low.endsWith("'d")) return [null, 'would'];
  return [null, MODAL.has(low) ? low : null];
}

// "not just X but Y" adds rather than negates; rewriting that formula away must not count as a lost negation
function isAdditive(text, e) {
  const rest = text.slice(e, e + 240);
  if (!/^\s+(?:just|only|merely|simply|solely)\b/i.test(rest)) return false;
  const m = rest.split(/[.!?](?:\s|$)|\n/)[0].match(/^([\s\S]*?)\b(?:but|also|rather|instead|it is|it['’]s)\b/i);
  return !!m && !/\bany(?:one|body|thing)?\b/i.test(m[1]); // "not just anyone" still negates
}

function termOf(t) {
  const k = t.replace(/['’]s$/u, '');
  if (!/^\p{L}/u.test(k)) return null;
  const caps = (k.match(/\p{Lu}/gu) || []).length, low = k.toLowerCase().replace(/’/g, "'");
  // negations, modals and contractions (shouted NOT, sentence-initial Don't, We'll) are not names
  if (NEG.has(low) || BARE_NT.has(low) || /n't$|'(?:ll|d|re|ve|m)$/.test(low) || (MODAL.has(low) && t !== 'May')) return null;
  if (caps >= 2) return { key: k.replace(/(\p{Lu})s$/u, '$1'), acro: true }; // DSAs → DSA
  if (caps === 1 && /\p{N}/u.test(k)) return { key: k, acro: true }; // G20, Covid19
  if (caps === 1 && /^\p{Lu}/u.test(k) && k.length > 1 && !STOP.has(low)) return { key: k, acro: false };
  return null;
}

const inc = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);

function scanText(input, { allNames = false } = {}) {
  const text = String(input ?? '').normalize('NFC'); // a decomposed "Société" is the same name
  const nums = new Map(), tokens = [], negations = new Map(), modals = new Map();
  const addNum = (canon, raw) => {
    const f = nums.get(canon);
    if (f) { f.raw.push(raw); f.count++; } else nums.set(canon, { raw: [raw], count: 1 });
  };
  let work = text;
  for (const [re, fn] of [...PASSES, [NUM_RE, numFacts]]) {
    const claims = [];
    re.lastIndex = 0;
    for (let m; (m = re.exec(work));) {
      const r = m[0] && (fn === numFacts || !isAlnum(work[m.index - 1])) ? fn(m, work, text) : null;
      if (!r) { re.lastIndex = m.index + 1; continue; }
      const a = r.start ?? m.index, b = r.end ?? m.index + m[0].length;
      const raw = text.slice(a, b).trim();
      for (const c of r.nums || []) addNum(c, raw);
      for (const key of r.terms || []) tokens.push({ key, acro: true, initial: false });
      claims.push([a, b]);
      re.lastIndex = Math.max(b, m.index + 1);
    }
    if (claims.length) {
      const arr = work.split('');
      for (const [a, b] of claims) arr.fill(SENT, a, b);
      work = arr.join('');
    }
  }
  for (const m of text.matchAll(TOKEN_RE)) {
    const s = m.index, e = s + m[0].length, t = m[0];
    if (work.slice(s, e).includes(SENT)) continue;
    const low = t.toLowerCase().replace(/’/g, "'"), initial = isInitial(text, s, e);
    let [neg, modal] = negModal(low);
    if (neg === 'no' && /^\.[ \u00a0]?(?:\d|#|of(?![\p{L}]))/u.test(text.slice(e, e + 5))) neg = null; // "No. 5", "No. of"
    if ((neg === 'not' || neg === "n't") && isAdditive(text, e)) neg = null;
    // capitalised "May" is the month unless it opens a question ("May we …")
    if (modal === 'may' && t === 'May' && !(initial && /^\s+(?:i|we|you|they|he|she|it)\b/i.test(text.slice(e, e + 8)))) modal = null;
    if (neg) inc(negations, neg);
    if (modal) inc(modals, modal);
    const term = modal === 'may' ? null : termOf(t);
    if (term) tokens.push({ ...term, initial: allNames ? false : initial });
  }
  return { nums, tokens, negations, modals };
}

// Names are capitalised words seen mid-sentence; once known, sentence-initial uses count too,
// so moving "Pune" to the start of a sentence does not lose it.
const nameVocab = (...lists) => new Set(lists.flat().filter((t) => !t.acro && !t.initial).map((t) => t.key));
function countTerms(tokens, vocab) {
  const out = new Map();
  for (const t of tokens) if (t.acro || !t.initial || vocab.has(t.key)) inc(out, t.key);
  return out;
}
const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);

export function extractFacts(text) {
  const f = scanText(text);
  return { nums: f.nums, terms: countTerms(f.tokens, nameVocab(f.tokens)), negations: f.negations, modals: f.modals };
}

// Facts the author supplied (Interview mode) that a rewrite may add.
function allowance(list) {
  const a = { nums: new Set(), terms: new Set(), negations: 0, modals: new Map() };
  for (const s of [].concat(list ?? [])) {
    const f = scanText(s, { allNames: true });
    for (const k of f.nums.keys()) a.nums.add(k);
    for (const t of f.tokens) a.terms.add(t.key);
    a.negations += total(f.negations);
    for (const [w, n] of f.modals) inc(a.modals, w, n);
  }
  return a;
}

// Multiset difference: one raw spelling per occurrence of `a` that `b` lacks.
function numDiff(a, b, skip) {
  const out = [];
  for (const [k, f] of a) {
    const g = b.get(k), n = f.count - (g ? g.count : 0);
    if (n <= 0 || skip.has(k)) continue;
    const rest = [...f.raw];
    for (const r of g ? g.raw : []) { const i = rest.indexOf(r); if (i >= 0) rest.splice(i, 1); }
    out.push(...rest.slice(0, n));
  }
  return out;
}
function termDiff(a, b, skip) {
  const out = [];
  for (const [k, n] of a) {
    const d = n - (b.get(k) || 0);
    if (d > 0 && !skip.has(k)) for (let i = 0; i < d; i++) out.push(k);
  }
  return out;
}

function compare(before, after, opts) {
  const tb = String(before ?? ''), ta = String(after ?? '');
  const A = scanText(tb), B = scanText(ta), ok = allowance(opts && opts.allow), none = new Set();
  const vocab = nameVocab(A.tokens, B.tokens);
  const termsA = countTerms(A.tokens, vocab), termsB = countTerms(B.tokens, vocab);
  const missingNums = numDiff(A.nums, B.nums, none), addedNums = numDiff(B.nums, A.nums, ok.nums);
  const missingTerms = termDiff(termsA, termsB, none), addedTerms = termDiff(termsB, termsA, ok.terms);
  const nb = total(A.negations), na = total(B.negations);
  const negOk = na === nb || (na > nb && na - nb <= ok.negations);
  const changed = [];
  for (const w of new Set([...A.modals.keys(), ...B.modals.keys()])) {
    const x = A.modals.get(w) || 0, y = B.modals.get(w) || 0;
    if (x !== y && !(y > x && y - x <= (ok.modals.get(w) || 0))) changed.push({ word: w, before: x, after: y });
  }
  const result = {
    ok: !missingNums.length && !addedNums.length && !missingTerms.length && !addedTerms.length && negOk && !changed.length,
    missingNums, addedNums, missingTerms, addedTerms,
    negations: { before: nb, after: na, ok: negOk },
    modals: { changed },
    parasBefore: paragraphs(tb), parasAfter: paragraphs(ta), wordsBefore: words(tb), wordsAfter: words(ta),
  };
  return { result, termsAfter: termsB };
}

export function compareFacts(before, after, opts = {}) {
  return compare(before, after, opts).result;
}

// The review dialog's shape. Numbers stay multiset (two 1.5% are usually two facts) but are listed
// once; a name counts as missing only when the rewrite drops it altogether, as before.
export function factCheck(before, after) {
  const { result: c, termsAfter } = compare(before, after, {});
  const uniq = (a) => [...new Set(a)];
  return {
    missingNums: uniq(c.missingNums), addedNums: uniq(c.addedNums),
    missingTerms: uniq(c.missingTerms).filter((t) => !termsAfter.has(t)),
    parasBefore: c.parasBefore, parasAfter: c.parasAfter, wordsBefore: c.wordsBefore, wordsAfter: c.wordsAfter,
  };
}
