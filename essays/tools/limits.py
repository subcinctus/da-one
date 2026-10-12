#!/usr/bin/env python3
"""Flag answers over a numeric word or character limit.
Usage: python3 -I limits.py <section.md> [...]"""
import re, sys, os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'count.py')).read().split('for p in sys.argv')[0]
ns = {}; exec(src, ns)
for p in sys.argv[1:]:
    for t, lim, st, w, ch in ns['analyse'](p):
        l = (lim or '').replace(',', '')
        m = re.search(r'(\d+)\s*(words|characters|chars)', l)
        if not m:
            continue
        n, kind = int(m.group(1)), m.group(2)
        act = w if kind == 'words' else ch
        per_entry = 'per entry' in l
        if not per_entry and act > n:
            print(f'OVER {p} {t}: {act} {kind} > {n}')
print('limits checked')
