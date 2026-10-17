"""Fit the page's calibration from a scored calibration pool, and write a report.

    python3 tools/calibrate.py POOL.jsonl SCORES_DIR [OUT_JSON] [REPORT_MD] [--validator KEY]

POOL.jsonl comes from tools/calib/build_pool.py; SCORES_DIR holds scores-*.json from
tools/calib/score_pool.py (doc and window probabilities per detector) and zippy.json from
tools/calib/zippy_pool.mjs. Output (read by the page through models/manifest.json):

  modes.article.checkers[k].human_q   101 quantiles of detector k's score on professional human texts
  modes.article.ensemble              {feature: 'logit', weights, combos: {"k1+k2": {human_q}}}
  windows[k], window_weights[k]       the same for 3-sentence windows (sentence highlights, rewrite guide)
  validator                           the detector held out of rewrite selection

Method: each score becomes a percentile among professional human texts (conformal p-value). The
detectors are combined by a non-negative logistic regression on logit(percentile), fitted on the
calibration half with non-native human texts weighted up, so the combination is not tuned to flag
them; the combined score gets its own human quantiles. Rates are measured on the held-out half and on
Human Detectors (never used for fitting), with Clopper-Pearson 95% intervals.
"""
import itertools, json, os, sys

import numpy as np
from scipy.optimize import minimize
from scipy.stats import beta

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
POOL, SCORES = ARGS[0], ARGS[1]
OUT = ARGS[2] if len(ARGS) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'ai-checker', 'calibration.json')
REPORT = ARGS[3] if len(ARGS) > 3 else None
VALIDATOR = sys.argv[sys.argv.index('--validator') + 1] if '--validator' in sys.argv else None
REF_GROUPS = {'prof', 'web', 'legacy'}       # the "professional human writing" reference
AI_GROUPS = {'ai', 'indomain', 'legacy'}
LEGACY_GEN = {'gpt-3.5/4'}


def quantiles(a):
    return np.quantile(np.asarray(a, dtype=float), np.linspace(0, 1, 101))


def human_pct(q, x):
    """Same interpolation as humanPct() in src/calibration.mjs."""
    q = np.asarray(q)
    x = np.asarray(x, dtype=float)
    n = len(q) - 1
    lo = np.clip(np.searchsorted(q, x, side='right') - 1, 0, n - 1)
    span = q[lo + 1] - q[lo]
    frac = np.where(span > 0, (x - q[lo]) / np.where(span > 0, span, 1), 0)
    p = (100 / n) * (lo + frac)
    return np.where(x <= q[0], 0, np.where(x >= q[n], 100, p))


def logit_pct(p):
    p = np.clip(np.asarray(p, dtype=float) / 100, 0.001, 0.999)
    return np.log(p / (1 - p))


def auroc(pos, neg):
    pos, neg = np.asarray(pos, dtype=float), np.asarray(neg, dtype=float)
    if not len(pos) or not len(neg):
        return float('nan')
    order = np.argsort(np.concatenate([pos, neg]), kind='mergesort')
    ranks = np.empty(len(order))
    vals = np.concatenate([pos, neg])[order]
    i = 0
    while i < len(vals):  # average ranks for ties
        j = i
        while j + 1 < len(vals) and vals[j + 1] == vals[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    rp = ranks[:len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def cp(k, n):
    """Clopper-Pearson 95% interval for k successes in n."""
    if n == 0:
        return (float('nan'), float('nan'))
    lo = beta.ppf(0.025, k, n - k + 1) if k > 0 else 0.0
    hi = beta.ppf(0.975, k + 1, n - k) if k < n else 1.0
    return (float(lo), float(hi))


def rate(mask_flag):
    k, n = int(np.sum(mask_flag)), int(np.size(mask_flag))
    lo, hi = cp(k, n)
    return dict(k=k, n=n, rate=(k / n if n else float('nan')), lo=lo, hi=hi)


def nnlr(X, y, w, l2=1e-3):
    """Logistic regression with non-negative coefficients (and a free intercept)."""
    d = X.shape[1]

    def f(theta):
        b, c = theta[0], theta[1:]
        z = b + X @ c
        p = 1 / (1 + np.exp(-z))
        eps = 1e-9
        loss = -np.sum(w * (y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps))) / np.sum(w) + l2 * np.sum(c ** 2)
        g = (p - y) * w / np.sum(w)
        return loss, np.concatenate([[g.sum()], X.T @ g + 2 * l2 * c])

    res = minimize(f, np.concatenate([[0.0], np.full(d, 0.1)]), jac=True, method='L-BFGS-B',
                   bounds=[(None, None)] + [(0, None)] * d)
    return res.x[0], res.x[1:]


def main():
    pool = [json.loads(l) for l in open(POOL, encoding='utf-8') if l.strip()]
    ids = [p['id'] for p in pool]
    idx = {i: k for k, i in enumerate(ids)}
    doc, win = {}, {}
    for f in sorted(os.listdir(SCORES)):
        d = json.load(open(os.path.join(SCORES, f)))
        assert d['ids'] == ids, f'{f} was scored on a different pool'
        if 'zippy' in d:
            doc['zippy'] = np.asarray(d['zippy'], dtype=float)
        for k, v in d.get('doc', {}).items():
            doc[k] = np.asarray(v, dtype=float)
        for k, v in d.get('win', {}).items():
            win[k] = v
    keys = sorted(doc)
    lab = np.array([p['label'] for p in pool])
    grp = np.array([p['group'] for p in pool])
    split = np.array([p['split'] for p in pool])
    task = np.array([p['task'] for p in pool])
    gen = np.array([p['gen'] for p in pool])
    nw = np.array([len(p['text'].split()) for p in pool])
    cal, te = split == 'cal', split == 'test'
    ref_h = (lab == 0) & np.isin(grp, list(REF_GROUPS))
    ai = (lab == 1) & np.isin(grp, list(AI_GROUPS))
    modern = ai & ~np.isin(gen, list(LEGACY_GEN))
    nonnat, essay, held = (grp == 'nonnative'), (grp == 'essay'), (grp == 'heldout')
    print(f'{len(pool)} texts; reference human {ref_h.sum()} (cal {(ref_h & cal).sum()}), AI {ai.sum()} (modern {modern.sum()}), '
          f'non-native {nonnat.sum()}, essays {essay.sum()}, held-out {held.sum()}; detectors {keys}')

    R = {'detectors': {}, 'pool': dict(n=len(pool), ref_human=int(ref_h.sum()), ai=int(ai.sum()), modern_ai=int(modern.sum()),
                                       nonnative=int(nonnat.sum()), essay=int(essay.sum()), heldout=int(held.sum()))}
    pct_cal = {}
    for k in keys:
        q = quantiles(doc[k][ref_h & cal])
        pc = human_pct(q, doc[k])
        pct_cal[k] = pc
        flag = np.round(pc) >= 95
        R['detectors'][k] = dict(
            auroc_modern=auroc(doc[k][modern & te], doc[k][ref_h & te]),
            auroc_heldout=auroc(doc[k][held & (lab == 1)], doc[k][held & (lab == 0)]),
            tpr_modern=rate(flag[modern & te]), fpr_prof=rate(flag[ref_h & te]),
            fpr_nonnative=rate(flag[nonnat]), fpr_essay=rate(flag[essay]),
            heldout_tpr=rate(flag[held & (lab == 1)]), heldout_fpr=rate(flag[held & (lab == 0)]),
            tpr_by_task={t: rate(flag[modern & te & (task == t)])['rate'] for t in ('generate', 'polish', 'rewrite', 'humanized')})

    # ensemble: non-negative logistic regression on logit(percentile), non-native humans weighted up
    fit_rows = cal & ((ref_h | ai | nonnat))
    X = np.stack([logit_pct(pct_cal[k]) for k in keys], 1)
    y = ai.astype(float)
    w = np.where(nonnat, 2.0, 1.0)
    b, coef = nnlr(X[fit_rows], y[fit_rows], w[fit_rows])
    coef = np.where(coef < 0.02 * coef.max(), 0.0, coef)
    weights = {k: round(float(c), 4) for k, c in zip(keys, coef)}
    used = [k for k in keys if weights[k] > 0]
    print('ensemble weights:', weights)

    def combo_score(sub, pcts):
        ws = np.array([weights[k] for k in sub])
        return sum(wk * logit_pct(pcts[k]) for wk, k in zip(ws, sub)) / ws.sum()

    s_cal = combo_score(used, pct_cal)
    qe = quantiles(s_cal[ref_h & cal])
    pe = human_pct(qe, s_cal)
    flag = np.round(pe) >= 95
    ens = dict(weights=weights, intercept=float(b),
               auroc_modern=auroc(s_cal[modern & te], s_cal[ref_h & te]),
               auroc_heldout=auroc(s_cal[held & (lab == 1)], s_cal[held & (lab == 0)]),
               tpr_modern=rate(flag[modern & te]), tpr_legacy=rate(flag[ai & ~modern & te]),
               fpr_prof=rate(flag[ref_h & te]), fpr_prof_150=rate(flag[ref_h & te & (nw >= 150)]),
               fpr_nonnative=rate(flag[nonnat]), fpr_essay=rate(flag[essay]),
               medium_or_high_fpr_prof=rate((pe >= 90)[ref_h & te]),
               heldout_tpr=rate(flag[held & (lab == 1)]), heldout_fpr=rate(flag[held & (lab == 0)]),
               tpr_by_task={t: rate(flag[modern & te & (task == t)]) for t in ('generate', 'polish', 'rewrite', 'humanized')},
               tpr_by_gen={g: rate(flag[modern & te & (gen == g)])['rate'] for g in sorted(set(gen[modern & te])) if (modern & te & (gen == g)).sum() >= 8},
               fpr_by_src={s: rate(flag[ref_h & te & (np.array([p['src'] for p in pool]) == s)]) for s in sorted({p['src'] for p in pool if p['label'] == 0})},
               by_length={f'{a}-{z}': dict(tpr=rate(flag[modern & te & (nw >= a) & (nw < z)])['rate'], fpr=rate(flag[ref_h & te & (nw >= a) & (nw < z)])['rate'])
                          for a, z in ((0, 150), (150, 300), (300, 10000))})
    # agreement with Pangram / GPTZero on the held-out articles
    ext = {}
    for name in ('pangram', 'gptzero'):
        v = np.array([p.get(name, np.nan) for p in pool], dtype=float)
        m = held & ~np.isnan(v)
        if m.sum():
            theirs, ours = v[m] >= 0.5, flag[m]
            po = float((theirs == ours).mean())
            pe_ = float(theirs.mean() * ours.mean() + (1 - theirs.mean()) * (1 - ours.mean()))
            ext[name] = dict(n=int(m.sum()), agreement=po, kappa=(po - pe_) / (1 - pe_) if pe_ < 1 else float('nan'),
                             their_tpr=float(theirs[lab[m] == 1].mean()), their_fpr=float(theirs[lab[m] == 0].mean()))
    ens['vs_commercial'] = ext
    R['ensemble'] = ens

    # shipped tables use every reference human text
    out = {'version': 2, 'source': 'tools/calibrate.py', 'default_mode': 'article', 'modes': {}, 'windows': {}, 'window_weights': {}}
    pa = {k: human_pct(quantiles(doc[k][ref_h]), doc[k]) for k in keys}
    mo = {'human_samples': int(ref_h.sum()), 'ai_samples': int(ai.sum()),
          'checkers': {k: {'human_q': [round(float(x), 7) for x in quantiles(doc[k][ref_h])],
                           'measured': {'tpr': round(R['detectors'][k]['tpr_modern']['rate'], 3), 'fpr': round(R['detectors'][k]['fpr_prof']['rate'], 3)}} for k in keys},
          'ensemble': {'feature': 'logit', 'weights': weights, 'combos': {}},
          'measured': {'tpr': round(ens['tpr_modern']['rate'], 3), 'fpr': round(ens['fpr_prof']['rate'], 3),
                       'fpr_nonnative': round(ens['fpr_nonnative']['rate'], 3), 'heldout_tpr': round(ens['heldout_tpr']['rate'], 3),
                       'heldout_fpr': round(ens['heldout_fpr']['rate'], 3)}}
    for r in range(1, len(used) + 1):
        for combo in itertools.combinations(sorted(used), r):
            sc = combo_score(combo, pa)
            mo['ensemble']['combos']['+'.join(combo)] = {'human_q': [round(float(x), 5) for x in quantiles(sc[ref_h])]}
    out['modes']['article'] = mo

    # windows: human quantiles per detector, and window weights by the same non-negative fit
    wkeys = [k for k in keys if k in win]
    if wkeys:
        hw, aw = {k: [] for k in wkeys}, {k: [] for k in wkeys}
        rows_h = [p['id'] for p in pool if p['label'] == 0 and p['group'] in REF_GROUPS and p['split'] == 'cal' and p.get('win')]
        rows_a = [p['id'] for p in pool if p['label'] == 1 and p['group'] in AI_GROUPS and p['split'] == 'cal' and p.get('win')]
        common_h = [i for i in rows_h if all(i in win[k] for k in wkeys)]
        common_a = [i for i in rows_a if all(i in win[k] for k in wkeys)]
        for k in wkeys:
            hw[k] = np.concatenate([win[k][i] for i in common_h if win[k][i]]) if common_h else np.array([])
            aw[k] = np.concatenate([win[k][i] for i in common_a if win[k][i]]) if common_a else np.array([])
        R['windows'] = {}
        Xw, yw = [], []
        for k in wkeys:
            qk = quantiles(hw[k])
            out['windows'][k] = [round(float(x), 7) for x in qk]
            R['windows'][k] = dict(human=len(hw[k]), ai=len(aw[k]), auroc=auroc(aw[k], hw[k]),
                                   ai_above_90=float((human_pct(qk, aw[k]) >= 90).mean()))
            Xw.append(np.concatenate([logit_pct(human_pct(qk, hw[k])), logit_pct(human_pct(qk, aw[k]))]))
        Xw = np.stack(Xw, 1)
        yw = np.concatenate([np.zeros(len(hw[wkeys[0]])), np.ones(len(aw[wkeys[0]]))])
        _, cw = nnlr(Xw, yw, np.ones(len(yw)))
        cw = np.where(cw < 0.02 * cw.max(), 0.0, cw)
        out['window_weights'] = {k: round(float(c), 4) for k, c in zip(wkeys, cw)}
        print('window weights:', out['window_weights'])
    # validator: the strongest detector on modern text unless one is named; the rest guide rewrites
    det = [k for k in keys if k != 'zippy' and weights.get(k, 0) > 0 and k in out['windows']]
    if VALIDATOR:
        out['validator'] = VALIDATOR
    elif det:
        out['validator'] = max(det, key=lambda k: R['detectors'][k]['auroc_modern'])
    R['validator'] = out.get('validator')
    gate = dict(prof_fpr_150=ens['fpr_prof_150'], modern_tpr=ens['tpr_modern'],
                passed=bool(ens['fpr_prof_150']['rate'] <= 0.05 and ens['fpr_prof_150']['hi'] <= 0.08 and ens['tpr_modern']['rate'] >= 0.90))
    R['release_gate'] = gate
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    print(json.dumps({k: v for k, v in R.items() if k != 'detectors'}, indent=1, default=float)[:6000])
    if REPORT:
        write_report(R, REPORT)
    print('release gate', 'PASSED' if gate['passed'] else 'NOT MET')


def pc(r):
    return f"{100 * r['rate']:.1f}% ({100 * r['lo']:.1f}–{100 * r['hi']:.1f}, n={r['n']})" if r['n'] else '–'


def write_report(R, path):
    L = ['# Calibration report', '', f"Pool: {R['pool']}", '',
         '## Detectors (held-out half; "flags" = above the 95th percentile of professional human writing)', '',
         '| Detector | AUROC modern | AUROC held-out | Modern AI flagged | Prof. human flagged | Non-native flagged | Essays flagged | Held-out AI / human flagged |',
         '|---|---|---|---|---|---|---|---|']
    for k, d in R['detectors'].items():
        L.append(f"| {k} | {d['auroc_modern']:.3f} | {d['auroc_heldout']:.3f} | {pc(d['tpr_modern'])} | {pc(d['fpr_prof'])} | {pc(d['fpr_nonnative'])} | {pc(d['fpr_essay'])} | {100 * d['heldout_tpr']['rate']:.0f}% / {100 * d['heldout_fpr']['rate']:.0f}% |")
    e = R['ensemble']
    L += ['', '## Combined score', '', f"Weights: {e['weights']}", '',
          f"- AUROC modern {e['auroc_modern']:.3f}, held-out {e['auroc_heldout']:.3f}",
          f"- Modern AI flagged: {pc(e['tpr_modern'])}; legacy (GPT-3.5/4) AI: {pc(e['tpr_legacy'])}",
          f"- Professional human flagged: {pc(e['fpr_prof'])}; at 150+ words {pc(e['fpr_prof_150'])}; Medium or High {pc(e['medium_or_high_fpr_prof'])}",
          f"- Non-native human flagged: {pc(e['fpr_nonnative'])}; student essays {pc(e['fpr_essay'])}",
          f"- Held-out articles (Human Detectors): AI {pc(e['heldout_tpr'])}, human {pc(e['heldout_fpr'])}",
          '', '| Task | Modern AI flagged |', '|---|---|'] + [f'| {t} | {pc(r)} |' for t, r in e['tpr_by_task'].items()]
    L += ['', '| Generator | Flagged |', '|---|---|'] + [f'| {g} | {100 * r:.0f}% |' for g, r in e['tpr_by_gen'].items()]
    L += ['', '| Human source | Flagged |', '|---|---|'] + [f'| {s} | {pc(r)} |' for s, r in e['fpr_by_src'].items()]
    L += ['', '| Length (words) | AI flagged | Human flagged |', '|---|---|---|'] + [f"| {b} | {100 * v['tpr']:.0f}% | {100 * v['fpr']:.0f}% |" for b, v in e['by_length'].items()]
    if e.get('vs_commercial'):
        L += ['', '## Agreement with commercial detectors on the held-out articles', '']
        for n, v in e['vs_commercial'].items():
            L.append(f"- {n}: agreement {100 * v['agreement']:.0f}%, kappa {v['kappa']:.2f}; {n} itself flagged {100 * v['their_tpr']:.0f}% of AI and {100 * v['their_fpr']:.0f}% of human (n={v['n']})")
    if R.get('windows'):
        L += ['', '## Sentence windows', '', '| Detector | Human windows | AI windows | AUROC | AI windows above 90th |', '|---|---|---|---|---|']
        L += [f"| {k} | {v['human']} | {v['ai']} | {v['auroc']:.3f} | {100 * v['ai_above_90']:.0f}% |" for k, v in R['windows'].items()]
    g = R['release_gate']
    L += ['', f"Validator (held out of rewrite selection): {R.get('validator')}", '',
          f"## Release gate: {'PASSED' if g['passed'] else 'NOT MET'}",
          f"- Professional human texts of 150+ words flagged: {pc(g['prof_fpr_150'])} (target ≤5%, upper bound ≤8%)",
          f"- Modern AI texts flagged: {pc(g['modern_tpr'])} (target ≥90%)"]
    open(path, 'w').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
