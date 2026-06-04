# @projexlight/sdk-catalog-index

Global **SDK catalog RAG store** (P9.2 / Epic A). Turns the SDK catalog from a
build-time file artifact into an auto-populated, auto-refreshed Postgres +
pgvector store that backs the Build-with-AI planner and the registry MCP.

## What it owns

- **`catalog.*` schema** (`global-catalog` pool), auto-created on boot by
  `@projexlight/migration-runner` — no manual SQL:
  - `catalog.sdk` — one row per SDK (summary, tags, `tier`, `content_hash`).
  - `catalog.endpoint` — method/path/`kind` + Epic B `request_schema` /
    `response_schema` / `auth_scopes`.
  - `catalog.embedding` — bge-small **`vector(384)`** cards (sdk / endpoint /
    scenario / ingest) with an **HNSW cosine** index.
  - `catalog.sync_state` — single-row version marker for MCP hot-index reloads.
- **Incremental sync** — `syncCatalog()` scans every `sdk-capability.json`
  (reusing the `sdk-registry` scanner), content-hash diffs, and upserts +
  re-embeds **only changed SDKs**.
- **Read surface** — `searchCatalog()` (semantic, optionally `kind:'ingest'`),
  `getEndpoint()`, `getIngestTargets()`, `getSyncVersion()`.

## Provider independence

Embeddings are computed by the **local** `bge-small-en-v1.5` model
(`@projexlight/sdk-registry`'s in-process ONNX embedder) — never an external
API. The model id + dim are pinned, so a change of the *generation* LLM provider
never alters retrieval. Changing the embedding model is a deliberate, versioned
reindex.

## Wiring (api-gateway boot)

```ts
import { runMigrations } from '@projexlight/migration-runner';
import { migrationsDir, syncCatalog } from '@projexlight/sdk-catalog-index';

await runMigrations([ /* … */, { sdk: 'sdk-catalog-index', dir: migrationsDir } ]);
await syncCatalog({ repoRoot: process.env.PROJEXCLOUD_REPO_ROOT }); // incremental, best-effort
```

The build planner (`apps/tenant-workspace`) retrieves candidates via
`searchCatalog()`; today it ships an in-app `EmbeddingRetriever` over the
`sdk-registry` file index as the pre-deploy stand-in — same embed→search→map
contract, only the index source differs.
