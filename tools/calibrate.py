"""Calibrate the four checkers against human-written text, separately for two kinds of writing.

Two references are measured, and the page ships the second:

  essay   — human essays written to a prompt by US school students (Kaggle DAIGT: Persuade
            corpus and others) vs AI essays (Mistral, Llama 2, Falcon, Claude, ChatGPT; ArguGPT)
  article — professional writing: RAID (abstracts, books, news, poetry, recipes, Reddit,
            reviews, Wikipedia) and Fast-DetectGPT's BBC news / WritingPrompts, human vs GPT-4,
            ChatGPT and the RAID models

The checkers score human school essays very high (ModernBERT rates most of them as AI), so with
the essay reference a polished, ChatGPT-style business answer only reached the 27th risk point.
Against professional writing the same answer scores 100. The page is for professional answers, so
it compares with professional writing; the essay numbers stay in the report for the record.

Inputs (from the scoring runs): pool.json (texts split in half into 'cal' and 'test'),
pool_scores.json (the three ONNX models), zippy_shard*.json (ZipPy, signed: positive = AI side)
and window_scores_prof.json (3-sentence windows from professional writing, for the sentence highlights).
Output: ai-checker/calibration.json, read by the page through models/manifest.json, and a
report of false-positive and detection rates measured on the held-out half.
"""
import itertools, json, os, sys

import numpy as np

CALIB_DIR = sys.argv[1] if len(sys.argv) > 1 else '/home/user/work/calib'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'ai-checker', 'calibration.json')
KEYS = ['bert-tiny-raid', 'e5-small-lora', 'modernbert-raid-mage', 'zippy']
MODES = {'essay': ('daigt', 'argugpt'), 'article': ('raid', 'fdg')}
WEIGHT_GRID = [0, 0.5, 1, 2, 3]
MIN_WEIGHT = 0.25  # every checker keeps a small say, so a missing one changes little


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


def combine(pcts, weights, keys):
    w = np.array([weights[k] for k in keys])
    return sum(wi * pcts[k] for wi, k in zip(w, keys)) / w.sum()


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
    te = ~cal
    src = np.array([p['src'].split('/')[0] for p in pool])
    gen = np.array([p['gen'] for p in pool])
    out = {'source': 'tools/calibrate.py', 'default_mode': 'article', 'modes': {}, 'windows': {}}
    report = {}
    for mode, sources in MODES.items():
        m = np.isin(src, sources)
        H, A = m & (lab == 0), m & (lab == 1)
        rep = {'human': int(H.sum()), 'ai': int(A.sum()), 'checkers': {}}
        # held-out estimate: quantiles from the calibration half, rates on the test half
        pc = {k: human_pct(quantiles(S[k][cal & H]), S[k]) for k in KEYS}
        for k in KEYS:
            rep['checkers'][k] = dict(tpr=float((np.round(pc[k][te & A]) >= 95).mean()), fpr=float((np.round(pc[k][te & H]) >= 95).mean()),
                                      auroc=auroc(S[k][te & A], S[k][te & H]))
        best = None
        for w in itertools.product(WEIGHT_GRID, repeat=len(KEYS)):
            if sum(w) == 0:
                continue
            weights = {k: max(MIN_WEIGHT, wi) for k, wi in zip(KEYS, w)}
            e = combine(pc, weights, KEYS)
            thr = np.quantile(e[cal & H], 0.95)
            key = (round(float((e[cal & A] > thr).mean()), 4), -sum(w))
            if best is None or key > best[0]:
                best = (key, weights)
        weights = best[1]
        e = combine(pc, weights, KEYS)
        qe = quantiles(e[cal & H])
        pe = human_pct(qe, e)
        rep['ensemble'] = dict(weights=weights, tpr=float((np.round(pe[te & A]) >= 95).mean()), fpr=float((np.round(pe[te & H]) >= 95).mean()),
                               medium_or_high_fpr=float((pe[te & H] >= 83).mean()),
                               tpr_by_generator={g: round(float((np.round(pe[te & A & (gen == g)]) >= 95).mean()), 3)
                                                 for g in sorted(set(gen[A])) if (te & A & (gen == g)).sum() >= 8})
        report[mode] = rep
        # shipped tables use every human sample of the mode
        pa = {k: human_pct(quantiles(S[k][H]), S[k]) for k in KEYS}
        mo = {'human_samples': int(H.sum()), 'ai_samples': int(A.sum()),
              'checkers': {k: {'human_q': [round(float(x), 7) for x in quantiles(S[k][H])],
                               'measured': {'tpr': round(rep['checkers'][k]['tpr'], 3), 'fpr': round(rep['checkers'][k]['fpr'], 3)}} for k in KEYS},
              'ensemble': {'weights': weights, 'combos': {}},
              'measured': {'tpr': round(rep['ensemble']['tpr'], 3), 'fpr': round(rep['ensemble']['fpr'], 3)}}
        for r in range(1, len(KEYS) + 1):
            for combo in itertools.combinations(sorted(KEYS), r):
                ec = combine(pa, weights, combo)
                mo['ensemble']['combos']['+'.join(combo)] = {'human_q': [round(float(x), 5) for x in quantiles(ec[H])]}
        if mode == out['default_mode']:
            out['modes'][mode] = mo
    # sentence windows from professional human writing (RAID + Fast-DetectGPT), matching the shipped reference
    ws = json.load(open(f'{CALIB_DIR}/window_scores_prof.json'))
    for k in ['e5-small-lora', 'bert-tiny-raid']:
        out['windows'][k] = [round(float(x), 7) for x in quantiles(ws[k]['human'])]
        report.setdefault('windows', {})[k] = dict(human_windows=len(ws[k]['human']),
                                                   ai_windows_above_95=float((human_pct(np.array(out['windows'][k]), ws[k]['ai']) >= 95).mean()))
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
