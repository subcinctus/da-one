"""Build the calibration pool: professional human writing, non-native human writing, and AI text from
2024-26 generators (generated, polished, rewritten and "humanized"), as JSON lines.

    python3 tools/calib/build_pool.py OUT.jsonl

Run in GitHub Actions (needs github raw files and the Hugging Face hub). Every source is optional: a
source that fails to download is logged and skipped, and the summary at the end shows what went in.
Each row: {id, text, label (0 human / 1 AI / -1 grey), group, src, gen, task, gkey, split, win}.
  group: prof (professional human) | nonnative | essay | web | legacy | indomain | grey
  split: cal | test (70/30 by a hash of the origin key, so every derivative of one human text stays
         together); Human Detectors is held out entirely (split test, group heldout).
  win:   also score 3-sentence windows (a subsample, for the sentence highlights).
Licences differ by source (see tools/calib/README.md); several are non-commercial, which is fine for
this personal tool. Texts never leave the private calibration branch.
"""
import ast, collections, csv, hashlib, io, json, os, random, re, sys, traceback, urllib.request

random.seed(20261017)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'pool.jsonl'
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = 'https://raw.githubusercontent.com'
MAX_WORDS, MIN_WORDS = 700, 150
rows, seen = [], set()
log = lambda *a: print(*a, flush=True)


def fetch(url, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def nwords(t):
    return len(t.split())


def clip(t):
    """At most MAX_WORDS words, cut at a sentence end where possible."""
    w = t.split()
    if len(w) <= MAX_WORDS:
        return t.strip()
    cut = ' '.join(w[:MAX_WORDS])
    m = max(cut.rfind('. '), cut.rfind('? '), cut.rfind('! '))
    return (cut[:m + 1] if m > len(cut) // 2 else cut).strip()


def add(text, label, group, src, gen='human', task='human', gkey=None, min_words=MIN_WORDS, split=None, extra=None):
    if not isinstance(text, str):
        return False
    t = re.sub(r'^\s*(here(\'s| is) (a|the) [^\n]*:\s*)', '', text.strip(), flags=re.I)  # strip LLM preambles
    if nwords(t) < min_words:
        return False
    t = clip(t)
    key = re.sub(r'\W+', '', t.lower())[:300]
    if key in seen:
        return False
    seen.add(key)
    g = gkey or key
    sp = split or ('test' if int(hashlib.sha1(str(g).encode()).hexdigest(), 16) % 10 >= 7 else 'cal')
    rows.append(dict(id=f'{src}-{len(rows)}', text=t, label=label, group=group, src=src, gen=gen, task=task, gkey=str(g)[:200], split=sp, **(extra or {})))
    return True


def source(name):
    def deco(fn):
        def run():
            n0 = len(rows)
            try:
                fn()
            except Exception:  # noqa: BLE001
                log(f'!! {name} failed:\n{traceback.format_exc(limit=3)}')
            log(f'{name}: +{len(rows) - n0} rows')
        run.__name__ = name
        return run
    return deco


def take(items, n):
    items = list(items)
    random.shuffle(items)
    return items[:n]


# ---------- MIRAGE (DetectAnyLLM): human originals + 17 LLMs x generate / polish / rewrite ----------
MIRAGE = f'{RAW}/fjc2005/DetectAnyLLM/main/data/MIRAGE_BENCH/DIG'
FORMAL = {'formal', 'expository', 'objective', 'academic', 'journalistic', 'original'}


@source('mirage')
def mirage():
    originals = {}
    for task, per_model in (('generate', 15), ('polish', 12), ('rewrite', 12)):
        data = json.loads(fetch(f'{MIRAGE}/{task}.json'))
        by_model = collections.defaultdict(list)
        for r in data:
            m = re.search(r' in an? (\w+) style', r.get('prompt') or '')
            if (m.group(1) if m else None) not in FORMAL:
                continue
            by_model[r['model']].append(r)
            if r.get('domain') in ('email', 'academic', 'news', 'website'):
                originals.setdefault(r['original'], r.get('domain'))
        for model, rs in by_model.items():
            for r in take(rs, per_model):
                add(r['rewritten'], 1, 'ai', 'mirage', gen=model, task=task, gkey=r['original'], min_words=100)
    # human originals: Enron emails first (business register), then academic and news
    pick = take([o for o, d in originals.items() if d == 'email'], 250) + take([o for o, d in originals.items() if d != 'email'], 200)
    for o in pick:
        add(o, 0, 'prof', 'mirage', gkey=o, min_words=120)


# ---------- SlopBench (sloptotal): 2026 generators, humanized and paraphrased hard cases ----------
SLOP = f'{RAW}/pablocaeg/sloptotal/master/tests/eval/slopbench/corpus'


def jsonl(url):
    return [json.loads(l) for l in fetch(url).decode('utf-8').splitlines() if l.strip()]


@source('slopbench')
def slopbench():
    for src in ('qa-stackexchange', 'news-ccnews', 'news-bbc', 'news-wikinews', 'encyclopedia-wikipedia', 'academic-arxiv'):
        for r in take(jsonl(f'{SLOP}/human-{src}.jsonl'), 45):
            add(r['text'], 0, 'prof', 'slopbench', gkey=r.get('id'))
        for r in take(jsonl(f'{SLOP}/ai-{src}.jsonl'), 35):
            add(r['text'], 1, 'ai', 'slopbench', gen=r.get('model', '?'), task='generate', gkey=r.get('pair') or r.get('id'))
    for r in take(jsonl(f'{SLOP}/hard-ai-humanized.jsonl'), 150):
        add(r['text'], 1, 'ai', 'slopbench', gen=r.get('model', '?'), task='humanized', gkey=r.get('base') or r.get('id'))
    for r in take(jsonl(f'{SLOP}/hard-ai-paraphrased.jsonl'), 100):
        add(r['text'], 1, 'ai', 'slopbench', gen=r.get('model', '?'), task='rewrite', gkey=r.get('base') or r.get('id'))
    for r in take(jsonl(f'{SLOP}/hard-human-ai-polished.jsonl'), 100):
        add(r['text'], -1, 'grey', 'slopbench', gen=r.get('model', '?'), task='polish-human', gkey=r.get('base') or r.get('id'))


# ---------- Non-native and student essays ----------
LIANG = f'{RAW}/Weixin-Liang/ChatGPT-Detector-Bias/main/Data_and_Results/Human_Data'


@source('liang')
def liang():
    for path, group, mw in (('TOEFL_real_91', 'nonnative', 50), ('HewlettStudentEssay_real_88', 'essay', 100), ('CollegeEssay_real_70', 'essay', 100)):
        for x in json.loads(fetch(f'{LIANG}/{path}/data.json')):
            add(x['document'], 0, group, f'liang-{path.split("_")[0].lower()}', min_words=mw)


@source('ellipse')
def ellipse():
    data = list(csv.DictReader(io.StringIO(fetch(f'{RAW}/scrosseye/ELLIPSE-Corpus/main/ELLIPSE_Final_github_train.csv').decode('utf-8', 'replace'))))
    for r in take(data, 300):
        add(r.get('full_text', ''), 0, 'nonnative', 'ellipse')


# ---------- Beemo: human answers, LLM output, GPT-4o "make it sound human" edits ----------
@source('beemo')
def beemo():
    import pandas as pd
    df = pd.read_parquet(io.BytesIO(fetch(f'{RAW}/Toloka/beemo/main/dataset.parquet')))
    df = df[df['category'].isin(['Generation', 'Rewrite', 'Open QA'])]
    n = collections.Counter()  # its LLM outputs are 2023-24 models, so keep them few; the GPT-4o edits matter most
    for _, r in df.sample(frac=1, random_state=7).iterrows():
        if n['human'] < 100 and add(r['human_output'], 0, 'web', 'beemo', gkey=r['prompt_id'], min_words=120):
            n['human'] += 1
        if n['model'] < 60 and add(r['model_output'], 1, 'ai', 'beemo', gen=r['model'], task='generate', gkey=r['prompt_id'], min_words=120):
            n['model'] += 1
        try:
            edits = ast.literal_eval(r['gpt-4o_edits'])
        except Exception:  # noqa: BLE001
            continue
        for e in edits:
            for k in ('P1', 'P3'):
                if k in e and n['edit'] < 120 and add(e[k], 1, 'ai', 'beemo', gen='gpt-4o', task='humanized', gkey=r['prompt_id'], min_words=120):
                    n['edit'] += 1


# ---------- Hugging Face sources (need the hub) ----------
def hf_file(repo, filename, revision=None):
    from huggingface_hub import hf_hub_download
    return hf_hub_download(repo, filename, repo_type='dataset', revision=revision, token=os.environ.get('HF_TOKEN') or None)


@source('hc3-finance')
def hc3():
    with open(hf_file('Hello-SimpleAI/HC3', 'finance.jsonl'), encoding='utf-8') as f:
        data = [json.loads(l) for l in f if l.strip()]
    n = 0
    for r in take(data, len(data)):
        for h in r.get('human_answers') or []:
            if add(h, 0, 'prof', 'hc3-finance', gkey=r.get('question')):
                n += 1
        if n >= 150:
            break


@source('edgar')
def edgar():
    n = 0
    for year in ('2019', '2018'):
        path = hf_file('eloukas/edgar-corpus', f'{year}/test.jsonl')
        with open(path, encoding='utf-8') as f:
            for line in f:
                r = json.loads(line)
                s = r.get('section_7') or ''
                if len(s.split()) < 500:
                    continue
                paras = [p.strip() for p in re.split(r'\n\s*\n|\n', s) if 60 <= len(p.split()) <= 400]
                paras = [p for p in paras if sum(ch.isdigit() for ch in p) / max(1, len(p)) < 0.08]
                for p in take(paras, 2):
                    if add(p, 0, 'prof', 'edgar', gkey=r.get('cik'), min_words=120):
                        n += 1
                if n >= 250:
                    return


@source('maga')
def maga():
    from datasets import load_dataset
    ds = load_dataset('anyangsong/MAGA', 'MGB', split='validation').to_pandas()
    for _, r in ds.sample(frac=1, random_state=3).iterrows():
        human = r['model'] == 'human'
        add(r['text'], 0 if human else 1, 'web' if human else 'ai', 'maga', gen=r['model'], task='human' if human else 'generate',
            gkey=r.get('human_source_id'))
        if sum(1 for x in rows if x['src'] == 'maga') >= 220:
            break


@source('llmtrace')
def llmtrace():
    from datasets import load_dataset
    ds = load_dataset('iitolstykh/LLMTrace_classification', split='test')
    ds = ds.filter(lambda r: r['lang'] == 'eng' and r['data_type'] in ('article', 'news', 'question', 'paper_abstract'))
    for r in ds.shuffle(seed=5).select(range(min(1500, len(ds)))):
        human = r['label'] == 'human'
        add(r['text'], 0 if human else 1, 'web' if human else 'ai', 'llmtrace', gen=r.get('model') or 'human',
            task='human' if human else 'generate', gkey=r.get('topic_id'))
        if sum(1 for x in rows if x['src'] == 'llmtrace') >= 220:
            break


@source('dactyl')
def dactyl():
    from datasets import load_dataset
    ds = load_dataset('ShantanuT01/DACTYL', split='test').shuffle(seed=9)
    n = 0
    for r in ds.select(range(min(4000, len(ds)))):
        if 'cpt' in str(r.get('model', '')).lower():
            continue
        human = int(r['target']) == 0
        if add(r['text'], 0 if human else 1, 'web' if human else 'ai', 'dactyl', gen=r.get('model') or 'human', task='human' if human else 'generate'):
            n += 1
        if n >= 160:
            break


# ---------- Held out entirely: Human Detectors (2024 articles; GPT-4o, Claude, o1-pro, paraphrased, humanized) ----------
@source('human-detectors')
def human_detectors():
    d = json.loads(fetch(f'{RAW}/jenna-russell/human_detectors/main/human_detectors.json'))
    for r in d.values():
        ai = r['ground_truth'] == 'AI-generated'
        g = r.get('generation_model', '?')
        task = 'humanized' if 'humanized' in g else 'rewrite' if 'paraphrased' in g else 'generate' if ai else 'human'
        ext = {}
        try:
            ext['pangram'] = float(ast.literal_eval(r['pangram'])['ai_likelihood'])
        except Exception:  # noqa: BLE001
            pass
        try:
            ext['gptzero'] = float(ast.literal_eval(r['gptzero'])['documents'][0]['class_probabilities']['ai'])
        except Exception:  # noqa: BLE001
            pass
        add(r['article'], int(ai), 'heldout', 'human-detectors', gen=g if ai else 'human', task=task, split='test', extra=ext)


# ---------- In the repository: legacy Fast-DetectGPT samples and in-domain AI answers ----------
@source('legacy-fdg')
def legacy():
    for x in json.load(open(os.path.join(os.path.dirname(HERE), 'sample_texts.json'))):
        add(x['text'], x['label'], 'legacy', 'fdg', gen='human' if x['label'] == 0 else 'gpt-3.5/4', task='human' if x['label'] == 0 else 'generate', min_words=80)


@source('in-domain')
def indomain():
    p = os.path.join(HERE, 'ai_answers_claude.jsonl')
    for line in open(p, encoding='utf-8'):
        r = json.loads(line)
        add(r['text'], 1, 'indomain', 'claude-answers', gen=r.get('gen', 'claude'), task=r.get('task', 'generate'), gkey=r.get('prompt'), min_words=120)


def main():
    for fn in (mirage, slopbench, liang, ellipse, beemo, hc3, edgar, maga, llmtrace, dactyl, human_detectors, legacy, indomain):
        fn()
    # window scoring for a subsample: calibration-split human texts of the professional kind, and AI texts
    prof = [r for r in rows if r['label'] == 0 and r['group'] in ('prof', 'web') and r['split'] == 'cal']
    ai = [r for r in rows if r['label'] == 1 and r['split'] == 'cal']
    win = {r['id'] for r in take(prof, 500) + take(ai, 400)}
    for r in rows:
        r['win'] = r['id'] in win
    with open(OUT, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    c = collections.Counter((r['label'], r['group'], r['split']) for r in rows)
    log('\nlabel group split -> n')
    for k in sorted(c, key=str):
        log(k, c[k])
    gens = collections.Counter(r['gen'] for r in rows if r['label'] == 1)
    log('\nAI generators:', len(gens), dict(gens.most_common(40)))
    log('tasks:', dict(collections.Counter(r['task'] for r in rows)))
    log(f'\n{len(rows)} rows, {sum(r["win"] for r in rows)} with windows -> {OUT}')


if __name__ == '__main__':
    main()
