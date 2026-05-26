# Migrating from `ai-appgen` to ProjexCloud (FR-AAG-1..3 / Q-10)

This is the **conversion recipe** committed at P9 GA per Q-10 (locked
2026-05-25). No automated migration; manual side-by-side mapping with
white-glove consulting for top tenants.

Sunset timeline: announced at P9 GA, ai-appgen hosting EOL at P10 release.
Post-EOL: customers complete the migration, self-host with export tooling,
or buy ai-appgen legacy hosting as a managed service.

---

## Concept mapping (FR-AAG-1)

| `ai-appgen` concept | ProjexCloud equivalent |
|---|---|
| `modular-architecture/{module}/auth-service` | `@projexlight/sdk-identity` |
| `modular-architecture/{module}/data-service` | `@projexlight/sdk-tenant` + per-domain SDK |
| `modular-architecture/{module}/api-routes` | App scaffold from `projex init` + per-SDK `*.server` exports |
| `mcp/server-tools.ts` | `services/registry-mcp` + `@projexlight/registry-mcp-local` |
| `mcp/database-tools.ts` | `@projexlight/db-runtime` query helpers |
| `mcp/auth-tools.ts` | `@projexlight/sdk-api-keys` + `@projexlight/sdk-identity` |
| `claude.md` mandatory-search rule | `CLAUDE.md` written by `projex init` (FR-AAG-1) |
| `claude.md` modular-architecture rule | `Doctrine §D` (Composition over Coupling) |
| Hand-rolled audit logging | `@projexlight/sdk-audit` (hash chain + verifier) |
| Hand-rolled billing | `@projexlight/sdk-billing` + `@projexlight/sdk-meter` |
| Hand-rolled multi-tenancy | `@projexlight/sdk-tenant` (six-layer JWT + pool routing) |
| App-specific RAG | `@projexlight/sdk-knowledge-rag` |

## Recipe (FR-AAG-3)

For each `ai-appgen` app:

1. **Inventory.** Run `find . -type d -name modular-architecture | xargs ls`
   in the ai-appgen repo. List every module — each becomes a candidate
   blueprint or SDK consumer.

2. **Match to a blueprint.** Compare against `blueprints/` — typical maps:
   - claims-style app → `claims-intake`
   - field-tech app → `field-dispatch`
   - sales tooling → `revops-crm`
   - patient portal → `patient-portal`
   - generic dashboard → `b2b-analytics`
   - PRD/spec workspace → `prd-management`

3. **Generate a ProjexCloud skeleton.**

   ```sh
   npx -y @projexlight/cli init my-app --blueprint <picked-blueprint>
   ```

4. **Port one module at a time.** Use shadow-mode (read from old + write
   to both); flip cutover per module. Never big-bang.

5. **Re-bind the AI layer.** ai-appgen's hand-rolled prompts become
   `sdk-ai-gateway.complete()` calls. PII redaction goes through
   `redactPrompt()`. Tool calling goes through `sdk-agent-runtime`.

6. **Verify guardrails.** Run `projex registry list` to confirm every SDK
   the app composes is in your tenant's `module_subscriptions`. If not,
   `projex_registry_request_pack_upgrade` from your AI tool.

7. **Cut over and decommission.** When traffic on the new app is stable
   for 14 days, archive the ai-appgen app and update DNS / SSO bindings.

## What we ported on purpose vs left behind

Ported into `projex init` defaults:

- **Mandatory file/table search rule** in the generated `CLAUDE.md`.
- **Modular-architecture pattern** in the scaffold tree
  (`src/integrations/<sdk>.ts` per SDK).
- **Auth-service separation** — auth is always an SDK call, never inline.

Not ported (intentional):

- ai-appgen's framework-detection layer (Express vs. NestJS vs. Fastify).
  ProjexCloud apps default to Fastify per `ProjectStructure-v3.1.html`.
- ai-appgen's per-app config files (the registry catalog + blueprint
  manifests subsume this).
- ai-appgen's bespoke MCP tools that overlap with `projex_registry_*` —
  the new MCP supersedes them.

## Support

- **Top 5–10 tenants:** Solutions Engineering, 40 hrs/tenant cap. Email
  `migrations@projexcloud.com`.
- **Everyone else:** this doc + community discussion. The conversion
  recipe is meant to be reproducible without a consultant.

## Why no auto-converter (Q-10)

Building one is months of work for a small user base. The shapes diverge
on the parts that matter (auth, audit, tenancy) where AST translation
would produce broken-but-compiling code that's worse than a manual port.
Manual port + clear recipe + consulting is faster *and* safer.
