import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sentencePrompt, batchVariantsPrompt, parseVariantsReply, humanizerPrompt, interviewQuestions, interviewPrompt,
  cleanOutput, forModel, pickBans, keepList, lengthHint, VARIANTS, HUMANIZER_INSTR, HUMANIZER_SEP, HUMANIZER_SAMPLING,
} from '../../ai-checker/src/rewrite/prompts.mjs';
import { BAN_LIST, findTells } from '../../ai-checker/src/tells.mjs';

const S1 = "In today's dynamic lending landscape, growing a retail mortgage book requires a holistic approach that balances ambition with prudence.";
const S2 = 'First and foremost, it is important to leverage data-driven underwriting to identify creditworthy segments, particularly in Tier 2 and Tier 3 cities where demand for affordable housing continues to rise.';
const S3 = 'Moreover, fostering strong partnerships with builders and DSAs plays a pivotal role in sourcing quality customers at scale.';
const FACTS = 'We may not lend more than ₹2,000 crore to DSAs in FY24, as RBI norms cap LTV at 80%.';
const PARA2 = 'Furthermore, robust early-warning systems and proactive collection strategies are crucial to keeping GNPA below 1.5%. '
  + 'By seamlessly integrating technology across the loan lifecycle, from sourcing to disbursement and servicing, lenders can reduce turnaround time while enhancing the overall customer experience. '
  + 'Ultimately, sustainable growth is not just about volumes; it is about building a resilient franchise that delivers long-term value for all stakeholders.';
const VOICE = 'Senior retail-lending executive in India with 30 years of experience. Writes plain, direct business English.';
// Prompt framing must never talk about checkers or evasion (it draws refusals and stiffer writing).
const BAD_FRAMING = /detect|undetect|evad|evasion|bypass|\bAI\b|language model|humani[sz]|plagiar|chatgpt|\bGPT\b|fool|trick/i;
const withoutBanLine = (t) => t.split('\n').filter((l) => !/Avoid these words and phrases/.test(l)).join('\n');
const sha16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const entries = (m) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));

describe('humanizerPrompt', () => {
  test('builds the exact completion wrapper from sgaofen/humanizer-local-model', () => {
    const expected = 'Rewrite the text below so it reads like a person wrote it, not a language model.\n\n'
      + 'Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\n'
      + 'throat-clearing, and any sentence that only announces what comes next.\n'
      + 'Prefer the concrete word over the abstract one. It is fine to sound uneven.\n\n'
      + 'Every fact, number, unit, date, name and quotation must survive unchanged.\n\n'
      + 'My draft.\n\n### Rewritten:\n\n';
    assert.equal(humanizerPrompt('My draft.'), expected);
    assert.equal(HUMANIZER_SEP, '\n\n### Rewritten:\n\n');
    assert.ok(!HUMANIZER_INSTR.endsWith('\n'));
  });

  test('matches the published format fingerprint', () => {
    assert.equal(sha16(humanizerPrompt('X')), 'cc51d66b4c593fbe');
  });

  test('strips the draft like Python str.strip(), keeping the inside byte for byte', () => {
    const draft = 'Line one: ₹1,00,000 at 1.5%.\n\n  Line two  (FY2023-24).';
    assert.equal(humanizerPrompt(`\n\t  ${draft} \n\n`), `${HUMANIZER_INSTR}\n\n${draft}${HUMANIZER_SEP}`);
    // Python strips U+3000, U+0085 and U+001C..U+001F; it keeps U+FEFF (JS trim would not)
    assert.equal(humanizerPrompt('　\u0085\u001cX  '), humanizerPrompt('X'));
    assert.equal(humanizerPrompt('\ufeffX\ufeff'), `${HUMANIZER_INSTR}\n\n\ufeffX\ufeff${HUMANIZER_SEP}`);
  });

  test('never throws on odd input', () => {
    assert.equal(humanizerPrompt(''), `${HUMANIZER_INSTR}\n\n${HUMANIZER_SEP}`);
    assert.equal(humanizerPrompt(null), humanizerPrompt(''));
    assert.equal(humanizerPrompt(42), humanizerPrompt('42'));
  });

  test('exports the recommended sampling settings', () => {
    assert.deepEqual({ ...HUMANIZER_SAMPLING }, { temperature: 1, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1 });
    assert.ok(Object.isFrozen(HUMANIZER_SAMPLING));
  });
});

describe('sentencePrompt', () => {
  const base = { before: S1, sentence: S2, after: S3, voice: VOICE, samples: [] };

  test('returns system and user strings with the target marked on its own line', () => {
    const r = sentencePrompt(base);
    assert.deepEqual(Object.keys(r).sort(), ['system', 'user']);
    assert.ok(r.user.split('\n').includes(`⟦${S2}⟧`));
    assert.ok(r.user.includes(`Before: ${S1}`));
    assert.ok(r.user.includes(`After: ${S3}`));
    // context sentences never stand alone on a line (a model, or the e2e stub, could take them for the target)
    for (const line of `${r.system}\n${r.user}`.split(/\n|⟦|⟧/)) assert.ok(line.trim() !== S1 && line.trim() !== S3);
    assert.match(r.system, /only the sentence between ⟦ and ⟧/);
    assert.match(r.user, /Reply with the rewritten sentence only\.$/);
  });

  test('carries the voice and the keep-exactly rules', () => {
    const r = sentencePrompt({ ...base, sentence: FACTS });
    assert.ok(r.system.includes(`About the author: ${VOICE}`));
    assert.match(r.system, /number, amount, percentage, date and period exactly as written/);
    assert.match(r.system, /negation/);
    assert.match(r.system, /may, might, will, would, must, should, could, can and shall/);
    assert.match(r.system, /no new facts, figures, names, examples or anecdotes/);
    const keep = r.user.split('\n').find((l) => l.startsWith('Keep exactly as written:'));
    for (const f of ['₹2,000 crore', 'FY24', '80%', 'RBI', 'DSAs', 'LTV', 'not', 'may']) assert.ok(keep.includes(f), f);
  });

  test('the four variants differ, and only "more personal" allows a placeholder', () => {
    const rs = [0, 1, 2, 3].map((variant) => sentencePrompt({ ...base, variant }));
    assert.equal(new Set(rs.map((r) => r.user)).size, 4);
    assert.match(rs[0].user, /plainer/i);
    assert.match(rs[1].user, /more personal/i);
    assert.match(rs[2].user, /Restructure/);
    assert.match(rs[3].user, /own voice/);
    for (const [i, r] of rs.entries()) {
      const both = `${r.system}\n${r.user}`;
      assert.equal(both.includes('[your example]'), i === 1, `variant ${i}`);
    }
    assert.match(rs[1].system, /exception: a bracketed placeholder/);
  });

  test('variant accepts names, wraps around and defaults to plainer', () => {
    const user = (variant) => sentencePrompt({ ...base, variant }).user;
    assert.equal(user(5), user(1));
    assert.equal(user(-1), user(3));
    assert.equal(user('restructured'), user(2));
    assert.equal(user('Your Voice'), user(3));
    assert.equal(user('nonsense'), user(0));
    assert.equal(user(undefined), user(0));
    assert.equal(user(NaN), user(0));
    assert.deepEqual(VARIANTS, ['plainer', 'more personal', 'restructured', 'your voice']);
  });

  test('uses up to three writing samples as style reference only', () => {
    const samples = ['First sample about our Nagpur branch.', { text: 'Second sample as an object.' }, '   ', 'Third.', 'Fourth is dropped.'];
    const r = sentencePrompt({ ...base, samples, variant: 3 });
    assert.match(r.user, /never reuse their content/);
    assert.ok(r.user.includes('First sample about our Nagpur branch.'));
    assert.ok(r.user.includes('Second sample as an object.'));
    assert.ok(r.user.includes('--- Sample 3 ---\nThird.'));
    assert.ok(!r.user.includes('Fourth'));
    assert.match(r.user, /following the samples/);
    const none = sentencePrompt({ ...base, samples: [], variant: 3 });
    assert.ok(!/Sample/.test(none.user));
    assert.match(none.user, /own voice as described/);
  });

  test('long samples and context are clipped', () => {
    const long = `${'We lend carefully in small towns. '.repeat(60)}`;
    const r = sentencePrompt({ ...base, samples: [long], before: long });
    const sample = r.user.split('--- Sample 1 ---\n')[1].split('\n')[0];
    assert.ok(sample.length <= 700 && sample.length > 300);
    const before = r.user.split('\n').find((l) => l.startsWith('Before: '));
    assert.ok(before.length <= 610);
  });

  test('ban list: phrases the text uses come first, capped, and can be replaced', () => {
    const r = sentencePrompt(base);
    const line = r.system.split('\n').find((l) => l.includes('Avoid these words and phrases'));
    const listed = line.replace(/^- Avoid these words and phrases: /, '').replace(/\.$/, '').split('; ');
    assert.ok(listed.length <= 40);
    for (const p of ['first and foremost', 'leverage (as a verb)', 'holistic', 'landscape', 'moreover', 'pivotal']) {
      assert.ok(listed.indexOf(p) >= 0 && listed.indexOf(p) < 12, p);
    }
    const custom = sentencePrompt({ ...base, banList: ['synergy', 'going forward'] });
    assert.match(custom.system, /Avoid these words and phrases: synergy; going forward\./);
    assert.ok(!/Avoid these/.test(sentencePrompt({ ...base, banList: [] }).system));
    assert.ok(!/Avoid these/.test(sentencePrompt({ ...base, banList: null }).system));
  });

  test('frames the task as editing the author\'s own draft, never as evading checkers', () => {
    for (let variant = 0; variant < 4; variant++) {
      const r = sentencePrompt({ ...base, variant, samples: ['A sample.'] });
      assert.doesNotMatch(withoutBanLine(`${r.system}\n${r.user}`), BAD_FRAMING);
      assert.match(r.system, /edit their own draft/);
    }
  });

  test('Qwen3 models get /no_think at the end of the user turn; others do not', () => {
    for (const model of ['Qwen3-4B-q4f16_1-MLC', 'qwen3-8b', 'Qwen-3 1.7B']) {
      const r = sentencePrompt({ ...base, model });
      assert.match(r.user, /\n\n\/no_think$/);
      assert.ok(!r.system.includes('/no_think'));
    }
    for (const model of [undefined, '', 'Llama-3.1-8B', 'Qwen2.5-7B', 'humanizer-12b-Q8_0.gguf']) {
      assert.ok(!sentencePrompt({ ...base, model }).user.includes('/no_think'), String(model));
    }
  });

  test('edge cases: first, last, lone and empty sentences', () => {
    assert.match(sentencePrompt({ sentence: S2, after: S3 }).user, /Before: \(this is the first sentence\)/);
    assert.match(sentencePrompt({ sentence: S2, before: S1 }).user, /After: \(this is the last sentence\)/);
    assert.match(sentencePrompt({ sentence: S2 }).user, /the sentence stands alone/);
    const empty = sentencePrompt();
    assert.equal(typeof empty.system, 'string');
    assert.ok(empty.user.includes('⟦⟧'));
    assert.ok(!/About the author/.test(sentencePrompt({ sentence: S2 }).system));
    assert.ok(!/null|undefined/.test(JSON.stringify(sentencePrompt({ sentence: S2, voice: null, samples: null, before: null }))));
  });
});

describe('lengthHint', () => {
  test('gives a concrete cue that varies the rhythm', () => {
    assert.match(lengthHint('', S2, ''), /two shorter sentences/);  // 31 words
    assert.match(lengthHint(S2, 'We lend with care in small towns.', S1), /noticeably shorter/);
    assert.match(lengthHint('We lend.', 'Small towns pay back well.', 'Defaults stay low.'), /fuller sentence/);
    assert.match(lengthHint('', 'Small towns pay back well.', ''), /differ/);
    assert.match(lengthHint(null, null, null), /differ/);
  });
});

describe('batchVariantsPrompt', () => {
  const items = [{ id: 3, before: S1, sentence: S2, after: S3 }, { id: 7, before: S2, sentence: S3, after: '' }];

  test('asks for one JSON object keyed by the ids', () => {
    const p = batchVariantsPrompt({ items, voice: VOICE, samples: ['My own sample text.'], n: 4 });
    assert.equal(typeof p, 'string');
    assert.match(p, /one JSON object and nothing else/);
    assert.match(p, /Use exactly these keys: "3", "7"\./);
    // the e2e test finds the ids this way
    assert.deepEqual([...new Set([...p.matchAll(/"(\d+)"\s*:/g)].map((m) => m[1]))], ['3', '7']);
    assert.match(p, /write 4 different versions/);
    for (const v of ['plainer', 'more personal', 'restructured', 'in my own voice']) assert.ok(p.includes(v), v);
    assert.ok(p.includes(`Sentence: ${S2}`) && p.includes(`Sentence: ${S3}`));
    assert.ok(p.includes(`Before: ${S1}`));
    assert.ok(p.includes(`About me: ${VOICE}`));
    assert.ok(p.includes('My own sample text.'));
    assert.ok(p.includes('Keep exactly as written: Tier 2, Tier 3.'));
    assert.ok(p.includes('Keep exactly as written: DSAs.'));
  });

  test('accepts items keyed by index (the page passes {index, …})', () => {
    const p = batchVariantsPrompt({ items: [{ index: 0, sentence: S1 }, { index: 12, sentence: S3 }], n: 2 });
    assert.match(p, /Use exactly these keys: "0", "12"\./);
    assert.match(p, /\[id "12"\]/);
  });

  test('the "your voice" version follows samples only when there are some', () => {
    assert.match(batchVariantsPrompt({ items, samples: ['My sample.'] }), /Version 4: in my own voice, following my writing samples/);
    const none = batchVariantsPrompt({ items, samples: [] });
    assert.match(none, /Version 4: in my own voice: plain, direct and specific/);
    assert.ok(!/Sample|following my writing samples/.test(none));
  });

  test('n is clamped and phrased correctly', () => {
    assert.match(batchVariantsPrompt({ items, n: 1 }), /write 1 different version:/);
    assert.match(batchVariantsPrompt({ items, n: 0 }), /write 4 different versions/);
    assert.match(batchVariantsPrompt({ items, n: 99 }), /write 8 different versions/);
    assert.match(batchVariantsPrompt({ items, n: 6 }), /repeat this cycle/);
    assert.match(batchVariantsPrompt({ items, n: 'x' }), /write 4 different versions/);
  });

  test('includes the whole ban list and never mentions checkers', () => {
    const p = batchVariantsPrompt({ items, n: 3 });
    const line = p.split('\n').find((l) => l.includes('Avoid these words and phrases'));
    for (const b of BAN_LIST) assert.ok(line.includes(b.replace(/,$/, '')), b);
    assert.doesNotMatch(withoutBanLine(p), BAD_FRAMING);
    assert.ok(batchVariantsPrompt({ items, banList: ['synergy'] }).includes('Avoid these words and phrases: synergy.'));
  });

  test('survives empty input', () => {
    const p = batchVariantsPrompt();
    assert.equal(typeof p, 'string');
    assert.match(p, /JSON/);
    assert.equal(typeof batchVariantsPrompt({ items: [null, { id: 1, sentence: S1 }] }), 'string');
  });

  test('round trip: a reply in the requested shape parses back', () => {
    const p = batchVariantsPrompt({ items, n: 2 });
    const ids = [...new Set([...p.matchAll(/"(\d+)"\s*:/g)].map((m) => Number(m[1])))];
    const reply = JSON.stringify({ 3: ['Data drives our underwriting in Tier 2 and Tier 3 cities.', 'We underwrite on data.'], 7: ['Builders and DSAs bring us good customers.'] });
    assert.deepEqual(entries(parseVariantsReply(reply, ids)), {
      3: ['Data drives our underwriting in Tier 2 and Tier 3 cities.', 'We underwrite on data.'],
      7: ['Builders and DSAs bring us good customers.'],
    });
  });
});

describe('parseVariantsReply', () => {
  const ids = [3, 7];
  const want = { 3: ['A one.', 'A two.'], 7: ['B one.'] };
  const messy = [
    ['plain JSON', '{"3": ["A one.", "A two."], "7": ["B one."]}'],
    ['code fence', '```json\n{"3": ["A one.", "A two."], "7": ["B one."]}\n```'],
    ['fence without language', '```\n{"3": ["A one.", "A two."], "7": ["B one."]}\n```'],
    ['leading prose and trailing commentary with brackets', 'Here are the versions you asked for [all four]:\n\n{"3": ["A one.", "A two."], "7": ["B one."]}\n\nLet me know if you want changes {or more}.'],
    ['smart quotes as delimiters', '{“3”: [“A one.”, “A two.”], “7”: [“B one.”]}'],
    ['single quotes', "{'3': ['A one.', 'A two.'], '7': ['B one.']}"],
    ['trailing commas', '{"3": ["A one.", "A two.",], "7": ["B one.",],}'],
    ['bare keys', '{3: ["A one.", "A two."], 7: ["B one."]}'],
    ['array of items', '[{"id": "3", "variants": ["A one.", "A two."]}, {"id": 7, "versions": ["B one."]}]'],
    ['array of arrays, in id order', '[["A one.", "A two."], ["B one."]]'],
    ['labelled keys', '{"Sentence 3": ["A one.", "A two."], "id 7": ["B one."]}'],
    ['wrapped in another object', '{"results": {"3": ["A one.", "A two."], "7": ["B one."]}}'],
    ['variants as an object', '{"3": {"plainer": "A one.", "more personal": "A two."}, "7": {"versions": ["B one."]}}'],
    ['one string instead of a list', '{"3": ["A one.", "A two."], "7": "B one."}'],
    ['two JSON blocks', 'First:\n```json\n{"3": ["A one.", "A two."]}\n```\nAnd the other:\n```json\n{"7": ["B one."]}\n```'],
    ['wrong keys in order', '{"1": ["A one.", "A two."], "2": ["B one."]}'],
    ['markdown list', '**3**\n1. A one.\n2. A two.\n\n**7**\n- B one.\n\nHope this helps!'],
    ['quoted lines under headings', 'Sentence 3:\n"A one."\n"A two."\n\nSentence 7:\n"B one."'],
    ['CRLF line ends', '```json\r\n{"3": ["A one.", "A two."],\r\n "7": ["B one."]}\r\n```'],
    ['labels and bold inside the strings', '{"3": ["Version 1: A one.", "**A two.**"], "7": ["Here is the rewritten sentence: B one."]}'],
    ['duplicates, blanks and template echoes', '{"3": ["A one.", "A one.", "", "  ", "version 1", "…", "A two."], "7": ["B one.", null, 5]}'],
  ];
  for (const [name, reply] of messy) {
    test(`survives: ${name}`, () => assert.deepEqual(entries(parseVariantsReply(reply, ids)), want));
  }

  test('unescaped straight quotes inside a string', () => {
    const m = parseVariantsReply('{"3": ["We call it "the Nagpur rule" internally.", "A two."], "7": ["B one."]}', ids);
    assert.deepEqual(m.get(3), ['We call it "the Nagpur rule" internally.', 'A two.']);
  });

  test('smart quotes inside valid JSON strings stay as they are', () => {
    const m = parseVariantsReply('{"3": ["Our “first-time buyer” book grew."], "7": ["We don’t chase volume."]}', ids);
    assert.deepEqual(entries(m), { 3: ['Our “first-time buyer” book grew.'], 7: ['We don’t chase volume.'] });
  });

  test('missing ids come back as empty lists', () => {
    assert.deepEqual(entries(parseVariantsReply('{"3": ["A one."]}', ids)), { 3: ['A one.'], 7: [] });
    assert.deepEqual(entries(parseVariantsReply('{"9": ["Stray."], "3": ["A one."]}', ids)), { 3: ['A one.'], 7: [] });
  });

  test('a reply cut off mid-string keeps everything complete before the cut', () => {
    assert.deepEqual(entries(parseVariantsReply('```json\n{"3": ["A one.", "A two."], "7": ["B one.", "B tw', ids)), want);
  });

  test('keeps Indian amounts, placeholders and brackets inside strings', () => {
    const reply = 'Version 2 uses [your example] as you asked.\n```json\n{"3": ["We lent ₹1,00,000 per [your example] in FY2023-24."], "7": ["GNPA fell 150 bps (to 1.2%)."]}\n```';
    assert.deepEqual(entries(parseVariantsReply(reply, ids)), { 3: ['We lent ₹1,00,000 per [your example] in FY2023-24.'], 7: ['GNPA fell 150 bps (to 1.2%).'] });
  });

  test('preserves the id type given by the caller', () => {
    const m = parseVariantsReply('{"3": ["A one."], "s7": ["B one."]}', ['3', 's7']);
    assert.deepEqual([...m.keys()], ['3', 's7']);
    assert.deepEqual(m.get('s7'), ['B one.']);
    const n = parseVariantsReply('{"3": ["A one."]}', new Set([3]));
    assert.deepEqual([...n.keys()], [3]);
  });

  test('a flat list maps only when there is a single id', () => {
    assert.deepEqual(entries(parseVariantsReply('["Only one.", "Two."]', [5])), { 5: ['Only one.', 'Two.'] });
    assert.deepEqual(entries(parseVariantsReply('["Only one.", "Two."]', ids)), { 3: [], 7: [] });
  });

  test('without ids, returns whatever keys the reply has', () => {
    assert.deepEqual(entries(parseVariantsReply('{"3": ["A one."], "7": ["B one."]}')), { 3: ['A one.'], 7: ['B one.'] });
    assert.deepEqual(entries(parseVariantsReply('{"results": {"3": ["A one."], "7": "B one."}}')), { 3: ['A one.'], 7: ['B one.'] });
  });

  test('a single id need not be wrapped in a list', () => {
    assert.deepEqual(entries(parseVariantsReply('{"5": ["A one."]}', 5)), { 5: ['A one.'] });
    assert.deepEqual(entries(parseVariantsReply('{"5": ["A one."]}', '5')), { 5: ['A one.'] });
  });

  test('an empty id only matches an empty key', () => {
    assert.deepEqual(entries(parseVariantsReply('{"sentence": ["Not this."], "": ["A one."]}', [''])), { '': ['A one.'] });
  });

  test('never throws, and never pollutes prototypes', () => {
    for (const r of ['', null, undefined, 'nothing here at all', '{', '[', '}{][', '{"3": }', '{"3": [,,,]}', '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[', '"just a string"', 42]) {
      const m = parseVariantsReply(r, ids);
      assert.deepEqual(entries(m), { 3: [], 7: [] }, String(r));
    }
    parseVariantsReply('{"__proto__": {"polluted": ["x"]}, "constructor": {"prototype": {"polluted": ["y"]}}, "3": ["A one."]}', ids);
    parseVariantsReply("{__proto__: {polluted: ['x']}, '3': ['A one.']}", ids);
    assert.equal({}.polluted, undefined);
  });

  test('stays fast on long or hostile replies', () => {
    const t0 = Date.now();
    parseVariantsReply('x{'.repeat(20000), ids);
    parseVariantsReply('['.repeat(30000), ids);
    parseVariantsReply(`{"3": [${Array.from({ length: 2000 }, (_, i) => `bare token ${i}`).join(', ')}]}`, ids);
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe('interviewQuestions', () => {
  test('a vague amount gets a question for the actual figure', () => {
    const q = interviewQuestions('We saw significant growth in the affordable housing book.', []);
    assert.ok(q.length >= 1 && q.length <= 2);
    assert.match(q[0], /“significant growth”/);
    assert.match(q[0], /actual figure/);
  });

  test('an unquantified change gets "by how much"', () => {
    const q = interviewQuestions('With better tools, lenders can reduce turnaround time for customers.', []);
    assert.match(q[0], /“reduce turnaround time”/);
    assert.match(q[0], /By how much/);
  });

  test('sentences that already give a figure are not asked about', () => {
    const q = interviewQuestions('Disbursements grew 18% in FY24, and GNPA stayed below 1.5%.', []);
    assert.ok(q.every((x) => !/actual figure|By how much/.test(x)));
  });

  test('a generic claim gets a request for a real example from lending work', () => {
    const q = interviewQuestions(`${S1} ${S2} ${S3}`, findTells(`${S1} ${S2} ${S3}`));
    assert.match(q[0], /real example from your own work on underwriting/);
    assert.ok(q.length <= 2);
  });

  test('a stock opinion gets a request for the author\'s own view', () => {
    const p = 'Ultimately, sustainable growth is not just about volumes; it is about building a franchise.';
    const q = interviewQuestions(p, [{ start: 0, end: 10, rule: 'closer', category: 'closer', weight: 3, message: 'stock wrap-up' }]);
    assert.ok(q.some((x) => /your own view/.test(x)));
  });

  test('the example paragraph: figure first, then the strongest other need', () => {
    const q = interviewQuestions(PARA2, findTells(PARA2));
    assert.equal(q.length, 2);
    assert.match(q[0], /“reduce turnaround time”/);
    assert.match(q[1], /real example|your own view/);
  });

  test('tells drive the choice when the text gives no clue', () => {
    const p = 'This is how we look at it.';
    const op = interviewQuestions(p, [{ rule: 'not-x-its-y', category: 'formula', weight: 3, message: 'formula' }]);
    assert.match(op[0], /your own view/);
    const num = interviewQuestions(p, [{ rule: 'array-of', category: 'phrase', weight: 2, message: 'Filler. Name the items, or give the number.' }]);
    assert.match(num[0], /actual figure/);
  });

  test('always 1-2 distinct questions, whatever the input', () => {
    for (const [p, t] of [['', []], [null, null], ['Fine.', undefined], ['x', [null, 5, 'junk', { weight: -1 }]], [PARA2, findTells(PARA2)]]) {
      const q = interviewQuestions(p, t);
      assert.ok(Array.isArray(q) && q.length >= 1 && q.length <= 2, String(p));
      assert.equal(new Set(q).size, q.length);
      for (const x of q) assert.ok(typeof x === 'string' && x.length > 10 && x.length < 200);
    }
  });

  test('quoted phrases end cleanly', () => {
    const q = interviewQuestions('Several of the branches in the north did well.', []);
    assert.match(q[0], /“Several”|“Several of the branches”/);
    assert.doesNotMatch(q[0], / (?:of|the|in)”/);
  });
});

describe('interviewPrompt', () => {
  const answers = ['TAT fell from 9 days to 4 days in FY24', { q: 'Your view?', a: 'Volume without collections discipline is a trap.' }];

  test('uses only the author\'s answers as new facts', () => {
    const r = interviewPrompt({ paragraph: PARA2, answers, voice: VOICE });
    assert.deepEqual(Object.keys(r).sort(), ['system', 'user']);
    assert.match(r.system, /answers are the only new facts/);
    assert.match(r.system, /Invent nothing else/);
    assert.match(r.system, /no placeholders/);
    assert.ok(r.system.includes(`About the author: ${VOICE}`));
    assert.ok(r.user.includes(PARA2));
    assert.ok(r.user.includes('- TAT fell from 9 days to 4 days in FY24'));
    assert.ok(r.user.includes('- Your view? Volume without collections discipline is a trap.'));
    assert.match(r.user, /Keep exactly as written: 1\.5%, GNPA, can\./);
    assert.match(r.user, /Reply with the paragraph only\.$/);
    assert.doesNotMatch(withoutBanLine(`${r.system}\n${r.user}`), BAD_FRAMING);
  });

  test('blank answers are dropped; none at all says so', () => {
    const r = interviewPrompt({ paragraph: 'We grow carefully.', answers: ['  ', '', null] });
    assert.match(r.user, /- \(none\)/);
    assert.equal(typeof interviewPrompt().user, 'string');
  });

  test('Qwen3 gets /no_think', () => {
    assert.match(interviewPrompt({ paragraph: PARA2, answers, model: 'Qwen3-8B' }).user, /\/no_think$/);
    assert.ok(!interviewPrompt({ paragraph: PARA2, answers }).user.includes('/no_think'));
  });
});

describe('cleanOutput', () => {
  const S = 'We keep GNPA below 1.5%.';
  const cases = [
    ['<think>\nLet me think.\n</think>\n\nWe keep GNPA below 1.5%.', S],
    ['<think>\n\n</think>\n\nWe keep GNPA below 1.5%.', S],
    ['reasoning only</think>We keep GNPA below 1.5%.', S],
    ['<think>ran out of tokens', ''],
    ['"We keep GNPA below 1.5%."', S],
    ['“We keep GNPA below 1.5%.”', S],
    ['"We keep GNPA below 1.5%".', S],
    ["'We don't chase volume.'", "We don't chase volume."],
    ['`We keep GNPA below 1.5%.`', S],
    ['```\nWe keep GNPA below 1.5%.\n```', S],
    ['```text\nWe keep GNPA below 1.5%.\n```', S],
    ['⟦We keep GNPA below 1.5%.⟧', S],
    ['<rewrite>We keep GNPA below 1.5%.</rewrite>', S],
    ['{"rewrite": "We keep GNPA below 1.5%."}', S],
    ['Here is the rewritten sentence:\n\nWe keep GNPA below 1.5%.', S],
    ["Sure! Here's a plainer version: We keep GNPA below 1.5%.", S],
    ['Certainly! Here is the revised sentence:\n"We keep GNPA below 1.5%."', S],
    ['Rewritten sentence: We keep GNPA below 1.5%.', S],
    ['**Revised:** We keep GNPA below 1.5%.', S],
    ['Version 2 (more personal): We keep GNPA below 1.5%.', S],
    ['### Rewritten:\n\nWe keep GNPA below 1.5%.', S],
    ['Certainly!\nWe keep GNPA below 1.5%.', S],
    ['Sure, here you go:\n"We keep GNPA below 1.5%."', S],
    ['We keep **GNPA** below 1.5%.', S],
    ['We keep __GNPA__ below *1.5%*.', S],
    ['We keep GNPA below 1.5%.\n\nI kept the figure and removed "Furthermore".', S],
    ['We keep GNPA below 1.5%.\nNote: I kept the figure.', S],
    ['We keep GNPA below 1.5%. (Note: the figure is unchanged.)', S],
    ["I've rewritten it to sound more natural.\n\nWe keep GNPA below 1.5%.", S],
    ['We keep GNPA below 1.5%. /no_think', S],
    ['  \n We keep GNPA below 1.5%.  \n', S],
  ];
  for (const [input, out] of cases) test(`cleans ${JSON.stringify(input).slice(0, 60)}`, () => assert.equal(cleanOutput(input), out));

  test('leaves real sentences alone', () => {
    for (const s of [
      'Here is what we learned: credit discipline beats volume.',
      'New: the bank opened 12 branches.',
      'Option 2: raise the LTV cap to 80%.',
      'Result: GNPA fell to 1.2% in FY2023-24.',
      'Certainly, we will not raise rates.',
      '"Growth" matters more than "volume"',
      'Our “first-time buyer” book grew to ₹1,00,000 crore.',
      'We lent Rs 2.5 crore at 150 bps over the repo rate; DSAs sourced 60%.',
      'In my experience, [your example] shows this.',
      '3*4 is 12, and 5*6 is 30.',
      'We don’t lend against property we can’t value.',
    ]) assert.equal(cleanOutput(s), s);
  });

  test('keeps a paragraph\'s single line breaks', () => {
    assert.equal(cleanOutput('Line one.\nLine two.'), 'Line one.\nLine two.');
  });

  test('is idempotent', () => {
    for (const [input] of cases) assert.equal(cleanOutput(cleanOutput(input)), cleanOutput(input));
  });

  test('never throws on odd input', () => {
    for (const x of [null, undefined, '', 42, '```', '""', '"', '".', '“”.', '****', '<think></think>', '\n\n\n', '{}', '[]', '[[1]]']) assert.equal(typeof cleanOutput(x), 'string');
    assert.equal(cleanOutput(null), '');
    assert.equal(cleanOutput('""'), '');
  });
});

describe('helpers', () => {
  test('forModel appends /no_think once, only for Qwen3', () => {
    const r = { system: 's', user: 'u' };
    assert.equal(forModel(r, 'Qwen3-4B').user, 'u\n\n/no_think');
    assert.equal(forModel(forModel(r, 'Qwen3-4B'), 'Qwen3-4B').user, 'u\n\n/no_think');
    assert.equal(forModel(r, 'gemma'), r);
    assert.equal(r.user, 'u');
  });

  test('pickBans matches plain parts of patterned entries', () => {
    const list = ['moreover', 'not just … but', 'leverage (as a verb)', 'overall,', 'em dashes (—)', 'vital'];
    assert.deepEqual(pickBans('It is not just about volume, but quality.', list, 2), ['not just … but', 'moreover']);
    assert.deepEqual(pickBans('Vitality matters.', list, 1), ['moreover']);  // whole words only
    assert.deepEqual(pickBans('Overall, fine.', list).slice(0, 1), ['overall,']);
    assert.deepEqual(pickBans('x', ['a', 'a', '', null]), ['a']);
  });

  test('keepList lists facts as written', () => {
    assert.deepEqual(keepList(FACTS).slice(0, 3).sort(), ['80%', 'FY24', '₹2,000 crore'].sort());
    assert.ok(keepList(FACTS).includes('DSAs'));
    assert.deepEqual(keepList(''), []);
  });
});

// ---------- review: regressions for bugs found after the first version ----------
describe('review: cleanOutput keeps real sentences', () => {
  const S = 'We keep GNPA below 1.5%.';

  test('a real first-person or "The following" opening is not taken for a note about the edit', () => {
    // each used to come back as the model's trailing note instead of the rewrite
    assert.equal(cleanOutput('I made collections our first priority in FY24.\n\nI kept the figure.'), 'I made collections our first priority in FY24.');
    assert.equal(cleanOutput('The following year, GNPA fell to 1.2%.\n\nNote: kept the figure.'), 'The following year, GNPA fell to 1.2%.');
    assert.equal(cleanOutput('I tried three pricing grids in Pune before one worked.\n\nThis keeps your meaning.'), 'I tried three pricing grids in Pune before one worked.');
    assert.equal(cleanOutput('This version of the product sold 2,000 loans.\n\nI kept the figure.'), 'This version of the product sold 2,000 loans.');
    assert.equal(cleanOutput('I have kept GNPA below 1.5% for five years.\n\nI kept all the facts.'), 'I have kept GNPA below 1.5% for five years.');
  });

  test('a leading block that does talk about the edit is still dropped', () => {
    for (const lead of ["I've made it more personal:", 'I have rewritten the sentence to be plainer.', 'This version keeps every figure.',
      'Below is the rewritten sentence.', 'The following keeps your figures:', 'I tightened the wording and kept the facts.']) {
      assert.equal(cleanOutput(`${lead}\n\n${S}`), S, lead);
    }
  });

  test('the last line of a multi-line paragraph survives unless it is a note', () => {
    for (const p of [
      'We grew the LAP book by 18% in FY24.\nChange came slowly in Tier 3 towns.',
      'We grew the LAP book by 18% in FY24.\nI used to approve every file myself.',
      'Our view is simple.\nWhy lend in Tier 3? Because repayment is strong.',
      'We cap LTV at 80%.\nNote that RBI allows 90% on small loans.',
      'We cap LTV at 80%.\nI made the cap stricter in FY23.',
      'We cap LTV at 80%.\nReason enough to stay cautious.',
    ]) assert.equal(cleanOutput(p), p);
    assert.equal(cleanOutput(`${S}\nChanges: removed "Furthermore".`), S);
    assert.equal(cleanOutput(`${S}\nWhy: the old opener was filler.`), S);
    assert.equal(cleanOutput(`${S}\nI changed the wording slightly.`), S);
    assert.equal(cleanOutput(`${S}\n(I kept the original sentence structure.)`), S);
  });

  test('"Here is/are …:" is a preamble only when it names the rewrite', () => {
    for (const s of [
      'Here are the options: raise the LTV cap or slow disbursals.',
      'Here is the text of our policy: no loans above 80% LTV.',
      'Here is the sentence our auditors quote: GNPA stayed below 1.5%.',
      'Here are the two numbers that matter: ₹2,000 crore and 1.5%.',
    ]) assert.equal(cleanOutput(s), s);
    for (const r of ['Here is the sentence:\nWe keep GNPA below 1.5%.', "Here's a plainer sentence: We keep GNPA below 1.5%.",
      "Here's one way to put it: We keep GNPA below 1.5%.", 'Here is my edit: We keep GNPA below 1.5%.',
      'Sure! Here is the sentence, rewritten: We keep GNPA below 1.5%.']) assert.equal(cleanOutput(r), S, r);
  });

  test('curly quotes around a sentence with a quoted phrase inside are removed', () => {
    assert.equal(cleanOutput('“We call it the “Nagpur rule” internally.”'), 'We call it the “Nagpur rule” internally.');
    assert.equal(cleanOutput('«We said «no» to the builder.»'), 'We said «no» to the builder.');
    // not one quotation: the quotes stay
    assert.equal(cleanOutput('“Growth” matters more than “volume”'), '“Growth” matters more than “volume”');
    assert.equal(cleanOutput('“Growth” matters, and so does “volume”.'), '“Growth” matters, and so does “volume”.');
  });

  test('stays linear on long runs of spaces (used to take seconds)', () => {
    const t0 = Date.now();
    assert.equal(cleanOutput(`a${' '.repeat(100000)}b`), `a${' '.repeat(100000)}b`);
    cleanOutput(`a ${'\t'.repeat(100000)}b /think`);
    cleanOutput('(note '.repeat(30000));
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  });

  test('is idempotent on the new cases', () => {
    for (const x of ['I made collections our first priority in FY24.\n\nI kept the figure.', '“We call it the “Nagpur rule” internally.”',
      'Here is the sentence:\nWe keep GNPA below 1.5%.', `${S}\nChanges: removed "Furthermore".`]) {
      assert.equal(cleanOutput(cleanOutput(x)), cleanOutput(x));
    }
  });
});

describe('review: parseVariantsReply', () => {
  const ids = [3, 7];
  const want = { 3: ['A one.', 'A two.'], 7: ['B one.'] };

  test('bracketed prose is never a version, even when the JSON needs the lenient reader', () => {
    // "[your example]" used to come back as a version for a single id
    assert.deepEqual(entries(parseVariantsReply('Version 2 includes a [your example] placeholder.\n\n{“5”: [“A one.”, “A two.”]}', [5])), { 5: ['A one.', 'A two.'] });
    assert.deepEqual(entries(parseVariantsReply('I used [your example] as asked.\n{5: [\'A one.\']}', [5])), { 5: ['A one.'] });
  });

  test('unquoted values (comments, None) are not versions', () => {
    assert.deepEqual(entries(parseVariantsReply('{"3": ["A one.", // first\n "A two."], "7": ["B one.", None]}', ids)), want);
    assert.deepEqual(entries(parseVariantsReply("{'3': ['A one.', 'A two.', None], '7': ['B one.', undefined]}", ids)), want);
  });

  test('an echoed original "sentence" field is left out, but used when it is the only text', () => {
    const reply = '[{"id": 3, "sentence": "Original sentence here.", "plainer": "A one.", "more personal": "A two."}, {"id": 7, "Sentence": "Original seven.", "rewrite": "B one."}]';
    assert.deepEqual(entries(parseVariantsReply(reply, ids)), want);
    assert.deepEqual(entries(parseVariantsReply('[{"id": 3, "sentence": "A one."}, {"id": 7, "sentence": "B one."}]', ids)), { 3: ['A one.'], 7: ['B one.'] });
  });

  test('full-width colons after quoted keys', () => {
    assert.deepEqual(entries(parseVariantsReply('{"3"： ["A one.", "A two."], "7"： ["B one."]}', ids)), want);
  });

  test('curly-quoted strings with a curly-quoted phrase before a comma', () => {
    const m = parseVariantsReply('{“3”: [“He said “no”, then left.”, “A two.”], “7”: [“We call it “the rule” here.”]}', ids);
    assert.deepEqual(entries(m), { 3: ['He said “no”, then left.', 'A two.'], 7: ['We call it “the rule” here.'] });
    // an inner quote that is never closed still ends at the bracket
    assert.deepEqual(parseVariantsReply('{“3”: [“He said “no, then left.”], “7”: [“B one.”]}', ids).get(3), ['He said “no, then left.']);
  });

  test('labels like "note" or "summary" are not ids', () => {
    // "note" used to be read as id "te" and "summary" as "ummary"
    assert.deepEqual(entries(parseVariantsReply('{"3": ["A one."], "note": ["Some note here."], "summary": ["Some summary."]}', [3, 'te', 'ummary'])), { 3: ['A one.'], te: [], ummary: [] });
    assert.deepEqual([...parseVariantsReply('{"3": ["A one."], "note": "I kept facts."}').keys()], ['3', 'note']);
    assert.deepEqual(entries(parseVariantsReply('{"No. 3": ["A one."], "#7": ["B one."]}', ids)), { 3: ['A one.'], 7: ['B one.'] });
  });

  test('a single id needs no heading in a prose reply', () => {
    assert.deepEqual(entries(parseVariantsReply('Here are the versions [as requested]:\n1. A one.\n2. A two.', [3])), { 3: ['A one.', 'A two.'] });
    assert.deepEqual(entries(parseVariantsReply('Version 1: "A one."\nVersion 2: "A two."', [3])), { 3: ['A one.', 'A two.'] });
    // with two ids and no headings nothing can be assigned
    assert.deepEqual(entries(parseVariantsReply('1. A one.\n2. A two.', ids)), { 3: [], 7: [] });
  });
});

describe('review: interviewQuestions', () => {
  test('acronym topics match only in capitals and are named as listed', () => {
    const lap = interviewQuestions('We are in the final lap of the merger, and it is key to stay focused.', []);
    assert.ok(lap.every((q) => !/\blap\b|LAP/.test(q)), lap.join(' | '));
    assert.match(interviewQuestions('LAP is key to our growth.', [])[0], /work on LAP/);
    const credit = interviewQuestions('Credit discipline is key to sustainable growth.', []);
    assert.ok(credit.some((q) => /work on credit\b/.test(q)), credit.join(' | '));
  });

  test('the stakeholders tell asks for a view, not a figure', () => {
    const t = { rule: 'stakeholders', category: 'phrase', weight: 1, message: 'Vague send-off. Name who benefits and how.' };
    const q = interviewQuestions('This is how we look at it.', [t, t]);
    assert.ok(!q.some((x) => /actual figure/.test(x)), q.join(' | '));
    assert.match(q[0], /your own view/);
  });

  test('a negated change or "lower" as an adjective is no figure to ask for', () => {
    for (const p of ['We will not lower our credit standards.', 'We never cut rates to chase volume.', "We won't reduce the branch network.",
      'We serve lower income groups in Tier 3 towns.']) {
      const q = interviewQuestions(p, []);
      assert.ok(q.every((x) => !/By how much|actual figure/.test(x)), `${p} -> ${q.join(' | ')}`);
    }
    assert.match(interviewQuestions('We will lower our costs and improve the customer experience.', [])[0], /“lower our costs”. By how much/);
  });

  test('punctuation tells do not ask for an example', () => {
    const q = interviewQuestions('In FY24, for example, we cut LTV to 75%.', [
      { rule: 'em-dash', category: 'punctuation', weight: 3, message: 'Dash-heavy.' },
      { rule: 'triad', category: 'formula', weight: 1, message: 'Three-part list for rhythm.' }]);
    assert.equal(q.length, 1);
    assert.match(q[0], /your own view/);
  });
});

describe('review: prompts and helpers', () => {
  test('keepList lists negations and modals as written', () => {
    const k = keepList("We cannot exceed 80% LTV, and we won't lend without GST returns.");
    for (const w of ['80%', 'LTV', 'GST', 'cannot', "won't", 'without']) assert.ok(k.includes(w), w);
    // "can", "will" and "n't" are not in the text and must not be asked for
    for (const w of ['can', 'will', "n't"]) assert.ok(!k.includes(w), w);
    const k2 = keepList('We may not and cannot, but we can and will.');
    for (const w of ['may', 'not', 'cannot', 'can', 'will']) assert.ok(k2.includes(w), w);
  });

  test('Qwen3 ids with a space or underscore get /no_think', () => {
    for (const model of ['Qwen 3 8B', 'qwen_3-4b', 'lmstudio-community/Qwen3-8B-GGUF']) assert.match(forModel({ system: 's', user: 'u' }, model).user, /\/no_think$/, model);
    assert.ok(!forModel({ system: 's', user: 'u' }, 'Qwen2.5-32B').user.includes('/no_think'));
  });

  test('a long "before" context keeps the end next to the sentence', () => {
    const before = `Early text that is far away. ${'We lend carefully in small towns. '.repeat(30)}LAST BIT before the target.`;
    const r = sentencePrompt({ before, sentence: S2, after: `${S3} ${'More after. '.repeat(80)}` });
    const b = r.user.split('\n').find((l) => l.startsWith('Before: '));
    assert.ok(b.endsWith('LAST BIT before the target.'), b.slice(-60));
    assert.ok(!b.includes('Early text') && b.length <= 610);
    const a = r.user.split('\n').find((l) => l.startsWith('After: '));
    assert.ok(a.startsWith(`After: ${S3}`) && a.length <= 610);
    const batch = batchVariantsPrompt({ items: [{ id: 1, before, sentence: S2 }] });
    assert.ok(batch.includes('LAST BIT before the target.') && !batch.includes('Early text'));
  });

  test('humanizerPrompt is linear on long inner runs of spaces (used to take seconds)', () => {
    const t0 = Date.now();
    const draft = `a${' '.repeat(100000)}b`;
    assert.equal(humanizerPrompt(` ${draft} `), `${HUMANIZER_INSTR}\n\n${draft}${HUMANIZER_SEP}`);
    assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  });
});
