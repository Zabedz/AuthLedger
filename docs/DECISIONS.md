# Decisions

Architecture decision records, newest last. Context and consequences are kept
short; the research behind stack-level picks is in RESEARCH.md.

## ADR-001: npm workspaces monorepo (2026-07-13)

Context: one developer, one deploy pipeline, three packages (api, web,
shared).
Decision: a single repository using npm workspaces, no extra workspace
tooling. `shared` builds to `dist/` and is consumed as a normal package.
Consequences: `shared` must be built before api typecheck or dev; the
Makefile and CI do this explicitly. No publish step exists or is needed.

## ADR-002: Fastify with TypeBox schemas at every boundary (2026-07-13)

Context: request and reply validation is a security requirement, and the
project needs an OpenAPI spec as a deliverable.
Decision: Fastify v5 with @sinclair/typebox schemas on every route, shared
with the SPA through the shared package. @fastify/swagger derives the OpenAPI
document from those schemas; the spec is a byproduct of validation, not a
separate artifact. Swagger UI and the JSON spec are exposed in development
only.
Consequences: one schema definition drives runtime validation, static types,
and documentation. Route code carries schema blocks, which is deliberate
visibility.

## ADR-003: SQL-first migrations with generated query types (2026-07-13)

Context: the ledger will need grants, triggers, and deferrable constraints
that ORM schema languages cannot express.
Decision: numbered .sql migrations run by node-pg-migrate (a regular
dependency, because production deploys run migrations from the same image),
queried through Kysely with types generated from the live schema by
kysely-codegen and committed. A CI job re-runs migrations plus codegen and
fails on drift.
Consequences: hand-written DDL is the single source of truth. The generated
types file is excluded from lint and prettier and never edited by hand; it
keeps kysely-codegen's own generated-file header, which records build-tool
provenance the same way a lockfile does.

## ADR-004: Logging conventions (2026-07-13)

Context: a payments service that leaks credentials into logs fails review;
log lines must be correlatable with requests.
Decision: pino through Fastify's built-in logger. Base bindings carry
`service` and `env`; every request gets a request id (inbound `x-request-id`
accepted when it is short and word-safe, UUID otherwise) logged as `req_id`,
echoed in the response header, and held in AsyncLocalStorage; a pino mixin
injects it into lines emitted outside req.log. Authorization headers, cookies,
and set-cookie are redacted at the logger level. Pretty printing is
development-only.
Consequences: redaction lives in one place and applies to every line. The
request-id contract is stable for the load balancer and e2e assertions.

## ADR-005: Hybrid local dev: containers for dependencies, host for the app (2026-07-13)

Context: parity matters for Postgres, SMTP, and webhook signatures; iteration
speed matters for the app process.
Decision: compose runs Postgres 18.4, Mailpit, and (behind a profile) the
Stripe CLI forwarder; the api and web processes run on the host with native
watch. `.env` is the single config source: the Makefile sources it, compose
interpolates it, and `.env.example` documents every variable.
Consequences: image-level issues would surface only at deploy time, so CI
builds the production image on every PR, boots it, probes liveness, and runs
an argon2 hash to prove native modules work in the image. The pinned major is
available on the deploy target: RDS for PostgreSQL lists major 18 with minor
18.4 as latest, checked against the AWS version list on 2026-07-13.

## ADR-006: CI gates (2026-07-13)

Context: the workflow files are part of the portfolio; gates must block real
mistakes without turning every PR red for pre-existing issues.
Decision: required checks are lint, typecheck, test, types-in-sync, build
(with image boot and argon2 smoke), gitleaks, and osv-scanner in PR-diff
mode. Dependabot handles version updates; a weekly scheduled osv-scanner run
covers pre-existing advisories. npm audit is deliberately not a gate.
Third-party actions are pinned to commit SHAs, workflow permissions default
to contents: read, and SARIF upload stays off until the repo is public.
Consequences: a PR cannot merge with a failed gate; provider-dependent e2e
arrives with deploy.yml at M1.

## ADR-007: API routes live under /api (2026-07-13)

Context: the deployed topology serves the SPA and the API from one CloudFront
origin, with `/api/*` routed to the API; local dev mirrors this with a Vite
proxy.
Decision: the API registers all routes under the `/api` prefix, including
health endpoints (`/api/healthz`, `/api/readyz`), so no path rewriting exists
anywhere.
Consequences: one origin everywhere. The ALB target group probes
`/api/healthz`: ECS stops and replaces a task that fails its target-group
check, so a database-touching probe would turn an RDS blip into a task
replacement loop. `/api/readyz` is asserted by the deploy workflow after the
migration step and stays available for e2e and humans.

## ADR-008: Infrastructure as Terraform-dialect HCL, split by lifecycle (2026-07-13)

Context: M1 needs provisioning that stands the AWS environment up and tears
it down repeatedly, with drift detection, and reads well to reviewers.
Decision: Terraform-dialect HCL, kept compatible with both the Terraform CLI
(>= 1.4) and OpenTofu. CDK was rejected because CloudFormation's slow
create/delete cycle punishes exactly this project's stand-up/teardown
lifecycle, and because infrastructure-as-TypeScript invites sharing code with
the app across a boundary that should stay dumb. Plain scripts were rejected
for having no state, no drift detection, and no reliable teardown.
Two root modules split by lifecycle, not by service. infra/persistent holds
what must survive teardown at near-zero idle cost: the ECR repository, the
SPA bucket, the CloudFront distribution (its stable default domain is what
Stripe webhook registrations and OAuth redirect URIs point at), the GitHub
Actions OIDC role, application secrets, and the origin-verify secret.
infra/ephemeral holds everything that bills by the hour: VPC, ALB, ECS
service, RDS, and the database credentials it generates.
Consequences: the persistent distribution's /api origin must follow the
ephemeral ALB, so stand-up is apply ephemeral, then apply persistent with the
new ALB hostname; teardown reverses it, leaving the origin pointed at a
placeholder that 502s while the environment is down. The deploy workflow owns
that ordering. State lives in an S3 bucket created once by a documented
bootstrap command, never in the repo.

## ADR-009: M1 asserts the cookie contract structurally, not at deploy time (2026-07-13)

Context: PLAN M1 acceptance asked for a deployed cookie round-trip proof, a
criterion written when the SPA and API risked living on different registrable
domains. The single-origin CloudFront topology removed that failure mode:
browser, SPA, and API share one origin, so first-party cookie flow is
structural, and no M1 endpoint sets a cookie to probe.
Decision: M1's deploy smoke asserts TLS, /api/healthz, /api/readyz
post-migration, and the SPA loading from the same origin. The cookie
round-trip assertion moves to M2's e2e, where login sets a real session
cookie through the deployed topology.
Consequences: PLAN.md M1 acceptance is amended accordingly; the cookie test
gains teeth at M2 instead of testing a synthetic endpoint at M1.

## ADR-010: Identity core shape (2026-07-13)

Context: M2 builds registration, login, sessions, and the audit log by hand
on the primitives from RESEARCH.md, and the shape has to carry M4 (MFA,
OAuth) and M5 (authorization) without a rewrite.
Decision: domain logic is plain functions taking a Kysely instance
(passwords, sessions, accounts, audit), Fastify plugins own request-scoped
concerns (session-auth resolves the cookie into request.auth on every
request; origin-check is the CSRF gate), and routes are thin. Sessions are
opaque: a 256-bit random token in an HttpOnly SameSite=Lax cookie, only its
SHA-256 stored, with a 30-day absolute and 14-day idle expiry. Passwords use
argon2id at the OWASP parameters, asserted by test. Login rotates the session
(fixation defense) and answers wrong-password, unknown-email, and locked
identically (no oracle); registration's 409 is a known enumeration vector
closed in M3 with verification emails. No repository layer yet: the db-in,
data-out functions are the seam, revisited if M6/M7 table growth makes it
pay.
Consequences: M4's half-authenticated MFA state and OAuth provider identities
are deferred, not designed in; they extend the sessions and users tables by
migration. M5 hooks role checks into the same preHandler chain after
session-auth. Load-bearing invariant to preserve: a row in `sessions` means
fully authenticated, which is what makes requireAuth safe. M4's
password-ok-awaiting-TOTP state must therefore be a separate short-lived
challenge token (its own table, like M3's reset tokens), never a pending flag
on a session row.

## ADR-011: Email transport and the job queue (2026-07-13)

Context: M3 needs transactional email (verification, reset, security notices)
and async processing with retries and a schedule.
Decision: one nodemailer SMTP transport for both environments (Mailpit in dev
and CI, the SES SMTP endpoint in production), so sending pulls in no AWS SDK
and the driver is identical everywhere. pg-boss is the queue: Postgres-backed,
so no Redis, with email sends and a daily purge running as jobs. Delivery is
idempotent through an email_dispatches row keyed by a per-job dedupe key
(claim, send, mark sent), and a per-account daily cap counts those rows. Auth
tokens (verification and reset) are single-use: a random token, only its
SHA-256 stored, consumed by an UPDATE ... WHERE consumed_at IS NULL so reuse
matches zero rows.
Consequences: a crash between SMTP success and the sent_at write can, rarely,
re-send one email; accepted as standard at-least-once delivery. The SES
delivery-event (bounce and complaint) webhook is deferred to its own step
(M3b) because SNS signature verification is a separate, testable concern.

## ADR-012: Non-enumerating identity responses (2026-07-13)

Context: registration, verification resend, and reset requests must not reveal
whether an address has an account.
Decision: all three return the same 202 accepted regardless, and only a real
account triggers an email. Registration therefore no longer signs the user in
or returns the user; the browser flow is register, verify by email link, then
sign in. Login stays available to unverified accounts (the SPA shows a verify
banner); gating specific actions on verification arrives with the money
endpoints.
Consequences: the M2 auto-login-on-register flow is gone, which changed the
SPA and its e2e. Registration timing stays dominated by the argon2 hash, which
runs on the exists path too, so registration does not leak by timing. The
resend and reset-request endpoints do a token-issue plus enqueue only on a
match and run no argon2, so a registered address responds measurably slower
there; that residual channel is accepted because the deployed environment
holds only developer-owned addresses (docs/DATA.md).

## ADR-013: Deploy-pipeline fixes from the first real standup (2026-07-13)

Context: M1 was authored and offline-validated, then run against a real AWS
account for the first time. Five gaps surfaced that neither terraform validate
nor actionlint can catch, because they only appear against live infrastructure.
Decision and fixes, in the order they surfaced:
1. The deploy workflow did not pass the AWS region to terraform, so applies
   defaulted to us-east-1 while the account and state were us-west-2. Fixed
   with TF_VAR_region in the workflow env.
2. GitHub-hosted runners no longer ship terraform preinstalled (exit 127).
   Added hashicorp/setup-terraform (pinned, terraform_wrapper: false so
   `terraform output -raw` stays clean).
3. The "provision data layer, then migrate, then full apply" ordering did not
   work: the migrate task definition depends only on the secret ARN, not RDS or
   the public subnets, so a targeted apply created neither the database nor the
   networking the migration RunTask needs. Reworked to a full ephemeral apply
   first, then migrations, then the CloudFront cutover. On a first standup the
   ECS service boots healthy on its liveness probe before the app schema
   exists and real traffic only arrives at the cutover; on update the rolling
   deploy overlaps old and new code, so migrations follow expand/contract.
4. RDS 18 forces SSL (rds.force_ssl); the app, pg-boss, and node-pg-migrate all
   connected in plaintext and every task crashed on boot. Fixed by adding
   sslmode=no-verify to the database URL secret, which all three clients read.
   Encrypted, VPC-internal, no CA verification; verify-full with the RDS CA
   bundle is the documented upgrade.
5. With those fixed, the standup completed and the deployed app passed
   end-to-end verification (health, register, login, cookie round-trip, CSRF,
   TLS).
Consequences: the deploy-first sequencing paid off exactly as intended, flushing
these out before any feature depended on the pipeline. The environment is torn
down after proving; the fixes stay in the workflow and infra for the next
standup.

## ADR-014: SES delivery-event webhook (2026-07-13)

Context: SES reports bounces and complaints via SNS. The endpoint is public,
so its only authentication is the SNS signature, and a wrong response poisons
deliverability.
Decision: verify the SNS signature by hand on node:crypto (no AWS SDK, keeping
ADR-011's posture on the receive side), building the exact canonical string SNS
signs and pinning the signing-cert host to sns.<region>.amazonaws.com to block
cert spoofing and SSRF. A valid signature only proves AWS signed the message,
not that it is our topic, so the route is not even registered in production
until SES_SNS_TOPIC_ARN pins the topic; the handler also rejects any other
topic. Notifications are deduped by SNS MessageId and the claim plus the
suppress-and-audit run in one transaction, so a mid-process failure rolls the
claim back and the SNS redelivery reprocesses. Bounced and complained addresses
go in an email_suppressions table that deliverEmail checks before every send.
Consequences: the code is complete and tested with real RSA-signed synthetic
messages; the live wiring (SES configuration set, SNS topic, subscription) is
additive (terraform plus the env var) and lands when SES is connected. The
transactional claim-and-effect here is the pattern M6's Stripe inbox reuses.

## ADR-015: TOTP MFA shape (2026-07-13)

Context: M4a adds a second factor without violating ADR-010's invariant that a
session row means fully authenticated.
Decision: TOTP via otplib over a secret encrypted at rest with AES-256-GCM
(key from ENCRYPTION_KEY). Enrollment stages the encrypted secret with
totp_enabled_at null and only enables it once a code confirms it, returning
single-use recovery codes (stored as SHA-256). Login verifies the password,
then if MFA is on issues a short-lived single-use mfa_challenge token and
returns it instead of a session; /login/mfa exchanges the challenge plus a
TOTP or recovery code for a session. The session-minting tail (rotate, create,
audit, new-device notice, set cookie) is extracted to completeLogin so the
password path, the MFA path, and M4b's OAuth callback all share it. Disabling
requires a current code. The encryption key lives in the persistent stack so
it is stable across stand-ups; a rotated key would orphan every enrolled
secret.
Consequences: the half-auth state is a row in its own table, never a session
flag, so requireAuth stays a simple "is there a session" check. TOTP replay is
closed by tracking the last accepted time step (totp_last_step) and rejecting
any code at or before it, so a code captured within its validity window cannot
be reused. Enable and disable are audited and notified; disable also accepts a
recovery code so a lost authenticator is not a lockout. M4b's OAuth converges
on completeLogin and adds a provider_identities table plus a nullable
password_hash.
