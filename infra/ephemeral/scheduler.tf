# The daily reconciliation run: EventBridge Scheduler starts a one-off
# ECS task from the same image with a command override, the same pattern the
# deploy workflow uses for migrations. No queue, no live API instance involved;
# the whole thing scales to zero with the rest of this stack.

resource "aws_ecs_task_definition" "reconcile" {
  family                   = "authledger-reconcile"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    merge(local.api_container, {
      name         = "reconcile"
      command      = ["node", "api/dist/jobs/reconcile.js"]
      portMappings = []
    })
  ])
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "authledger-reconcile-scheduler"
  path               = "/authledger/"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_run_task" {
  statement {
    actions = ["ecs:RunTask"]
    # Any revision of the family: the policy must not go stale when an apply
    # registers a new revision between scheduler evaluations.
    resources = ["${replace(aws_ecs_task_definition.reconcile.arn, "/:\\d+$/", "")}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  name   = "run-reconcile-task"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_run_task.json
}

resource "aws_scheduler_schedule" "reconcile" {
  name = "authledger-reconcile-daily"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.reconcile_schedule

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.reconcile.arn
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = aws_subnet.public[*].id
        security_groups  = [aws_security_group.api.id]
        assign_public_ip = true
      }
    }

    # Retries cover the invoke layer only: an ecs:RunTask call the scheduler
    # could not place (throttle, capacity) leaves no task, no history row, and
    # no Sentry event, so it is the one failure worth retrying. A task that
    # started and failed reports through the history and Sentry and is not
    # retried into the same failure.
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
