variable "region" {
  type    = string
  default = "us-east-1"
}

variable "github_repository" {
  description = "owner/name of the GitHub repo allowed to assume the deploy role"
  type        = string
  default     = "Zabedz/authledger"
}

variable "api_origin_domain" {
  description = <<-EOT
    Hostname CloudFront forwards /api/* to. Set to the ephemeral ALB DNS name
    while the environment is up; the default is an unresolvable placeholder
    that makes /api return 502 while the environment is down.
  EOT
  type        = string
  default     = "environment-is-down.invalid"
}
