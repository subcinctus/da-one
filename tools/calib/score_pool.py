"""Score a calibration pool with every detector exactly as the browser page does.

    python3 tools/calib/score_pool.py POOL.jsonl MODELS_DIR OUT.json [key1,key2,...]

Scores are cached by text (OUT.cache.json next to OUT), so a rebuilt pool only scores new texts.

Matches ai-checker/workers/models.mjs: detector input cleaned like normalize.mjs forDetector
(invisible characters removed, unusual spaces normalised, then NFKC), tokens without special tokens,
windows of min(510, max_len - 2) tokens with a stride of 384/510 of that, [CLS] w [SEP] per window,
and the length-weighted mean of the window probabilities. Also scores 3-sentence windows of every
text (for the sentence highlights) with the models in WINDOW_MODELS.
"""
import hashlib, json, os, re, sys, time, unicodedata

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from model_specs import model_spec  # noqa: E402

WINDOW, STRIDE = 510, 384
WINDOW_MODELS = None  # every detector also scores the 3-sentence windows of rows marked 'win'
INVISIBLE = re.compile('[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]')
SPACES = re.compile('[  -   　]')


def for_detector(t):
    t = INVISIBLE.sub('', t)
    t = SPACES.sub(' ', t).replace(' ', '\n').replace(' ', '\n')
    return unicodedata.normalize('NFKC', t)


def sentences(text):
    """Close to Intl.Segmenter for prose: split after . ! ? (plus closing quotes) and at paragraph breaks."""
    out = []
    for para in re.split(r'\n\s*\n|\n', text):
        start = 0
        for m in re.finditer(r'[.!?]["\'’”)\]]?\s+(?=[A-Z0-9“"‘\'(])', para):
            if re.search(r'\b(?:Mr|Mrs|Ms|Dr|Prof|Rs|No|vs|St|Sr|Jr|Inc|Ltd|Co|e\.g|i\.e|etc)\.\s+$', para[start:m.end()]):
                continue  # an abbreviation, not a sentence end
            out.append(para[start:m.end()].strip())
            start = m.end()
        out.append(para[start:].strip())
    return [s for s in out if re.search(r'\w', s)]


def load(models_dir, key):
    d = os.path.join(models_dir, key)
    ref = json.load(open(os.path.join(d, 'reference.json')))
    meta = ref['files']['model_q8.onnx']
    path = os.path.join(d, 'model_q8.onnx')
    if not os.path.exists(path):
        with open(path, 'wb') as f:
            for p in meta['parts']:
                f.write(open(os.path.join(d, p), 'rb').read())
    so = ort.SessionOptions()
    so.add_session_config_entry('session.disable_quant_qdq', '1')
    so.intra_op_num_threads = int(os.environ.get('ORT_THREADS', '0'))  # 0 = ONNX Runtime's default
    sess = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
    tok = Tokenizer.from_file(os.path.join(d, 'tokenizer.json'))
    tok.no_padding()
    tok.no_truncation()
    return sess, tok, model_spec(key, ref)


def prob(sess, spec, ids):
    x = np.array([[spec['cls_id'], *ids, spec['sep_id']]], dtype=np.int64)
    names = [i.name for i in sess.get_inputs()]
    feed = {'input_ids': x, 'attention_mask': np.ones_like(x)}
    if 'token_type_ids' in names:
        feed['token_type_ids'] = np.zeros_like(x)
    feed = {k: v for k, v in feed.items() if k in names}
    lg = sess.run(None, feed)[0][0].astype(np.float64).reshape(-1)
    if spec.get('output') == 'sigmoid_human':
        return 1 - 1 / (1 + np.exp(-lg[0]))
    if spec.get('output') == 'sigmoid' or lg.size == 1:
        return 1 / (1 + np.exp(-lg[0]))
    z = np.exp(lg - lg.max())
    return float(z[spec.get('ai_index', 1)] / z.sum())


def score_text(sess, tok, spec, text):
    ids = tok.encode(for_detector(text), add_special_tokens=False).ids
    size = min(WINDOW, spec.get('max_len', 512) - 2)
    stride = round(size * STRIDE / WINDOW)
    wins = []
    start = 0
    while True:
        wins.append(ids[start:start + size])
        if start + size >= len(ids):
            break
        start += stride
    ps = [prob(sess, spec, w) for w in wins]
    ws = [max(1, len(w)) for w in wins]
    return float(np.average(ps, weights=ws))


def main():
    pool_path, models_dir, out_path = sys.argv[1:4]
    pool = [json.loads(l) for l in open(pool_path, encoding='utf-8') if l.strip()]
    keys = sys.argv[4].split(',') if len(sys.argv) > 4 else sorted(
        k for k in os.listdir(models_dir) if os.path.exists(os.path.join(models_dir, k, 'reference.json'))
        and json.load(open(os.path.join(models_dir, k, 'reference.json'))).get('kind', 'detector') == 'detector'
        and json.load(open(os.path.join(models_dir, k, 'reference.json'))).get('published', True))
    cache_path = out_path + '.cache.json'
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    h = lambda t: hashlib.sha1(t.encode('utf-8')).hexdigest()
    out = {'ids': [p['id'] for p in pool], 'doc': {}, 'win': {}}
    for key in keys:
        c = cache.setdefault(key, {})
        sess, tok, spec = load(models_dir, key)
        t0, n = time.time(), 0
        doc = []
        for i, p in enumerate(pool):
            k = h(p['text'])
            if k not in c:
                c[k] = score_text(sess, tok, spec, p['text'])
                n += 1
                if n % 200 == 0:
                    print(f'{key}: {n} new texts ({i + 1}/{len(pool)}) {time.time() - t0:.0f}s', flush=True)
                    json.dump(cache, open(cache_path, 'w'))
            doc.append(c[k])
        out['doc'][key] = doc
        print(f'{key}: {len(pool)} texts ({n} new) in {time.time() - t0:.0f}s', flush=True)
        if WINDOW_MODELS is None or key in WINDOW_MODELS:
            t0, n = time.time(), 0
            win = {}
            for p in pool:
                if not p.get('win', True):
                    continue
                S = sentences(p['text'])
                ws = [' '.join(S[max(0, i - 1):i + 2]) for i in range(len(S))]
                vals = []
                for w in ws:
                    k = 'w:' + h(w)
                    if k not in c:
                        c[k] = score_text(sess, tok, spec, w)
                        n += 1
                    vals.append(c[k])
                win[p['id']] = vals
            out['win'][key] = win
            print(f'{key}: windows ({n} new) in {time.time() - t0:.0f}s', flush=True)
        json.dump(cache, open(cache_path, 'w'))
        json.dump(out, open(out_path, 'w'))


if __name__ == '__main__':
    main()
