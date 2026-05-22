# Changesets

This folder holds changesets — markdown files describing a version bump and a
human-readable summary.

## Adding a changeset

```bash
pnpm changeset
```

Pick the affected packages, the bump type (patch/minor/major), and write a one-line summary.

## Publishing

On merge to `main`, the GitHub Action runs `changeset version` (updates `package.json`
versions and CHANGELOG.md per package) and then `changeset publish` (pushes to the private
registry at https://npm.projexcloud.com — or http://localhost:4873 in dev).

See `docs/v3.1/ProjectStructure-v3.1.html` §13 for the full registry strategy.
