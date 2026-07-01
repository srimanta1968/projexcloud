"""Parse all tests/api_definitions/**/*.json into a flat QA spec list, and emit
the unique epicId/featureId set to enrich with projexlight metadata."""
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API_DIR = os.path.join(ROOT, "tests", "api_definitions")
OUT_DIR = os.path.join(ROOT, "scripts", "qa-matrix")

# Map api_definition resource folder -> canonical implementing SDK/service.
# Every def now carries an explicit "sdk" field, so this is only a fallback for
# any future def added without one. Keep in sync with scripts/qa-matrix canonical map.
RESOURCE_SDK = {
    "admin": "api-gateway", "health": "api-gateway",
    "agent-runtime": "sdk-agent-runtime", "agent-runtime-agents": "sdk-agent-runtime",
    "agent-runtime-runs": "sdk-agent-runtime", "agent-runtime-tokens": "sdk-agent-runtime",
    "ai-gateway": "sdk-ai-gateway", "analytics": "sdk-analytics",
    "api-keys": "sdk-api-keys", "keys": "sdk-api-keys",
    "app-identities": "sdk-persona", "personas": "sdk-persona", "persons": "sdk-persona",
    "memberships": "sdk-persona",
    "approvals": "sdk-approval", "break-glass": "sdk-approval",
    "assets": "sdk-asset", "audit": "sdk-audit",
    "auth": "sdk-identity", "identity": "sdk-identity", "impersonation": "sdk-identity",
    "me": "sdk-identity", "mfa": "sdk-identity", "saml": "sdk-identity", "scim": "sdk-identity",
    "billing": "sdk-billing",
    "bridge": "semantic-service", "build-plan": "semantic-service", "intent": "semantic-service",
    "ontology": "semantic-service", "plan": "semantic-service", "policy": "semantic-service",
    "campaigns": "sdk-campaign", "charts": "sdk-policy", "commands": "sdk-command",
    "connectors": "sdk-connectors", "consent": "sdk-consent", "consents": "sdk-consent",
    "content": "sdk-content", "contracts": "contracts", "crm": "sdk-crm",
    "data-rights": "sdk-data-rights", "devices": "sdk-device",
    "diagnostic": "sdk-diagnostic-telemetry", "dispatch": "sdk-dispatch",
    "empi": "sdk-identity-resolver", "resolver": "sdk-identity-resolver",
    "encounters": "sdk-engagement", "grants": "sdk-engagement", "participants": "sdk-engagement",
    "events": "sdk-event", "evidence": "sdk-evidence",
    "failovers": "pool-federation-runtime", "routes": "pool-federation-runtime",
    "flags": "sdk-feature-flags", "geo": "sdk-geo", "geo-nodes": "sdk-tenant",
    "hdk-diagnostic": "hdk-diagnostic", "hdk-idp": "hdk-idp",
    "hdk-permissions": "hdk-permissions", "hdk-sync": "hdk-sync",
    "ingest": "sdk-ingest", "lead-scoring": "sdk-lead-scoring", "leads": "sdk-crm",
    "mcp": "sdk-mcp-bridge", "media": "sdk-media", "meter": "sdk-meter",
    "notifications": "sdk-notification", "observability": "telemetry",
    "payments": "sdk-payment", "policies": "sdk-policy",
    "principal-token": "sdk-principal-token", "profile": "sdk-profile",
    "relationships": "sdk-rebac", "role-assignments": "sdk-rebac", "role-templates": "sdk-rebac",
    "resellers": "sdk-tenant", "tenants": "sdk-tenant", "tenant-lifecycle": "sdk-tenant-lifecycle",
    "resources": "sdk-resource-registry", "router": "sdk-pool-router",
    "search": "sdk-search", "secrets": "sdk-secrets", "service-request": "sdk-service-request",
    "social": "sdk-social", "storm": "sdk-storm", "taxonomy": "sdk-taxonomy",
    "trace": "sdk-trace", "vault": "sdk-vault", "webhooks": "sdk-webhook",
    "workflows": "sdk-workflow", "x": "sdk-capability",
}

def infer_sdk(rel_path):
    parts = rel_path.replace("\\", "/").split("/")
    # tests/api_definitions/<resource>/<file>.json
    try:
        resource = parts[parts.index("api_definitions") + 1]
    except (ValueError, IndexError):
        resource = ""
    return RESOURCE_SDK.get(resource, resource or "(unknown)")


# sdk -> epicId map from the 34-epic catalogue's customdata.source_module, so
# generated (task-less) defs can still be grouped under an epic.
SDK_TO_EPIC = {}
_all = os.path.join(OUT_DIR, "all-epics.json")
if os.path.exists(_all):
    _raw = json.load(open(_all, encoding="utf-8"))
    _items = _raw.get("data", {}).get("items", _raw) if isinstance(_raw, dict) else _raw
    for e in _items:
        sm = (e.get("customdata") or {}).get("source_module") or ""
        for s in re.split(r"[,\s]+", sm):
            s = s.strip()
            if s and s not in SDK_TO_EPIC:
                SDK_TO_EPIC[s] = e["id"]

rows = []
epic_ids, feature_ids = set(), set()
for dirpath, _dirs, files in os.walk(API_DIR):
    for fn in files:
        if not fn.endswith(".json") or fn == "api_summary.json":
            continue
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        try:
            with open(full, "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception as e:  # noqa
            print(f"skip {rel}: {e}", file=sys.stderr)
            continue
        if not isinstance(d, dict) or "endpoint" not in d:
            continue
        sdk = d.get("sdk") or infer_sdk(rel)
        generated = bool(d.get("_generated"))
        source_file = d.get("sourceFile", "")
        epic_id = d.get("epicId") or SDK_TO_EPIC.get(sdk, "")
        feature_id = d.get("featureId") or ""
        if epic_id:
            epic_ids.add(epic_id)
        if feature_id:
            feature_ids.add(feature_id)
        tcs = d.get("testCases") or []
        # Flatten: one row per test case (or one row if none / manual).
        if not tcs:
            rows.append({
                "epicId": epic_id, "featureId": feature_id, "taskId": d.get("taskId", ""),
                "endpoint": d.get("endpoint", ""), "method": d.get("method", ""),
                "requiresAuth": d.get("requiresAuth", None), "testability": d.get("testability", ""),
                "skipReason": d.get("skipReason", ""), "case": "", "payload": None,
                "pathParams": None, "expectedStatus": d.get("expectedStatus", ""),
                "expectedResponse": d.get("expectedResponse", None),
                "dependsOn": d.get("dependsOn", []), "sdk": sdk, "file": rel,
                "generated": generated, "sourceFile": source_file,
                "fieldOptions": d.get("fieldOptions", None),
                "serverFieldOptions": d.get("serverFieldOptions", None),
            })
        for tc in tcs:
            rows.append({
                "epicId": epic_id, "featureId": feature_id, "taskId": d.get("taskId", ""),
                "endpoint": d.get("endpoint", ""), "method": d.get("method", ""),
                "requiresAuth": d.get("requiresAuth", None), "testability": d.get("testability", ""),
                "skipReason": d.get("skipReason", ""), "case": tc.get("name", ""),
                "payload": tc.get("payload", None), "pathParams": tc.get("pathParams", None),
                "expectedStatus": tc.get("expectedStatus", d.get("expectedStatus", "")),
                "expectedResponse": tc.get("expectedResponse", d.get("expectedResponse", None)),
                "dependsOn": d.get("dependsOn", []), "sdk": sdk, "file": rel,
                "generated": generated, "sourceFile": source_file,
                "fieldOptions": d.get("fieldOptions", None),
                "serverFieldOptions": d.get("serverFieldOptions", None),
            })

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "qa-apis.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, indent=1)
with open(os.path.join(OUT_DIR, "unique-ids.json"), "w", encoding="utf-8") as f:
    json.dump({"epicIds": sorted(epic_ids), "featureIds": sorted(feature_ids)}, f, indent=1)

print(f"rows={len(rows)} files_with_apis=~{len(rows)} unique_epics={len(epic_ids)} unique_features={len(feature_ids)}")
