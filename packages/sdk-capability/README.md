# @projexlight/sdk-capability

> P9 / E1 — Layer 1 of the SDK Discoverability & AI Builder stack.

Defines and validates the `sdk-capability.json` manifest every SDK in the
ProjexCloud monorepo ships. Companion docs: `docs/v3.1/prd/P9-SDK-Discoverability-AI-Builder.md` §5.1.

## Why this exists

Every SDK in `packages/*` exposes routes, emits events, and writes to specific
database schemas. Today that information is only discoverable by reading source.
P9 turns it into a **machine-readable manifest** so AI coding tools (Claude Code,
Cursor, Windsurf) and the cloud builder agent can compose vertical apps from the
SDK catalog without reading 70 READMEs.

Doctrine §C — every new SDK ships its `sdk-capability.json` at v1.0. CI rejects
publish without it. See `docs/v3.1/Architecture-v3.1.html`.

## Package surface

```ts
import {
  SdkCapabilityManifest,
  validateManifest,
  diffManifests,
} from '@projexlight/sdk-capability';

const r = validateManifest(parsedJson);
if (!r.ok) throw new Error(r.errors.join('\n'));

const diff = diffManifests(prev, next);
if (diff.is_breaking) {
  // warn downstream consumers
}
```

## CLI

```sh
# Scaffold a starter manifest from a package's source (run from monorepo root):
npx @projexlight/sdk-capability scaffold --dir packages/sdk-vault

# Validate after authoring:
npx @projexlight/sdk-capability validate --dir packages/sdk-vault
```

The scaffold output is intentionally `TBD:`-rich for prose fields (summary,
scenarios, compliance notes). The lint layer refuses to validate until those
placeholders are filled — that's the forcing function for quality.

## Manifest shape (schema_version "1.0")

| Field | Type | Notes |
|---|---|---|
| `name`, `version`, `schema_version` | string | Required. Schema version pinned at `"1.0"`. |
| `summary` | string | 50–5000 chars. Used for embedding-based search. |
| `tags` | string[] | Free-form discovery tags. |
| `provides` | object | `{ endpoints, events, models, hooks, ui_components }`. |
| `consumes` | object | `{ events, infra, config_keys }`. |
| `scenarios` | array | ≥3 entries, each with `id`, `title`, `when_to_use`, `example_code` (≥20 chars), `expected_outcome`. |
| `compliance_posture` | object | `regimes` (≥1, e.g. `"SOC2"`, `"HIPAA"`) + optional `notes`. |
| `pool_placement` | enum | `admin` / `app` / `evidence` / `global-catalog` / `warehouse` / `vector` / `olap`. |
| `pricing_skus` | array | `{ sku, mode, unit_description }`. Empty for free/internal SDKs. |
| `links` | object | `readme`, `source`, `prd_section`. |
| `no_endpoints` | boolean | Optional opt-out for build-time-only packages. |

## Lint rules (run after schema validation passes)

- `summary` length 50–5000 chars, no `TBD`/`TODO`/`FIXME`/`PLACEHOLDER` tokens
- ≥3 scenarios
- Each scenario's `example_code` ≥20 chars, no placeholder tokens
- `compliance_posture.regimes` non-empty
- `provides.endpoints` non-empty unless `no_endpoints: true`

CI surfaces lint failures with the same severity as schema failures
(PR-blocking) — per Q-5 decision in the P9 PRD.

## Version-bump policy

| Bump | When | Action |
|---|---|---|
| `1.x` patch | Adding optional fields, tightening lint rules | Backward-compatible; no consumer action needed |
| `1.x` minor | Adding new top-level optional sections | Backward-compatible; consumers may opt in |
| `2.0` major | Removing fields, changing required-field semantics | Ship a migration utility alongside; downstream PRD bump |

Schema validation rejects unsupported `schema_version` values with a clear
error, so consumers fail fast on version skew.

## Status

P9 / E1 deliverable. Tests: `pnpm test`. Build: `pnpm build`.
