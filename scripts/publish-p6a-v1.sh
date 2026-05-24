#!/usr/bin/env bash
# TK-3307 / G-5 / AC-15 — publish all P6A SDKs at v1.0.0 to Verdaccio.
#
# Steps:
#   1. Bump version: 0.1.0 → 1.0.0 in each P6A package.json (idempotent).
#   2. Build via turbo.
#   3. Publish each package to the configured registry (default: Verdaccio
#      at REGISTRY_URL=http://localhost:4873).
#   4. Smoke-test: `npm view @projexlight/<pkg>@1.0.0 version` returns 1.0.0.
#   5. Tag the monorepo `p6a-v1.0.0` and push (requires GIT_REMOTE).
#
# Requires: pnpm, npm, jq, git on PATH; npm auth configured for REGISTRY_URL.
set -euo pipefail

REGISTRY_URL="${REGISTRY_URL:-http://localhost:4873}"
NEW_VERSION="1.0.0"
PACKAGES=(
  "packages/sdk-ai-gateway"
  "packages/sdk-taxonomy"
  "packages/sdk-agent-runtime"
  "packages/sdk-trace"
  "packages/sdk-mcp-bridge"
  "packages/connector-github"
)

echo "[publish-p6a] target registry: $REGISTRY_URL"
echo "[publish-p6a] target version:  $NEW_VERSION"

for pkg in "${PACKAGES[@]}"; do
  pkgJson="$pkg/package.json"
  if [ ! -f "$pkgJson" ]; then
    echo "[publish-p6a] WARN: $pkgJson missing — skipping" >&2
    continue
  fi
  currentVersion=$(jq -r '.version' "$pkgJson")
  if [ "$currentVersion" != "$NEW_VERSION" ]; then
    echo "[publish-p6a] bump $pkg: $currentVersion → $NEW_VERSION"
    tmp=$(mktemp)
    jq --arg v "$NEW_VERSION" '.version = $v | .private = false' "$pkgJson" > "$tmp"
    mv "$tmp" "$pkgJson"
  fi
done

echo "[publish-p6a] build via turbo"
pnpm -w turbo run build --filter='./packages/sdk-ai-gateway' \
                       --filter='./packages/sdk-taxonomy' \
                       --filter='./packages/sdk-agent-runtime' \
                       --filter='./packages/sdk-trace' \
                       --filter='./packages/sdk-mcp-bridge' \
                       --filter='./packages/connector-github'

for pkg in "${PACKAGES[@]}"; do
  echo "[publish-p6a] publishing $pkg"
  (cd "$pkg" && npm publish --registry "$REGISTRY_URL" --access public)
done

echo "[publish-p6a] smoke-testing"
for pkg in "${PACKAGES[@]}"; do
  name=$(jq -r '.name' "$pkg/package.json")
  published=$(npm view "$name@$NEW_VERSION" version --registry "$REGISTRY_URL" || echo "MISSING")
  if [ "$published" != "$NEW_VERSION" ]; then
    echo "[publish-p6a] FAIL: $name not at $NEW_VERSION (got '$published')" >&2
    exit 1
  fi
  echo "[publish-p6a] ✓ $name@$NEW_VERSION"
done

TAG="p6a-v$NEW_VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "[publish-p6a] tag $TAG already exists"
else
  git tag -a "$TAG" -m "P6A release v$NEW_VERSION — AC-15 close"
  if [ -n "${GIT_REMOTE:-}" ]; then
    git push "$GIT_REMOTE" "$TAG"
  else
    echo "[publish-p6a] GIT_REMOTE not set — tag created locally; push manually"
  fi
fi

cat <<EOF
[publish-p6a] DONE
  - 6 packages at v$NEW_VERSION on $REGISTRY_URL
  - monorepo tag $TAG
  - AC-15 satisfied
EOF
