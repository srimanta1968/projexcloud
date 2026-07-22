"""Generate the machine-readable ProjexCloud SDK catalog (sdk-catalog.json).

This is PRD-FR1 / milestone M1: a single, versioned, public artifact describing
every SDK and every API — the thing a developer downloads (Track A · Direct) or
that ProjexLight bundles into a CLI export (Track B · Accelerated) so an AI
coding tool can discover all 538 APIs and decide reuse-vs-generate per capability.

It reuses the EXACT same source of truth as the API reference
(scripts/qa-matrix/qa-apis.json) so the two never drift. It writes:

  docs/v3.1/api_docs/sdk-catalog.json                 (published next to the API reference)
  apps/<portal>/public/docs/api/sdk-catalog.json      (served + downloadable from the portals)
  <ai-appgen>/mcp/dist/data/sdk-catalog.json          (bundled into every CLI export — if present)

Per-SDK / per-API schema follows PRD §6.1. Group membership + counts reconcile
exactly to the Developer Hub catalog table (75 SDKs / 538 APIs across 9 groups).

Re-run whenever qa-apis.json changes (same cadence as build_api_docs.py).
"""
import os
import json
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "qa-apis.json")

# Catalog version = the QA snapshot date. Kept as a constant (not today()) so
# reruns are reproducible and the version only moves when someone bumps it.
VERSION = "2026.07.21"
# Configurable so a self-hosted ProjexCloud can publish its OWN catalog with its own
# domain: SDK_GATEWAY_BASE_URL=https://projexcloud.acme.com python build_sdk_catalog.py
GATEWAY_BASE_URL = os.getenv("SDK_GATEWAY_BASE_URL", "https://cloud.projexlight.com").rstrip("/")
# Where the human API reference is served (for per-SDK deep links).
DOCS_BASE = GATEWAY_BASE_URL + "/workspace/docs/api/index.html"

# Optional ProjexLight MCP toolkit path — the catalog is bundled into every CLI
# export from here (PRD-FR2 / M2). Written only if the directory already exists.
AI_APPGEN_DATA = os.path.abspath(os.path.join(ROOT, "..", "..", "ai-appgen", "mcp", "dist", "data"))

# ── 9 business groups → their member SDKs (authoritative; reconciles to the hub
#    catalog table: 20/133, 8/111, 8/68, 10/56, 6/55, 7/53, 11/28, 1/18, 4/16). ──
GROUPS = [
    ("Platform & Multi-Tenancy", [
        "api-gateway", "contracts", "pool-federation-runtime", "sdk-asset",
        "sdk-assignment", "sdk-command", "sdk-device", "sdk-diagnostic-telemetry",
        "sdk-dispatch", "sdk-feature-flags", "sdk-geo", "sdk-media", "sdk-pool-router",
        "sdk-resource-registry", "sdk-storm", "sdk-tenant", "sdk-tenant-lifecycle",
        "sdk-webhook", "sdk-workflow", "telemetry",
    ]),
    ("Outreach & Communication", [
        "sdk-sequence", "sdk-scheduling", "sdk-deliverability", "sdk-notification",
        "sdk-offer-catalog", "sdk-handoff", "sdk-incident", "connector-twilio-voice",
    ]),
    ("CRM & Engagement", [
        "sdk-crm", "sdk-engagement", "sdk-lead-scoring", "sdk-campaign",
        "sdk-content", "sdk-service-request", "sdk-event", "sdk-social",
    ]),
    ("Governance, Consent & Security", [
        "sdk-consent", "sdk-rebac", "sdk-policy", "sdk-data-rights", "sdk-vault",
        "sdk-secrets", "sdk-audit", "sdk-approval", "sdk-evidence", "sdk-trace",
    ]),
    ("Identity & Access (AIM)", [
        "sdk-identity", "sdk-persona", "sdk-identity-resolver", "sdk-api-keys",
        "sdk-principal-token", "sdk-profile",
    ]),
    ("AI & Agents", [
        "sdk-agent-runtime", "sdk-ai-gateway", "sdk-mcp-bridge", "semantic-service",
        "sdk-taxonomy", "sdk-ingest", "sdk-search",
    ]),
    ("Native HDK (mobile / edge)", [
        "hdk-camera", "hdk-diagnostic", "hdk-idp", "hdk-image-editor", "hdk-map",
        "hdk-measure", "hdk-permissions", "hdk-scanner", "hdk-sync",
        "hdk-video-editor", "hdk-watermark",
    ]),
    ("Connectors & Integration", ["sdk-connectors"]),
    ("Billing, Metering & Analytics", ["sdk-billing", "sdk-payment", "sdk-meter", "sdk-analytics"]),
]

# Per-SDK one-line summary + discovery keywords (reuse_when). These drive an AI
# builder's "which SDK covers X?" matching, so keep the keywords capability-oriented.
SDK_META = {
    # Platform & Multi-Tenancy
    "api-gateway": ("Platform gateway: admin ops, active-active profiles, pool federation, health, cross-cutting endpoints", ["gateway", "admin", "platform", "health", "routing", "active-active", "federation"]),
    "contracts": ("Shared event/data contracts and schema registry", ["contract", "schema", "event contract", "registry"]),
    "pool-federation-runtime": ("Multi-region pool federation runtime and failover drills", ["federation", "multi-region", "pool", "failover", "drill", "region"]),
    "sdk-asset": ("Digital asset records and lifecycle", ["asset", "file", "attachment", "resource"]),
    "sdk-assignment": ("Generic assignment of work/records to owners", ["assignment", "assign", "owner", "allocation"]),
    "sdk-command": ("Command bus / imperative operation dispatch", ["command", "action", "dispatch", "operation"]),
    "sdk-device": ("Device registry, posture, and management", ["device", "hardware", "posture", "registration", "mobile device"]),
    "sdk-diagnostic-telemetry": ("Diagnostic telemetry ingestion and health signals", ["diagnostic", "telemetry", "health", "metrics", "signal"]),
    "sdk-dispatch": ("Dispatch/queue of jobs to workers", ["dispatch", "queue", "job", "worker", "routing"]),
    "sdk-feature-flags": ("Feature flags, targeting, and rollout", ["feature flag", "toggle", "rollout", "experiment", "targeting"]),
    "sdk-geo": ("Geospatial: geocoding, regions, distance, merge", ["geo", "location", "geocode", "address", "distance", "region", "map"]),
    "sdk-media": ("Media storage and transcoding (blob service)", ["media", "image", "video", "upload", "blob", "storage", "transcode"]),
    "sdk-pool-router": ("Tenant→pool routing resolution", ["pool", "routing", "tenant routing", "shard", "resolve"]),
    "sdk-resource-registry": ("Resource ownership registry (GitOps, no-owner-no-resource)", ["resource", "ownership", "registry", "owner", "gitops"]),
    "sdk-storm": ("Storm/load event ingestion endpoint", ["storm", "load", "spike", "event ingest"]),
    "sdk-tenant": ("Tenant records, settings, and membership", ["tenant", "organization", "workspace", "account", "multi-tenant"]),
    "sdk-tenant-lifecycle": ("Tenant provisioning, suspension, and offboarding lifecycle", ["tenant lifecycle", "provisioning", "onboarding", "suspend", "offboard"]),
    "sdk-webhook": ("Outbound webhooks: endpoints, deliveries, signing", ["webhook", "callback", "event delivery", "subscription", "signature"]),
    "sdk-workflow": ("Durable workflow/saga orchestration", ["workflow", "saga", "orchestration", "state machine", "process", "steps"]),
    "telemetry": ("Platform telemetry endpoint", ["telemetry", "metrics", "observability"]),
    # Outreach & Communication
    "sdk-sequence": ("Multi-touch outreach sequences/cadences: steps, enrollment, advancement", ["sequence", "cadence", "drip", "outreach", "follow-up", "multi-touch", "enrollment"]),
    "sdk-scheduling": ("Calendar, appointments, availability, booking, no-show, public booking links", ["scheduling", "appointment", "booking", "calendar", "availability", "meeting", "no-show", "reschedule"]),
    "sdk-deliverability": ("Email/SMS deliverability: domains, warmup, suppression, bounce/complaint handling", ["deliverability", "email", "domain", "warmup", "suppression", "bounce", "spam", "dkim", "spf"]),
    "sdk-notification": ("Multi-channel notifications (email/SMS/push/in-app) + provider adapters + templates", ["notification", "email", "sms", "push", "in-app", "alert", "message", "template", "provider"]),
    "sdk-offer-catalog": ("Offers, quotes, pricing, feature-status matrix, publish gating", ["offer", "quote", "pricing", "catalog", "proposal", "package", "plan"]),
    "sdk-handoff": ("Human/agent handoff sagas — route, accept, resolve work", ["handoff", "escalation", "transfer", "routing", "assignment", "agent handoff"]),
    "sdk-incident": ("Incident tickets: create, triage, assign, status transitions, audit", ["incident", "ticket", "triage", "outage", "on-call", "alerting"]),
    "connector-twilio-voice": ("Twilio programmable voice: calls, IVR, recordings, consent-aware dialing", ["voice", "call", "phone", "twilio", "ivr", "dial", "telephony", "recording"]),
    # CRM & Engagement
    "sdk-crm": ("Contacts, deals, pipelines, and activities (canonical CRM)", ["crm", "contact", "deal", "lead", "pipeline", "opportunity", "account", "activity"]),
    "sdk-engagement": ("Engagement events/timeline across channels", ["engagement", "timeline", "interaction", "activity", "touchpoint"]),
    "sdk-lead-scoring": ("Lead scoring models, scoring, and next-best-action", ["lead scoring", "score", "ml model", "next best action", "prioritize", "ranking"]),
    "sdk-campaign": ("Marketing campaigns and membership", ["campaign", "marketing", "blast", "audience", "segment"]),
    "sdk-content": ("Content items, templates, and rendering", ["content", "template", "cms", "copy"]),
    "sdk-service-request": ("Service requests / support tickets", ["service request", "ticket", "support", "case", "request"]),
    "sdk-event": ("Domain event store / event sourcing", ["event", "event store", "domain event", "stream"]),
    "sdk-social": ("Social profiles and posting", ["social", "post", "profile", "social media"]),
    # Governance, Consent & Security
    "sdk-consent": ("Consent capture, purpose binding, revocation, consent-gated auth", ["consent", "opt-in", "opt-out", "gdpr", "purpose", "permission", "privacy"]),
    "sdk-rebac": ("Relationship-based access control (ReBAC) graph", ["rebac", "authorization", "relationship", "access control", "permission", "graph"]),
    "sdk-policy": ("Policy decision point (ABAC/PDP) with obligations", ["policy", "abac", "pdp", "authorization", "decision", "rule", "obligation"]),
    "sdk-data-rights": ("Data subject rights (DSAR): access, erasure, portability", ["data rights", "dsar", "gdpr", "erasure", "right to be forgotten", "subject access", "privacy"]),
    "sdk-vault": ("Encrypted vault for secrets/keys (envelope encryption)", ["vault", "secret", "encryption", "key", "kms", "envelope"]),
    "sdk-secrets": ("Secret storage and retrieval", ["secret", "credential", "token", "secure store"]),
    "sdk-audit": ("Tamper-evident audit chain / audit log", ["audit", "audit log", "compliance", "trail", "tamper-evident", "history"]),
    "sdk-approval": ("Approval workflows, multi-step sign-off, audited break-glass", ["approval", "sign-off", "review", "break-glass", "gate", "authorization workflow"]),
    "sdk-evidence": ("Evidence capture and chain-of-custody", ["evidence", "chain of custody", "proof", "forensic"]),
    "sdk-trace": ("Distributed trace / lineage records", ["trace", "lineage", "span", "distributed tracing", "provenance"]),
    # Identity & Access (AIM)
    "sdk-identity": ("Six-layer canonical identity: persons, credentials, authentication", ["identity", "user", "auth", "login", "person", "credential", "authentication", "account"]),
    "sdk-persona": ("Personas — role-scoped identity facets (L4)", ["persona", "role", "identity facet", "actor", "profile role"]),
    "sdk-identity-resolver": ("Identity resolution / EMPI / MDM matching and merge", ["identity resolution", "empi", "mdm", "match", "dedupe", "merge", "golden record"]),
    "sdk-api-keys": ("API key issuance, rotation, and scopes", ["api key", "token", "credential", "key rotation", "scope", "service account"]),
    "sdk-principal-token": ("Minted, audience-bound platform principal tokens", ["principal token", "service identity", "internal token", "audience", "minted token"]),
    "sdk-profile": ("User/persona profiles and preferences", ["profile", "preferences", "user profile", "settings"]),
    # AI & Agents
    "sdk-agent-runtime": ("Agent runtime: plan/execute, capability graph, capability tokens", ["agent", "ai agent", "runtime", "plan", "execute", "autonomous", "capability", "tool"]),
    "sdk-ai-gateway": ("Multi-LLM AI gateway with tenant BYOK provider keys", ["ai", "llm", "openai", "anthropic", "model", "completion", "byok", "provider key", "inference"]),
    "sdk-mcp-bridge": ("MCP bridge — expose tools to agents via the Model Context Protocol", ["mcp", "tool", "agent tool", "bridge", "model context protocol"]),
    "semantic-service": ("Semantic/ontology + embeddings + vector search (RAG)", ["semantic", "embedding", "vector", "ontology", "similarity", "rag", "knowledge"]),
    "sdk-taxonomy": ("Taxonomies, categories, and classification", ["taxonomy", "category", "classification", "tag", "hierarchy"]),
    "sdk-ingest": ("Data ingestion pipelines", ["ingest", "ingestion", "import", "etl", "pipeline", "load data"]),
    "sdk-search": ("Search / query across resources", ["search", "query", "find", "full-text", "lookup"]),
    # Native HDK (mobile / edge)
    "hdk-camera": ("On-device camera capture (HDK)", ["camera", "capture", "photo", "scan", "mobile camera"]),
    "hdk-diagnostic": ("On-device diagnostics (HDK)", ["diagnostic", "device diagnostic", "hardware check"]),
    "hdk-idp": ("On-device identity/document proofing (HDK)", ["idp", "id verification", "document proofing", "kyc", "id scan"]),
    "hdk-image-editor": ("On-device image editing (HDK)", ["image editor", "crop", "edit image", "annotate"]),
    "hdk-map": ("On-device maps (HDK)", ["map", "navigation", "location", "offline map"]),
    "hdk-measure": ("On-device AR measurement (HDK)", ["measure", "ar", "dimension", "distance", "measurement"]),
    "hdk-permissions": ("On-device permission prompts (HDK)", ["permissions", "device permission", "access prompt"]),
    "hdk-scanner": ("On-device barcode/QR scanner (HDK)", ["scanner", "barcode", "qr", "scan code"]),
    "hdk-sync": ("Offline-first data sync (HDK)", ["sync", "offline", "offline-first", "replication", "conflict"]),
    "hdk-video-editor": ("On-device video editing (HDK)", ["video editor", "trim", "edit video"]),
    "hdk-watermark": ("On-device watermarking (HDK)", ["watermark", "stamp", "overlay", "brand image"]),
    # Connectors & Integration
    "sdk-connectors": ("Enterprise connector framework (Salesforce, Slack, M365, Snowflake, …)", ["connector", "integration", "salesforce", "slack", "m365", "snowflake", "sync", "third-party", "external system"]),
    # Billing, Metering & Analytics
    "sdk-billing": ("Invoicing and billing", ["billing", "invoice", "charge", "subscription", "bill"]),
    "sdk-payment": ("Payments and payment methods", ["payment", "pay", "card", "stripe", "checkout", "transaction"]),
    "sdk-meter": ("Usage metering / metered events", ["meter", "usage", "metering", "consumption", "quota", "usage-based"]),
    "sdk-analytics": ("Analytics rollups and reporting", ["analytics", "report", "metrics", "dashboard", "aggregate", "insight"]),
}


def sdk_anchor(s):
    return "sdk-" + "".join(c if c.isalnum() else "-" for c in s.lower())


def first_sentence(txt):
    if not txt:
        return ""
    s = txt.strip().split(". ")[0].strip()
    return (s[:200]).rstrip(".") if s else ""


def payload_shape(rec):
    """Top-level field names of the request body (shape, not values)."""
    src = rec.get("exampleRequest")
    if not isinstance(src, dict):
        src = rec.get("payload")
    return sorted(src.keys()) if isinstance(src, dict) else []


# ── Platform-internal SDKs / endpoints NOT reusable by a generated TENANT app ──
# Admin routes (/admin/, /api/admin/) self-guard with the ADMIN_OPS_TOKEN operator
# secret and reject a tenant JWT; the SDKs below are platform ops / internal plumbing.
# They are excluded from this REUSE catalog so codegen never emits an integration a
# tenant token can't call. (The human API reference, build_api_docs.py, keeps all 538.)
PLATFORM_INTERNAL_SDKS = {
    "api-gateway",             # platform admin ops (active-active, federation) — ADMIN_OPS_TOKEN
    "pool-federation-runtime", # multi-region failover ops
    "sdk-pool-router",         # internal tenant->pool routing
    "sdk-principal-token",     # internal minted platform tokens
    "sdk-resource-registry",   # GitOps ownership registry (ops)
    "sdk-storm",               # load/spike ingest (platform)
    "telemetry",               # platform telemetry
    "contracts",               # internal event/schema contracts
}


def is_admin_endpoint(endpoint):
    return endpoint.startswith("/admin/") or endpoint.startswith("/api/admin/")


def main():
    apis = json.load(open(SRC, encoding="utf-8"))

    # sdk -> (method, endpoint) -> [records(cases)]
    by_sdk = defaultdict(lambda: defaultdict(list))
    for r in apis:
        by_sdk[r.get("sdk") or "(unknown)"][(r["method"], r["endpoint"])].append(r)

    sdk_to_group = {sdk: name for name, sdks in GROUPS for sdk in sdks}

    # Guard: every SDK present in the data must be mapped, and vice-versa.
    unmapped = sorted(set(by_sdk) - set(sdk_to_group))
    missing = sorted(set(sdk_to_group) - set(by_sdk))
    if unmapped:
        raise SystemExit(f"ERROR: SDKs in qa-apis.json not assigned to a group: {unmapped}")
    if missing:
        raise SystemExit(f"ERROR: grouped SDKs absent from qa-apis.json (stale mapping): {missing}")

    def sdk_entry(sdk):
        summary, reuse_when = SDK_META.get(sdk, (sdk.replace("-", " ").title(), [sdk]))
        endpoints = by_sdk[sdk]
        apis_out = []
        for (method, endpoint) in sorted(endpoints.keys(), key=lambda x: (x[1], x[0])):
            if is_admin_endpoint(endpoint):
                continue  # admin-guarded (ADMIN_OPS_TOKEN) — not tenant-reusable
            recs = endpoints[(method, endpoint)]
            rep = recs[0]
            field_enums = {}
            depends_on = []
            for rc in recs:
                fe = rc.get("fieldEnums")
                if isinstance(fe, dict):
                    field_enums.update(fe)
                for d in (rc.get("dependsOn") or []):
                    if d not in depends_on:
                        depends_on.append(d)
            apis_out.append({
                "method": method,
                "endpoint": endpoint,
                "requiresAuth": bool(rep.get("requiresAuth", True)),
                "summary": rep.get("case") or first_sentence(rep.get("description", "")),
                "payload_shape": payload_shape(rep),
                "fieldEnums": field_enums,
                "dependsOn": depends_on,
            })
        return {
            "sdk": sdk,
            "group": sdk_to_group[sdk],
            "summary": summary,
            "reuse_when": reuse_when,
            "api_count": len(apis_out),
            "docs_url": f"{DOCS_BASE}#{sdk_anchor(sdk)}",
            "apis": apis_out,
        }

    groups_out = []
    excluded_sdks = sorted(s for s in by_sdk if s in PLATFORM_INTERNAL_SDKS)
    for name, sdks in GROUPS:
        entries = [sdk_entry(s) for s in sorted(sdks, key=str.lower)
                   if s in by_sdk and s not in PLATFORM_INTERNAL_SDKS]
        # drop any SDK left with no endpoints after admin-endpoint filtering
        entries = [e for e in entries if e["api_count"] > 0]
        if entries:
            groups_out.append({
                "name": name,
                "sdk_count": len(entries),
                "api_count": sum(e["api_count"] for e in entries),
                "sdks": entries,
            })

    catalog = {
        "version": VERSION,
        "gateway_base_url": GATEWAY_BASE_URL,
        "auth": "Authenticate as a tenant (login -> JWT) and send Authorization: Bearer <token> on every call.",
        "api_reference": DOCS_BASE,
        "sdk_count": sum(g["sdk_count"] for g in groups_out),
        "api_count": sum(g["api_count"] for g in groups_out),
        "groups": groups_out,
    }

    # Tier-1 COMPACT INDEX (the "SDK map"): name + one-line usage + reuse_when keywords
    # + api_count, NO payloads/enums. ~3k tokens vs ~94k for the full catalog. The codegen
    # LLM reads this once to decide WHICH sdk/endpoint, then fetches one endpoint's full
    # spec via the get_sdk_api tool (or the full sdk-catalog.json). Progressive disclosure.
    index = {
        "version": VERSION,
        "gateway_base_url": GATEWAY_BASE_URL,
        "note": ("Compact SDK map for capability discovery. Match a capability to an SDK via "
                 "reuse_when, then fetch that endpoint's full spec (payload/fields) with the "
                 "get_sdk_api tool or from sdk-catalog.json. Do not rebuild what an SDK covers."),
        "auth": catalog["auth"],
        "sdk_count": catalog["sdk_count"],
        "api_count": catalog["api_count"],
        # docs_url intentionally omitted (human-only; saves tokens) — the tool / full
        # catalog carry it. The LLM decides purely from summary + reuse_when.
        "sdks": [
            {"sdk": s["sdk"], "group": s["group"], "summary": s["summary"],
             "reuse_when": s["reuse_when"], "api_count": s["api_count"]}
            for g in groups_out for s in g["sdks"]
        ],
    }

    def _targets(basename):
        ts = [
            os.path.join(ROOT, "docs", "v3.1", "api_docs", basename),
            os.path.join(ROOT, "apps", "tenant-workspace", "public", "docs", "api", basename),
            os.path.join(ROOT, "apps", "tenant-admin", "public", "docs", "api", basename),
        ]
        if os.path.isdir(AI_APPGEN_DATA):
            ts.append(os.path.join(AI_APPGEN_DATA, basename))
        return ts

    written = []
    for obj, basename in ((catalog, "sdk-catalog.json"), (index, "sdk-catalog-index.json")):
        # Index is minified (LLM reads it into context — every token counts); the full
        # catalog stays pretty-printed (also browsed/diffed by humans).
        blob = (json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                if basename == "sdk-catalog-index.json"
                else json.dumps(obj, indent=2, ensure_ascii=False))
        for t in _targets(basename):
            os.makedirs(os.path.dirname(t), exist_ok=True)
            with open(t, "w", encoding="utf-8") as f:
                f.write(blob)
            written.append((t, len(blob)))

    print(f"wrote sdk-catalog.json + sdk-catalog-index.json v{VERSION} | "
          f"{catalog['sdk_count']} SDKs / {catalog['api_count']} APIs / {len(groups_out)} groups")
    for g in groups_out:
        print(f"  {g['sdk_count']:2d} SDKs {g['api_count']:4d} APIs  {g['name']}")
    idx_kb = next((b for t, b in written if t.endswith('sdk-catalog-index.json')), 0) / 1024
    full_kb = next((b for t, b in written if t.endswith('sdk-catalog.json')), 0) / 1024
    print(f"sizes: full={full_kb:.0f}KB  index={idx_kb:.0f}KB (~{idx_kb*1000/4/1000:.0f}k tok)")
    print("targets:")
    for t, _ in written:
        print(f"  {t}")


if __name__ == "__main__":
    main()
