#!/usr/bin/env bash
# Mirror the hand-authored Developer Hub + the referenced architecture docs into
# the customer-facing portals, so they serve alongside the generated API docs.
#
#   docs/v3.1/developer-hub/*.html   -> apps/<portal>/public/docs/hub/*.html
#   docs/v3.1/<ref>-v3.1.html        -> apps/<portal>/public/docs/<ref>-v3.1.html
#
# Link rewrite: the canonical API reference folder is `api_docs`, but the portal
# serves it at `docs/api`, so `../api_docs/` -> `../api/` in the mirrored hub.
# Ref-doc links (`../X-v3.1.html`) resolve because the ref docs are copied to
# `public/docs/` (the hub sits in `public/docs/hub/`).
#
# Re-run after editing any developer-hub page or a referenced architecture doc.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/docs/v3.1"
HUB="$SRC/developer-hub"
REF_DOCS=(Architecture-v3.1 AIM-Identity-Model-v3.1 AgenticIntegration-v3.1 \
          SDK-Discoverability-AI-Builder-v3.1 TechStack-v3.1)
PORTALS=(tenant-workspace tenant-admin)

for portal in "${PORTALS[@]}"; do
  base="$ROOT/apps/$portal/public/docs"
  mkdir -p "$base/hub"
  # hub pages, with the api_docs -> api rewrite
  for f in "$HUB"/*.html; do
    sed 's#\.\./api_docs/#../api/#g' "$f" > "$base/hub/$(basename "$f")"
  done
  # referenced architecture docs (served at public/docs/<name> so ../<name> from hub works).
  # Rewrite canonical hub path `developer-hub/` -> portal path `hub/`.
  for d in "${REF_DOCS[@]}"; do
    sed 's#developer-hub/#hub/#g' "$SRC/$d.html" > "$base/$d.html"
  done
  echo "mirrored Developer Hub + ${#REF_DOCS[@]} ref docs -> apps/$portal/public/docs/"
done
