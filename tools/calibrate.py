"""Calibrate the four checkers against human-written text and pick ensemble weights.

Inputs (from the scoring runs): pool.json (1,293 texts: RAID, Fast-DetectGPT and DAIGT/ArguGPT
human and AI samples, split in half into 'cal' and 'test'), pool_scores.json (the three ONNX
models), zippy_shard*.json (ZipPy, signed: positive = AI side) and window_scores.json
(3-sentence windows for the sentence highlights).

Output: ai-checker/calibration.json, read by the page through models/manifest.json, and a
report of false-positive and detection rates measured on the held-out half.
"""
import itertools, json, os, sys

import numpy as np

CALIB_DIR = sys.argv[1] if len(sys.argv) > 1 else '/home/user/work/calib'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'ai-checker', 'calibration.json')
KEYS = ['bert-tiny-raid', 'e5-small-lora', 'modernbert-raid-mage', 'zippy']


def quantiles(a):
    return np.quantile(np.asarray(a, dtype=float), np.linspace(0, 1, 101))


def human_pct(q, x):
    """Same interpolation as humanPct() in app.mjs."""
    q = np.asarray(q)
    x = np.asarray(x, dtype=float)
    n = len(q) - 1
    lo = np.clip(np.searchsorted(q, x, side='right') - 1, 0, n - 1)
    span = q[lo + 1] - q[lo]
    frac = np.where(span > 0, (x - q[lo]) / np.where(span > 0, span, 1), 0)
    p = (100 / n) * (lo + frac)
    return np.where(x <= q[0], 0, np.where(x >= q[n], 100, p))


def auroc(pos, neg):
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def main():
    pool = json.load(open(f'{CALIB_DIR}/pool.json'))
    sc = json.load(open(f'{CALIB_DIR}/pool_scores.json'))
    z = {}
    for s in range(3):
        z.update({int(k): v for k, v in json.load(open(f'{CALIB_DIR}/zippy_shard{s}.json')).items()})
    sc['zippy'] = [z[i] for i in range(len(pool))]
    S = {k: np.asarray(sc[k], dtype=float) for k in KEYS}
    lab = np.array([p['label'] for p in pool])
    cal = np.array([p['split'] == 'cal' for p in pool])
    src = np.array([p['src'] for p in pool])
    gen = np.array([p['gen'] for p in pool])
    H, A = lab == 0, lab == 1
    report = {'pool': {'texts': len(pool), 'human': int(H.sum()), 'ai': int(A.sum())}, 'checkers': {}}

    # per checker: quantiles from the calibration half, rates on the held-out half
    pct_cal = {}
    for k in KEYS:
        q = quantiles(S[k][cal & H])
        p = human_pct(q, S[k])
        pct_cal[k] = p
        te = ~cal
        report['checkers'][k] = dict(
            fpr_test=float((np.round(p[te & H]) >= 95).mean()),
            tpr_test=float((np.round(p[te & A]) >= 95).mean()),
            auroc_test=auroc(S[k][te & A], S[k][te & H]),
            tpr_by_source={s: float((np.round(p[te & A & (src == s)]) >= 95).mean()) for s in sorted(set(src[A])) if (te & A & (src == s)).sum() >= 5},
        )

    # ensemble weights: maximise detection at 5% false positives on the calibration half
    grid = [0, 0.5, 1, 2, 3]
    best = None
    for w in itertools.product(grid, repeat=len(KEYS)):
        if sum(w) == 0 or w[KEYS.index('modernbert-raid-mage')] == 0:
            continue
        e = sum(wi * pct_cal[k] for wi, k in zip(w, KEYS)) / sum(w)
        thr = np.quantile(e[cal & H], 0.95)
        tpr = (e[cal & A] > thr).mean()
        key = (round(float(tpr), 4), sum(1 for wi in w if wi > 0))  # ties: prefer using more checkers
        if best is None or key > best[0]:
            best = (key, w, thr)
    w = best[1]
    weights = {k: float(wi) for k, wi in zip(KEYS, w)}
    # keep every checker in the risk score with at least a small weight, so a missing one changes little
    for k in KEYS:
        if weights[k] == 0:
            weights[k] = 0.25
    e_cal = sum(weights[k] * pct_cal[k] for k in KEYS) / sum(weights.values())
    qe = quantiles(e_cal[cal & H])
    pe = human_pct(qe, e_cal)
    te = ~cal
    report['ensemble'] = dict(weights=weights, fpr_test=float((np.round(pe[te & H]) >= 95).mean()),
                              tpr_test=float((np.round(pe[te & A]) >= 95).mean()),
                              medium_or_high_fpr_test=float((pe[te & H] >= 83).mean()),
                              tpr_by_generator={g: float((np.round(pe[te & A & (gen == g)]) >= 95).mean()) for g in sorted(set(gen[A])) if (te & A & (gen == g)).sum() >= 5})

    # final tables use every human sample
    out = {'source': 'tools/calibrate.py', 'human_samples': int(H.sum()), 'checkers': {}, 'ensemble': {'weights': weights, 'combos': {}}, 'windows': {}}
    pct_all = {}
    for k in KEYS:
        q = quantiles(S[k][H])
        out['checkers'][k] = {'human_q': [round(float(x), 7) for x in q]}
        pct_all[k] = human_pct(q, S[k])
    for r in range(1, len(KEYS) + 1):
        for combo in itertools.combinations(sorted(KEYS), r):
            e = sum(weights[k] * pct_all[k] for k in combo) / sum(weights[k] for k in combo)
            out['ensemble']['combos']['+'.join(combo)] = {'human_q': [round(float(x), 5) for x in quantiles(e[H])]}
    ws = json.load(open(f'{CALIB_DIR}/window_scores.json'))
    for k in ['e5-small-lora', 'bert-tiny-raid']:
        out['windows'][k] = [round(float(x), 7) for x in quantiles(ws[k]['human'])]
        qh = np.array(out['windows'][k])
        report.setdefault('windows', {})[k] = dict(human_windows=len(ws[k]['human']), ai_windows=len(ws[k]['ai']),
                                                   ai_windows_above_95=float((human_pct(qh, ws[k]['ai']) >= 95).mean()))
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
