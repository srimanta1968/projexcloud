# @projexlight/sdk-crm

## 0.2.0

### Minor Changes

- 343ffca: P16 — publish the vertical-facing SDKs to the private registry.

  Every package a vertical depends on is now genuinely installable rather than
  workspace-only: `private: false`, a `publishConfig`, real `main`/`types`, and a `files`
  list that ships `dist` plus `src/db/migrations` (the migration runner reads those `.sql`
  files at boot, so a package that omitted them would install fine and then leave the
  gateway running against an unmigrated schema).

  `publishConfig.registry` is deliberately ABSENT. npm resolves the publish target as
  publishConfig.registry > .npmrc scope registry > default, so the hardcoded
  `http://localhost:4873/` that every package previously carried would have won over
  anything CI set — a production release would have published to a developer's laptop
  registry and reported success. The scope registry now lives only in `.npmrc`, which is the
  single place dev and production can differ.

  **minor, not patch**: these packages change from unpublishable to publishable, which is
  new consumable surface rather than a fix. No existing API changed, so it is not major.

### Patch Changes

- Updated dependencies [343ffca]
  - @projexlight/sdk-audit@0.2.0
  - @projexlight/sdk-data-rights@0.1.1
  - @projexlight/sdk-engagement@0.1.1
