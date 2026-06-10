# ETL Agent Discovery — Worked Example (P9.2 / Epic D, TK-3479)

How an external ETL agent imports data into a ProjexCloud app **using only
discovered contracts** — no hardcoded endpoints or payloads. Backed by the
registry MCP tools (`registry-mcp-local` / hosted `registry-mcp`) and the
`sdk-ingest` batch endpoint.

## The loop

```
1. search ingest endpoints for the entity
2. get_ingest_targets(entity)        → endpoint + payload schema + auth scope
3. read request_schema               → map external columns to the envelope
4. POST the batch                    → import records idempotently
5. watch ingest/lineage events       → row counts + conflicts
```

### 1–2. Discover where to push the data

```jsonc
// MCP tool call
{ "name": "projex_registry_search_sdks",
  "arguments": { "query": "import customer records", "top_k": 5 } }

// then narrow to ingest endpoints + contracts
{ "name": "projex_registry_get_ingest_targets",
  "arguments": { "entity": "customer" } }
```

Returns (live, verified):

```json
{
  "entity": "customer",
  "count": 1,
  "targets": [
    {
      "sdk_name": "@projexlight/sdk-ingest",
      "method": "POST",
      "path": "/api/ingest/:entity/batch",
      "kind": "ingest",
      "auth_scopes": ["ingest:write"],
      "request_schema": {
        "type": "object",
        "required": ["entity", "idempotency_key", "records"],
        "properties": {
          "entity": { "type": "string" },
          "mode": { "type": "string", "enum": ["upsert", "insert"] },
          "idempotency_key": { "type": "string" },
          "records": { "type": "array", "items": { "type": "object" } }
        }
      }
    }
  ]
}
```

(For non-customer entities that land in other SDKs — e.g. `crash` →
`sdk-diagnostic-telemetry`, `evidence` → `sdk-evidence`, blobs → `sdk-media` —
the same tool returns those, each with its own `auth_scopes`.)

### 3–4. Map columns to the envelope and POST

The agent reads `request_schema`, maps its source columns into the records, and
calls the discovered endpoint — nothing is hardcoded:

```ts
const target = ingestTargets[0];                       // discovered, not assumed
const url = target.path.replace(":entity", "customer"); // /api/ingest/customer/batch

await fetch(url, {
  method: target.method,                                // "POST"
  headers: { Authorization: `Bearer ${token}` },        // scope: ingest:write
  body: JSON.stringify({
    entity: "customer",
    mode: "upsert",
    idempotency_key: batchId,                            // re-run-safe
    records: sourceRows.map(mapToCustomer),              // mapped from external schema
  }),
});
```

Response:

```json
{ "entity": "customer", "imported": 2, "skipped": 0, "errors": [] }
```

### 5. Verify

- Re-running the same batch with the same `idempotency_key` upserts rather than
  duplicating (`imported` reflects rows touched, `skipped` the no-ops).
- Provenance is recorded via `sdk-lineage` and an append-only entry via
  `sdk-audit` (wired through `setIngestHooks` at the gateway), so every imported
  row is traceable source → entity.
- `ingest.batch.completed.v1` carries the final counts for downstream listeners.

## Why this is safe for agents

- **Discovery, not guessing** — the agent learns the endpoint, payload, and auth
  scope from the registry; it never embeds a URL or invents a body shape.
- **Provider-independent** — endpoint discovery runs on the local bge-small
  index/store, so the generation LLM can change without affecting what's found.
- **Idempotent + audited** — retries are safe and every import is provenance-
  tracked, satisfying the SOC2/GDPR posture in `sdk-ingest`'s manifest.

## Verified

Against the live catalog store: `get_ingest_targets()` returned the 3 tagged
ingest endpoints (`sdk-ingest`, `sdk-media` upload, `sdk-diagnostic-telemetry`
crash, `sdk-evidence` capture), and `searchCatalog(kind='ingest')` for
*"where can I upload crash reports and evidence files"* ranked them
0.77 / 0.63 / 0.55. See §14.2/§14.4 of `SDK-Discoverability-AI-Builder-v3.1.html`.
