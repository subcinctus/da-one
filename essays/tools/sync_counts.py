#!/usr/bin/env python3
"""Set every count line in the given section files to count.py's number (words exact; chars if off by >10)."""
import os, re, sys
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'count.py')).read().split('for p in sys.argv')[0]
ns = {}; exec(src, ns)
for path in sys.argv[1:]:
    stats = {t: (w, ch) for t, lim, st, w, ch in ns['analyse'](path)}
    L = open(path).read().split('\n'); cur = None; n = 0
    for i, l in enumerate(L):
        if l.startswith('## '): cur = l[3:].strip('* ')
        m = re.match(r'^\*([\d,]+) (words|characters)(.*)$', l)
        if m and cur in stats:
            v = int(m.group(1).replace(',', '')); w, ch = stats[cur]
            act = w if m.group(2) == 'words' else ch
            if abs(v - act) > (0 if m.group(2) == 'words' else 10):
                L[i] = f'*{act:,} {m.group(2)}{m.group(3)}' if ',' in m.group(1) else f'*{act} {m.group(2)}{m.group(3)}'; n += 1
    open(path, 'w').write('\n'.join(L)); print(path, 'updated', n)
