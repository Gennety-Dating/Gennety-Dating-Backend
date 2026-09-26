#!/usr/bin/env python3
"""Legal markdown (the subset legal/*.md uses) -> the JSX body of the website's legal pages.

The website (`gennetydating-website`, Vercel) carries each document as a hand-written
`src/app/<privacy|terms|cookies>/page.tsx`; this prints the part between the version line and
the closing `</div>` of the prose block, with the same class names. Header (H1, "Last Updated ·
Version" line) stays hand-written in the page.

Usage:
  python3 scripts/legal-md-to-tsx.py legal/privacy-policy.md --from-line <first body line>
  (first body line = the paragraph after the version blurb, e.g. "This Privacy Policy explains")

Calibrated 2026-09-26: privacy v3.0 (264bb97a) reproduces the site's page (f074243) except the
July page's literal `*…*` in one blockquote (rendered as <em> here) and one hand-shortened cell;
terms v2.0 reproduces byte for byte after whitespace normalisation.
"""
import re
import sys
import html

P = '<p className="text-gray-300 leading-relaxed my-4">'
H2 = '<h2 className="text-2xl font-semibold text-white mt-12 mb-4">'
H3 = '<h3 className="text-xl font-semibold text-white mt-6 mb-3">'
HR = '<hr className="border-gray-800 my-8" />'
UL = '<ul className="list-disc pl-6 space-y-2 my-2 text-gray-300">'
CODE = '<code className="bg-gray-800 px-1 py-0.5 rounded text-magenta font-mono text-sm">'
BQ = '<blockquote className="border-l-4 border-magenta bg-magenta/5 p-4 my-6 rounded text-sm italic text-gray-400">'
A = '<a href="{href}" className="text-magenta hover:underline">'
TABLE_OPEN = ('<div className="overflow-x-auto my-6">\n'
              '<table className="w-full border-collapse border border-gray-800 text-left text-sm text-gray-300">\n'
              '<thead className="bg-gray-900/80 text-white font-semibold">')
TH = '<th className="border border-gray-800 px-4 py-3 font-semibold">'
TD = '<td className="border border-gray-800 px-4 py-3 align-top">'
TBODY = '<tbody className="divide-y divide-gray-800">'


def esc(text: str) -> str:
    """Escape plain text for JSX children."""
    text = html.escape(text, quote=False)  # & < >
    text = text.replace('"', '&quot;').replace("'", '&apos;')
    return text.replace('{', '&#123;').replace('}', '&#125;')


def inline(text: str) -> str:
    out = []
    i = 0
    # tokens: `code`, [label](href), **bold**, *em*
    pattern = re.compile(r'`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])')
    for m in pattern.finditer(text):
        out.append(esc(text[i:m.start()]))
        if m.group(1) is not None:
            out.append(CODE + esc(m.group(1)) + '</code>')
        elif m.group(2) is not None:
            out.append(A.format(href=m.group(3)) + inline(m.group(2)) + '</a>')
        elif m.group(4) is not None:
            out.append('<strong>' + inline(m.group(4)) + '</strong>')
        else:
            out.append('<em>' + inline(m.group(5)) + '</em>')
        i = m.end()
    out.append(esc(text[i:]))
    return ''.join(out)


def join(parts):
    """Join wrapped source lines; a line ending in letter+hyphen continues the word."""
    out = ''
    for part in parts:
        if not part:
            continue
        if out and not re.search(r'[A-Za-z]-$', out):
            out += ' '
        out += part
    return out


def split_row(line: str):
    cells = line.strip().strip('|').split('|')
    return [c.strip() for c in cells]


def convert(lines):
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        s = line.rstrip('\n')
        if not s.strip():
            i += 1
            continue
        if s.strip() == '---':
            out.append(HR)
            i += 1
            continue
        if s.startswith('### '):
            out.append(H3 + inline(s[4:].strip()) + '</h3>')
            i += 1
            continue
        if s.startswith('## '):
            out.append(H2 + inline(s[3:].strip()) + '</h2>')
            i += 1
            continue
        if s.startswith('#'):
            raise SystemExit(f'unsupported heading at line {i+1}: {s}')
        if s.startswith('|'):
            rows = []
            while i < n and lines[i].startswith('|'):
                rows.append(lines[i].rstrip('\n'))
                i += 1
            header = split_row(rows[0])
            if not re.fullmatch(r'\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?', rows[1].strip()):
                raise SystemExit(f'table without separator near line {i}')
            out.append(TABLE_OPEN)
            out.append('<tr>' + ''.join(TH + inline(c) + '</th>' for c in header) + '</tr>')
            out.append('</thead>')
            out.append(TBODY)
            for r in rows[2:]:
                cells = split_row(r)
                if len(cells) != len(header):
                    raise SystemExit(f'row width {len(cells)} != {len(header)}: {r[:80]}')
                out.append('<tr>' + ''.join(TD + inline(c) + '</td>' for c in cells) + '</tr>')
            out.append('</tbody>\n</table>\n</div>')
            continue
        if s.startswith('> ') or s == '>':
            buf = []
            while i < n and (lines[i].startswith('>')):
                buf.append(lines[i].rstrip('\n')[1:].strip())
                i += 1
            paras = [join(buf)]
            out.append(BQ + inline(paras[0]) + '</blockquote>')
            continue
        if re.match(r'^- ', s):
            items = []
            while i < n and (lines[i].startswith('- ') or (lines[i].startswith('  ') and lines[i].strip() and items)):
                l = lines[i].rstrip('\n')
                if l.startswith('- '):
                    items.append(l[2:].strip())
                else:
                    items[-1] = join([items[-1], l.strip()])
                i += 1
            out.append(UL)
            out.extend('<li>' + inline(it) + '</li>' for it in items)
            out.append('</ul>')
            continue
        if re.match(r'^\d+\. ', s):
            raise SystemExit(f'ordered list at line {i+1} — add support')
        buf = []
        while i < n and lines[i].strip() and not re.match(r'^(#|\||- |> |---\s*$|\d+\. )', lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append(P + inline(join(buf)) + '</p>')
    return '\n'.join(out)


if __name__ == '__main__':
    path = sys.argv[1]
    start = 1
    if '--from-line' in sys.argv:
        start = int(sys.argv[sys.argv.index('--from-line') + 1])
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()[start - 1:]
    print(convert(lines))
