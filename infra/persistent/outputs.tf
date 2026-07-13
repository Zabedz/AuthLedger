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
