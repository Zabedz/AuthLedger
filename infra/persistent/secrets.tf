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
