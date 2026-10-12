#!/usr/bin/env python3
"""Put the final creative pieces into the section files and tidy every count line.
Usage (from the scratchpad root): python3 -I tools/assemble.py <sections dir> <final pieces dir>
- each <final>/NN_qQ.md replaces the body of question Q in <sections>/NN.md (via apply_answer.py)
- count lines lose the '(excluding [bracket] notes)' wording and screenplay page estimates are recomputed (words / 180)"""
import os, re, subprocess, sys

SECS, FINAL = sys.argv[1], sys.argv[2]
TOOLS = os.path.dirname(os.path.abspath(__file__))
for f in sorted(os.listdir(FINAL)):
    m = re.match(r'^(\d\d)_q(\d+)\.md$', f)
    if not m:
        continue
    sec = os.path.join(SECS, f'{m.group(1)}.md')
    r = subprocess.run([sys.executable, '-I', os.path.join(TOOLS, 'apply_answer.py'), sec, m.group(2), os.path.join(FINAL, f)],
                       capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())

for f in sorted(os.listdir(SECS)):
    if not re.match(r'^\d\d\.md$', f):
        continue
    p = os.path.join(SECS, f)
    L = open(p).read().split('\n')
    for i, l in enumerate(L):
        l = l.replace(' (excluding \\[bracket\\] notes)', '')
        m = re.match(r'^\*([\d,]+) words, about [\d.]+ screenplay pages\*$', l)
        if m:
            w = int(m.group(1).replace(',', ''))
            l = f'*{m.group(1)} words, about {w / 180:.1f} screenplay pages*'
        L[i] = l
    open(p, 'w').write('\n'.join(L))
print('count lines tidied')
