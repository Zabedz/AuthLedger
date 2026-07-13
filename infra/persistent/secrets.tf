resource "random_password" "origin_verify" {
  length  = 40
  special = false
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
