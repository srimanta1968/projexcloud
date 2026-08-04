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

# Sibling consuming projects that keep their own copy of the catalog. LeadFlow's dev-MCP
# resolves SDK reuse questions against this file, so a stale copy there tells a LeadFlow
# developer that a capability does not exist and they write it again — the same failure the
# catalog exists to prevent, just one repo over. Listed here so `python build_sdk_catalog.py`
# refreshes it rather than someone remembering to copy the file across.
SIBLING_MCP_DATA = [
    os.path.abspath(os.path.join(ROOT, "..", "LeadFlow", "mcp-server", "data")),
]

# ── 9 business groups → their member SDKs (authoritative; reconciles to the hub
#    catalog table: 20/133, 8/111, 8/68, 10/56, 6/55, 7/53, 11/28, 1/18, 4/16). ──
GROUPS = [
    ("Platform & Multi-Tenancy", [
        "api-gateway", "contracts", "pool-federation-runtime", "sdk-asset",
        "sdk-config", "registry-mcp",
        "sdk-assignment", "sdk-command", "sdk-device", "sdk-diagnostic-telemetry",
        "sdk-dispatch", "sdk-feature-flags", "sdk-geo", "sdk-media", "sdk-pool-router",
        "sdk-resource-registry", "sdk-storm", "sdk-tenant", "sdk-tenant-lifecycle",
        "sdk-webhook", "sdk-workflow", "telemetry",
    ]),
    ("Outreach & Communication", [
        "sdk-sequence", "sdk-scheduling", "sdk-deliverability", "sdk-notification",
        "sdk-offer-catalog", "sdk-handoff", "sdk-incident", "connector-twilio-voice",
        # P16: omnichannel threading + reply detection is a communication capability,
        # not a CRM one — it threads messages regardless of what the subject is.
        "sdk-conversation",
    ]),
    ("CRM & Engagement", [
        "sdk-crm", "sdk-engagement", "sdk-lead-scoring", "sdk-campaign",
        "sdk-content", "sdk-service-request", "sdk-event", "sdk-social",
        # P16: response-time clocks and who-is-available, both scoped to engagement work.
        "sdk-sla", "sdk-coverage",
    ]),
    ("Data Provenance & Ingest", [
        # P16. Kept as its own group rather than folded into Platform: these four answer
        # "where did this value come from and which one wins", which is the question a
        # developer searches for by name. Buried under a generic group they read as
        # infrastructure and get rebuilt as custom code — the exact cost the catalog exists
        # to prevent.
        "sdk-source-record",   # provenance capture / chain of custody
        "sdk-projection",      # attribute survivorship + explainable replay
        "sdk-import",          # governed bulk import, dry-run and rollback
        "sdk-parsing",         # contact extraction; proposes, persists nothing
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
    ("Billing, Metering & Analytics", [
        "sdk-billing", "sdk-payment", "sdk-meter", "sdk-analytics",
        # P16: prepaid capability credits — metered spend against enrichment providers.
        "sdk-data-credits",
    ]),
]

# Per-SDK one-line summary + discovery keywords (reuse_when). These drive an AI
# builder's "which SDK covers X?" matching, so keep the keywords capability-oriented.
SDK_META = {
    # ── P16 SDKs ──────────────────────────────────────────────────────────────────
    # Keywords are the words a developer types when they HAVE the problem, not the
    # SDK's own vocabulary. Someone about to rebuild provenance searches "where did
    # this come from"; they never search "sdk-source-record", because if they knew it
    # existed they would not be rebuilding it. Falling back to the package name (the
    # default below) is therefore the same as being undiscoverable.
    "sdk-source-record": ("Provenance capture: immutable source records, origin class, raw evidence and chain of custody", ["provenance", "source record", "origin", "attestation", "chain of custody", "where did this come from", "audit trail of a value", "who told us this"]),
    "sdk-projection": ("Attribute-level survivorship: which asserted value wins, with an explainable reason and deterministic replay", ["survivorship", "which value wins", "explain projection", "attribute conflict", "losing assertion", "conflicting data", "replay", "why is this field wrong"]),
    "sdk-import": ("Governed bulk import: column mapping templates, dry run, commit and rollback", ["import", "mapping", "csv", "dry run", "rollback", "bulk upload", "column mapping", "spreadsheet", "data migration"]),
    "sdk-parsing": ("Contact extraction from unstructured text; proposes candidates with evidence spans and persists nothing", ["contact extraction", "smart paste", "business card", "vcard", "email signature", "ocr", "parse contact", "extract from text"]),
    "sdk-conversation": ("Omnichannel threading: unified inbox, reply detection, internal notes and compose guardrails", ["conversation", "thread", "omnichannel", "inbox", "transcript", "internal note", "reply detection", "compose guardrail", "message history"]),
    "sdk-sla": ("Service-level clocks: targets, business hours, pause/resume, breach and escalation", ["sla", "response time", "escalation", "business hours", "breach", "time to first response", "due by", "overdue"]),
    "sdk-coverage": ("Who is available to take work: schedules, PTO, holidays, on-call and capacity", ["coverage", "availability", "pto", "on-call", "capacity", "who is working", "holiday", "out of office", "shift"]),
    "sdk-data-credits": ("Prepaid capability credits: balances, reservation, consumption and top-up against enrichment providers", ["credits", "capability", "enrichment", "provider", "budget", "metered spend", "top up", "quota", "prepaid"]),
    "sdk-config": ("Tenant-scoped configuration values and typed settings resolution", ["config", "setting", "tenant configuration", "preference", "parameter", "feature configuration"]),
    "registry-mcp": ("MCP server registry: tool registration, discovery and invocation brokering", ["mcp", "tool registry", "server registration", "tool discovery", "agent tools"]),

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
    "sdk-tenant": ("Tenant records, settings, and membership", ["tenant", "organization", "workspace", "account", "multi-tenant", "tenant signup", "onboarding", "provisioning", "business unit", "role template", "tenant admin", "isolation tier", "parent tenant", "become a provider", "sub tenant"]),
    "sdk-tenant-lifecycle": ("Tenant provisioning, suspension, and offboarding lifecycle", ["tenant lifecycle", "provisioning", "onboarding", "suspend", "offboard"]),
    "sdk-webhook": ("Outbound webhooks: endpoints, deliveries, signing", ["webhook", "callback", "event delivery", "subscription", "signature"]),
    "sdk-workflow": ("Durable workflow/saga orchestration", ["workflow", "saga", "orchestration", "state machine", "process", "steps"]),
    "telemetry": ("Platform telemetry endpoint", ["telemetry", "metrics", "observability"]),
    # Outreach & Communication
    "sdk-sequence": ("Multi-touch outreach sequences/cadences: steps, enrollment, advancement", ["sequence", "cadence", "drip", "outreach", "follow-up", "multi-touch", "enrollment"]),
    "sdk-scheduling": ("Calendar, appointments, availability, booking, no-show, public booking links", ["scheduling", "appointment", "booking", "calendar", "availability", "meeting", "no-show", "reschedule"]),
    "sdk-deliverability": ("Email/SMS deliverability: domains, warmup, suppression, bounce/complaint handling", ["deliverability", "email", "domain", "warmup", "suppression", "bounce", "spam", "dkim", "spf"]),
    "sdk-notification": ("Multi-channel notifications (email/SMS/push/in-app) + provider adapters + templates", ["notification", "email", "sms", "push", "in-app", "alert", "message", "template", "provider", "frequency cap", "dedup", "quiet hours", "send throttle", "no answer retry", "do not contact too often"]),
    "sdk-offer-catalog": ("Offers, quotes, pricing, feature-status matrix, publish gating", ["offer", "quote", "pricing", "catalog", "proposal", "package", "plan"]),
    "sdk-handoff": ("Human/agent handoff sagas — route, accept, resolve work", ["handoff", "escalation", "transfer", "routing", "assignment", "agent handoff"]),
    "sdk-incident": ("Incident tickets: create, triage, assign, status transitions, audit", ["incident", "ticket", "triage", "outage", "on-call", "alerting"]),
    "connector-twilio-voice": ("Twilio programmable voice: calls, IVR, recordings, consent-aware dialing", ["voice", "call", "phone", "twilio", "ivr", "dial", "telephony", "recording"]),
    # CRM & Engagement
    "sdk-crm": ("Contacts, deals, pipelines, and activities (canonical CRM)", ["crm", "contact", "deal", "lead", "pipeline", "opportunity", "account", "activity"]),
    "sdk-engagement": ("Engagement events/timeline across channels", ["engagement", "timeline", "interaction", "activity", "touchpoint"]),
    "sdk-lead-scoring": ("Lead scoring models, scoring, and next-best-action", ["lead scoring", "score", "ml model", "next best action", "prioritize", "ranking", "firmographic", "intent signal", "company size", "b2b features", "prioritise leads"]),
    "sdk-campaign": ("Marketing campaigns and membership", ["campaign", "marketing", "blast", "audience", "segment"]),
    "sdk-content": ("Content items, templates, and rendering", ["content", "template", "cms", "copy"]),
    "sdk-service-request": ("Service requests / support tickets", ["service request", "ticket", "support", "case", "request"]),
    "sdk-event": ("Domain event store / event sourcing", ["event", "event store", "domain event", "stream"]),
    "sdk-social": ("Social profiles and posting", ["social", "post", "profile", "social media"]),
    # Governance, Consent & Security
    "sdk-consent": ("Consent capture, purpose binding, revocation, consent-gated auth", ["consent", "opt-in", "opt-out", "gdpr", "purpose", "permission", "privacy"]),
    "sdk-rebac": ("Relationship-based access control (ReBAC) graph", ["rebac", "authorization", "relationship", "access control", "permission", "graph", "contextual role", "delegate", "acts on behalf of", "trust state", "evidence", "who may act for whom", "can this user", "ownership", "sharing", "team access"]),
    "sdk-policy": ("Policy decision point (ABAC/PDP) with obligations", ["policy", "abac", "pdp", "authorization", "decision", "rule", "obligation", "access policy", "permit or deny", "attribute based", "conditional access", "guardrail"]),
    "sdk-data-rights": ("Data subject rights (DSAR): access, erasure, portability", ["data rights", "dsar", "gdpr", "erasure", "right to be forgotten", "subject access", "privacy"]),
    "sdk-vault": ("Encrypted vault for secrets/keys (envelope encryption)", ["vault", "secret", "encryption", "key", "kms", "envelope"]),
    "sdk-secrets": ("Secret storage and retrieval", ["secret", "credential", "token", "secure store"]),
    "sdk-audit": ("Tamper-evident audit chain / audit log", ["audit", "audit log", "compliance", "trail", "tamper-evident", "history"]),
    "sdk-approval": ("Approval workflows, multi-step sign-off, audited break-glass", ["approval", "sign-off", "review", "break-glass", "gate", "authorization workflow"]),
    "sdk-evidence": ("Evidence capture and chain-of-custody", ["evidence", "chain of custody", "proof", "forensic"]),
    "sdk-trace": ("Distributed trace / lineage records", ["trace", "lineage", "span", "distributed tracing", "provenance"]),
    # Identity & Access (AIM)
    "sdk-identity": ("Six-layer canonical identity: persons, credentials, authentication", ["identity", "user", "auth", "login", "person", "credential", "authentication", "account", "signup", "sign up", "register", "registration", "sign in", "session", "password", "email verification", "forgot password", "jwt", "bearer token", "who is logged in", "same person across tenants", "one email one person"]),
    "sdk-persona": ("Personas — role-scoped identity facets (L4)", ["persona", "role", "identity facet", "actor", "profile role", "app user", "end user", "member", "seat", "user role", "acting identity", "persona id", "one user many apps", "join another tenant", "switch tenant"]),
    "sdk-identity-resolver": ("Identity resolution / EMPI / MDM matching and merge", ["identity resolution", "empi", "mdm", "match", "dedupe", "merge", "golden record"]),
    "sdk-api-keys": ("API key issuance, rotation, and scopes", ["api key", "token", "credential", "key rotation", "scope", "service account", "application", "client credentials", "machine to machine", "m2m", "secret key", "pk_live", "publishable key", "server to server"]),
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
    "sdk-connectors": ("Enterprise connector framework (Salesforce, Slack, M365, Snowflake, …)", ["connector", "integration", "salesforce", "slack", "m365", "snowflake", "sync", "third-party", "external system", "lead form", "meta", "facebook", "instagram", "linkedin", "tiktok", "google ads", "web chat", "webhook ingest"]),
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


# ── The auth playbook carried INSIDE both catalog artifacts ────────────────────────────
#
# WHY THIS LIVES IN THE CATALOG. An AI coding agent building a tenant app has to solve
# authentication before it can call anything else, and the endpoint list alone does not
# teach it: nothing in "POST /api/auth/register" says that it creates a person but NOT an
# app user, or that signup-tenant is catastrophic if called for an end user, or that the
# API key rides the same Authorization header as the JWT. Left to infer, an agent invents a
# users table and its own login — rebuilding the one thing the platform most needs it not
# to. So the flows ship WITH the map.
#
# Kept terse on purpose: this is loaded into context on every discovery call.
AUTH_PLAYBOOK = {
    "model": (
        "Four principals, each with its own credential: PLATFORM OPERATOR (ADMIN_OPS_TOKEN, "
        "/admin/* only, rejects tenant JWTs); TENANT ADMIN (human, password -> JWT); TENANT "
        "APPLICATION (machine, pk_live_/pk_test_ API key); APP END USER (human, password -> "
        "JWT scoped to an app_id). The gateway is DEFAULT-DENY: every path needs a valid "
        "tenant JWT unless explicitly public."
    ),
    "critical": [
        "The API key and the JWT use the SAME header: 'Authorization: Bearer <value>'. The "
        "gateway distinguishes them by the pk_live_/pk_test_ prefix. There is NO X-API-Key header.",
        "POST /api/auth/signup-tenant provisions an ENTIRE TENANT (org + app + tenant + "
        "membership). NEVER call it to register an end user of an app — use /api/auth/register.",
        "Credential-management routes (/api/applications, /api/api-keys) require a HUMAN JWT and "
        "reject an API key by design: a key that can mint another key cannot be contained.",
        "Do NOT build your own users/roles/sessions tables. identity + persona + tenant + rebac "
        "+ policy already own that; a parallel table breaks tenant isolation and the audit chain.",
        "A human JWT carries NO scopes. Authority is resolved from the persona and its grants at "
        "request time, so a revoked role takes effect immediately rather than at token expiry.",
        "THE SAME IS TRUE OF A MACHINE TOKEN, and this is the step everyone misses: exchanging a "
        "pk_ key via POST /api/auth/token returns a token carrying scopes (e.g. ['crm']) and "
        "actor {kind: service} — and it will STILL 403. The scopes on the token are not the "
        "authority; the credential is bound to a SYNTHETIC PERSONA that starts with NO grants. "
        "You must grant it: POST /api/role-assignments {persona_id, role_template_id}. A valid key plus a successful "
        "token exchange plus 403 on every call is not a broken key — it is an ungranted persona.",
        "Everything downstream keys on persona_id (L4), not on person_id and not on a user_id.",
    ],
    "flows": {
        "tenant_signup": [
            "POST /api/auth/signup-tenant  -> person + alias + credential + org + app + tenant "
            "+ tenant_membership + app_identity + profile band (one transaction)",
            "POST /api/auth/send-verification-email  -> purpose-scoped short-lived token",
            "POST /api/auth/verify-email",
            "POST /api/auth/login  (optional tenant_id selects the membership)  -> six-layer JWT",
        ],
        "register_an_application_and_key": [
            "POST /api/applications                        (human JWT) -> application_id",
            "POST /api/applications/{application_id}/keys  (human JWT) -> pk_live_/pk_test_",
            "POST /api/auth/token                          (public, client_credentials) -> short-lived token",
            "rotate: POST /api/api-keys/{key_id}/rotate | revoke: POST /api/api-keys/{key_id}/revoke",
            "POST /api/role-assignments {persona_id, role_template_id}   <- REQUIRED. The key's synthetic persona has no "
            "grants until you add them, so every call 403s no matter how valid the key is. "
            "persona_id is the key's synthetic_persona_id from the issue call; role_template_id "
            "names a tenant.role_template, whose app_id is an app_id and NOT the application_id above.",
            "environment (live|test) is a property of the APPLICATION, not the key, so a test "
            "app can never mint a credential that reaches production data.",
            "app_id IS NOT application_id. app_id is TEXT (e.g. 'leadflow-dev-af4bd2'), the PK of "
            "tenant.app; tenant.tenant.app_id and tenant.role_template.app_id both REFERENCE it, and "
            "persona.app_identity.app_id carries the same value. application_id is a UUID, the PK of "
            "api_keys.application - the API-KEY CLIENT REGISTRATION, whose slug is the client_id for "
            "client_credentials. Passing an application_id where an app_id belongs is refused by "
            "role_template_app_id_fkey, whose message names neither concept. app_id answers 'which of "
            "your products is this?'; application_id answers 'which of your machines is calling?'.",
        ],
        "app_end_user_signup": [
            "POST /api/auth/register                       -> identity.person (+ alias, credential)",
            "POST /api/app-identities                      -> app_identity, UNIQUE (person_id, app_id)",
            "POST /api/app-identities/{id}/memberships     -> tenant + bu_id + starting role_template_id",
            "POST /api/personas                            -> persona_id  (the acting identity)",
            "POST /api/auth/login                          -> end-user JWT",
            "One human in two of your apps is ONE person_id with TWO app_identities and TWO "
            "personas — not two accounts. Delete at persona level so other apps are unaffected.",
        ],
        "person_joins_another_tenant": [
            "SUPPORTED, and it needs no new person. identity.alias has UNIQUE (kind, value_hash), "
            "so one email is one identity.person GLOBALLY — a human who is already a tenant admin "
            "somewhere is the same person_id when they join a different tenant's app.",
            "POST /api/memberships                        -> tenant_membership for the OTHER tenant",
            "POST /api/app-identities                     -> app_identity for that tenant's app_id",
            "POST /api/memberships/{membership_id}/personas -> a SECOND persona, independent roles",
            "Their existing personas are untouched. Login with tenant_id selects which membership "
            "the JWT is minted against; omit it to get a person-level token and let them choose.",
            "DO NOT call /api/auth/register again for this person — it will fail on the unique "
            "alias, and that failure is the constraint doing its job.",
        ],
        "app_user_becomes_a_provider": [
            "RESOLVED (EP-328). POST /api/auth/signup-tenant now REUSES the existing person when the "
            "caller sends a verified token for THAT SAME person; anonymous callers still get "
            "PersonExistsError. A second identity.person for one human would split their audit "
            "trail across two ids that nothing can reconcile, so reuse is the only safe repair.",
            "Compose it instead, from an authorised caller:",
            "POST /api/tenants                            -> the new tenant (+ its tenant.app row)",
            "POST /api/memberships                        -> bind the EXISTING person_id to it",
            "POST /api/memberships/{membership_id}/personas -> owner persona + owner role_template",
            "POST /api/applications                       -> their application, then keys",
            "Correct fix if you need self-service: make signup-tenant reuse the existing person_id "
            "when the alias matches AND the caller proves control of it (verified session or "
            "re-auth), rather than refusing. Creating a second person for the same human would "
            "break MDM convergence and split their audit trail.",
        ],
        "single_login_many_providers": [
            "SUPPORTED. A person has ONE identity.credential, so one password works across every "
            "provider's app they belong to. Which app they enter is chosen at LOGIN, not signup.",
            "POST /api/auth/login {email,password}                  -> person-level token (no tenant claims)",
            "GET  /api/memberships                                  -> every tenant+app they are subscribed to",
            "POST /api/auth/login {email,password,tenant_id,app_id} -> scoped token; app_identity auto-mints",
            "Subscription is PROVIDER-controlled: login with a tenant_id returns 403 NoMembership "
            "unless a membership exists, so nobody self-joins by guessing an id. The provider "
            "admits them via POST /api/memberships.",
            "CAVEAT: the credential is global, so a provider collecting the password on their own "
            "page holds one that works at other providers too. For mutually-untrusting providers, "
            "host login centrally and redirect. There is no OIDC authorize endpoint yet.",
        ],
        "get_an_api_key": [
            "An API key belongs to an APPLICATION, which belongs to a TENANT. Order matters.",
            "POST /api/auth/login {email,password,tenant_id}        -> human JWT (steps below need it)",
            "POST /api/applications {name,slug,environment}         -> application_id",
            "POST /api/applications/{application_id}/keys           -> pk_live_/pk_test_ (SHOWN ONCE)",
            "call:  Authorization: Bearer pk_live_...   (same header as a JWT)",
            "POST /api/auth/token (client_credentials)              -> short-lived token, preferred "
            "when the credential would otherwise sit on a device or in a browser",
            "rotate POST /api/api-keys/{key_id}/rotate | revoke POST /api/api-keys/{key_id}/revoke | "
            "kill all POST /api/applications/{application_id}/disable",
            "environment (live|test) is fixed on the APPLICATION and cannot be flipped; the prefix "
            "derives from it, so a test app can never mint a credential that reaches production.",
            "The secret is returned ONCE — only a hash is stored, so there is no 'show it again' call.",
            "Mint ONE KEY PER CONSUMER (web backend, mobile BFF, each CI pipeline) so revocation is "
            "about one consumer rather than an outage for all of them.",
        ],
        "roles_and_access": [
            "RBAC  tenant.role_template keyed (tenant_id, app_id, name); tenant_id NULL = a "
            "platform default for the app, tenant_id set = that tenant's override of the same "
            "role name. parent_role_template_id gives inheritance.",
            "POST /api/role-assignments {persona_id, role_template_id}  -> grant beyond the starting template",
            "GET  /api/personas/{persona_id}/roles         -> LIST what a persona holds (read-only; there is no POST on this path)",
            "POST /api/role-assignments/{assignment_id}/revoke          -> withdraw a grant",
            "ReBAC (sdk-rebac)  'may THIS persona act on THAT record' — owner/delegate/account "
            "team relationships, with trust state and evidence. Use when authority comes from a "
            "relationship rather than from a role.",
            "ABAC (sdk-policy)  'do the attributes permit it right now' — region, consent, time, "
            "record state. Use when the decision does not depend on identity.",
            "They compose RBAC -> ReBAC -> ABAC.",
        ],
    },
    "multi_app_caveat": (
        "tenant.tenant.app_id is NOT NULL, so a tenant row belongs to exactly ONE app, while "
        "tenant.app_pool_index (jsonb app->pool) assumes several. To model one tenant owning "
        "several apps today, use the tenant hierarchy (parent_tenant_id / root_tenant_id): a "
        "root tenant per customer and a child tenant per app. Do not assume one tenant row can "
        "span apps."
    ),
    "guide": "docs/v3.1/developer-hub/authentication.html",
}


# ── Audit events ────────────────────────────────────────────────────────────────
#
# WHY THIS IS IN THE AGENT GUIDE AT ALL. Until 2026-08-03 the event vocabulary was a
# compile-time constant with no write path, so a consuming app's first
# POST /api/audit/append returned 400 forever — and since the emit path is
# non-throwing by design, nothing surfaced it. LeadFlow shipped 32 event names, none
# of which could ever be appended, and found out only by going to look at why the
# ledger was empty. An agent building a vertical will make the same two mistakes
# (skip registration, omit the .v<N> suffix) unless it is told here, before it writes
# the code, rather than by a 400 it will interpret as a transient failure.
AUDIT_EVENTS_PLAYBOOK = {
    "model": (
        "Every audited action carries an event_type, and the vocabulary is CLOSED: a type in "
        "neither the platform baseline nor your tenant's own registered types is rejected before "
        "any write (OC-2). That constraint is deliberate — it is what stops lead.routed, "
        "lead.route and routing.applied all existing within one release, after which nothing can "
        "answer 'how often was a lead routed'. Your vertical's business events are NOT platform "
        "events: register your own rather than borrowing a vault.*/tenant.*/audit.* name, which "
        "would file your event under a name that already means something else."
    ),
    "critical": [
        "THE NAME MUST BE <domain>.<entity>.<verb>.v<N> — lowercase, '-' or '_' inside a segment, "
        "at least two segments before the version. All 294 platform types follow it and "
        "registration rejects anything that does not.",
        "THE .v<N> SUFFIX IS NOT DECORATION. It is what lets a payload shape change later as a NEW "
        "version instead of a silent redefinition of rows already written under the old shape. "
        "'capture.created' is rejected; 'capture.lead.created.v1' is accepted.",
        "REGISTER BEFORE YOU APPEND. POST /api/events/types with a tenant JWT, once per type, "
        "typically from a boot-time provisioner. It is additive: a repeat returns 200 with the "
        "STORED metadata and created:false, so re-running it on every deploy is safe and correct.",
        "A 2xx FROM YOUR OWN WRITE PATH IS NOT PROOF THE EVENT LANDED. emitEvent catches and logs "
        "rather than propagating, so an audit outage never blocks the caller — which also means a "
        "PERMANENT rejection looks exactly like a transient blip. Verify against audit.entry.",
        "AN EMPTY CHAIN VERIFIES CLEAN. POST /api/audit/verify returning ok proves nothing if "
        "nothing was ever appended; check entries_checked, not just ok.",
        "retention_class IS LOAD-BEARING. When an append omits it, the REGISTERED type's class "
        "applies. Declaring 'operational' on something regulated shreds it at 90 days instead of "
        "seven years — quietly, and years later.",
        "YOU CANNOT SHADOW A PLATFORM TYPE, and should not try: resolution reads the baseline "
        "first, and registering a baseline name is rejected 400. Nor can you see another tenant's "
        "types, or they yours.",
    ],
    "flows": {
        "register_and_emit": [
            "POST /api/events/types  (tenant JWT)  -> 201 first time, 200 on a repeat",
            "  { event_type: 'capture.lead.created.v1',",
            "    retention_class: 'regulated',        // transient | operational | regulated",
            "    conflict_policy: 'event-sourcing',   // crdt | lww | merge | event-sourcing | human-review",
            "    schema_state: 'active',              // optional, default active",
            "    compaction_policy: 'none',           // optional, default none",
            "    schema_version: 1 }                  // optional, default 1",
            "POST /api/audit/append  {pool_index, event_type, payload, actor_kind, tenant_id}  -> 201",
            "  tenant_id defaults to your JWT's tenant claim; omit retention_class to inherit the type's.",
            "POST /api/audit/verify  {pool_index}  -> assert entries_checked > 0, not just ok",
            "GET  /api/events/types            -> platform baseline + your own (platform_count/tenant_count)",
            "GET  /api/events/types/{type}     -> one type, with source: 'platform' | 'tenant'",
        ],
    },
    "guide": "docs/v3.1/developer-hub/audit-events.html",
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

    # Guard: every SDK must carry real discovery metadata.
    #
    # This previously fell back to (title-cased name, [sdk]) — which builds cleanly and
    # ships an SDK whose only search keyword is its own package name. Nobody searching for
    # a CAPABILITY ever types that, so the SDK is present in the catalog and still
    # undiscoverable, and the developer rebuilds it as custom code. A silent default that
    # produces a broken-but-valid artifact is worse than no default: the build says success.
    # This is the failure that left ten SDKs unfindable, so it now stops the build.
    undocumented = sorted(set(by_sdk) - set(SDK_META) - PLATFORM_INTERNAL_SDKS)
    if undocumented:
        raise SystemExit(
            f"ERROR: SDKs missing SDK_META (summary + reuse_when keywords): {undocumented}\n"
            "  Add an entry to SDK_META in this file. reuse_when must be the words a\n"
            "  developer types when they HAVE the problem — 'response time', 'who is\n"
            "  working' — not the SDK name, which nobody searches for."
        )

    def sdk_entry(sdk):
        summary, reuse_when = SDK_META[sdk]
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
        "auth": AUTH_PLAYBOOK,
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

    # ── AGENTS.md — the prose rendering of AUTH_PLAYBOOK ─────────────────────────
    #
    # WHY A SECOND FORMAT. JSON is right for lookup and wrong for procedure. Auth is
    # almost entirely procedure and PROHIBITION ("never call signup-tenant for an end
    # user"), and an obligation stated as a JSON array member lands weaker than one
    # stated as a sentence. Agents also auto-load AGENTS.md by convention, whereas a
    # README reads as human-facing and gets skipped.
    #
    # GENERATED, never hand-written: hand-maintaining a second copy of these facts is
    # exactly how the catalog went eighteen SDKs stale. One source, two renderings.
    def render_agents_md(catalog, index):
        pb = AUTH_PLAYBOOK
        L = []
        L.append("# ProjexCloud — agent guide")
        L.append("")
        L.append("<!-- GENERATED by scripts/qa-matrix/build_sdk_catalog.py — do not edit by hand. -->")
        L.append("")
        L.append(f"{catalog['sdk_count']} SDKs, {catalog['api_count']} tenant-callable APIs. "
                 f"Gateway: `{catalog['gateway_base_url']}`")
        L.append("")
        L.append("## Read this before writing any code")
        L.append("")
        L.append("**Do not rebuild what an SDK already covers.** Match your capability against "
                 "`sdk-catalog-index.json` (`reuse_when` keywords) first, then fetch that endpoint's "
                 "full spec from `sdk-catalog.json`. `openapi.json` is there if you want a generated "
                 "client.")
        L.append("")
        L.append("## Authentication")
        L.append("")
        L.append(pb["model"])
        L.append("")
        L.append("### Rules that will cost you if you get them wrong")
        L.append("")
        for c in pb["critical"]:
            L.append(f"- {c}")
        L.append("")
        titles = {
            "tenant_signup": "A tenant signs up (bootstrap — no credential needed)",
            "register_an_application_and_key": "A tenant registers an application and a machine key",
            "app_end_user_signup": "An end user signs up inside a tenant's app",
            "person_joins_another_tenant": "An existing user joins ANOTHER tenant's app",
            "app_user_becomes_a_provider": "An existing app user becomes a provider (own tenant + apps)",
            "single_login_many_providers": "One login across many providers' apps",
            "get_an_api_key": "Getting an API key for an app (every step)",
            "roles_and_access": "Roles, relationships and policy",
        }
        for key, steps in pb["flows"].items():
            L.append(f"### {titles.get(key, key)}")
            L.append("")
            L.append("```")
            for st in steps:
                L.append(st)
            L.append("```")
            L.append("")
        L.append("### One tenant, many apps")
        L.append("")
        L.append(pb["multi_app_caveat"])
        L.append("")

        ae = AUDIT_EVENTS_PLAYBOOK
        L.append("## Audit events — emitting your own")
        L.append("")
        L.append(ae["model"])
        L.append("")
        L.append("### Rules that will cost you if you get them wrong")
        L.append("")
        for c in ae["critical"]:
            L.append(f"- {c}")
        L.append("")
        L.append("### Registering a type, then appending against it")
        L.append("")
        L.append("```")
        for st in ae["flows"]["register_and_emit"]:
            L.append(st)
        L.append("```")
        L.append("")
        L.append(f"Human guide: `{ae['guide']}`")
        L.append("")
        L.append("## Files in this bundle")
        L.append("")
        L.append("| File | Use it for |")
        L.append("| --- | --- |")
        L.append("| `AGENTS.md` | This file. Auth flows and the rules. |")
        L.append("| `sdk-catalog-index.json` | Capability discovery — which SDK covers X. Load this first. |")
        L.append("| `sdk-catalog.json` | Full per-endpoint spec, once you have a match. |")
        L.append("| `openapi.json` | OpenAPI 3.1 — point a client generator at it. |")
        L.append("")
        L.append(f"Human guide: `{pb['guide']}`")
        L.append("")
        return chr(10).join(L)

    def render_readme_md(catalog):
        return chr(10).join([
            "# ProjexCloud API library",
            "",
            "<!-- GENERATED by scripts/qa-matrix/build_sdk_catalog.py — do not edit by hand. -->",
            "",
            f"{catalog['sdk_count']} SDKs and {catalog['api_count']} tenant-callable APIs for "
            f"`{catalog['gateway_base_url']}`.",
            "",
            "**If you are an AI coding agent, read `AGENTS.md` first** — it carries the "
            "authentication flows and the rules that prevent the expensive mistakes.",
            "",
            "- `AGENTS.md` — auth flows, prohibitions, what not to rebuild",
            "- `sdk-catalog-index.json` — compact capability map (start here to find an SDK)",
            "- `sdk-catalog.json` — full endpoint specs",
            "- `openapi.json` — OpenAPI 3.1 for client generation",
            "",
        ])

    def _targets(basename):
        ts = [
            os.path.join(ROOT, "docs", "v3.1", "api_docs", basename),
            os.path.join(ROOT, "apps", "tenant-workspace", "public", "docs", "api", basename),
            os.path.join(ROOT, "apps", "tenant-admin", "public", "docs", "api", basename),
        ]
        if os.path.isdir(AI_APPGEN_DATA):
            ts.append(os.path.join(AI_APPGEN_DATA, basename))
        # Only refresh a sibling copy that already exists — creating one in a checkout that
        # never had it would leave a file nobody updates, which is how stale copies start.
        for d in SIBLING_MCP_DATA:
            if os.path.isdir(d):
                ts.append(os.path.join(d, basename))
        return ts

    written = []
    # Markdown is tallied separately: `written` carries (path, bytes) pairs used for the
    # size report below, and mixing bare names into it broke that unpack.
    md_written = []
    for text, basename in ((render_agents_md(catalog, index), "AGENTS.md"),
                           (render_readme_md(catalog), "README.md")):
        for t in _targets(basename):
            os.makedirs(os.path.dirname(t), exist_ok=True)
            with open(t, "w", encoding="utf-8") as f:
                f.write(text)
        md_written.append((basename, len(text.encode("utf-8"))))

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
