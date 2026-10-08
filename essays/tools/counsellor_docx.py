#!/usr/bin/env python3
"""Build the counsellor copy as a Word document.
Usage: python3 -I counsellor_docx.py <sections_dir> <endnotes.md> <out.docx> [date_line]
Reads 01.md..15.md in the working structure and writes a clean document:
title page with contents, one school per page, question / essay / small count line,
screenplays in Courier New, deadlines and open points at the end."""
import os, re, sys
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

SEC_DIR, ENDNOTES, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
DATE_LINE = sys.argv[4] if len(sys.argv) > 4 else 'Draft for review, October 2026'
SERIF, SANS, MONO = 'Cambria', 'Calibri', 'Courier New'
INK, GREY, LIGHT = RGBColor(0x1A, 0x1A, 0x1A), RGBColor(0x55, 0x55, 0x55), RGBColor(0x88, 0x88, 0x88)

doc = Document()
sec = doc.sections[0]
sec.page_height, sec.page_width = Cm(29.7), Cm(21.0)
for side in ('left_margin', 'right_margin'):
    setattr(sec, side, Cm(2.5))
sec.top_margin, sec.bottom_margin = Cm(2.3), Cm(2.3)

cp = doc.core_properties
cp.author = ''; cp.last_modified_by = ''; cp.comments = ''; cp.keywords = ''; cp.subject = ''
cp.title = 'Fall 2027 application essays'


def set_font(style_or_run_font, name):
    """Set a font name on every script slot and drop theme overrides."""
    f = style_or_run_font
    f.name = name
    rpr = f.element.get_or_add_rPr() if hasattr(f, 'element') else None


def force_fonts(style, name):
    style.font.name = name
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts'); rpr.append(rfonts)
    for a in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
        rfonts.set(qn(a), name)
    for a in ('w:asciiTheme', 'w:hAnsiTheme', 'w:cstheme', 'w:eastAsiaTheme'):
        if rfonts.get(qn(a)) is not None:
            del rfonts.attrib[qn(a)]


def para_style(name, font, size, color=INK, bold=False, before=0, after=8, line=1.15, base=None):
    st = doc.styles[name] if name in [s.name for s in doc.styles] else doc.styles.add_style(name, 1)
    if base:
        st.base_style = doc.styles[base]
    force_fonts(st, font)
    st.font.size = Pt(size); st.font.bold = bold; st.font.color.rgb = color; st.font.italic = False
    pf = st.paragraph_format
    pf.space_before = Pt(before); pf.space_after = Pt(after); pf.line_spacing = line
    return st


para_style('Normal', SERIF, 11, after=8, line=1.2)
para_style('Title', SANS, 26, bold=True, after=2, line=1.0)
para_style('Heading 1', SANS, 17, bold=True, before=0, after=4, line=1.05)
para_style('Heading 2', SANS, 12.5, bold=True, before=18, after=5, line=1.1)
para_style('Subtitle', SANS, 13, color=GREY, after=2, line=1.1)
para_style('Dateline', SANS, 10.5, color=LIGHT, after=22)
para_style('Deadline', SANS, 10.5, color=GREY, after=12)
para_style('Prompt', SANS, 10.5, color=RGBColor(0x44, 0x44, 0x44), after=9, line=1.15)
para_style('Meta', SANS, 9.5, color=LIGHT, before=2, after=0)
para_style('Script', MONO, 10.5, after=5, line=1.0)
para_style('Contents head', SANS, 12, bold=True, before=18, after=8)
para_style('Contents entry', SANS, 10.5, after=5, line=1.1)
for nm in ('Title', 'Subtitle'):
    ppr = doc.styles[nm].element.get_or_add_pPr()
    for b in ppr.findall(qn('w:pBdr')):
        ppr.remove(b)
    rpr = doc.styles[nm].element.get_or_add_rPr()
    for tag in ('w:spacing', 'w:i', 'w:iCs'):
        for el in rpr.findall(qn(tag)):
            rpr.remove(el)
for nm, ind_l, ind_r, after, before in (('Script cue', 5.6, 0, 0, 8), ('Script paren', 4.2, 4.0, 0, 0),
                                        ('Script dialogue', 2.6, 2.6, 6, 0), ('Script heading', 0, 0, 6, 12)):
    st = para_style(nm, MONO, 10.5, after=after, before=before, line=1.0, bold=(nm == 'Script heading'))
    st.paragraph_format.left_indent = Cm(ind_l); st.paragraph_format.right_indent = Cm(ind_r)
    if nm in ('Script cue', 'Script paren'):
        st.paragraph_format.keep_with_next = True
lb = doc.styles['List Bullet']
force_fonts(lb, SERIF); lb.font.size = Pt(11); lb.paragraph_format.space_after = Pt(4); lb.paragraph_format.line_spacing = 1.2
for h in ('Heading 1', 'Heading 2'):
    doc.styles[h].paragraph_format.keep_with_next = True

TOKEN = re.compile(r'(\*\*.+?\*\*|(?<![\w*])\*(?!\s).+?(?<!\s)\*(?![\w*]))')


def add_inline(p, text, size=None, color=None):
    text = text.replace('\\[', '[').replace('\\]', ']').replace('\\', '')
    for part in TOKEN.split(text):
        if not part:
            continue
        bold = part.startswith('**') and part.endswith('**') and len(part) > 4
        ital = not bold and part.startswith('*') and part.endswith('*') and len(part) > 2
        r = p.add_run(part[2:-2] if bold else part[1:-1] if ital else part)
        r.bold = True if bold else None
        r.italic = True if ital else None
        if size: r.font.size = Pt(size)
        if color: r.font.color.rgb = color
    return p


def strip_md(t):
    return re.sub(r'\*\*|\*', '', t).strip()


def short_limit(lim):
    t = re.sub(r'^\*Limit:\s*|\*$', '', lim).strip()
    if not t:
        return ''
    optional = 'optional' in t.lower()
    first = re.split(r'(?<=[a-z0-9)"])\.\s+', t)[0].rstrip('.')
    if first.lower().startswith('not stated'):
        first = ''
    first = re.sub(r';\s*one entry per employer', ' (one entry per employer)', first)
    first = re.sub(r'\s*\(([^()]*)\)', r', \1', first)
    out = f'limit: {first}' if first else ''
    if optional:
        out = (out + ', optional') if out else 'optional'
    return out


def count_text(cline):
    s = cline.strip()
    m = re.match(r'^\*([\d,]+) (words|characters)(.*?)\*$', s)
    if not m:
        m2 = re.match(r'^\*Longest entry: ([\d,]+) characters', s)
        return f'longest entry {m2.group(1)} characters' if m2 else ''
    n, unit, rest = m.groups()
    pm = re.search(r'about ([\d.]+) screenplay pages', rest)
    return f'{n} {unit}' + (f', about {pm.group(1)} screenplay pages' if pm else '')


def page_number_footer(section):
    fp = section.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = fp.add_run('Karan Chaudhary  ·  Fall 2027 application essays  ·  ')
    r.font.size = Pt(8.5); r.font.color.rgb = LIGHT; r.font.name = SANS
    run = fp.add_run(); run.font.size = Pt(8.5); run.font.color.rgb = LIGHT; run.font.name = SANS
    for tag, txt in (('begin', None), (None, 'PAGE'), ('end', None)):
        if tag:
            el = OxmlElement('w:fldChar'); el.set(qn('w:fldCharType'), tag); run._r.append(el)
        else:
            it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = txt; run._r.append(it)


page_number_footer(sec)

# ---------- title page ----------
files = sorted(f for f in os.listdir(SEC_DIR) if re.match(r'^\d\d\.md$', f))
toc = []
for f in files:
    L = open(os.path.join(SEC_DIR, f)).read().split('\n')
    m = re.match(r'^\*\*(.+?)\*\*', L[1]) if len(L) > 1 else None
    toc.append((strip_md(L[0][2:]), m.group(1).rstrip('.') if m else ''))

doc.add_paragraph('Karan Chaudhary', style='Title')
doc.add_paragraph('Graduate application essays, Fall 2027', style='Subtitle')
doc.add_paragraph(DATE_LINE, style='Dateline')
doc.add_paragraph("These are the draft answers for fifteen graduate programmes in film producing and entertainment management, in deadline order. Each section gives the school's question, the answer, and its length against the limit. Words in square brackets are details still to be added or confirmed.")
doc.add_paragraph('Deadlines, eligibility questions and the schools left out are on the last pages.')
doc.add_paragraph('Contents', style='Contents head')
for title, dl in toc:
    p = doc.add_paragraph(style='Contents entry')
    add_inline(p, title)
    if dl:
        r = p.add_run(); r.add_break()
        add_inline(p, dl, color=LIGHT)
doc.add_paragraph('Deadlines and open points', style='Contents entry')

# ---------- sections ----------
for f in files:
    L = open(os.path.join(SEC_DIR, f)).read().rstrip('\n').split('\n')
    h = doc.add_paragraph(style='Heading 1'); add_inline(h, strip_md(L[0][2:]))
    h.paragraph_format.page_break_before = True
    i = 1
    if i < len(L) and L[i].startswith('**'):
        m = re.match(r'^\*\*(.+?)\*\*', L[i])
        add_inline(doc.add_paragraph(style='Deadline'), (m.group(1) if m else strip_md(L[i])).rstrip('.'))
        i += 1
    qs = [k for k in range(i, len(L)) if L[k].startswith('## ')]
    for n, k in enumerate(qs):
        j = qs[n + 1] if n + 1 < len(qs) else len(L)
        block = L[k:j]
        add_inline(doc.add_paragraph(style='Heading 2'), strip_md(block[0][3:]))
        lim, body, counts = '', [], []
        for line in block[1:]:
            s = line.rstrip()
            if s.startswith('*Limit'):
                lim = s
            elif s.startswith('*Question:'):
                q = re.sub(r'^\*Question:\s*|\*$', '', s)
                q = re.sub(r'\s*\((Give|Talking points)[^()]*\)\s*$', '', q)
                add_inline(doc.add_paragraph(style='Prompt'), q)
            elif re.match(r'^\*([\d,]+) (words|characters)', s) or s.startswith('*Longest entry'):
                counts.append(s)
            else:
                body.append(s)
        script = any('screenplay pages' in c for c in counts) or 'screenplay format' in lim.lower()
        expect_dialogue = False
        for s in body:
            if not s.strip():
                continue
            if s.startswith('• ') or s.startswith('- '):
                add_inline(doc.add_paragraph(style='List Bullet'), s[2:]); expect_dialogue = False
                continue
            if not script or s.startswith('**'):
                add_inline(doc.add_paragraph(style='Normal'), s); expect_dialogue = False
                continue
            plain = s.replace('\\', '').strip()
            if re.match(r'^(INT\.|EXT\.|INT/EXT|I/E\.)', plain):
                style, expect_dialogue = 'Script heading', False
            elif re.match(r"^[A-Z0-9 .,'&\-]+( \((V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D)\))?$", plain) and len(plain) <= 40 and re.search(r'[A-Z]', plain) and not plain.endswith(':'):
                style, expect_dialogue = 'Script cue', True
            elif plain.startswith('(') and plain.endswith(')') and expect_dialogue:
                style = 'Script paren'
            elif expect_dialogue:
                style, expect_dialogue = 'Script dialogue', False
            elif re.match(r'^[A-Z ]+(TO|OUT|IN):$', plain):
                style = 'Script'
            else:
                style = 'Script'
            p_ = doc.add_paragraph(style=style)
            if re.match(r'^[A-Z ]+(TO|OUT|IN):$', plain):
                p_.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            add_inline(p_, s)
        bits = [c for c in (count_text(c) for c in counts) if c]
        meta = '  ·  '.join(x for x in [', '.join(bits), short_limit(lim)] if x)
        if meta:
            add_inline(doc.add_paragraph(style='Meta'), meta)

# ---------- end notes ----------
first = True
for s in open(ENDNOTES).read().split('\n'):
    s = s.rstrip()
    if not s:
        continue
    if s.startswith('# '):
        h = doc.add_paragraph(style='Heading 1'); add_inline(h, s[2:]); h.paragraph_format.page_break_before = True
    elif s.startswith('## '):
        add_inline(doc.add_paragraph(style='Heading 2'), s[3:])
    else:
        add_inline(doc.add_paragraph(), s)

doc.save(OUT)
print('wrote', OUT)
