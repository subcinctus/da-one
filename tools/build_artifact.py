"""Assemble the publishable Answer Rewrite Desk into dist/ (or the folder given as argv[1]).

Inputs: ai-checker/ (page, app, workers, detectors, vendor), the exported models from the
claude/ai-checker-models branch (MODELS_DIR), the onnxruntime-web and @huggingface/tokenizers
npm packages (NPM_DIR), and ai-checker/calibration.json.
Model files are split into parts of at most 14 MiB because artifact files are capped at 15 MB.
"""
import hashlib, json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'ai-checker')
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist'))
MODELS_DIR = os.environ.get('MODELS_DIR', '/home/user/work/models')
NPM_DIR = os.environ.get('NPM_DIR', '/home/user/work/npm')
CALIB = os.environ.get('CALIB', os.path.join(SRC, 'calibration.json'))
PART = 14 * 1024 * 1024

MODELS = {
    'bert-tiny-raid': dict(cls_id=101, sep_id=102, output='sigmoid_human'),
    'e5-small-lora': dict(cls_id=101, sep_id=102, output='softmax'),
    'modernbert-raid-mage': dict(cls_id=50281, sep_id=50282, output='softmax'),
}


def copy(src, rel):
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for rel in ['index.html', 'app.mjs', 'workers/models.mjs', 'workers/zippy.js', 'detectors/zippy.js',
                'vendor/lzma_worker-min.js', 'vendor/zippy-ai-generated.txt']:
        copy(os.path.join(SRC, rel), rel)
    ort = os.path.join(NPM_DIR, 'ort/package/dist')
    for f in ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']:
        copy(os.path.join(ort, f), f'vendor/{f}')
    copy(os.path.join(NPM_DIR, 'hft/package/dist/tokenizers.min.mjs'), 'vendor/tokenizers.min.mjs')
    manifest = {'models': {}, 'calibration': json.load(open(CALIB)) if os.path.exists(CALIB) else None}
    for key, extra in MODELS.items():
        d = os.path.join(MODELS_DIR, key)
        ref = json.load(open(os.path.join(d, 'reference.json')))
        meta = ref['files']['model_q8.onnx']
        src_parts = meta['parts'] or ['model_q8.onnx']
        data = b''.join(open(os.path.join(d, p), 'rb').read() for p in src_parts)
        assert len(data) == meta['size'] and hashlib.sha256(data).hexdigest() == meta['sha256'], key
        os.makedirs(os.path.join(OUT, 'models', key), exist_ok=True)
        parts = []
        for i in range(0, len(data), PART):
            name = f'model-{len(parts)}.wasm'  # served as a binary type; the worker only reads the bytes
            with open(os.path.join(OUT, 'models', key, name), 'wb') as f:
                f.write(data[i:i + PART])
            parts.append(name)
        for f in ['tokenizer.json', 'tokenizer_config.json']:
            copy(os.path.join(d, f), f'models/{key}/{f}')
        manifest['models'][key] = dict(size=len(data), sha256=meta['sha256'], parts=parts, repo=ref['repo'], **extra)
    with open(os.path.join(OUT, 'models', 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    total, count = 0, 0
    for dp, _, fs in os.walk(OUT):
        for name in fs:
            p = os.path.join(dp, name)
            size = os.path.getsize(p)
            total += size
            count += 1
            if size > 15_000_000:
                raise SystemExit(f'{p} is over the 15 MB per-file limit')
    print(f'{OUT}: {count} files, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
