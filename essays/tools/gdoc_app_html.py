#!/usr/bin/env python3
"""Compact HTML for ONE application as its own Google Doc (Docs default fonts; class styles only).
Usage: python3 -I gdoc_app_html.py <section.md> <notes.md> <out.html> [date_line]
Layout: name, programme, date, deadline, a two-line intro, then every question
(heading, prompt, answer, small count line), then the notes."""
import re, sys, html

SEC, NOTES, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
DATE = sys.argv[4] if len(sys.argv) > 4 else 'Draft for review, October 2026'
CSS = ("p{margin:0 0 8pt 0;line-height:1.15}ul{margin:0 0 8pt 0}h1{margin:28pt 0 4pt 0}h2{margin:18pt 0 4pt 0}"
       ".q{color:#555555}.m{font-size:9pt;color:#888888;margin:0 0 4pt 0}"
       ".t{font-size:26pt;font-weight:bold;margin:0}.st{font-size:14pt;color:#444444;margin:0}"
       ".da{color:#888888;margin:0 0 4pt 0}.dl{color:#444444;margin:0 0 16pt 0}"
       ".s{font-family:'Courier New';margin:0 0 6pt 0}.c{font-family:'Courier New';margin:8pt 0 0 2.2in}"
       ".r{font-family:'Courier New';margin:0 0 0 1.6in}.d{font-family:'Courier New';margin:0 1in 6pt 1in}")


def il(t):
    t = html.escape(t, quote=False).replace('\\[', '[').replace('\\]', ']').replace('\\', '')
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<i>\1</i>', t)


def sm(t):
    return re.sub(r'\*\*|\*', '', t).strip()


def short_limit(lim):
    t = re.sub(r'^\*Limit:\s*|\*$', '', lim).strip()
    if not t:
        return ''
    opt = 'optional' in t.lower()
    f = re.split(r'(?<=[a-z0-9)"])\.\s+', t)[0].rstrip('.')
    if f.lower().startswith('not stated'):
        f = ''
    f = re.sub(r';\s*one entry per employer', ' (one entry per employer)', f)
    f = re.sub(r'\s*\(([^()]*)\)', r', \1', f)
    o = f'limit: {f}' if f else ''
    return (o + ', optional' if o else 'optional') if opt else o


def ctext(c):
    m = re.match(r'^\*([\d,]+) (words|characters)(.*?)\*$', c.strip())
    if not m:
        m2 = re.match(r'^\*Longest entry: ([\d,]+) characters', c.strip())
        return f'longest entry {m2.group(1)} characters' if m2 else ''
    pm = re.search(r'about ([\d.]+) screenplay pages', m.group(3))
    return f'{m.group(1)} {m.group(2)}' + (f', about {pm.group(1)} screenplay pages' if pm else '')


L = open(SEC).read().rstrip('\n').split('\n')
programme = sm(L[0][2:])
programme = re.sub(r'^\d+\.\s*', '', programme)
m = re.match(r'^\*\*(.+?)\*\*', L[1]) if len(L) > 1 else None
deadline = m.group(1).rstrip('.') if m else ''

out = [f'<html><head><meta charset="utf-8"><style>{CSS}</style></head><body>',
       '<p class="t">Karan Chaudhary</p>',
       f'<p class="st">{il(programme)}, Fall 2027</p>',
       f'<p class="da">{il(DATE)}</p>']
if deadline:
    out.append(f'<p class="dl">{il(deadline)}</p>')
has_brackets = any('\\[' in l for l in L if not re.match(r'^\*[\d,]+ (words|characters)', l))
out.append("<p>These are the draft answers for this application. Each question is followed by the answer and its length against the limit. "
           + ("Words in square brackets are details still to be added or confirmed. " if has_brackets else "")
           + "Notes on eligibility are at the end.</p>")

qs = [k for k in range(1, len(L)) if L[k].startswith('## ')]
for n, k in enumerate(qs):
    block = L[k:(qs[n + 1] if n + 1 < len(qs) else len(L))]
    out.append(f'<h2>{il(sm(block[0][3:]))}</h2>')
    lim, body, counts = '', [], []
    for s in (x.rstrip() for x in block[1:]):
        if s.startswith('*Limit'):
            lim = s
        elif s.startswith('*Question:'):
            q = re.sub(r'^\*Question:\s*|\*$', '', s)
            q = re.sub(r'\s*\((Give|Talking points)[^()]*\)\s*$', '', q)
            out.append(f'<p class="q">{il(q)}</p>')
        elif re.match(r'^\*([\d,]+) (words|characters)', s) or s.startswith('*Longest entry'):
            counts.append(s)
        else:
            body.append(s)
    script = any('screenplay pages' in c for c in counts) or 'screenplay format' in lim.lower()
    inl, exp = False, False
    for s in body:
        if not s.strip():
            continue
        if s.startswith('• ') or s.startswith('- ') or s.startswith('* '):
            if not inl:
                out.append('<ul>'); inl = True
            out.append(f'<li>{il(s[2:])}</li>'); exp = False
            continue
        if inl:
            out.append('</ul>'); inl = False
        if not script or s.startswith('**'):
            out.append(f'<p>{il(s)}</p>'); exp = False
            continue
        p = s.replace('\\', '').strip()
        if re.match(r'^(INT\.|EXT\.|INT/EXT|I/E\.)', p):
            cls, exp, ph = 's', False, f'<b>{il(s)}</b>'
        elif re.match(r"^[A-Z0-9 .,'&\-]+( \((V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D)\))?$", p) and len(p) <= 40 and re.search('[A-Z]', p) and not p.endswith(':'):
            cls, exp, ph = 'c', True, il(s)
        elif p.startswith('(') and p.endswith(')') and exp:
            cls, ph = 'r', il(s)
        elif exp:
            cls, exp, ph = 'd', False, il(s)
        else:
            cls, ph = 's', il(s)
        out.append(f'<p class="{cls}">{ph}</p>')
    if inl:
        out.append('</ul>')
    bits = [c for c in (ctext(c) for c in counts) if c]
    meta = ' · '.join(x for x in [', '.join(bits), short_limit(lim)] if x)
    if meta:
        out.append(f'<p class="m">{il(meta)}</p>')

for s in open(NOTES).read().split('\n'):
    s = s.rstrip()
    if not s:
        continue
    if s.startswith('# '):
        out.append(f'<h1>{il(s[2:])}</h1>')
    elif s.startswith('## '):
        out.append(f'<h2>{il(s[3:])}</h2>')
    else:
        out.append(f'<p>{il(s)}</p>')
out.append('</body></html>')
open(OUT, 'w').write('\n'.join(out))
print('wrote', OUT, sum(len(x) for x in out), 'chars')
