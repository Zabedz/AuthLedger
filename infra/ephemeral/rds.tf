resource "aws_db_subnet_group" "main" {
  name       = "authledger"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier = "authledger"
  engine     = "postgres"
  # Major-only pin: auto minor upgrades stay on and never fight the plan.
  engine_version = "18"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"

  db_name  = "authledger"
  username = "authledger"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = 1

  # The environment is disposable by design; data does not outlive teardown.
  skip_final_snapshot = true
  deletion_protection = false
}

resource "aws_secretsmanager_secret" "database_url" {
  # Force-delete frees the name asynchronously; a prefix avoids the collision
  # when a standup follows a teardown quickly. Consumers use the ARN.
  name_prefix             = "authledger/database-url-"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # RDS forces SSL (rds.force_ssl). sslmode=no-verify encrypts the connection
  # without CA verification, which is proportionate for VPC-internal traffic
  # and covers all three clients (app pool, pg-boss, node-pg-migrate) that read
  # this URL. The upgrade to verify-full (bundle the RDS CA) is the first move
  # of a real deployment, like the plain-HTTP CloudFront-to-ALB leg.
  secret_string = format(
    "postgres://%s:%s@%s/%s?sslmode=no-verify",
    aws_db_instance.main.username,
    random_password.db.result,
    aws_db_instance.main.endpoint,
    aws_db_instance.main.db_name,
  )
}
