"""Generate a self-contained HTML API reference under docs/v3.1/api_docs/.
Grouped by SDK; each API shows method/URI/auth, payload, path params, expected
response, epic + feature links. Includes a full 34-epic index + SDK sidebar.
Sources: qa-apis.json, metadata.json, all-epics.json."""
import json
import os
import html
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(__file__)
OUT_DIR = os.path.join(ROOT, "docs", "v3.1", "api_docs")
BASE_URL = "https://projexlight.com/s/"

apis = json.load(open(os.path.join(HERE, "qa-apis.json"), encoding="utf-8"))
meta = json.load(open(os.path.join(HERE, "metadata.json"), encoding="utf-8"))
features, scenarios = meta["features"], meta.get("scenarios", {})

# Full epic catalogue (34) from the list_epics dump; merge source_module.
raw = json.load(open(os.path.join(HERE, "all-epics.json"), encoding="utf-8"))
items = raw.get("data", {}).get("items", raw) if isinstance(raw, dict) else raw
epic_by_id = {}
for e in items:
    epic_by_id[e["id"]] = {
        "short_id": e.get("short_id", ""),
        "title": e.get("title", ""),
        "source_module": (e.get("customdata") or {}).get("source_module"),
    }
for eid, e in meta["epics"].items():  # ensure any api-referenced epic present
    epic_by_id.setdefault(eid, e)

def esc(v):
    return html.escape(str(v), quote=True)

def url(short):
    return f"{BASE_URL}{short}" if short else ""

def code_block(v):
    if v is None or v == "" or v == []:
        return '<span class="muted">—</span>'
    if isinstance(v, (dict, list)):
        return f"<pre>{esc(json.dumps(v, indent=2, ensure_ascii=False))}</pre>"
    return f"<pre>{esc(v)}</pre>"

# Group API rows by SDK -> unique (method,endpoint) -> list of test-case rows.
by_sdk = defaultdict(lambda: defaultdict(list))
for r in apis:
    by_sdk[r.get("sdk") or "(unknown)"][(r["method"], r["endpoint"])].append(r)

sdk_names = sorted(by_sdk.keys(), key=str.lower)
total_apis = sum(len(v) for v in by_sdk.values())
documented_epics = {r["epicId"] for r in apis if r.get("epicId")}

# #documented apis per epic
epic_api_count = defaultdict(int)
for sdk in by_sdk:
    for (_m, _e), rows in by_sdk[sdk].items():
        epic_api_count[rows[0].get("epicId", "")] += 1

METHOD_COLORS = {"GET": "#2d8a4e", "POST": "#1f6feb", "PUT": "#9a6700",
                 "PATCH": "#8250df", "DELETE": "#cf222e"}

def sdk_anchor(s):
    return "sdk-" + "".join(c if c.isalnum() else "-" for c in s.lower())

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:grid;grid-template-columns:300px 1fr;min-height:100vh}
aside{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:18px 16px}
aside h1{font-size:15px;margin:0 0 4px}aside .sub{color:var(--muted);font-size:12px;margin-bottom:14px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 0 6px}
aside a{display:block;padding:3px 6px;border-radius:6px;color:var(--ink);font-size:13px}
aside a:hover{background:#21262d;text-decoration:none}
aside .cnt{color:var(--muted);font-size:11px}
main{padding:26px 34px;max-width:1100px}
.hero{background:linear-gradient(135deg,#161b22,#1c2735);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:24px}
.hero h1{margin:0 0 6px;font-size:22px}.hero p{margin:4px 0;color:var(--muted)}
.stats{display:flex;gap:26px;margin-top:12px;flex-wrap:wrap}
.stat b{font-size:20px;display:block}.stat span{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;margin:8px 0 26px;font-size:13px}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#1c2330;color:var(--muted);font-weight:600;position:sticky}
h2.sdk{margin:34px 0 4px;font-size:19px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sdkmeta{color:var(--muted);font-size:12px;margin-bottom:10px}
.api{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:14px 0;overflow:hidden}
.api>summary{list-style:none;cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:12px}
.api>summary::-webkit-details-marker{display:none}
.api[open]>summary{border-bottom:1px solid var(--line)}
.m{font-weight:700;color:#fff;border-radius:6px;padding:2px 9px;font-size:12px;min-width:54px;text-align:center}
.uri{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:14px}
.badge{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:1px 9px;margin-left:auto}
.body{padding:6px 16px 16px}
.kv{display:grid;grid-template-columns:130px 1fr;gap:4px 14px;margin:10px 0}
.kv .k{color:var(--muted);font-size:12px;padding-top:3px}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;margin:2px 0;font:12px/1.5 ui-monospace,Consolas,monospace;color:#c9d1d9}
.muted{color:var(--muted)}
.tag{display:inline-block;background:#21262d;border:1px solid var(--line);border-radius:6px;padding:1px 7px;font-size:11px;margin:1px}
.manual{color:#d29922}
.kv .k.ok{color:#3fb950}.kv .k.err{color:#f85149}
.note{color:var(--muted);font-size:11px;margin-top:3px}
.wavebadge{font-size:11px;color:#fff;background:#1f6feb;border-radius:20px;padding:1px 9px;margin-left:8px}
.planlink{display:inline-block;background:#10261a;border:1px solid #2d8a4e;color:#3fb950;border-radius:8px;padding:6px 12px;margin-top:10px;font-weight:600}
.planlink:hover{text-decoration:none;background:#15311f}
code{background:#0b0f14;border:1px solid var(--line);border-radius:5px;padding:0 4px;font-family:ui-monospace,Consolas,monospace}
.apidesc{margin:2px 0 12px;color:#c9d1d9;font-size:13.5px;line-height:1.6;border-left:3px solid var(--accent);padding:4px 0 4px 12px;background:#11161d;border-radius:0 6px 6px 0}
.errsec{margin:14px 0 6px}
.errhead{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 5px}
table.errtable{margin:0 0 4px;font-size:12.5px}
table.errtable th{background:#241c22;color:#f0b8b0;position:static}
table.errtable td{vertical-align:top}
.httpcode{display:inline-block;min-width:34px;text-align:center;font-weight:700;font-family:ui-monospace,Consolas,monospace;color:#f85149;background:#2a1416;border:1px solid #5c2327;border-radius:6px;padding:1px 6px}
"""

def render_api(method, endpoint, rows, public=False):
    r0 = rows[0]
    eid, fid = r0.get("epicId", ""), r0.get("featureId", "")
    e = epic_by_id.get(eid, {})
    f = features.get(fid, {})
    color = METHOD_COLORS.get(method.upper(), "#6e7681")
    auth = "🔒 auth" if r0.get("requiresAuth") else ("public" if r0.get("requiresAuth") is False else "")
    manual = r0.get("testability") == "manual"
    parts = []
    parts.append(f'<details class="api"><summary>'
                 f'<span class="m" style="background:{color}">{esc(method)}</span>'
                 f'<span class="uri">{esc(endpoint)}</span>'
                 f'<span class="badge">{esc(auth)}{" · manual" if manual else ""}</span></summary>')
    parts.append('<div class="body">')
    # QA-facing description (what it does + edge cases) — MUST-42.
    if r0.get("description"):
        parts.append(f'<p class="apidesc">{esc(r0.get("description"))}</p>')
    # context
    epic_link = f'<a href="{url(e.get("short_id",""))}">{esc(e.get("short_id",""))}</a> {esc(e.get("title",""))}' if e else "—"
    feat_link = f'<a href="{url(f.get("short_id",""))}">{esc(f.get("short_id",""))}</a> {esc(f.get("title",""))}' if f else "—"
    scs = scenarios.get(fid, []) or []
    sc_html = " ".join(f'<a class="tag" href="{url(s.get("short_id",""))}">{esc(s.get("short_id",""))} · {esc(s.get("title",""))}</a>' for s in scs) or '<span class="muted">—</span>'
    parts.append('<div class="kv">')
    wbadge = (f'<a class="wavebadge" href="test-plan.html">W{esc(r0.get("testWave"))} · test wave</a>'
              if r0.get("testWave") is not None else "")
    parts.append(f'<div class="k">SDK / service</div><div><b>{esc(r0.get("sdk",""))}</b>{wbadge}</div>')
    # Epic / Feature / Scenario are internal ProjexLight planning artifacts (they
    # link to the internal projexlight.com planning tool) — omitted from the
    # public/prod build so customer-facing docs carry no internal traceability.
    if not public:
        parts.append(f'<div class="k">Epic</div><div>{epic_link}</div>')
        parts.append(f'<div class="k">Feature</div><div>{feat_link}</div>')
        parts.append(f'<div class="k">Scenario(s)</div><div>{sc_html}</div>')
    if manual and r0.get("skipReason"):
        parts.append(f'<div class="k">Testability</div><div class="manual">manual — {esc(r0.get("skipReason"))}</div>')
    if r0.get("dependsOn"):
        parts.append(f'<div class="k">Depends on</div><div>{code_block(r0.get("dependsOn"))}</div>')
    if r0.get("sourceFile"):
        parts.append(f'<div class="k">Implemented in</div><div><span class="muted">{esc(r0.get("sourceFile"))}</span></div>')
    if r0.get("generated"):
        parts.append('<div class="k">Status</div><div class="manual">auto-generated from route scan — review payload/response before enabling automated tests</div>')
    def _opts_rows(fo):
        return "".join(
            '<div><code>{k}</code>: {vals}</div>'.format(
                k=esc(k),
                vals=", ".join('<code>{}</code>'.format(esc(str(v))) for v in (vals or [])),
            )
            for k, vals in fo.items()
        )
    # fieldEnums (MUST-39) is the canonical enum map; fieldOptions is the legacy name.
    _enums = r0.get("fieldEnums") or r0.get("fieldOptions")
    if _enums:
        parts.append('<div class="k">Request field options</div>'
                     '<div>{rows}<div class="note">Allowed values (enum / DB-CHECK) for these '
                     '<b>request</b> fields you send — QA should exercise each option.</div></div>'
                     .format(rows=_opts_rows(_enums)))
    if r0.get("serverFieldOptions"):
        parts.append('<div class="k">Server-managed values</div>'
                     '<div>{rows}<div class="note">Set by the server (not sent in the request) — '
                     'these are the possible <b>response</b> values for the entity’s lifecycle; '
                     'QA asserts them in the response / after state-changing calls.</div></div>'
                     .format(rows=_opts_rows(r0["serverFieldOptions"])))
    parts.append(f'<div class="k">Source spec</div><div><span class="muted">{esc(r0.get("file",""))}</span></div>')
    parts.append('</div>')
    # Error codes with explanation (MUST-43) — the handler-derived error catalogue.
    ecs = r0.get("errorCases") or []
    if ecs:
        rows_html = []
        for ec in ecs:
            if not isinstance(ec, dict):
                continue
            st = esc(ec.get("status", ""))
            code = esc(ec.get("code", "") or "—")
            msg = esc(ec.get("message", "") or "—")
            when = esc(ec.get("when", "") or "—")
            rows_html.append(
                f'<tr><td><span class="httpcode">{st}</span></td>'
                f'<td><code>{code}</code></td><td>{msg}</td><td>{when}</td></tr>')
        if rows_html:
            parts.append('<div class="errsec"><div class="errhead">Error responses</div>'
                         '<table class="errtable"><tr><th>HTTP</th><th>Code</th>'
                         '<th>Message</th><th>When it happens</th></tr>'
                         + "".join(rows_html) + '</table>'
                         '<div class="note">Enumerated from the handler — every error the '
                         'endpoint can return, with the condition that triggers it.</div></div>')
    # Status / lifecycle transitions (MUST-40).
    st_obj = r0.get("statusTransitions")
    if st_obj:
        if isinstance(st_obj, dict) and not any(k in st_obj for k in ("flow", "transitions")):
            trs = "".join(
                f'<tr><td><code>{esc(k)}</code></td><td>{esc(v)}</td></tr>'
                for k, v in st_obj.items())
            parts.append('<div class="errsec"><div class="errhead">Status transitions</div>'
                         '<table class="errtable"><tr><th>Transition</th><th>Triggered by</th></tr>'
                         + trs + '</table></div>')
        else:
            parts.append('<div class="errsec"><div class="errhead">Status transitions</div>'
                         f'<div>{code_block(st_obj)}</div></div>')
    # per test case
    for r in rows:
        title = r.get("case") or "request"
        parts.append(f'<div style="margin-top:14px"><b>{esc(title)}</b> '
                     f'<span class="muted">→ expects HTTP {esc(r.get("expectedStatus",""))}</span></div>')
        parts.append('<div class="kv">')
        parts.append(f'<div class="k">Path params</div><div>{code_block(r.get("pathParams"))}</div>')
        parts.append(f'<div class="k">Payload (template)</div><div>{code_block(r.get("payload"))}</div>')
        if r.get("exampleRequest"):
            parts.append(f'<div class="k">Example request</div><div>{code_block(r.get("exampleRequest"))}</div>')
        # Expected output: illustrative example body QA should assert (standard envelope).
        parts.append(f'<div class="k ok">Expected output ✓</div>'
                     f'<div>{code_block(r.get("exampleResponse"))}'
                     f'<div class="note">Illustrative — standard <code>{{success,data}}</code> '
                     f'envelope derived from the request contract; assert shape + HTTP '
                     f'{esc(r.get("expectedStatus",""))}.</div></div>')
        if r.get("exampleError"):
            ee = r.get("exampleError")
            parts.append(f'<div class="k err">On error</div>'
                         f'<div>{code_block(ee.get("body") if isinstance(ee,dict) else ee)}'
                         f'<div class="note">e.g. HTTP {esc(ee.get("http","")) if isinstance(ee,dict) else ""}</div></div>')
        # original runner assertion (minimal), kept for traceability
        if r.get("expectedResponse"):
            parts.append(f'<div class="k">Runner assertion</div><div>{code_block(r.get("expectedResponse"))}</div>')
        parts.append('</div>')
    parts.append('</div></details>')
    return "".join(parts)

# ---- build page ----
# public=True is the customer/prod build: it omits the internal ProjexLight
# planning surface (the Epic index, the "Epics" sidebar entry, the epics stat,
# and the per-API Epic/Feature/Scenario rows — all of which link to the internal
# projexlight.com planning tool). public=False keeps them for the internal QA copy.
def build_page(public=False):
    P = []
    P.append(f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
             f'<meta name="viewport" content="width=device-width,initial-scale=1">'
             f'<title>ProjexCloud API Reference</title><style>{CSS}</style></head><body>')
    P.append('<div class="layout">')

    # sidebar
    P.append('<aside><a href="/" title="Back to ProjexCloud" '
             'style="display:flex;align-items:center;gap:9px;padding:0;margin:0 0 10px;text-decoration:none;color:var(--ink)">'
             '<span style="width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#1A51C7,#3f74e8);'
             'display:grid;place-items:center;flex:none">'
             '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 19V5h6.5a4.5 4.5 0 0 1 0 9H9.5" '
             'stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
             '<span style="font-weight:700;font-size:15px">ProjexCloud API</span></a>'
             '<div class="sub">v3.1 · API reference</div>')
    P.append('<h2>SDKs / services</h2>')
    for s in sdk_names:
        P.append(f'<a href="#{sdk_anchor(s)}">{esc(s)} <span class="cnt">({len(by_sdk[s])})</span></a>')
    if not public:
        P.append('<h2>Epics</h2><a href="#epics">All 34 epics ▾</a>')
    P.append('</aside>')

    # main
    P.append('<main>')
    src_note = ('Generated from <code>tests/api_definitions/</code>.' if public
                else 'Generated from <code>tests/api_definitions/</code> + ProjexLight epics/features/scenarios.')
    stats = [
        f'<div class="stat"><b>{len(sdk_names)}</b><span>SDKs / services</span></div>',
        f'<div class="stat"><b>{total_apis}</b><span>documented APIs</span></div>',
        f'<div class="stat"><b>{len(apis)}</b><span>test cases</span></div>',
    ]
    if not public:
        stats.append(f'<div class="stat"><b>{len(documented_epics)} / {len(epic_by_id)}</b><span>epics with APIs</span></div>')
    P.append('<div class="hero"><h1>ProjexCloud — API Reference</h1>'
             '<p>Every documented API by SDK: URI, method, auth, payload, parameters, expected response, '
             'the enumerated <b>error responses</b> (code + when it happens) and any <b>status transitions</b>. '
             + src_note + '</p>'
             '<div class="stats">' + "".join(stats) + '</div>'
             '<a class="planlink" href="test-plan.html">▶ QA Test Plan — dependency-ordered test waves &amp; what to test first ↗</a>'
             '</div>')

    # epic index (internal only)
    if not public:
        P.append('<h2 class="sdk" id="epics">Epic index (34)</h2>')
        P.append('<table><tr><th>Epic</th><th>Title</th><th>Primary SDK / source</th><th># documented APIs</th></tr>')
        for eid, e in sorted(epic_by_id.items(), key=lambda kv: kv[1].get("short_id", "ZZ")):
            n = epic_api_count.get(eid, 0)
            link = f'<a href="{url(e.get("short_id",""))}">{esc(e.get("short_id",""))}</a>'
            sm = esc(e.get("source_module") or "—")
            nb = f'{n}' if n else '<span class="muted">— (no automated API spec)</span>'
            P.append(f'<tr><td>{link}</td><td>{esc(e.get("title",""))}</td><td>{sm}</td><td>{nb}</td></tr>')
        P.append('</table>')

    # per-SDK sections
    for s in sdk_names:
        P.append(f'<h2 class="sdk" id="{sdk_anchor(s)}">{esc(s)}</h2>')
        P.append(f'<div class="sdkmeta">{len(by_sdk[s])} API(s)</div>')
        for (method, endpoint) in sorted(by_sdk[s].keys(), key=lambda x: (x[1], x[0])):
            P.append(render_api(method, endpoint, by_sdk[s][(method, endpoint)], public=public))

    P.append('</main></div></body></html>')
    return "".join(P)

os.makedirs(OUT_DIR, exist_ok=True)
out = os.path.join(OUT_DIR, "index.html")
internal_html = build_page(public=False)
with open(out, "w", encoding="utf-8") as f:
    f.write(internal_html)

# Mirror the PUBLIC build (no internal epic/feature/scenario references) into the
# customer-facing portals — reachable at /docs/api/index.html (same static-docs
# pattern as /docs/user/*.html). Kept in sync on every regeneration.
public_html = build_page(public=True)
PORTAL_DIRS = [
    os.path.join(ROOT, "apps", "tenant-workspace", "public", "docs", "api"),
    os.path.join(ROOT, "apps", "tenant-admin", "public", "docs", "api"),
]
for pdir in PORTAL_DIRS:
    os.makedirs(pdir, exist_ok=True)
    with open(os.path.join(pdir, "index.html"), "w", encoding="utf-8") as f:
        f.write(public_html)

print(f"wrote {out} (full) + portal mirror (public, no epics) | "
      f"sdks={len(sdk_names)} apis={total_apis} cases={len(apis)} epics={len(epic_by_id)}")
