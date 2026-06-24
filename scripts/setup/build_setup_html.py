"""Render the docs/setup/*.md guides to styled, cross-linked HTML.

Dependency-free: a small Markdown subset converter (headings, GFM pipe tables,
fenced code, inline code/bold/links, bullet + task lists, blockquotes) wrapped in
a shared dark theme with a sidebar — matching docs/v3.1/api_docs/index.html.

Run:  python scripts/qa-matrix/../setup/build_setup_html.py
  (or just: python scripts/setup/build_setup_html.py)
Re-run after editing any .md to regenerate the .html.
"""
import os
import re
import html

HERE = os.path.dirname(__file__)
DOCS = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "setup"))

# Sidebar order + titles (file stem -> nav label).
NAV = [
    ("README", "Overview / Index"),
    ("dev-environment", "Developer Environment"),
    ("production-overview", "Production — Overview"),
    ("production-aws-ec2", "Production — AWS (EC2)"),
    ("production-digitalocean", "Production — DigitalOcean"),
    ("local-llm-and-discovery", "Local LLM & Discovery"),
]
TITLES = {
    "README": "ProjexCloud Setup — Index",
    "dev-environment": "Developer Environment Setup",
    "production-overview": "Production Setup — Overview",
    "production-aws-ec2": "Production Setup — AWS (EC2)",
    "production-digitalocean": "Production Setup — DigitalOcean",
    "local-llm-and-discovery": "Local LLM & SDK Discovery",
}

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--ok:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
aside{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:20px 16px}
aside h1{font-size:15px;margin:0 0 2px}aside .sub{color:var(--muted);font-size:12px;margin-bottom:16px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:16px 0 6px}
aside a{display:block;padding:6px 10px;border-radius:6px;color:var(--ink);font-size:13px}
aside a:hover{background:#21262d;text-decoration:none}
aside a.active{background:#1f6feb;color:#fff}
main{padding:30px 42px;max-width:960px}
h1,h2,h3,h4{line-height:1.3}
h1{font-size:26px;margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid var(--line)}
h2{font-size:20px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:22px 0 8px}h4{font-size:14px;margin:18px 0 6px;color:var(--muted)}
p{margin:10px 0}
code{background:#0b0f14;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.88em}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto;margin:12px 0}
pre code{background:none;border:0;padding:0;font-size:12.5px;line-height:1.55;color:#c9d1d9}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}
th{background:#1c2330;color:var(--muted);font-weight:600}
tr:nth-child(even) td{background:#11161d}
blockquote{margin:12px 0;padding:8px 16px;border-left:3px solid var(--accent);background:#11161d;border-radius:0 8px 8px 0;color:#c9d1d9}
ul{margin:10px 0;padding-left:22px}li{margin:4px 0}
ul.task{list-style:none;padding-left:4px}ul.task li::before{content:"☐ ";color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.crumb{color:var(--muted);font-size:12px;margin-bottom:14px}
"""


def esc(s):
    return html.escape(s, quote=True)


def inline(text):
    """Render inline markdown to HTML on already-raw text (escapes as it goes)."""
    out = []
    # Split out `code` spans so their contents aren't treated as markdown.
    for i, part in enumerate(re.split(r"(`[^`]+`)", text)):
        if i % 2 == 1:  # code span
            out.append(f"<code>{esc(part[1:-1])}</code>")
            continue
        seg = esc(part)
        # links [text](url) — text already escaped; rewrite .md -> .html
        def link(m):
            label, url = m.group(1), m.group(2)
            if url.endswith(".md"):
                url = url[:-3] + ".html"
            url = re.sub(r"\.md(#)", r".html\1", url)
            return f'<a href="{url}">{label}</a>'
        seg = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, seg)
        seg = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", seg)
        out.append(seg)
    return "".join(out)


def render(md):
    lines = md.split("\n")
    htmlp = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        # fenced code
        if line.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # closing fence
            htmlp.append(f"<pre><code>{esc(chr(10).join(buf))}</code></pre>")
            continue
        # table: a line starting with | followed by a |---| separator
        if line.lstrip().startswith("|") and i + 1 < n and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = ["<table><thead><tr>"]
            t += [f"<th>{inline(h)}</th>" for h in header]
            t.append("</tr></thead><tbody>")
            for r in rows:
                t.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
            t.append("</tbody></table>")
            htmlp.append("".join(t))
            continue
        # heading
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            lvl = len(m.group(1))
            htmlp.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            i += 1
            continue
        # blockquote (consecutive > lines)
        if line.startswith(">"):
            buf = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").lstrip())
                i += 1
            htmlp.append(f"<blockquote>{inline(' '.join(buf))}</blockquote>")
            continue
        # list (bullet or task), consecutive - items
        if re.match(r"^\s*-\s+", line):
            buf = []
            is_task = False
            while i < n and re.match(r"^\s*-\s+", lines[i]):
                item = re.sub(r"^\s*-\s+", "", lines[i])
                tm = re.match(r"^\[([ xX])\]\s+(.*)$", item)
                if tm:
                    is_task = True
                    item = tm.group(2)
                buf.append(item)
                i += 1
            cls = ' class="task"' if is_task else ""
            htmlp.append(f"<ul{cls}>" + "".join(f"<li>{inline(b)}</li>" for b in buf) + "</ul>")
            continue
        # blank
        if line.strip() == "":
            i += 1
            continue
        # horizontal rule
        if re.match(r"^---+\s*$", line):
            htmlp.append("<hr>")
            i += 1
            continue
        # paragraph (gather until blank/structural)
        buf = [line]
        i += 1
        while i < n and lines[i].strip() != "" and not re.match(r"^(#{1,6}\s|```|>|\s*-\s|\|)", lines[i]):
            buf.append(lines[i])
            i += 1
        htmlp.append(f"<p>{inline(' '.join(buf))}</p>")
    return "\n".join(htmlp)


def page(stem, body):
    nav = []
    for s, label in NAV:
        active = " active" if s == stem else ""
        nav.append(f'<a class="{active.strip()}" href="{s}.html">{esc(label)}</a>')
    nav_html = "\n".join(nav)
    title = TITLES.get(stem, stem)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)} · ProjexCloud</title><style>{CSS}</style></head><body>
<div class="layout">
<aside><h1>ProjexCloud</h1><div class="sub">Setup &amp; Deployment</div>
<h2>Guides</h2>
{nav_html}
<h2>Reference</h2>
<a href="../v3.1/api_docs/index.html">API Reference ↗</a>
<a href="../v3.1/api_docs/test-plan.html">QA Test Plan ↗</a>
</aside>
<main>
<div class="crumb">docs / setup / {esc(stem)}.html</div>
{body}
</main></div></body></html>"""


def main():
    built = []
    for stem, _ in NAV:
        src = os.path.join(DOCS, stem + ".md")
        if not os.path.exists(src):
            print(f"  skip (no md): {stem}")
            continue
        with open(src, encoding="utf-8") as f:
            md = f.read()
        out = os.path.join(DOCS, stem + ".html")
        with open(out, "w", encoding="utf-8") as f:
            f.write(page(stem, render(md)))
        built.append(stem + ".html")
    print("wrote:", ", ".join(built))


if __name__ == "__main__":
    main()
