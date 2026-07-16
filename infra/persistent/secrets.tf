resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

# The AES key that encrypts TOTP secrets. It must be stable across stand-ups,
# or every enrolled secret becomes undecryptable, so it lives in the
# persistent stack. random_bytes gives 32 bytes; base64 is what the app reads.
resource "random_bytes" "encryption_key" {
  length = 32
}

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "authledger/encryption-key"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = random_bytes.encryption_key.base64
}

# Account-issued credentials the ephemeral tasks read: the Stripe test-mode
# secret key, the Grafana Cloud OTLP basic-auth header, and the Sentry DSN.
# Terraform owns the containers only; the values come from the provider
# dashboards and are pushed once with `aws secretsmanager put-secret-value`.
# A container with no value fails task startup, so pushing the values precedes
# the first ephemeral apply (the standup runbook covers it).
resource "aws_secretsmanager_secret" "stripe_secret_key" {
  name                    = "authledger/stripe-secret-key"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "otel_otlp_headers" {
  name                    = "authledger/otel-otlp-headers"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "sentry_dsn" {
  name                    = "authledger/sentry-dsn"
  recovery_window_in_days = 0
}

# Read by the ephemeral stack so the ALB can require the header CloudFront
# injects. Rotating it is: taint the random_password, apply both stacks.
resource "aws_secretsmanager_secret" "origin_verify" {
  name                    = "authledger/origin-verify"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id     = aws_secretsmanager_secret.origin_verify.id
  secret_string = random_password.origin_verify.result
}
