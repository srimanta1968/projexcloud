"""Enrich qa-apis.json so every documented API carries a QA-usable *expected output*.

For each test case we add:
  exampleRequest   - the payload with {{static}}/{{dynamic}}/{{cache}} tokens resolved
                     to concrete sample values (what QA actually sends).
  exampleResponse  - an illustrative success body in the platform's standard envelope
                     {success:true, data:{...}}; shape derived from the request
                     contract + HTTP method (create echoes payload + id + timestamps,
                     list GETs return data:[...], etc.).
  exampleError     - a representative failure body {success:false, error:"..."} for the
                     negative path, matched to the auth/validation profile.
  testWave / waveLabel / waveOrder - which dependency-ordered wave the owning SDK belongs
                     to (see build_test_plan.py for the wave model). Drives the test order.

These examples are *contract-derived* (clearly labelled in the docs). The runner assertion
is still the original `expectedResponse`; this only fills the documentation gap so QA knows
what each API should return. Re-run is idempotent.
"""
import json
import os
import re

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "qa-apis.json")

SAMPLE_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

# ---- wave model: SDK -> (order, label). Lower order = test earlier. -----------------
# Built from the dependsOn graph (sdk-identity/auth is depended on by 49 APIs -> wave 0)
# combined with the Wave/Phase epic structure (EP-289..EP-326). See build_test_plan.py.
WAVES = [
    (0, "W0 · Foundation Spine (auth, tenant, routing, events)", [
        "sdk-identity", "identity", "router", "events", "api-gateway",
        "sdk-tenant", "sdk-tenant-lifecycle", "tenant-lifecycle", "pool-federation-runtime"]),
    (1, "W1 · Secrets, Audit & Telemetry (cross-cutting infra)", [
        "vault", "secrets", "sdk-vault", "sdk-secrets",
        "sdk-audit", "meter", "telemetry/api-gateway", "sdk-trace", "trace",
        "sdk-diagnostic-telemetry", "hdk-diagnostic"]),
    (2, "W2 · Identity Triad (MDM + ABAC + Consent)", [
        "sdk-consent", "sdk-policy", "sdk-rebac", "sdk-api-keys", "mfa", "saml",
        "scim", "resellers", "role-templates", "social", "geo-nodes",
        "sdk-principal-token", "sdk-resource-registry"]),
    (3, "W3 · Canonical Entities + Privacy", [
        "persons", "personas", "profile", "memberships", "app-identities", "devices",
        "flags", "geo", "resolver", "data-rights", "role-assignments", "identity",
        "hdk-idp", "hdk-permissions", "hdk-sync"]),
    (4, "W4 · Operational Core + Billing", [
        "billing", "payments", "approvals", "connectors", "media", "notifications",
        "search", "webhooks", "workflows"]),
    (5, "W5 · Engagement (Domain Layer)", [
        "sdk-engagement", "sdk-crm", "sdk-campaign", "sdk-lead-scoring", "sdk-social",
        "sdk-content", "sdk-service-request", "sdk-event", "sdk-approval"]),
    (6, "W6 · Knowledge, Semantic & Agent Runtime", [
        "semantic-service", "agent-runtime-agents", "agent-runtime-runs",
        "agent-runtime-tokens", "sdk-agent-runtime", "ai-gateway", "sdk-ai-gateway",
        "mcp", "sdk-mcp-bridge", "sdk-capability", "sdk-taxonomy", "sdk-ingest",
        "ingest", "sdk-search", "sdk-connectors", "connectors", "build-plan"]),
    (7, "W7 · Field, Evidence & Hyperscale (P7)", [
        "sdk-evidence", "hdk-camera", "hdk-map", "hdk-measure", "hdk-scanner",
        "hdk-watermark", "hdk-image-editor", "hdk-video-editor", "sdk-media", "sdk-webhook"]),
    (8, "W8 · Governance & Authorization (P10)", [
        "sdk-identity-resolver", "contracts", "personas"]),
]
SDK_WAVE = {}
for order, label, sdks in WAVES:
    for s in sdks:
        SDK_WAVE.setdefault(s, (order, label))
DEFAULT_WAVE = (6, "W6 · Knowledge, Semantic & Agent Runtime")  # platform/uncategorised SDKs


def resolve_token(val):
    """Resolve a single {{prefix:arg}} token (or plain value) to a concrete sample."""
    if not isinstance(val, str):
        return val
    m = re.fullmatch(r"\{\{(\w+):(.*)\}\}", val)
    if not m:
        return val
    prefix, arg = m.group(1), m.group(2)
    if prefix == "static":
        if arg in ("REPLACE_WITH_ID", "REPLACE_WITH_UUID"):
            return SAMPLE_UUID
        if arg == "sample":
            return "sample-value"
        return arg
    if prefix == "dynamic":
        a = arg.lower()
        if "uuid" in a or a.endswith("_id") or a == "id":
            return SAMPLE_UUID
        if "email" in a:
            return "qa.user@example.com"
        if "name" in a:
            return "Acme QA Sample"
        if "phone" in a:
            return "+15555550123"
        if "date" in a or "time" in a:
            return "2026-01-15T10:30:00Z"
        return f"sample-{a}"
    if prefix == "cache":
        # {{cache:agent-runtime-agents.create.response.data.agent_id}} -> a prior id
        return SAMPLE_UUID
    return val


def resolve_deep(obj):
    if isinstance(obj, dict):
        return {k: resolve_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [resolve_deep(v) for v in obj]
    return resolve_token(obj)


def resource_name(endpoint):
    """Best-effort resource label from the endpoint, e.g. '/api/persons/:id' -> 'person'."""
    segs = [s for s in endpoint.split("/") if s and not s.startswith(":") and s != "api"]
    if not segs:
        return "resource"
    last = segs[-1].replace("-", "_")
    if last.endswith("ies") and len(last) > 4:
        return last[:-3] + "y"
    if last.endswith(("ses", "ches", "shes", "xes", "zes")):
        return last[:-2]
    if last.endswith("s") and not last.endswith("ss") and len(last) > 3:
        return last[:-1]
    return last


def id_field(endpoint):
    name = resource_name(endpoint)
    return f"{name}_id"


def build_example_response(r):
    method = (r.get("method") or "GET").upper()
    status = r.get("expectedStatus")
    endpoint = r.get("endpoint", "")
    payload = resolve_deep(r.get("payload") or {})
    last_seg = [s for s in endpoint.split("/") if s][-1] if endpoint.split("/") else ""
    is_action = last_seg in {
        "replay", "rollback", "generate", "canonicalize", "drills", "rotate",
        "revoke", "validate", "evaluate", "resolve", "publish", "sync", "verify"}

    if method == "DELETE" or status == 204:
        return {"success": True}
    if status == 202:
        return {"success": True, "data": {"status": "accepted", "job_id": SAMPLE_UUID}}

    if method in ("POST", "PUT", "PATCH"):
        if is_action:
            data = {"status": "completed"}
            data.update({k: v for k, v in (payload.items() if isinstance(payload, dict) else [])})
            data.setdefault(id_field(endpoint), SAMPLE_UUID)
            return {"success": True, "data": data}
        # create/update -> echo resolved payload + id + audit timestamps
        data = {id_field(endpoint): SAMPLE_UUID}
        if isinstance(payload, dict):
            data.update(payload)
        data.setdefault("status", "active")
        data["created_at"] = "2026-01-15T10:30:00Z"
        data["updated_at"] = "2026-01-15T10:30:00Z"
        return {"success": True, "data": data}

    # GET
    has_path_param = bool(r.get("pathParams")) or ":" in endpoint
    if has_path_param:  # single resource
        data = {id_field(endpoint): SAMPLE_UUID, "status": "active",
                "created_at": "2026-01-15T10:30:00Z"}
        return {"success": True, "data": data}
    # collection
    item = {id_field(endpoint): SAMPLE_UUID, "status": "active"}
    return {"success": True, "data": [item], "total": 1}


def build_example_error(r):
    status = r.get("expectedStatus")
    if r.get("requiresAuth") and status not in (400, 404):
        return {"http": 401, "body": {"success": False, "error": "unauthorized: missing or invalid token"}}
    method = (r.get("method") or "GET").upper()
    if method == "GET" and (r.get("pathParams") or ":" in r.get("endpoint", "")):
        return {"http": 404, "body": {"success": False,
                "error": f"{resource_name(r.get('endpoint',''))} not found"}}
    return {"http": 400, "body": {"success": False,
            "error": "validation failed: a required field is missing or invalid"}}


def main():
    apis = json.load(open(SRC, encoding="utf-8"))
    for r in apis:
        sdk = r.get("sdk") or ""
        order, label = SDK_WAVE.get(sdk, DEFAULT_WAVE)
        r["testWave"] = order
        r["waveLabel"] = label
        r["exampleRequest"] = resolve_deep(r.get("payload")) if r.get("payload") else None
        r["exampleResponse"] = build_example_response(r)
        r["exampleError"] = build_example_error(r)
    with open(SRC, "w", encoding="utf-8") as f:
        json.dump(apis, f, indent=1, ensure_ascii=False)
    waves = {}
    for r in apis:
        waves.setdefault(r["testWave"], 0)
        waves[r["testWave"]] += 1
    print(f"enriched {len(apis)} test cases; wave counts:",
          {k: waves[k] for k in sorted(waves)})


if __name__ == "__main__":
    main()
