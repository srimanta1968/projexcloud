# Provider configuration for the sovereign region apply.
#
# Additive to main.tf (which declares required_providers, including random).
# Operators point these at their in-region cloud + cluster.

variable "aws_region" {
  description = "In-region AWS region (or GovCloud / partner-cloud equivalent)."
  type        = string
  default     = "us-gov-east-1"
}

provider "aws" {
  region = var.aws_region
}

# Cluster providers — operator supplies kubeconfig context for the in-region
# Kubernetes cluster the Helm release targets.
provider "kubernetes" {}

provider "helm" {}
