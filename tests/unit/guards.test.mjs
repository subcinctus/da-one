import test from 'node:test';
import assert from 'node:assert/strict';
import { gateCandidate, DEFAULT_LIMITS, editRatio } from '../../ai-checker/src/guards.mjs';

// ---------- deterministic fakes for the page's model checks ----------
const GOOD = { entailment: 0.95, contradiction: 0.01, neutral: 0.04 };

// NLI that answers by direction: forward when the premise is (or starts with) the original.
function fakeNli(orig, fwd = GOOD, bwd = GOOD) {
  const calls = [];
  const fn = async (premise, hypothesis) => {
    calls.push([premise, hypothesis]);
    return premise.startsWith(orig) ? fwd : bwd;
  };
  fn.calls = calls;
  return fn;
}

// Unit vectors at a chosen cosine.
function fakeEmbed(cos = 0.95) {
  const calls = [];
  const fn = async (texts) => {
    calls.push(texts);
    return [Float32Array.from([1, 0, 0]), Float32Array.from([cos, Math.sqrt(1 - cos * cos), 0])];
  };
  fn.calls = calls;
  return fn;
}

// A tiny rule-based linter in the Harper shape ({start, end, kind, message, problem?}).
const TYPOS = new Set(['teh', 'recieve', 'seperate']);
function fakeGrammar() {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    const out = [];
    for (const m of text.matchAll(/\b[\p{L}]+\b/gu)) {
      // no `problem` here: the guard must slice the text itself
      if (TYPOS.has(m[0].toLowerCase())) out.push({ start: m.index, end: m.index + m[0].length, kind: 'Spelling', message: `Did you mean to spell “${m[0]}” this way?` });
    }
    for (const m of text.matchAll(/\b(we|they) (has|was)\b/giu)) {
      out.push({ start: m.index, end: m.index + m[0].length, kind: 'Agreement', message: 'Subject and verb do not agree.', problem: m[0] });
    }
    for (const m of text.matchAll(/\b(\w+) \1\b/giu)) {
      out.push({ start: m.index, end: m.index + m[0].length, kind: 'Repetition', message: `“${m[1]}” is repeated.`, problem: m[0] });
    }
    for (const s of text.split(/[.!?]\s+/)) {
      if (s.split(/\s+/).length > 30) out.push({ start: text.indexOf(s), end: text.indexOf(s) + s.length, kind: 'Readability', message: 'This sentence is long.', problem: s });
    }
    if (/\bvery\b/i.test(text)) out.push({ start: text.search(/\bvery\b/i), end: text.search(/\bvery\b/i) + 4, kind: 'Style', message: 'Avoid “very”.', problem: 'very' });
    return out;
  };
  fn.calls = calls;
  return fn;
}

const fullCtx = (orig, { fwd, bwd, cos, ...rest } = {}) => ({
  nli: fakeNli(orig, fwd, bwd), embed: fakeEmbed(cos), grammar: fakeGrammar(), ...rest,
});
const codes = (r) => r.reasons.map((x) => x.code);
const modelCalls = (ctx) => ctx.nli.calls.length + ctx.embed.calls.length + ctx.grammar.calls.length;

const ORIG = 'We cut GNPA to 1.4% in FY24 by tightening underwriting for DSAs in Tier 2 cities.';
const PARA = 'In FY2023-24 we brought GNPA down to 1.4% by tightening underwriting for DSAs in Tier 2 cities.';

// ---------- DEFAULT_LIMITS ----------
test('DEFAULT_LIMITS holds the contract values and cannot be changed by accident', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, { entailment: 0.80, contradiction: 0.10, cosine: 0.85, maxEditRatio: 0.80,
    minLengthRatio: 0.6, maxLengthRatio: 1.6 });
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
});

// ---------- editRatio ----------
test('editRatio: identical text is 0, ignoring case and punctuation', () => {
  assert.equal(editRatio(ORIG, ORIG), 0);
  assert.equal(editRatio('Growth was strong.', 'growth, was strong!'), 0);
  assert.equal(editRatio('Growth was strong', 'Growth   was\nstrong'), 0);
});

test('editRatio: word-level Levenshtein over the longer word count', () => {
  assert.equal(editRatio('we cut costs fast', 'we cut costs quickly'), 1 / 4); // one substitution
  assert.equal(editRatio('we cut costs', 'we cut all costs'), 1 / 4); // one insertion
  assert.equal(editRatio('we cut all costs', 'we cut costs'), 1 / 4); // one deletion
  assert.equal(editRatio('a b c d', 'w x y z'), 1);
  assert.equal(editRatio('a b c d', 'b c d a'), 2 / 4); // a move is a delete and an insert
  assert.equal(editRatio('one two', 'two one three four'), editRatio('two one three four', 'one two'));
});

test('editRatio: empty input and odd types never throw', () => {
  assert.equal(editRatio('', ''), 0);
  assert.equal(editRatio(null, undefined), 0);
  assert.equal(editRatio('', 'some words here'), 1);
  assert.equal(editRatio('some words here', '  \n '), 1);
  assert.equal(editRatio(12345, '12345'), 0);
});

test('editRatio: Indian amounts are single words', () => {
  assert.equal(editRatio('GNPA of ₹1,00,000 crore', 'GNPA of ₹2,00,000 crore'), 1 / 4);
  assert.equal(editRatio('GNPA of ₹1,00,000 crore', 'GNPA of Rs 1,00,000 crore'), 1 / 5);
});

test('editRatio: very long texts stay fast and within 0..1', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `w${i % 997}`).join(' ');
  const b = a.split(' ').reverse().join(' ');
  const t0 = Date.now();
  const r = editRatio(a, b);
  assert.ok(Date.now() - t0 < 3000, 'took too long');
  assert.ok(r >= 0 && r <= 1);
});

// ---------- the happy path ----------
test('a correct paraphrase passes every check, with metrics for display', async () => {
  const ctx = fullCtx(ORIG);
  const r = await gateCandidate(ORIG, PARA, ctx);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons, []);
  const m = r.metrics;
  assert.equal(m.wordsBefore, 16);
  assert.equal(m.wordsAfter, 17);
  assert.ok(m.lengthRatio > 1 && m.lengthRatio < 1.1);
  assert.ok(m.editRatio > 0 && m.editRatio < DEFAULT_LIMITS.maxEditRatio);
  assert.equal(m.cosine.toFixed(4), '0.9500');
  assert.equal(m.entailment, 0.95);
  assert.equal(m.contradiction, 0.01);
  assert.deepEqual(m.grammar, { before: 0, after: 0, added: [] });
  assert.equal(m.facts.ok, true);
  assert.deepEqual(m.newEntities, []);
  assert.deepEqual(m.skipped, []);
  assert.deepEqual(m.errors, {});
  // NLI ran both ways with the arguments swapped
  assert.deepEqual(ctx.nli.calls, [[ORIG, PARA], [PARA, ORIG]]);
  assert.deepEqual(ctx.embed.calls, [[ORIG, PARA]]);
});

test('equivalent Indian spellings of amounts and fiscal years pass', async () => {
  const o = 'We disbursed ₹1,00,000 crore in FY24 and kept LTV under 70 per cent.';
  const c = 'In FY2023-24 we disbursed Rs 1 lakh crore and kept LTV under 70%.';
  const r = await gateCandidate(o, c, fullCtx(o));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test('no model functions: the cheap checks decide and the rest are reported as skipped', async () => {
  const r = await gateCandidate(ORIG, PARA);
  assert.equal(r.ok, true);
  assert.deepEqual(r.metrics.skipped, [{ check: 'grammar', why: 'unavailable' }, { check: 'similarity', why: 'unavailable' }, { check: 'nli', why: 'unavailable' }]);
  assert.equal(r.metrics.cosine, null);
  assert.equal(r.metrics.entailment, null);
  const r2 = await gateCandidate(ORIG, PARA, { nli: undefined, embed: null, grammar: 'no' });
  assert.equal(r2.ok, true);
  assert.equal(r2.metrics.skipped.length, 3);
});

// ---------- facts, negations, modals ----------
test('a dropped number fails and no model is called', async () => {
  const ctx = fullCtx(ORIG);
  const r = await gateCandidate(ORIG, 'We cut GNPA in FY24 by tightening underwriting for DSAs in Tier 2 cities.', ctx);
  assert.deepEqual(codes(r), ['facts']);
  assert.match(r.reasons[0].message, /numbers missing: 1\.4%/);
  assert.equal(modelCalls(ctx), 0);
  assert.deepEqual(r.metrics.skipped.map((s) => s.why), ['earlier-failure', 'earlier-failure', 'earlier-failure']);
});

test('an added or changed number fails', async () => {
  const added = await gateCandidate(ORIG, 'We cut GNPA to 1.4% in FY24 by tightening underwriting for 300 DSAs in Tier 2 cities.', fullCtx(ORIG));
  assert.deepEqual(codes(added), ['facts']);
  assert.match(added.reasons[0].message, /numbers added: 300/);
  const changed = await gateCandidate(ORIG, 'We cut GNPA to 1.5% in FY25 by tightening underwriting for DSAs in Tier 2 cities.', fullCtx(ORIG));
  assert.deepEqual(codes(changed), ['facts']);
  assert.match(changed.reasons[0].message, /missing: .*1\.4%/);
  assert.match(changed.reasons[0].message, /added: .*1\.5%/);
  const lakh = await gateCandidate('We lent ₹5 lakh per borrower.', 'We lent ₹5 crore per borrower.', fullCtx('We lent ₹5 lakh per borrower.'));
  assert.deepEqual(codes(lakh), ['facts']);
});

test('a dropped acronym fails as a missing term', async () => {
  const r = await gateCandidate(ORIG, 'We cut bad loans to 1.4% in FY24 by tightening underwriting for DSAs in Tier 2 cities.');
  assert.deepEqual(codes(r), ['facts']);
  assert.match(r.reasons[0].message, /names or terms missing: GNPA/);
});

test('a flipped negation fails, in either direction', async () => {
  const add = await gateCandidate(ORIG, 'We did not cut GNPA to 1.4% in FY24 by tightening underwriting for DSAs in Tier 2 cities.', fullCtx(ORIG));
  assert.deepEqual(codes(add), ['negation']);
  assert.match(add.reasons[0].message, /0 before, 1 after/);
  const o = 'We do not lend to builders without RERA approval.';
  const drop = await gateCandidate(o, 'We lend to builders without RERA approval.', fullCtx(o));
  assert.deepEqual(codes(drop), ['negation']);
  const nt = await gateCandidate(o, "We don't lend to builders without RERA approval.", fullCtx(o));
  assert.equal(nt.ok, true, JSON.stringify(nt.reasons));
});

test("'may' → 'will' fails as a modal change", async () => {
  const o = 'Disbursements may grow 20% in FY25 if rates ease.';
  const r = await gateCandidate(o, 'Disbursements will grow 20% in FY25 if rates ease.', fullCtx(o));
  assert.deepEqual(codes(r), ['modal']);
  assert.match(r.reasons[0].message, /“may” 1 → 0/);
  assert.match(r.reasons[0].message, /“will” 0 → 1/);
  const ok = await gateCandidate(o, 'If rates ease, disbursements may grow 20% in FY25.', fullCtx(o));
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
});

// ---------- new entities ----------
test('new names and acronyms fail; known ones in another case or form do not', async () => {
  const r = await gateCandidate(ORIG, 'We cut GNPA to 1.4% in FY24 with HDFC by tightening underwriting for DSAs in Tier 2 cities like Indore.');
  assert.ok(codes(r).includes('new-entity'));
  assert.deepEqual(r.metrics.newEntities, ['HDFC', 'Indore']);
  assert.match(r.reasons.find((x) => x.code === 'new-entity').message, /HDFC, Indore/);
  // the facts reason does not repeat what new-entity already says
  assert.ok(!r.reasons.some((x) => x.code === 'facts'));

  const o = 'The board approved the DSA payout of ₹500 for each file in 31/03/2025 data.';
  const c = 'The Board approved the DSAs payout of Rs 500 for each file in 31 March 2025 data.';
  const r2 = await gateCandidate(o, c);
  assert.deepEqual(r2.metrics.newEntities, [], JSON.stringify(r2.metrics.newEntities));
});

test('Tier 2 written as Tier-II is not a new acronym (the facts check owns tier terms)', async () => {
  for (const [o, c] of [
    ['We grew in Tier 2 and Tier 3 cities in FY24.', 'In FY24 we grew in Tier-II and Tier-III cities.'],
    ['We grew in Tier 2 and Tier 3 cities in FY24.', 'In FY24 we grew in Tier II & Tier III cities.'],
    ['We lend in Tier-II towns.', 'We lend in Tier 2 towns.'],
  ]) {
    const r = await gateCandidate(o, c, { limits: { maxEditRatio: 1 } });
    assert.deepEqual(r.metrics.newEntities, [], c);
    assert.equal(r.ok, true, `${c}: ${JSON.stringify(r.reasons)}`);
  }
  // "Tier II and III" is a tier list too; whether it equals "Tier 2 and 3" is for the facts check
  const list = await gateCandidate('We grew in Tier 2 and 3 cities in FY24.', 'In FY24 we grew in Tier II and III cities.', { limits: { maxEditRatio: 1 } });
  assert.deepEqual(list.metrics.newEntities, []);
  assert.ok(!codes(list).includes('new-entity'));
  // a different tier is still a changed fact
  const r = await gateCandidate('We grew in Tier 2 cities.', 'We grew in Tier-III cities.');
  assert.deepEqual(codes(r), ['facts']);
  // other Roman numerals that are new still count
  const p = await gateCandidate('The LOS rollout ended in FY24.', 'Phase II of the LOS rollout ended in FY24.');
  assert.ok(p.metrics.newEntities.includes('II'));
});

test('sentence-initial capitals and pronouns are not new entities', async () => {
  const o = 'collections improved across all branches in FY24.';
  const r = await gateCandidate(o, "Collections improved in FY24 across all branches, and I'm pleased with it.", { limits: { maxLengthRatio: 3 } });
  assert.deepEqual(r.metrics.newEntities, []);
  assert.ok(!codes(r).includes('new-entity'));
});

test('the allow list lets an interview fact through', async () => {
  const o = 'We grew the branch network last year.';
  const c = 'We grew the branch network last year, opening 12 branches in Pune.';
  const without = await gateCandidate(o, c, fullCtx(o));
  assert.ok(codes(without).includes('facts'));
  assert.ok(codes(without).includes('new-entity'));
  const answers = ['We opened 12 branches in Pune'];
  const ctx = fullCtx(o, { allow: answers });
  const withAllow = await gateCandidate(o, c, ctx);
  assert.equal(withAllow.ok, true, JSON.stringify(withAllow.reasons));
  // the forward meaning check reads the original plus the author's answers
  assert.equal(ctx.nli.calls[0][0], 'We grew the branch network last year. We opened 12 branches in Pune.');
  assert.equal(ctx.nli.calls[1][1], o);
});

test('the allow list does not excuse facts the author did not supply', async () => {
  const o = 'We grew the branch network last year.';
  const r = await gateCandidate(o, 'We grew the branch network last year, opening 15 branches in Nagpur.', { allow: ['We opened 12 branches in Pune'] });
  assert.ok(codes(r).includes('facts'));
  assert.deepEqual(r.metrics.newEntities, ['Nagpur']);
});

// ---------- meaning models ----------
test('an NLI contradiction fails even when entailment looks fine', async () => {
  const ctx = fullCtx(ORIG, { fwd: { entailment: 0.85, contradiction: 0.12, neutral: 0.03 } });
  const r = await gateCandidate(ORIG, PARA, ctx);
  assert.deepEqual(codes(r), ['contradiction']);
  assert.match(r.reasons[0].message, /0\.12/);
  assert.equal(ctx.nli.calls.length, 1, 'the reverse direction is not needed after a failure');
  assert.equal(r.metrics.contradiction, 0.12);
});

test('a contradiction in the reverse direction also fails', async () => {
  const ctx = fullCtx(ORIG, { bwd: { entailment: 0.9, contradiction: 0.4, neutral: 0 } });
  const r = await gateCandidate(ORIG, PARA, ctx);
  assert.deepEqual(codes(r), ['contradiction']);
  assert.equal(ctx.nli.calls.length, 2);
  assert.equal(r.metrics.contradiction, 0.4);
  assert.equal(r.metrics.entailment, 0.9);
});

test('entailment must hold both ways', async () => {
  const fwdFail = fullCtx(ORIG, { fwd: { entailment: 0.5, contradiction: 0.02, neutral: 0.48 } });
  const a = await gateCandidate(ORIG, PARA, fwdFail);
  assert.deepEqual(codes(a), ['entailment']);
  assert.match(a.reasons[0].message, /says something your answer does not/);
  assert.equal(fwdFail.nli.calls.length, 1);

  const bwdFail = fullCtx(ORIG, { bwd: { entailment: 0.6, contradiction: 0.02, neutral: 0.38 } });
  const b = await gateCandidate(ORIG, PARA, bwdFail);
  assert.deepEqual(codes(b), ['entailment']);
  assert.match(b.reasons[0].message, /leaves out part of what your answer says/);
  assert.equal(b.metrics.entailment, 0.6);
  assert.equal(b.metrics.nli.forward.entailment, 0.95);
  assert.equal(b.metrics.nli.backward.entailment, 0.6);
});

test('limits are inclusive for entailment and exclusive for contradiction', async () => {
  const atLimit = fullCtx(ORIG, { fwd: { entailment: 0.8, contradiction: 0.05, neutral: 0.15 } });
  assert.equal((await gateCandidate(ORIG, PARA, atLimit)).ok, true);
  const atC = fullCtx(ORIG, { fwd: { entailment: 0.85, contradiction: 0.1, neutral: 0.05 } });
  assert.deepEqual(codes(await gateCandidate(ORIG, PARA, atC)), ['contradiction']);
});

test('a low cosine fails before NLI is called', async () => {
  const ctx = fullCtx(ORIG, { cos: 0.7 });
  const r = await gateCandidate(ORIG, PARA, ctx);
  assert.deepEqual(codes(r), ['similarity']);
  assert.match(r.reasons[0].message, /0\.70, need 0\.85/);
  assert.equal(ctx.nli.calls.length, 0);
  assert.deepEqual(r.metrics.skipped, [{ check: 'nli', why: 'earlier-failure' }]);
});

test('vectors that are not normalised still give the true cosine', async () => {
  const embed = async () => [[2, 0], [3, 3]];
  const r = await gateCandidate(ORIG, PARA, { embed });
  assert.equal(r.metrics.cosine.toFixed(4), (Math.SQRT1_2).toFixed(4));
  assert.deepEqual(codes(r), ['similarity']);
});

test('ctx.limits overrides single limits and ignores junk', async () => {
  const r = await gateCandidate(ORIG, PARA, { ...fullCtx(ORIG, { cos: 0.7 }), limits: { cosine: 0.5, entailment: 'high', maxEditRatio: NaN } });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const strict = await gateCandidate(ORIG, PARA, { limits: { maxEditRatio: 0.1 } });
  assert.deepEqual(codes(strict), ['edit-ratio']);
});

test('a meaning model that fails blocks the rewrite (fail closed)', async () => {
  const boom = async () => { throw new Error('worker crashed'); };
  const a = await gateCandidate(ORIG, PARA, { nli: boom });
  assert.deepEqual(codes(a), ['entailment']);
  assert.match(a.reasons[0].message, /could not run \(worker crashed\)/);
  assert.equal(a.metrics.errors.nli, 'worker crashed');

  const b = await gateCandidate(ORIG, PARA, { embed: boom, nli: fakeNli(ORIG) });
  assert.deepEqual(codes(b), ['similarity']);
  assert.equal(b.metrics.errors.similarity, 'worker crashed');

  const upper = await gateCandidate(ORIG, PARA, { nli: async () => ({ ENTAILMENT: 0.9, CONTRADICTION: 0.02, NEUTRAL: 0.08 }) });
  assert.equal(upper.ok, true, 'label names in capitals are read too');
  for (const bad of [null, {}, { entailment: 'x', contradiction: 0 }, { entailment: 3.2, contradiction: -4 }, [0.9, 0.05, 0.05]]) {
    const r = await gateCandidate(ORIG, PARA, { nli: async () => bad });
    assert.deepEqual(codes(r), ['entailment'], JSON.stringify(bad));
  }
  for (const bad of [null, [], [new Float32Array(3)], [[1, 0], [1, 0, 0]], [[0, 0], [0, 0]]]) {
    const r = await gateCandidate(ORIG, PARA, { embed: async () => bad });
    assert.deepEqual(codes(r), ['similarity'], JSON.stringify(bad));
  }
});

// ---------- grammar ----------
test('a grammar regression fails', async () => {
  const ctx = fullCtx(ORIG);
  const r = await gateCandidate(ORIG, 'In FY24 we has cut GNPA to 1.4% by tightening underwriting for DSAs in Tier 2 cities.', ctx);
  assert.deepEqual(codes(r), ['grammar']);
  assert.match(r.reasons[0].message, /Subject and verb do not agree\. \(“we has”\)/);
  assert.deepEqual(r.metrics.grammar.added, [{ kind: 'Agreement', message: 'Subject and verb do not agree.', text: 'we has' }]);
  assert.equal(ctx.embed.calls.length + ctx.nli.calls.length, 0, 'no meaning check after a grammar failure');
});

test('a grammar issue already in the original does not fail, wherever it moves', async () => {
  const o = 'In FY24 we has cut GNPA to 1.4% and teh DSAs in Tier 2 cities helped.';
  const c = 'Teh DSAs in Tier 2 cities helped, and in FY24 we has cut GNPA to 1.4%.';
  // swapping the clauses is a near-total word-level edit, so that limit is lifted here
  const r = await gateCandidate(o, c, fullCtx(o, { limits: { maxEditRatio: 1 } }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.metrics.grammar, { before: 2, after: 2, added: [] });
});

test('a second copy of an existing grammar issue counts as new', async () => {
  const o = 'In FY24 we has cut GNPA to 1.4% across Tier 2 cities.';
  const c = 'In FY24 we has cut GNPA to 1.4%, and they has done it across Tier 2 cities.';
  const r = await gateCandidate(o, c, fullCtx(o, { limits: { maxLengthRatio: 2 } }));
  assert.deepEqual(codes(r), ['grammar']);
  assert.equal(r.metrics.grammar.added.length, 1);
  assert.equal(r.metrics.grammar.added[0].text, 'they has');
});

test('a new misspelling fails; style and readability lints are ignored', async () => {
  const spell = await gateCandidate(ORIG, 'In FY24 we cut GNPA to 1.4% by tightening teh underwriting for DSAs in Tier 2 cities.', fullCtx(ORIG));
  assert.deepEqual(codes(spell), ['grammar']);
  assert.match(spell.reasons[0].message, /“teh”/);
  const style = await gateCandidate(ORIG, 'In FY24 we cut GNPA to 1.4% by very much tightening underwriting for DSAs in Tier 2 cities.', fullCtx(ORIG));
  assert.equal(style.ok, true, JSON.stringify(style.reasons));
  assert.deepEqual(style.metrics.grammar, { before: 0, after: 0, added: [] });
});

test('a grammar checker that fails is skipped, not fatal', async () => {
  const boom = async () => { throw new Error('wasm failed'); };
  const r = await gateCandidate(ORIG, PARA, { grammar: boom, embed: fakeEmbed(), nli: fakeNli(ORIG) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.metrics.skipped, [{ check: 'grammar', why: 'error' }]);
  assert.equal(r.metrics.errors.grammar, 'wasm failed');
  const notList = await gateCandidate(ORIG, PARA, { grammar: async () => 'nothing' });
  assert.equal(notList.ok, true);
  assert.deepEqual(notList.metrics.skipped.find((s) => s.check === 'grammar'), { check: 'grammar', why: 'error' });
  const junk = await gateCandidate(ORIG, PARA, { grammar: async () => [null, 5, { kind: 'Spelling' }] });
  assert.equal(junk.ok, true, 'a malformed lint present in both texts is not new');
});

// Real Harper (harper.js 2.13, Dialect.Indian) flags fiscal codes, possessives of acronyms, unit
// abbreviations and Indian place names as Spelling, with the word in backticks in the message.
const HARPER_UNKNOWN = new Set(['nashik', 'indore', 'cr', 'recieve', 'vis', 'à']);
const HARPER_PROPER = new Set(['mumbai', 'india']); // known, but only with a capital
function harperLike() {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    const out = [];
    for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
      const w = m[0];
      const code = /\p{N}/u.test(w) && /\p{L}/u.test(w); // FY24, Q1FY25, FY2023 (of FY2023-24)
      const possessive = /^\p{Lu}{2,}['’]s$/u.test(w) || /^nashik['’]s$/i.test(w); // RBI's, Nashik's
      if (code || possessive || HARPER_UNKNOWN.has(w.toLowerCase()) || HARPER_PROPER.has(w)) {
        out.push({ start: m.index, end: m.index + w.length, kind: 'Spelling', message: `Did you mean to spell \`${w}\` this way?`, problem: w });
      }
    }
    for (const m of text.matchAll(/\b(?:we|they) (has)\b/giu)) {
      const s = m.index + m[0].length - 3;
      out.push({ start: s, end: s + 3, kind: 'Agreement', message: 'The form of the verb must agree in grammatical number with the pronoun.', problem: 'has' });
    }
    for (const m of text.matchAll(/\d-\d/g)) {
      out.push({ start: m.index + 1, end: m.index + 2, kind: 'Formatting', message: 'Use an en dash (–) in ranges of numbers. Ignore this if it is math.', problem: '-' });
    }
    for (const m of text.matchAll(/ ,/g)) {
      out.push({ start: m.index, end: m.index + 1, kind: 'Punctuation', message: "Don't use a space before a comma.", problem: ' ' });
    }
    return out;
  };
  fn.calls = calls;
  return fn;
}

test('Harper spelling lints on fiscal codes, unit words and possessives are not grammar regressions', async () => {
  const pairs = [
    ['In FY2023-24 we cut GNPA to 1.4%.', 'We cut GNPA to 1.4% in FY24.'],
    ['GNPA fell 40 bps to 1.4% in Q1 FY25.', 'In Q1FY25, GNPA fell 40 bps to 1.4%.'],
    ['Collections efficiency improved to 98.5% in H1 FY25.', 'In H1FY25, collections efficiency improved to 98.5%.'],
    ['The RBI guidelines were followed by the NBFC team.', "The RBI's guidelines were followed by the NBFC's team."],
    ['We disbursed ₹500 crore in FY24.', 'We disbursed ₹500 cr in FY24.'],
    ['Our Nashik branch grew 12% in FY24.', "Nashik's branch grew 12% in FY24."],
  ];
  for (const [o, c] of pairs) {
    const r = await gateCandidate(o, c, { grammar: harperLike(), limits: { maxEditRatio: 1 } });
    assert.equal(r.ok, true, `${c}: ${JSON.stringify(r.reasons)}`);
    assert.deepEqual(r.metrics.grammar.added, [], c);
  }
});

test("Harper's en-dash lint on number ranges is typography, other punctuation lints still count", async () => {
  const fy = await gateCandidate('We expect GNPA near 1.4% in FY24.', 'We expect GNPA near 1.4% in FY 2023-24.', { grammar: harperLike() });
  assert.equal(fy.ok, true, JSON.stringify(fy.reasons));
  const range = await gateCandidate('We expect 10% to 12% growth in FY25.', 'We expect 10-12% growth in FY25.', { grammar: harperLike() });
  assert.equal(range.ok, true, JSON.stringify(range.reasons));
  const comma = await gateCandidate('We expect 10% growth in FY25, and stable margins.', 'We expect 10% growth in FY25 , and stable margins.', { grammar: harperLike() });
  assert.deepEqual(codes(comma), ['grammar']);
});

test('with a real spell checker, an interview fact passes but a real misspelling still fails', async () => {
  const o = 'Our branch network grew last year.';
  const c = 'Our branch network grew last year, with 12 new branches in Nashik.';
  const ctx = { ...fullCtx(o, { allow: ['We opened 12 branches in Nashik'] }), grammar: harperLike() };
  const r = await gateCandidate(o, c, ctx);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.metrics.grammar.added, []);
  assert.equal(ctx.nli.calls.length, 2, 'the meaning checks still ran');

  const typo = await gateCandidate(o, 'Our branch network grew last year, with 12 new branches in Nashik to recieve walk-ins.',
    { grammar: harperLike(), allow: ['We opened 12 branches in Nashik'] });
  assert.deepEqual(codes(typo), ['grammar']);
  assert.deepEqual(typo.metrics.grammar.added.map((l) => l.text), ['recieve']);

  // a word the spell checker does not know and nobody supplied is still a new lint
  const vis = await gateCandidate('We grew our loan book in FY24.', 'We grew our loan book vis-à-vis peers in FY24.', { grammar: harperLike() });
  assert.deepEqual(codes(vis), ['grammar']);
  // a name the rewrite puts in lower case is a real error, even though the word is in the answer
  const lower = await gateCandidate('Mumbai leads our book in FY24.', 'Our book in FY24 is led by mumbai.', { grammar: harperLike() });
  assert.deepEqual(codes(lower), ['grammar']);
  assert.deepEqual(lower.metrics.grammar.added.map((l) => l.text), ['mumbai']);
  // but a name the author typed in lower case may be capitalised
  const up = await gateCandidate('Branches grew 12% in nashik in FY24.', 'Nashik branches grew 12% in FY24.', { grammar: harperLike() });
  assert.equal(up.ok, true, JSON.stringify(up.reasons));
  assert.deepEqual(up.metrics.grammar.added, []);
  // and a code-like word does not hide a real agreement error next to it
  const agree = await gateCandidate('In FY2023-24 we cut GNPA to 1.4%.', 'In FY24 we has cut GNPA to 1.4%.', { grammar: harperLike() });
  assert.deepEqual(codes(agree), ['grammar']);
  assert.deepEqual(agree.metrics.grammar.added.map((l) => l.text), ['has']);
});

test('a malformed lint result for the original is not cached', async () => {
  const o = 'We cut GNPA to 1.4% in FY24.';
  let first = true;
  const grammar = async (t) => {
    if (t === o && first) { first = false; return undefined; }
    return t.includes('teh') ? [{ start: t.indexOf('teh'), end: t.indexOf('teh') + 3, kind: 'Typo', message: 'Did you mean the definite article?', problem: 'teh' }] : [];
  };
  const a = await gateCandidate(o, 'In FY24 we cut GNPA to 1.4%.', { grammar });
  assert.deepEqual(a.metrics.skipped, [{ check: 'grammar', why: 'error' }, { check: 'similarity', why: 'unavailable' }, { check: 'nli', why: 'unavailable' }]);
  const b = await gateCandidate(o, 'In FY24 we cut teh GNPA to 1.4%.', { grammar });
  assert.deepEqual(codes(b), ['grammar'], 'the next candidate lints the original again');
  const c = await gateCandidate(o, 'In FY24, we cut GNPA to 1.4%.', { grammar });
  assert.equal(c.ok, true);
});

test('the original is linted once for many candidates', async () => {
  const grammar = fakeGrammar();
  for (const c of [PARA, 'We brought GNPA down to 1.4% in FY24 by tightening underwriting for DSAs in Tier 2 cities.']) {
    await gateCandidate(ORIG, c, { grammar });
  }
  assert.equal(grammar.calls.filter((t) => t === ORIG).length, 1);
  assert.equal(grammar.calls.length, 3);
});

// ---------- characters, meta, size ----------
test('an invisible character fails', async () => {
  const ctx = fullCtx(ORIG);
  const r = await gateCandidate(ORIG, PARA.replace('GNPA', 'GN\u200bPA'), ctx);
  assert.ok(codes(r).includes('unsafe-chars'));
  assert.match(r.reasons.find((x) => x.code === 'unsafe-chars').message, /1 invisible: U\+200B/);
  assert.equal(r.metrics.unsafeChars, 1);
  assert.equal(modelCalls(ctx), 0);
});

test('lookalike letters, fullwidth forms and odd spaces fail', async () => {
  const look = await gateCandidate(ORIG, PARA.replace('tightening', 'tіghtening'));
  assert.ok(codes(look).includes('unsafe-chars'));
  assert.match(look.reasons.find((x) => x.code === 'unsafe-chars').message, /lookalike/);
  const fw = await gateCandidate(ORIG, PARA.replace('Tier', 'Ｔier'));
  assert.ok(codes(fw).includes('unsafe-chars'));
  const nbsp = await gateCandidate(ORIG, PARA.replace('1.4%', '1.4\u00a0%'));
  assert.ok(codes(nbsp).includes('unsafe-chars'));
});

test('genuine Hindi, ₹ and curly quotes are not unsafe', async () => {
  const o = 'Customers call it “ghar loan” (घर लोन), and ticket size stays near ₹25 lakh.';
  const c = 'Customers call it “ghar loan” (घर लोन), and the ticket size stays close to ₹25 lakh.';
  const r = await gateCandidate(o, c, fullCtx(o));
  assert.equal(r.metrics.unsafeChars, 0);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test('model self-talk fails', async () => {
  for (const c of [`Here is a plainer version: ${PARA}`, `Sure! ${PARA}`, `As an AI language model, ${PARA.toLowerCase()}`,
    `${PARA} I hope this helps.`, `Rewritten: ${PARA}`, `<think>ok</think>${PARA}`, `I have rephrased it: ${PARA}`]) {
    const r = await gateCandidate(ORIG, c, { limits: { maxLengthRatio: 3 } });
    assert.ok(codes(r).includes('meta'), c);
    assert.ok(r.metrics.meta.length >= 1, c);
  }
});

test('self-talk phrases already in the original are allowed', async () => {
  const o = 'Here is how we did it: we cut GNPA to 1.4% in FY24.';
  const r = await gateCandidate(o, 'Here is how we did it: GNPA came down to 1.4% in FY24.', fullCtx(o));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.metrics.meta, []);
});

test('ordinary business wording is not self-talk', async () => {
  const o = 'We revised the credit policy and the new version took effect in FY24.';
  const c = 'The new version of the credit policy took effect in FY24 after we revised it.';
  const r = await gateCandidate(o, c);
  assert.deepEqual(r.metrics.meta, []);
  assert.ok(!codes(r).includes('meta'));
});

test('ordinary business wording that sounds like a rewrite note is not self-talk', async () => {
  const pairs = [
    ['We submitted an updated draft of the policy to the RBI.', 'We submitted a revised draft of the policy to the RBI.'],
    ['The RBI issued an updated text of the circular.', 'The RBI issued the revised text of the circular.'],
    ['The board saw an amended version of the plan.', 'The board saw an edited version of the plan.'],
    ['We are glad to assist first-time MSME borrowers.', 'We are happy to help first-time MSME borrowers.'],
    ['We want to support more MSMEs in getting credit.', 'We are happy to help more MSMEs get credit.'],
    ['Our branch staff will assist, and we are glad to do so.', "Our branch staff will assist, and we'd be glad to help."],
    ['As an AI-first NBFC, we score every file.', 'We score every file as an AI-first NBFC.'],
  ];
  for (const [o, c] of pairs) {
    const r = await gateCandidate(o, c, { limits: { maxEditRatio: 1 } });
    assert.deepEqual(r.metrics.meta, [], c);
    assert.ok(!codes(r).includes('meta'), c);
  }
});

test('sign-offs and notes about the rewrite are still self-talk', async () => {
  const o = 'GNPA fell to 1.4% in FY24.';
  for (const c of [`${o} Happy to help!`, `Revised version: ${o}`, `Rewritten text: ${o}`, `${o} The revised sentence keeps every number.`,
    `${o} I am glad to help with anything else.`, `${o}\nI'd be happy to help further.`, `${o} This is my revised version.`,
    `As an AI, I note that ${o.toLowerCase()}`]) {
    const r = await gateCandidate(o, c, { limits: { maxLengthRatio: 5, maxEditRatio: 1 } });
    assert.ok(codes(r).includes('meta'), c);
  }
  const r = await gateCandidate(o, `${o} Happy to help!`, { limits: { maxLengthRatio: 5 } });
  assert.deepEqual(r.metrics.meta, ['Happy to help'], 'the phrase is shown without the full stop before it');
});

test('decomposed accents (NFD) are the same words as composed ones', async () => {
  const o = 'Our lender is Société Générale, and GNPA is 1.4%.';
  const c = 'Société Générale is our lender, and GNPA is 1.4%.';
  const r = await gateCandidate(o, c, { limits: { maxEditRatio: 1 } });
  assert.deepEqual(r.metrics.newEntities, []);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(editRatio(o, o.normalize('NFC')), 0);
});

test('too long and too short fail on length', async () => {
  const long = await gateCandidate('GNPA fell to 1.4% in FY24.', 'GNPA fell to 1.4% in FY24, helped by sharper underwriting, closer collections follow-up and better sourcing discipline.');
  assert.ok(codes(long).includes('length'));
  assert.match(long.reasons.find((x) => x.code === 'length').message, /Too long/);
  const short = await gateCandidate(ORIG, 'GNPA: 1.4% in FY24 via DSAs, Tier 2.');
  assert.ok(codes(short).includes('length'));
  assert.match(short.reasons.find((x) => x.code === 'length').message, /Too short/);
});

test('the allow list widens the length budget by the words supplied', async () => {
  const o = 'Our branch network grew last year.';
  const c = 'Our branch network grew last year, with 12 new branches opened across Pune and Nashik.';
  const allow = ['12 new branches opened across Pune and Nashik'];
  assert.ok(codes(await gateCandidate(o, c)).includes('length'));
  assert.ok(!codes(await gateCandidate(o, c, { allow, limits: { maxEditRatio: 1 } })).includes('length'));
});

test('a rewrite that changes most of the wording fails on edit ratio', async () => {
  const o = 'Strong partnerships with builders and DSAs help us source quality customers at scale.';
  const c = 'Builders and DSAs we work closely with bring in good borrowers in large numbers.';
  const r = await gateCandidate(o, c);
  assert.ok(r.metrics.editRatio > 0.8, String(r.metrics.editRatio));
  assert.deepEqual(codes(r), ['edit-ratio']);
});

test('all cheap reasons are reported together, and no model is called', async () => {
  const ctx = fullCtx(ORIG);
  const c = `Here is the rewritten sentence: we did not cut GNPA in FY24 for DSAs in Tier 2 cities with HDFC in Indore, which was a very long and slow process for the whole team across many quarters and many more branches.`;
  const r = await gateCandidate(ORIG, c, ctx);
  for (const code of ['meta', 'facts', 'negation', 'new-entity', 'length', 'edit-ratio']) assert.ok(codes(r).includes(code), code);
  assert.equal(modelCalls(ctx), 0);
  assert.equal(r.ok, false);
});

// ---------- pathological input ----------
test('empty and whitespace-only candidates fail as empty, with no other check', async () => {
  for (const c of ['', '   ', '\n\n\t ', null, undefined, '...', ' — ', '\u200b\u200b']) {
    const ctx = fullCtx(ORIG);
    const r = await gateCandidate(ORIG, c, ctx);
    assert.deepEqual(codes(r), ['empty'], JSON.stringify(c));
    assert.equal(r.ok, false);
    assert.equal(modelCalls(ctx), 0);
    assert.equal(r.metrics.wordsAfter, 0);
  }
});

test('odd inputs never throw', async () => {
  for (const [o, c, ctx] of [[null, 'Text', null], [42, 42, undefined], ['', 'New text here.', {}], [ORIG, { toString: () => PARA }, 'ctx'],
    [ORIG, PARA, { allow: 'We opened 12 branches', limits: null }], [ORIG, PARA, { allow: [null, '', 7] }]]) {
    const r = await gateCandidate(o, c, ctx);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.reasons));
    for (const x of r.reasons) assert.ok(typeof x.code === 'string' && typeof x.message === 'string' && x.message);
  }
  assert.equal((await gateCandidate(42, 42)).ok, true);
  assert.deepEqual(codes(await gateCandidate('', 'New text here.')), ['length', 'edit-ratio']);
});

test('an identical candidate passes', async () => {
  const r = await gateCandidate(ORIG, ORIG, fullCtx(ORIG));
  assert.equal(r.ok, true);
  assert.equal(r.metrics.editRatio, 0);
});
