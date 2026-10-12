#!/usr/bin/env python3
"""Show changes OUTSIDE bracket notes between two versions of a section.
Usage (from scratchpad root): python3 -I tools/outside_diff.py out/01.md counsellor/01.md
Prints per answer any word-level change in text outside \\[...\\]; silent answers are unchanged."""
import re, sys, difflib
def answers(p):
    L = open(p).read().split('\n'); qs = [i for i, l in enumerate(L) if l.startswith('## ')]
    d = {}
    for k, i in enumerate(qs):
        j = qs[k + 1] if k + 1 < len(qs) else len(L)
        body = [l for l in L[i + 1:j] if not re.match(r'^\*([\d,]+ (words|characters)|Longest entry)', l)]
        d[L[i]] = re.sub(r'\\\[.*?\\\]', ' ', '\n'.join(body)).split()
    return d
a, b = answers(sys.argv[1]), answers(sys.argv[2])
total = 0
for h in a:
    x, y = a[h], b.get(h, [])
    if x == y: continue
    ops = [o for o in difflib.SequenceMatcher(None, x, y).get_opcodes() if o[0] != 'equal']
    total += len(ops)
    print(f'{h[3:60]}:')
    for tag, i1, i2, j1, j2 in ops[:12]:
        print(f'   {tag}: "{" ".join(x[i1:i2])[:90]}" -> "{" ".join(y[j1:j2])[:90]}"')
missing = [h for h in a if h not in b]
if missing: print('MISSING QUESTIONS:', missing)
print(f'== {sys.argv[2]}: {total} change(s) outside brackets')
