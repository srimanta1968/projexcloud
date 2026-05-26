# Blueprint Upgrade Policy (FR-BP-4 / Q-3)

Per **Q-3 (locked 2026-05-25)**, blueprints follow a semver-tier auto-policy
so tenants get security fixes without surprise feature churn.

## Tiers

| Bump | Behavior | Window |
|------|----------|--------|
| **patch** (1.0.0 → 1.0.1) | Auto-applied on the tenant's next maintenance window. Tenant admin gets a notification, not an approval. | Within 7 days |
| **minor** (1.0.0 → 1.1.0) | Admin approval required. We send a 30-day reminder, then escalate. | 30 days to opt in |
| **major** (1.0.0 → 2.0.0) | Admin approval + migration plan attached. The previous major retains a 90-day deprecation window. | 90 days minimum |

## Manifest field

Each blueprint declares its compatibility expectations in `blueprint.yaml`:

```yaml
id: revops-crm
schema_version: "1.0"
version: 1.2.3
upgrade_policy:
  patch: auto              # auto | notify | block
  minor: approval          # auto | approval | block
  major: approval+plan     # approval | approval+plan | block
deprecation:
  previous_major_window_days: 90
```

`upgrade_policy.*` defaults are the table above when unset — blueprints rarely
need to override these.

## How tenants opt in

`projexcloud-admin` exposes per-blueprint **Update windows** at
`/blueprints/<id>/update-windows`. Tenant admins can:

- **Pause auto-patch** for a blueprint (per-tenant). Patches still queue
  but don't apply until unpaused; tenant accepts the security risk.
- **Pin a major version.** Forces them onto the major-upgrade path when
  the current major reaches end-of-life.
- **Subscribe to release notes** for any blueprint they've installed.

## What "auto-apply" actually does

1. Tenant pool runner pulls the new blueprint version into a sandbox
2. Runs the blueprint's own `tests/smoke.mjs` against the sandbox install
3. On pass: blue/green cuts the live install to the new version, audits
   `blueprint.upgraded.v1`, retains the old install for 24 h rollback
4. On fail: notification fires, install stays on the old version, the
   failure feeds back to the blueprint owner as a regression report

## Pinning specific SDKs inside a blueprint

`blueprint.yaml`'s `sdks:` block uses semver ranges (`^1.0`, `~2.1.0`). When
an SDK ships a major bump, the blueprint owner explicitly updates the
range in a new blueprint version — never automatically pulled across major
boundaries.

## See also

- §13 Q-3 in `docs/v3.1/prd/P9-SDK-Discoverability-AI-Builder.md`
- `services/lineage-projector` — produces the per-tenant blueprint manifest
  visible in `projexcloud-admin`
