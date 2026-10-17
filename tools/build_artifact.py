"""Assemble the publishable Answer Rewrite Desk into dist/ (or the folder given as the first argument).

    python3 tools/build_artifact.py [OUT]           # for a claude.ai artifact (the host adds the page skeleton)
    python3 tools/build_artifact.py [OUT] --site    # standalone static site, e.g. GitHub Pages

Inputs: ai-checker/ (page, app, workers, detectors, vendor), the exported models from the
claude/ai-checker-models branch (MODELS_DIR), the onnxruntime-web and @huggingface/tokenizers
npm packages (NPM_DIR), and ai-checker/calibration.json.
Model files are split into parts of at most 14 MiB because artifact files are capped at 15 MB.
"""
import hashlib, json, os, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_specs import model_spec  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'ai-checker')
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
SITE = '--site' in sys.argv[1:]
OUT = os.path.abspath(ARGS[0] if ARGS else os.path.join(ROOT, 'dist'))
MODELS_DIR = os.environ.get('MODELS_DIR', '/home/user/work/models')
NPM_DIR = os.environ.get('NPM_DIR', '/home/user/work/npm')


def pkg(name, legacy):
    """An npm package: node_modules/<name> (npm ci with package.json), else the older unpacked tarball layout."""
    nm = os.path.join(ROOT, 'node_modules', name)
    return nm if os.path.exists(nm) else os.path.join(NPM_DIR, legacy, 'package')


ORT_PKG, TOK_PKG, HARPER_PKG = pkg('onnxruntime-web', 'ort'), pkg('@huggingface/tokenizers', 'hft'), pkg('harper.js', 'harper')
WEBLLM_PKG = pkg('@mlc-ai/web-llm', 'web-llm')
CALIB = os.environ.get('CALIB', os.path.join(SRC, 'calibration.json'))
PART = 14 * 1024 * 1024

DEFAULT_MODELS = ['bert-tiny-raid', 'e5-small-lora', 'modernbert-raid-mage', 'fakespot-roberta', 'tabularis-modernbert',
                  'sallulabs-minilm', 'nli-deberta-xsmall', 'minilm-l6']
INCLUDE = [k for k in os.environ.get('INCLUDE', ','.join(DEFAULT_MODELS)).split(',') if k]
SITE_WARN_MB, SITE_MAX_MB = 700, 900  # GitHub Pages sites are capped at 1 GB


def copy(src, rel):
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


# The artifact host wraps the page in a document with this reset; a standalone site has to supply it.
SITE_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Check an answer with four open-source AI-text detectors in your browser and rewrite the sentences they flag, with a fact check before anything changes.">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230E5D6B'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
"""


def write_site_page():
    """index.html for a static host: the page's title, fonts and styles go in <head>, the rest in <body>."""
    page = open(os.path.join(SRC, 'index.html'), encoding='utf-8').read()
    cut = page.index('</style>') + len('</style>')
    head, body = page[:cut], page[cut:]
    assert '<div' not in head and '<script' not in head, 'index.html should start with its title, links and style'
    with open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(SITE_HEAD + head.strip() + '\n</head>\n<body>\n' + body.strip() + '\n</body>\n</html>\n')
    open(os.path.join(OUT, '.nojekyll'), 'w').close()  # serve files as they are, no Jekyll build
    copy(os.path.join(SRC, 'site', 'README.md'), 'README.md')
    copy(os.path.join(SRC, 'site', 'MIT.txt'), 'LICENSES/MIT.txt')
    copy(os.path.join(TOK_PKG, 'LICENSE'), 'LICENSES/Apache-2.0.txt')


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for rel in ['app.mjs', 'workers/models.mjs', 'workers/zippy.js', 'workers/grammar.mjs', 'detectors/zippy.js',
                'vendor/lzma_worker-min.js', 'vendor/zippy-ai-generated.txt', 'vendor/NOTICE.md']:
        copy(os.path.join(SRC, rel), rel)
    for dp, _, fs in os.walk(os.path.join(SRC, 'src')):  # page modules (plain ES modules)
        for f in fs:
            if f.endswith('.mjs'):
                copy(os.path.join(dp, f), os.path.relpath(os.path.join(dp, f), SRC))
    if SITE:
        write_site_page()
    else:
        copy(os.path.join(SRC, 'index.html'), 'index.html')
    ort = os.path.join(ORT_PKG, 'dist')
    for f in ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']:
        copy(os.path.join(ort, f), f'vendor/{f}')
    copy(os.path.join(TOK_PKG, 'dist/tokenizers.min.mjs'), 'vendor/tokenizers.min.mjs')
    # Harper grammar checker (harper.js): the ES modules and the slim WASM binary
    hdist = os.path.join(HARPER_PKG, 'dist')
    for f in sorted(os.listdir(hdist)):
        if f in ('index.js', 'slimBinary.js', 'harper_wasm_slim_bg.wasm') or f.startswith('BinaryModule-'):
            copy(os.path.join(hdist, f), f'vendor/harper/{f}')
    copy(os.path.join(HARPER_PKG, 'LICENSE'), 'vendor/harper/LICENSE')
    # WebLLM (in-browser rewriter): one self-contained ES module, loaded by workers/llm.mjs
    copy(os.path.join(WEBLLM_PKG, 'lib/index.js'), 'vendor/web-llm/index.js')
    copy(os.path.join(WEBLLM_PKG, 'LICENSE'), 'vendor/web-llm/LICENSE')
    manifest ={'models': {}, 'calibration': json.load(open(CALIB)) if os.path.exists(CALIB) else None}
    for key in INCLUDE:
        d = os.path.join(MODELS_DIR, key)
        if not os.path.exists(os.path.join(d, 'reference.json')):
            print(f'warning: {key} is not in {MODELS_DIR}; left out')
            continue
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
        copy(os.path.join(d, 'tokenizer.json'), f'models/{key}/tokenizer.json')
        tc = os.path.join(d, 'tokenizer_config.json')
        if os.path.exists(tc):
            copy(tc, f'models/{key}/tokenizer_config.json')
        else:
            with open(os.path.join(OUT, 'models', key, 'tokenizer_config.json'), 'w') as f:
                f.write('{}')
        manifest['models'][key] = dict(size=len(data), sha256=meta['sha256'], parts=parts, **model_spec(key, ref))
    with open(os.path.join(OUT, 'models', 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    total, count = 0, 0
    for dp, _, fs in os.walk(OUT):
        for name in fs:
            p = os.path.join(dp, name)
            size = os.path.getsize(p)
            total += size
            count += 1
            limit = 50_000_000 if SITE else 15_000_000  # artifacts cap files at 15 MB; keep site files far below GitHub's 100 MB
            if size > limit:
                raise SystemExit(f'{p} is over the {limit // 1_000_000} MB per-file limit')
    print(f'{OUT}: {count} files, {total / 1e6:.1f} MB')
    if SITE and total / 1e6 > SITE_MAX_MB:
        raise SystemExit(f'site is {total / 1e6:.0f} MB, over the {SITE_MAX_MB} MB budget (GitHub Pages limit 1 GB)')
    if SITE and total / 1e6 > SITE_WARN_MB:
        print(f'warning: site is {total / 1e6:.0f} MB, over the {SITE_WARN_MB} MB target')


if __name__ == '__main__':
    main()
