import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  humanPct, riskFromPct, band, BAND_LABEL, RISK_KNOTS, combine, logitPct,
  windowHeat, windowPcts, smoothHeat, WINDOW_WEIGHTS,
} from '../../ai-checker/src/calibration.mjs';

const CAL = JSON.parse(readFileSync(new URL('../../ai-checker/calibration.json', import.meta.url), 'utf8'));
const MODE = CAL.modes.article;
const CALIBRATE_PY = fileURLToPath(new URL('../../tools/calibrate.py', import.meta.url));
const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b}`);

// Seeded PRNG so failures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Sorted quantiles with plateaus (repeated values), as real calibration data can have.
function randomQ(r, n = 101) {
  const q = [r() * 2 - 1];
  for (let i = 1; i < n; i++) q.push(q[i - 1] + (r() < 0.15 ? 0 : r() * r()));
  return q;
}
function randomXs(r, q, k = 60) {
  const lo = q[0], hi = q[q.length - 1], pad = (hi - lo) * 0.1 + 0.01;
  const xs = [lo, hi, lo - pad, hi + pad];
  for (let i = 0; i < k; i++) xs.push(lo - pad + r() * (hi - lo + 2 * pad));
  for (let i = 0; i < 10; i++) xs.push(q[Math.floor(r() * q.length)]);
  return xs;
}

// ---------- the old page's code, verbatim (reference for "same numbers as before") ----------
function oldHumanPct(q, x) {
  if (!q || !q.length) return null;
  if (x <= q[0]) return 0;
  const n = q.length - 1;
  if (x >= q[n]) return 100;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= x) lo = mid; else hi = mid; }
  const span = q[hi] - q[lo];
  return (100 / n) * (lo + (span > 0 ? (x - q[lo]) / span : 0));
}
const OLD_KNOTS = [[0, 0], [50, 15], [80, 30], [90, 40], [95, 65], [99, 85], [100, 100]];
function oldRiskFromPct(p) {
  for (let i = 1; i < OLD_KNOTS.length; i++) {
    const [x0, y0] = OLD_KNOTS[i - 1], [x1, y1] = OLD_KNOTS[i];
    if (p <= x1) return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
  }
  return 100;
}
const OLD_ORDER = ['modernbert-raid-mage', 'e5-small-lora', 'bert-tiny-raid', 'zippy'];
function oldEnsemble(raw) {
  const pctOf = (k) => (raw[k] === undefined || !MODE.checkers[k] ? null : oldHumanPct(MODE.checkers[k].human_q, raw[k]));
  const cal = MODE.ensemble;
  const used = OLD_ORDER.filter((k) => pctOf(k) !== null);
  if (!used.some((k) => k !== 'zippy')) return null;
  const combo = cal.combos[[...used].sort().join('+')];
  if (!combo) return null;
  let s = 0, w = 0;
  for (const k of used) { s += cal.weights[k] * pctOf(k); w += cal.weights[k]; }
  const pct = oldHumanPct(combo.human_q, s / w);
  return { used, pct, risk: Math.round(oldRiskFromPct(pct)), flagged: used.filter((k) => Math.round(pctOf(k)) >= 95) };
}
// The new page converts raw scores to percentiles first, then calls combine().
const pctsOf = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, humanPct(MODE.checkers[k].human_q, v)]));

// ---------- humanPct ----------
test('humanPct: no quantiles or a non-numeric score gives null', () => {
  for (const q of [null, undefined, [], '']) assert.equal(humanPct(q, 0.5), null);
  const q = MODE.checkers['e5-small-lora'].human_q;
  for (const x of [NaN, null, undefined, '0.5', {}, [0.5]]) assert.equal(humanPct(q, x), null, String(x));
});

test('humanPct: below the lowest quantile is 0, above the highest is 100, infinities clamp', () => {
  const q = [0.1, 0.2, 0.3];
  assert.equal(humanPct(q, 0.1), 0);
  assert.equal(humanPct(q, -5), 0);
  assert.equal(humanPct(q, -Infinity), 0);
  assert.equal(humanPct(q, 0.3), 100);
  assert.equal(humanPct(q, 7), 100);
  assert.equal(humanPct(q, Infinity), 100);
});

test('humanPct: exact quantiles and linear interpolation between them', () => {
  const q = Array.from({ length: 101 }, (_, i) => i / 100);  // q[i] = i/100
  near(humanPct(q, 0.37), 37);
  near(humanPct(q, 0.375), 37.5);
  near(humanPct(q, 0.995), 99.5);
  assert.equal(humanPct([0, 10], 2.5), 25);
  assert.equal(humanPct([0, 10, 30], 20), 75);
  assert.equal(humanPct([0, 1, 2, 3, 4], 1), 25);
});

test('humanPct: plateaus (repeated quantiles) take the last index of the plateau, never divide by zero', () => {
  const q = [0, 1, 1, 1, 2];
  assert.equal(humanPct(q, 1), 75);
  assert.equal(humanPct(q, 1.5), 87.5);
  assert.equal(humanPct(q, 0.5), 12.5);
  assert.equal(humanPct([5, 5, 5], 5), 0);
  assert.equal(humanPct([5, 5, 5], 5.0001), 100);
  assert.equal(humanPct([5, 5, 5], 4.9999), 0);
});

test('humanPct: a single quantile splits at that value; typed arrays work', () => {
  assert.equal(humanPct([0.5], 0.5), 0);
  assert.equal(humanPct([0.5], 0.6), 100);
  assert.equal(humanPct(new Float64Array([0, 1, 2]), 1.5), 75);
});

test('humanPct: within [0, 100] and non-decreasing in x on every real calibration table', () => {
  const tables = [...Object.values(MODE.checkers).map((c) => c.human_q), ...Object.values(MODE.ensemble.combos).map((c) => c.human_q), ...Object.values(CAL.windows)];
  const r = rng(7);
  for (const q of tables) {
    assert.equal(q.length, 101);
    const xs = randomXs(r, q, 200).sort((a, b) => a - b);
    let prev = -1;
    for (const x of xs) {
      const p = humanPct(q, x);
      assert.ok(p >= 0 && p <= 100, `${p}`);
      assert.ok(p >= prev - 1e-12, `not monotonic at ${x}`);
      prev = p;
    }
  }
});

test('humanPct: identical to the old page on random and real inputs', () => {
  const r = rng(42);
  for (let t = 0; t < 300; t++) {
    const q = randomQ(r, [101, 101, 11, 2][t % 4]);
    for (const x of randomXs(r, q, 20)) assert.equal(humanPct(q, x), oldHumanPct(q, x));
  }
  for (const [k, c] of Object.entries(MODE.checkers)) {
    for (const x of randomXs(r, c.human_q, 200)) assert.equal(humanPct(c.human_q, x), oldHumanPct(c.human_q, x), k);
  }
});

// ---------- tools/calibrate.py cross-check ----------
const PY = `
import ast, json, sys
import numpy as np
path = sys.argv[1]
tree = ast.parse(open(path, encoding='utf-8').read())
fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('human_pct', 'logit_pct')]
ns = {'np': np}
exec(compile(ast.Module(body=fns, type_ignores=[]), path, 'exec'), ns)
hp, lp = ns['human_pct'], ns['logit_pct']
d = json.load(sys.stdin)
out = {'pct': [[float(v) for v in hp(c['q'], c['x'])] for c in d['pct']]}
combos = []
for c in d['combine']:
    s = sum(w * lp(p) for w, p in zip(c['w'], c['p'])) / np.array(c['w']).sum()
    combos.append(float(hp(c['q'], [s])[0]))
out['combine'] = combos
print(json.dumps(out))
`;
const hasNumpy = (() => {
  try { return existsSync(CALIBRATE_PY) && spawnSync('python3', ['-I', '-c', 'import numpy'], { timeout: 20000 }).status === 0; } catch { return false; }
})();

test('humanPct and the logit combine match tools/calibrate.py (python3 + numpy)', { skip: !hasNumpy && 'python3 with numpy (or tools/calibrate.py) not available' }, () => {
  const r = rng(2024);
  const pct = [];
  for (let t = 0; t < 120; t++) { const q = randomQ(r, t % 5 ? 101 : 2); pct.push({ q, x: randomXs(r, q, 30) }); }
  for (const c of [...Object.values(MODE.checkers), ...Object.values(MODE.ensemble.combos)]) pct.push({ q: c.human_q, x: randomXs(r, c.human_q, 50) });
  // logit-format combos: random weights, percentiles (including the 0/100 clip edges) and quantiles
  const combine_ = [];
  for (let t = 0; t < 80; t++) {
    const m = 1 + Math.floor(r() * 4);
    const w = Array.from({ length: m }, () => Math.round((0.05 + r() * 3) * 1e4) / 1e4);
    const p = Array.from({ length: m }, () => [0, 100, 0.05, 99.95, 50][Math.floor(r() * 12)] ?? r() * 100);
    const q = randomQ(r).map((v) => v * 8 - 4).sort((a, b) => a - b);
    combine_.push({ w, p, q });
  }
  const res = spawnSync('python3', ['-I', '-c', PY, CALIBRATE_PY], { input: JSON.stringify({ pct, combine: combine_ }), encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  const py = JSON.parse(res.stdout);
  let n = 0;
  pct.forEach((c, i) => c.x.forEach((x, j) => { assert.equal(humanPct(c.q, x), py.pct[i][j], `q#${i} x=${x}`); n++; }));
  assert.ok(n > 5000);
  combine_.forEach((c, i) => {
    const keys = c.w.map((_, k) => `k${k}`);
    const sorted = [...keys].sort();
    const cal = { ensemble: { feature: 'logit', weights: Object.fromEntries(keys.map((k, j) => [k, c.w[j]])), combos: { [sorted.join('+')]: { human_q: c.q } } } };
    const e = combine(cal, Object.fromEntries(keys.map((k, j) => [k, c.p[j]])));
    near(e.pct, py.combine[i], 1e-9, `combo #${i}: ${e.pct} vs ${py.combine[i]}`);
  });
});

// ---------- riskFromPct / band ----------
test('riskFromPct: same knots as the old page, hit exactly', () => {
  assert.deepEqual(RISK_KNOTS.map((k) => [...k]), OLD_KNOTS);
  for (const [x, y] of OLD_KNOTS) assert.equal(riskFromPct(x), y);
  assert.throws(() => { RISK_KNOTS.push([1, 1]); });
});

test('riskFromPct: linear between knots, identical to the old page on [0, 100]', () => {
  assert.equal(riskFromPct(25), 7.5);
  assert.equal(riskFromPct(85), 35);
  assert.equal(riskFromPct(92.5), 52.5);
  assert.equal(riskFromPct(97), 75);
  assert.equal(riskFromPct(99.5), 92.5);
  let prev = -1;
  for (let p = 0; p <= 100; p += 0.01) {
    const v = riskFromPct(p);
    assert.equal(v, oldRiskFromPct(p));
    assert.ok(v >= prev);
    prev = v;
  }
});

test('riskFromPct: out-of-range clamps to 0..100, non-numbers give null', () => {
  assert.equal(riskFromPct(-3), 0);
  assert.equal(riskFromPct(-Infinity), 0);
  assert.equal(riskFromPct(100.5), 100);
  assert.equal(riskFromPct(Infinity), 100);
  for (const p of [null, undefined, NaN, '50']) assert.equal(riskFromPct(p), null);
});

test('band: high ≥ 65, mid ≥ 40, else low; null → none', () => {
  assert.equal(band(65), 'high');
  assert.equal(band(100), 'high');
  assert.equal(band(64.99), 'mid');
  assert.equal(band(40), 'mid');
  assert.equal(band(39.99), 'low');
  assert.equal(band(0), 'low');
  for (const r of [null, undefined, NaN, '70']) assert.equal(band(r), 'none');
  // the 95th human percentile is exactly the High line, the 90th the Medium line
  assert.equal(band(riskFromPct(95)), 'high');
  assert.equal(band(riskFromPct(94.99)), 'mid');
  assert.equal(band(riskFromPct(90)), 'mid');
  assert.equal(band(riskFromPct(89.99)), 'low');
});

test('BAND_LABEL: one label per band, unchanged wording, frozen', () => {
  assert.deepEqual({ ...BAND_LABEL }, { high: 'High: likely flagged', mid: 'Medium: could be flagged', low: 'Low: reads human', none: 'Not checked yet' });
  for (const r of [0, 50, 80, null]) assert.ok(BAND_LABEL[band(r)]);
  assert.ok(Object.isFrozen(BAND_LABEL));
});

// ---------- combine: the shipped (linear) calibration.json ----------
const GOLDEN = [  // computed with the old page's ensemble() on ai-checker/calibration.json
  { raw: { 'modernbert-raid-mage': 0.42, 'e5-small-lora': 0.71, 'bert-tiny-raid': 0.2, zippy: 0.05 }, pct: 87.77132810159225, risk: 38, flagged: ['zippy'] },
  { raw: { 'modernbert-raid-mage': 0.995, 'e5-small-lora': 0.95, 'bert-tiny-raid': 0.9, zippy: 0.2 }, pct: 100, risk: 100, flagged: ['e5-small-lora', 'modernbert-raid-mage', 'zippy'] },
  { raw: { 'modernbert-raid-mage': 0.8, 'e5-small-lora': 0.7, 'bert-tiny-raid': 0.4, zippy: 0.02 }, pct: 91.27637844565633, risk: 46, flagged: [] },
  { raw: { 'modernbert-raid-mage': 0.95, 'e5-small-lora': 0.9, 'bert-tiny-raid': 0.4, zippy: 0.02 }, pct: 97.40301090804032, risk: 77, flagged: ['e5-small-lora'] },
  { raw: { 'modernbert-raid-mage': 0.98, 'e5-small-lora': 0.7, 'bert-tiny-raid': 0.4, zippy: 0.02 }, pct: 95.7523121677543, risk: 69, flagged: ['modernbert-raid-mage'] },
  { raw: { 'e5-small-lora': 0.6, 'bert-tiny-raid': 0.12 }, pct: 69.58525045989711, risk: 25, flagged: [] },
  { raw: { 'e5-small-lora': 0.3, zippy: -0.02 }, pct: 29.35004057185752, risk: 9, flagged: [] },
  { raw: { 'modernbert-raid-mage': 0.5 }, pct: 82.40286290488496, risk: 32, flagged: [] },
  { raw: { 'modernbert-raid-mage': 0.0001, 'e5-small-lora': 0.01, 'bert-tiny-raid': 0.01 }, pct: 0, risk: 0, flagged: [] },
];

test('combine reproduces the old page on the real calibration.json', () => {
  assert.equal(MODE.ensemble.feature, undefined);  // the shipped file is the old (linear) format
  for (const g of GOLDEN) {
    const e = combine(MODE, pctsOf(g.raw));
    near(e.pct, g.pct, 1e-9, JSON.stringify(g.raw));
    assert.equal(e.risk, g.risk);
    assert.deepEqual(e.flagged, g.flagged);
    assert.deepEqual(e.used, Object.keys(g.raw).sort());
  }
  assert.deepEqual(GOLDEN.map((g) => band(g.risk)), ['low', 'high', 'mid', 'high', 'high', 'low', 'low', 'low', 'low']);
  assert.equal(combine(MODE, pctsOf({ zippy: 0.1 })), null);
});

test('combine matches the old ensemble on random scores and every subset of checkers', () => {
  const r = rng(99);
  const keys = Object.keys(MODE.checkers);
  for (let t = 0; t < 2000; t++) {
    const raw = {};
    for (const k of keys) if (r() < 0.7) raw[k] = k === 'zippy' ? (r() - 0.5) * 0.3 : r() < 0.2 ? r() * 0.1 : r();
    const old = oldEnsemble(raw), e = combine(MODE, pctsOf(raw));
    if (old === null) { assert.equal(e, null, JSON.stringify(raw)); continue; }
    near(e.pct, old.pct, 1e-9);
    assert.equal(e.risk, old.risk);
    assert.deepEqual(e.flagged, [...old.flagged].sort());
    assert.deepEqual(e.used, [...old.used].sort());
  }
});

test('combine takes either the mode or its ensemble object', () => {
  const p = pctsOf(GOLDEN[0].raw);
  assert.deepEqual(combine(MODE.ensemble, p), combine(MODE, p));
});

// ---------- combine: rules ----------
const LIN = { ensemble: { weights: { a: 1, b: 3, zippy: 1 }, combos: { a: { human_q: [0, 100] }, 'a+b': { human_q: [0, 100] }, 'a+zippy': { human_q: [0, 100] }, 'a+b+zippy': { human_q: [0, 100] }, zippy: { human_q: [0, 100] } } } };

test('combine: ignores keys without a usable percentile', () => {
  const e = combine(LIN, { a: 40, b: null, zippy: undefined, c: NaN });
  assert.deepEqual(e.used, ['a']);
  assert.equal(e.pct, 40);
  assert.equal(combine(LIN, { a: 40, b: Infinity }).used.length, 1);
  assert.equal(combine(LIN, { a: 40, b: '90' }).used.length, 1);
});

test('combine: weighted average of percentiles in the old format', () => {
  const e = combine(LIN, { a: 20, b: 60 });
  assert.equal(e.pct, (20 + 3 * 60) / 4);
  assert.equal(e.risk, Math.round(riskFromPct(50)));
  assert.equal(combine(LIN, { a: 20, b: 60, zippy: 100 }).pct, (20 + 180 + 100) / 5);
});

test('combine: needs a checker other than ZipPy', () => {
  assert.equal(combine(LIN, { zippy: 99 }), null);
  assert.equal(combine(LIN, {}), null);
  assert.equal(combine(LIN, { zippy: 99, b: null }), null);
  assert.ok(combine(LIN, { zippy: 99, a: 10 }));
});

test('combine: null when the combo for the available set is missing', () => {
  assert.equal(combine(LIN, { b: 50 }), null);          // no "b" combo
  assert.equal(combine(LIN, { b: 50, zippy: 1 }), null); // no "b+zippy" combo
  const noQ = { ensemble: { weights: { a: 1 }, combos: { a: {} } } };
  assert.equal(combine(noQ, { a: 50 }), null);
  const emptyQ = { ensemble: { weights: { a: 1 }, combos: { a: { human_q: [] } } } };
  assert.equal(combine(emptyQ, { a: 50 }), null);
});

test('combine: keys without a positive weight do not enter (nor pick) the combo', () => {
  const cal = { ensemble: { weights: { a: 1, b: 0, c: -1 }, combos: { a: { human_q: [0, 100] } } } };
  assert.deepEqual(combine(cal, { a: 30, b: 99, c: 99, unknown: 99 }).used, ['a']);
  assert.deepEqual(combine(cal, { a: 30, b: 99 }).flagged, []);
  // prototype names are never mistaken for checkers or combos
  assert.equal(combine({ ensemble: { weights: {}, combos: {} } }, { constructor: 50, toString: 50 }), null);
  assert.equal(combine({ ensemble: { weights: { constructor: 1 }, combos: {} } }, { constructor: 50 }), null);
});

test('combine: bad calibration or input gives null, never throws', () => {
  for (const cal of [null, undefined, {}, { ensemble: null }, { ensemble: { weights: { a: 1 } } }, { ensemble: { combos: {} } }, 42, 'x']) {
    assert.equal(combine(cal, { a: 50 }), null, JSON.stringify(cal));
  }
  for (const p of [null, undefined, 5, 'a']) assert.equal(combine(LIN, p), null);
});

test('combine: flagged = used keys whose rounded percentile is at least 95', () => {
  const e = combine(LIN, { a: 94.5, b: 94.49, zippy: 100 });
  assert.deepEqual(e.flagged, ['a', 'zippy']);
  assert.deepEqual(combine(LIN, { a: 99, b: 99, zippy: 2 }).flagged, ['a', 'b']);
});

test('combine: key order of the input does not matter and inputs are not mutated', () => {
  const p1 = { a: 12.5, b: 77, zippy: 3 }, p2 = { zippy: 3, b: 77, a: 12.5 };
  const snap = JSON.stringify(LIN);
  assert.deepEqual(combine(LIN, p1), combine(LIN, p2));
  assert.equal(JSON.stringify(LIN), snap);
  assert.deepEqual(p1, { a: 12.5, b: 77, zippy: 3 });
});

test('combine: risk is the rounded risk of the combined percentile', () => {
  const r = rng(5);
  for (let i = 0; i < 500; i++) {
    const e = combine(LIN, { a: r() * 100, b: r() * 100 });
    assert.equal(e.risk, Math.round(riskFromPct(e.pct)));
    assert.ok(Number.isInteger(e.risk) && e.risk >= 0 && e.risk <= 100);
  }
});

// ---------- combine: logit format ----------
const LQ = Array.from({ length: 101 }, (_, i) => -5 + i / 10);  // humanPct(LQ, s) = (s + 5) * 10
const LOGIT = { ensemble: { feature: 'logit', weights: { a: 1, b: 3, zippy: 0.5 }, combos: { a: { human_q: LQ }, 'a+b': { human_q: LQ }, 'a+b+zippy': { human_q: LQ }, b: { human_q: LQ } } } };

test('logitPct clips to [0.001, 0.999] like calibrate.py', () => {
  assert.equal(logitPct(50), 0);
  near(logitPct(90), Math.log(9));
  near(logitPct(10), -Math.log(9));
  near(logitPct(0), Math.log(0.001 / 0.999));
  near(logitPct(-20), Math.log(0.001 / 0.999));
  near(logitPct(100), Math.log(0.999 / 0.001));
  near(logitPct(250), Math.log(0.999 / 0.001));
  near(logitPct(0.1), logitPct(0));
  near(logitPct(99.9), logitPct(100));
});

test('combine (logit): Σ w·logit(p) / Σ w, then the combo human quantiles', () => {
  const e = combine(LOGIT, { a: 50, b: 90 });
  const s = (1 * 0 + 3 * Math.log(9)) / 4;
  near(e.pct, (s + 5) * 10);
  assert.equal(e.risk, Math.round(riskFromPct((s + 5) * 10)));
  assert.deepEqual(e.used, ['a', 'b']);
  const z = combine(LOGIT, { a: 50, b: 90, zippy: 10 });
  near(z.pct, ((3 * Math.log(9) - 0.5 * Math.log(9)) / 4.5 + 5) * 10);
});

test('combine (logit): 0 and 100 percentiles stay finite; extremes clamp to 0/100', () => {
  const WQ = Array.from({ length: 101 }, (_, i) => -10 + i / 5);  // humanPct(WQ, s) = (s + 10) * 5
  const wide = { ensemble: { feature: 'logit', weights: { a: 1, b: 3 }, combos: { 'a+b': { human_q: WQ } } } };
  const lo = combine(wide, { a: 0, b: 0 }), hi = combine(wide, { a: 100, b: 100 });
  near(lo.pct, (Math.log(0.001 / 0.999) + 10) * 5);
  near(hi.pct, (Math.log(0.999 / 0.001) + 10) * 5);
  near(combine(wide, { a: 0, b: 100 }).pct, ((3 - 1) * Math.log(0.999 / 0.001) / 4 + 10) * 5);
  // beyond the combo's human range the percentile clamps
  assert.equal(combine(LOGIT, { a: 0, b: 0 }).pct, 0);
  assert.equal(combine(LOGIT, { a: 100, b: 100 }).pct, 100);
  const tight = { ensemble: { feature: 'logit', weights: { a: 1 }, combos: { a: { human_q: [-1, 0, 1] } } } };
  assert.equal(combine(tight, { a: 0 }).pct, 0);
  assert.equal(combine(tight, { a: 100 }).pct, 100);
  assert.equal(combine(tight, { a: 100 }).risk, 100);
});

test('combine (logit): differs from the linear average; feature may sit on the mode', () => {
  const lin = { ensemble: { ...LOGIT.ensemble, feature: undefined } };
  assert.notEqual(combine(LOGIT, { a: 50, b: 90 }).pct, combine(lin, { a: 50, b: 90 }).pct);
  const modeLevel = { feature: 'logit', ensemble: { weights: LOGIT.ensemble.weights, combos: LOGIT.ensemble.combos } };
  assert.deepEqual(combine(modeLevel, { a: 50, b: 90 }), combine(LOGIT, { a: 50, b: 90 }));
  assert.equal(combine({ ensemble: { feature: 'linear', weights: { a: 1 }, combos: { a: { human_q: [0, 100] } } } }, { a: 40 }).pct, 40);
});

test('combine (logit): same rules for ZipPy, missing combos and flagged', () => {
  assert.equal(combine(LOGIT, { zippy: 99 }), null);
  assert.equal(combine(LOGIT, { a: 10, zippy: 99 }), null);  // no "a+zippy" combo
  assert.deepEqual(combine(LOGIT, { a: 96, b: 50, zippy: 95 }).flagged, ['a', 'zippy']);
  assert.deepEqual(combine(LOGIT, { b: 70 }).used, ['b']);
});

test('combine (logit): a calibrate.py-shaped mode built from the shipped tables works end to end', () => {
  // same keys and weights as the shipped file, logit feature, combos made from linspace quantiles
  const ens = { feature: 'logit', weights: MODE.ensemble.weights, combos: {} };
  for (const k of Object.keys(MODE.ensemble.combos)) ens.combos[k] = { human_q: LQ };
  const mode = { checkers: MODE.checkers, ensemble: ens };
  for (const g of GOLDEN) {
    const p = pctsOf(g.raw), e = combine(mode, p);
    const keys = Object.keys(p).sort();
    const w = keys.reduce((s, k) => s + ens.weights[k], 0);
    const s = keys.reduce((acc, k) => acc + ens.weights[k] * logitPct(p[k]), 0) / w;
    near(e.pct, humanPct(LQ, s));
    assert.deepEqual(e.flagged, g.flagged);
  }
});

// ---------- windowHeat / smoothHeat ----------
const PROBS = { 'e5-small-lora': [0.1, 0.5, 0.9, 0.3, 0.97], 'bert-tiny-raid': [0.05, 0.2, 0.95, 0.04, 0.5] };
// computed with the old page's scoreSentencesInner() on ai-checker/calibration.json windows
const OLD_OWN = [0.35646542925988495, 7.4586715315758605, 80.9095823579844, 2.123800338237453, 70.62788313258034];
const OLD_HEAT = [3.1973478701862756, 36.83903586213928, 80.9095823579844, 33.638113146136234, 70.62788313258034];

test('windowHeat + smoothHeat reproduce the old page sentence heat (e5 weight 2, BERT-tiny 1)', () => {
  const own = windowHeat(CAL.windows, PROBS);
  own.forEach((v, i) => near(v, OLD_OWN[i]));
  smoothHeat(own).forEach((v, i) => near(v, OLD_HEAT[i]));
  // e5-small alone
  const one = windowHeat(CAL.windows, { 'e5-small-lora': [0.2, 0.8, 0.4] });
  [1.710307630540342, 41.490703629481196, 5.567441448767846].forEach((v, i) => near(one[i], v));
  [17.622466030116684, 41.490703629481196, 19.936746321053185].forEach((v, i) => near(smoothHeat(one)[i], v));
});

test('windowHeat: default weights, explicit weights and the calibration window_weights', () => {
  assert.deepEqual({ ...WINDOW_WEIGHTS }, { 'e5-small-lora': 2, 'bert-tiny-raid': 1 });
  const per = windowPcts(CAL.windows, PROBS);
  const e = per['e5-small-lora'], b = per['bert-tiny-raid'];
  windowHeat(CAL.windows, PROBS, { 'e5-small-lora': 1, 'bert-tiny-raid': 1 }).forEach((v, i) => near(v, (e[i] + b[i]) / 2));
  windowHeat(CAL.windows, PROBS, { 'e5-small-lora': 0.7, 'bert-tiny-raid': 2.1 }).forEach((v, i) => near(v, (0.7 * e[i] + 2.1 * b[i]) / 2.8));
  // missing keys in the weights fall back to the defaults, a zero weight drops the checker
  windowHeat(CAL.windows, PROBS, { 'bert-tiny-raid': 1 }).forEach((v, i) => near(v, OLD_OWN[i]));
  windowHeat(CAL.windows, PROBS, {}).forEach((v, i) => near(v, OLD_OWN[i]));
  windowHeat(CAL.windows, PROBS, { 'bert-tiny-raid': 0 }).forEach((v, i) => near(v, e[i]));
  assert.deepEqual(windowHeat(CAL.windows, PROBS, { 'bert-tiny-raid': 0, 'e5-small-lora': 0 }), []);
  // an unknown checker with window quantiles counts once
  const cal = { ...CAL.windows, other: CAL.windows['e5-small-lora'] };
  windowHeat(cal, { ...PROBS, other: PROBS['e5-small-lora'] }).forEach((v, i) => near(v, (3 * e[i] + b[i]) / 4));
});

test('windowHeat: checkers without window calibration, missing or bad scores are skipped', () => {
  const per = windowPcts(CAL.windows, PROBS);
  // ModernBERT has no window quantiles
  windowHeat(CAL.windows, { ...PROBS, 'modernbert-raid-mage': [1, 1, 1, 1, 1] }).forEach((v, i) => near(v, OLD_OWN[i]));
  // a missing value only drops that checker for that window
  const h = windowHeat(CAL.windows, { 'e5-small-lora': [0.1, NaN, 0.9], 'bert-tiny-raid': [0.05, 0.2, undefined] });
  near(h[0], OLD_OWN[0]);
  near(h[1], per['bert-tiny-raid'][1]);
  near(h[2], per['e5-small-lora'][2]);
  assert.deepEqual(windowHeat(CAL.windows, { 'e5-small-lora': [null, 0.5] }).map((v) => v === null), [true, false]);
  // different lengths: the longer list sets the window count
  const u = windowHeat(CAL.windows, { 'e5-small-lora': [0.5], 'bert-tiny-raid': [0.2, 0.2] });
  assert.equal(u.length, 2);
  near(u[1], per['bert-tiny-raid'][1]);
  // typed arrays from the worker are fine
  windowHeat(CAL.windows, { 'e5-small-lora': Float64Array.from(PROBS['e5-small-lora']), 'bert-tiny-raid': PROBS['bert-tiny-raid'] }).forEach((v, i) => near(v, OLD_OWN[i]));
});

test('windowHeat: empty and bad input never throws', () => {
  assert.deepEqual(windowHeat(CAL.windows, {}), []);
  assert.deepEqual(windowHeat(CAL.windows, null), []);
  assert.deepEqual(windowHeat(null, PROBS), []);
  assert.deepEqual(windowHeat({}, PROBS), []);
  assert.deepEqual(windowHeat(CAL.windows, { 'e5-small-lora': [] }), []);
  assert.deepEqual(windowHeat(CAL.windows, { 'e5-small-lora': null }), []);
  // a checker with empty window quantiles is skipped, the others still count
  const bt = { 'bert-tiny-raid': CAL.windows['bert-tiny-raid'] };
  assert.deepEqual(windowHeat({ ...bt, 'e5-small-lora': [] }, PROBS), windowHeat(bt, PROBS));
  assert.equal(windowHeat(bt, PROBS).length, 5);
});

test('windowHeat: values stay within 0..100 on random scores', () => {
  const r = rng(11);
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(r() * 12);
    const probs = { 'e5-small-lora': Array.from({ length: n }, r), 'bert-tiny-raid': Array.from({ length: n }, r) };
    for (const v of smoothHeat(windowHeat(CAL.windows, probs))) assert.ok(v >= 0 && v <= 100);
  }
});

test('smoothHeat: 0.6·own + 0.4·max(own, neighbours)', () => {
  assert.deepEqual(smoothHeat([10, 50, 20]), [0.6 * 10 + 0.4 * 50, 50, 0.6 * 20 + 0.4 * 50]);
  assert.deepEqual(smoothHeat([90]), [90]);
  assert.deepEqual(smoothHeat([30, 30]), [30, 30]);
  // a non-neighbour peak does not spread
  assert.deepEqual(smoothHeat([0, 0, 100]), [0, 40, 100]);
  // the peak itself never goes down, the others never exceed the local maximum
  const r = rng(3);
  for (let t = 0; t < 200; t++) {
    const own = Array.from({ length: 1 + Math.floor(r() * 9) }, () => r() * 100);
    smoothHeat(own).forEach((v, i) => {
      const m = Math.max(...[own[i - 1], own[i], own[i + 1]].filter((x) => x !== undefined));
      assert.ok(v >= own[i] - 1e-12 && v <= m + 1e-12);
    });
  }
});

test('smoothHeat: unscored sentences stay null and do not count as neighbours', () => {
  assert.deepEqual(smoothHeat([null, 80, null]), [null, 80, null]);
  assert.deepEqual(smoothHeat([20, null, 80]), [20, null, 80]);
  assert.deepEqual(smoothHeat([undefined, NaN, 10]), [null, null, 10]);
  assert.deepEqual(smoothHeat([]), []);
  assert.deepEqual(smoothHeat(null), []);
  assert.deepEqual(smoothHeat(undefined), []);
  assert.deepEqual(smoothHeat(new Float64Array([10, 50])), [0.6 * 10 + 0.4 * 50, 50]);
  const own = [5, 60];
  smoothHeat(own);
  assert.deepEqual(own, [5, 60]);
});
