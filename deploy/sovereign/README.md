# Sovereign Region Deployment

P8 Variant B (FR-SOV-1..8). This directory is the starter IaC partners
receive as part of the signed quarterly sovereign bundle.

## Layout

- `terraform/main.tf` — pool family + Helm release; per-cloud blocks in
  `terraform/main.{aws,azure,gcp,ovh,tencent}.tf` (operator-supplied).
- `helm/projexcloud/Chart.yaml` — chart metadata.
- `helm/projexcloud/values.yaml` — strictest-posture defaults.

## Deployment sequence

1. Operator receives the signed bundle (`sovereign.bundle_release` row +
   detached signature). They verify the signature against ProjexCloud's
   published release public key before any apply.
2. Operator fills `terraform.tfvars` with: `region_id`, `regime`,
   `operator_partner`, `bundle_release_id`, `kms_provider`.
3. `terraform init && terraform apply` provisions the pool family + Helm
   release.
4. On first boot, the api-gateway:
   - Runs all SDK migrations (forward-only, sha256-tracked).
   - Inserts `sovereign.region_config` from the env passed by Helm.
   - Starts the leak detector (Cilium subscriber registered via
     `sdk-sovereign.setLeakDetector()`).
   - Starts the attestation-expiry watcher.
5. Operator records the attestation via `POST /admin/sovereign/regions/:id/attestations`
   once external audit is complete.
6. Operator publishes "applied" status via
   `POST /admin/sovereign/bundles/:release_id/applied`.

## What stays terminal

Per FR-SOV-2, **no data leaves the region**. The terraform module sets
`cross_region_replication_enabled = false` on the warehouse; the Helm
values block all internet egress and cross-region routes; the gateway's
Pool Router consults `sovereign.region_config.terminal_federation` (P8
G-P8-7) and refuses cross-region routes with HTTP 451 at runtime.

## What partners adapt

- Per-cloud `terraform/main.{aws,azure,...}.tf` for managed-service
  shapes (RDS vs Cloud SQL vs in-house Postgres, etc.).
- `helm/projexcloud/values.{region}.yaml` for instance sizes + replica
  counts based on regional traffic.
- KMS provider — must be region-resident; ProjexCloud ships only the
  contract, the operator supplies the implementation.
