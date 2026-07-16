# Infrastructure

Terraform-dialect HCL, compatible with Terraform >= 1.4 and OpenTofu. Two
root modules split by lifecycle (ADR-008):

- `persistent/`: survives teardown at near-zero idle cost. ECR, the SPA
  bucket, the CloudFront distribution (the stable public URL), the GitHub
  Actions OIDC deploy role, and the origin-verify secret.
- `ephemeral/`: everything that bills by the hour. VPC, ALB, ECS service,
  RDS, and the database credentials it generates.

## One-time bootstrap

State lives in S3 with a DynamoDB lock table. Create both once per AWS
account, then keep the names in `infra/backend.hcl` (git-ignored):

```sh
aws s3api create-bucket --bucket <state-bucket-name>
aws s3api put-bucket-versioning --bucket <state-bucket-name> \
  --versioning-configuration Status=Enabled
aws dynamodb create-table --table-name terraform-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

```hcl
# infra/backend.hcl
bucket         = "<state-bucket-name>"
region         = "us-east-1"
dynamodb_table = "terraform-lock"
```

Then apply the persistent stack once by hand and record its outputs as
GitHub repository variables (`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`,
`STATE_BUCKET`, plus `ECR_REPOSITORY`, `SPA_BUCKET`, `DISTRIBUTION_ID`,
`APP_URL` for the workflow):

```sh
cd infra/persistent
terraform init -backend-config=../backend.hcl
terraform apply
```

## Account-issued secret values

Three persistent-stack secrets hold credentials Terraform cannot generate: the
Stripe test-mode secret key, the Grafana Cloud OTLP basic-auth header, and the
Sentry DSN. Terraform creates the containers; push the values once after the
persistent apply, and before any ephemeral stand-up (an ECS task referencing a
valueless secret fails to start):

```sh
aws secretsmanager put-secret-value \
  --secret-id authledger/stripe-secret-key --secret-string "sk_test_..."
aws secretsmanager put-secret-value \
  --secret-id authledger/otel-otlp-headers \
  --secret-string "Authorization=Basic <instance-id:token, base64>"
aws secretsmanager put-secret-value \
  --secret-id authledger/sentry-dsn --secret-string "https://...ingest...sentry.io/..."
```

The values live in the root `.env` for local dev; use the same ones.

## Environment lifecycle

The deploy workflow (`.github/workflows/deploy.yml`) owns the ordering; the
manual equivalent is:

Stand up:

```sh
cd infra/ephemeral
terraform init -backend-config=../backend.hcl
terraform apply -var state_bucket=<state-bucket-name> -var image_tag=<tag>
cd ../persistent
terraform apply -var api_origin_domain=$(cd ../ephemeral && terraform output -raw alb_dns_name)
```

Tear down (reverse order, so CloudFront never points at a destroyed ALB):

```sh
cd infra/persistent
terraform apply    # api_origin_domain reverts to its placeholder default
cd ../ephemeral
terraform destroy -var state_bucket=<state-bucket-name> -var image_tag=unused
```

While torn down, the public URL stays live: the SPA serves from S3 and
`/api/*` answers 502. Cost while torn down is ECR images, S3 objects, a
handful of Secrets Manager secrets, and the state bucket: pennies. Cost while
up is roughly $50/month, itemized in docs/RESEARCH.md.

One footgun: a manual `terraform apply` on the persistent stack without
`-var api_origin_domain=...` while the environment is up silently detaches
the /api origin (the variable reverts to its placeholder default). Use the
workflow for lifecycle changes; apply persistent by hand only for bootstrap
and IAM edits.

## Rollback

Application rollback: revert the offending commit on main, dispatch `update`;
migrations follow expand/contract (docs/RESEARCH.md), so the previous code
runs against the newer schema. The ECS deployment circuit breaker also rolls
a failing service update back automatically. Data rollback: the environment
is disposable, so `migrate:down` for a bad migration caught early, teardown
plus stand-up for anything worse. Exercise one rollback when the environment
first goes up (PLAN M1 acceptance).

## Accepted weakness

The app reaches RDS with SSL but without CA verification
(`sslmode=no-verify`), because RDS forces SSL and bundling the regional CA into
the image is deferred. The traffic is encrypted and stays inside the private
VPC (RDS in private subnets, reachable only from the API security group), so
the residual risk is a VPC-internal MITM. The upgrade to `verify-full` with the
RDS CA bundle is a small follow-up.

CloudFront reaches the ALB over plain HTTP because ACM will not issue a
certificate for the ALB's default hostname. Mitigations: the ALB security
group admits only CloudFront's origin-facing prefix list, and the listener
forwards only requests carrying the origin-verify header CloudFront injects;
everything else gets a 403. The first move of a real deployment is a custom
domain plus an ACM certificate on the ALB, which closes this gap.

Two IAM caveats, accepted for a single-owner test account. The deploy role is
PowerUserAccess plus read access to its own IAM resources and write access to
roles under the `/authledger/` path; changing the persistent stack's IAM
resources themselves therefore requires admin credentials, deliberately. And
path-scoped role creation is still an escalation surface (a role created
under that path can carry any policy); the hardening, if this ever guards
anything real, is a permissions boundary condition on role creation.
