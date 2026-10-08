#!/usr/bin/env python3
"""Find passages shared between different answers (n-word shingles merged into spans).
Usage (from scratchpad root): python3 -I tools/overlap.py [--n 8] out/*.md
Flags pairs inside the same university (USC 03/04/05, Chapman 06/07, LMU 08/09)."""
import re, sys, os
from collections import defaultdict
args = sys.argv[1:]; N = 8
if args and args[0] == '--n': N = int(args[1]); args = args[2:]
FIXED = re.compile(r'^(# |\*\*Deadline|## |\*Limit|\*Question|\*[\d,]+ (words|characters))')
GROUP = {'03': 'USC', '04': 'USC', '05': 'USC', '06': 'Chapman', '07': 'Chapman', '08': 'LMU', '09': 'LMU', '13': 'NYU'}
def toks(t):
    t = re.sub(r'\\\[.*?\\\]', ' ', t).replace('\\', '').replace('*', '')
    return re.findall(r"[a-z0-9']+", t.lower())
units = []
for p in args:
    L = open(p).read().split('\n'); f = os.path.basename(p)[:2]
    qs = [i for i, l in enumerate(L) if l.startswith('## ')]
    for k, i in enumerate(qs):
        j = qs[k + 1] if k + 1 < len(qs) else len(L)
        body = '\n'.join(l for l in L[i + 1:j] if not FIXED.match(l))
        if re.match(r'\s*Use ', body): continue
        units.append((f, L[i][3:].strip('* ')[:40], toks(body)))
idx = defaultdict(set)
for u, (f, q, t) in enumerate(units):
    for s in range(len(t) - N + 1): idx[tuple(t[s:s + N])].add(u)
pairs = defaultdict(set)
for sh, us in idx.items():
    if len(us) > 1:
        us = sorted(us)
        for a in range(len(us)):
            for b in range(a + 1, len(us)): pairs[(us[a], us[b])].add(sh)
rows = []
for (a, b), shs in pairs.items():
    t = units[a][2]; covered = [False] * len(t)
    for s in range(len(t) - N + 1):
        if tuple(t[s:s + N]) in shs:
            for x in range(s, s + N): covered[x] = True
    spans, cur = [], []
    for w, c in zip(t, covered):
        if c: cur.append(w)
        elif cur: spans.append(' '.join(cur)); cur = []
    if cur: spans.append(' '.join(cur))
    fa, fb = units[a][0], units[b][0]
    same = GROUP.get(fa) and GROUP.get(fa) == GROUP.get(fb)
    rows.append((not same, -sum(covered), fa, units[a][1], fb, units[b][1], spans, same))
rows.sort()
for _, neg, fa, qa, fb, qb, spans, same in rows:
    tag = 'SAME-UNIVERSITY ' if same else ''
    print(f'{tag}{fa}:{qa}  <->  {fb}:{qb}   shared words={-neg}')
    for s in spans[:4]: print(f'     "{s[:160]}"')
