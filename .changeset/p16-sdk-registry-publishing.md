---
"@projexlight/sdk-source-record": minor
"@projexlight/sdk-import": minor
"@projexlight/sdk-sla": minor
"@projexlight/sdk-coverage": minor
"@projexlight/sdk-data-credits": minor
"@projexlight/sdk-crm": minor
"@projexlight/sdk-assignment": minor
"@projexlight/sdk-identity-resolver": minor
"@projexlight/sdk-lead-scoring": minor
"@projexlight/sdk-ingest": minor
"@projexlight/sdk-audit": minor
"@projexlight/sdk-conversation": minor
"@projexlight/sdk-parsing": minor
"@projexlight/sdk-evidence": minor
---

P16 — publish the vertical-facing SDKs to the private registry.

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
