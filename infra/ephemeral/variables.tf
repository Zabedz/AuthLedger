variable "region" {
  type    = string
  default = "us-east-1"
}

variable "state_bucket" {
  description = "S3 bucket holding Terraform state; used to read the persistent stack outputs"
  type        = string
}

variable "image_tag" {
  description = "Tag of the authledger-api image in ECR to run"
  type        = string
}
