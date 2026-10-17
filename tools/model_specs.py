"""Manifest entries for the ONNX models: what the browser worker (and the calibration scorer) need
to tokenise, run and read each one. Specs come from each model's reference.json, written by
tools/export_detectors.py; the first three models predate those fields, so their token ids are here."""

LEGACY = {
    'bert-tiny-raid': dict(cls_id=101, sep_id=102, output='sigmoid_human'),
    'e5-small-lora': dict(cls_id=101, sep_id=102, output='softmax'),
    'modernbert-raid-mage': dict(cls_id=50281, sep_id=50282, output='softmax'),
    # trained on 256-token windows (its reference code); exported before max_len was recorded
    'sallulabs-minilm': dict(max_len=256),
}


def model_spec(key, ref):
    """Manifest entry for one model: what the worker needs to tokenise, run and read it."""
    kind = ref.get('kind', 'detector')
    spec = dict(kind=kind, repo=ref.get('repo'), max_len=ref.get('max_len', 512))
    for k in ('cls_id', 'sep_id', 'pad_id'):
        if ref.get(k) is not None:
            spec[k] = ref[k]
    if kind == 'detector':
        n = ref.get('n_outputs', 2)
        if 'auroc_raw' in ref:  # a detector that shipped its own ONNX: the AI class is the output that ranks AI highest
            spec['ai_index'] = int(max(range(len(ref['auroc_raw'])), key=lambda i: ref['auroc_raw'][i]))
        else:
            spec['ai_index'] = ref.get('ai_index', 1)
        spec['output'] = 'softmax' if n > 1 else 'sigmoid'
    elif kind == 'nli':
        spec['labels'] = {int(k): v.lower() for k, v in ref['id2label'].items()}
    elif kind == 'embed':
        spec['dim'] = ref.get('dim')
    spec.update(LEGACY.get(key, {}))
    return spec
