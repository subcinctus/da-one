#!/usr/bin/env python3
"""Lint a rewritten section against its source.
Usage (from scratchpad root): python3 -I tools/lint.py out/01.md [out/02.md ...]
Source is taken from sections/<same name>. Checks: fixed structure lines unchanged,
stated count == computed count, computed count within limit, bracket deltas,
em dashes and banned phrases in answer prose."""
import re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'count.py')).read().split('for p in sys.argv')[0]
ns = {}; exec(_src, ns); analyse, clean = ns['analyse'], ns['clean']

FIXED = re.compile(r'^(# |\*\*Deadline|## |\*Limit|\*Question)')
BANNED = ['delve', 'tapestry', 'testament', 'journey', 'passion', 'passionate', 'navigate', 'navigating',
          'foster', 'leverage', 'robust', 'pivotal', 'crucial', 'realm', 'landscape', 'insurmountable',
          'not just', 'kept me up', 'never forget', 'everything changed', 'visionary', 'uniquely',
          'truly', 'deeply', 'profound', 'ignite', 'unwavering', 'resonate', 'embark', 'invaluable',
          'game-changer', 'dream of', 'thrive', 'holistic', 'synergy', 'seamless']
COUNT = re.compile(r'^\*([\d,]+) (words|characters)')

def limit_of(lim):
    m = re.search(r'about ([\d,]+) words', lim)
    if m: return int(m.group(1).replace(',', '')), 'words', 'soft'
    if 'per entry' in lim: return None
    m = re.search(r'([\d,]+) (words|characters)', lim)
    if m: return int(m.group(1).replace(',', '')), m.group(2), 'hard'
    return None

def answers(path):
    L = open(path).read().split('\n')
    qs = [i for i, l in enumerate(L) if l.startswith('## ')]
    res = {}
    for k, i in enumerate(qs):
        j = qs[k + 1] if k + 1 < len(qs) else len(L)
        res[L[i]] = L[i:j]
    return res

def lint(out):
    src = os.path.join('sections', os.path.basename(out))
    problems = []
    so = [l for l in open(src).read().split('\n') if FIXED.match(l)]
    oo = [l for l in open(out).read().split('\n') if FIXED.match(l)]
    if so != oo:
        for a, b in zip(so, oo):
            if a != b: problems.append(f'STRUCTURE changed:\n      src: {a[:110]}\n      out: {b[:110]}')
        if len(so) != len(oo): problems.append(f'STRUCTURE line count {len(so)} -> {len(oo)}')
    sa, oa = answers(src), answers(out)
    stats = {t: (w, ch, st, lim) for t, lim, st, w, ch in analyse(out)}
    for head, block in oa.items():
        t = head[3:].strip('* ')
        w, ch, st, lim = stats.get(t, (0, 0, '', ''))
        m = COUNT.match(st)
        if m:
            v = int(m.group(1).replace(',', '')); unit = m.group(2)
            act = w if unit == 'words' else ch
            tol = 0 if unit == 'words' else 10
            if abs(v - act) > tol: problems.append(f'[{t}] COUNT stated {v} {unit}, actual {act}')
        L = limit_of(lim)
        if L:
            n, unit, kind = L
            act = w if unit == 'words' else ch
            if act > n: problems.append(f'[{t}] OVER LIMIT {act} > {n} {unit} ({kind})')
            elif unit == 'characters' and act > n - 40: problems.append(f'[{t}] NEAR CHAR LIMIT {act}/{n} (keep 40 under)')
        sb = sum(l.count('\\[') for l in sa.get(head, []))
        ob = sum(l.count('\\[') for l in block)
        if sb != ob: problems.append(f'[{t}] BRACKETS {sb} -> {ob}')
        prose = '\n'.join(l for l in block if not FIXED.match(l) and not COUNT.match(l))
        pc = clean(prose).lower()
        if '—' in prose: problems.append(f'[{t}] EM DASH x{prose.count(chr(0x2014))}')
        for b in BANNED:
            if re.search(r'\b' + re.escape(b) + r'\b', pc): problems.append(f'[{t}] BANNED "{b}"')
        for word, mx in (('door', 1), ('doors', 1), ('outsider', 1), ('outsiders', 1), ('pipeline', 1)):
            c = len(re.findall(r'\b' + word + r'\b', pc))
            if c > mx: problems.append(f'[{t}] OVERUSE "{word}" x{c}')
    return problems

for p in sys.argv[1:]:
    ps = lint(p)
    print(f'== {p}: {"OK" if not ps else str(len(ps)) + " issue(s)"}')
    for x in ps: print('   - ' + x)
