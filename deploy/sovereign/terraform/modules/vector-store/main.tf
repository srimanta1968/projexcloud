# vector-store — region-resident pgvector store for agent/embedding namespaces.
#
# The platform embeds in-process (bge-small) and persists vectors in Postgres
# via pgvector (sdk-agent-runtime). This module provisions a dedicated, KMS-
# encrypted Postgres instance for the vector namespaces, kept separate from the
# transactional pools so vector load doesn't contend with OLTP. Operators may
# swap in a managed k-NN store, preserving the `endpoint` output contract.

terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.30" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "region_id" {
  description = "Stable sovereign region identifier."
  type        = string
}

variable "kms_provider" {
  description = "Region-resident KMS provider/key identifier."
  type        = string
}

variable "instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "allocated_storage" {
  type    = number
  default = 200
}

variable "engine_version" {
  type    = string
  default = "16.4"
}

locals {
  name = "projexcloud-${var.region_id}-vector"
}

resource "random_password" "master" {
  length  = 32
  special = false
}

# Preload pgvector so CREATE EXTENSION vector succeeds for the SDK migrations.
resource "aws_db_parameter_group" "this" {
  name   = "${local.name}-pg"
  family = "postgres16"

  parameter {
    name  = "shared_preload_libraries"
    value = "vector"
  }
}

resource "aws_db_instance" "this" {
  identifier                = local.name
  engine                    = "postgres"
  engine_version            = var.engine_version
  instance_class            = var.instance_class
  allocated_storage         = var.allocated_storage
  max_allocated_storage     = var.allocated_storage * 4
  db_name                   = "projexcloud_vectors"
  username                  = "projex"
  password                  = random_password.master.result
  storage_encrypted         = true
  kms_key_id                = var.kms_provider
  parameter_group_name      = aws_db_parameter_group.this.name
  publicly_accessible       = false
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  tags = {
    "projexcloud:region" = var.region_id
    "projexcloud:role"   = "vector-store"
  }
}

output "endpoint" {
  description = "pgvector store endpoint host:port."
  value       = aws_db_instance.this.endpoint
}

output "dsn" {
  value     = "postgres://projex:${random_password.master.result}@${aws_db_instance.this.endpoint}/projexcloud_vectors?sslmode=require"
  sensitive = true
}
