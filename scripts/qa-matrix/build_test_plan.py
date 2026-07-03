"""Generate docs/v3.1/api_docs/test-plan.html — the QA test execution plan.

Answers, for the whole API surface:
  * which SDK is tested FIRST and why (the dependency-root),
  * the chronological wave order of every SDK based on dependency + Wave/Phase epics,
  * per wave: prerequisites, the SDKs involved, API counts, and the expected-output
    contract QA should assert.

Sourced from the enriched qa-apis.json (run enrich_qa_apis.py first) so the plan and the
API reference never drift. Links back to index.html#<sdk-anchor> for per-API detail.
"""
import json
import os
import html
from collections import defaultdict

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "docs", "v3.1", "api_docs", "test-plan.html")
apis = json.load(open(os.path.join(HERE, "qa-apis.json"), encoding="utf-8"))


def esc(v):
    return html.escape(str(v), quote=True)


def sdk_anchor(s):
    return "sdk-" + "".join(c if c.isalnum() else "-" for c in s.lower())


# ---- aggregate per wave / per sdk -------------------------------------------------
wave_label = {}
wave_sdks = defaultdict(set)
sdk_stats = defaultdict(lambda: {"cases": 0, "apis": set(), "auth": 0, "deps": set()})
endpoint_owner = {}
for r in apis:
    endpoint_owner[(r["method"], r["endpoint"])] = r.get("sdk")
for r in apis:
    w = r["testWave"]
    wave_label[w] = r["waveLabel"]
    sdk = r.get("sdk") or "(unknown)"
    wave_sdks[w].add(sdk)
    st = sdk_stats[sdk]
    st["cases"] += 1
    st["apis"].add((r["method"], r["endpoint"]))
    if r.get("requiresAuth"):
        st["auth"] += 1
    for dep in (r.get("dependsOn") or []):
        st["deps"].add(dep)

# cross-SDK prerequisite roll-up per wave (which earlier SDKs feed this one)
import re
def dep_sdk(dep):
    if not isinstance(dep, str) or " " not in dep:
        return None
    mth, path = dep.split(" ", 1)
    p = re.sub(r":[^/]+", "", path).rstrip("/")
    for (m, e), s in endpoint_owner.items():
        ne = re.sub(r":[^/]+", "", e).rstrip("/")
        if m == mth and (ne == p or "/api" + ne == p):
            return s
    return None


WAVE_INTENT = {
    0: ("Stand up the spine first — nothing else can be exercised without a tenant, an "
        "authenticated principal and the pool router. <b>Start here: <code>sdk-identity</code> "
        "(auth/register)</b>; 49 downstream APIs cache its token/ids. Gate the whole suite on W0 going green."),
    1: ("Cross-cutting infrastructure every later wave emits into: secret storage, audit log, "
        "metering and telemetry/trace. Verify writes are persisted and readable before relying on "
        "them as assertions in later waves."),
    2: ("The identity triad — master-data / ABAC policy / consent — plus API keys, MFA and "
        "federation (SAML/SCIM). These gate authorization decisions used from W3 onward."),
    3: ("Canonical business entities (persons, personas, profiles, memberships, devices) and "
        "privacy/data-rights. Depend on W0 auth + W2 policy/consent."),
    4: ("Operational core: billing, payments, approvals, connectors, media, notifications, "
        "search, webhooks, workflows. Depend on entities from W3."),
    5: ("Engagement domain layer (CRM, campaigns, lead-scoring, content, service-requests). "
        "Depends on canonical entities + operational core."),
    6: ("Knowledge & semantic layer, agent runtime, AI gateway, MCP bridge, taxonomy/ingest. "
        "Depends on identity, policy and the connector/operational layers."),
    7: ("Field + Evidence + Hyperscale (current P7 branch): evidence capture, HDK device "
        "surfaces, pool federation. Depends on media, identity and sync."),
    8: ("Governance & authorization (P10): obligation-based PDP, principal token enrichment, "
        "consent-gated access, EMPI, resource ownership. Exercised last — asserts the policy "
        "decisions woven through every earlier wave."),
}

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--ok:#2d8a4e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
main{max-width:1080px;margin:0 auto;padding:28px 30px}
.hero{background:linear-gradient(135deg,#161b22,#1c2735);border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-bottom:22px}
.hero h1{margin:0 0 6px;font-size:24px}.hero p{margin:6px 0;color:var(--muted)}
.first{background:#10261a;border:1px solid var(--ok);border-radius:10px;padding:14px 18px;margin:18px 0}
.first b{color:#3fb950}
table{border-collapse:collapse;width:100%;margin:10px 0 8px;font-size:13px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:#1c2330;color:var(--muted);font-weight:600}
.wave{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:16px 0;overflow:hidden}
.wave>summary{cursor:pointer;list-style:none;padding:14px 18px;display:flex;align-items:center;gap:12px;font-size:16px;font-weight:600}
.wave>summary::-webkit-details-marker{display:none}
.wave[open]>summary{border-bottom:1px solid var(--line)}
.wbody{padding:6px 18px 18px}.intent{color:#c9d1d9;margin:8px 0 14px}
.num{background:#1f6feb;color:#fff;border-radius:8px;min-width:34px;text-align:center;padding:3px 8px;font-size:13px}
.pill{display:inline-block;background:#21262d;border:1px solid var(--line);border-radius:20px;padding:1px 10px;font-size:12px;margin-left:auto;color:var(--muted)}
.tag{display:inline-block;background:#21262d;border:1px solid var(--line);border-radius:6px;padding:1px 8px;font-size:12px;margin:2px}
code{background:#0b0f14;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace}
h2{font-size:15px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.legend{color:var(--muted);font-size:13px}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;color:#c9d1d9}
"""

P = [f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
     f'<meta name="viewport" content="width=device-width,initial-scale=1">'
     f'<title>ProjexCloud — QA Test Plan</title><style>{CSS}</style></head><body><main>']

total_cases = len(apis)
total_apis = len({(r["method"], r["endpoint"]) for r in apis})
n_waves = len(wave_label)
P.append('<div class="hero"><h1>ProjexCloud — API QA Test Plan</h1>'
         '<p>Dependency-ordered execution plan for the full API surface. Each wave lists its '
         'prerequisites, the SDKs it covers and the expected-output contract QA asserts. '
         'Per-API request/response examples live in the '
         '<a href="index.html">API Reference</a>.</p>'
         f'<p><b>{total_apis}</b> APIs · <b>{total_cases}</b> test cases · '
         f'<b>{n_waves}</b> waves</p></div>')

P.append('<div class="first"><b>▶ Start testing here: <code>sdk-identity</code> '
         '(POST /api/auth/register → login).</b> It is the dependency root — 49 downstream APIs '
         'consume the principal token / tenant id it mints (<code>{{cache:...}}</code> references). '
         'Run it, cache the token, then proceed wave by wave. A wave only begins once the prior '
         'wave is green.</div>')

# ---- test environment setup ----
P.append('<h2>Test environment setup</h2>')
P.append('<p class="legend">Bring up the full stack, then exercise the layers in order. '
         'The api-gateway auto-runs every SDK migration on first boot — no manual SQL. '
         'Only the analytics path (Kafka + ClickHouse) needs <code>--full</code>; the SDK-discovery '
         'embedding model runs in-process (no container).</p>')
P.append('<pre>'
         '# 1. Full stack up (Postgres + Redis + Kafka + ClickHouse) + seed\n'
         './scripts/setup/dev-setup.sh --full --seed        # Windows: ./scripts/setup/dev-setup.ps1 -Full -Seed\n\n'
         '# 2. Run all services (gateway, projectors, collectors, discovery, apps)\n'
         'pnpm dev\n\n'
         '# 3. Unit / integration suites (separate terminal) — 97 vitest packages\n'
         'pnpm test\n\n'
         f'# 4. API contract tests (gateway must be up) — {total_cases} tests/api_definitions/*.json\n'
         '#    driven by the ProjexLight runner, wave by wave (W0 -> W8):\n'
         '#    projexlight_start_api_tests / projexlight_run_api_tests / projexlight_get_api_test_status\n\n'
         '# 5. Smoke: every service health endpoint\n'
         'curl http://localhost:3500/health      # api-gateway\n'
         'curl http://localhost:3600/healthz     # registry-mcp (discovery)\n'
         'curl http://localhost:8081/health      # lineage-projector\n'
         'curl http://localhost:8082/health      # semantic-service\n'
         'curl http://localhost:8083/health      # pool-federation-runtime'
         '</pre>')
P.append('<p class="legend"><b>Testing layers:</b> '
         '(1) unit/integration <code>pnpm test</code> · '
         '(2) service smoke/health · '
         f'(3) API contract tests over the {total_cases} api_definitions in the wave order below · '
         '(4) path checks — discovery, and usage&nbsp;event&nbsp;→&nbsp;ClickHouse rollup&nbsp;+&nbsp;Postgres ledger (needs <code>--full</code>) · '
         '(5) deploy artifacts <code>helm lint/template</code>, <code>terraform fmt</code>.</p>')

# ---- expected-output contract (applies to every API) ----
P.append('<h2>Expected-output contract (all APIs)</h2>')
P.append('<p class="legend">Every endpoint returns the standard envelope. QA asserts on this shape '
         'plus the HTTP status documented per API:</p>')
P.append('<pre>Success:  { "success": true,  "data": { ... } | [ ... ] }\n'
         'Error:    { "success": false, "error": "&lt;human-readable reason&gt;" }</pre>')
P.append('<table><tr><th>Method</th><th>Status</th><th>data shape</th></tr>'
         '<tr><td>POST (create)</td><td>201</td><td>created resource: <code>{&lt;resource&gt;_id, …payload, status, created_at, updated_at}</code></td></tr>'
         '<tr><td>POST (action)</td><td>200</td><td>action outcome: <code>{status:"completed", …}</code></td></tr>'
         '<tr><td>GET (one)</td><td>200</td><td>single resource object</td></tr>'
         '<tr><td>GET (list)</td><td>200</td><td><code>data:[ … ]</code> (often with <code>total</code>)</td></tr>'
         '<tr><td>PUT/PATCH</td><td>200</td><td>updated resource</td></tr>'
         '<tr><td>DELETE</td><td>200/204</td><td><code>{success:true}</code></td></tr>'
         '<tr><td>async</td><td>202</td><td><code>{status:"accepted", job_id}</code></td></tr></table>')

# ---- wave order summary table ----
P.append('<h2>Wave order at a glance</h2>')
P.append('<table><tr><th>#</th><th>Wave</th><th>SDKs</th><th>APIs</th><th>Test cases</th></tr>')
for w in sorted(wave_label):
    sdks = sorted(wave_sdks[w])
    napis = sum(len(sdk_stats[s]["apis"]) for s in sdks)
    ncase = sum(sdk_stats[s]["cases"] for s in sdks)
    P.append(f'<tr><td><span class="num">{w}</span></td>'
             f'<td>{esc(wave_label[w].split(" · ",1)[1])}</td>'
             f'<td>{len(sdks)}</td><td>{napis}</td><td>{ncase}</td></tr>')
P.append('</table>')

# ---- per-wave detail ----
for w in sorted(wave_label):
    sdks = sorted(wave_sdks[w])
    napis = sum(len(sdk_stats[s]["apis"]) for s in sdks)
    ncase = sum(sdk_stats[s]["cases"] for s in sdks)
    # prerequisite SDKs from dependsOn that live in earlier waves
    prereqs = set()
    for s in sdks:
        for dep in sdk_stats[s]["deps"]:
            ds = dep_sdk(dep)
            if ds and ds not in sdks:
                prereqs.add(ds)
    open_attr = " open" if w == 0 else ""
    P.append(f'<details class="wave"{open_attr}><summary><span class="num">{w}</span>'
             f'{esc(wave_label[w].split(" · ",1)[1])}'
             f'<span class="pill">{len(sdks)} SDKs · {napis} APIs · {ncase} cases</span></summary>')
    P.append('<div class="wbody">')
    P.append(f'<p class="intent">{WAVE_INTENT.get(w,"")}</p>')
    if w == 0:
        P.append('<p class="legend"><b>Prerequisites:</b> none — this is the root wave.</p>')
    elif prereqs:
        plinks = " ".join(f'<a class="tag" href="index.html#{sdk_anchor(p)}">{esc(p)}</a>'
                          for p in sorted(prereqs))
        P.append(f'<p class="legend"><b>Prerequisites (must be green):</b> {plinks}</p>')
    P.append('<table><tr><th>SDK / service</th><th>APIs</th><th>Cases</th>'
             '<th>Auth-gated</th><th>Detail</th></tr>')
    for s in sdks:
        st = sdk_stats[s]
        P.append(f'<tr><td><b>{esc(s)}</b></td><td>{len(st["apis"])}</td>'
                 f'<td>{st["cases"]}</td><td>{st["auth"]}</td>'
                 f'<td><a href="index.html#{sdk_anchor(s)}">open ↗</a></td></tr>')
    P.append('</table></div></details>')

P.append('<p class="legend" style="margin-top:24px">Regenerate: '
         '<code>python scripts/qa-matrix/enrich_qa_apis.py &amp;&amp; '
         'python scripts/qa-matrix/build_test_plan.py &amp;&amp; '
         'python scripts/qa-matrix/build_api_docs.py</code></p>')
P.append('</main></body></html>')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("".join(P))
print(f"wrote {OUT} | waves={n_waves} apis={total_apis} cases={total_cases}")
