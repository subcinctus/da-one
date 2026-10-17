// Calibration: detector scores as percentiles of professional human writing, the combined score,
// the 0–100 risk scale and sentence heat. No DOM access. The fitting side is tools/calibrate.py.

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// Percentile (0–100) of score x among human calibration samples, by linear interpolation of the
// quantiles q (101 in calibration.json). Same arithmetic as human_pct() in tools/calibrate.py.
// Returns null without quantiles or for a non-numeric score (the old page gave NaN or 0 there).
export function humanPct(q, x) {
  if (!q?.length || typeof x !== 'number' || Number.isNaN(x)) return null;
  if (x <= q[0]) return 0;
  const n = q.length - 1;
  if (x >= q[n]) return 100;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= x) lo = mid; else hi = mid; }
  const span = q[hi] - q[lo];
  return (100 / n) * (lo + (span > 0 ? (x - q[lo]) / span : 0));
}

// Risk scale shown to the user: typical human writing sits low, the 5%-false-positive line sits at 65.
export const RISK_KNOTS = Object.freeze([[0, 0], [50, 15], [80, 30], [90, 40], [95, 65], [99, 85], [100, 100]]);
export function riskFromPct(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  p = Math.max(0, p);
  for (let i = 1; i < RISK_KNOTS.length; i++) {
    const [x0, y0] = RISK_KNOTS[i - 1], [x1, y1] = RISK_KNOTS[i];
    if (p <= x1) return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
  }
  return 100;
}

export const band = (r) => (typeof r !== 'number' || Number.isNaN(r) ? 'none' : r >= 65 ? 'high' : r >= 40 ? 'mid' : 'low');
export const BAND_LABEL = Object.freeze({ high: 'High: likely flagged', mid: 'Medium: could be flagged', low: 'Low: reads human', none: 'Not checked yet' });

// logit of a percentile, clipped like logit_pct() in tools/calibrate.py
export const logitPct = (pct) => { const p = Math.min(0.999, Math.max(0.001, pct / 100)); return Math.log(p / (1 - p)); };

// Combined score from per-checker percentiles {key: pct}. `cal` is a calibration mode
// ({ensemble: {weights, combos, feature?}}) or its ensemble object. Uses the combo fitted for the
// sorted set of checkers that have a percentile and a positive weight; 'logit' averages
// logit(percentile), the old format averages the percentiles. ZipPy alone is too weak to stand for
// the overall risk, so at least one trained checker is required.
export function combine(cal, pcts) {
  const ens = cal?.ensemble ?? cal;
  const weights = ens?.weights, combos = ens?.combos;
  if (!weights || !combos || !pcts || typeof pcts !== 'object') return null;
  const used = Object.keys(pcts).filter((k) => finite(pcts[k]) && own(weights, k) && finite(weights[k]) && weights[k] > 0).sort();
  if (!used.some((k) => k !== 'zippy')) return null;
  const key = used.join('+');
  const q = own(combos, key) ? combos[key]?.human_q : null;
  if (!q?.length) return null;
  const f = (ens.feature ?? cal.feature) === 'logit' ? logitPct : (p) => p;
  let s = 0, w = 0;
  for (const k of used) { s += weights[k] * f(pcts[k]); w += weights[k]; }
  const pct = humanPct(q, s / w);
  if (pct === null) return null;
  return { pct, risk: Math.round(riskFromPct(pct)), used, flagged: used.filter((k) => Math.round(pcts[k]) >= 95) };
}

// Window weights when the calibration has none (the old page: e5-small counts double).
export const WINDOW_WEIGHTS = Object.freeze({ 'e5-small-lora': 2, 'bert-tiny-raid': 1 });
const windowWeight = (weights, k) => (finite(weights?.[k]) ? weights[k] : WINDOW_WEIGHTS[k] ?? 1);

// Per-checker window percentiles {key: (pct|null)[]} for the checkers that have window quantiles.
export function windowPcts(calWindows, probsByKey) {
  const out = {};
  for (const k of Object.keys(probsByKey || {})) {
    const q = own(calWindows, k) ? calWindows[k] : null;
    if (q?.length && probsByKey[k]?.length) out[k] = Array.from(probsByKey[k], (p) => humanPct(q, p));
  }
  return out;
}

// Per-window heat: each checker's window probabilities as human percentiles, averaged with
// weightsByKey (calibration window_weights; missing keys fall back to WINDOW_WEIGHTS, else 1).
// A window no checker scored is null.
export function windowHeat(calWindows, probsByKey, weightsByKey = null) {
  const per = windowPcts(calWindows, probsByKey);
  const keys = Object.keys(per).filter((k) => windowWeight(weightsByKey, k) > 0);
  const len = Math.max(0, ...keys.map((k) => per[k].length));
  return Array.from({ length: len }, (_, i) => {
    let s = 0, w = 0;
    for (const k of keys) {
      const p = per[k][i], wk = windowWeight(weightsByKey, k);
      if (finite(p)) { s += p * wk; w += wk; }
    }
    return w ? s / w : null;
  });
}

// Sentence i appears in windows i-1, i and i+1: it keeps 0.6 of its own window's heat and takes
// 0.4 of the strongest of those three, so a line next to an AI-looking one warms up too.
export function smoothHeat(heat) {
  const h = Array.from(heat || [], (x) => (finite(x) ? x : null));
  return h.map((x, i) => (x === null ? null : 0.6 * x + 0.4 * Math.max(...[x, h[i - 1], h[i + 1]].filter(finite))));
}
