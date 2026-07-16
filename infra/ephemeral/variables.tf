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

variable "otlp_endpoint" {
  description = "OTLP/HTTP collector base endpoint for traces; empty leaves tracing off"
  type        = string
  default     = "https://otlp-gateway-prod-gb-south-1.grafana.net/otlp"
}

variable "reconcile_schedule" {
  description = "EventBridge Scheduler cron for the daily reconciliation run (UTC)"
  type        = string
  default     = "cron(11 6 * * ? *)"
}
