# PRD · P9 — SDK Discoverability & AI-Driven Vertical App Builder

| Field | Value |
|---|---|
| **Phase** | P9 |
| **Window** | Weeks 50–62 GA (~12 weeks, internally phased P9A/P9B/P9C/P9D) · **+ P9.1 follow-up week 64** for AC-11 (Projexlight dogfood cutover) |
| **Maps to wave(s)** | W7 (post-P8 productization) |
| **Gates closed** | G13 (SDK Composability) · G14 (AI-Native App Builder) |
| **Status** | DRAFT — pending review |
| **Owner (DRI)** | Platform Architect (Layer 1+2) · Developer Experience Lead (Layer 4 CLI) · Tenant Product Lead (Layer 4 Cloud Agent) |
| **Follow-on** | **`P9.2-SDK-Catalog-RAG-Ingest.md`** (IMPLEMENTED) — evolves the L2 registry into a Postgres+pgvector RAG store, rebuilds the `/build` planner as retrieve-then-compose with foundation-tier injection, and adds endpoint payload contracts + an ingest front door. Supersedes the file-dump planner path described here. |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` · `../docs/v3.1/SDK-Build-Plan-v3.1.html` · `../docs/v3.1/AgenticIntegration-v3.1.html` · `../docs/v3.1/ProjectStructure-v3.1.html` · `../docs/v3.1/SDK-Discoverability-AI-Builder-v3.1.html` §14 |

---

## 1 · TL;DR

After P1–P8 we have ~70 SDKs that solve cross-cutting SaaS concerns (identity, tenancy, billing, audit, AI gateway, evidence chain, geo, dispatch, etc.), but they are only discoverable by reading source. P9 turns the SDK catalog into a **machine-readable, AI-consumable platform** so customers' developers (via local AI coding tools like Claude Code / Cursor / Windsurf) and non-developers (via a hosted cloud agent) can compose vertical applications from these SDKs in days instead of months. The phase ships four layers — capability manifests, a registry + MCP server, vertical blueprints, and two builder entry points (local CLI and cloud agent) — and a pilot **RevOps CRM** vertical built end-to-end on this stack to prove the model.

---

## 2 · Why this phase now

Phases P1–P8 built the SDK stack and the deployment variants. The stack is now broad enough that the *bottleneck to ProjexCloud's growth is no longer features, it is composability*: a tenant who signs up today gets a workspace with no scaffolded application, and the only way to actually build one is to clone the monorepo and learn ~70 packages. That doesn't scale to thousands of tenants. The MCP ecosystem (Anthropic, Cursor, Windsurf, Cline) has converged on a stable protocol in the last 6 months — building on it now means every AI coding tool, present and future, becomes a ProjexCloud entry point without a per-tool plugin. Delaying P9 means: (a) every tenant onboarding burns operator hours on hand-holding, (b) the AI-native window closes as competitors ship their own MCP catalogs, and (c) the vertical packs (Healthcare, FinServ, Public Sector) referenced in P8 have no surface to materialize on.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-capability` | SDK · NEW | M · 2w | Platform Architect | Schema + types + validator for `sdk-capability.json`; one CLI to auto-generate the auto-detectable portions per SDK |
| `@projexlight/sdk-registry` | SDK · NEW | M · 2w | Platform Architect | Build-time scanner that walks `packages/*`, validates manifests, produces a single normalized catalog JSON + an embedding index |
| `services/registry-mcp` (hosted) | Service binary · NEW | M · 2w | Platform Architect | **Hosted** half. Per-region, behind api-gateway. Owns tenant-scoped reads and ALL writes (`scaffold`, `deploy`, audit emission, billing). SSE transport for browser/cloud-agent clients |
| `@projexlight/registry-mcp-local` | CLI-bundled binary · NEW | M · 2w | Developer Experience Lead | **Local** half. Same MCP wire protocol, stdio transport. Caches the public catalog locally (refreshed daily); answers read tools from cache for offline speed; proxies write tools to the hosted side with the dev's tenant API key. Docker image follows the `projex_dev_mcp` distribution pattern |
| `blueprints/` | Package · NEW | M · 2w (5 blueprints) | Tenant Product Lead | YAML blueprint files + per-blueprint scaffold templates. Ships 5 pilots: revops-crm, field-dispatch, claims-intake, b2b-analytics, patient-portal |
| `@projexlight/cli` | CLI · NEW | L · 3w | Developer Experience Lead | `projex init`, `projex install`, `projex deploy`, `projex blueprint apply`. Auto-writes `.claude/mcp.json` / `cursor.mcp.json` |
| `apps/cloud-builder` | Portal / app · NEW | L · 3w | Tenant Product Lead | `/build` surface inside tenant-workspace. Conversation UI driven by sdk-agent-runtime + sdk-ai-gateway, scoped to registry + blueprints |
| Per-SDK manifest authoring | Migration | XL · 6w (parallel) | Each SDK owner | Hand-written portion of `sdk-capability.json` for every existing SDK (~70). Auto-generation handles routes/events/deps; descriptions + scenarios + compliance posture are hand-authored |
| **Pilot vertical: RevOps CRM** | Reference application | M · 2w | Tenant Product Lead | End-to-end demo: blueprint composes sdk-crm + sdk-engagement + sdk-lead-scoring + sdk-campaign + connector-salesforce. Provable in both CLI and Cloud-Agent paths |
| **Dogfood vertical: Projexlight on ProjexCloud** | Reference application | L · 4w (parallel) | Projexlight team | Rebuild Projexlight's PRD/feature/scenario/task surface as a blueprint (`prd-management`) consuming sdk-projection + sdk-identity + sdk-audit + sdk-billing + sdk-ai-gateway + sdk-knowledge-rag + sdk-approval + sdk-webhook + sdk-api-keys. Projexlight retains its proprietary AI-review IP but runs on ProjexCloud's substrate. First real-world stress test of the blueprint model — feedback loop drives Layer 1/2 fixes before external GA |
| **Doctrine §C — Capability-First SDK Authoring** in Architecture | Architecture doc | — | Platform Architect | Every new SDK ships its capability manifest at v1.0 — no exceptions. CI rejects publish without it |
| **Doctrine §D — Composition over Coupling** in Architecture | Architecture doc | — | Platform Architect | SDKs declare what they consume/produce via events + capability manifests; blueprints compose, they don't import-cycle |

---

## 4 · User stories

### As a **Platform Engineer** (internal)
- **US-PE-1**: As a platform engineer, I want every SDK to expose a capability manifest so that I can build new internal tools (admin portal, dashboards, drift detectors) against a single normalized catalog instead of grepping source.
- **US-PE-2**: As a platform engineer, I want CI to reject any SDK that publishes without a valid `sdk-capability.json` so that the catalog never goes stale.
- **US-PE-3**: As a platform engineer, I want the registry to flag breaking changes in an SDK's manifest (removed events, changed signatures) so that downstream consumers are warned before publish.

### As a **Vertical Product Engineer** (internal)
- **US-VE-1**: As the engineer owning the Healthcare Pack, I want to define a blueprint that pins specific SDKs at specific versions with HIPAA guardrails so that any tenant who adopts the pack ships a compliant baseline.
- **US-VE-2**: As a vertical engineer, I want blueprints to be testable end-to-end (scaffold → migrate → run → smoke-test) so that I can ship updates without breaking installed tenants.

### As a **ProjexCloud Operator** (internal staff)
- **US-OP-1**: As an operator, I want a registry browser in `projexcloud-admin` so that I can see which SDKs are most-used across tenants and plan deprecation windows.
- **US-OP-2**: As an operator, I want to see which tenants are running each blueprint version so that I can target communications about updates.

### As a **Tenant Admin** (customer-side)
- **US-TA-1**: As a tenant admin, I want to browse a catalog of vertical blueprints in my workspace so that I can understand what I can build *before* talking to my developers.
- **US-TA-2**: As a tenant admin, I want to grant or revoke "build agent" access per persona so that not every employee can scaffold new applications.
- **US-TA-3**: As a tenant admin, I want to see a manifest of what an installed blueprint touches (tables, events, billing impact) so that I can review before approving.

### As a **Tenant Developer** (customer's engineer)
- **US-TD-1**: As a tenant developer, I want to run `npx @projexlight/cli init my-app` and have my AI coding tool (Claude Code / Cursor / Windsurf) immediately know what SDKs are available so that I can prompt my way to an integration in minutes.
- **US-TD-2**: As a tenant developer, I want my AI tool to suggest the right SDK when I describe a capability in natural language (e.g. "I need consent receipts for GDPR") so that I don't have to read 70 READMEs.
- **US-TD-3**: As a tenant developer, I want a `projex deploy` flow that pushes my code to my tenant's pool, runs migrations, and rolls back on failure so that I don't need to know our pool topology.
- **US-TD-4**: As a tenant developer, I want to start from a blueprint and customize it rather than from a blank page so that my first commit is closer to production than to "hello world."

### As a **Tenant Employee / End User** (non-developer)
- **US-EU-1**: As a non-developer in a tenant, I want to type "I need a claims-intake workflow with photo evidence" into a `/build` chat and get a working application URL within 5 minutes so that I can prototype without filing an IT ticket.
- **US-EU-2**: As a non-developer, I want clarifying questions when my prompt is ambiguous (e.g., "do you want to settle in-app or via Stripe?") so that the generated app matches my intent.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-capability`

**Purpose:** define and validate the `sdk-capability.json` schema that every SDK ships.

**Owns:**
- FR-CAP-1: Publishes a versioned JSON schema for `sdk-capability.json` (`schema_version: "1.0"`). All future bumps are backward-compatible or call a migration.
- FR-CAP-2: Provides a TypeScript type `SdkCapabilityManifest` exported from `@projexlight/sdk-capability`.
- FR-CAP-3: Provides a CLI `npx @projexlight/sdk-capability scaffold` that emits a starter manifest scaffolded from a package's `package.json`, route registrations, and `events.ts` — the developer fills in the prose sections.
- FR-CAP-4: Provides a validator (`validateManifest(json) → { ok, errors }`) used in CI and at registry-build time.
- FR-CAP-5: Manifest fields:
  - `name`, `version`, `schema_version` (required)
  - `summary` (1-paragraph, ≤500 chars)
  - `tags` (string[]) — e.g. `["billing","metering","financial"]`
  - `provides`: `{ endpoints: [], events: [], models: [], hooks: [], ui_components: [] }`
  - `consumes`: `{ events: [], infra: [], config_keys: [] }`
  - `scenarios`: `[{ id, title, when_to_use, example_code, expected_outcome }]` (3–5)
  - `compliance_posture`: `{ regimes: ["HIPAA","SOC2",...], notes }`
  - `pool_placement`: `"admin" | "app" | "evidence" | "global-catalog" | "warehouse" | "vector" | "olap"`
  - `pricing_skus`: `[{ sku, mode, unit_description }]`
  - `links`: `{ readme, source, prd_section }`

**Public API surface (selected):**
```ts
export interface SdkCapabilityManifest { /* per FR-CAP-5 */ }
export function validateManifest(input: unknown): { ok: true; value: SdkCapabilityManifest } | { ok: false; errors: string[] };
export function diffManifests(a: SdkCapabilityManifest, b: SdkCapabilityManifest): ManifestDiff;
```

**Database / storage:** none — pure spec + validator.

**Events published:** none.

**Events subscribed:** none.

**Pool placement:** N/A (build-time package).

**SKUs:** none.

### 5.2 · `@projexlight/sdk-registry`

**Purpose:** scan all SDKs at build time, validate their manifests, produce a normalized catalog + embedding index for semantic search.

**Owns:**
- FR-REG-1: Build-time scanner walks `packages/*/sdk-capability.json` + `services/*/sdk-capability.json`. Missing/invalid manifests fail the build with a structured error pointing at the offending package.
- FR-REG-2: Produces `dist/registry.catalog.json` — a single normalized JSON blob containing all manifests + a derived dependency graph (who-consumes-whose-events).
- FR-REG-3: Produces `dist/registry.embeddings.bin` — a vector index keyed by `(sdk_name, scenario_id)` built with a small open embedding model (default `bge-small-en-v1.5`, configurable). Vectors are deterministic per content hash so CI can cache.
- FR-REG-4: Exposes a runtime API `loadRegistry()` that returns the catalog + an in-memory ANN index for `searchByIntent(query, top_k)`.
- FR-REG-5: Exposes `findCompatibleSdks(sdk_name)` — returns SDKs whose `consumes.events` overlap with the target SDK's `provides.events` (and vice versa).
- FR-REG-6: Exposes `getScaffold(sdk_names, app_name)` — returns a tree of files (TypeScript modules + migration index + sample test) that wires the requested SDKs together.

**Public API surface (selected):**
```ts
export interface Registry {
  list(): SdkCapabilityManifest[];
  get(sdk_name: string): SdkCapabilityManifest | null;
  searchByIntent(query: string, top_k?: number): Promise<RegistryHit[]>;
  findCompatibleSdks(sdk_name: string): string[];
  getScaffold(sdk_names: string[], app_name: string): ScaffoldTree;
}
export function loadRegistry(catalogPath?: string): Promise<Registry>;
```

**Database / storage:**
- No OLTP; reads pre-built JSON + binary embedding index at process start.
- Optional Redis cache for `searchByIntent` results (per query hash, TTL 1 h).

**Events published:** none.

**Events subscribed:** none.

**Pool placement:** Global Catalog (catalog is single-source-of-truth across all pools).

**SKUs:** none — internal/free tier.

### 5.3 · `services/registry-mcp` (HOSTED half)

**Purpose:** Per-region hosted MCP server. Owns the **tenant-scoped reads** and **all writes** (scaffold, deploy, audit, billing). The local CLI-bundled MCP (§5.3b) is its read-cache + write-proxy peer.

**Why split into hosted + local:** read tools are ~95 % of traffic; AI coding tools prefer local stdio MCPs for latency + trust + offline tolerance. But writes (scaffolding into a tenant's pool, deploying, listing tenant-specific SDKs) cannot be trusted to the client — they need server-side identity, audit, billing, and pack guardrails. Splitting cleanly avoids forcing one side to do both jobs poorly.

**Owns:**
- FR-MCP-1: Implements MCP server spec v1 over **SSE** transport (browser / hosted cloud-agent clients).
- FR-MCP-2: Exposes write/scoped tools:
  - `scaffold(sdk_names: string[], app_name: string, target_dir?: string)` — emits an audit event + meters a `scaffold.session` SKU
  - `deploy(scaffold_id: string, env: 'trial'|'staging'|'prod')` — server-side; runs migrations under tenant pool, supports rollback (cross-ref AC-10)
  - `list_my_sdks()` — tenant-scoped: only SDKs in caller tenant's `module_subscriptions`
  - `list_my_blueprints()` — pack-filtered
  - `request_pack_upgrade(pack_id)` — opens an approval request (sdk-approval) so the tenant admin can opt into a new pack
- FR-MCP-3: Authenticates clients via tenant API key (`x-projex-api-key` header) → maps to a SixLayer JWT internally.
- FR-MCP-4: Per-tenant scoping enforced server-side. Public read tools (search/manifest/example) are also exposed here for clients without local cache, but with the SAME results as the local MCP — single source of truth.
- FR-MCP-5: Rate limit per API key: 100 tool calls/min (configurable per plan).
- FR-MCP-6: Every tool call emits `registry.tool.invoked.v1` to the audit chain. Cloud builder's full conversation transcript is reconstructable from this stream (AC-7).
- FR-MCP-7: Pack guardrails (HIPAA/FinServ/PublicSector) enforced via `sdk-policy` decisions BEFORE any scaffold/deploy returns — a guardrail violation is a hard 403 with the policy citation.
- FR-MCP-8: Health endpoint `/healthz` returns `200` only after the catalog + embedding index have loaded.

**Public API surface:** MCP wire protocol over SSE at `/mcp/v1/sse`. Plus `/healthz` HTTP for liveness.

**Database / storage:**
- Reads catalog + embeddings from S3 (catalog object + ANN index files).
- Writes audit events via `sdk-audit`.
- Rate-limit counters + scaffold-id tracking in Redis.

**Events published:** `registry.tool.invoked.v1` (retention class: operational · LWW conflict policy) · `scaffold.created.v1` · `deploy.completed.v1`

**Events subscribed:** none.

**Pool placement:** Global Catalog cluster, one set of replicas per region; reads-only against catalog, writes go through `sdk-audit` + `sdk-meter`.

**SKUs:** `registry.tool.call` (metered, free below plan ceiling) · `scaffold.session` (per scaffold, free during P9 trial) · `deploy.session` (per deploy).

### 5.3b · `@projexlight/registry-mcp-local` (LOCAL half)

**Purpose:** CLI-bundled MCP binary that runs on the developer's machine via stdio. Caches the public catalog locally; answers read tools without network; proxies write tools to the hosted MCP.

**Distribution:** Two equivalent surfaces, dev picks one:
- Docker image `projexcloud/registry-mcp-local:<version>` — single canonical namespace (per Q-11 decision). Clean brand boundary against the existing Projexlight MCPs (`projex_dev_mcp`, `projex_test_mcp`) which retain their `projexlight/` namespace.
- `npx @projexlight/registry-mcp-local` — for devs who don't want Docker.

`@projexlight/cli init` auto-detects which AI tools are installed (Claude Code / Cursor / Windsurf / Cline) and writes the matching MCP config files (`.claude/mcp.json`, `.cursor/mcp.json`, `.windsurf/mcp.json`, etc.) pointing at this local binary.

**Owns:**
- FR-MCP-L1: Speaks the SAME MCP wire protocol as §5.3 — same tool shapes, same response schemas. Calls are indistinguishable to the AI client.
- FR-MCP-L2: Read tools answered from local cache: `search_sdks`, `get_manifest`, `get_example`, `list_compatible_sdks`, `list_blueprints`, `get_blueprint`. Cache lives at `~/.projex/cache/registry.catalog.json` + `~/.projex/cache/registry.embeddings.bin`.
- FR-MCP-L3: Cache refresh: daily background pull from the hosted endpoint `GET /registry/catalog?since=<etag>`. ETag-keyed conditional GET means no-op when nothing changed. Manual refresh: `projex registry refresh`.
- FR-MCP-L4: Write tools proxied to hosted MCP over SSE using the dev's stored API key (from `projex login`). Streaming responses are forwarded unchanged.
- FR-MCP-L5: Offline mode: when the hosted side is unreachable, read tools work from cache; write tools return a structured error pointing the dev at `projex deploy --queue` (queue locally, drain on reconnect).
- FR-MCP-L6: Telemetry-free by default; opt-in `projex telemetry on` sends anonymous usage counters (which tools the AI calls most) to help tune the catalog.

**Public API surface:** MCP stdio (no HTTP). One config knob via env: `PROJEX_HOSTED_MCP=https://mcp.<region>.projexcloud.com`.

**Database / storage:** Local-only — JSON catalog + binary embedding index in `~/.projex/cache/`.

**Events published:** none directly; proxied writes cause hosted events.

**Events subscribed:** none.

**Pool placement:** N/A (client-side).

**SKUs:** none — free distribution; costs only accrue when proxied writes hit the hosted side.

### 5.4 · `blueprints/` library

**Purpose:** declarative compositions of SDKs that produce a runnable vertical application.

**Owns:**
- FR-BP-1: Each blueprint is a directory under `blueprints/<blueprint_id>/` containing:
  - `blueprint.yaml` — metadata + SDK list + clarifying questions + scaffold variants
  - `templates/` — file templates with Handlebars-style placeholders for app_id, tenant_id, blueprint-specific choices
  - `seed/` — sample data SQL + fixture records
  - `tests/` — smoke-test scripts that validate the blueprint produced a working app
- FR-BP-2: Schema-validated `blueprint.yaml`:
  ```yaml
  id: revops-crm
  schema_version: "1.0"
  title: RevOps CRM
  summary: A B2B sales CRM with lead-routing and Salesforce sync
  pack: general | healthcare | finserv | public-sector
  sdks:
    - { name: sdk-crm, version: ^1.0 }
    - { name: sdk-engagement, version: ^1.0 }
    - { name: sdk-lead-scoring, version: ^1.0 }
    - { name: sdk-campaign, version: ^1.0 }
    - { name: connector-salesforce, version: ^1.0 }
  clarifying_questions:
    - id: sf_sync_direction
      prompt: Should leads sync from Salesforce → ProjexCloud, or both directions?
      type: enum
      options: [salesforce-to-projex, bidirectional]
  outputs:
    - { path: src/leads/intake.ts, template: templates/intake.ts.hbs }
    - { path: db/migrations/001_init.sql, template: templates/init_sql.hbs }
  estimated_minutes: 5
  ```
- FR-BP-3: Blueprint installer (`projex blueprint apply <id>`) reads YAML → asks clarifying questions → resolves templates → writes files → runs migrations → seeds data → runs smoke tests.
- FR-BP-4: Blueprint registry is versioned independently per blueprint; tenants opt into update windows.
- FR-BP-5: Pilot ships 6 blueprints:
  - `revops-crm` (pilot for end-to-end CLI + cloud-agent demo)
  - `field-dispatch`
  - `claims-intake`
  - `b2b-analytics`
  - `patient-portal`
  - `prd-management` (the **Projexlight dogfood blueprint** — see §5.7. Composes sdk-projection + sdk-identity + sdk-audit + sdk-billing + sdk-ai-gateway + sdk-knowledge-rag + sdk-approval + sdk-webhook + sdk-api-keys. Customers can install a "Projexlight-like" PRD/spec workspace; Projexlight the product runs its own private logic atop this blueprint)

**Events published:** `blueprint.installed.v1` · `blueprint.upgraded.v1`

**Events subscribed:** none.

**Pool placement:** Global Catalog (definitions); installs land in the tenant's pool.

**SKUs:** `blueprint.install` — one-time per install (free during P9).

### 5.5 · `@projexlight/cli`

**Purpose:** the developer-facing entry point. Installs into a customer dev's local machine; configures their AI coding tool to talk to the tenant's MCP.

**Owns:**
- FR-CLI-1: `projex login` — OAuth device flow against the tenant's identity SDK. Stores a refresh token in OS keychain.
- FR-CLI-2: `projex init <app_name> [--blueprint <id>]` — creates a local repo skeleton, writes `.claude/mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), `.windsurf/mcp.json` (Windsurf) — auto-detects which AI tools are installed and writes only the configs needed.
- FR-CLI-3: `projex install <sdk_name>` — adds an SDK to the local repo's `package.json`, fetches its manifest, drops a starter snippet in `src/integrations/<sdk>.ts`.
- FR-CLI-4: `projex blueprint list | apply <id>` — wraps Layer 3.
- FR-CLI-5: `projex deploy [--env trial|staging|prod]` — packages the local app, uploads to the tenant's pool, triggers migrations, returns a URL.
- FR-CLI-6: `projex logs [--tail]` — streams logs from the deployed app.
- FR-CLI-7: All commands accept `--json` for scripting.
- FR-CLI-8: Auto-update mechanism: warns when a newer CLI is available; never auto-installs without consent.

**Distribution:** `npm i -g @projexlight/cli` and `npx @projexlight/cli`. Binary builds (`projex` for macOS / Linux / Windows) via `pkg`.

**Pool placement:** N/A (client-side).

**SKUs:** none.

### 5.6 · Cohabitation with existing Projexlight MCPs

**Decision:** the new `registry-mcp-local` is a **peer**, not a replacement, of the existing `projex_dev_mcp` and `projex_test_mcp` (Projexlight's dev + test MCPs at `projex_mcp/projex_dev_mcp` and `projex_mcp/projex_test_mcp`). They expose disjoint tool catalogs to AI clients.

| MCP | Tool catalog | Lives | Auth |
|---|---|---|---|
| `projex_dev_mcp` | Projexlight PRD/feature/scenario/task ops; LLM review; autofix; embedding | Docker, local | Projexlight project API key |
| `projex_test_mcp` | UI test recorder; API functional-test runner | Docker, local | Projexlight project API key |
| **`registry-mcp-local`** (new) | **ProjexCloud SDK catalog**: search, manifest, scaffold, deploy | Docker or npx, local | ProjexCloud tenant API key |
| **`registry-mcp`** (new) | Same wire surface; tenant-scoped + write-authoritative | Hosted, per-region | ProjexCloud tenant API key (SixLayer JWT minted internally) |

**FR-COHAB-1:** `projex init` writes one `.claude/mcp.json` (or per-tool equivalent) that lists *both* Projexlight MCPs (if Projexlight is detected on the dev's machine via `~/.projexlight/config.json`) *and* the new `registry-mcp-local`. An AI client (Claude Code, Cursor, Windsurf) sees all of them in one tool list and routes calls by name.

**FR-COHAB-2:** Naming convention: all ProjexCloud registry tools are prefixed `projex_registry_*` (e.g. `projex_registry_search_sdks`). Projexlight tools are prefixed `projexlight_*`. Zero name collisions, even when both MCPs are loaded.

**FR-COHAB-3:** Shared dev-experience layer: both Projexlight and ProjexCloud install via the same one-liner (`curl ... | bash` or `winget install projexlight.tools`) which then installs the requested MCPs. Customers learn one install pattern.

### 5.7 · Projexlight-on-ProjexCloud (the dogfood pilot)

**Purpose:** rebuild Projexlight's surface as a vertical app composed from ProjexCloud SDKs, using the `prd-management` blueprint. Projexlight retains its proprietary AI-review IP (as a private SDK in Projexlight's tree, optionally publishable to the registry later), but every cross-cutting concern (multi-tenancy, identity, billing, audit, webhooks, approvals, search, AI gateway) is delegated to ProjexCloud SDKs.

**Why now:** Projexlight is the highest-fidelity real-world test of the blueprint model. External pilot tenants will hit edge cases ~2 weeks after they start building; doing Projexlight in parallel during weeks 50–60 means we find those gaps in our own product first.

**Owns:**
- FR-DF-1: A new repo (or branch of existing Projexlight) that imports `@projexlight/sdk-projection`, `@projexlight/sdk-identity`, `@projexlight/sdk-billing`, `@projexlight/sdk-audit`, `@projexlight/sdk-approval`, `@projexlight/sdk-webhook`, `@projexlight/sdk-knowledge-rag`, `@projexlight/sdk-ai-gateway`, `@projexlight/sdk-api-keys`, and the existing Projexlight-private AI logic.
- FR-DF-2: The `prd-management` blueprint installer generates a starter Projexlight-shaped app (epic/feature/scenario/task model, AI-review hooks, webhook subscriptions). Projexlight's production deployment becomes the canonical reference install.
- FR-DF-3: Projexlight's dev MCP (`projex_dev_mcp`) becomes the canonical reference for "tenant-specific MCPs" — a customer building a vertical app sees Projexlight as the worked example of how to ship their own domain MCP alongside their app.
- FR-DF-4: Migration plan: feature-flag Projexlight to read/write via ProjexCloud SDKs in a shadow mode first; flip cutover per surface (identity → projects → tasks → review → webhooks). No big-bang.
- FR-DF-5: Bidirectional bug-fix protocol: every gap Projexlight hits during dogfood is filed as a P9 PRD amendment within 1 business day; resolution lands in ProjexCloud SDKs (not Projexlight's local workaround) unless the gap is Projexlight-domain-specific.

**Effort:** L · 4 weeks (parallel to the rest of P9). Owned by Projexlight team in coordination with Platform Architect.

**Acceptance:** AC-11 (see §7). Projexlight production instance must run entirely on `prd-management` blueprint + private domain SDK before P9 GA.

### 5.8 · ai-appgen as precursor (lessons-learned migration)

**Context:** `ai-appgen` (a separate repo at `C:\Users\srima\ai-appgen`) is an earlier full-stack attempt at AI-generated multi-tenant SaaS apps. It is not part of ProjexCloud and is NOT being merged. It is, however, a rich source of patterns that should inform Layer 1–4 design.

**FR-AAG-1:** Audit `ai-appgen/CLAUDE.md` rules (mandatory file/table search, modular-architecture layers, auth-service separation) → port the relevant rules into:
- The default `CLAUDE.md` written by `projex init` for tenant developers.
- The cloud builder agent's system prompt.
- The scaffold templates' default linters.

**FR-AAG-2:** Audit `ai-appgen/mcp/` integration → cross-reference any MCP tool shapes that work well for AI-generated SaaS and consider exposing equivalents in `registry-mcp`.

**FR-AAG-3:** Migration path for existing ai-appgen tenants (if any are in production): document a "convert ai-appgen app to ProjexCloud blueprint" recipe by P9 GA. No commitment to automated migration.

**Effort:** S · 1 week. Owned by Platform Architect (audit) + Tenant Product Lead (recipe).

### 5.9 · `apps/cloud-builder`

**Purpose:** hosted no-code-ish entry point. Lives at `/build` inside tenant-workspace.

**Owns:**
- FR-CB-1: Chat UI driven by `sdk-agent-runtime` + `sdk-ai-gateway`. Agent's tool set is the MCP server's exposed tools (Layer 3 inside the tenant's scope).
- FR-CB-2: Agent flow: search blueprints → present top 2–3 matches → ask clarifying questions defined in the matched blueprint → confirm → spawn isolated sandbox in tenant's app pool → run blueprint installer → return URL.
- FR-CB-3: All agent steps emit audit events; tenant admin sees a full trace per build.
- FR-CB-4: Guardrails: agent refuses to scaffold blueprints whose required SDKs are outside the tenant's `module_subscriptions` *unless* the tenant admin explicitly grants opt-in during the build.
- FR-CB-5: Pack-aware guardrails (HIPAA pack: agent refuses to write PHI fields to unencrypted columns, etc.) enforced via `sdk-policy` rules tagged with the pack ID.
- FR-CB-6: Build retention: scaffolded apps stay in the tenant's pool indefinitely; the build conversation transcript retains for 30 days.

**Pool placement:** Tenant App Pool (per-tenant).

**SKUs:** `builder.session` — metered per build, free during P9 trial.

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Latency (p99) — `search_sdks` | 300 ms (cold), 80 ms (warm cache) |
| Latency (p99) — blueprint `apply` (5-SDK blueprint) | 60 s end-to-end (scaffold → migrate → seed → smoke test) |
| Latency — `projex deploy` (small app, ≤ 50 files) | 90 s p99 |
| Throughput — MCP tool calls | 1,000 RPS aggregate; 100 RPM per API key |
| Availability — registry MCP service | 99.9 % monthly |
| Durability — registry catalog | RPO ≤ 1 h (S3-backed); rebuildable from source in ≤ 10 min |
| Security | API keys hashed at rest (sdk-api-keys); MCP transport over TLS 1.3; SSE auth via per-key short-lived session token; CLI tokens in OS keychain |
| Compliance | Per-pack: HIPAA / SOC 2 / FedRAMP-Moderate map to the SDKs each pack pre-installs; agent enforces pack guardrails via `sdk-policy` |
| Cost guardrails | Cloud builder per Q-4: Trial 3 builds/month hard-cap · Pro 20 builds/month + $2/build OR token pass-through (lower wins) · Enterprise unlimited · 1-hour iteration window per session. Enforced via `sdk-meter` soft+hard caps. |

---

## 7 · Acceptance criteria (the phase exit gate)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | Every existing SDK in `packages/*` has a valid `sdk-capability.json`; CI fails any PR that publishes an SDK without one. | Platform Architect | CI gate `validate-manifests` runs `validateManifest` over every `sdk-capability.json`; new SDK fixture without manifest must fail CI in a contract test |
| **AC-2** | `@projexlight/sdk-registry` build produces a normalized catalog + embedding index in ≤ 10 minutes on standard CI hardware; output is deterministic per content hash. | Platform Architect | CI job times the build twice; diffs the output bytes — must be byte-identical when inputs unchanged |
| **AC-3** | `search_sdks("consent receipts for GDPR")` returns `sdk-consent` in the top 3 hits with score ≥ 0.7. | Platform Architect | Test suite with 50 intent queries → expected SDK; precision@3 ≥ 0.9 |
| **AC-4** | A fresh tenant developer can run `npx @projexlight/cli init my-app --blueprint revops-crm`, open Claude Code, prompt "add a lead-routing rule", and have the AI write working integration code without the developer reading any SDK README. | Developer Experience Lead | Recorded user test with 3 external devs; success criteria: app deploys successfully, lead-routing rule works on demo data, dev completes in ≤ 45 min |
| **AC-5** | A non-developer signs up for a new tenant, opens `/build`, types "I want a claims intake workflow with photo evidence", answers 3 clarifying questions, and within 5 minutes gets a working URL serving the scaffolded application. | Tenant Product Lead | Recorded user test with 3 non-dev personas (operations manager, BA, founder); p99 time-to-URL ≤ 5 min; all 3 tests must succeed |
| **AC-6** | MCP server sustains 1,000 RPS aggregate with p99 latency ≤ 300 ms cold, ≤ 80 ms warm for `search_sdks`. | Platform Architect | k6 load test against staging cluster, 3 replicas, with mixed `search/get/list` traffic |
| **AC-7** | Audit chain (`registry.tool.invoked.v1`) covers every MCP tool call; an operator can reconstruct an agent's entire build session from the chain. | Platform Architect | Chaos test: scaffold a blueprint, then verify the audit chain replay produces a faithful step-by-step transcript |
| **AC-8** | Healthcare pack guardrail demo: cloud agent attempts to scaffold a blueprint with a PHI field bound to an unencrypted column → agent refuses, citing the offending policy. | Tenant Product Lead | Integration test using sdk-policy fixtures; agent transcript must contain the policy violation reason |
| **AC-9** | All 5 pilot blueprints (revops-crm, field-dispatch, claims-intake, b2b-analytics, patient-portal) install and pass their smoke tests in CI on a clean tenant. | Tenant Product Lead | CI job spins ephemeral tenants, runs `projex blueprint apply` for each blueprint, asserts smoke tests pass |
| **AC-10** | CLI `projex deploy` rolls back cleanly on migration failure: tenant's app pool returns to its pre-deploy state, no orphaned tables, no half-written rows. | Developer Experience Lead | Chaos test injects a migration failure mid-deploy; post-state diff against pre-state must be empty |
| **AC-11** *(P9.1 gate — see §12 step 8)* | Projexlight production runs entirely on the `prd-management` blueprint + Projexlight-private domain SDK. No direct Postgres writes from Projexlight code; every persistent op routes through a ProjexCloud SDK. | Projexlight team + Platform Architect | Production traffic audit over a 7-day window: zero non-SDK DB writes traced; all events visible in the per-tenant audit chain |
| **AC-12** | The local `registry-mcp-local` answers all read tools from cache with zero network when the dev is offline; reconnect resumes proxied writes with no data loss. | Developer Experience Lead | Chaos test: disable network, run `search_sdks` + `get_manifest` + `get_example` (must succeed); attempt `scaffold` (must queue and surface a clear "queued" status); reconnect and verify queued ops drain |
| **AC-13** | `registry-mcp-local` and `projex_dev_mcp` coexist in one Claude Code config without tool-name collisions; an AI client can call tools from both in the same session. | Developer Experience Lead | Integration test: load both MCPs in a Claude Code config; invoke `projex_registry_search_sdks` and `projexlight_create_feature` in the same session — both succeed |

---

## 8 · Test plan (per acceptance criterion)

### AC-1 · Every SDK has a valid manifest
**Scenario:** Given the monorepo at HEAD, When CI runs `pnpm registry:validate`, Then every package under `packages/*` and `services/*` must have an `sdk-capability.json` that passes `validateManifest`. A PR that introduces a new SDK without a manifest must fail CI with a clear error.

**Test type:** CI contract test.

**Environment:** GitHub Actions CI.

**Pass condition:** Zero `MANIFEST_MISSING` or `MANIFEST_INVALID` errors. Fixture PR with missing manifest must fail.

**Evidence captured:** CI logs in the registry-validate job.

### AC-2 · Deterministic registry build
**Scenario:** Run `pnpm registry:build` twice on identical inputs; `dist/registry.catalog.json` and `dist/registry.embeddings.bin` bytes must match.

**Test type:** CI integration.

**Environment:** GitHub Actions CI, same runner image.

**Pass condition:** `sha256sum` matches across two runs.

**Evidence captured:** CI artifact hash recorded.

### AC-3 · Semantic search precision
**Scenario:** Run a fixed suite of 50 intent queries against the registry's `searchByIntent`. Compare top-3 against expected SDK.

**Test type:** Offline eval suite, run nightly.

**Environment:** Staging registry.

**Pass condition:** precision@3 ≥ 0.9; recall@3 ≥ 0.85 (no intent query returns zero relevant SDKs in top 3).

**Evidence captured:** Precision/recall report uploaded as build artifact; regressions paged.

### AC-4 · End-to-end developer test (CLI)
**Scenario:** Recruit 3 external developers unfamiliar with ProjexCloud. Each runs `npx @projexlight/cli init my-app --blueprint revops-crm`, opens Claude Code, and is given the task: "add a rule that routes leads from EU to our EU team queue." They are not allowed to read SDK READMEs.

**Test type:** Manual user test.

**Environment:** Staging tenant.

**Pass condition:** All 3 dev's apps deploy successfully; the routing rule works against demo data; each dev finishes in ≤ 45 min; post-test survey averages ≥ 4/5 on "I knew what to do."

**Evidence captured:** Screen recordings + transcripts + survey responses.

### AC-5 · End-to-end non-dev test (Cloud agent)
**Scenario:** Recruit 3 non-developers (ops manager, BA, founder profile). Each signs up for a new tenant, opens `/build`, types "I want a claims intake workflow with photo evidence." They answer the 3 clarifying questions however they like and click Deploy.

**Test type:** Manual user test.

**Environment:** Staging tenant + cloud builder.

**Pass condition:** All 3 tests succeed in ≤ 5 minutes from prompt to working URL; all 3 URLs serve a working claims-intake form with photo upload.

**Evidence captured:** Screen recordings + audit chain traces.

### AC-6 · MCP throughput & latency
**Scenario:** k6 load test with mixed traffic: 60 % `search_sdks`, 30 % `get_manifest`, 10 % `list_blueprints`. Ramp 0 → 1,000 RPS over 5 min, hold 10 min, ramp down.

**Test type:** Load test.

**Environment:** Staging cluster, 3 MCP replicas.

**Pass condition:** p99 `search_sdks` ≤ 300 ms cold, ≤ 80 ms warm; zero 5xx; CPU < 80 %.

**Evidence captured:** k6 report archived; Grafana snapshot.

### AC-7 · Audit chain coverage
**Scenario:** Scaffold a blueprint end-to-end via cloud agent. Pull the per-tenant audit chain for that session. Verify every MCP tool call appears, in order, with arguments and outcomes.

**Test type:** Integration test.

**Environment:** Staging.

**Pass condition:** 100 % coverage of tool calls; chain verifies; replay reconstructs the build session faithfully.

**Evidence captured:** Audit chain dump + replay diff.

### AC-8 · HIPAA pack guardrail
**Scenario:** On a tenant enrolled in the Healthcare pack, prompt the cloud agent to scaffold a custom blueprint that maps a `patient_ssn` field to an unencrypted column. Agent must refuse and cite the policy rule.

**Test type:** Integration test with sdk-policy fixtures.

**Environment:** Staging.

**Pass condition:** Agent response includes `PolicyViolation: patient_ssn must be sdk-vault-encrypted`; no rows written.

**Evidence captured:** Agent transcript + policy decision log.

### AC-9 · Blueprint smoke tests
**Scenario:** CI spins 5 ephemeral tenants. For each blueprint, runs `projex blueprint apply`, then the blueprint's smoke-test script (e.g., for revops-crm: create a lead via API, verify it appears in the lead table, fires `lead.created.v1`, and triggers a routing rule).

**Test type:** CI integration.

**Environment:** Ephemeral CI tenants.

**Pass condition:** All 5 blueprints pass; total CI time ≤ 25 min.

**Evidence captured:** CI logs + per-blueprint smoke-test report.

### AC-11 · Projexlight dogfood cutover
**Scenario:** Projexlight production is migrated to read/write through ProjexCloud SDKs. Over a 7-day observation window, audit every persistent operation (DB writes, S3 puts, vault writes).

**Test type:** Production traffic audit + audit-chain reconciliation.

**Environment:** Projexlight production tenant on ProjexCloud.

**Pass condition:** 100 % of persistent ops correspond to an SDK service call; zero direct `pg.query` or raw infra writes in Projexlight's code paths (verified via grep + runtime stack-trace sampling).

**Evidence captured:** Audit chain export + grep report + runtime trace sample.

### AC-12 · Offline read tools + queued writes
**Scenario:** Developer uses `registry-mcp-local` with network disabled. Runs `search_sdks`, `get_manifest`, `get_example` (reads). Attempts `scaffold` (write). Reconnects. Queued scaffold must drain.

**Test type:** Chaos test (network partition).

**Environment:** Local dev container with controlled network.

**Pass condition:** All reads succeed offline; write returns `{ status: 'queued', queued_id: ... }`; after reconnect, `projex registry drain` completes the queued write within 30 s; result is byte-identical to the same write done online.

**Evidence captured:** CLI stdout transcript + queue file diff.

### AC-13 · MCP cohabitation
**Scenario:** Developer machine has both `projex_dev_mcp` (Projexlight) and `registry-mcp-local` (ProjexCloud) configured in Claude Code's `~/.claude/mcp.json`. Open Claude Code; ask: "Search ProjexCloud SDKs for 'lead scoring' and create a Projexlight feature called 'Add lead-score badge'."

**Test type:** Integration test (manual + scripted).

**Environment:** Local dev machine.

**Pass condition:** Claude Code calls `projex_registry_search_sdks` against `registry-mcp-local` AND `projexlight_create_feature` against `projex_dev_mcp` in the same session; both succeed; tool list shown to user contains both prefixes with no name collision.

**Evidence captured:** Claude Code transcript + MCP server logs from both MCPs.

### AC-10 · Deploy rollback
**Scenario:** `projex deploy` against a staging tenant; inject a SQL failure into one of the migrations. Verify the deploy aborts, pool state is restored to pre-deploy snapshot, and the CLI surfaces a clear error.

**Test type:** Chaos test.

**Environment:** Staging.

**Pass condition:** Post-rollback state diff against pre-deploy snapshot is empty; CLI exit code non-zero; error message names the failing migration.

**Evidence captured:** Snapshot diff + CLI stderr.

---

## 9 · Dependencies (what must be true entering this phase)

- ✅ Phase P8 exit gate green (deployment variants — BYOK, Sovereign, On-Prem, Active-Active — all verified)
- ✅ `sdk-agent-runtime` v1.0 published (P6A) — drives cloud builder agent
- ✅ `sdk-ai-gateway` v1.0 published (P6A) — required for cloud builder LLM calls
- ✅ `sdk-mcp-bridge` v1.0 published (P6A) — the MCP runtime substrate
- ✅ `sdk-audit`, `sdk-policy`, `sdk-meter`, `sdk-api-keys` stable (P1–P4) — audit chain + guardrails + metering + auth
- ✅ ProjexCloud-admin tenant provisioning UI in place (delivered in P8 productization work)
- ✅ Tenant-workspace `/signup` self-serve flow live (delivered alongside P8 productization)
- ✅ Architecture Working Group sign-off on Doctrine §C (Capability-First) and §D (Composition over Coupling)

---

## 10 · Out of scope (deferred to later phases)

- ❌ Visual no-code app builder (drag-and-drop UI on top of blueprints) → P10
- ❌ Multi-blueprint composition (install blueprint A *and* blueprint B with conflict resolution) → P10
- ❌ Automated migration tool for `ai-appgen` apps → conversion recipe documented (FR-AAG-3), automation deferred to backlog
- ❌ Projexlight's private AI-review logic published as a public SDK → see Q-9
- ❌ Per-vertical pack guardrail libraries beyond Healthcare/FinServ/PublicSector (e.g. Retail-Loss-Prevention, EdTech-FERPA) → P10
- ❌ Self-serve SDK authoring by tenants (3rd-party SDK marketplace) → P11
- ❌ Cloud builder generative UI (UI components, not just backend logic) → P10
- ❌ Mobile-app blueprints (HDK-driven native bundles) → P10
- ❌ Blueprint billing-as-a-service (resellers selling their blueprints) → P11
- ❌ AI fine-tuning the agent on per-tenant code → P11

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Hand-authored manifests for ~70 SDKs is a 6–12 person-week lift; quality varies by SDK owner. | H | M | **Mitigated by Q-5 decision (locked 2026-05-25):** distributed authoring + central review + CI gate + pair-author first 5 + quarterly catalog-quality audit. Auto-scaffold via `sdk-capability scaffold` cuts each manifest to ~half-day of prose for the SDK owner. CI blocks PR merge on schema/lint failure including "TBD" scenarios. Likelihood downgraded H→M. |
| R-2 | MCP protocol churn — Anthropic / open spec evolves and breaks our wire compat. | M | M | Version the MCP server endpoint (`/mcp/v1`); track upstream spec via subscribed RFC channel; quarterly compat audit. |
| R-3 | Semantic search precision insufficient (precision@3 < 0.9) — AI agents pick wrong SDKs. | H | M | Eval suite (50 → 200 queries) run nightly; tune embedding model and re-index when precision drifts. Fall back to keyword search if embeddings unavailable. |
| R-4 | Cloud builder generates unsafe code that bypasses tenant guardrails (PHI leak, billing escape, etc.). | H | L | Layer 4 guardrails are sdk-policy decisions enforced server-side, not agent-side. Independent policy regression suite per pack. Pen-test before GA. |
| R-5 | `projex deploy` corrupts a tenant's pool on migration failure. | H | M | Pool snapshot before every deploy; automatic rollback on any migration error; deploy job is transactional per pool. |
| R-6 | Tenant developers reject the CLI in favor of direct SDK imports, splintering the ecosystem. | M | M | CLI never blocks — it's optional sugar. Direct imports work too, with manifests still discoverable via the registry HTTP API. |
| R-7 | Cloud agent costs spike — LLM tokens per build session balloon past $0.50 ceiling. | M | H | Hard cap on LLM tokens per session (sdk-meter); agent retries are exponentially backed off; transcript truncation past 30k tokens. |
| R-8 | MCP rate limits triggered by a single chatty AI tool create a bad first-run UX. | M | M | Generous default (100 RPM/key); per-key burst tokens; clear error message that points to upgrade path. |
| R-9 | Projexlight dogfood slips → cascading delay to P9 GA. | H | L | **Mitigated by Q-8 decision (locked 2026-05-25):** AC-11 is officially deferred to P9.1 (week 64). P9 GA fires when 12 of 13 ACs are green (AC-1..AC-10, AC-12, AC-13). AC-11 closes 2 weeks later. Projexlight team owns the P9.1 burn-down without holding the platform release. |
| R-10 | Local MCP cache goes stale and AI suggests a removed SDK. | M | M | Daily auto-refresh; `projex registry refresh` for manual; manifest diff at install time refuses to install an SDK no longer in the live catalog. |
| R-11 | Two MCPs in Claude Code config confuse non-technical users. | L | M | `projex init` is the only sanctioned config writer; auto-generates correct configs; surfaces a single "MCP status" command to verify both loaded. |

---

## 12 · Rollout plan

1. **Internal alpha** (weeks 50–53): Platform Engineering uses the CLI + MCP against the monorepo. Validates AC-1, AC-2, AC-3, AC-6. Manifests written for the 5 pilot-blueprint SDKs only.
2. **Internal dogfood** (weeks 53–56): All internal engineers use the registry + CLI when scaffolding new internal tools. Remaining ~65 SDK manifests authored in parallel via SDK-owner sprints.
3. **Friendly beta** (weeks 56–58): 5 design-partner tenants (mix of dev + non-dev personas) get CLI and cloud builder access. Drive AC-4, AC-5 user tests.
4. **Staging gate** (week 58): All AC green except AC-9 (which requires all 5 blueprints). Architecture WG + Security review.
5. **Per-region rollout** (weeks 59–61): dev region → US-East primary → EU primary → APAC. MCP servers stand up alongside each region's api-gateway cluster.
6. **GA gate** (week 61): All 10 ACs verified; pen-test clean; pricing model published.
7. **Customer-facing announcement** (week 62): Blog post + docs site + sample-app gallery + Claude Code MCP marketplace listing.
8. **P9.1 follow-up gate** (week 64): AC-11 (Projexlight dogfood cutover) verified. Per Q-8 decision (locked 2026-05-25), AC-11 is **explicitly deferred from the P9 GA gate to P9.1** so platform GA is not blocked by Projexlight team's migration cadence. P9 ships with 12 ACs green (AC-1..AC-10, AC-12, AC-13); AC-11 closes 2 weeks later as the dogfood cutover lands.

---

## 13 · Open questions / decisions needed

- [x] **Q-1 — DECIDED 2026-05-25:** Embedding model is **`bge-small-en-v1.5`** loaded via **`@huggingface/transformers`** (INT8-quantized ONNX, ~33 MB on disk, ~150 MB resident). Runs in-process in both `services/registry-mcp` (hosted) and `@projexlight/registry-mcp-local` (CLI-bundled) — no separate inference service, no per-query API cost. CI also uses it to embed SDK descriptions at catalog-build time. Recall is on par with `text-embedding-3-small` for a 70-SDK corpus; saves ~$140/month at projected traffic and is required for AC-12 (offline reads).
- [x] **Q-2 — DECIDED 2026-05-25:** Hosted MCP transport is **SSE** (Server-Sent Events). Aligns with Anthropic's MCP spec recommendation and Claude Code's remote MCP support. SSE's HTTP-native design works through corporate firewalls without WebSocket-upgrade friction, supports horizontal scaling without sticky sessions, and matches our request-response traffic shape (no full-duplex chat needs). Local MCP continues to use stdio (not a choice — local is always stdio).
- [x] **Q-3 — DECIDED 2026-05-25:** Blueprint versioning is **semver-tier auto-policy**: **patch** bumps auto-apply with tenant-admin notification (bug fixes + security); **minor** bumps require admin approval with 30-day reminder (new features may need config); **major** bumps require admin approval + migration plan and the old major retains a 90-day deprecation window. Industry-standard pattern (Helm, K8s operators, Renovate). Balances security hygiene against feature-creep ops burden.
- [x] **Q-4 — DECIDED 2026-05-25:** Cloud-builder pricing is **tier inclusion + metered overage**. Trial: 3 free builds/month, hard-cap (block + upgrade prompt). Pro: 20 free builds/month, overage $2/build OR pass-through LLM token cost, whichever is lower. Enterprise: unlimited. A "build session" = one prompt-to-deployed-URL flow including iterations within 1 hour of the initial prompt (refinements don't double-charge). Matches AI-SaaS norms (Vercel v0, Lovable). Tier inclusion drives upgrade conversion; pass-through cap protects against chatty-user downside.
- [x] **Q-5 — DECIDED 2026-05-25:** **Distributed authoring + central review + CI gate.** SDK owners author their own manifests using `sdk-capability scaffold` for auto-generatable boilerplate. Platform team owns the schema, validator, quality checklist (≥3 scenarios with working code, compliance posture filled, summary ≤500 chars), and code-review on every manifest PR. CI blocks merge on schema-fail or lint-fail (e.g., "TBD" in scenario code). **First 5 manifests pair-authored** by SDK owner + platform team to calibrate the quality bar. Platform team runs **quarterly catalog-quality audit** (precision@3 metric) and submits rewrite PRs for weakest manifests. This is the explicit mitigation for R-1.
- [x] **Q-6 — DECIDED 2026-05-25:** **`npx` only for v1; native binaries deferred to P10.** Most P9 users are tenant developers who already have Node 20+. Mitigation for non-Node users: ship a one-line installer (`curl https://install.projexcloud.com | bash` on mac/linux; `iex (irm https://install.projexcloud.com/win)` on Windows) that installs Node if missing and creates a `projex` shell alias wrapping `npx @projexlight/cli` — Node becomes invisible. Reassess at GA: if customer feedback shows Node install is a blocker (especially among Python/Go teams), ship native binaries early in P10. Saves ~2 weeks of cross-platform pipeline work (signing certs, auto-update infra) that's better spent on more SDK manifests.
- [x] **Q-7 — DECIDED 2026-05-25:** **Confirm-by-default + per-tenant opt-in autonomous with $ ceiling.** Default: agent generates a scaffold preview → user must click **Deploy** to proceed. Opt-in: tenant admin sets `cloud_builder.autonomous = true` with a per-session $ ceiling (default $10/build); agent may deploy without explicit confirm until ceiling hit. **Destructive operations** (delete records, modify already-installed blueprint, touch production data) ALWAYS require confirm — autonomous mode never overrides this gate. Mirrors Anthropic/Cursor's safe-by-default pattern.
- [x] **Q-8 — DECIDED 2026-05-25 (timing portion):** AC-11 (Projexlight dogfood cutover) is **deferred from P9 GA to P9.1 (week 64)**. P9 GA gate is 12 ACs (all except AC-11). Projexlight cutover order itself (identity → projects → tasks → AI review → webhooks) remains the recommended sequence; final order owned by Projexlight team.
- [x] **Q-9 — DECIDED 2026-05-25:** Projexlight's private AI-review logic stays **Projexlight-internal** for P9. May ship as a premium add-on SDK in a later phase once the registry distribution model is proven. P9 commercial story does not depend on it.
- [x] **Q-10 — DECIDED 2026-05-25:** **Conversion recipe + white-glove for top 5–10 + EOL at P10 (~6 months runway).** No automated migration — building a converter is months of work for a small user base, bad ROI. By P9 GA: publish docs page "Migrating from ai-appgen to ProjexCloud" with side-by-side concept mapping (ai-appgen modules → ProjexCloud SDKs/blueprints). Offer 1-1 migration consulting (~40 hrs/tenant cap) to top 5–10 ai-appgen tenants, owned by Solutions Engineering. EOL announced at P9 GA; sunset at P10 release. Post-EOL: customers either complete migration, take their data and self-host (export tooling provided), or buy legacy ai-appgen hosting as a managed service.
- [x] **Q-11 — DECIDED 2026-05-25:** Publish to **`projexcloud/`** namespace only. Clean brand boundary: `projexcloud/registry-mcp-local` is the canonical image for the new P9 MCP. Existing Projexlight MCPs (`projex_dev_mcp`, `projex_test_mcp`) stay under `projexlight/` and are not affected. Single namespace simplifies docs, CI, and customer mental model.

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI (Platform Architect) | | | |
| Developer Experience Lead | | | |
| Tenant Product Lead | | | |
| Architecture Working Group | | | |
| Security / Compliance | | | |
| Engineering Lead | | | |
| Pricing / Finance | | | |
