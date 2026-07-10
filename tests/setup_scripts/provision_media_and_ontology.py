#!/usr/bin/env python3
"""
API-based test seed provisioning (MUST-51) — runs in BOTH Dev and Test MCP after
the auth bootstrap, before the suite. Provisions per-run seed data that the
dependency graph CANNOT express (multi-step-same-endpoint / mutated shared
producer), using ONLY the SUT API so it is cloud-safe (no DB access needed).

Reads context from env (injected by the runner):
  API_BASE_URL          - SUT base url (e.g. http://host.docker.internal:3500)
  TENANT_ID             - this run's dynamic tenant (auth.signup-tenant...tenant_id)
  TENANT_TOKEN          - tenant-scoped bearer token
  USER_TOKEN            - plain-user bearer token (fallback)
  SETUP_CONTEXT_JSON    - JSON of all resolved {{cache}}/{{var}} values
  ACTIVE_ONTOLOGY_NAME  - name the /ontology/:name/active test looks up

Secure secret export (never printed / logged):
  SETUP_VARS_OUT           - private 0600 file the runner reads for vars to inject
                             (e.g. {{var:ADMIN_OPS_TOKEN}}), then shreds+deletes.
  ADMIN_OPS_BOOTSTRAP_TOKEN - master admin-ops secret, injected into the container
                             ONLY as an env var from a gitignored/secret source
                             (never committed, never in test-config). Used solely to
                             MINT a short-lived per-run token; the master is never
                             exported or logged.

Contract: IDEMPOTENT (check/tolerate-409) and NON-FATAL (always exits 0; a
failure here must never abort the suite — seed-dependent tests just fail with a
clear reason). SECURITY: minted secrets go ONLY to SETUP_VARS_OUT (never stdout).
"""
import os
import sys
import json
import urllib.request
import urllib.error

BASE = (os.environ.get("API_BASE_URL") or "").rstrip("/")
TENANT_ID = os.environ.get("TENANT_ID", "")
TOKEN = os.environ.get("TENANT_TOKEN") or os.environ.get("USER_TOKEN") or ""
ONTOLOGY_NAME = os.environ.get("ACTIVE_ONTOLOGY_NAME", "sdk-semantic-smoke")


def _req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        try:
            return r.status, json.load(r)
        except Exception:
            return r.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, None
    except Exception as e:
        print(f"  [warn] request {method} {path} failed: {e}")
        return None, None


def provision_vault_tenant_key():
    """Root key + tenant-tier key (parent=root) so media/upload-url resolves a
    vault key. The graph can't express this (two POSTs to the same endpoint)."""
    if not TENANT_ID or not TOKEN:
        print("  [skip] vault key: no TENANT_ID/token in context")
        return
    st, d = _req("POST", "/api/vault/keys", {
        "tier": "root", "kms_ref": "kms-seed-root",
        "algorithm": "AES-256-GCM", "region": "us-east-1",
    })
    root_id = ((d or {}).get("data") or {}).get("key_id") if isinstance(d, dict) else None
    if not root_id:
        print(f"  [warn] vault root key not created (status={st}); skipping tenant key")
        return
    st, d = _req("POST", "/api/vault/keys", {
        "tier": "tenant", "scope_id": TENANT_ID, "parent_key_id": root_id,
        "kms_ref": "kms-seed-tenant", "algorithm": "AES-256-GCM", "region": "us-east-1",
    })
    if st in (200, 201):
        print(f"  [ok] vault tenant key provisioned for tenant {TENANT_ID[:8]}")
    elif st == 409:
        print("  [ok] vault tenant key already exists (409)")
    else:
        print(f"  [warn] vault tenant key status={st}: {str(d)[:120]}")


def provision_active_ontology():
    """Ensure an active ontology named ACTIVE_ONTOLOGY_NAME exists (idempotent —
    skip if already active). Cloud/fresh-env safety; a global SQL seed may
    already cover this in devbox."""
    if not TOKEN:
        print("  [skip] ontology: no token in context")
        return
    st, _ = _req("GET", f"/ontology/{ONTOLOGY_NAME}/active")
    if st == 200:
        print(f"  [ok] ontology '{ONTOLOGY_NAME}' already active")
        return
    bundle = {
        "name": ONTOLOGY_NAME, "version": "1.0.0", "parent_ontology": None,
        "object_types": [
            {"name": "Patient", "attribute_schema": {"mrn": "string"},
             "backed_by": "persona.persona_ext:patient_chart"},
            {"name": "Encounter", "attribute_schema": {"code": "string"},
             "backed_by": "clinical.encounter"},
        ],
        "relation_types": [
            {"name": "treats", "cardinality": "1:N", "rebac_kind_mapping": "member",
             "from_object_type_name": "Patient", "to_object_type_name": "Encounter"},
        ],
        "capability_graph": [
            {"tool_sku": "clinical.note.summarize", "pre_conditions": {},
             "post_conditions": {}, "object_type_name": "Patient",
             "requires_relation_name": "treats"},
        ],
    }
    st, d = _req("POST", "/ontology/register",
                 {"bundle": bundle, "bundle_ref": "seed-" + ONTOLOGY_NAME, "activate": True})
    if st in (200, 201):
        print(f"  [ok] ontology '{ONTOLOGY_NAME}' registered + activated")
    elif st == 409:
        print(f"  [ok] ontology '{ONTOLOGY_NAME}' already registered (409)")
    else:
        print(f"  [warn] ontology register status={st}: {str(d)[:120]}")


def _export_secret_var(key, value):
    """Hand a secret back to the runner via the private SETUP_VARS_OUT file — NEVER
    via stdout/logs. The runner injects it as {{var:key}}/{{cache:key}}, redacts its
    value everywhere, then shreds+deletes the file. If SETUP_VARS_OUT isn't set
    (older runner), we silently skip rather than risk printing the secret."""
    out_path = os.environ.get("SETUP_VARS_OUT", "")
    if not out_path or not value:
        return False
    existing = {}
    try:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            existing = json.loads(open(out_path).read()) or {}
    except Exception:
        existing = {}
    existing[key] = value
    with open(out_path, "w") as f:
        json.dump(existing, f)
    return True


def provision_admin_ops_token():
    """Mint a SHORT-LIVED admin ops-token for this run and export it securely as
    {{var:ADMIN_OPS_TOKEN}} so the ~56 /admin/* endpoints authenticate on any env
    (staging/prod) — WITHOUT a static token in test-config.

    Auth: uses ADMIN_OPS_BOOTSTRAP_TOKEN (the env-only master secret) purely to mint;
    the master is never exported or logged. The minted token is written ONLY to the
    private SETUP_VARS_OUT file. If the bootstrap secret or export channel is absent
    (e.g. no secret provisioned for this env), skip silently — endpoints then 401 with
    a clear reason, and nothing leaks."""
    bootstrap = os.environ.get("ADMIN_OPS_BOOTSTRAP_TOKEN", "")
    out_path = os.environ.get("SETUP_VARS_OUT", "")
    if not bootstrap or not out_path:
        print("  [skip] admin ops-token: no bootstrap secret / export channel (env not provisioned)")
        return
    body = {"label": "qa-run", "ttl_seconds": 1800, "reason": "automated qa mint",
            "created_by": "api-test-runner"}
    try:
        req = urllib.request.Request(
            BASE + "/admin/security/ops-tokens", data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-admin-ops-token": bootstrap})
        r = urllib.request.urlopen(req, timeout=30)
        tok = ((json.load(r) or {}).get("data") or {}).get("token")
    except Exception:
        tok = None  # deliberately no error detail — could echo the bootstrap secret
    if not tok:
        print("  [warn] admin ops-token mint failed (bootstrap secret/endpoint) — continuing")
        return
    if _export_secret_var("ADMIN_OPS_TOKEN", tok):
        print("  [ok] admin ops-token minted + exported securely (value redacted)")


def main():
    if not BASE:
        print("  [skip] no API_BASE_URL in context — nothing to provision")
        return
    print(f"[provision] SUT={BASE} tenant={TENANT_ID[:8] if TENANT_ID else '-'}")
    try:
        provision_admin_ops_token()
    except Exception as e:
        print(f"  [warn] ops-token provisioning error (non-fatal): {type(e).__name__}")
    try:
        provision_vault_tenant_key()
    except Exception as e:
        print(f"  [warn] vault provisioning error (non-fatal): {e}")
    try:
        provision_active_ontology()
    except Exception as e:
        print(f"  [warn] ontology provisioning error (non-fatal): {e}")


if __name__ == "__main__":
    main()
    sys.exit(0)  # NON-FATAL: never fail the suite
