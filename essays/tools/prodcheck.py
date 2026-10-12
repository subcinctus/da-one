#!/usr/bin/env python3
"""Flag lines that may still claim production work or misstate Karan's roles.
Usage (from scratchpad root): python3 -I tools/prodcheck.py out/*.md counsellor/*.md
Every hit must be read: some are legitimate (fiction, the goal of producing, 'production sheets' on Finolex,
programme course names such as 'physical production'), most are not."""
import re, sys
PATS = [
    r'production intern', r'interned? (in|on) production', r'intern(ed)? on Khauf', r'Khauf[^.]{0,80}\bintern',
    r'\b(worked|work|working|works) in production', r'production (work|job|jobs|experience|role|roles|side|team)\b',
    r'\bmy production\b', r'on-set execution', r'managed the (Sleepyhead|campaign)', r'managing (the )?(Sleepyhead|campaign)',
    r'on-site coordination', r'responsible for a whole shoot', r'whole shoot', r'run (a|one|the) shoot', r'ran (a|the) shoot',
    r'plan a shoot and run', r'camera to production', r'from camera (to|into) production', r'Boney Kapoor[^.]{0,60}production',
    r'production[^.]{0,40}Boney Kapoor', r'coordinat\w+ (the )?(client|agency|crew|cast|departments)', r'Sleepyhead[^.]{0,120}(managed|coordinat|client|agency|crew|cast)',
    r'(client|agency)[^.]{0,60}(crew|cast)[^.]{0,60}(answer|needed)', r'production (manager|coordinator|assistant)',
]
RX = re.compile('|'.join(f'(?:{p})' for p in PATS), re.I)
total = 0
for path in sys.argv[1:]:
    L = open(path).read().split('\n'); cur = ''
    for n, l in enumerate(L, 1):
        if l.startswith('## '): cur = l[3:].strip('* ')[:40]
        if l.startswith(('*Question', '*Limit', '# ', '## ')): continue
        for m in RX.finditer(l):
            total += 1
            s = max(0, m.start() - 60); e = min(len(l), m.end() + 60)
            print(f'{path}:{n} [{cur}] ...{l[s:e]}...')
print(f'== {total} hit(s)')
