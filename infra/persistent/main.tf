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
    key = "authledger/persistent.tfstate"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project   = "authledger"
      lifecycle = "persistent"
      managed   = "terraform"
    }
  }
}
