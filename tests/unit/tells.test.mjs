import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findTells, styleStats, tellsBySentence, BAN_LIST } from '../../ai-checker/src/tells.mjs';
import * as data from '../../ai-checker/src/tells-data.mjs';
import { splitSentences, words } from '../../ai-checker/src/text.mjs';

// The AI-style example shipped with the page (app.mjs, EXAMPLE).
const EXAMPLE = `In today's dynamic lending landscape, growing a retail mortgage book requires a holistic approach that balances ambition with prudence. First and foremost, it is important to leverage data-driven underwriting to identify creditworthy segments, particularly in Tier 2 and Tier 3 cities where demand for affordable housing continues to rise. Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role in sourcing quality customers at scale.

Furthermore, robust early-warning systems and proactive collection strategies are crucial to keeping GNPA below 1.5%. By seamlessly integrating technology across the loan lifecycle, from sourcing to disbursement and servicing, lenders can reduce turnaround time while enhancing the overall customer experience. Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise that delivers long-term value for all stakeholders.`;

const HUMAN = 'We lent ₹2,000 crore last year. Most of it went to salaried borrowers in Tier 2 towns. Collections held up because our branch teams knew the customers.';

// Plain human finance writing: must come back clean.
const HUMAN_SET = [
  HUMAN,
  'Our GNPA was 1.8% at the end of FY24, up from 1.5% a year earlier. We implemented a new scorecard in Q2 and prioritised salaried borrowers. Disbursements rose 22% to ₹4,500 crore. The leverage ratio stayed at 4.2x, and the portfolio is well diversified across Pune, Nashik and Nagpur.',
  'We optimise collections through our branch network and facilitate disbursement within 48 hours of sanction. Underwriting is done in-house; we do not rely on DSAs for credit decisions. Robust collections in FY2023-24 kept credit costs at 40 bps.',
  'In FY24 we disbursed Rs 1,250 crore of home loans, LAP and MSME loans. Average ticket size was ₹18 lakh and LTV was 62%. Going forward, we will focus on self-employed customers in Tier 3 towns, where competition from banks is lower.',
  'The RBI raised the risk weight on unsecured loans by 25 percentage points in November 2023. This increased our capital requirement, so we slowed personal-loan growth and shifted towards secured lending. Our CRAR is still comfortable at 22.4%.',
  'Excluding the one-time gain on the sale of our stake, PAT grew 14% to ₹612 crore. Net interest margin fell 30 bps because our cost of funds rose faster than our lending rates. We expect margins to stabilise by H2 FY25.',
  'Collections efficiency improved to 98.7% in Q3. Our field staff visit every borrower who misses an EMI within three days, and that early contact matters more than any scorecard. Bounce rates in the Nagpur cluster are still high, and we are looking at why.',
  'I joined the company in 1996 as a credit officer in Indore. In those days we appraised every file by hand and visited every property. Today the scorecard does much of the first screening, but our credit managers still meet each self-employed borrower before sanction.',
  'Asset quality remained stable during the year. Stage 3 assets were 1.9% of the book against 2.1% last year, and provision coverage was 45%. The increase in Stage 2 was largely from two builder accounts, both of which are now regular.',
  'Please let me know if you need any further information. We would be happy to share the branch-wise data for FY24.',
  'Housing finance companies, the RBI said in its circular, must maintain a minimum NOF of ₹20 crore. We comply comfortably, with a net worth of ₹3,400 crore.',
  'Our key priorities for FY25 are: growing the affordable housing book, reducing cost of funds, and improving collections in the Vidarbha region.',
  'Lending to MSMEs, especially in smaller towns, carries higher risk. We price for that risk and keep tenures short.',
  'Overall, disbursements grew 18% in the quarter. Branch productivity also improved.',
  'In May 2024 the RBI may review the norms. We may need more capital if it does.',
  'Our rule is simple: lend against property and keep LTV under 50%.\nNote: all figures are provisional and unaudited.',
  'We lent ₹500 crore, ₹700 crore and ₹900 crore in the three years. Sourcing, underwriting and collections sit in separate teams.',
];

// AI-style finance answers in the styles of current chat models.
const AI_SET = [
  `Navigating the evolving regulatory landscape requires a proactive, data-driven approach. Our strategy rests on three pillars: prudence, agility, and innovation. It's not just about compliance — it's about building trust with every stakeholder. By leveraging advanced analytics, we can identify early signs of stress, ensuring timely intervention.`,
  `**Credit Quality:** Our GNPA improved to 1.2%, reflecting our commitment to disciplined underwriting.\n**Collections:** Collection efficiency remained robust at 99%, underscoring the strength of our field teams.\n**Growth:** AUM grew 24% — driven by strong demand in Tier 2 and Tier 3 markets.`,
  `In an increasingly competitive lending environment, NBFCs must strike a balance between growth and risk. Moreover, the RBI's recent measures underscore the importance of robust governance. Additionally, digital channels offer a seamless customer experience. In conclusion, the path forward lies in transparency, efficiency, and resilience.`,
  `The result? A 30% drop in turnaround time. Leveraging our branch network, we expanded into 40 new districts. This isn't merely a growth story. It's a testament to our team's unwavering dedication.`,
  `Ultimately, the goal is not only to grow the book but also to ensure that every customer feels valued. This could potentially reduce churn and may possibly improve cross-sell. The key takeaway: disciplined growth wins.`,
];

const CATEGORIES = new Set(['vocabulary', 'phrase', 'opener', 'closer', 'formula', 'structure', 'punctuation']);
const slices = (t) => findTells(t).map((f) => t.slice(f.start, f.end));
const hits = (t) => findTells(t).map((f) => [t.slice(f.start, f.end), f.rule]);
const has = (t, text, rule) => findTells(t).some((f) => t.slice(f.start, f.end) === text && (!rule || f.rule === rule));
const ruleCount = (t, rule) => findTells(t).filter((f) => f.rule === rule).length;
const weight = (t) => findTells(t).reduce((a, f) => a + f.weight, 0);
const flagged = (t) => styleStats(t).flags.map((f) => f.stat);

function assertWellFormed(t) {
  const list = findTells(t);
  let prev = null;
  for (const f of list) {
    assert.deepEqual(Object.keys(f).sort(), ['category', 'end', 'message', 'rule', 'start', 'weight']);
    assert.ok(Number.isInteger(f.start) && Number.isInteger(f.end), 'integer offsets');
    assert.ok(f.start >= 0 && f.end <= t.length && f.end > f.start, `offsets in range: ${f.start}-${f.end}`);
    const s = t.slice(f.start, f.end);
    assert.equal(s, s.trim(), `no padding around "${s}"`);
    assert.ok(CATEGORIES.has(f.category), f.category);
    assert.ok([1, 2, 3].includes(f.weight), `weight ${f.weight}`);
    assert.equal(typeof f.rule, 'string');
    assert.ok(f.rule.length > 0);
    assert.ok(f.message.length > 10 && f.message.length <= 110, `message length: ${f.message}`);
    assert.match(f.message, /[.)]$/, 'message is a sentence');
    if (prev) assert.ok(prev.start < f.start || (prev.start === f.start && prev.end >= f.end), 'sorted');
    prev = f;
  }
  return list;
}

// ---------- shape and robustness ----------
test('findTells returns the contract shape for every sample', () => {
  for (const t of [EXAMPLE, HUMAN, ...HUMAN_SET, ...AI_SET]) assertWellFormed(t);
});

test('empty, whitespace, null, undefined and non-string input never throw', () => {
  for (const t of ['', '   \n\n ', null, undefined, 42, {}, [], '12345', '₹ % — –', '.', '?!']) {
    assert.deepEqual(findTells(t), [], String(t));
    const st = styleStats(t);
    assert.equal(st.flags.length, 0);
    for (const k of ['meanLen', 'cvLen', 'contractionsPer100', 'emDashPer100']) assert.ok(Number.isFinite(st[k]), k);
    assert.deepEqual(tellsBySentence(t), splitSentences(String(t ?? '')).map(() => ({ count: 0, weight: 0, rules: [] })));
  }
});

test('returned findings are copies: mutating them does not change the next call', () => {
  const a = findTells(EXAMPLE);
  const n = a.length;
  a[0].start = 999; a.pop();
  const b = findTells(EXAMPLE);
  assert.equal(b.length, n);
  assert.notEqual(b[0].start, 999);
  assert.deepEqual(findTells(EXAMPLE), b);
});

// ---------- the page's AI example ----------
test('the AI mortgage example produces many findings at the right places', () => {
  const list = assertWellFormed(EXAMPLE);
  assert.ok(list.length >= 15, `found ${list.length}`);
  const expected = [
    ["In today's dynamic lending landscape", 'todays-world'], ['holistic', 'ai-word'], ['First and foremost', 'first-foremost'],
    ['it is important to', 'important-to'], ['leverage', 'ai-word'], ['Moreover', 'transition'], ['fostering', 'ai-word'],
    ['plays a pivotal role', 'plays-role'], ['Furthermore', 'transition'], ['proactive', 'ai-word'], ['crucial', 'ai-word'],
    ['By seamlessly integrating technology across the loan lifecycle', 'ing-opener'], ['seamlessly', 'ai-word'],
    ['enhancing', 'ai-word'], ['Ultimately', 'closer'], ['is not just about volumes; it is about', 'not-x-its-y'],
    ['for all stakeholders', 'stakeholders'],
  ];
  const got = hits(EXAMPLE).map(([s, r]) => `${s}|${r}`);
  for (const [s, r] of expected) assert.ok(got.includes(`${s}|${r}`), `missing ${s} (${r})`);
  // offsets point at the exact text
  const f = findTells(EXAMPLE).find((x) => x.rule === 'plays-role');
  assert.equal(f.start, EXAMPLE.indexOf('plays a pivotal role'));
  assert.equal(f.end, f.start + 'plays a pivotal role'.length);
  assert.equal(findTells(EXAMPLE)[0].start, 0);
});

test('the example: each word counts once and domain words stay clean', () => {
  const s = slices(EXAMPLE);
  assert.ok(!s.includes('pivotal'), 'pivotal is part of "plays a pivotal role"');
  assert.ok(!s.includes('dynamic') && !s.includes('landscape'), 'part of the opener');
  for (const w of ['robust', 'data-driven', 'underwriting', 'disbursement', 'sustainable', 'resilient', 'GNPA', 'DSAs']) {
    assert.ok(!s.some((x) => x.includes(w)), `${w} must not be flagged`);
  }
  const cats = new Set(findTells(EXAMPLE).map((f) => f.category));
  for (const c of ['vocabulary', 'phrase', 'opener', 'closer', 'formula']) assert.ok(cats.has(c), c);
});

test('every finding stays inside one sentence', () => {
  for (const t of [EXAMPLE, ...AI_SET]) {
    const sents = splitSentences(t);
    for (const f of findTells(t)) {
      assert.ok(sents.some((s) => f.start >= s.start && f.end <= s.end), `"${t.slice(f.start, f.end)}" crosses a sentence`);
    }
  }
});

// ---------- human writing stays clean ----------
test('the plain human finance paragraph has no findings', () => {
  assert.deepEqual(findTells(HUMAN), []);
  assert.deepEqual(styleStats(HUMAN).flags, []);
});

test('ordinary human finance writing produces no findings or flags', () => {
  for (const t of HUMAN_SET) {
    assert.deepEqual(hits(t), [], t);
    assert.deepEqual(flagged(t), [], t);
  }
});

test('AI-style answers weigh far more than human ones', () => {
  for (const t of AI_SET) assert.ok(weight(t) >= 6, `${weight(t)}: ${t}`);
  const human = HUMAN_SET.reduce((a, t) => a + weight(t), 0);
  const ai = AI_SET.reduce((a, t) => a + weight(t), 0);
  assert.ok(ai >= 50 && human === 0, `ai ${ai}, human ${human}`);
});

test('domain and register words are never flagged', () => {
  for (const w of data.DOMAIN_SAFE) {
    for (const t of [`We looked at ${w} in FY24.`, `${w[0].toUpperCase()}${w.slice(1)} matters to us.`, `The ${w} was discussed by the board.`]) {
      assert.deepEqual(findTells(t), [], t);
    }
  }
  const t = 'We implemented the new LOS, prioritised salaried customers, optimised branch costs and facilitated faster sanction. '
    + 'The RBI may terminate the licence if we breach norms, so we minimise risk and maximise recoveries. Disbursement and underwriting '
    + 'sit with credit; the portfolio is robust, and our comprehensive review found a significant increase in credit risk in Stage 2. '
    + 'Fund utilisation, enhanced due diligence and dynamic provisioning are standard. Elevated credit costs hurt margins.';
  assert.deepEqual(hits(t), []);
});

// ---------- vocabulary ----------
test('leverage: the verb is flagged, the noun is not', () => {
  for (const t of ['We will leverage our branch network.', 'We plan to leverage data.', 'We leverage data in underwriting.',
    'We will leverage on our branches.', 'Leveraging data, we cut losses.', 'The firm leverages its network.']) {
    assert.ok(findTells(t).some((f) => /^leverag/i.test(t.slice(f.start, f.end))), t);
  }
  for (const t of ['Our leverage ratio is 4.2x.', 'Financial leverage rose.', 'Leverage was 4.2x at year end.', 'Operating leverage helped margins.',
    'We cut leverage to 3x.', 'A highly leveraged balance sheet is risky.', 'Debt to equity, or leverage, fell.', 'The rules cap leverage at 7x.']) {
    assert.deepEqual(findTells(t), [], t);
  }
});

test('AI words: inflections, case, compounds, names and exceptions', () => {
  assert.deepEqual(slices('We delved into data. She delves deeper.'), ['delved into', 'delves']);
  assert.ok(has('The results underscore the risk.', 'underscore', 'ai-word'));
  assert.ok(has('Pivotal changes followed.', 'Pivotal'), 'capitalised at sentence start');
  assert.deepEqual(findTells('He spoke at Vibrant Gujarat last year.'), [], 'a name mid-sentence');
  assert.deepEqual(findTells('This is a non-crucial step.'), [], 'part of a compound');
  assert.deepEqual(slices('Rates in this ever-evolving sector.'), ['ever-evolving']);
  assert.deepEqual(slices('Rates in an ever-evolving market.'), ['in an ever-evolving market'], 'the phrase absorbs the word');
  assert.deepEqual(findTells('We use dynamic provisioning and dynamic pricing.'), []);
  assert.ok(has('It is a dynamic market.', 'dynamic'));
  assert.deepEqual(findTells('She grew up in foster homes.'), []);
  assert.ok(has('We foster trust with borrowers.', 'foster'));
  const f = findTells('Our meticulous approach.')[0];
  assert.equal(f.weight, 3);
  assert.match(f.message, /^"Meticulous": a word AI overuses\./);
});

// ---------- openers and closers ----------
test('transition openers count only at the start of a sentence or line', () => {
  assert.ok(has('Moreover, rates fell.', 'Moreover', 'transition'));
  assert.ok(has('Moreover rates fell.', 'Moreover', 'transition'));
  assert.ok(has('Rates rose. Furthermore, costs rose.', 'Furthermore', 'transition'));
  assert.ok(has('Points:\n- Additionally, costs rose.', 'Additionally', 'transition'));
  assert.ok(has('He said "no." Moreover, rates fell.', 'Moreover'));
  for (const t of ['(a) Moreover, costs rose.', '1) Furthermore, costs rose.', 'Points:\n(iv) Additionally, costs rose.', 'b) Ultimately, we grew.']) {
    assert.equal(findTells(t).filter((f) => f.category === 'opener' || f.category === 'closer').length, 1, t);
  }
  assert.deepEqual(findTells('The RBI (in its circular) moreover agreed.'), [], 'a bracket mid-sentence is not a list marker');
  assert.deepEqual(findTells('The board, moreover, agreed.'), []);
  assert.equal(ruleCount('Notably absent was the CFO.', 'transition'), 0, 'needs a comma');
  assert.ok(has('Notably, the CFO was absent.', 'Notably'));
  assert.deepEqual(findTells('In addition to home loans, we offer LAP.'), []);
  assert.equal(findTells('In addition, we offer LAP.')[0].weight, 1);
  const add = findTells('Additionally, we cut costs.');
  assert.equal(add.length, 1, 'the word and the opener count once');
  assert.equal(add[0].rule, 'transition');
});

test('closers: Ultimately and In conclusion anywhere at a start; Overall only as a closing line', () => {
  assert.ok(has('Ultimately, growth matters.', 'Ultimately', 'closer'));
  assert.deepEqual(findTells('Costs rose, which ultimately hurt margins.'), []);
  assert.equal(findTells('In conclusion, we grew.')[0].weight, 3);
  assert.ok(has('Rates fell. To sum up, we grew.', 'To sum up'));
  assert.deepEqual(findTells('Overall, disbursements grew 18%. Branch productivity improved.'), []);
  assert.ok(has('Branch productivity improved. Overall, it was a good year.', 'Overall', 'closer'));
  assert.ok(has('Overall, it was a good year.\nNext year we expect more.', 'Overall'), 'last sentence of its line');
  assert.ok(has('Margins held. At the end of the day, trust wins.', 'At the end of the day', 'sum-up'));
});

test("In today's … world/landscape openers", () => {
  assert.equal(findTells("In today's world, credit is cheap.")[0].weight, 3);
  assert.ok(has("In today’s fast-paced digital world, speed matters.", "In today’s fast-paced digital world", 'todays-world'));
  assert.ok(has("In today's competitive market, pricing matters.", "In today's competitive market"));
  assert.deepEqual(findTells("In today's market, rates are 8.5%."), []);
  assert.deepEqual(findTells("In today's meeting we approved the plan."), []);
  assert.ok(has('In an increasingly competitive lending environment, NBFCs must act.', 'In an increasingly competitive lending environment', 'era-opener'));
  assert.ok(has('In an era of cheap money, we stayed careful.', 'In an era of'));
});

// ---------- stock phrases ----------
test('stock phrases and chatbot residue', () => {
  const cases = [
    ['Branches play a key role in sourcing.', 'play a key role', 'plays-role'],
    ['DSAs played a very important role here.', 'played a very important role', 'plays-role'],
    ['This is a testament to our team.', 'a testament to', 'testament'],
    ['The branch serves as a catalyst for growth.', 'serves as a catalyst', 'serves-as'],
    ['This paves the way for growth.', 'paves the way', 'paves-way'],
    ['This marks a pivotal moment for us.', 'marks a pivotal moment', 'marks-moment'],
    ['It is important to note that rates fell.', 'It is important to note that', 'important-to'],
    ["It's worth noting that rates fell.", "It's worth noting that", 'important-to'],
    ['Worth noting: rates fell.', 'Worth noting', 'important-to'],
    ['We must navigate the complexities of regulation.', 'navigate the complexities', 'navigate-complexities'],
    ['We must unlock the full potential of our book.', 'unlock the full potential', 'unlock-potential'],
    ['Let us take a deep dive into costs.', 'a deep dive', 'deep-dive'],
    ['The stakes cannot be overstated.', 'cannot be overstated', 'urgency'],
    ['Despite these challenges, we grew.', 'Despite these challenges', 'despite-challenges'],
    ['The future looks bright for us.', 'The future looks bright', 'sendoff'],
    ['Experts believe rates will fall.', 'Experts believe', 'vague-authority'],
    ['Our strategy rests on three pillars.', 'rests on three pillars', 'pillars'],
    ['I hope this helps.', 'I hope this helps', 'chatbot'],
    ['Great question! Rates fell.', 'Great question', 'chatbot'],
    ['Certainly! Here are the numbers.', 'Certainly!', 'chatbot'],
    ['Here is a revised version of your answer.', 'Here is a revised version', 'chatbot'],
    ["Here's the thing: rates fell.", "Here's the thing", 'staged-reveal'],
    ["Let's dive into the numbers.", "Let's dive", 'explainer'],
    ['The takeaway: rates matter.', 'The takeaway:', 'colon-reveal'],
    ['GNPA fell to 1.2%, highlighting the strength of our model.', 'highlighting the', 'ing-rider'],
    ['GNPA fell, reflecting our commitment to quality.', 'reflecting our commitment', 'ing-rider'],
    ['We must strike a balance between growth and risk.', 'strike a balance', 'balance'],
    ['We drew valuable insights from the data.', 'valuable insights', 'insights'],
  ];
  for (const [t, s, r] of cases) assert.ok(has(t, s, r), `${t} → ${JSON.stringify(hits(t))}`);
});

test('ordinary uses of the same words are not flagged', () => {
  for (const t of ['It is critical that GNPA stays below 2%.', 'It is worth ₹500 crore.', 'GNPA fell to 1.2%, reflecting lower slippages in MSME.',
    'Please do not hesitate to contact me.', 'We have a role in the consortium.', 'Rates fell, highlighted by the RBI cut.',
    'The building stands on the corner.', 'Analysts expect rates to fall.', 'Of course, RBI rules apply.']) {
    assert.deepEqual(hits(t), [], t);
  }
});

// ---------- formulas ----------
test('"not just X but Y" and "it\'s not X, it\'s Y" formulas', () => {
  const t1 = 'Growth is not just about volume but about quality.';
  assert.ok(has(t1, 'not just about volume but', 'not-just-but'));
  assert.equal(findTells(t1)[0].weight, 3);
  const t2 = 'We aim not only to grow but also to stay profitable.';
  assert.ok(has(t2, 'not only to grow but also', 'not-just-but'));
  assert.equal(findTells(t2)[0].weight, 2);
  assert.ok(has("It's not a loan, it's a promise.", "It's not a loan, it's", 'not-x-its-y'));
  assert.ok(has('It’s not a loan; it’s a promise.', 'It’s not a loan; it’s', 'not-x-its-y'));
  // split across sentences: the finding covers the negative sentence only
  assert.ok(has("It's not just a loan. It's a promise.", "It's not just a loan.", 'not-x-its-y'));
  assert.ok(has('This doesn\'t mean we stop lending. It means we lend with care.', "This doesn't mean we stop lending.", 'not-x-its-y'));
  assert.ok(has("The real question isn't growth; it's quality.", "The real question isn't growth; it's", 'not-x-its-y'));
  assert.ok(has('Growth is less about volume and more about quality.', 'less about volume and more about', 'less-about'));
  assert.ok(has('We grew not because rates fell, but because we hired well.', 'not because rates fell, but because', 'not-because'));
  assert.ok(has('A home loan is more than just a loan.', 'is more than just', 'more-than-just'));
});

test('ordinary negation is not a formula', () => {
  for (const t of ['We did not lend to builders, they were risky.', 'Disbursement was not done because the file was incomplete. It was resubmitted the next week.',
    'GNPA is not high, which is good.', 'It is not easy to get approval, which is why we pre-screen.', 'We are not only lenders in Pune.',
    'This is not a concern for FY25.', 'We will not lend; the board said no.']) {
    assert.deepEqual(hits(t), [], t);
  }
});

test('rhetorical triads are flagged; factual three-item lists are not', () => {
  assert.ok(has('Our culture rests on trust, transparency and integrity.', 'trust, transparency and integrity', 'triad'));
  assert.ok(has('We value speed, simplicity, and reliability.', 'speed, simplicity, and reliability', 'triad'));
  assert.ok(has('In conclusion, the path forward lies in transparency, efficiency, and resilience.', 'transparency, efficiency, and resilience', 'triad'));
  assert.ok(has('Our answer must be faster, simpler and more transparent.', 'faster, simpler and more transparent', 'triad'));
  for (const t of ['We lend in Pune, Nashik and Nagpur.', 'We offer home loans, LAP and MSME loans.', 'Sourcing, underwriting and collections report to me.',
    'We lent ₹500 crore, ₹700 crore and ₹900 crore.', 'We value trust, transparency, integrity and excellence.',
    'RBI, SEBI and NHB regulate us.', 'Salaried, self-employed and NRI borrowers apply.', 'We met in March, April and May.',
    'He read the file, checked the property and approved the loan.', 'Branches, DSAs and connectors source our loans.']) {
    assert.equal(ruleCount(t, 'triad'), 0, t);
  }
  assert.equal(styleStats('We value speed, simplicity, and reliability.').triads, 1);
});

// ---------- -ing openers ----------
test('"-ing" participial openers', () => {
  const t = 'By seamlessly integrating technology, lenders can cut costs.';
  assert.ok(has(t, 'By seamlessly integrating technology', 'ing-opener'));
  assert.ok(has('By leveraging analytics, we cut losses.', 'By leveraging analytics', 'ing-opener'));
  assert.ok(has('Recognising the need for speed, we cut TAT.', 'Recognising the need for speed', 'ing-opener'));
  assert.ok(has('Strategically expanding our network, we grew.', 'Strategically expanding our network', 'ing-opener'));
  // plain human openers are counted for the stats but not flagged
  const plain = 'By lending only to salaried borrowers, we kept GNPA low.';
  assert.deepEqual(findTells(plain), []);
  assert.equal(styleStats(plain).ingOpeners, 1);
  for (const x of ['Excluding one-time gains, PAT grew 12%.', 'Going forward, we will focus on salaried borrowers.',
    'Lending to MSMEs, especially in smaller towns, carries risk.', 'Housing finance companies, the RBI said, must comply.',
    'Including LAP, the book is ₹9,000 crore.', 'Early warning signals, the first line of defence, matter.', 'During FY24, we grew.']) {
    assert.deepEqual(findTells(x), [], x);
    assert.equal(styleStats(x).ingOpeners, 0, x);
  }
});

// ---------- structure ----------
test('hedge stacks', () => {
  assert.ok(has('This could potentially reduce churn.', 'could potentially', 'hedge-stack'));
  assert.ok(has('It may possibly help.', 'may possibly', 'hedge-stack'));
  const t = 'Rates may perhaps fall, which could arguably help.';
  assert.equal(ruleCount(t, 'hedge-stack'), 2);
  assert.ok(has('Margins might fall and could typically stay low, which may hurt.', 'might fall and could typically stay low, which may', 'hedge-stack'));
  assert.equal(ruleCount('In May 2024 we may grow, and could hire.', 'hedge-stack'), 0, 'the month is not a hedge');
  assert.equal(ruleCount('GNPA may rise if rates could stay high.', 'hedge-stack'), 0, 'two hedges are fine');
});

test('staccato runs and self-answered questions', () => {
  const t = 'Growth slowed. Costs rose. Margins fell. We acted fast and cut costs across branches.';
  assert.equal(ruleCount(t, 'staccato'), 3);
  assert.equal(ruleCount('Growth slowed. Costs rose. We cut costs across all branches in the west.', 'staccato'), 0);
  assert.equal(ruleCount('"Oh no. Stop. Wait." she said.', 'staccato'), 0, 'dialogue');
  assert.ok(has('The result? A 30% drop in TAT.', 'The result?', 'self-answer'));
  assert.ok(has('Why? Because branches knew customers.', 'Why?', 'self-answer'));
  assert.equal(ruleCount('Is the rate fixed? Yes.', 'self-answer'), 0);
});

// ---------- punctuation ----------
test('em dashes are flagged only when dense; ranges never count', () => {
  const one = 'Collections improved — mostly in the west. We expect more of the same next year from our branches.';
  assert.deepEqual(findTells(one), []);
  const many = 'Growth — strong. Costs — lower. Risk — contained. We did well.';
  assert.equal(ruleCount(many, 'em-dash'), 3);
  assert.ok(findTells(many).filter((f) => f.rule === 'em-dash').every((f) => many.slice(f.start, f.end) === '—'));
  assert.ok(flagged(many).includes('emDashPer100'));
  assert.equal(styleStats('FY2023–24 and FY2024—25 loans of ₹5–10 lakh rose 10–12%.').emDashPer100, 0);
  const spaced = 'Growth – strong. Costs -- lower. Risk – fine.';
  assert.equal(ruleCount(spaced, 'em-dash'), 3);
  assert.ok(styleStats(spaced).emDashPer100 > 1);
  assert.equal(styleStats('Use the --verbose flag.\n---\nDone.').emDashPer100, 0, 'CLI flags and rules');
});

test('"Label:" lines', () => {
  const t = '**Credit Quality:** Our GNPA improved to 1.2% this year.\n**Growth:** AUM grew 24% on demand from towns.';
  assert.deepEqual(findTells(t).filter((f) => f.rule === 'label-colon').map((f) => t.slice(f.start, f.end)), ['**Credit Quality:', '**Growth:']);
  const plain = 'Credit: Our GNPA improved to 1.2% this year.\nGrowth: AUM grew 24% on demand from towns.\nRisk: We kept LTV under 60% on all loans.';
  assert.equal(ruleCount(plain, 'label-colon'), 3);
  const crlf = plain.replace(/\n/g, '\r\n');
  assert.deepEqual(findTells(crlf).filter((f) => f.rule === 'label-colon').map((f) => crlf.slice(f.start, f.end)), ['Credit:', 'Growth:', 'Risk:']);
  assert.ok(flagged(plain).includes('colonLines'));
  for (const x of ['Note: all figures are provisional and unaudited.', 'Our rule is simple: lend against property.\nOur aim is clear: keep LTV low.',
    'Time: 10:30 am on Monday\nVenue: 3rd floor, head office', 'FY24: ₹2,000 crore disbursed\nFY25: ₹2,600 crore disbursed', 'See https://rbi.org.in for details.']) {
    assert.equal(ruleCount(x, 'label-colon'), 0, x);
  }
  assert.equal(styleStats('Our priorities:\n- growth\n- quality').colonLines, 1);
});

// ---------- offsets ----------
test('offsets slice to the matched text with Unicode, emoji, CRLF and Hindi around them', () => {
  const t = '₹2,000 करोड़ 😀 last year.\r\nMoreover, it is crucial — truly — that we foster trust 🙂 — always.\r\nUltimately, it’s not a loan, it’s a promise.';
  const list = assertWellFormed(t);
  const got = list.map((f) => t.slice(f.start, f.end));
  for (const s of ['Moreover', 'crucial', 'foster', '—', 'Ultimately', 'it’s not a loan, it’s']) assert.ok(got.includes(s), `${s} in ${JSON.stringify(got)}`);
});

test('findings never overlap twice for the same rule and words inside phrases count once', () => {
  for (const t of [EXAMPLE, ...AI_SET]) {
    const list = findTells(t);
    const keys = list.map((f) => `${f.start}:${f.end}:${f.rule}`);
    assert.equal(new Set(keys).size, keys.length);
    const formulas = list.filter((f) => f.category === 'formula');
    for (let i = 1; i < formulas.length; i++) assert.ok(formulas[i].start >= formulas[i - 1].end, 'formulas do not overlap');
  }
});

// ---------- styleStats ----------
test('styleStats shape and values for the example', () => {
  const st = styleStats(EXAMPLE);
  assert.deepEqual(Object.keys(st).sort(), ['colonLines', 'contractionsPer100', 'cvLen', 'emDashPer100', 'flags', 'ingOpeners', 'meanLen', 'sentences', 'triads'].sort());
  assert.equal(st.sentences, 6);
  const lens = splitSentences(EXAMPLE).map((s) => words(s.text));
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  assert.ok(Math.abs(st.meanLen - mean) < 1e-9);
  assert.ok(st.cvLen > 0.2 && st.cvLen < 0.3, String(st.cvLen));
  assert.equal(st.contractionsPer100, 0);
  assert.equal(st.emDashPer100, 0);
  assert.equal(st.ingOpeners, 1);
  for (const f of st.flags) assert.ok(typeof f.stat === 'string' && Number.isFinite(f.value) && f.message.length > 10);
});

test('styleStats flags uniform sentence length but not varied length or short texts', () => {
  const uniform = 'We grew the retail book by twenty percent this year. We cut credit costs by thirty basis points too. '
    + 'We opened forty new branches across three western states. We hired two hundred new credit officers in the field. '
    + 'We raised fresh equity from two large global investors. We kept our capital ratio well above the regulatory floor.';
  const st = styleStats(uniform);
  assert.ok(st.cvLen < 0.25);
  assert.ok(flagged(uniform).includes('cvLen'));
  assert.match(st.flags.find((f) => f.stat === 'cvLen').message, /same length/);
  const varied = 'We grew. The retail book rose twenty percent this year on strong demand from salaried buyers in smaller towns across the west. '
    + 'Costs fell. We opened forty branches. Hiring was hard in the north, where competition from banks for credit officers was intense all year. Margins held.';
  assert.ok(!flagged(varied).includes('cvLen'));
  assert.ok(!flagged('We grew. We grew again. We grew more.').includes('cvLen'), 'too few sentences to judge');
});

test('styleStats: long sentences, contractions, -ing openers and triads', () => {
  const long = 'Our retail mortgage business, which we built over two decades through a branch-led model in Tier 2 and Tier 3 towns, now accounts for most of our disbursements and nearly all of our fee income in the western region. '
    + 'The collections team, which reports to the chief risk officer rather than to the business heads, reviews every account that misses two instalments in a row and decides on the next step within a week of the second miss. '
    + 'Credit decisions above ₹1 crore go to a committee that meets twice a week, includes an independent director, and records its reasons for every approval and every rejection in the loan file.';
  assert.ok(flagged(long).includes('meanLen'));
  const c = styleStats("We can't lend there. It's risky, and they'll know. The bank's view and the RBI's view differ.");
  assert.ok(Math.abs(c.contractionsPer100 - (3 / 17) * 100) < 1e-9, String(c.contractionsPer100));
  assert.ok(!flagged("We don't, can't, won't and shouldn't.").includes('contractionsPer100'), 'contractions are never flagged');
  const ing = 'Leveraging data, we cut losses. Harnessing our network, we grew. Recognising the risk, we slowed. Rates fell.';
  assert.equal(styleStats(ing).ingOpeners, 3);
  assert.ok(flagged(ing).includes('ingOpeners'));
  const tri = 'We stand for trust, transparency and integrity. We value speed, simplicity and reliability. Rates fell.';
  assert.equal(styleStats(tri).triads, 2);
  assert.ok(flagged(tri).includes('triads'));
});

// ---------- tellsBySentence ----------
test('tellsBySentence aligns with sentences and sums weights', () => {
  const sents = splitSentences(EXAMPLE);
  const per = tellsBySentence(EXAMPLE, sents);
  assert.equal(per.length, sents.length);
  const all = findTells(EXAMPLE);
  assert.equal(per.reduce((a, s) => a + s.count, 0), all.length);
  assert.equal(per.reduce((a, s) => a + s.weight, 0), all.reduce((a, f) => a + f.weight, 0));
  assert.deepEqual(per[0].rules, ['todays-world', 'ai-word']);
  assert.ok(per[5].rules.includes('not-x-its-y') && per[5].rules.includes('closer'));
  assert.deepEqual(tellsBySentence(EXAMPLE), per, 'defaults to splitSentences');
  for (const s of per) assert.equal(new Set(s.rules).size, s.rules.length, 'rules are unique');
});

test('tellsBySentence: human text, custom spans, overlaps and bad entries', () => {
  assert.ok(tellsBySentence(HUMAN).every((s) => s.count === 0 && s.weight === 0 && s.rules.length === 0));
  const t = 'Moreover, rates fell. Costs rose.';
  // a span covering both sentences sees the tell; an empty list gives an empty result
  assert.deepEqual(tellsBySentence(t, [{ start: 0, end: t.length }]), [{ count: 1, weight: 2, rules: ['transition'] }]);
  assert.deepEqual(tellsBySentence(t, []), []);
  assert.deepEqual(tellsBySentence(t, [null, { start: 'x' }, { start: 22, end: 33 }]),
    [{ count: 0, weight: 0, rules: [] }, { count: 0, weight: 0, rules: [] }, { count: 0, weight: 0, rules: [] }]);
  // a tell that straddles two custom spans counts in both
  const u = 'Growth is not just about volume but about quality.';
  const mid = u.indexOf('volume');
  const both = tellsBySentence(u, [{ start: 0, end: mid }, { start: mid, end: u.length }]);
  assert.ok(both[0].rules.includes('not-just-but') && both[1].rules.includes('not-just-but'));
});

// ---------- BAN_LIST and data ----------
test('BAN_LIST: 60-120 unique, lower-case phrases with no domain words', () => {
  assert.ok(Array.isArray(BAN_LIST));
  assert.ok(BAN_LIST.length >= 60 && BAN_LIST.length <= 120, String(BAN_LIST.length));
  assert.equal(new Set(BAN_LIST).size, BAN_LIST.length);
  for (const p of BAN_LIST) assert.ok(typeof p === 'string' && p === p.trim() && p === p.toLowerCase() && p.length > 1, p);
  for (const p of ['delve', 'moreover', 'plays a pivotal role', "in today's world", 'not just … but', 'seamless', 'ultimately']) assert.ok(BAN_LIST.includes(p), p);
  const banned = BAN_LIST.join(' | ');
  for (const w of ['implement', 'prioriti', 'optimi', 'facilitate', 'robust', 'portfolio', 'underwriting', 'disburse', 'sanction', 'utilis', 'significant', 'comprehensive']) {
    assert.ok(!banned.includes(w), `${w} is a domain word`);
  }
  assert.equal(data.BAN_LIST, BAN_LIST);
});

test('rule data is well formed', () => {
  const forms = data.AI_WORDS.flatMap(([f]) => f.split(' '));
  assert.equal(new Set(forms).size, forms.length, 'no duplicate word forms');
  for (const [f, w, tip] of data.AI_WORDS) assert.ok(f && [1, 2, 3].includes(w) && /\.$/.test(tip), f);
  for (const list of [data.PHRASES, data.CONTRASTS]) {
    for (const [re, rule, cat, w, msg] of list) {
      assert.ok(re instanceof RegExp && re.global, `${rule} is a global regex`);
      assert.ok(CATEGORIES.has(cat) && typeof rule === 'string' && /\.$/.test(msg), rule);
      assert.ok(typeof w === 'function' || [1, 2, 3].includes(w), rule);
    }
  }
  for (const w of data.DOMAIN_SAFE) assert.ok(!forms.includes(w), `${w} is in AI_WORDS`);
});

test('source has no regex lookbehind (older Safari)', () => {
  for (const f of ['tells.mjs', 'tells-data.mjs']) {
    const src = readFileSync(new URL(`../../ai-checker/src/${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('(?<=') && !src.includes('(?<!'), f);
  }
  const all = [...data.PHRASES, ...data.CONTRASTS, ...data.OPENERS].map(([re]) => re.source)
    .concat([data.LEVERAGE_VERB.source, data.HEDGES.source, data.STACKED_HEDGE.source], Object.values(data.WORD_EXCEPTIONS).map((r) => r.source));
  for (const s of all) assert.ok(!s.includes('(?<=') && !s.includes('(?<!'), s);
});

// ---------- review regressions ----------
// More plain human finance writing (letters, results commentary, Q&A): must come back clean.
const HUMAN_MORE = [
  'Our AUM grew 24% to ₹68,500 crore in FY2023-24, driven mainly by home loans and LAP. GNPA was 1.6% and NNPA 0.9% as on 31 March 2024.',
  'The Board approved a dividend of ₹2.50 per share. We also raised ₹1,500 crore through NCDs at 8.65% p.a. and a further ₹750 crore from banks.',
  'With regard to your query on the restructured book, it stood at ₹410 crore, i.e. 0.6% of AUM. Most of these accounts are now regular.',
  'The co-applicant stood as guarantor for the loan, and the property was mortgaged in our favour.',
  'He stood as a guarantor for the loan. His brother stands as a co-borrower.',
  'It is not possible to give a branch-wise break-up at this stage. It is likely we will share it with the Q2 results.',
  'It is not clear whether the RBI will act. It is likely to wait.',
  'This is not a new rule. It was introduced in 2019.',
  'Asset quality, liquidity and capital adequacy remain comfortable.',
  'Our priorities are growth, asset quality and profitability.',
  'However, it is efficient and reliable.',
  'We reviewed the current, previous and next quarter.',
  'By only lending to salaried borrowers, we kept GNPA low.',
  'By quickly resolving complaints, we kept our customers.',
  'By regularly reviewing accounts, we caught stress early.',
  'Disbursements fell 10%, reflecting the broader slowdown in housing demand.',
  'Yields rose, reflecting the strength of demand.',
  'Leverage stood at 4.1x, well below the ceiling. We do not intend to leverage beyond 5x.',
  'Leverage was 4.1x. We have room to leverage further, but we will not.',
  'Our leverage remains low. Management may leverage the balance sheet if demand picks up. We can leverage 5x under the norms.',
  'We are averse to leverage. Our exposure to leverage is low, and we will cut exposure to leverage.',
  'In May leverage rose to 5x. Tier I leverage requirement is met.',
  'Vibrant Gujarat 2024 brought large MoUs for housing.',
  'Rest assured, we will resolve this within a week.',
  'Basel II rests on three pillars, and Pillar 3 covers disclosure.',
  'Here is a short note on the Nagpur branch. Collections there are back to normal.',
  'Key highlights:\n- GNPA: 1.2%.\n- NNPA: 0.6%.\n- CRAR: 22%.',
  'Thank you. Regards. Rahul.',
  'Q: What was GNPA in FY24?\nA: GNPA was 1.2% at the end of FY24.\nQ: And NNPA?\nA: NNPA was 0.6% on the same date.',
  'To: The Board of Directors\nFrom: Chief Financial Officer\nSubject: Request for additional borrowing limits\nDate: 12 June 2024',
  'Interest rates have risen sharply; borrowers are therefore more careful. Hence, we have seen some slowdown in the self-employed segment.',
];

test('review: more human finance writing produces no findings or flags', () => {
  for (const t of HUMAN_MORE) {
    assert.deepEqual(hits(t), [], t);
    assert.deepEqual(flagged(t), [], t);
    assertWellFormed(t);
  }
});

test('review: a phrase inside a longer phrase of the same kind counts once', () => {
  assert.deepEqual(hits("It's worth noting that rates fell."), [["It's worth noting that", 'important-to']]);
  assert.deepEqual(hits('This marks a watershed moment for us.'), [['marks a watershed moment', 'marks-moment']]);
  assert.deepEqual(hits('It stands as a testament to our team.'), [['stands as a testament to', 'testament']]);
  assert.equal(weight('It stands as a testament to our team.'), 2);
  // different categories still count separately: the formula and the opener are two tells
  assert.deepEqual(hits('Ultimately, it is not just about growth; it is about trust.').map(([, r]) => r), ['closer', 'not-x-its-y']);
});

test('review: inflated-significance phrases that the first version missed', () => {
  assert.ok(has('This marks a turning point for the company.', 'marks a turning point', 'marks-moment'));
  assert.ok(has('It represents a watershed for lenders.', 'represents a watershed', 'marks-moment'));
  assert.ok(has('The branch serves as a symbol of trust.', 'serves as a symbol', 'serves-as'));
  assert.ok(has('GNPA fell, reinforcing our position as a leader.', 'reinforcing our position', 'ing-rider'));
  assert.ok(has('GNPA fell, demonstrating the strength of our model.', 'demonstrating the strength', 'ing-rider'));
  assert.ok(has('GNPA fell, reflecting the importance of discipline.', 'reflecting the importance', 'ing-rider'));
  assert.ok(has('Our strategy rests on three pillars.', 'rests on three pillars', 'pillars'));
});

test('review: formulas run across decimals and "Rs." and are not cut short', () => {
  assert.ok(has('GNPA is not only below 1.5% but also falling.', 'not only below 1.5% but also', 'not-just-but'));
  assert.ok(has('We lend not just to salaried Rs. 5 lakh earners but also to the self-employed.', 'not just to salaried Rs. 5 lakh earners but also', 'not-just-but'));
  assert.ok(has('We lend not just in Pune, e.g. in Nashik, but across the state.', 'not just in Pune, e.g. in Nashik, but', 'not-just-but'));
  assert.ok(has('Our book is not just 2.5x bigger, it is safer.', 'is not just 2.5x bigger, it is', 'not-x-its-y'));
  assert.ok(has('We grew not because rates fell 0.5%, but because we hired well.', 'not because rates fell 0.5%, but because', 'not-because'));
  // a real sentence end still stops the gap
  assert.equal(ruleCount('We lend not only in Pune. But we also lend in Nashik.', 'not-just-but'), 0);
  assert.equal(ruleCount('It is not 1. It is 2.', 'not-x-its-y'), 1);
});

test('review: findings never cross a sentence boundary, even where the splitter breaks after "Mr."', () => {
  const texts = [...HUMAN_SET, ...HUMAN_MORE, EXAMPLE, ...AI_SET,
    'This is not just about Mr. Rao, it is about trust.', "It's not about rates.\nIt's about trust.",
    'We met Mr. Rao. It is not just a loan, it is trust.', 'Our view? Simple. Lend carefully.',
    'It is not a loan.\n\nIt is a promise.', 'Not just growth.  But quality too, and more of it.'];
  for (const t of texts) {
    const sents = splitSentences(t);
    for (const f of findTells(t)) {
      assert.ok(sents.some((s) => f.start >= s.start && f.end <= s.end), `"${t.slice(f.start, f.end)}" crosses a sentence in ${JSON.stringify(t)}`);
    }
    assertWellFormed(t);
  }
  const t = 'This is not just about Mr. Rao, it is about trust.';
  const f = findTells(t).find((x) => x.rule === 'not-x-its-y');
  assert.ok(f, 'still reported, inside the first sentence');
  assert.equal(t.slice(f.start, f.end), 'is not just about Mr.');
});

test('review: "leverage" as the AI verb only, never the noun or the finance verb', () => {
  for (const [t, s] of [['We will leverage our branch network.', 'leverage'], ['We must leverage our data and our network.', 'leverage'],
    ['Let’s leverage AI in collections.', 'leverage'], ['We plan to leverage digital channels.', 'leverage'], ['We will leverage on our strengths.', 'leverage']]) {
    assert.ok(has(t, s, 'ai-word'), t);
  }
  for (const t of ['We are averse to leverage.', 'Exposure to leverage is low.', 'Our appetite to leverage and growth is limited.',
    'In May leverage rose to 5x.', 'Tier I leverage requirement is met.', 'We will leverage up the balance sheet.', 'We may leverage-up later.',
    'We can leverage 5x under the norms.', 'We do not intend to leverage beyond 5x.', 'We could leverage our net worth further.',
    'We will leverage the balance sheet.', 'Lenders want to leverage.']) {
    assert.equal(ruleCount(t, 'ai-word'), 0, t);
  }
});

test('review: triads skip clauses, sentence adverbs and lists that qualify a domain noun', () => {
  for (const t of ['However, it is efficient and reliable.', 'Moreover, efficient and reliable systems matter.',
    'We reviewed the current, previous and next quarter.', 'Growth, asset quality and profitability improved.',
    'Our loans are faster, simpler and cheaper loans than banks offer.', 'Today, it was effective and transparent.']) {
    assert.equal(ruleCount(t, 'triad'), 0, t);
  }
  assert.ok(has('Our culture rests on trust, transparency and integrity in lending.', 'trust, transparency and integrity', 'triad'));
});

test('review: "-ing" openers flag AI adverbs and participles, not plain ones', () => {
  for (const t of ['By only lending to salaried borrowers, we kept GNPA low.', 'By quickly resolving complaints, we kept customers.',
    'By carefully checking each file, we cut fraud.', 'Quickly reviewing the file, we approved it.']) {
    assert.equal(ruleCount(t, 'ing-opener'), 0, t);
    assert.equal(styleStats(t).ingOpeners, 1, t);
  }
  assert.ok(has('By strategically expanding our network, we grew.', 'By strategically expanding our network', 'ing-opener'));
  assert.ok(has('Proactively addressing stress, we cut losses.', 'Proactively addressing stress', 'ing-opener'));
  // the span runs to the clause comma, not the comma inside ₹1,000
  assert.ok(has('By leveraging ₹1,000 crore of capital, we grew.', 'By leveraging ₹1,000 crore of capital', 'ing-opener'));
});

test('review: staccato ignores figure lists, bullets and sign-offs', () => {
  assert.equal(ruleCount('- GNPA: 1.2%.\n- NNPA: 0.6%.\n- CRAR: 22%.', 'staccato'), 0);
  assert.equal(ruleCount('- Growth slowed.\n- Costs rose.\n- Margins fell.', 'staccato'), 0, 'bulleted items');
  assert.equal(ruleCount('Rates rose. Thank you. Regards. Rahul.', 'staccato'), 0);
  assert.equal(ruleCount('Growth slowed. Costs rose. Margins fell.', 'staccato'), 3);
  assert.equal(ruleCount('Growth slowed.\nCosts rose.\nMargins fell.', 'staccato'), 3, 'one per line is still drama');
});

test('review: self-answered questions are found one after another, but not question chains', () => {
  assert.deepEqual(hits('Why? How? Because we cared.'), [['How?', 'self-answer']]);
  assert.deepEqual(hits('The result? A 30% drop. The cost? Nothing.').map(([s]) => s), ['The result?', 'The cost?']);
  assert.equal(ruleCount('Why? Why not?', 'self-answer'), 0);
  assert.equal(ruleCount('The result?', 'self-answer'), 0, 'no answer follows');
});

test('review: letter, memo and Q&A fields are not "Label:" lines', () => {
  const memo = 'To: The Board of Directors\nFrom: Chief Financial Officer\nSubject: Request for additional borrowing limits\nDate: 12 June 2024';
  assert.equal(ruleCount(memo, 'label-colon'), 0);
  assert.equal(styleStats(memo).colonLines, 0);
  const qa = 'Question: What was GNPA in FY24?\nAnswer: GNPA was 1.2% at the end of the year.\nNote: All figures are unaudited.';
  assert.equal(ruleCount(qa, 'label-colon'), 0);
  assert.equal(styleStats('Subject:\nNotes:\nAgenda:').colonLines, 0);
  // real AI label lines are still found among them
  const mixed = `${memo}\n\nCredit Quality: Our GNPA improved to 1.2% this year.\nGrowth: AUM grew 24% on demand from towns.`;
  assert.deepEqual(findTells(mixed).filter((f) => f.rule === 'label-colon').map((f) => mixed.slice(f.start, f.end)), ['Credit Quality:', 'Growth:']);
});

test('review: chatbot wrappers and names at the start of a sentence', () => {
  assert.equal(findTells('Here is a brief summary of our FY24 performance.')[0].weight, 1);
  assert.equal(findTells("Here's a detailed breakdown of FY24.")[0].weight, 3);
  assert.equal(findTells('Here is a revised version of your answer.')[0].weight, 3);
  assert.deepEqual(findTells('Vibrant Gujarat 2024 brought large MoUs.'), []);
  assert.ok(has('Vibrant towns grow fast.', 'Vibrant', 'ai-word'), 'still a word when no name follows');
  assert.ok(has('Crucial RBI rules apply.', 'Crucial', 'ai-word'), 'an acronym after it is not a name');
  assert.equal(findTells('Customer interest is paramount.')[0].weight, 1);
});

// ---------- performance ----------
test('a 1,000-word answer is analysed in under 20 ms', () => {
  let base = '';
  while (words(base) < 1000) base += `${EXAMPLE}\n\n${HUMAN_SET[1]}\n\n${AI_SET[0]}\n\n`;
  findTells(base + ' warm-up'); styleStats(base + ' warm-up');
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t = `${base} Run ${i}.`;  // a new text each time, so nothing is cached
    const a = performance.now();
    findTells(t); styleStats(t); tellsBySentence(t);
    times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[3] < 20, `median ${times[3].toFixed(1)} ms`);
});

test('adversarial long inputs stay fast (no catastrophic backtracking)', () => {
  const nasty = ['a'.repeat(50000), 'word '.repeat(10000), 'not just '.repeat(3000), 'it is not '.repeat(3000), ', x'.repeat(10000),
    'x, y, and '.repeat(5000), 'By doing '.repeat(5000), '—'.repeat(20000), 'Label: something long enough here\n'.repeat(2000),
    'could potentially may possibly '.repeat(2000), 'The result? '.repeat(5000), `${'is not about '.repeat(4000)}; it is about`,
    `In today's ${'very '.repeat(5000)}world`, `${'a'.repeat(30000)}ing, we`, ' '.repeat(50000), '\n'.repeat(50000),
    'not just Rs. 1.5 e.g. '.repeat(3000), 'it is not Rs. 2.5 i.e. '.repeat(3000), 'not because 1.5 '.repeat(4000),
    'Subject: something here\n'.repeat(3000), 'Why? '.repeat(5000), 'By quickly doing '.repeat(4000)];
  for (const s of nasty) {
    const a = performance.now();
    findTells(s); styleStats(s);
    const ms = performance.now() - a;
    assert.ok(ms < 400, `${JSON.stringify(s.slice(0, 15))}… took ${ms.toFixed(0)} ms`);
  }
});
