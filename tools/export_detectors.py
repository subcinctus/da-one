"""Download open-source AI-text detectors, export them to ONNX and quantize them for the browser.

Run by .github/workflows/fetch-detector-models.yml (the build sandbox cannot reach Hugging Face).
For every model it writes, under out/<key>/:
  model_q8.onnx        int8 block-quantized weights (DequantizeLinear-21), fp32 compute
  model_q4.onnx        int4 variant (only where requested)
  tokenizer files, config.json, the model card, and reference.json with PyTorch vs ONNX scores
Files above 45 MB are split into .partN chunks (GitHub rejects files over 100 MB).

Kinds: 'detector' (AI-text classifier, scored on Fast-DetectGPT samples), 'nli' (sentence-pair
entailment model for the rewrite meaning check), 'embed' (sentence embeddings, mean-pooled and
L2-normalised inside the graph), 'github-onnx' (a detector that ships its own ONNX file in a GitHub repo).
Set ONLY=key1,key2 to export a subset. A spec with publish=False keeps only reference.json (a parity
and size report) and drops the weights.
"""
import hashlib, json, os, sys, time, traceback

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import TensorProto, helper, numpy_helper
from huggingface_hub import HfApi, snapshot_download
from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'out')
SAMPLES = json.load(open(os.path.join(os.path.dirname(__file__), 'sample_texts.json')))
CHUNK = 45 * 1024 * 1024
torch.set_grad_enabled(False)

MODELS = [
    dict(key='bert-tiny-raid', repo='ShantanuT01/BERT-tiny-RAID', variants=['q8', 'fp32']),
    dict(key='e5-small-lora', repo='MayZhou/e5-small-lora-ai-generated-detector', variants=['q8', 'q4']),
    dict(key='modernbert-raid-mage', repo='GeorgeDrayson/modernbert-ai-detection-raid-mage', variants=['q8', 'q4']),
    # trained on 14 sources incl. GPT-4o, Claude 3, Llama 3, Qwen 2.5 (Apache-2.0)
    dict(key='fakespot-roberta', repo='fakespot-ai/roberta-base-ai-text-detection-v1', variants=['q8']),
    # ModernBERT-base R1.1, MIT; RAID 98.98% with attacks
    dict(key='tabularis-modernbert', repo='tabularisai/ai-text-detection', variants=['q8']),
    # MiniLMv2 distilled from DeBERTa-v3-large, MIT, ships its own int8 ONNX on GitHub
    dict(key='sallulabs-minilm', kind='github-onnx', repo='https://github.com/salmannawaz786/sallulabs-ai-detector',
         onnx='model/model_int8.onnx', variants=['q8']),
    # rewrite guards
    dict(key='nli-deberta-xsmall', kind='nli', repo='cross-encoder/nli-deberta-v3-xsmall', variants=['q8']),
    dict(key='minilm-l6', kind='embed', repo='sentence-transformers/all-MiniLM-L6-v2', variants=['q8']),
    # DeBERTa-v3-large, MIT, not RAID-trained: size and int8 parity report only for now
    dict(key='gradient-deberta', repo='ShantanuT01/gradient-ai-text-detector', variants=['q8'], publish=False, n_samples=120),
]
PROBES = ['fakespot-ai/roberta-base-ai-text-detection-v1', 'tabularisai/ai-text-detection',
          'ShantanuT01/gradient-ai-text-detector', 'ShantanuT01/vanguard-ai-text-detector',
          'noumenon-labs/Earlybird-fast', 'cross-encoder/nli-deberta-v3-xsmall',
          'sentence-transformers/all-MiniLM-L6-v2', 'HuggingFaceTB/SmolLM2-135M']


def log(*a):
    print(*a, flush=True)


def probe(repo):
    api = HfApi()
    try:
        info = api.model_info(repo, files_metadata=True)
    except Exception as e:  # noqa: BLE001
        log(f'[probe] {repo}: unavailable ({e.__class__.__name__}: {str(e)[:120]})')
        return
    card = getattr(info, 'card_data', None) or {}
    lic = card.get('license') if hasattr(card, 'get') else None
    files = [(s.rfilename, s.size) for s in (info.siblings or [])]
    weights = [(f, s) for f, s in files if f.endswith(('.safetensors', '.bin', '.onnx'))]
    log(f'[probe] {repo}: license={lic} tags={(info.tags or [])[:12]} downloads={getattr(info, "downloads", None)}')
    for f, s in weights:
        log(f'          {f}  {((s or 0) / 1e6):.1f} MB')
    try:
        cfg = AutoConfig.from_pretrained(repo)
        log(f'          arch={getattr(cfg, "architectures", None)} model_type={cfg.model_type} '
            f'hidden={getattr(cfg, "hidden_size", None)} layers={getattr(cfg, "num_hidden_layers", None)} '
            f'max_pos={getattr(cfg, "max_position_embeddings", None)} id2label={getattr(cfg, "id2label", None)}')
    except Exception as e:  # noqa: BLE001
        log(f'          config: {e.__class__.__name__}: {str(e)[:200]}')


def load_model(spec, local):
    """Load the classifier; merge a PEFT adapter into its base model when the repo only holds an adapter."""
    kw = {}
    cfg_path = os.path.join(local, 'config.json')
    if os.path.exists(cfg_path):
        mt = json.load(open(cfg_path)).get('model_type', '')
        if mt == 'modernbert':
            kw = dict(attn_implementation='eager', reference_compile=False)
    if os.path.exists(os.path.join(local, 'adapter_config.json')) and not os.path.exists(cfg_path):
        from peft import PeftModel
        acfg = json.load(open(os.path.join(local, 'adapter_config.json')))
        base = acfg['base_model_name_or_path']
        log(f'  PEFT adapter on {base}; merging')
        bm, binfo = AutoModelForSequenceClassification.from_pretrained(base, num_labels=2, output_loading_info=True)
        log(f'  base loading info: {binfo}')
        model = PeftModel.from_pretrained(bm, local).merge_and_unload()
        tok = AutoTokenizer.from_pretrained(base)
        return model.eval(), tok, base
    model, info = AutoModelForSequenceClassification.from_pretrained(local, output_loading_info=True, **kw)
    log(f'  loading info: {info}')
    tok = AutoTokenizer.from_pretrained(local)
    return model.eval(), tok, None


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask):
        return self.m(input_ids=input_ids, attention_mask=attention_mask).logits.float()


class EmbedWrap(torch.nn.Module):
    """Mean-pool the last hidden state over real tokens and L2-normalise (sentence-transformers style)."""
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask):
        h = self.m(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).to(h.dtype)
        v = (h * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        return torch.nn.functional.normalize(v, p=2, dim=1)


def ops_of(path):
    m = onnx.load(path, load_external_data=False)
    return sorted({f'{n.domain + "." if n.domain else ""}{n.op_type}' for n in m.graph.node})


def torch_scores(model, tok, texts, max_len):
    out = []
    for t in texts:
        enc = tok(t, truncation=True, max_length=max_len, return_tensors='pt')
        out.append(model(**{k: v for k, v in enc.items() if k in ('input_ids', 'attention_mask', 'token_type_ids')}).logits[0].float().numpy())
    return np.array(out)


def onnx_scores(path, tok, texts, max_len):
    so = ort.SessionOptions()
    so.add_session_config_entry('session.disable_quant_qdq', '1')
    t0 = time.time()
    s = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
    load = time.time() - t0
    out = []
    t0 = time.time()
    for t in texts:
        enc = tok(t, truncation=True, max_length=max_len, return_tensors='np')
        out.append(s.run(None, {'input_ids': enc['input_ids'].astype(np.int64),
                                'attention_mask': enc['attention_mask'].astype(np.int64)})[0][0])
    return np.array(out), load, (time.time() - t0) / len(texts)


def softmax(z):
    z = z - z.max(-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(-1, keepdims=True)


def auroc(scores, labels):
    scores, labels = np.asarray(scores), np.asarray(labels)
    pos, neg = scores[labels == 1], scores[labels == 0]
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def pack_int4(q):
    flat = (q.astype(np.int16).reshape(-1) & 0x0F).astype(np.uint8)
    if flat.size % 2:
        flat = np.concatenate([flat, np.zeros(1, np.uint8)])
    return (flat[0::2] | (flat[1::2] << 4)).tobytes()


def quantize_dq21(src, dst, bits=8, block=64, min_elems=4096):
    """Replace large MatMul/Gemm/Gather weight initializers by blocked DequantizeLinear-21 (int8 or int4)."""
    m = onnx.load(src)
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    consumers = {}
    for n in g.node:
        for j, x in enumerate(n.input):
            consumers.setdefault(x, []).append((n, j))
    axis_for = {}
    for name, init in inits.items():
        if len(init.dims) != 2 or int(np.prod(init.dims)) < min_elems:
            continue
        axes = set()
        for n, j in consumers.get(name, []):
            if n.op_type == 'MatMul' and j == 1:
                axes.add(0)  # W[K, N]: blocks run down K
            elif n.op_type == 'Gemm' and j == 1:
                tb = next((a.i for a in n.attribute if a.name == 'transB'), 0)
                axes.add(1 if tb else 0)
            elif n.op_type == 'Gather' and j == 0:
                axes.add(1)  # embedding table [V, D]: blocks run along D
            else:
                axes.add(None)
        if len(axes) == 1 and None not in axes:
            ax = axes.pop()
            if init.dims[ax] % block == 0:
                axis_for[name] = ax
    lo, hi = (-127, 127) if bits == 8 else (-8, 7)
    new_inits, new_nodes = [], []
    for name, ax in axis_for.items():
        w = numpy_helper.to_array(inits[name]).astype(np.float32)
        if ax == 0:
            r = w.reshape(w.shape[0] // block, block, w.shape[1])
            s = np.abs(r).max(1) / hi
            s[s == 0] = 1e-8
            q = np.clip(np.round(r / s[:, None, :]), lo, hi).reshape(w.shape)
        else:
            r = w.reshape(w.shape[0], w.shape[1] // block, block)
            s = np.abs(r).max(2) / hi
            s[s == 0] = 1e-8
            q = np.clip(np.round(r / s[:, :, None]), lo, hi).reshape(w.shape)
        if bits == 8:
            qt = numpy_helper.from_array(q.astype(np.int8), name + '_q')
        else:
            qt = helper.make_tensor(name + '_q', TensorProto.INT4, list(w.shape), pack_int4(q), raw=True)
        st = numpy_helper.from_array(s.astype(np.float32), name + '_s')
        new_inits += [qt, st]
        new_nodes.append(helper.make_node('DequantizeLinear', [name + '_q', name + '_s'], [name],
                                          axis=ax, block_size=block, name=name + '_dq'))
    keep = [i for i in g.initializer if i.name not in axis_for]
    del g.initializer[:]
    g.initializer.extend(keep + new_inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(new_nodes + nodes)
    ops = {o.domain: o for o in m.opset_import}
    if ops[''].version < 21:
        ops[''].version = 21
    m.ir_version = max(m.ir_version, 10)
    onnx.save(m, dst)
    return len(axis_for)


def write_chunked(path):
    size = os.path.getsize(path)
    parts = []
    if size > CHUNK:
        with open(path, 'rb') as f:
            i = 0
            while True:
                b = f.read(CHUNK)
                if not b:
                    break
                p = f'{path}.part{i}'
                open(p, 'wb').write(b)
                parts.append(os.path.basename(p))
                i += 1
        os.remove(path)
    return size, parts


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def fetch_hf(repo, out):
    local = snapshot_download(repo, allow_patterns=['*.json', '*.txt', '*.md', '*.safetensors', '*.model', 'vocab*', 'merges*', 'spm*'])
    files = sorted(os.listdir(local))
    log(f'  files: {files}')
    if not any(f.endswith('.safetensors') for f in files):
        local = snapshot_download(repo, allow_patterns=['*.json', '*.txt', '*.md', '*.bin', '*.model', 'vocab*', 'merges*', 'spm*'])
    for f in ('README.md', 'config.json', 'adapter_config.json'):
        p = os.path.join(local, f)
        if os.path.exists(p):
            txt = open(p, encoding='utf-8', errors='replace').read()
            log(f'  --- {f} (first 1500 chars)\n{txt[:1500]}')
            open(os.path.join(out, 'MODEL_CARD.md' if f == 'README.md' else f), 'w', encoding='utf-8').write(txt)
    return local


def onnx_export(wrapper, tok, path, output_name):
    enc = tok(['hello world, this is a test sentence for export.'] * 2, return_tensors='pt', padding=True)
    torch.onnx.export(wrapper, (enc['input_ids'], enc['attention_mask']), path,
                      input_names=['input_ids', 'attention_mask'], output_names=[output_name],
                      dynamic_axes={'input_ids': {0: 'batch', 1: 'seq'}, 'attention_mask': {0: 'batch', 1: 'seq'},
                                    output_name: {0: 'batch'}},
                      opset_version=17, do_constant_folding=True, dynamo=False)
    onnx.save(onnx.load(path), path)  # weights inline (torch may emit external data for big models)


def finish(spec, out, report):
    """Hash and chunk the ONNX files, write reference.json; drop weights when publish=False."""
    manifest = {}
    for f in sorted(os.listdir(out)):
        p = os.path.join(out, f)
        if f.endswith('.onnx'):
            report.setdefault('ops', {})[f] = ops_of(p)
            digest = sha256(p)
            if spec.get('publish', True):
                size, parts = write_chunked(p)
            else:
                size, parts = os.path.getsize(p), []
                os.remove(p)
            manifest[f] = dict(size=size, sha256=digest, parts=parts)
    report['files'] = manifest
    report['published'] = spec.get('publish', True)
    json.dump(report, open(os.path.join(out, 'reference.json'), 'w'))
    log(f'  ops: {report.get("ops")}')
    log(f'  wrote {out}: {sorted(os.listdir(out))}')


def export_detector(spec, out):
    key, repo = spec['key'], spec['repo']
    local = fetch_hf(repo, out)
    model, tok, base = load_model(spec, local)
    tok.save_pretrained(out)
    model.config.to_json_file(os.path.join(out, 'config.json'))
    n_params = sum(p.numel() for p in model.parameters())
    max_len = int(min(512, getattr(model.config, 'max_position_embeddings', 512) or 512, tok.model_max_length or 512))
    if getattr(model.config, 'model_type', '') == 'roberta':
        max_len = min(max_len, 512)  # 514 positions minus the padding offset
    log(f'  params={n_params / 1e6:.1f}M max_len={max_len} id2label={model.config.id2label} '
        f'tokenizer={tok.__class__.__name__} padding_side={tok.padding_side} truncation_side={tok.truncation_side}')
    n = spec.get('n_samples', len(SAMPLES))
    step = max(1, len(SAMPLES) // n)
    sample = SAMPLES[::step][:n]
    texts = [x['text'] for x in sample]
    labels = [x['label'] for x in sample]
    t0 = time.time()
    ref = torch_scores(model, tok, texts, max_len)
    log(f'  torch scored {len(texts)} texts in {time.time() - t0:.1f}s')
    p_ref = softmax(ref) if ref.shape[1] > 1 else 1 / (1 + np.exp(-ref))
    au = [auroc(p_ref[:, k], labels) for k in range(p_ref.shape[1])]
    ai_index = int(np.argmax(au))
    log(f'  AUROC per output index on Fast-DetectGPT samples: {au} -> AI index {ai_index}')
    fp32 = os.path.join(out, 'model_fp32.onnx')
    onnx_export(Wrap(model), tok, fp32, 'logits')
    report = dict(key=key, kind='detector', repo=repo, base=base, params=n_params, max_len=max_len, ai_index=ai_index,
                  n_outputs=int(ref.shape[1]), id2label={str(k): v for k, v in model.config.id2label.items()},
                  auroc_torch=au[ai_index], tokenizer_class=tok.__class__.__name__,
                  cls_id=tok.cls_token_id, sep_id=tok.sep_token_id, pad_id=tok.pad_token_id,
                  truncation_side=tok.truncation_side, variants={})
    for v in ['fp32'] + [x for x in spec['variants'] if x != 'fp32']:
        path = fp32 if v == 'fp32' else os.path.join(out, f'model_{v}.onnx')
        if v != 'fp32':
            nq = quantize_dq21(fp32, path, bits=8 if v == 'q8' else 4, block=64 if v == 'q8' else 32)
            log(f'  {v}: quantized {nq} weight tensors')
        sc, load_s, per_text = onnx_scores(path, tok, texts, max_len)
        p = softmax(sc) if sc.shape[1] > 1 else 1 / (1 + np.exp(-sc))
        d = np.abs(p[:, ai_index] - p_ref[:, ai_index])
        agree = float(((p[:, ai_index] > 0.5) == (p_ref[:, ai_index] > 0.5)).mean())
        rank_corr = float(np.corrcoef(np.argsort(np.argsort(p[:, ai_index])), np.argsort(np.argsort(p_ref[:, ai_index])))[0, 1])
        rep = dict(size_mb=os.path.getsize(path) / 1e6, load_s=load_s, ms_per_text=per_text * 1000,
                   max_abs_dprob=float(d.max()), mean_abs_dprob=float(d.mean()), decision_agreement=agree,
                   rank_corr=rank_corr, auroc=auroc(p[:, ai_index], labels), ai_prob=[round(float(x), 6) for x in p[:, ai_index]])
        log(f'  {v}: {rep["size_mb"]:.1f} MB load {load_s:.2f}s {rep["ms_per_text"]:.0f} ms/text | '
            f'max|dP| {rep["max_abs_dprob"]:.4f} mean {rep["mean_abs_dprob"]:.5f} agree {agree:.4f} '
            f'rank-corr {rank_corr:.4f} AUROC {rep["auroc"]:.4f}')
        report['variants'][v] = rep
    report['torch_ai_prob'] = [round(float(x), 6) for x in p_ref[:, ai_index]]
    report['sample_index'] = list(range(0, len(SAMPLES), step))[:n]
    report['token_ids'] = [tok(t, truncation=True, max_length=max_len)['input_ids'] for t in texts[:40]]
    if 'fp32' not in spec['variants']:
        os.remove(fp32)
    finish(spec, out, report)


def sentence_pairs():
    import re
    sents = []
    for x in SAMPLES[:120]:
        parts = [p.strip() for p in re.split(r'(?<=[.!?])\s+', x['text']) if len(p.split()) >= 6]
        sents += parts[:2]
    pairs = []
    for i in range(0, min(len(sents) - 1, 60), 2):
        pairs.append((sents[i], sents[i]))            # identical: entailment
        pairs.append((sents[i], sents[i + 1]))        # unrelated: neutral or contradiction
    pairs.append(('The loan was approved in March.', 'The loan was not approved in March.'))
    pairs.append(('GNPA fell to 1.5% in FY24.', 'GNPA rose to 1.5% in FY24.'))
    pairs.append(('We disbursed Rs 2,000 crore last year.', 'Last year we disbursed Rs 2,000 crore.'))
    return pairs


def export_nli(spec, out):
    key, repo = spec['key'], spec['repo']
    local = fetch_hf(repo, out)
    tok = AutoTokenizer.from_pretrained(local)
    model = AutoModelForSequenceClassification.from_pretrained(local).eval()
    tok.save_pretrained(out)
    model.config.to_json_file(os.path.join(out, 'config.json'))
    pairs = sentence_pairs()
    enc = [tok(a, b, truncation=True, max_length=512, return_tensors='pt') for a, b in pairs]
    ref = np.array([model(input_ids=e['input_ids'], attention_mask=e['attention_mask']).logits[0].float().numpy() for e in enc])
    fp32 = os.path.join(out, 'model_fp32.onnx')
    onnx_export(Wrap(model), tok, fp32, 'logits')
    labels = {str(k): v for k, v in model.config.id2label.items()}
    log(f'  id2label={labels} params={sum(p.numel() for p in model.parameters()) / 1e6:.1f}M')
    report = dict(key=key, kind='nli', repo=repo, id2label=labels, cls_id=tok.cls_token_id, sep_id=tok.sep_token_id,
                  pad_id=tok.pad_token_id, tokenizer_class=tok.__class__.__name__, variants={},
                  pairs=pairs[-3:], torch_probs=softmax(ref)[-3:].round(5).tolist(),
                  pair_token_ids=[tok(a, b)['input_ids'] for a, b in pairs[-3:]])
    for v in spec['variants']:
        path = os.path.join(out, f'model_{v}.onnx')
        quantize_dq21(fp32, path, bits=8, block=64)
        s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        got = np.array([s.run(None, {'input_ids': e['input_ids'].numpy().astype(np.int64),
                                     'attention_mask': e['attention_mask'].numpy().astype(np.int64)})[0][0] for e in enc])
        pr, pg = softmax(ref), softmax(got)
        rep = dict(size_mb=os.path.getsize(path) / 1e6, max_abs_dprob=float(np.abs(pr - pg).max()),
                   argmax_agreement=float((pr.argmax(1) == pg.argmax(1)).mean()), probs_last3=pg[-3:].round(5).tolist())
        log(f'  {v}: {rep}')
        report['variants'][v] = rep
    os.remove(fp32)
    finish(spec, out, report)


def export_embed(spec, out):
    from transformers import AutoModel
    key, repo = spec['key'], spec['repo']
    local = fetch_hf(repo, out)
    tok = AutoTokenizer.from_pretrained(local)
    model = AutoModel.from_pretrained(local).eval()
    tok.save_pretrained(out)
    model.config.to_json_file(os.path.join(out, 'config.json'))
    w = EmbedWrap(model)
    texts = [x['text'][:600] for x in SAMPLES[:40]]
    enc = [tok(t, truncation=True, max_length=256, return_tensors='pt') for t in texts]
    ref = np.array([w(e['input_ids'], e['attention_mask'])[0].numpy() for e in enc])
    fp32 = os.path.join(out, 'model_fp32.onnx')
    onnx_export(w, tok, fp32, 'embeddings')
    report = dict(key=key, kind='embed', repo=repo, dim=int(ref.shape[1]), cls_id=tok.cls_token_id, sep_id=tok.sep_token_id,
                  pad_id=tok.pad_token_id, max_len=256, tokenizer_class=tok.__class__.__name__, variants={},
                  probe_text=texts[0], probe_first8=ref[0][:8].round(6).tolist(), probe_token_ids=tok(texts[0], truncation=True, max_length=256)['input_ids'])
    for v in spec['variants']:
        path = os.path.join(out, f'model_{v}.onnx')
        quantize_dq21(fp32, path, bits=8, block=64)
        s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        got = np.array([s.run(None, {'input_ids': e['input_ids'].numpy().astype(np.int64),
                                     'attention_mask': e['attention_mask'].numpy().astype(np.int64)})[0][0] for e in enc])
        cos = (got * ref).sum(1)
        rep = dict(size_mb=os.path.getsize(path) / 1e6, min_cos_to_fp32=float(cos.min()), mean_cos_to_fp32=float(cos.mean()))
        log(f'  {v}: {rep}')
        report['variants'][v] = rep
    os.remove(fp32)
    finish(spec, out, report)


def export_github_onnx(spec, out):
    """A detector that ships its own ONNX file; record its I/O, ops and behaviour on the samples."""
    import shutil, subprocess
    from tokenizers import Tokenizer
    key, repo = spec['key'], spec['repo']
    src = os.path.join(OUT, '_src_' + key)
    subprocess.run(['git', 'clone', '--depth', '1', repo, src], check=True)
    head = subprocess.run(['git', '-C', src, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    for root, _, fs in os.walk(src):
        if '.git' in root:
            continue
        for f in fs:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, src)
            log(f'  file {rel} {os.path.getsize(p) / 1e6:.2f} MB')
            if f.endswith(('.py', '.md', '.json', '.txt', '.cfg', '.toml')) and os.path.getsize(p) < 200_000 and 'tokenizer.json' not in f:
                log(f'  ----- {rel} -----\n{open(p, encoding="utf-8", errors="replace").read()[:6000]}')
    mdir = os.path.dirname(os.path.join(src, spec['onnx']))
    dst = os.path.join(out, 'model_q8.onnx')
    shutil.copyfile(os.path.join(src, spec['onnx']), dst)
    for f in os.listdir(mdir):
        if f.endswith('.json') or f.endswith('.txt'):
            shutil.copyfile(os.path.join(mdir, f), os.path.join(out, f))
    lic = os.path.join(src, 'LICENSE')
    if os.path.exists(lic):
        shutil.copyfile(lic, os.path.join(out, 'LICENSE'))
    readme = os.path.join(src, 'README.md')
    if os.path.exists(readme):
        shutil.copyfile(readme, os.path.join(out, 'MODEL_CARD.md'))
    s = ort.InferenceSession(dst, providers=['CPUExecutionProvider'])
    ins = [(i.name, i.shape, i.type) for i in s.get_inputs()]
    outs = [(o.name, o.shape, o.type) for o in s.get_outputs()]
    log(f'  inputs {ins} outputs {outs}')
    tok = Tokenizer.from_file(os.path.join(out, 'tokenizer.json'))
    tok.no_padding()
    tok.enable_truncation(512)
    texts = [x['text'] for x in SAMPLES]
    labels = [x['label'] for x in SAMPLES]
    rows = []
    for t in texts:
        e = tok.encode(t)
        feed = {}
        for name, _, _ in ins:
            if 'mask' in name:
                feed[name] = np.array([e.attention_mask], dtype=np.int64)
            elif 'type' in name:
                feed[name] = np.zeros((1, len(e.ids)), dtype=np.int64)
            else:
                feed[name] = np.array([e.ids], dtype=np.int64)
        rows.append(np.asarray(s.run(None, feed)[0]).reshape(-1))
    sc = np.array(rows)
    au = [auroc(sc[:, k], labels) for k in range(sc.shape[1])]
    margin = sc[:, -1] - sc[:, 0] if sc.shape[1] > 1 else sc[:, 0]
    log(f'  raw output dims {sc.shape} AUROC per raw output {au}; AUROC of last-first margin {auroc(margin, labels)}')
    report = dict(key=key, kind='detector', repo=repo, commit=head, inputs=[i[0] for i in ins], outputs=[o[0] for o in outs],
                  n_outputs=int(sc.shape[1]), auroc_raw=au, auroc_margin=auroc(margin, labels),
                  cls_id=tok.token_to_id('<s>') if tok.token_to_id('<s>') is not None else tok.token_to_id('[CLS]'),
                  sep_id=tok.token_to_id('</s>') if tok.token_to_id('</s>') is not None else tok.token_to_id('[SEP]'),
                  raw_first5=sc[:5].round(5).tolist(), token_ids=[tok.encode(t).ids for t in texts[:40]],
                  variants={'q8': dict(size_mb=os.path.getsize(dst) / 1e6, auroc=max(au))})
    shutil.rmtree(src, ignore_errors=True)
    finish(spec, out, report)


def export(spec):
    out = os.path.join(OUT, spec['key'])
    os.makedirs(out, exist_ok=True)
    log(f'\n===== {spec["key"]} ({spec["repo"]})')
    kind = spec.get('kind', 'detector')
    {'detector': export_detector, 'nli': export_nli, 'embed': export_embed, 'github-onnx': export_github_onnx}[kind](spec, out)


def main():
    os.makedirs(OUT, exist_ok=True)
    log(f'torch {torch.__version__} onnx {onnx.__version__} onnxruntime {ort.__version__}')
    only = [k for k in os.environ.get('ONLY', '').split(',') if k.strip()]
    for r in PROBES:
        probe(r)
    ok = True
    for spec in MODELS:
        if only and spec['key'] not in only:
            continue
        try:
            export(spec)
        except Exception:  # noqa: BLE001
            ok = False
            log(f'!!! {spec["key"]} failed:\n{traceback.format_exc()}')
            import shutil
            shutil.rmtree(os.path.join(OUT, spec['key']), ignore_errors=True)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
