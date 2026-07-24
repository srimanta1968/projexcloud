#!/usr/bin/env python3
"""
MUST-51 API-based setup (replaces 40_seed_lead_scoring_retire_fixture.sql):
provisions a dedicated, resettable ACTIVE lead_scoring.model at the FIXED id
{{var:retire_fixture_model_id}} (qa-retire-fixture-model-0001) on a throwaway
vertical ('solar-retire-fixture') by calling the REAL producer
POST /api/lead-scoring/models (with a caller-supplied model_id + activate:true)
instead of a direct DB INSERT.

The retire test POST /api/lead-scoring/models/:id/retire retires THIS model, so
it never touches the shared 'solar' scoring model that score / next-best-action /
models-active depend on. Running this per-def before the retire test re-upserts
the row to 'active' every run (createModel now ON CONFLICT (model_id) DO UPDATE),
so it is order-independent and re-run-safe even though the retire test flips it to
'retired'. retireModel retires purely by model_id (no tenant check), so the fixed
tenant here is irrelevant to the retire.

Why a .py and not a pure dependsOn edge: the retire test needs a SECOND, distinct
model from the same POST /api/lead-scoring/models endpoint the scoring tests use;
the runner's one-node-per-(method,endpoint) graph can't express two producers for
one endpoint, so this is the prescribed NEXT-tier (MUST-51) mechanism — API-based,
cloud-safe, no DB access. A fixed model_id is used (not a captured random id)
because the runner does not inject a setup-script-exported id into a def pathParam;
the caller-supplied-id support on createModel is what makes the fixed id possible.

Reads env: API_BASE_URL, TENANT_ID, TENANT_TOKEN (falls back to USER_TOKEN).
Idempotent (upsert) and NON-FATAL (always exits 0).
"""
import os
import json
import urllib.request
import urllib.error

BASE = (os.environ.get("API_BASE_URL") or "").rstrip("/")
TENANT_ID = os.environ.get("TENANT_ID", "")
TOKEN = os.environ.get("TENANT_TOKEN") or os.environ.get("USER_TOKEN") or ""

FIXTURE_MODEL_ID = "qa-retire-fixture-model-0001"
FIXTURE_VERTICAL = "solar-retire-fixture"


def main():
    if not BASE or not TOKEN or not TENANT_ID:
        print("  [skip] lead-scoring retire fixture: no API_BASE_URL/token/tenant in context")
        return
    body = {
        "model_id": FIXTURE_MODEL_ID,
        "tenant_id": TENANT_ID,
        "vertical": FIXTURE_VERTICAL,
        "activate": True,
    }
    req = urllib.request.Request(
        BASE + "/api/lead-scoring/models",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN},
        method="POST",
    )
    try:
        r = urllib.request.urlopen(req, timeout=30)
        status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] lead-scoring retire fixture POST failed: {e}")
        return
    if status in (200, 201):
        print(f"  [ok] lead-scoring retire fixture model provisioned/reset active ({FIXTURE_MODEL_ID})")
    else:
        print(f"  [warn] lead-scoring retire fixture status={status}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — never abort the suite
        print(f"  [warn] provision_lead_scoring_retire_fixture.py non-fatal error: {e}")
