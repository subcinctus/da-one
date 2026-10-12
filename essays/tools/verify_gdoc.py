#!/usr/bin/env python3
"""Compare a Google Doc's plain-text export with the HTML it was made from.
Usage: python3 -I verify_gdoc.py <source.html> <export.txt>
Prints word-level differences (ignores whitespace and list bullets)."""
import re, sys, html, difflib
def words_from_html(p):
    t = open(p).read()
    t = re.sub(r'<style>.*?</style>', ' ', t, flags=re.S)
    t = re.sub(r'<br>|</p>|</h\d>|</li>', '\n', t)
    t = html.unescape(re.sub(r'<[^>]+>', ' ', t))
    return t.split()
def words_from_txt(p):
    t = open(p, encoding='utf-8-sig').read().replace(' ', ' ')
    t = re.sub(r'^\s*[\*●○■•]\s+', ' ', t, flags=re.M)
    return t.split()
a, b = words_from_html(sys.argv[1]), words_from_txt(sys.argv[2])
sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
ops = [o for o in sm.get_opcodes() if o[0] != 'equal']
print(f'source words {len(a)}, doc words {len(b)}, differing spans {len(ops)}')
for tag, i1, i2, j1, j2 in ops[:40]:
    print(f'  {tag}: src[{i1}] "{" ".join(a[max(0,i1-3):i2+3])[:140]}"  ->  doc "{" ".join(b[max(0,j1-3):j2+3])[:140]}"')
