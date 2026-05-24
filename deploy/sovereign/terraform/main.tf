# ProjexCloud Sovereign Region — Terraform starter
#
# P8 Variant B (FR-SOV-4). Defines the minimum infra footprint for an
# isolated sovereign region. Partners receive this file as part of the
# signed quarterly bundle; provider-specific blocks live in companion
# files (main.aws.tf, main.azure.tf, main.gcp.tf) selected by the
# `provider` variable.
#
# This is a STARTER template. Each sovereign region operator (US-cleared
# MSP for FedRAMP, Chinese cloud for PIPL, EU partner for sovereign,
# UAE partner for TRD) adapts the resource blocks to their cloud's
# managed-service catalog. The contract with the operator pins these
# resource shapes; we do NOT support per-operator forks of the SDK.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.30" }
    helm = { source = "hashicorp/helm", version = "~> 2.12" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.25" }
  }
}

# -----------------------------------------------------------------------------
# Variables — set per region in terraform.tfvars
# -----------------------------------------------------------------------------

variable "region_id" {
  description = "Stable region identifier. Must match sovereign.region_config.region_id (PRD §5.B)."
  type        = string
  # e.g. "us-gov-east-1", "cn-bj-1", "eu-sovereign-1", "uae-trd-1"
}

variable "regime" {
  description = "Compliance regime."
  type        = string
  validation {
    condition     = contains(["fedramp-high", "il5", "pipl", "eu-sovereign", "uae-trd"], var.regime)
    error_message = "regime must be one of fedramp-high|il5|pipl|eu-sovereign|uae-trd."
  }
}

variable "operator_partner" {
  description = "In-region MSP / cloud partner name."
  type        = string
}

variable "bundle_release_id" {
  description = "sovereign.bundle_release.release_id this apply is shipping."
  type        = string
}

variable "kms_provider" {
  description = "KMS provider for the region (must be region-resident)."
  type        = string
}

variable "terminal_federation" {
  description = "When true, Pool Router federation manifest treats this region as terminal (FR-SOV-2)."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Pool family — Admin / App / Evidence / Vector / Warehouse / KMS
# Each is an isolated cluster within the sovereign boundary.
# -----------------------------------------------------------------------------

module "admin_pool" {
  source              = "./modules/postgres-pool"
  pool_kind           = "admin"
  region_id           = var.region_id
  instance_count      = 3   # primary + 2 replicas (one for sync)
  synchronous_replica = true
  storage_encrypted   = true
  kms_provider        = var.kms_provider
}

module "app_pool" {
  source              = "./modules/postgres-pool"
  pool_kind           = "app"
  region_id           = var.region_id
  instance_count      = 3
  synchronous_replica = true
  storage_encrypted   = true
  kms_provider        = var.kms_provider
}

module "evidence_pool" {
  source              = "./modules/postgres-pool"
  pool_kind           = "evidence"
  region_id           = var.region_id
  instance_count      = 3
  storage_encrypted   = true
  kms_provider        = var.kms_provider
  # Evidence rows are append-only + immutable; sync replica enforces audit.
  synchronous_replica = true
}

module "vector_store" {
  source       = "./modules/vector-store"
  region_id    = var.region_id
  kms_provider = var.kms_provider
}

module "warehouse" {
  source       = "./modules/iceberg-warehouse"
  region_id    = var.region_id
  kms_provider = var.kms_provider
  # Per FR-SOV-1 — warehouse data stays in-region. Cross-region replication off.
  cross_region_replication_enabled = false
}

# -----------------------------------------------------------------------------
# Outputs — consumed by the helm release below and by the operator runbook
# -----------------------------------------------------------------------------

output "region_id"        { value = var.region_id }
output "regime"           { value = var.regime }
output "operator_partner" { value = var.operator_partner }
output "admin_pool_dsn"   { value = module.admin_pool.dsn   sensitive = true }
output "app_pool_dsn"     { value = module.app_pool.dsn     sensitive = true }
output "evidence_pool_dsn" { value = module.evidence_pool.dsn sensitive = true }
output "vector_endpoint"  { value = module.vector_store.endpoint }
output "warehouse_endpoint" { value = module.warehouse.endpoint }

# -----------------------------------------------------------------------------
# Helm release of the ProjexCloud platform image
# -----------------------------------------------------------------------------

resource "helm_release" "projexcloud" {
  name       = "projexcloud"
  repository = "oci://${var.region_id}.projexcloud.local"
  chart      = "projexcloud"
  version    = var.bundle_release_id
  namespace  = "projexcloud"

  values = [
    file("${path.module}/../helm/projexcloud/values.yaml"),
  ]

  set { name = "region_id"          value = var.region_id }
  set { name = "regime"             value = var.regime }
  set { name = "operator_partner"   value = var.operator_partner }
  set { name = "terminalFederation" value = var.terminal_federation }
  set { name = "adminPoolDsn"       value = module.admin_pool.dsn }
  set { name = "appPoolDsn"         value = module.app_pool.dsn }
  set { name = "evidencePoolDsn"    value = module.evidence_pool.dsn }
  set { name = "kmsProvider"        value = var.kms_provider }

  # Sovereign isolation: refuse any phone-home / cross-region NetworkPolicy.
  set { name = "networkPolicies.allowEgressInternet" value = "false" }
  set { name = "networkPolicies.allowCrossRegion"    value = "false" }
}
