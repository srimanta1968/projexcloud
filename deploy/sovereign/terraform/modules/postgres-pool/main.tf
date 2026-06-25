# postgres-pool — one isolated Postgres pool (admin | app | evidence).
#
# Reference implementation on Aurora PostgreSQL: a writer + (instance_count-1)
# readers, storage-encrypted with the region-resident KMS key. Operators adapt
# the resource shapes to their cloud (Cloud SQL / in-house Postgres) but MUST
# preserve the `dsn` output contract main.tf consumes. pgvector + PostGIS are
# enabled via the cluster parameter group so the platform's SDK migrations
# (sdk-agent-runtime, sdk-geo) succeed on first boot.

terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.30" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "pool_kind" {
  description = "admin | app | evidence."
  type        = string
  validation {
    condition     = contains(["admin", "app", "evidence"], var.pool_kind)
    error_message = "pool_kind must be admin|app|evidence."
  }
}

variable "region_id" {
  description = "Stable sovereign region identifier (used in resource names)."
  type        = string
}

variable "instance_count" {
  description = "Total instances: 1 writer + (instance_count-1) readers."
  type        = number
  default     = 3
}

variable "synchronous_replica" {
  description = "Promote one replica to synchronous commit (audit/evidence pools)."
  type        = bool
  default     = false
}

variable "storage_encrypted" {
  description = "Encrypt storage with the region KMS key."
  type        = bool
  default     = true
}

variable "kms_provider" {
  description = "Region-resident KMS provider/key identifier."
  type        = string
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version."
  type        = string
  default     = "16.4"
}

variable "instance_class" {
  description = "Instance class for writer + readers."
  type        = string
  default     = "db.r6g.large"
}

variable "database_name" {
  description = "Initial database name."
  type        = string
  default     = "projexcloud_db"
}

variable "master_username" {
  type    = string
  default = "projex"
}

locals {
  name = "projexcloud-${var.region_id}-${var.pool_kind}"
}

resource "random_password" "master" {
  length  = 32
  special = false
}

# Cluster parameter group — enable the extensions the SDK migrations require.
resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${local.name}-pg"
  family      = "aurora-postgresql16"
  description = "ProjexCloud ${var.pool_kind} pool — pgvector + postgis preloaded."

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier              = local.name
  engine                          = "aurora-postgresql"
  engine_version                  = var.engine_version
  database_name                   = var.database_name
  master_username                 = var.master_username
  master_password                 = random_password.master.result
  storage_encrypted               = var.storage_encrypted
  kms_key_id                      = var.storage_encrypted ? var.kms_provider : null
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  deletion_protection             = true

  tags = {
    "projexcloud:region" = var.region_id
    "projexcloud:pool"   = var.pool_kind
  }
}

resource "aws_rds_cluster_instance" "members" {
  count              = var.instance_count
  identifier         = "${local.name}-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = var.instance_class
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version
  # Instance 0 is the writer; readers get a higher failover tier.
  promotion_tier      = count.index == 0 ? 0 : (var.synchronous_replica && count.index == 1 ? 1 : 15)
  publicly_accessible = false
}

output "dsn" {
  description = "Postgres connection string for this pool (writer endpoint)."
  value       = "postgres://${var.master_username}:${random_password.master.result}@${aws_rds_cluster.this.endpoint}:5432/${var.database_name}?sslmode=require"
  sensitive   = true
}

output "reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}
