import json, os, numpy as np, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from np_gpt2 import *
W = load_weights()
tok = tokenizer()
for name in ['woodchuck', 'paper_gan']:
    d = json.load(open(os.path.join(os.environ.get('GLTR_DEMO_DIR', 'detecting-fake-text/client/src/demo'), f'{name}.json')))
    text = d['request']['text']; ref = d['result']
    ids = tok.encode(text).ids
    toks = [tok.id_to_token(i) for i in ids]
    ok_tok = toks == ref['bpe_strings'][1:]
    full = [50256] + ids
    T = min(len(full), 1024)
    lp = log_softmax(forward(W, full[:T]))
    ranks, probs = [], []
    for t in range(T - 1):
        y = full[t + 1]
        ranks.append(int((lp[t] > lp[t, y]).sum()))
        probs.append(float(np.exp(lp[t, y])))
    rr = [r[0] for r in ref['real_topk']][:T-1]; rp = [r[1] for r in ref['real_topk']][:T-1]
    rank_match = np.mean(np.array(ranks) == np.array(rr))
    pdiff = np.abs(np.array(probs) - np.array(rp))
    print(name, 'tokens', len(ids), 'tokenization match:', ok_tok, '| rank exact match: %.4f' % rank_match, '| max |p diff|: %.2e' % pdiff.max(), 'mean: %.2e' % pdiff.mean())
    bad = [(i, toks[i], ranks[i], rr[i]) for i in range(len(rr)) if ranks[i] != rr[i]][:8]
    if bad: print('  mismatches (idx, tok, mine, ref):', bad)
