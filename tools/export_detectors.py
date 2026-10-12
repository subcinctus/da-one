"""Download open-source AI-text detectors, export them to ONNX and quantize them for the browser.

Run by .github/workflows/fetch-detector-models.yml (the build sandbox cannot reach Hugging Face).
For every model it writes, under out/<key>/:
  model_q8.onnx        int8 block-quantized weights (DequantizeLinear-21), fp32 compute
  model_q4.onnx        int4 variant (only where requested)
  tokenizer files, config.json, the model card, and reference.json with PyTorch vs ONNX scores
Files above 45 MB are split into .partN chunks (GitHub rejects files over 100 MB).
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
]
PROBES = ['tabularisai/ai-text-detection', 'mohamedmady/deberta-conpara', 'Oxidane/tmr-ai-text-detector',
          'Lindarixon/Linda-RAID', 'Shushant/ADAL-detector-large', 'desklib/ai-text-detector-v1.01',
          'MayZhou/e5-small-lora-ai-generated-detector', 'ShantanuT01/BERT-tiny-RAID',
          'GeorgeDrayson/modernbert-ai-detection-raid-mage']


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


def export(spec):
    key, repo = spec['key'], spec['repo']
    out = os.path.join(OUT, key)
    os.makedirs(out, exist_ok=True)
    log(f'\n===== {key} ({repo})')
    local = snapshot_download(repo, allow_patterns=['*.json', '*.txt', '*.md', '*.safetensors', '*.model', 'vocab*', 'merges*'])
    files = sorted(os.listdir(local))
    log(f'  files: {files}')
    if not any(f.endswith('.safetensors') for f in files):
        local = snapshot_download(repo, allow_patterns=['*.json', '*.txt', '*.md', '*.bin', '*.model', 'vocab*', 'merges*'])
    for f in ('README.md', 'config.json', 'adapter_config.json'):
        p = os.path.join(local, f)
        if os.path.exists(p):
            txt = open(p, encoding='utf-8', errors='replace').read()
            log(f'  --- {f} (first 1500 chars)\n{txt[:1500]}')
            open(os.path.join(out, 'MODEL_CARD.md' if f == 'README.md' else f), 'w', encoding='utf-8').write(txt)
    model, tok, base = load_model(spec, local)
    tok.save_pretrained(out)
    model.config.to_json_file(os.path.join(out, 'config.json'))
    n_params = sum(p.numel() for p in model.parameters())
    max_len = int(min(512, getattr(model.config, 'max_position_embeddings', 512) or 512, tok.model_max_length or 512))
    log(f'  params={n_params / 1e6:.1f}M max_len={max_len} id2label={model.config.id2label} '
        f'tokenizer={tok.__class__.__name__} padding_side={tok.padding_side} truncation_side={tok.truncation_side}')

    texts = [s['text'] for s in SAMPLES]
    labels = [s['label'] for s in SAMPLES]
    t0 = time.time()
    ref = torch_scores(model, tok, texts, max_len)
    log(f'  torch scored {len(texts)} texts in {time.time() - t0:.1f}s')
    p_ref = softmax(ref)
    au = [auroc(p_ref[:, k], labels) for k in range(p_ref.shape[1])]
    ai_index = int(np.argmax(au))
    log(f'  AUROC per output index on Fast-DetectGPT samples: {au} -> AI index {ai_index}')

    fp32 = os.path.join(out, 'model_fp32.onnx')
    enc = tok(['hello world, this is a test sentence for export.'] * 2, return_tensors='pt', padding=True)
    torch.onnx.export(Wrap(model), (enc['input_ids'], enc['attention_mask']), fp32,
                      input_names=['input_ids', 'attention_mask'], output_names=['logits'],
                      dynamic_axes={'input_ids': {0: 'batch', 1: 'seq'}, 'attention_mask': {0: 'batch', 1: 'seq'},
                                    'logits': {0: 'batch'}},
                      opset_version=17, do_constant_folding=True, dynamo=False)
    # re-save with weights inline (torch may emit external data for big models)
    onnx.save(onnx.load(fp32), fp32)
    report = dict(key=key, repo=repo, base=base, params=n_params, max_len=max_len, ai_index=ai_index,
                  id2label={str(k): v for k, v in model.config.id2label.items()}, auroc_torch=au[ai_index],
                  tokenizer_class=tok.__class__.__name__, truncation_side=tok.truncation_side, variants={})
    for v in ['fp32'] + [x for x in spec['variants'] if x != 'fp32']:
        path = fp32 if v == 'fp32' else os.path.join(out, f'model_{v}.onnx')
        if v != 'fp32':
            nq = quantize_dq21(fp32, path, bits=8 if v == 'q8' else 4, block=64 if v == 'q8' else 32)
            log(f'  {v}: quantized {nq} weight tensors')
        sc, load_s, per_text = onnx_scores(path, tok, texts, max_len)
        p = softmax(sc)
        d = np.abs(p[:, ai_index] - p_ref[:, ai_index])
        agree = float(((p[:, ai_index] > 0.5) == (p_ref[:, ai_index] > 0.5)).mean())
        rep = dict(size_mb=os.path.getsize(path) / 1e6, load_s=load_s, ms_per_text=per_text * 1000,
                   max_abs_dprob=float(d.max()), mean_abs_dprob=float(d.mean()), decision_agreement=agree,
                   auroc=auroc(p[:, ai_index], labels), ai_prob=[round(float(x), 6) for x in p[:, ai_index]])
        log(f'  {v}: {rep["size_mb"]:.1f} MB load {load_s:.2f}s {rep["ms_per_text"]:.0f} ms/text | '
            f'max|dP| {rep["max_abs_dprob"]:.4f} mean {rep["mean_abs_dprob"]:.5f} agree {agree:.4f} AUROC {rep["auroc"]:.4f}')
        report['variants'][v] = rep
    report['torch_ai_prob'] = [round(float(x), 6) for x in p_ref[:, ai_index]]
    report['token_ids'] = [tok(t, truncation=True, max_length=max_len)['input_ids'] for t in texts[:40]]
    if 'fp32' not in spec['variants']:
        os.remove(fp32)
    manifest = {}
    for f in sorted(os.listdir(out)):
        p = os.path.join(out, f)
        if f.endswith('.onnx'):
            digest = sha256(p)
            size, parts = write_chunked(p)
            manifest[f] = dict(size=size, sha256=digest, parts=parts)
    report['files'] = manifest
    json.dump(report, open(os.path.join(out, 'reference.json'), 'w'))
    log(f'  wrote {out}: {sorted(os.listdir(out))}')


def main():
    os.makedirs(OUT, exist_ok=True)
    log(f'torch {torch.__version__} onnx {onnx.__version__} onnxruntime {ort.__version__}')
    for r in PROBES:
        probe(r)
    ok = True
    for spec in MODELS:
        try:
            export(spec)
        except Exception:  # noqa: BLE001
            ok = False
            log(f'!!! {spec["key"]} failed:\n{traceback.format_exc()}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
