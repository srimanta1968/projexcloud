#!/usr/bin/env bash
#
# Build all ProjexCloud prod images for linux/amd64 and push them to a registry,
# so prod can `docker compose pull` instead of building on the (small) EC2 box.
#
# Drives the build from the compose files themselves (image names already
# resolve to ${IMAGE_PREFIX}/<svc>:${IMAGE_TAG}), so there is no separate list
# of Dockerfiles/build-args to drift out of sync.
#
# Run from any machine with Docker + (for ECR) AWS creds — e.g. your laptop or a
# self-hosted CI runner. NOT meant to run on the prod box.
#
#   # AWS ECR (recommended for this stack — private, cheap, fast from EC2):
#   IMAGE_PREFIX=<acct>.dkr.ecr.us-east-1.amazonaws.com AWS_REGION=us-east-1 \
#     IMAGE_TAG=$(git rev-parse --short HEAD) ./scripts/setup/build-and-push.sh
#
#   # Any other registry (Docker Hub user, GHCR, etc.) — login yourself first:
#   IMAGE_PREFIX=ghcr.io/srimanta1968 IMAGE_TAG=v1 ./scripts/setup/build-and-push.sh
#
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

: "${IMAGE_PREFIX:?set IMAGE_PREFIX (e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com or ghcr.io/<user>)}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
export IMAGE_PREFIX IMAGE_TAG
# EC2 box is x86_64 — build amd64 regardless of the build host's arch.
export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"

REPOS=(postgres-pgvector api-gateway registry-mcp portal-workspace portal-tenant portal-console)

# --- ECR convenience: log in + ensure repositories exist -------------------
if [[ "$IMAGE_PREFIX" == *.dkr.ecr.*.amazonaws.com ]]; then
  region="${AWS_REGION:-$(printf '%s' "$IMAGE_PREFIX" | sed -E 's/.*dkr\.ecr\.([^.]+)\.amazonaws\.com/\1/')}"
  echo "[build-push] ECR login ($region)"
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$IMAGE_PREFIX"
  for repo in "${REPOS[@]}"; do
    aws ecr describe-repositories --repository-names "$repo" --region "$region" >/dev/null 2>&1 \
      || { echo "[build-push] creating ECR repo $repo"; aws ecr create-repository --repository-name "$repo" --region "$region" >/dev/null; }
  done
fi

ENVFILE_ARG=()
[ -f .env.prod ] && ENVFILE_ARG=(--env-file .env.prod)
PORTAL_ENV_ARG=()
[ -f scripts/setup/.env ] && PORTAL_ENV_ARG=(--env-file scripts/setup/.env)

echo "[build-push] building + pushing ${IMAGE_PREFIX}/*:${IMAGE_TAG}"

# Main stack (postgres-pgvector, api-gateway, registry-mcp).
docker compose "${ENVFILE_ARG[@]}" \
  -f scripts/setup/docker-compose.prod.yml \
  -f scripts/setup/docker-compose.clickhouse.yml \
  --profile selfhosted --profile discovery build
docker compose "${ENVFILE_ARG[@]}" \
  -f scripts/setup/docker-compose.prod.yml \
  -f scripts/setup/docker-compose.clickhouse.yml \
  --profile selfhosted --profile discovery push

# Portals (workspace, tenant, console).
docker compose "${PORTAL_ENV_ARG[@]}" -f scripts/setup/docker-compose.portals.yml build
docker compose "${PORTAL_ENV_ARG[@]}" -f scripts/setup/docker-compose.portals.yml push

echo "[build-push] done. On prod:  IMAGE_PREFIX=$IMAGE_PREFIX IMAGE_TAG=$IMAGE_TAG ./deploy.sh deploy"
