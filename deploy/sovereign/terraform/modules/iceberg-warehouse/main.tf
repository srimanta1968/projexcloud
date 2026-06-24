# iceberg-warehouse — region-resident Iceberg lakehouse (G11 full federation).
#
# Reference implementation: an encrypted S3 bucket for table data + a Glue
# catalog database for Iceberg metadata. Per FR-SOV-1 the warehouse data stays
# in-region; main.tf passes cross_region_replication_enabled = false for a
# sovereign region, which leaves replication off (no cross-region destination is
# configured). Operators on other clouds swap S3/Glue for their object store +
# catalog, preserving the `endpoint` output.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.30" }
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

variable "cross_region_replication_enabled" {
  description = "Must be false for sovereign regions (FR-SOV-1)."
  type        = bool
  default     = false
  validation {
    condition     = var.cross_region_replication_enabled == false
    error_message = "FR-SOV-1: cross-region replication must stay disabled for a sovereign region."
  }
}

locals {
  name = "projexcloud-${var.region_id}-warehouse"
}

resource "aws_s3_bucket" "warehouse" {
  bucket = local.name

  tags = {
    "projexcloud:region" = var.region_id
    "projexcloud:role"   = "iceberg-warehouse"
  }
}

# FR-SOV-1: block all public access; data never leaves the region.
resource "aws_s3_bucket_public_access_block" "warehouse" {
  bucket                  = aws_s3_bucket.warehouse.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "warehouse" {
  bucket = aws_s3_bucket.warehouse.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_provider
    }
  }
}

resource "aws_s3_bucket_versioning" "warehouse" {
  bucket = aws_s3_bucket.warehouse.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_glue_catalog_database" "iceberg" {
  name = replace(local.name, "-", "_")
}

output "endpoint" {
  description = "Iceberg warehouse S3 URI + Glue catalog database."
  value       = "s3://${aws_s3_bucket.warehouse.bucket}/?catalog=${aws_glue_catalog_database.iceberg.name}"
}

output "bucket" {
  value = aws_s3_bucket.warehouse.bucket
}
