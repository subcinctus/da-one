import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFacts, compareFacts, factCheck } from '../../ai-checker/src/facts.mjs';

// Canonical numbers as a sorted list, one entry per occurrence.
const nums = (t) => [...extractFacts(t).nums].flatMap(([k, f]) => Array(f.count).fill(k)).sort();
const keys = (t) => [...extractFacts(t).nums.keys()].sort();
const terms = (t) => Object.fromEntries(extractFacts(t).terms);
const negs = (t) => Object.fromEntries(extractFacts(t).negations);
const mods = (t) => Object.fromEntries(extractFacts(t).modals);
const same = (a, b, msg) => assert.deepEqual(keys(a), keys(b), msg || `${a} vs ${b}`);

// ---------- shape ----------
test('extractFacts returns Maps in the contract shape', () => {
  const f = extractFacts('GNPA was 1.5% and 1.5% again; we may not grow in Pune.');
  for (const k of ['nums', 'terms', 'negations', 'modals']) assert.ok(f[k] instanceof Map, k);
  assert.deepEqual(f.nums.get('pct:1.5'), { raw: ['1.5%', '1.5%'], count: 2 });
  assert.equal(f.terms.get('GNPA'), 1);
  assert.equal(f.terms.get('Pune'), 1);
  assert.equal(f.negations.get('not'), 1);
  assert.equal(f.modals.get('may'), 1);
});

test('empty, null and non-string input never throw', () => {
  for (const t of ['', null, undefined, 42, '   \n\n  ']) {
    const f = extractFacts(t);
    assert.equal(f.nums.size + f.terms.size + f.negations.size + f.modals.size, t === 42 ? 1 : 0);
  }
  assert.equal(compareFacts(null, undefined).ok, true);
  assert.equal(compareFacts('a', 'a', null).ok, true);
  assert.equal(compareFacts('Rs 5 crore', 'Rs 5 crore', { allow: 'Pune' }).ok, true);
});

// ---------- currencies and Indian units ----------
test('₹1,00,000 = Rs 100000 = INR 1 lakh = Rs. 1,00,000 = Rs 1L = ₹ 1 lac', () => {
  assert.deepEqual(keys('₹1,00,000 Rs 100000 INR 1 lakh Rs. 1,00,000 Rs 1L ₹ 1 lac rs 1 Lakh 1,00,000 rupees'), ['inr:100000']);
});

test('2.5 crore = 25,000,000 = 2,50,00,000; with a currency it becomes inr', () => {
  same('2.5 crore', '25,000,000');
  same('2.5 crore', '2,50,00,000');
  same('2.5 Cr', '25 million');
  assert.deepEqual(keys('Rs 2.5 crore'), ['inr:25000000']);
  assert.deepEqual(keys('2.5 crore rupees'), ['inr:25000000']);
});

test('Rs 2,000 cr in every spelling', () => {
  assert.deepEqual(keys('Rs 2,000 cr, Rs 2,000 Cr., ₹2000 crores, INR 2,000 CR, Rs.2000cr'), ['inr:20000000000']);
});

test('Indian digit grouping and lakh/lac/crore forms', () => {
  assert.deepEqual(nums('1,00,00,000 and 1 crore and 10 million and 100 lakh'), Array(4).fill('n:10000000'));
  assert.deepEqual(nums('12,34,567 and 1,234,567'), ['n:1234567', 'n:1234567']);
  assert.deepEqual(nums('5 lakhs, 5 lacs, 5 Lakh, 5L'), Array(4).fill('n:500000'));
  assert.deepEqual(keys('₹1.5 lakh crore'), ['inr:1500000000000']);
  assert.deepEqual(keys('₹10 thousand crore'), ['inr:100000000000']);
});

test('million, billion, thousand and k', () => {
  assert.deepEqual(keys('$4 mn, US$ 4 million, USD 4mn, $4M, $4m, 4 million dollars'), ['usd:4000000']);
  same('₹1.2 bn', 'INR 1,200 million');
  same('10k', '10,000');
  same('10K', '10 thousand');
  assert.deepEqual(keys('€5 bn and £2k'), ['eur:5000000000', 'gbp:2000']);
});

test('decimals do not pick up floating-point noise', () => {
  assert.deepEqual(keys('0.07 crore'), ['n:700000']);
  assert.deepEqual(keys('0.29 percentage points'), ['bps:29']);
  assert.deepEqual(keys('₹1,234.56 crore'), ['inr:12345600000']);
  same('1.50%', '1.5%');
});

test('single-letter units must touch the number; m and b need a currency', () => {
  assert.deepEqual(keys('5 L'), ['n:5']);
  assert.deepEqual(keys('5 m'), ['n:5']);
  assert.deepEqual(keys('5m'), ['n:5']);
  assert.deepEqual(keys('$5m'), ['usd:5000000']);
  assert.deepEqual(keys('10 K'), ['n:10']);
  assert.deepEqual(keys('5l'), ['n:5']);
});

test('hyphenated units: a ₹500-crore fund, a 3-lakh limit, but a 5-year loan', () => {
  same('a ₹500-crore fund', 'a fund of Rs 500 crore');
  assert.deepEqual(keys('a 3-lakh limit'), ['n:300000']);
  assert.deepEqual(keys('a 5-year loan, a 10-member team'), ['n:10', 'n:5']);
});

test('currency prefixes inside words are ignored (are 5, Mrs 5, years 5)', () => {
  assert.deepEqual(nums('we are 5 people; Mrs 5; years 5'), ['n:5', 'n:5', 'n:5']);
  assert.deepEqual(keys('Re 1 and INR500 and Rs.500'), ['inr:1', 'inr:500']);
  assert.deepEqual(keys('Rs 5,000/-'), ['inr:5000']);
});

// ---------- percentages, bps, multiples ----------
test('percent forms are one fact', () => {
  assert.deepEqual(nums('1.5% 1.5 per cent 1.5 percent 1.5pc 1.5 pct 1.5 per-cent 1.5 %'), Array(7).fill('pct:1.5'));
  assert.deepEqual(keys('5 pcs'), ['n:5']);
});

test('bps, basis points and percentage points share one canon', () => {
  assert.deepEqual(nums('150 bps 150bps 150 bp 150 basis points 1.5 percentage points 1.5 pp'), Array(6).fill('bps:150'));
  assert.notDeepEqual(keys('1.5%'), keys('150 bps'));
});

test('multiples: only an attached x counts', () => {
  assert.deepEqual(nums('3x 3X 3× 3.5x'), ['x:3', 'x:3', 'x:3', 'x:3.5']);
  assert.deepEqual(keys('3 times'), ['n:3']);
  assert.deepEqual(keys('3 x 4'), ['n:3', 'n:4']);
});

test('ranges carry the unit to both ends', () => {
  same('5–10%', '5% to 10%');
  same('Rs 5-10 crore', 'Rs 5 crore to Rs 10 crore');
  same('1.5 to 2%', '1.5% and 2%');
  same('2-3x', '2x or 3x');
});

test('signs: -2% is not 2%, but a hyphen after a word or unit is not a minus', () => {
  assert.deepEqual(keys('-2%'), ['pct:-2']);
  assert.deepEqual(keys('(−0.5%)'), ['pct:-0.5']);
  assert.deepEqual(keys('COVID-19'), ['n:19']);
  assert.deepEqual(keys('5%-6%'), ['pct:5', 'pct:6']);
  assert.equal(compareFacts('a fall of -2%', 'a fall of 2%').ok, false);
});

// ---------- fiscal years, quarters, halves ----------
test('FY forms → fy:2024', () => {
  const forms = ['FY24', "FY'24", 'FY’24', 'FY 24', 'FY-24', 'FY2024', 'FY 2024', 'FY2023-24', 'FY 2023–24', 'FY23-24',
    'FY2023/24', 'F.Y. 2023-24', 'fy24', 'financial year 2023-24', 'fiscal year 2023–24', 'fiscal 2024', '2023-24', '2023–2024'];
  for (const f of forms) assert.deepEqual(keys(`In ${f} we grew.`), ['fy:2024'], f);
});

test('FY24-25 is FY2025; FY24-FY25 and FY22-25 are two years', () => {
  assert.deepEqual(keys('FY24-25'), ['fy:2025']);
  assert.deepEqual(keys('FY2024-25'), ['fy:2025']);
  assert.deepEqual(keys('FY24-FY25'), ['fy:2024', 'fy:2025']);
  assert.deepEqual(keys('FY22-25'), ['fy:2022', 'fy:2025']);
  assert.deepEqual(keys('2019-2023'), ['n:2019', 'n:2023']);
  assert.equal(compareFacts('In FY24 we grew.', 'In FY2023-24 we grew.').ok, true);
  assert.equal(compareFacts('In FY24 we grew.', 'In FY25 we grew.').ok, false);
});

test('quarters, halves and nine months, also glued to the year', () => {
  assert.deepEqual(nums('Q1FY24, 1QFY24, Q1 FY24 and Q1-FY24'), ['fy:2024', 'fy:2024', 'fy:2024', 'fy:2024', 'q:1', 'q:1', 'q:1', 'q:1']);
  assert.deepEqual(nums('H1 and H2 FY25, 2H'), ['fy:2025', 'h:1', 'h:2', 'h:2']);
  assert.deepEqual(keys('9MFY24'), ['fy:2024', 'months:9']);
  assert.deepEqual(keys('CY24 and CY2024'), ['cy:2024']);
  assert.deepEqual(nums('H2O and H1B'), []);
});

test('FY with an estimate suffix is kept as a term, not silently equal to FY24', () => {
  assert.deepEqual(terms('Guidance for FY24E is firm.'), { FY24E: 1 });
  assert.equal(compareFacts('FY24E', 'FY24').ok, false);
});

// ---------- dates and years ----------
test('full dates in every common spelling → date:2025-03-31', () => {
  const forms = ['31 March 2025', 'March 31, 2025', '31/03/2025', '31-03-2025', '31.03.2025', '31/3/25', '31-Mar-2025',
    '31-Mar-25', "31 Mar '25", '31st March, 2025', '31st of March 2025', '2025-03-31', 'Mar. 31, 2025', 'MARCH 31 2025'];
  for (const f of forms) assert.deepEqual(nums(`As of ${f}, we grew.`), ['date:2025-03-31'], f);
});

test('dd/mm first, mm/dd only when dd/mm is impossible; invalid dates are plain numbers', () => {
  assert.deepEqual(keys('01/04/2024'), ['date:2024-04-01']);
  assert.deepEqual(keys('12/31/2024'), ['date:2024-12-31']);
  assert.deepEqual(keys('29/02/2024'), ['date:2024-02-29']);
  assert.deepEqual(nums('31/02/2025'), ['n:2', 'n:2025', 'n:31']);
});

test('month-year and day-month', () => {
  assert.deepEqual(nums("March 2025, Mar '25, Mar-25, Mar'25, March, 2025, MAY 2025"), [
    'date:2025-03', 'date:2025-03', 'date:2025-03', 'date:2025-03', 'date:2025-03', 'date:2025-05']);
  assert.deepEqual(nums('by 31 March or March 31 or 31st Mar'), Array(3).fill('date:--03-31'));
  assert.deepEqual(nums('31 April'), ['n:31']); // no such day: just the number; "April" is a name only mid-sentence
});

test('years are bare numbers and the year inside a date is not counted twice', () => {
  assert.deepEqual(keys('In 2025 we grew.'), ['n:2025']);
  assert.deepEqual(nums('31 March 2025'), ['date:2025-03-31']);
  assert.equal(compareFacts('In 2024 we grew.', 'In 2025 we grew.').ok, false);
});

test('lower-case "may" and "march" are not months', () => {
  assert.deepEqual(nums('we may 2 times'), ['n:2']);
  assert.deepEqual(nums('troops march 5 miles'), ['n:5']);
});

// ---------- things that are not facts ----------
test('list numbering is not a fact', () => {
  assert.deepEqual(nums('1. Growth\n2. Quality\n  3) Collections\n(4) Recovery'), []);
  assert.deepEqual(nums('We focus on (1) sourcing and (2) underwriting.'), []);
  assert.deepEqual(nums('1.5% growth\n2. 5% margin'), ['pct:1.5', 'pct:5']);
  assert.equal(compareFacts('1. Growth is strong.\n2. Quality is stable.', 'Growth is strong and quality is stable.').ok, true);
});

test('ordinal words and "one of the" are not facts', () => {
  assert.deepEqual(nums('First and foremost, one of the best; second, no one else; twenty-first century; one-time fee.'), []);
  assert.equal(compareFacts('This is one of the key drivers.', 'This is a key driver.').ok, true);
});

test('number words count by value', () => {
  same('five branches', '5 branches');
  same('two crore', '2,00,00,000');
  same('twenty-five lakh', '25,00,000');
  same('one per cent', '1%');
  same('two hundred and fifty', '250');
  assert.deepEqual(nums('Ten years, a two-wheeler'), ['n:10', 'n:2']);
  assert.deepEqual(nums('someone, tenure, often, alone, weight'), []);
});

test('digit ordinals, decades and glued identifiers', () => {
  assert.deepEqual(keys('the 2nd largest'), ['ord:2']);
  assert.equal(compareFacts('the 2nd largest', 'the 3rd largest').ok, false);
  assert.deepEqual(keys('the 1990s'), ['n:1990']);
  assert.deepEqual(nums('B2B and G20 and CO2'), []);
  assert.deepEqual(terms('B2B and G20 and CO2'), { B2B: 1, G20: 1, CO2: 1 });
  assert.deepEqual(nums('1,2,3'), ['n:1', 'n:2', 'n:3']);
});

test('"No. 5" is a number, not a negation; "No 5 branches" still negates', () => {
  assert.deepEqual(negs('See No. 5 and No.6.'), {});
  assert.deepEqual(negs('No, it is not.'), { no: 1, not: 1 });
  assert.deepEqual(negs('No 5 branches closed; we have no 5-star hotels.'), { no: 2 });
});

// ---------- terms ----------
test('acronyms, plural and possessive forms', () => {
  assert.deepEqual(terms('RBI, NBFCs, DSAs, EMIs, the RBI’s view, LTV, PSL, MSMEs, P&L and AT&T.'),
    { RBI: 2, NBFC: 1, DSA: 1, EMI: 1, LTV: 1, PSL: 1, MSME: 1, 'P&L': 1, 'AT&T': 1 });
  assert.equal(compareFacts('Our DSAs and NBFCs grew.', 'Our DSA network and NBFC peers grew.').ok, true);
});

test('sentence-initial words and "I" are not terms; mid-sentence names are', () => {
  assert.deepEqual(terms('The book grew. Growth was strong in Pune and I think Mumbai too.'), { Pune: 1, Mumbai: 1 });
  assert.deepEqual(terms('Moreover, it rose. However, it fell.'), {});
  assert.equal(compareFacts('The book grew. The RBI approved it.', 'RBI approved it as the book grew.').ok, true);
});

test('names after abbreviations, colons, bullets and list markers', () => {
  assert.deepEqual(terms('Mr. Sharma said e.g. Mumbai leads.'), { Sharma: 1, Mumbai: 1 });
  assert.deepEqual(terms('Note: Growth was fine.\n- Collections improved.\n(a) Recovery rose.'), {});
});

test('a name moved to the start of a sentence is not lost', () => {
  assert.equal(compareFacts('Pune leads our growth.', 'We grew fastest in Pune.').ok, true);
  assert.equal(compareFacts('We grew fastest in Pune.', 'Pune leads our growth.').ok, true);
});

test('Tier 2 / Tier-2 / tier 2 / Tier II are one term and not a number', () => {
  assert.deepEqual(terms('Tier 2 cities, Tier-2 towns, tier 2 markets, Tier II centres, Tier2 hubs'), { 'Tier 2': 5 });
  assert.deepEqual(terms('Tier 2 and 3 cities; Tier-2/3; Tier 1, Tier 2 and Tier 3'), { 'Tier 2': 3, 'Tier 3': 3, 'Tier 1': 1 });
  assert.deepEqual(nums('Tier 2 and Tier 3 cities'), []);
  assert.equal(compareFacts('Tier 2 and Tier 3 cities', 'tier-2 and tier-3 towns').ok, true);
  assert.equal(compareFacts('Tier 2 cities', 'Tier 3 cities').ok, false);
  assert.deepEqual(nums('Tier 1, 2,000 branches'), ['n:2000']);
});

test('shouted negations, modals and contractions are not terms', () => {
  assert.deepEqual(terms('We do NOT lend and WILL NOT.'), {});
  assert.deepEqual(terms("Rates rose. Don't panic, as \"We'll see\" and \"Can't stop\" show."), {});
  assert.equal(compareFacts('We do NOT lend.', 'We do not lend.').ok, true);
});

// ---------- negations and modals ----------
test('negation words and contractions, with and without apostrophes', () => {
  assert.deepEqual(negs("not, no, never, without, none, nor, cannot, don't, isn’t, didnt, nothing, nobody, neither, nowhere"),
    { not: 1, no: 1, never: 1, without: 1, none: 1, nor: 1, cannot: 1, "n't": 3, nothing: 1, nobody: 1, neither: 1, nowhere: 1 });
});

test("contractions carry their modal: can't, won't, shouldn't, cannot, we'll", () => {
  assert.deepEqual(mods("can't, won't, shan't, shouldn't, couldn't, cannot, we'll, I'd, cant, wont"),
    { can: 3, will: 3, shall: 1, should: 1, could: 1, would: 1 });
  assert.deepEqual(negs("can't, won't, cannot"), { "n't": 2, cannot: 1 });
});

test('equivalent negation spellings compare equal', () => {
  assert.equal(compareFacts('We cannot lend.', "We can't lend.").ok, true);
  assert.equal(compareFacts('We can not lend.', 'We cannot lend.').ok, true);
  assert.equal(compareFacts('We will not lend.', "We won't lend.").ok, true);
  assert.equal(compareFacts('We do not lend.', "We don't lend.").ok, true);
  assert.equal(compareFacts('We did not default.', 'We never defaulted.').ok, true);
});

test('"not approved" → "approved" fails on negation', () => {
  const r = compareFacts('The loan was not approved.', 'The loan was approved.');
  assert.equal(r.ok, false);
  assert.deepEqual(r.negations, { before: 1, after: 0, ok: false });
  assert.deepEqual([r.missingNums, r.missingTerms, r.modals.changed], [[], [], []]);
});

test('"may" → "will" fails on modals', () => {
  const r = compareFacts('We may expand to Pune.', 'We will expand to Pune.');
  assert.equal(r.ok, false);
  assert.deepEqual(r.modals.changed, [{ word: 'may', before: 1, after: 0 }, { word: 'will', before: 0, after: 1 }]);
  assert.equal(compareFacts("We can't lend.", 'We cannot lend.').ok, true);
  assert.equal(compareFacts('We should lend.', 'We must lend.').ok, false);
});

test('case-insensitive: May the month is not a modal, "May we" is', () => {
  assert.deepEqual(mods('In May, disbursals rose. On 31 May 2025 we closed. May 2024 was slow.'), {});
  assert.deepEqual(mods('May we suggest a change? We MAY. It may rain.'), { may: 3 });
  assert.deepEqual(terms('In May, disbursals rose. May we suggest a change?'), { May: 1 });
});

test('"not just X but Y" is additive; "not only" alone still negates', () => {
  assert.deepEqual(negs('Growth is not just about volumes; it is about building a franchise.'), {});
  assert.deepEqual(negs("It isn't only price but also service."), {});
  assert.deepEqual(negs('We do not only lend to salaried borrowers.'), { not: 1 });
  assert.deepEqual(negs('GNPA is not just 1.5% but 2% if we add write-offs.'), {});
});

// ---------- compareFacts ----------
test('equivalent spellings pass', () => {
  const r = compareFacts('We lent ₹1,00,000 to each of 2.5 crore borrowers in FY24 at 1.5%.',
    'In FY2023-24 we lent Rs 1 lakh to each of 25,000,000 borrowers at 1.5 per cent.');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('1.5% → 1.6% is a true change', () => {
  const r = compareFacts('GNPA was 1.5%.', 'GNPA was 1.6%.');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingNums, ['1.5%']);
  assert.deepEqual(r.addedNums, ['1.6%']);
});

test('multiset numbers: 1.5% twice before and once after → one missing', () => {
  const r = compareFacts('GNPA was 1.5% and credit cost 1.5% in FY24.', 'GNPA and credit cost were 1.5% in FY24.');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingNums, ['1.5%']);
  assert.deepEqual(r.addedNums, []);
  // the missing raw is the spelling the rewrite did not keep
  assert.deepEqual(compareFacts('1.5% and 1.5 per cent', '1.5 per cent').missingNums, ['1.5%']);
  assert.deepEqual(compareFacts('1.5% and 1.5% and 1.5%', '1.5%').missingNums, ['1.5%', '1.5%']);
});

test('dropped GNPA is a missing term', () => {
  const r = compareFacts('GNPA and NNPA fell.', 'NNPA fell.');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingTerms, ['GNPA']);
  assert.deepEqual(compareFacts('We grew.', 'We grew with HDFC.').addedTerms, ['HDFC']);
});

test('compareFacts reports paragraphs and words', () => {
  const r = compareFacts('First para.\n\nNext para.', 'Just a paragraph now.');
  assert.deepEqual([r.parasBefore, r.parasAfter, r.wordsBefore, r.wordsAfter], [2, 1, 4, 4]);
  assert.equal(r.ok, true);
});

test('allow lets the author’s facts be added, canonicalised the same way', () => {
  const allow = ['Rs 50 crore', 'Nashik', 'FY2024-25'];
  const r = compareFacts('We grew 20%.', 'We grew 20% in Nashik and sanctioned ₹50 cr in FY25.', { allow });
  assert.equal(r.ok, true, JSON.stringify(r));
  const bad = compareFacts('We grew 20%.', 'We grew 20% in Nashik and sanctioned ₹60 cr.', { allow });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.addedNums, ['₹60 cr']);
});

test('allow never excuses a dropped fact', () => {
  const r = compareFacts('We sanctioned ₹50 crore in Nashik.', 'We sanctioned loans.', { allow: ['₹50 crore', 'Nashik'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingNums, ['₹50 crore']);
  assert.deepEqual(r.missingTerms, ['Nashik']);
});

test('allow covers negations and modals only up to what the author wrote', () => {
  assert.equal(compareFacts('We grew.', 'We will never stop growing.', { allow: ['We will never stop'] }).ok, true);
  assert.equal(compareFacts('We grew.', 'We will never, never stop.', { allow: ['We will never stop'] }).ok, false);
  assert.equal(compareFacts('We will not stop.', 'We stop.', { allow: ['We will not stop'] }).ok, false);
});

// ---------- factCheck ----------
test('factCheck keeps the old shape for the review dialog', () => {
  const r = factCheck('GNPA was 1.5% in Pune.\n\nNNPA was 0.5%.', 'GNPA was 1.6%.');
  assert.deepEqual(Object.keys(r).sort(),
    ['addedNums', 'missingNums', 'missingTerms', 'parasAfter', 'parasBefore', 'wordsAfter', 'wordsBefore']);
  assert.deepEqual(r.missingNums, ['1.5%', '0.5%']);
  assert.deepEqual(r.addedNums, ['1.6%']);
  assert.deepEqual(r.missingTerms, ['Pune', 'NNPA']);
  assert.deepEqual([r.parasBefore, r.parasAfter], [2, 1]);
});

test('factCheck lists repeats once and only reports names the rewrite dropped altogether', () => {
  const r = factCheck('We like Mumbai. Mumbai grew 1.5% and 1.5% and 1.5%.', 'Mumbai grew 1.5%.');
  assert.deepEqual(r.missingNums, ['1.5%']);
  assert.deepEqual(r.missingTerms, []);
  assert.equal(compareFacts('We like Mumbai. Mumbai grew.', 'Mumbai grew.').ok, false); // the guard stays strict
});

// ---------- a realistic answer ----------
test('the example answer', () => {
  const t = `In today's dynamic lending landscape, growing a retail mortgage book requires a holistic approach. First and foremost, it is important to leverage data-driven underwriting, particularly in Tier 2 and Tier 3 cities. Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role.

Furthermore, robust early-warning systems are crucial to keeping GNPA below 1.5%. Lenders can reduce turnaround time. Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise.`;
  const f = extractFacts(t);
  assert.deepEqual([...f.nums.keys()], ['pct:1.5']);
  assert.deepEqual(Object.fromEntries(f.terms), { 'Tier 2': 1, 'Tier 3': 1, DSA: 1, GNPA: 1 });
  assert.deepEqual(Object.fromEntries(f.negations), {});
  assert.deepEqual(Object.fromEntries(f.modals), { can: 1 });
});

test('a dense NBFC paragraph', () => {
  const t = 'As per RBI norms (Master Direction, 2023), our LTV cap is 80% for loans up to ₹30 lakh. Mr. Sharma, our CFO, '
    + 'said AUM grew 12.5% YoY to ₹1,234.56 crore as of 30th September 2024. CRAR stood at 22.3% vs. 15% required. '
    + 'We added 150 branches in H1 FY25 and cut GNPA by 50 bps.';
  assert.deepEqual(keys(t), ['bps:50', 'date:2024-09-30', 'fy:2025', 'h:1', 'inr:12345600000', 'inr:3000000', 'n:150', 'n:2023',
    'pct:12.5', 'pct:15', 'pct:22.3', 'pct:80']);
  assert.deepEqual(terms(t), { RBI: 1, Master: 1, Direction: 1, LTV: 1, Sharma: 1, CFO: 1, AUM: 1, YoY: 1, CRAR: 1, GNPA: 1 });
  const rewrite = 'Under RBI norms (Master Direction, 2023) we cap LTV at 80% for loans up to Rs 30 lakh. AUM rose 12.5% YoY to '
    + 'Rs 1,234.56 Cr by 30 Sep 2024, our CFO Mr. Sharma said. CRAR was 22.3% against the 15% required. In H1 FY2024-25 '
    + 'we opened 150 branches and cut GNPA by 0.5 percentage points.';
  assert.equal(compareFacts(t, rewrite).ok, true, JSON.stringify(compareFacts(t, rewrite)));
});

test('typical sentence rewrites keep their facts and pass', () => {
  const pairs = [
    ['Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise.',
      'Volumes matter, but lasting growth comes from building a franchise that holds up.'],
    ['Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role.', 'Our builder and DSA partnerships matter.'],
    ['Sammaan Capital has grown its book.', 'We at Sammaan Capital have grown the book.'],
    ['Our disbursements crossed ₹10,000 crore in FY24, up 25% YoY.',
      'In FY2023-24 we disbursed over Rs 10,000 Cr, 25% more than a year earlier (YoY).'],
    ['As of 31st March 2024, our GNPA stood at 1.2% and NNPA at 0.6%.', 'GNPA was 1.2% and NNPA 0.6% on 31 March 2024.'],
    ['Collection efficiency improved to 99.5% in Q4FY24 from 98.7% in Q3FY24.',
      'In Q4 FY24 collection efficiency rose to 99.5%, from 98.7% in Q3 FY24.'],
  ];
  for (const [a, b] of pairs) assert.equal(compareFacts(a, b).ok, true, `${a} → ${b}: ${JSON.stringify(compareFacts(a, b))}`);
});

// ---------- portability ----------
test('no regex lookbehind (older Safari)', () => {
  const src = readFileSync(new URL('../../ai-checker/src/facts.mjs', import.meta.url), 'utf8');
  assert.equal(/\(\?<[=!]/.test(src), false);
});
