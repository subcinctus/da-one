#!/usr/bin/env python3
"""Per-question word/char counts for a section file of the essays doc.
Usage: python3 -I count.py <section.md> [more.md ...]
For each '## ' question: prints the limit line, the stated count line, and the computed
words/chars of the answer body (text between the italic Question line and the count line),
excluding bracket notes (\\[...\\] or [...]) exactly as the doc's counts do."""
import re, sys

BR = re.compile(r'\\\[.*?\\\]|\[[^\]]*\]')
COUNT = re.compile(r'^\*([\d,]+) (words|characters)')

def clean(t):
    t = BR.sub(' ', t)
    t = t.replace('\\', '')
    t = re.sub(r'\*\*|(?<!\w)\*|\*(?!\w)', '', t)  # strip md emphasis markers
    return t

def analyse(path):
    lines = open(path).read().split('\n')
    qs = [i for i, l in enumerate(lines) if l.startswith('## ')]
    out = []
    for k, i in enumerate(qs):
        j = qs[k + 1] if k + 1 < len(qs) else len(lines)
        block = lines[i:j]
        limit = next((l for l in block if l.startswith('*Limit')), '')
        # body starts after the last leading italic line (*Limit*, *Question*, other notes)
        b = 1
        while b < len(block) and (block[b].startswith('*') and not block[b].startswith('**') or block[b].strip() == ''):
            b += 1
        cidx = next((n for n in range(len(block)) if COUNT.match(block[n])), None)
        end = cidx if cidx is not None else len(block)
        body = '\n'.join(block[b:end])
        c = clean(body)
        words = len(c.split())
        chars = len(re.sub(r'[ \t]+', ' ', ' '.join(x.strip() for x in c.split('\n') if x.strip())).strip())
        stated = block[cidx] if cidx is not None else '(no count line)'
        out.append((block[0][3:].strip('* '), limit, stated, words, chars))
    return out

for p in sys.argv[1:]:
    print('=' * 8, p)
    for title, limit, stated, w, ch in analyse(p):
        print(f'- {title}\n    limit : {limit}\n    stated: {stated}\n    actual: {w} words | {ch} chars')
