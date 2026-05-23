# Publishing SDKs to Verdaccio (AC-19)

This runbook covers publishing every `@projexlight/*` package that ships
`publishConfig.registry = http://localhost:4873/` to a local or staging
Verdaccio registry.

## One-time setup

1. **Start Verdaccio**:
   ```bash
   pnpm verdaccio:up
   ```
   This pulls and runs the official `verdaccio/verdaccio` Docker image
   bound to port 4873. The container is named `verdaccio`; stop it with
   `pnpm verdaccio:down`.

2. **(CI / staging only)** Add an auth token. Local dev uses Verdaccio's
   permissive default config and needs nothing here.
   ```bash
   npm adduser --registry=http://verdaccio.internal:4873/
   ```
   The token lands in `~/.npmrc`. For CI, set `NPM_TOKEN` and write
   `//verdaccio.internal:4873/:_authToken=$NPM_TOKEN` to `.npmrc` at
   pipeline-init time.

## Publishing

1. **Build everything**:
   ```bash
   pnpm build
   ```

2. **Dry-run first** to catch any package that fails `npm pack`:
   ```bash
   pnpm publish:verdaccio:dry
   ```
   Look for `tarball details` blocks; anything missing `dist/` is a build
   gap.

3. **Publish for real**:
   ```bash
   pnpm publish:verdaccio
   ```
   The script walks `packages/*` and `native/*`, filters to packages
   whose `publishConfig.registry` includes `4873`, and `npm publish`es
   each one. Failures are surfaced as a non-zero exit.

4. **Verify**:
   ```bash
   npm view @projexlight/sdk-billing --registry=http://localhost:4873/
   ```

## Re-publishing a single package

To re-publish just one SDK without walking the full set:
```bash
cd packages/sdk-billing
npm publish --registry=http://localhost:4873/ --access=restricted
```
Bump the version in `package.json` first if you've already published the
same version (Verdaccio refuses overwrites by default — same policy as
npmjs.org).

## Override the registry URL

```bash
VERDACCIO_URL=http://verdaccio.staging.internal:4873/ pnpm publish:verdaccio
```

## What gets published

The publish script reads each package's `publishConfig.registry` and
publishes only when that value contains `4873`. As of the latest run:

- All `@projexlight/sdk-*` packages with `publishConfig` set (every
  Wave 1–4 SDK + every P5 SDK that has been built v1.0.0)
- HDK TS-facade packages (`hdk-scanner`, `hdk-image-editor`,
  `hdk-video-editor`, `hdk-camera`, `hdk-map`)

Packages without `publishConfig` (e.g. `services/api-gateway`,
`apps/projexcloud-admin`, `apps/tenant-admin`) are intentionally skipped
— they're consumed by deployment, not by other workspaces.
