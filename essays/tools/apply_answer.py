#!/usr/bin/env python3
"""Replace one answer body in a section file and recompute its count line.
Usage: python3 -I apply_answer.py <section.md> <question number> <body.txt>
The body sits between the question's last italic header line (*Limit*, *Question*)
and its count line; blank lines in body.txt separate paragraphs (one line each in the file)."""
import os, re, sys

path, qnum, body_path = sys.argv[1], sys.argv[2], sys.argv[3]
L = open(path).read().split('\n')
qs = [i for i, l in enumerate(L) if l.startswith('## ')]
start = next((i for i in qs if L[i].startswith(f'## **{qnum}. ')), None)
if start is None:
    sys.exit(f'question {qnum} not found in {path}')
end = next((i for i in qs if i > start), len(L))
b = start + 1
while b < end and L[b].startswith('*') and not L[b].startswith('**') and not re.match(r'^\*[\d,]+ (words|characters)', L[b]):
    b += 1
c = next((i for i in range(b, end) if re.match(r'^\*[\d,]+ (words|characters)', L[i])), None)
if c is None:
    sys.exit('count line not found')
paras = [' '.join(p.split('\n')).strip() for p in re.split(r'\n\s*\n', open(body_path).read().strip())]
new = L[:b] + paras + L[c:]
open(path, 'w').write('\n'.join(new))

# recount with count.py's own logic
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'count.py')).read().split('for p in sys.argv')[0]
ns = {}; exec(src, ns)
L = open(path).read().split('\n')
stats = {t: (w, ch, st) for t, lim, st, w, ch in ns['analyse'](path)}
cur = None
for i, l in enumerate(L):
    if l.startswith('## '):
        cur = l[3:].strip('* ')
    m = re.match(r'^\*([\d,]+) (words|characters)(.*)$', l)
    if m and cur and cur.startswith(f'{qnum}. ') and cur in stats:
        w, ch, _ = stats[cur]
        act = w if m.group(2) == 'words' else ch
        L[i] = f'*{act} {m.group(2)}{m.group(3)}'
        print(f'{path} Q{qnum}: {act} {m.group(2)}')
open(path, 'w').write('\n'.join(L))
