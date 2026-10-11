#!/usr/bin/env python3
"""HTML for ONE college as its own Google Doc: one or more programmes (section files) plus notes.
Usage: python3 -I gdoc_college_html.py <out.html> <college name> <notes.md> <date line> <section.md> [section.md ...]
One section: laid out exactly like gdoc_app_html.py (programme as the subtitle).
Several sections: the college is the subtitle, and each programme gets a large heading and its deadline."""
import re, sys, html

OUT, COLLEGE, NOTES, DATE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
SECS = sys.argv[5:]
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
    unit = m.group(2)[:-1] if m.group(1) == '1' else m.group(2)
    return f'{m.group(1)} {unit}' + (f', about {pm.group(1)} screenplay pages' if pm else '')



def render_questions(L, out):
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
        inl, exp, last = False, False, ''
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
            p = s.replace('\\', '').strip()
            plain = re.sub(r'^\*\*(.*)\*\*$', r'\1', p).strip()
            if not script:
                if re.match(r"^[A-Z][A-Z0-9 &/,'()\-]{2,40}$", plain) and not re.search('[a-z]', plain) and len(plain.split()) <= 6:
                    out.append(f'<p><b>{il(plain)}</b></p>')
                else:
                    out.append(f'<p>{il(s)}</p>')
                exp = False; last = ''
                continue
            if re.match(r'^(INT\.|EXT\.|INT/EXT|I/E\.|INT\./EXT\.)', plain) or re.match(r'^(INSERT\b|BACK TO SCENE|FADE (IN|OUT)|CUT TO|SMASH CUT|DISSOLVE TO|MATCH CUT|INTERCUT|END OF|THE END)', plain):
                cls, exp, ph = 's', False, f'<b>{il(plain)}</b>'
            elif s.startswith('**'):
                cls, exp, ph = 's', False, il(s)
            elif re.match(r"^[A-Z0-9 .,'&\-]+( \((V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D|ON PHONE|ON RADIO|INTO PHONE|PRE-LAP)\))*$", p) and len(p) <= 48 and re.search('[A-Z]', p) and not p.endswith(':'):
                cls, exp, ph = 'c', True, il(s)
            elif p.startswith('(') and p.endswith(')') and (exp or last in ('d', 'r')):
                cls, exp, ph = 'r', True, il(s)
            elif exp:
                cls, exp, ph = 'd', False, il(s)
            else:
                cls, ph = 's', il(s)
            last = cls
            out.append(f'<p class="{cls}">{ph}</p>')
        if inl:
            out.append('</ul>')
        bits = [c for c in (ctext(c) for c in counts) if c] if 'url' not in lim.lower() else []
        meta = ' · '.join(x for x in [', '.join(bits), short_limit(lim)] if x)
        if meta:
            out.append(f'<p class="m">{il(meta)}</p>')


def sec_info(path):
    L = open(path).read().rstrip('\n').split('\n')
    programme = re.sub(r'^\d+\.\s*', '', sm(L[0][2:]))
    m = re.match(r'^\*\*(.+?)\*\*', L[1]) if len(L) > 1 else None
    return L, programme, (m.group(1).rstrip('.') if m else '')


infos = [sec_info(p) for p in SECS]
has_brackets = any('\\[' in l for L, _, _ in infos for l in L if not re.match(r'^\*[\d,]+ (words|characters)', l))
note = ("Words in square brackets are details still to be added or confirmed. " if has_brackets else "")
out = [f'<html><head><meta charset="utf-8"><style>{CSS}</style></head><body>', '<p class="t">Karan Chaudhary</p>']
if len(infos) == 1:
    L, programme, deadline = infos[0]
    out += [f'<p class="st">{il(programme)}, Fall 2027</p>', f'<p class="da">{il(DATE)}</p>']
    if deadline:
        out.append(f'<p class="dl">{il(deadline)}</p>')
    out.append("<p>These are the draft answers for this application. Each question is followed by the answer and its length against the limit. " + note + "Notes on eligibility are at the end.</p>")
    render_questions(L, out)
else:
    names = []
    for L, programme, deadline in infos:
        short = programme[len(COLLEGE):].lstrip(' ,') if programme.startswith(COLLEGE) else programme
        names.append(short)
    out += [f'<p class="st">{il(COLLEGE)}, Fall 2027</p>', f'<p class="da">{il(DATE)}</p>']
    sep = '; ' if any(' and ' in x for x in names) else ', '
    listing = sep.join(names[:-1]) + (sep.rstrip() + ' and ' if sep == '; ' else ' and ') + names[-1] if len(names) > 1 else names[0]
    out.append(f"<p>This document holds the draft answers for {({2: "two", 3: "three", 4: "four"}).get(len(infos), len(infos))} programmes: {il(listing)}. Each programme starts on its own heading with its deadline. Each question is followed by the answer and its length against the limit. " + note + "Notes on eligibility are at the end.</p>")
    for (L, programme, deadline), short in zip(infos, names):
        out.append(f'<h1>{il(short)}</h1>')
        if deadline:
            out.append(f'<p class="dl">{il(deadline)}</p>')
        render_questions(L, out)

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
