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

Contract: IDEMPOTENT (check/tolerate-409) and NON-FATAL (always exits 0; a
failure here must never abort the suite — seed-dependent tests just fail with a
clear reason).
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


def main():
    if not BASE:
        print("  [skip] no API_BASE_URL in context — nothing to provision")
        return
    print(f"[provision] SUT={BASE} tenant={TENANT_ID[:8] if TENANT_ID else '-'}")
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
