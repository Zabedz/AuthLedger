output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "spa_bucket" {
  value = aws_s3_bucket.spa.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.app.id
}

output "app_url" {
  value = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "origin_verify_secret_arn" {
  value = aws_secretsmanager_secret.origin_verify.arn
}

output "encryption_key_secret_arn" {
  value = aws_secretsmanager_secret.encryption_key.arn
}

output "stripe_secret_key_secret_arn" {
  value = aws_secretsmanager_secret.stripe_secret_key.arn
}

output "otel_otlp_headers_secret_arn" {
  value = aws_secretsmanager_secret.otel_otlp_headers.arn
}

output "sentry_dsn_secret_arn" {
  value = aws_secretsmanager_secret.sentry_dsn.arn
}
