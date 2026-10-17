import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, forDetector, auditText } from '../../ai-checker/src/normalize.mjs';
import { LOOKALIKES, TR39_VERSION } from '../../ai-checker/src/confusables-data.mjs';

// Lookalikes and invisible characters are written as \u{...} escapes so the source stays readable.
const clean = (s) => cleanText(s).text;
const ZERO = { invisible: 0, lookalike: 0, fullwidth: 0, spaces: 0 };
const unchanged = (s) => {
  const r = cleanText(s);
  assert.equal(r.text, s);
  assert.equal(r.changed, false);
  assert.deepEqual(r.counts, ZERO);
  assert.deepEqual(auditText(s), []);
};

// ---------- lookalikes ----------

test('Greek Eta and Cyrillic letters inside Latin words become Latin', () => {
  const s = '\u{397}\u{435}ll\u{43E} w\u{43E}rld'; // "Ηеllо wоrld"
  const r = cleanText(s);
  assert.equal(r.text, 'Hello world');
  assert.equal(r.changed, true);
  assert.deepEqual(r.counts, { ...ZERO, lookalike: 4 });
});

test('common Cyrillic and Greek lookalikes map inside mixed words', () => {
  const cases = [
    ['\u{430}pple', 'apple'], ['r\u{435}port', 'report'], ['l\u{43E}an', 'loan'], ['\u{440}ay', 'pay'],
    ['\u{441}redit', 'credit'], ['\u{443}ield', 'yield'], ['ta\u{445}', 'tax'], ['\u{456}ncome', 'income'],
    ['\u{458}oin', 'join'], ['ri\u{455}k', 'risk'], ['\u{501}ebt', 'debt'], ['\u{4BB}ome', 'home'],
    ['\u{410}sset', 'Asset'], ['\u{412}ank', 'Bank'], ['\u{415}MI', 'EMI'], ['\u{41A}YC', 'KYC'],
    ['\u{41C}SME', 'MSME'], ['\u{41D}FC', 'HFC'], ['\u{41E}K', 'OK'], ['\u{420}SL', 'PSL'],
    ['\u{421}ASA', 'CASA'], ['\u{422}ier', 'Tier'], ['\u{425}IRR', 'XIRR'],
    ['\u{391}UM', 'AUM'], ['\u{392}SE', 'BSE'], ['\u{395}BITDA', 'EBITDA'], ['\u{396}one', 'Zone'],
    ['\u{397}FC', 'HFC'], ['\u{39A}PI', 'KPI'], ['\u{39C}D', 'MD'], ['\u{39D}BFC', 'NBFC'],
    ['\u{39F}D', 'OD'], ['\u{3A1}AT', 'PAT'], ['\u{3A4}ier', 'Tier'], ['\u{3A5}ield', 'Yield'],
    ['\u{3A7}IRR', 'XIRR'], ['l\u{3BF}an', 'loan'], ['in\u{3BD}est', 'invest'],
  ];
  for (const [inp, want] of cases) assert.equal(clean(inp), want, inp);
});

test('capital-I lookalikes get the right case for I versus l', () => {
  assert.equal(clean('he\u{399}\u{399}o'), 'hello'); // Greek capital iota used for l
  assert.equal(clean('\u{399}NDIA'), 'INDIA');
  assert.equal(clean('\u{406}t is'), 'It is');
  assert.equal(clean('A\u{4C0}ex'), 'Alex');
  assert.equal(clean('\u{4CF}oan book'), 'loan book');
  assert.equal(clean('\u{391}\u{399} tools are used in lending'), 'AI tools are used in lending');
  assert.equal(clean('\u{A4F2} think so, said the lender'), 'I think so, said the lender'); // Lisu I
});

test('words made only of strict lookalikes are mapped in mostly Latin text', () => {
  const s = 'The loan was approved by the credit committee in \u{41C}\u{430}\u{443} for \u{420}2\u{420} lending to small borrowers.';
  assert.equal(clean(s), 'The loan was approved by the credit committee in May for P2P lending to small borrowers.');
  // the article "a" written with Cyrillic а
  assert.equal(clean('We gave \u{430} loan of Rs 5 lakh to the borrower in the last quarter.'),
    'We gave a loan of Rs 5 lakh to the borrower in the last quarter.');
  assert.equal(clean('Net \u{420}\u{410}\u{422} rose to \u{20B9}12 crore in FY24 on strong loan growth.'),
    'Net PAT rose to \u{20B9}12 crore in FY24 on strong loan growth.');
});

test('whole-lookalike words stay when the text is not mostly Latin', () => {
  unchanged('\u{41C}\u{430}\u{443}'); // alone: no Latin context
  unchanged('\u{41D}\u{415} \u{412}\u{421}\u{415}'); // НЕ ВСЕ
  unchanged('\u{420}\u{410}\u{422} of 12 crore'); // 3 of 10 letters non-Latin: below 80%
});

test('Russian, Greek and Hindi sentences are unchanged', () => {
  unchanged('Мы выдали кредит на сумму 5 млн рублей. Он сказал: а то, о чём ВСЕ знают.');
  unchanged('ООО «Ромашка» получило кредит в 2024 году; срок — 5 лет, ставка 12%.');
  unchanged('Η Ελλάδα είναι όμορφη χώρα. Ο ΟΤΕ και η ΕΕ.');
  unchanged('हमने वित्त वर्ष 2023-24 में ₹1,200 करोड़ के ऋण वितरित किए। ग्राहकों की संख्या १२,००० रही।');
  unchanged('আমরা ঋণ দিয়েছি। நாங்கள் கடன் வழங்கினோம். ہم نے قرض دیا۔');
});

test('a Russian phrase quoted inside English text stays Russian', () => {
  unchanged('The borrower wrote «а также ООО Ромашка» in the form, and the loan was approved after a review by the credit committee of the company today.');
  unchanged('The client, a Moscow firm called ВСЕ Ромашка, repaid the full amount of the loan before the due date this year.');
});

test('genuine non-Latin words with a Latin lookalike inside stay', () => {
  unchanged('M\u{43E}\u{441}\u{43A}\u{432}\u{430}'); // Latin M + "осква": к and в are not lookalikes
  unchanged('NBFCкредит');
});

test('Greek letters used as symbols are not mapped', () => {
  unchanged('Portfolio β is 1.2, ρ = 0.8, α of 2%, σ of 3%, γ and ν are small; σx and ρxy are notation.');
  unchanged('μg, Ω, Δ NII, π and λ stay.');
});

test('loose lookalikes map only inside longer mixed words', () => {
  assert.equal(clean('\u{3C1}\u{3B1}yment'), 'payment');
  assert.equal(clean('\u{3B1}pproval'), 'approval');
  unchanged('\u{3B1}b'); // short, notation-like
});

test('Latin-extended lookalikes, styled math letters and exclusions', () => {
  assert.equal(clean('\u{251}pproved'), 'approved');
  assert.equal(clean('\u{261}rowth'), 'growth');
  assert.equal(clean('\u{1D401}\u{1D428}\u{1D425}\u{1D41D} text'), 'Bold text'); // math bold
  assert.equal(clean('\u{1D407}\u{1D41E}\u{1D425}\u{1D425}\u{1D428} \u{1D464}\u{1D45C}\u{1D45F}\u{1D459}\u{1D451}'), 'Hello world');
  assert.equal(clean('\u{212A}elvin'), 'Kelvin');
  unchanged('Kırıkkale and İstanbul'); // Turkish dotless i is a real letter
  unchanged('\u{1D04}\u{1D00}\u{1D18}\u{A731}'); // small caps outside the table block the word
  unchanged('þing ƒ 5 \u{2139}\u{FE0F} info');
  unchanged('Ærø, Łódź, Ñandú, São Paulo, Zürich, Straße, façade, naïve, Đà Nẵng');
});

test('Armenian, Cherokee, Lisu and Coptic lookalikes in Latin words', () => {
  assert.equal(clean('l\u{585}an'), 'loan'); // Armenian oh
  assert.equal(clean('\u{13AA}UM'), 'AUM'); // Cherokee A
  assert.equal(clean('\u{A4EE}SSET'), 'ASSET'); // Lisu A
  assert.equal(clean('l\u{2C9F}ans'), 'loans'); // Coptic o (loose, long word)
});

test('combining marks and digits stay attached to mapped words', () => {
  assert.equal(clean('caf\u{435}\u{301}'), 'cafe\u{301}');
  assert.equal(clean('F\u{3A5}24'), 'FY24');
});

// ---------- invisible, spaces, fullwidth ----------

test('zero-width, soft hyphen, BOM, word joiner and bidi controls are removed', () => {
  const s = '\u{FEFF}pay\u{200B}ment\u{AD} \u{200D}loan\u{200C} \u{202E}abc\u{202C} \u{2066}x\u{2069} \u{2060}y\u{200E}\u{200F}'
    + ' \u{202A}z\u{202B}\u{202D} \u{61C}w\u{2067}\u{2068} \u{2062}q\u{2064} \u{180E}r\u{FFF9}';
  const r = cleanText(s);
  assert.equal(r.text, 'payment loan abc x y z w q r');
  assert.deepEqual(r.counts, { ...ZERO, invisible: 22 });
});

test('invisible characters inside a lookalike word do not split it', () => {
  assert.equal(clean('\u{41D}\u{200B}\u{435}ll\u{200D}\u{43E}'), 'Hello');
});

test('NBSP, thin and other unusual spaces become a normal space; separators become newlines', () => {
  const s = 'Rs\u{A0}500\u{2009}crore\u{202F}%\u{3000}x\u{205F}y\u{2007}z\u{2000}a\u{200A}b\u{1680}c\u{2028}d\u{2029}e';
  const r = cleanText(s);
  assert.equal(r.text, 'Rs 500 crore % x y z a b c\nd\ne');
  assert.deepEqual(r.counts, { ...ZERO, spaces: 11 });
});

test('tabs, CR and LF stay; other control characters go', () => {
  unchanged('a\tb\r\nc\nd');
  assert.equal(clean('a\u{0}b\u{7}c\u{1B}d\u{7F}e\u{90}f'), 'abcdef');
  assert.equal(clean('line\u{B}break\u{C}page\u{85}next'), 'line\nbreak\npage\nnext');
});

test('fullwidth ASCII becomes ASCII', () => {
  const r = cleanText('ＡＢＣ１２３');
  assert.equal(r.text, 'ABC123');
  assert.deepEqual(r.counts, { ...ZERO, fullwidth: 6 });
  assert.equal(clean('ＧＮＰＡ ｏｆ １．５％ ｉｎ ＦＹ２４！'), 'GNPA of 1.5% in FY24!');
  assert.equal(clean('Ｒｓ ５，００，０００ （approx）'), 'Rs 5,00,000 (approx)');
});

test('fullwidth punctuation inside Chinese or Japanese text stays', () => {
  unchanged('你好，世界！東京（とうきょう）。');
  assert.equal(clean('ＡＢＣ株式会社'), 'ABC株式会社'); // letters always map
  assert.equal(clean('Done！ 東京'), 'Done! 東京');
});

test('emoji sequences, keycaps and flags survive', () => {
  unchanged('Team \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{1F3F3}\u{FE0F}\u{200D}\u{1F308} \u{1F469}\u{1F3FD}\u{200D}\u{1F4BB} \u{2764}\u{FE0F}\u{200D}\u{1F525} 1\u{FE0F}\u{20E3} #\u{FE0F}\u{20E3}'
    + ' \u{A9}\u{FE0F} \u{2122}\u{FE0F} \u{2764}\u{FE0F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{1F1EE}\u{1F1F3} done');
});

test('joiners stay inside Indic and Arabic-script words', () => {
  unchanged('\u{915}\u{94D}\u{200D}\u{937} \u{915}\u{94D}\u{200C}\u{937}'); // Devanagari with ZWJ and ZWNJ
  unchanged('\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}'); // Persian with ZWNJ
});

test('hidden data tricks are removed', () => {
  assert.equal(clean('hi\u{E0041}\u{E0042}\u{E007F} there'), 'hi there'); // tag characters
  assert.equal(clean('pay\u{FE0F}ment ok\u{FE00}\u{FE01}'), 'payment ok'); // selectors after letters
  assert.equal(clean('\u{1F600}\u{FE0F}\u{FE0F}\u{E0100}\u{E0101}'), '\u{1F600}\u{FE0F}'); // selector runs
  assert.equal(clean('7\u{FE0F} days'), '7 days'); // a digit takes a selector only as a keycap
  assert.equal(clean('a\u{34F}b'), 'ab'); // grapheme joiner
  assert.equal(clean('x\u{3164}y \u{FFA0}'), 'xy '); // Hangul fillers
  assert.equal(clean('a\u{2800}b'), 'a b'); // braille blank
  unchanged('\u{6F22}\u{E0100}\u{5B57}'); // ideographic variation sequence
  unchanged('\u{D55C}\u{AE00}\u{3164}'); // filler next to Hangul
  unchanged('\u{600}\u{661}\u{662}'); // Arabic number sign is a visible format character
});

// ---------- things that must never change ----------

test('rupee, Indian grouping, punctuation, quotes, dashes, ellipses, superscripts and fractions are untouched', () => {
  unchanged('₹1,00,000 at 9.5% p.a. — m² ½ …');
  unchanged('“Quoted” and ‘single’ — en – dash ‒ ― ‐ ‑ … ² ³ ¹ ⁰ ⁿ ½ ¼ ¾ ⅓ ⅛ ° × ÷ ± ‰ © ® ™ • · ′ ″ § ¶ € £ $ ¥ ₹ % & @ # * ^ ~ ` | \\ / < > [ ] { } ( ) ! ? ; : , . \' " - _ = +');
  unchanged('GNPA fell 45 bps to 1.4% in FY2023-24; Rs 2,000 cr AUM; LTV 70%; INR 1.5 lakh; 1,00,00,000.');
  unchanged('Roman numerals Ⅰ Ⅱ Ⅴ Ⅹ ⅰ ⅴ stay; NFKC handles them for the detector only.');
});

test('protected characters stay even next to lookalikes', () => {
  assert.equal(clean('R\u{455}\u{A0}₹1,00,000 — 9.5% p.a. … ½ m²'), 'Rs ₹1,00,000 — 9.5% p.a. … ½ m²');
  for (const ch of '₹0123456789²½…—–“”‘’-.,%') {
    assert.equal(clean(`l\u{43E}an ${ch} r\u{435}port${ch}x`), `loan ${ch} report${ch}x`, ch);
  }
});

test('Indian digits and other-script digits are never mapped', () => {
  unchanged('०१२३ ০১২ ௦௧ ൦ ໐ ០ 1०'); // TR39 maps several of these zeros to "o"
  unchanged('l0an 10O'); // ASCII digits inside words stay digits
});

test('no-op and odd inputs', () => {
  assert.deepEqual(cleanText(''), { text: '', changed: false, counts: ZERO });
  assert.deepEqual(cleanText(null), { text: '', changed: false, counts: ZERO });
  assert.deepEqual(cleanText(undefined), { text: '', changed: false, counts: ZERO });
  assert.equal(clean(12345), '12345');
  unchanged('Plain ASCII text with numbers 1,00,000 and FY24.');
  assert.deepEqual(auditText(''), []);
  assert.equal(forDetector(''), '');
  assert.equal(clean('\u{D800}x'), '\u{D800}x'); // lone surrogate left alone
});

test('cleanText is idempotent', () => {
  const samples = [
    '\u{FEFF}\u{397}\u{435}ll\u{43E}\u{A0}w\u{43E}rld ＡＢＣ１２３ \u{200B}',
    'We gave \u{430} loan to \u{41C}\u{430}\u{443} borrowers; \u{1D401}\u{1D428}\u{1D425}\u{1D41D} \u{251}pproved.',
    'Мы выдали кредит. हमने ऋण दिया। 你好，世界',
  ];
  for (const s of samples) {
    const once = clean(s);
    assert.equal(clean(once), once);
    assert.equal(cleanText(once).changed, false);
  }
});

// ---------- auditText and counts ----------

test('auditText reports UTF-16 index, char, code point and kind', () => {
  assert.deepEqual(auditText('\u{200B}a\u{A0}Ｂ\u{435}x \u{1D407}ello'), [
    { index: 0, char: '\u{200B}', code: 0x200B, kind: 'invisible' },
    { index: 2, char: '\u{A0}', code: 0xA0, kind: 'space' },
    { index: 3, char: 'Ｂ', code: 0xFF22, kind: 'fullwidth' },
    { index: 4, char: '\u{435}', code: 0x435, kind: 'lookalike' },
    { index: 7, char: '\u{1D407}', code: 0x1D407, kind: 'lookalike' },
  ]);
  // an astral character before a hit shifts its index by two
  assert.deepEqual(auditText('\u{1F600}\u{A0}'), [{ index: 2, char: '\u{A0}', code: 0xA0, kind: 'space' }]);
  assert.deepEqual(auditText('\u{E0041}x'), [{ index: 0, char: '\u{E0041}', code: 0xE0041, kind: 'invisible' }]);
});

test('auditText indexes point at the reported characters', () => {
  const s = 'A\u{AD}b \u{397}\u{435}ll\u{43E} \u{1D401}\u{1D428}\u{1D425}\u{1D41D} ＡＢ\u{3000}\u{2028} \u{202E}\u{441}redit';
  const hits = auditText(s);
  assert.equal(hits.length, 14);
  for (const h of hits) {
    assert.equal(s.codePointAt(h.index), h.code);
    assert.equal(String.fromCodePoint(h.code), h.char);
  }
});

test('counts agree with auditText kinds', () => {
  const s = '\u{FEFF}\u{397}\u{435}ll\u{43E}\u{A0}w\u{43E}rld\u{2009}ＡＢＣ\u{200B}\u{200C} \u{1D401}\u{1D428}\u{1D425}\u{1D41D}\u{2029}';
  const r = cleanText(s);
  const hits = auditText(s);
  const by = (k) => hits.filter((h) => h.kind === k).length;
  assert.deepEqual(r.counts, { invisible: by('invisible'), lookalike: by('lookalike'), fullwidth: by('fullwidth'), spaces: by('space') });
  assert.deepEqual(r.counts, { invisible: 3, lookalike: 8, fullwidth: 3, spaces: 3 });
  assert.equal(r.text, 'Hello world ABC Bold\n');
});

// ---------- forDetector ----------

test('forDetector cleans then applies NFKC', () => {
  assert.equal(forDetector('\u{FB01}nance\u{A0}² ½ … \u{397}\u{435}ll\u{43E}'), 'finance 2 1\u{2044}2 ... Hello');
  assert.equal(forDetector('\u{200B}pay\u{AD}ment ＡＢＣ１２３ ™'), 'payment ABC123 TM');
  for (const s of ['Ⅻ ㎏ ﬃ ①', '₹1,00,000 — “x”', 'Мы выдали кредит.', '\u{397}\u{435}ll\u{43E}\u{A0}w\u{43E}rld']) {
    assert.equal(forDetector(s), cleanText(s).text.normalize('NFKC'));
  }
  assert.equal(forDetector('l\u{43E}an'), 'loan'); // NFKC alone would keep the Cyrillic о
  assert.equal(forDetector('₹ stays'), '₹ stays');
});

// ---------- confusables data ----------

test('confusables table: one non-ASCII letter to one ASCII letter, no duplicates', () => {
  assert.match(TR39_VERSION, /^\d+\.\d+\.\d+$/);
  const seen = new Map();
  for (const [sc, g] of Object.entries(LOOKALIKES)) {
    for (const kind of ['strict', 'loose']) {
      for (const pair of g[kind].split(' ').filter(Boolean)) {
        const cps = Array.from(pair);
        assert.equal(cps.length, 2, `${sc} ${pair}`);
        const [from, to] = cps;
        assert.match(to, /^[A-Za-z]$/, pair);
        assert.ok(from.codePointAt(0) > 0x7F, pair);
        assert.match(from, /^\p{L}$/u, pair);
        assert.doesNotMatch(from, /[\p{Lm}\p{N}\p{P}\p{S}\u{FF00}-\u{FFEF}]/u, pair);
        assert.ok(!seen.has(from), `duplicate ${pair}`);
        seen.set(from, to);
      }
    }
  }
  const must = [
    '\u{430}a', '\u{435}e', '\u{43E}o', '\u{440}p', '\u{441}c', '\u{443}y', '\u{445}x', '\u{456}i', '\u{458}j', '\u{455}s',
    '\u{501}d', '\u{4BB}h', '\u{4CF}l', '\u{410}A', '\u{412}B', '\u{415}E', '\u{41A}K', '\u{41C}M', '\u{41D}H', '\u{41E}O',
    '\u{420}P', '\u{421}C', '\u{422}T', '\u{425}X', '\u{406}I', '\u{408}J', '\u{405}S',
    '\u{391}A', '\u{392}B', '\u{395}E', '\u{396}Z', '\u{397}H', '\u{399}I', '\u{39A}K', '\u{39C}M', '\u{39D}N', '\u{39F}O',
    '\u{3A1}P', '\u{3A4}T', '\u{3A5}Y', '\u{3A7}X', '\u{3BF}o', '\u{3BD}v',
    '\u{585}o', '\u{57D}u', '\u{13AA}A', '\u{A4EE}A', '\u{251}a', '\u{1D400}A', '\u{2113}l',
  ];
  for (const pair of must) {
    const [from, to] = Array.from(pair);
    assert.equal(seen.get(from), to, pair);
  }
  for (const ch of 'ıſþƿƒǀʋɣɩƖ\u{2139}0123456789₹') assert.ok(!seen.has(ch), ch);
});

test('every table entry is mapped inside a mixed Latin word', () => {
  for (const g of Object.values(LOOKALIKES)) {
    for (const pair of `${g.strict} ${g.loose}`.split(' ').filter(Boolean)) {
      const [from, to] = Array.from(pair);
      const out = clean(`loan${from}book`);
      assert.match(out, /^loan[A-Za-z]book$/, pair);
      if (/[Il]/.test(to)) assert.match(out[4], /[Il]/, pair); // I and l share a skeleton
      else assert.equal(out[4], to, pair);
    }
  }
});

test('large input stays fast', () => {
  const para = 'In FY2023-24 we disbursed ₹1,200 crore at 9.5% p.a. — GNPA 1.4%. \u{397}\u{435}ll\u{43E}\u{A0}w\u{43E}rld\u{200B}. ';
  const s = para.repeat(2000);
  const t0 = Date.now();
  const r = cleanText(s);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.counts.lookalike, 8000);
  assert.equal(r.counts.invisible, 2000);
  assert.ok(!r.text.includes('\u{200B}'));
});

test('context ignores characters that are removed, so a second pass changes nothing', () => {
  assert.equal(clean('a\u{200B}\u{FE0F}'), 'a'); // the selector follows a letter once the ZWSP is gone
  assert.equal(clean('\u{1F600}\u{200B}\u{FE0F}'), '\u{1F600}\u{FE0F}');
  assert.equal(clean('\u{915}\u{200B}\u{200D}\u{937}'), '\u{915}\u{200D}\u{937}');
  assert.equal(clean('\u{4F60}\u{200B}\u{FF0C}'), '\u{4F60}\u{FF0C}'); // fullwidth comma after Chinese
});

test('fuzz: protected characters survive in order; output is clean and stable', () => {
  let seed = 20240331;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const PROTECTED = '₹0123456789.,;:!?\'"“”‘’-–—…²³½¼¾%()/';
  const POOL = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ      ', ...PROTECTED,
    '\u{430}', '\u{435}', '\u{43E}', '\u{410}', '\u{397}', '\u{399}', '\u{3BF}', '\u{3B1}', '\u{1D400}', '\u{A4F2}',
    '\u{200B}', '\u{200D}', '\u{AD}', '\u{A0}', '\u{2009}', '\u{FEFF}', '\u{202E}', '\u{FE0F}', '\u{E0041}', '\u{2028}',
    'Ａ', 'ｂ', 'क', '\u{94D}', 'ж', 'ш', '你', '\u{FF0C}', '\u{1F600}'];
  // a fullwidth comma may legitimately become ',' (outside Chinese text), so compare it as one
  const keep = (s) => [...s].map((c) => (c === '\u{FF0C}' ? ',' : c)).filter((c) => PROTECTED.includes(c)).join('');
  for (let n = 0; n < 2000; n++) {
    let s = '';
    for (let k = 0, len = 1 + rnd(60); k < len; k++) s += POOL[rnd(POOL.length)];
    const r = cleanText(s), hits = auditText(s), msg = JSON.stringify(s);
    assert.equal(keep(r.text), keep(s), msg);
    assert.equal(clean(r.text), r.text, msg);
    assert.equal(hits.length, Object.values(r.counts).reduce((a, b) => a + b, 0), msg);
    assert.doesNotMatch(r.text, /[\u{200B}\u{AD}\u{A0}\u{2009}\u{FEFF}\u{202E}\u{E0041}\u{2028}Ａｂ]/u, msg);
    for (const h of hits) assert.equal(s.codePointAt(h.index), h.code, msg);
    assert.equal(forDetector(s), r.text.normalize('NFKC'), msg);
  }
});

test('long runs of invisible characters or lookalike words stay linear', () => {
  const t0 = Date.now();
  assert.equal(clean('a' + '\u{200B}'.repeat(100000) + '\u{FE0F}b'), 'ab');
  const words = 'The committee approved the loan for the borrower today. '.repeat(400);
  const r = cleanText(words + '\u{41D}\u{415} '.repeat(1500)); // about 86% Latin letters
  assert.equal(r.counts.lookalike, 3000);
  assert.ok(Date.now() - t0 < 3000);
});
