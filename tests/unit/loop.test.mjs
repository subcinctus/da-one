import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteFlagged, applyChanges, windowOf, abortError, keepMarker, MIN_GAIN } from '../../ai-checker/src/rewrite/loop.mjs';
import { splitSentences } from '../../ai-checker/src/text.mjs';

// ---------- fakes ----------
// Guide: every "AI word" in the 3-sentence window adds 20 points.
const MARK = /\b(?:delve|robust|seamless|pivotal)\b/gi;
const SWAP = { delve: 'look', robust: 'sound', seamless: 'smooth', pivotal: 'key' };
const marks = (t) => (t.match(MARK) || []).length;
const guideOf = (t) => 30 + 20 * marks(t);
const validatorOf = (t) => 20 + 10 * marks(t);
// Candidate generator that replaces the first AI word with a plain one (one step per round).
const peel = (s) => s.replace(new RegExp(MARK.source, 'i'), (w) => SWAP[w.toLowerCase()]);
// Gate: the digits must survive, and no meta talk.
const digits = (t) => (t.match(/\d+/g) || []).sort().join(' ');
function factGate(original, candidate) {
  const reasons = [];
  if (digits(original) !== digits(candidate)) reasons.push({ code: 'facts', message: 'A number changed.' });
  if (/^Here is/i.test(candidate)) reasons.push({ code: 'meta', message: 'Talks about the rewrite.' });
  return { ok: !reasons.length, reasons, metrics: {} };
}

// Every injected function logs its calls, in order.
function harness({ cands = {}, gate = factGate, guide = guideOf, validator = validatorOf } = {}) {
  const log = [];
  return {
    log,
    getCandidates: async (items, round) => {
      log.push({ kind: 'cand', round, items: structuredClone(items) });
      const m = new Map();
      for (const it of items) m.set(it.index, typeof cands === 'function' ? cands(it, round) : cands[round]?.[it.index] || []);
      return m;
    },
    scoreGuide: async (texts) => { log.push({ kind: 'guide', texts: [...texts] }); return texts.map(guide); },
    gate: async (original, candidate, opts) => { log.push({ kind: 'gate', original, candidate, opts }); return gate(original, candidate); },
    scoreValidator: async (text) => { log.push({ kind: 'validator', text }); return validator(text); },
  };
}
const run = (h, opts) => rewriteFlagged({ getCandidates: h.getCandidates, scoreGuide: h.scoreGuide, gate: h.gate, scoreValidator: h.scoreValidator, ...opts });
const kinds = (log, k) => log.filter((e) => e.kind === k);
const sents = (t) => splitSentences(t);

const T1 = 'Our AUM grew to ₹12,450 crore in FY24. We delve into robust, seamless underwriting across 1,00,000 accounts. GNPA stayed at 1.8%.';
const T1_S1 = 'We delve into robust, seamless underwriting across 1,00,000 accounts.';
const GOOD = 'Underwriting covered 1,00,000 accounts, and we checked each file.';

describe('helpers', () => {
  test('windowOf keeps the original spacing and clips at the ends', () => {
    const t = 'A one.  B two.\n\nC three.';
    const S = sents(t);
    assert.equal(windowOf(t, S, 0), 'A one.  B two.');
    assert.equal(windowOf(t, S, 1), t);
    assert.equal(windowOf(t, S, 2), 'B two.\n\nC three.');
    assert.equal(windowOf(t, S, 1, 'X.'), 'A one.  X.\n\nC three.');
    const one = sents('Only one.');
    assert.equal(windowOf('Only one.', one, 0, 'Solo.'), 'Solo.');
  });

  test('applyChanges replaces by offset and recomputes every sentence offset', () => {
    const t = 'Alpha one. Beta two is here.\n\nGamma three. Delta.';
    const S = sents(t);
    const { text, sentences } = applyChanges(t, S, new Map([[0, 'A much longer first sentence.'], [2, 'G.'], [3, 'Delta, with ₹1,00,000.']]));
    assert.equal(text, 'A much longer first sentence. Beta two is here.\n\nG. Delta, with ₹1,00,000.');
    for (const s of sentences) assert.equal(text.slice(s.start, s.end), s.text);
    assert.equal(sentences[1].text, 'Beta two is here.');
    assert.deepEqual(applyChanges(t, S, new Map()), { text: t, sentences: S });
  });

  test('abortError always has the name AbortError', () => {
    const c = new AbortController();
    c.abort();
    assert.equal(abortError(c.signal).name, 'AbortError');
    const d = new AbortController();
    d.abort('user pressed stop');
    const e = abortError(d.signal);
    assert.equal(e.name, 'AbortError');
    assert.equal(e.cause, 'user pressed stop');
    assert.equal(abortError(undefined).name, 'AbortError');
  });
});

describe('rewriteFlagged: selection', () => {
  test('improves a flagged sentence and keeps everything else byte-identical', async () => {
    const h = harness({ cands: { 0: { 1: ['We delve into robust underwriting across 1,00,000 accounts.', GOOD] } } });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(res.text, T1.replace(T1_S1, GOOD));
    assert.equal(res.changes.length, 1);
    const c = res.changes[0];
    assert.equal(c.index, 1);
    assert.equal(c.before, T1_S1);
    assert.equal(c.after, GOOD);
    assert.equal(c.guideBefore, 90);
    assert.equal(c.guideAfter, 30);
    assert.deepEqual(c.rejected, []);
    assert.equal(c.rounds, 1);
    assert.deepEqual(res.validator, { before: 50, after: 20 });
    assert.deepEqual(res.warnings, []);
    // one guide call per round: own window first, then each version in its window
    const g = kinds(h.log, 'guide');
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].texts, [T1, T1.replace(T1_S1, 'We delve into robust underwriting across 1,00,000 accounts.'), T1.replace(T1_S1, GOOD)]);
    // reached the target: no second round
    assert.equal(kinds(h.log, 'cand').length, 1);
  });

  test('round 0 items carry neighbours, the sentence and an empty history', async () => {
    const h = harness();
    await run(h, { text: T1, sentences: sents(T1), targets: [0, 1, 2], rounds: 1 });
    const [{ items, round }] = kinds(h.log, 'cand');
    assert.equal(round, 0);
    assert.deepEqual(items.map((it) => [it.index, it.before, it.sentence, it.after]), [
      [0, '', 'Our AUM grew to ₹12,450 crore in FY24.', T1_S1],
      [1, 'Our AUM grew to ₹12,450 crore in FY24.', T1_S1, 'GNPA stayed at 1.8%.'],
      [2, T1_S1, 'GNPA stayed at 1.8%.', ''],
    ]);
    for (const it of items) { assert.equal(it.score, null); assert.deepEqual(it.previous, []); assert.equal(it.original, it.sentence); }
  });

  test('sentences default to splitSentences(text)', async () => {
    const h = harness({ cands: { 0: { 1: [GOOD] } } });
    const res = await run(h, { text: T1, targets: [1] });
    assert.equal(res.text, T1.replace(T1_S1, GOOD));
  });

  test('keeps the text unchanged when every candidate fails the gate', async () => {
    const h = harness({ cands: { 0: { 1: ['We delve into underwriting across many accounts.', 'Here is the rewrite: 1,00,000 accounts were checked.', '   ', 42, null] } } });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(res.text, T1);
    assert.deepEqual(res.warnings, ['no-change']);
    const c = res.changes[0];
    assert.equal(c.after, c.before);
    assert.deepEqual(c.rejected.map((r) => [r.candidate, r.reasons.map((x) => x.code)]), [
      ['We delve into underwriting across many accounts.', ['facts']],
      ['Here is the rewrite: 1,00,000 accounts were checked.', ['meta']],
    ]);
    assert.equal(c.guideBefore, 90);
    assert.equal(c.guideAfter, 90);
    // rejected versions are never scored; the validator never runs when nothing changed
    assert.deepEqual(kinds(h.log, 'guide').map((e) => e.texts), [[T1]]);
    assert.equal(kinds(h.log, 'validator').length, 0);
    assert.deepEqual(res.validator, { before: null, after: null });
    assert.equal(kinds(h.log, 'cand').length, 1);
  });

  test(`a version must beat the current window by at least ${MIN_GAIN} points`, async () => {
    const text = 'Opening line. Old sentence here. Closing line.';
    const guide = (t) => (t.includes('Alpha') ? 88.5 : t.includes('Beta') ? 88 : t.includes('Gamma') ? 88.000001 : 90);
    const h1 = harness({ guide, cands: { 0: { 1: ['Alpha sentence here.'] } } });
    const r1 = await run(h1, { text, sentences: sents(text), targets: [1] });
    assert.equal(r1.text, text);
    assert.deepEqual(r1.changes[0].rejected, []); // passed the gate, just not better enough
    const h2 = harness({ guide, cands: { 0: { 1: ['Alpha sentence here.', 'Gamma sentence here.', 'Beta sentence here.'] } } });
    const r2 = await run(h2, { text, sentences: sents(text), targets: [1] });
    assert.equal(r2.text, 'Opening line. Beta sentence here. Closing line.');
    assert.equal(r2.changes[0].guideAfter, 88);
    // float slack: 90.3 -> 88.3 is a 2-point gain
    const h3 = harness({ guide: (t) => (t.includes('Delta') ? 88.3 : 90.3), cands: { 0: { 1: ['Delta sentence here.'] } } });
    assert.equal((await run(h3, { text, sentences: sents(text), targets: [1] })).changes[0].after, 'Delta sentence here.');
  });

  test('ties keep the earlier version; the lowest score wins', async () => {
    const text = 'Opening line. Old sentence here. Closing line.';
    const guide = (t) => (t.includes('First') || t.includes('Second') ? 40 : t.includes('Third') ? 60 : 90);
    const h = harness({ guide, cands: { 0: { 1: ['Third sentence here.', 'First sentence here.', 'Second sentence here.'] } } });
    const res = await run(h, { text, sentences: sents(text), targets: [1] });
    assert.equal(res.changes[0].after, 'First sentence here.');
  });

  test('candidates are trimmed, de-duplicated, and copies of the current sentence are skipped', async () => {
    const h = harness({ cands: { 0: { 1: [`  ${GOOD}  `, GOOD, `\t${GOOD}`, T1_S1, ` ${T1_S1} `, '', 7, undefined] } } });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(res.text, T1.replace(T1_S1, GOOD));
    assert.deepEqual(kinds(h.log, 'gate').map((e) => e.candidate), [GOOD]);
  });

  test('accepts candidate maps with string keys and plain objects; tolerates null', async () => {
    const base = harness();
    for (const reply of [new Map([['1', [GOOD]]]), { 1: [GOOD] }]) {
      const res = await run(base, { text: T1, sentences: sents(T1), targets: [1], getCandidates: async () => reply });
      assert.equal(res.text, T1.replace(T1_S1, GOOD));
    }
    const res = await run(base, { text: T1, sentences: sents(T1), targets: [1], getCandidates: async () => null });
    assert.equal(res.text, T1);
    assert.deepEqual(res.warnings, ['no-change']);
  });

  test('non-numeric guide scores never lead to a change', async () => {
    const nan = harness({ guide: () => NaN, cands: { 0: { 1: [GOOD] } } });
    const r1 = await run(nan, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(r1.text, T1);
    assert.equal(r1.changes[0].guideBefore, null);
    // a short reply leaves the version unscored
    const h = harness({ cands: { 0: { 1: [GOOD] } } });
    const r2 = await run(h, { text: T1, sentences: sents(T1), targets: [1], scoreGuide: async (texts) => [90] });
    assert.equal(r2.text, T1);
    // own window unscored: no baseline, no change
    const r3 = await run(h, { text: T1, sentences: sents(T1), targets: [1], scoreGuide: async (texts) => texts.map((t, k) => (k === 0 ? null : 10)) });
    assert.equal(r3.text, T1);
  });
});

describe('rewriteFlagged: guards', () => {
  test('the gate gets the ORIGINAL sentence in every round, with context', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 3, targetPct: 0 });
    const gates = kinds(h.log, 'gate');
    assert.equal(gates.length, 3);
    for (const g of gates) assert.equal(g.original, T1_S1);
    assert.deepEqual(gates.map((g) => g.opts.context.round), [0, 1, 2]);
    assert.deepEqual(gates[1].opts.context, { index: 1, round: 1, before: 'Our AUM grew to ₹12,450 crore in FY24.', after: 'GNPA stayed at 1.8%.' });
  });

  test('a version seen again in a later round is not gated twice', async () => {
    const SAME = 'We robust into delve, seamless underwriting across 1,00,000 accounts.'; // as AI-like as the original
    const h = harness({ cands: (it) => [SAME, peel(it.sentence)] });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 2, targetPct: 0 });
    assert.equal(kinds(h.log, 'gate').filter((g) => g.candidate === SAME).length, 1);
    assert.equal(res.changes[0].after, 'We look into sound, seamless underwriting across 1,00,000 accounts.');
  });

  test('layout checks reject line breaks and a lost full stop before the gate runs', async () => {
    const h = harness({ cands: { 0: { 1: ['Underwriting covered 1,00,000\naccounts.', 'Underwriting covered 1,00,000 accounts', GOOD] } } });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(res.text, T1.replace(T1_S1, GOOD));
    assert.deepEqual(res.changes[0].rejected.map((r) => r.reasons[0].code), ['layout', 'layout']);
    assert.deepEqual(kinds(h.log, 'gate').map((g) => g.candidate), [GOOD]);
    // no full stop to keep when the original has none (a heading line)
    const t = 'Key risks for FY25\n\nWe delve into robust credit.';
    const h2 = harness({ cands: { 0: { 0: ['Main risks in FY25'] } }, guide: (x) => (x.includes('Main') ? 10 : 90) });
    assert.equal((await run(h2, { text: t, sentences: sents(t), targets: [0] })).text, 'Main risks in FY25\n\nWe delve into robust credit.');
  });

  test('a guard that throws fails closed; an unclear verdict is a rejection', async () => {
    const A = 'Underwriting at 1,00,000 accounts went well.';
    const B = 'Underwriting at 1,00,000 accounts held up.';
    const gate = (o, c) => {
      if (c === A) throw new Error('NLI worker crashed');
      if (c === B) return { ok: 'yes' };
      return factGate(o, c);
    };
    const h = harness({ gate, cands: { 0: { 1: [A, B, GOOD] } } });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(res.changes[0].after, GOOD);
    assert.deepEqual(res.changes[0].rejected.map((r) => [r.candidate, r.reasons[0].code]), [[A, 'error'], [B, 'gate']]);
    assert.match(res.changes[0].rejected[0].reasons[0].message, /NLI worker crashed/);
  });
});

describe('rewriteFlagged: rounds and target', () => {
  test('respects the round limit and passes the current best version and history', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 2, targetPct: 0 });
    const calls = kinds(h.log, 'cand');
    assert.deepEqual(calls.map((c) => c.round), [0, 1]);
    const r1 = 'We look into robust, seamless underwriting across 1,00,000 accounts.';
    const it = calls[1].items[0];
    assert.equal(it.sentence, r1);
    assert.equal(it.original, T1_S1);
    assert.equal(it.score, 70);
    assert.deepEqual(it.previous, [{ candidate: r1, score: 70, ok: true, round: 0 }]);
    assert.equal(res.changes[0].after, 'We look into sound, seamless underwriting across 1,00,000 accounts.');
    assert.equal(res.changes[0].guideAfter, 50);
    assert.equal(res.changes[0].rounds, 2);
  });

  test('stops after a round with no improvement', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 9, targetPct: 0 });
    // three AI words: three improving rounds, then a round with nothing new
    assert.deepEqual(kinds(h.log, 'cand').map((c) => c.round), [0, 1, 2, 3]);
    assert.equal(res.changes[0].after, 'We look into sound, smooth underwriting across 1,00,000 accounts.');
    const h2 = harness({ cands: { 0: { 1: ['We robust into delve, seamless underwriting across 1,00,000 accounts.'] } } });
    await run(h2, { text: T1, sentences: sents(T1), targets: [1], rounds: 3 });
    assert.equal(kinds(h2.log, 'cand').length, 1);
  });

  test('stops a sentence once its score reaches the target', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 3, targetPct: 85 });
    assert.equal(kinds(h.log, 'cand').length, 1); // 90 -> 70
    const h2 = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h2, { text: T1, sentences: sents(T1), targets: [1], rounds: 3, targetPct: 60 });
    assert.equal(kinds(h2.log, 'cand').length, 2); // 90 -> 70 -> 50
    assert.equal(res.changes[0].guideAfter, 50);
  });

  test('later rounds only ask for sentences still above the target', async () => {
    const text = 'We delve into retail credit. Disbursals rose 8%. Our robust, seamless and pivotal process won.';
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text, sentences: sents(text), targets: [0, 2], rounds: 3, targetPct: 60 });
    const calls = kinds(h.log, 'cand');
    assert.deepEqual(calls.map((c) => c.items.map((it) => it.index)), [[0, 2], [2]]);
    assert.equal(res.text, 'We look into retail credit. Disbursals rose 8%. Our sound, smooth and pivotal process won.');
  });

  test('rounds = 0, empty or invalid targets do nothing and call nothing', async () => {
    for (const opts of [{ rounds: 0, targets: [1] }, { targets: [] }, { targets: [-1, 1.5, 99, '1', NaN] }, { targets: undefined }]) {
      const h = harness({ cands: { 0: { 1: [GOOD] } } });
      const res = await run(h, { text: T1, sentences: sents(T1), ...opts });
      assert.equal(res.text, T1);
      assert.deepEqual(res.warnings, ['no-change']);
      assert.equal(h.log.length, 0);
    }
  });

  test('duplicate and unsorted targets are processed once, in text order; string rounds work', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1, 0, 1], rounds: '2', targetPct: 0 });
    assert.deepEqual(res.changes.map((c) => c.index), [0, 1]);
    assert.deepEqual(kinds(h.log, 'cand').map((c) => c.round), [0, 1]);
  });
});

describe('rewriteFlagged: offsets', () => {
  test('several targets in one paragraph, longer and shorter versions', async () => {
    const text = 'We delve into retail credit. Our book is ₹8,200 crore. Robust and seamless growth followed in FY24. DSAs sourced 61% of loans. This was a pivotal and robust year.';
    const S = sents(text);
    assert.equal(S.length, 5);
    const cands = { 0: {
      0: ['We now lend mostly to salaried home buyers, which is retail credit.'],
      2: ['Growth followed in FY24.'],
      4: ['This year mattered.'],
    } };
    const h = harness({ cands });
    const res = await run(h, { text, sentences: S, targets: [4, 0, 2] });
    assert.equal(res.text, 'We now lend mostly to salaried home buyers, which is retail credit. Our book is ₹8,200 crore. Growth followed in FY24. DSAs sourced 61% of loans. This year mattered.');
    assert.deepEqual(res.changes.map((c) => [c.index, c.after]), [[0, cands[0][0][0]], [2, cands[0][2][0]], [4, cands[0][4][0]]]);
  });

  test('offsets are recomputed between rounds across paragraphs', async () => {
    const text = 'Intro line here.\n\nWe delve into robust growth. RBI norms apply to NBFCs. Our LTV is 65%.\n\nCollections are seamless and robust. Thanks.';
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text, sentences: sents(text), targets: [1, 4], rounds: 3, targetPct: 0 });
    assert.equal(res.text, 'Intro line here.\n\nWe look into sound growth. RBI norms apply to NBFCs. Our LTV is 65%.\n\nCollections are smooth and sound. Thanks.');
    // round 1 saw the round-0 versions as current sentences and neighbours
    const r1 = kinds(h.log, 'cand')[1].items;
    assert.deepEqual(r1.map((it) => it.sentence), ['We look into robust growth.', 'Collections are smooth and robust.']);
    // and its windows were cut from the updated text
    const g1 = kinds(h.log, 'guide')[1].texts;
    assert.equal(g1[0], 'Intro line here.\n\nWe look into robust growth. RBI norms apply to NBFCs.');
    assert.equal(g1[1], 'Our LTV is 65%.\n\nCollections are smooth and robust. Thanks.');
  });

  test('adjacent targets both change in the same round', async () => {
    const text = 'First is robust. Second is seamless. Third stays.';
    const h = harness({ cands: { 0: { 0: ['First holds up.'], 1: ['The second one is a far longer replacement sentence.'] } } });
    const res = await run(h, { text, sentences: sents(text), targets: [0, 1] });
    assert.equal(res.text, 'First holds up. The second one is a far longer replacement sentence. Third stays.');
  });

  test('a version that is two sentences keeps its index in later rounds', async () => {
    const text = 'Opening line. Underwriting is robust and seamless at 1,00,000 accounts. Closing line.';
    const two = 'Underwriting is robust. It covers 1,00,000 accounts.';
    const cands = (it, round) => (round === 0 ? [two] : [peel(it.sentence)]);
    const h = harness({ cands });
    const res = await run(h, { text, sentences: sents(text), targets: [1], rounds: 2, targetPct: 0 });
    assert.equal(res.text, 'Opening line. Underwriting is sound. It covers 1,00,000 accounts. Closing line.');
    const it = kinds(h.log, 'cand')[1].items[0];
    assert.deepEqual([it.index, it.before, it.sentence, it.after], [1, 'Opening line.', two, 'Closing line.']);
  });

  test('identical sentences appearing twice are rewritten in place, each its own way', async () => {
    const text = 'The plan is robust and seamless. Disbursals rose 8%. The plan is robust and seamless.';
    const both = harness({ cands: { 0: { 0: ['The plan held up well.'], 2: ['The plan still works.'] } } });
    assert.equal((await run(both, { text, sentences: sents(text), targets: [0, 2] })).text, 'The plan held up well. Disbursals rose 8%. The plan still works.');
    const second = harness({ cands: { 0: { 0: ['The plan held up well.'], 2: ['The plan still works.'] } } });
    assert.equal((await run(second, { text, sentences: sents(text), targets: [2] })).text, 'The plan is robust and seamless. Disbursals rose 8%. The plan still works.');
    const first = harness({ cands: { 0: { 0: ['The plan held up well.'], 2: ['The plan still works.'] } } });
    assert.equal((await run(first, { text, sentences: sents(text), targets: [0] })).text, 'The plan held up well. Disbursals rose 8%. The plan is robust and seamless.');
    const same = harness({ cands: (it) => [peel(it.sentence)] });
    const r = await run(same, { text, sentences: sents(text), targets: [0, 2], rounds: 3, targetPct: 0 });
    assert.equal(r.text, 'The plan is sound and smooth. Disbursals rose 8%. The plan is sound and smooth.');
    assert.deepEqual(r.changes.map((c) => c.index), [0, 2]);
  });

  test('stale or overlapping offsets throw before anything runs', async () => {
    const h = harness({ cands: { 0: { 1: [GOOD] } } });
    const other = sents(T1.replace('Our AUM', 'The AUM of the company'));
    await assert.rejects(run(h, { text: T1, sentences: other, targets: [1] }), RangeError);
    const S = sents(T1);
    await assert.rejects(run(h, { text: T1, sentences: [S[0], { ...S[1], start: S[0].end - 3, text: undefined }], targets: [1] }), RangeError);
    await assert.rejects(run(h, { text: T1, sentences: [{ start: 0, end: T1.length + 5 }], targets: [0] }), RangeError);
    await assert.rejects(run(h, { text: T1, sentences: 'nope', targets: [0] }), TypeError);
    assert.equal(h.log.length, 0);
  });

  test('input validation', async () => {
    const h = harness();
    await assert.rejects(rewriteFlagged({ text: 5, scoreGuide: h.scoreGuide, gate: h.gate, getCandidates: h.getCandidates }), TypeError);
    await assert.rejects(rewriteFlagged({ text: T1, scoreGuide: h.scoreGuide, gate: h.gate }), /getCandidates/);
    await assert.rejects(rewriteFlagged({ text: T1, getCandidates: h.getCandidates, gate: h.gate }), /scoreGuide/);
    await assert.rejects(rewriteFlagged({ text: T1, getCandidates: h.getCandidates, scoreGuide: h.scoreGuide }), /gate/);
    await assert.rejects(rewriteFlagged(), TypeError);
  });
});

describe('rewriteFlagged: list markers and layout', () => {
  const ROBUST = (t) => 30 + 20 * marks(t);
  const okGate = async () => ({ ok: true, reasons: [] });

  test('keepMarker: the original marker wins, a new one is dropped, wording is never taken for a marker', () => {
    const rows = [
      ['• Growth was robust.', 'Growth held up.', '• Growth held up.'],
      ['• Growth was robust.', '- Growth held up.', '• Growth held up.'],
      ['•Growth was robust.', 'Growth held up.', '•Growth held up.'],
      ['- Growth was robust.', 'Growth held up.', '- Growth held up.'],
      ['– Growth was robust.', '• Growth held up.', '– Growth held up.'],
      ['* Figures are provisional.', 'These figures are provisional.', '* These figures are provisional.'],
      ['(a) Growth was robust.', 'a) Growth held up.', '(a) Growth held up.'],
      ['2) Growth was robust.', 'Growth held up.', '2) Growth held up.'],
      ['2) Growth was robust.', '3) Growth held up.', '2) Growth held up.'],
      ['(iv) Growth was robust.', 'Growth held up.', '(iv) Growth held up.'],
      ['1. Growth was robust.', '1) Growth held up.', '1. Growth held up.'],
      ['## Key risks', 'Main risks', '## Main risks'],
      ['Growth was robust.', '* Growth held up.', 'Growth held up.'],
      ['Growth was robust.', '1. Growth held up.', 'Growth held up.'],
      ['Growth was robust.', '*Growth* held up.', '*Growth* held up.'],
      // wording, not markers
      ['> 90% of loans are secured.', 'More than 90% of loans are secured.', 'More than 90% of loans are secured.'],
      ['+12% growth came from DSAs.', 'DSAs drove 12% growth.', 'DSAs drove 12% growth.'],
      ['# of DSAs rose to 1,200.', 'DSA count rose to 1,200.', 'DSA count rose to 1,200.'],
      ['1.5 lakh loans were robust.', '1.5 lakh loans held up.', '1.5 lakh loans held up.'],
      ['A. K. Sharma joined as CRO.', 'A. K. Sharma is now CRO.', 'A. K. Sharma is now CRO.'],
      ['- Growth was robust.', '-5% was the hit.', '- -5% was the hit.'],
      ['• Growth.', '•', '•'],
    ];
    for (const [o, c, want] of rows) assert.equal(keepMarker(o, c), want, `${o} | ${c}`);
  });

  test('a bulleted answer keeps its bullets when the engine drops them', async () => {
    const text = 'Highlights for FY24:\n• Our collection efficiency remained robust at 98.5%.\n• GNPA was seamless at 1.8%.\n• RBI norms were met.';
    const S = sents(text);
    assert.deepEqual(S.map((s) => s.text.slice(0, 2)), ['Hi', '• ', '• ', '• ']);
    const h = harness({ guide: ROBUST, cands: { 0: {
      1: ['Our collection efficiency held at 98.5%.', '- Our collection efficiency held at 98.5%.', '• Our collection efficiency held at 98.5%.'],
      2: ['GNPA was 1.8%.'],
    } } });
    const res = await run(h, { text, sentences: S, targets: [1, 2] });
    assert.equal(res.text, 'Highlights for FY24:\n• Our collection efficiency held at 98.5%.\n• GNPA was 1.8%.\n• RBI norms were met.');
    // the three spellings are one version: gated once, with the marker the answer will carry
    assert.deepEqual(kinds(h.log, 'gate').map((g) => g.candidate), ['• Our collection efficiency held at 98.5%.', '• GNPA was 1.8%.']);
    assert.deepEqual(res.changes.map((c) => c.after), ['• Our collection efficiency held at 98.5%.', '• GNPA was 1.8%.']);
  });

  test('numbered and lettered points keep their numbers; a version never adds a marker', async () => {
    const text = 'Our plan has two parts.\n1) We delve into salaried home loans.\n(b) Robust DSA sourcing in Tier 2 towns follows.';
    const h = harness({ guide: ROBUST, cands: { 0: { 1: ['We focus on salaried home loans.'], 2: ['b) DSA sourcing in Tier 2 towns follows.'] } } });
    const res = await run(h, { text, sentences: sents(text), targets: [1, 2] });
    assert.equal(res.text, 'Our plan has two parts.\n1) We focus on salaried home loans.\n(b) DSA sourcing in Tier 2 towns follows.');
    const t2 = 'We delve into retail credit. Disbursals rose 8%.';
    const h2 = harness({ guide: ROBUST, cands: { 0: { 0: ['- We now lend to retail borrowers.'] } } });
    assert.equal((await run(h2, { text: t2, sentences: sents(t2), targets: [0] })).text, 'We now lend to retail borrowers. Disbursals rose 8%.');
  });

  test('a version equal to the original is never gated, even after the sentence has changed', async () => {
    const text = 'Opening line. We delve into robust credit. Closing line.';
    const orig = 'We delve into robust credit.';
    const cands = (it, round) => (round === 0 ? ['We delve into sound credit.'] : [orig, ` ${orig} `, peel(it.sentence)]);
    const h = harness({ cands });
    const res = await run(h, { text, sentences: sents(text), targets: [1], rounds: 2, targetPct: 0 });
    assert.equal(res.text, 'Opening line. We look into sound credit. Closing line.');
    assert.ok(kinds(h.log, 'gate').every((g) => g.candidate !== orig));
  });

  test('every line-break character is a layout change', async () => {
    for (const br of ['\n', '\r', '\v', '\f', '\u0085', ' ', ' ']) {
      const h = harness({ cands: { 0: { 1: [`Underwriting covered${br}1,00,000 accounts.`] } } });
      const res = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
      assert.equal(res.text, T1, JSON.stringify(br));
      assert.equal(res.changes[0].rejected[0].reasons[0].code, 'layout');
      assert.equal(kinds(h.log, 'gate').length, 0);
    }
  });

  test('caller spans with surrounding spaces are trimmed, so sentences never run together', async () => {
    const text = '  Growth was robust.   Next one here.\n';
    const res = await rewriteFlagged({ text, sentences: [{ start: 0, end: 23 }, { start: 23, end: text.length }], targets: [0],
      getCandidates: async () => new Map([[0, ['Growth held up.']]]), scoreGuide: async (ts) => ts.map(ROBUST), gate: okGate });
    assert.equal(res.text, '  Growth held up.   Next one here.\n');
    assert.equal(res.changes[0].before, 'Growth was robust.');
  });

  test('targets with no words (empty or punctuation-only spans) are ignored', async () => {
    const text = 'Growth was robust. — Next one here.';
    const S = [{ start: 0, end: 18 }, { start: 19, end: 20 }, { start: 21, end: 21 }, { start: 21, end: 35 }];
    const h = harness({ cands: { 0: { 1: ['Inserted text.'], 2: ['More inserted text.'] } } });
    const res = await run(h, { text, sentences: S, targets: [1, 2] });
    assert.equal(res.text, text);
    assert.equal(h.log.length, 0);
    assert.deepEqual(res.changes, []);
  });

  test('applyChanges keeps text order for spans that start at the same offset', () => {
    const t = 'abc def';
    const S = [{ start: 3, end: 3, text: '' }, { start: 3, end: 3, text: '' }, { start: 4, end: 7, text: 'def' }];
    const { text, sentences } = applyChanges(t, S, new Map([[0, 'A'], [1, 'B'], [2, 'D']]));
    assert.equal(text, 'abcAB D');
    for (const s of sentences) assert.equal(text.slice(s.start, s.end), s.text);
  });

  test('property: markers, paragraphs and untouched sentences survive any mix of versions', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const any = (xs) => xs[Math.floor(rnd() * xs.length)];
    const W = ['robust', 'seamless', 'growth', 'GNPA', '₹1,00,000', 'crore', 'delve', 'loans', 'RBI', 'FY24', 'pivotal', 'DSAs', '1.8%'];
    const sentence = () => {
      const w = Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => any(W));
      return w.join(' ').replace(/^./, (c) => c.toUpperCase()) + any(['.', '.', '?', '!']);
    };
    const markerCount = (t) => (t.match(/(?:^|\n)(?:• |- |\(a\) |2\) )/g) || []).length;
    for (let k = 0; k < 300; k++) {
      const text = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Array.from({ length: 1 + Math.floor(rnd() * 4) },
        () => any(['', '', '• ', '- ', '(a) ', '2) ']) + sentence()).join(any([' ', '  ', '\n']))).join('\n\n');
      const S = sents(text);
      const targets = S.map((_, i) => i).filter(() => rnd() < 0.5);
      const res = await run(harness({ guide: (t) => ROBUST(t) + (t.length % 3), cands: (it) => [
        peel(it.sentence).replace(/^(?:• |- |\(a\) |2\) )/, ''), sentence(), it.sentence.replace(/[.?!]$/, ''), `${peel(it.sentence)}\nNew line.`,
      ] }), { text, sentences: S, targets, rounds: 3, targetPct: 0 });
      let rebuilt = text;
      for (const c of [...res.changes].sort((a, b) => b.index - a.index)) rebuilt = rebuilt.slice(0, S[c.index].start) + c.after + rebuilt.slice(S[c.index].end);
      assert.equal(res.text, rebuilt, text);
      assert.equal(markerCount(res.text), markerCount(text), text);
      assert.equal(res.text.split('\n').length, text.split('\n').length, text);
      const changed = new Set(res.changes.filter((c) => c.after !== c.before).map((c) => c.index));
      S.forEach((s, i) => { if (!changed.has(i)) assert.ok(res.text.includes(s.text)); });
      for (const c of res.changes) assert.equal(/[.?!]$/.test(c.after), /[.?!]$/.test(c.before), c.after);
    }
  });
});

describe('rewriteFlagged: validator and warnings', () => {
  test('the validator runs exactly twice, after every guide call, on the whole answer', async () => {
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const res = await run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 3, targetPct: 0 });
    const v = h.log.map((e, k) => [e.kind, k]).filter(([kind]) => kind === 'validator').map(([, k]) => k);
    const lastGuide = h.log.map((e) => e.kind).lastIndexOf('guide');
    assert.equal(v.length, 2);
    assert.ok(v.every((k) => k > lastGuide));
    assert.deepEqual(kinds(h.log, 'validator').map((e) => e.text), [T1, res.text]);
  });

  test('goodhart when the guide improves a lot but the validator does not', async () => {
    const c = { 0: { 1: [GOOD] } };
    const flat = await run(harness({ cands: c, validator: () => 70 }), { text: T1, sentences: sents(T1), targets: [1] });
    assert.deepEqual(flat.warnings, ['goodhart']);
    assert.deepEqual(flat.validator, { before: 70, after: 70 });
    let n = 0;
    const small = await run(harness({ cands: c, validator: () => (n++ ? 67.5 : 70) }), { text: T1, sentences: sents(T1), targets: [1] });
    assert.deepEqual(small.warnings, ['goodhart']);
    n = 0;
    const enough = await run(harness({ cands: c, validator: () => (n++ ? 67 : 70) }), { text: T1, sentences: sents(T1), targets: [1] });
    assert.deepEqual(enough.warnings, []);
    n = 0;
    const worse = await run(harness({ cands: c, validator: () => (n++ ? 80 : 70) }), { text: T1, sentences: sents(T1), targets: [1] });
    assert.deepEqual(worse.warnings, ['goodhart']);
    assert.deepEqual(worse.validator, { before: 70, after: 80 });
    // a small guide gain (under 10 points on average) is no reason to warn
    const text = 'Opening line. Old sentence here. Closing line.';
    const guide = (t) => (t.includes('New') ? 81 : 90);
    const mild = await run(harness({ guide, validator: () => 70, cands: { 0: { 1: ['New sentence here.'] } } }), { text, sentences: sents(text), targets: [1] });
    assert.deepEqual(mild.warnings, []);
  });

  test('the guide average covers every target, changed or not', async () => {
    const text = 'Opening line. Old sentence here. Middle line. Another one here. Closing line.';
    const guide = (t) => (t.includes('New') ? 75 : 90);
    const res = await run(harness({ guide, validator: () => 70, cands: { 0: { 1: ['New sentence here.'] } } }), { text, sentences: sents(text), targets: [1, 3] });
    assert.deepEqual(res.changes.map((c) => [c.guideBefore, c.guideAfter]), [[90, 75], [90, 90]]);
    assert.deepEqual(res.warnings, []); // average gain 7.5
  });

  test('a missing or failing validator never blocks the result', async () => {
    const c = { 0: { 1: [GOOD] } };
    const none = await run(harness({ cands: c, validator: () => null }), { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(none.text, T1.replace(T1_S1, GOOD));
    assert.deepEqual(none.warnings, ['no-validator']);
    const h = harness({ cands: c, validator: () => { throw new Error('model failed to load'); } });
    const boom = await run(h, { text: T1, sentences: sents(T1), targets: [1] });
    assert.equal(boom.text, T1.replace(T1_S1, GOOD));
    assert.deepEqual(boom.validator, { before: null, after: null });
    const noFn = await run(harness({ cands: c }), { text: T1, sentences: sents(T1), targets: [1], scoreValidator: undefined });
    assert.deepEqual(noFn.warnings, ['no-validator']);
  });
});

describe('rewriteFlagged: abort', () => {
  const waitAbort = (ms, ctl) => setTimeout(() => ctl.abort(), ms);

  test('an already-aborted signal throws before any work', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const h = harness({ cands: { 0: { 1: [GOOD] } } });
    await assert.rejects(run(h, { text: T1, sentences: sents(T1), targets: [1], signal: ctl.signal }), { name: 'AbortError' });
    assert.equal(h.log.length, 0);
  });

  test('aborts promptly while the engine ignores the signal', async () => {
    const ctl = new AbortController();
    const h = harness();
    const t0 = Date.now();
    waitAbort(15, ctl);
    await assert.rejects(run(h, { text: T1, sentences: sents(T1), targets: [1], signal: ctl.signal, getCandidates: () => new Promise(() => {}) }), { name: 'AbortError' });
    assert.ok(Date.now() - t0 < 500);
  });

  test('aborts during the guards and during scoring', async () => {
    const c1 = new AbortController();
    const h1 = harness({ cands: { 0: { 1: [GOOD] } } });
    waitAbort(10, c1);
    await assert.rejects(run(h1, { text: T1, sentences: sents(T1), targets: [1], signal: c1.signal, gate: () => new Promise(() => {}) }), { name: 'AbortError' });
    const c2 = new AbortController();
    waitAbort(10, c2);
    await assert.rejects(run(h1, { text: T1, sentences: sents(T1), targets: [1], signal: c2.signal, scoreGuide: () => new Promise(() => {}) }), { name: 'AbortError' });
  });

  test('aborting in a later round returns no partial text', async () => {
    const ctl = new AbortController();
    const h = harness();
    const getCandidates = async (items, round) => {
      if (round === 0) return new Map([[1, [peel(T1_S1)]]]);
      ctl.abort();
      return new Map([[1, [peel(peel(T1_S1))]]]);
    };
    await assert.rejects(run(h, { text: T1, sentences: sents(T1), targets: [1], rounds: 3, targetPct: 0, signal: ctl.signal, getCandidates }), { name: 'AbortError' });
    assert.equal(kinds(h.log, 'validator').length, 0);
  });

  test('aborts during the validator', async () => {
    const ctl = new AbortController();
    const h = harness({ cands: { 0: { 1: [GOOD] } } });
    waitAbort(10, ctl);
    await assert.rejects(run(h, { text: T1, sentences: sents(T1), targets: [1], signal: ctl.signal, scoreValidator: () => new Promise(() => {}) }), { name: 'AbortError' });
  });

  test('a custom abort reason still surfaces as AbortError; an engine error after abort too', async () => {
    const ctl = new AbortController();
    const getCandidates = () => new Promise((_, reject) => { ctl.signal.addEventListener('abort', () => reject(new TypeError('fetch failed'))); });
    setTimeout(() => ctl.abort('user pressed stop'), 5);
    await assert.rejects(run(harness(), { text: T1, sentences: sents(T1), targets: [1], signal: ctl.signal, getCandidates }),
      (err) => err.name === 'AbortError' && err.cause === 'user pressed stop');
  });

  test('no unhandled rejections after an abort or after a finished run', async () => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const c1 = new AbortController();
      const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late engine failure')), 20));
      waitAbort(5, c1);
      await assert.rejects(run(harness(), { text: T1, sentences: sents(T1), targets: [1], signal: c1.signal, getCandidates: late }), { name: 'AbortError' });
      const c2 = new AbortController();
      const res = await run(harness({ cands: { 0: { 1: [GOOD] } } }), { text: T1, sentences: sents(T1), targets: [1], signal: c2.signal });
      c2.abort();
      assert.equal(res.text, T1.replace(T1_S1, GOOD));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(seen, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('an engine error (not an abort) propagates unchanged', async () => {
    const err = new Error('llama-server is not running');
    await assert.rejects(run(harness(), { text: T1, sentences: sents(T1), targets: [1], getCandidates: async () => { throw err; } }), (e) => e === err);
  });
});

describe('rewriteFlagged: progress and determinism', () => {
  test('progress is monotonic, ends at total, and a throwing listener is harmless', async () => {
    const events = [];
    const h = harness({ cands: (it) => [peel(it.sentence)] });
    const text = 'Intro line here.\n\nWe delve into robust growth. RBI norms apply to NBFCs. Our LTV is 65%.\n\nCollections are seamless and robust. Thanks.';
    const res = await run(h, {
      text, sentences: sents(text), targets: [1, 4], rounds: 4, targetPct: 0,
      onProgress: (p) => { events.push(p); throw new Error('UI bug'); },
    });
    assert.ok(res.text.includes('We look into sound growth.'));
    assert.ok(events.length > 4);
    for (const e of events) {
      assert.equal(e.total, 8);
      assert.equal(typeof e.message, 'string');
      assert.ok(Number.isInteger(e.round));
    }
    for (let k = 1; k < events.length; k++) assert.ok(events[k].done >= events[k - 1].done);
    assert.equal(events.at(-1).done, 8);
    assert.match(events.at(-1).message, /^Done: 2 of 2 sentences changed\.$/);
  });

  test('same inputs give the same result and the same calls', async () => {
    const text = 'Intro line here.\n\nWe delve into robust growth of ₹1,00,000. RBI norms apply to NBFCs. The plan is robust and seamless.\n\nThe plan is robust and seamless. Thanks.';
    const cands = (it, round) => [peel(it.sentence), `${it.sentence.replace(/\.$/, '')} indeed.`, `Here is ${it.sentence}`, round ? peel(peel(it.sentence)) : ''];
    const once = async () => { const h = harness({ cands }); const res = await run(h, { text, sentences: sents(text), targets: [4, 1, 3], rounds: 3, targetPct: 40 }); return { res, log: h.log }; };
    const a = await once(), b = await once();
    assert.deepEqual(a.res, b.res);
    assert.deepEqual(a.log, b.log);
    assert.notEqual(a.res.text, text);
  });
});
