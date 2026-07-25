#!/usr/bin/env python3
"""
MUST-51 API-based setup (replaces assignment_seed_workload_pool.sql): provisions
the fixed pool of eligible personas in assignment.workload THROUGH the real HTTP
producer PUT /api/assignment/workload/:persona_id (sdk-assignment, added under
TK-3805) instead of a direct DB INSERT, so POST /api/assignment/assign-by-task
has candidates to rotate through (EP-335 round-robin).

Why a .py and not a pure dependsOn edge: the round-robin test needs THREE
candidates, i.e. the same PUT endpoint called three times — the runner's
one-node-per-(method,endpoint) graph can't express that, so this is the
prescribed NEXT-tier (MUST-51) mechanism: still API-produced, cloud-safe, no DB.

The three UUIDs are bare assignment.workload PKs (no FK, no tenant column), so
fixed ids are legitimately real rows. Each is PUT with skills=['plumbing'],
capacity_per_day=1000 and NO availability window (null = always available), so
the skill + availability gates pass and only the rotation cursor picks the winner.
open_tasks is dispatcher-owned and not settable via the API; the 1000/day ceiling
keeps them eligible across many runs regardless.

Reads from env (injected by the runner): API_BASE_URL, TENANT_TOKEN (falls back
to USER_TOKEN). Idempotent (PUT is an upsert) and NON-FATAL (always exits 0).
"""
import os
import json
import urllib.request
import urllib.error

BASE = (os.environ.get("API_BASE_URL") or "").rstrip("/")
TOKEN = os.environ.get("TENANT_TOKEN") or os.environ.get("USER_TOKEN") or ""

PERSONA_IDS = [
    "a1111111-1111-4111-8111-111111111111",
    "a2222222-2222-4222-8222-222222222222",
    "a3333333-3333-4333-8333-333333333333",
]


def _put(persona_id, body):
    url = f"{BASE}/api/assignment/workload/{persona_id}"
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] PUT workload {persona_id[:8]} failed: {e}")
        return None


def main():
    if not BASE or not TOKEN:
        print("  [skip] assignment workload: no API_BASE_URL/token in context")
        return
    for pid in PERSONA_IDS:
        st = _put(pid, {"capacity_per_day": 1000, "skills": ["plumbing"]})
        if st == 200:
            print(f"  [ok] assignment workload provisioned for {pid[:8]}")
        else:
            print(f"  [warn] assignment workload {pid[:8]} status={st}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — never abort the suite
        print(f"  [warn] assignment_seed_workload_pool.py non-fatal error: {e}")
