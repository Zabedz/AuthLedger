terraform {
  required_version = ">= 1.4.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    # bucket, region, and dynamodb_table come from -backend-config; see infra/README.md
    key = "authledger/ephemeral.tfstate"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project   = "authledger"
      lifecycle = "ephemeral"
      managed   = "terraform"
    }
  }
}

data "terraform_remote_state" "persistent" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "authledger/persistent.tfstate"
    region = var.region
  }
}

data "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id = data.terraform_remote_state.persistent.outputs.origin_verify_secret_arn
}
