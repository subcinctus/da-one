#!/usr/bin/env python3
"""Convert a simple Markdown book to HTML.

Usage: python3 -I md_book_html.py IN.md OUT.html

'#' to '####' headings become h1 to h4, '- ' lines (indented for nesting)
become ul/li, **bold** becomes b, [text](url) becomes a href, and every
other non-blank line becomes p. Text is HTML-escaped.
"""
import html
import re
import sys

LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
BOLD = re.compile(r"\*\*(.+?)\*\*")


def inline(text):
    out = []
    pos = 0
    for m in LINK.finditer(text):
        out.append(fmt(text[pos:m.start()]))
        url = html.escape(m.group(2), quote=True)
        out.append(f'<a href="{url}">{fmt(m.group(1))}</a>')
        pos = m.end()
    out.append(fmt(text[pos:]))
    return "".join(out)


def fmt(text):
    t = html.escape(text, quote=False)
    return BOLD.sub(r"<b>\1</b>", t)


def convert(md):
    lines = md.split("\n")
    body = []
    stack = []  # indent widths of open <ul>
    title = None

    def close_to(indent):
        while stack and stack[-1] > indent:
            body.append("</li></ul>")
            stack.pop()

    for raw in lines:
        line = raw.rstrip()
        lm = re.match(r"^(\s*)- (.*)$", line)
        if lm:
            ind = len(lm.group(1).expandtabs(4))
            if stack and ind > stack[-1]:
                body.append("<ul>")
                stack.append(ind)
            else:
                close_to(ind)
                if stack and stack[-1] == ind:
                    body.append("</li>")
                else:
                    body.append("<ul>")
                    stack.append(ind)
            body.append("<li>" + inline(lm.group(2)))
            continue
        close_to(-1)
        if not line.strip():
            continue
        hm = re.match(r"^(#{1,4}) (.*)$", line)
        if hm:
            n = len(hm.group(1))
            if n == 1 and title is None:
                title = hm.group(2)
            body.append(f"<h{n}>{inline(hm.group(2))}</h{n}>")
            continue
        body.append("<p>" + inline(line.strip()) + "</p>")
    close_to(-1)
    title = html.escape(title or "Document", quote=False)
    head = (
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>{title}</title>\n"
        "<style>p{margin:0 0 6pt 0} h2{margin-top:18pt}</style>\n"
        "</head>\n<body>\n"
    )
    return head + "\n".join(body) + "\n</body>\n</html>\n"


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: md_book_html.py IN.md OUT.html")
    with open(sys.argv[1], encoding="utf-8") as f:
        md = f.read()
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(convert(md))


if __name__ == "__main__":
    main()
