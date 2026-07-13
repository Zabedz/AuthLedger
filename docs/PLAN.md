# Plan

High-level milestones only. Each milestone ends with a working system and
green CI, deployable to the on-demand test environment from M1 onward; each
builds on the one before it. Implementation detail
lives in ADRs (docs/DECISIONS.md) written as the work happens. Stack choices
and their reasoning are in docs/RESEARCH.md.

Status: awaiting approval. No application code before that.

## Scope boundaries

In scope: the identity and money domains described in the README, their
intersection (authorization over transactions), and the operational shell that
makes them production-shaped (CI/CD, observability, docs, threat model).

Out of scope, deliberately: multi-tenancy, internationalization, mobile
clients, real money movement (sandbox only, tokenization only, no raw card
data), marketing pages, and any microservice split. One API, one SPA, one
database.

## M0: Foundations

A cloneable skeleton that proves the toolchain end to end, before any domain
logic.

Monorepo layout (api, web, shared types), strict TypeScript, Fastify app with
`/healthz` and `/readyz`, structured logging with request IDs, OpenAPI
generation wired from the first route, Docker Compose (Postgres, Mailpit,
Stripe CLI), SQL migration runner plus type generation, ci.yml with every
required check from the research doc, `.env.example`. The seed command arrives
with the first real schema in M2; a stub against zero tables would be dead
code.

Acceptance:
- Fresh clone to running system in one command plus one make target,
  documented in the README.
- ci.yml green with all checks required: lint, typecheck, test, types-in-sync,
  build (image boots, argon2 smoke test passes), gitleaks, osv-scanner.
- The Postgres major used in compose is confirmed available on RDS.
- OpenAPI spec is generated from route schemas and served in dev.

## M1: Deployable walking skeleton

The empty system reaches its deployed shape before features exist, so every
later milestone lands on a proven pipeline instead of a hope.

The on-demand AWS environment from the research doc: ECR, one Fargate task
behind an ALB, CloudFront default domain serving the SPA placeholder from S3
and routing `/api/*` to the ALB, RDS Postgres, Secrets Manager, and deploy.yml
(workflow_dispatch) with stand-up, update, and teardown actions. Teardown
keeps the near-zero-cost persistent layer (CloudFront distribution, S3
bucket, ECR repo) so the public URL stays stable across stand-ups. The
provisioning tool (OpenTofu/Terraform, CDK, or plain scripts) is chosen by
ADR at milestone start.

Acceptance:
- One workflow dispatch stands the environment up from nothing, a second
  updates it in place, and a third tears it down, verified against the
  console and the next day's bill.
- Migrations run before cutover; a failed migration aborts the deploy.
- The CloudFront URL serves the SPA placeholder and `/api/healthz` over valid
  HTTPS on the default `cloudfront.net` hostname (the reachability Stripe
  webhooks will need in M6).
- The SPA and the API respond from one origin; the cookie round-trip is
  structural under that topology and is asserted by M2's e2e once login sets
  a real cookie (ADR-009).
- The ALB accepts traffic only through CloudFront (managed prefix list plus a
  verified origin header).
- Cost of the environment while up is documented; rollback procedure
  documented and exercised once.

## M2: Identity core

Registration, login with argon2id, opaque server-side sessions in Postgres,
logout, active-session listing and revocation, CSRF and CORS policy from the
research doc, per-route rate limits, account lockout, and the security audit
log table. Minimal SPA pages for register, login, and session management. The
idempotent seed command lands here with the first schema: one user per role
with fixed UUIDs.

Acceptance:
- Integration tests cover the happy paths and the abuse paths: wrong
  password, locked account, rate-limited endpoint, revoked session, missing
  or foreign Origin header on a state-changing request.
- Password storage matches OWASP guidance (argon2id, per-user salt, no
  length truncation); asserted by tests, not convention.
- Session cookie flags (HttpOnly, Secure, SameSite=Lax) asserted in an e2e
  test against the composed stack in CI, and against the test environment
  when it is up.
- Authenticating issues a new session id (fixation defense), proven by test.
- Log redaction of authorization headers, cookies, and token fields is
  configured and covered by a test that fails if a secret reaches a log line.
- Every security-relevant event (login, failure, lockout, revocation) lands
  in the audit log with actor, IP, and user agent.

## M3: Email flows and background jobs

The mailer interface (SES in the test environment, Mailpit in dev and CI),
the pg-boss job queue, email verification, password reset with single-use
hashed tokens, security notification emails, bounce and complaint
notifications from the mail provider, account deletion, and housekeeping jobs
(expired session and token purge).

Acceptance:
- Verification and reset flows tested end to end through Mailpit's API,
  including token expiry and reuse rejection.
- Password reset invalidates all active sessions; the event is audited and
  the user notified.
- Registration, verification, and reset responses do not reveal whether an
  account exists (uniform status, wording, and timing envelope).
- Email sends retry on failure and are capped per account per day.
- Bounce and complaint notifications (SNS messages, for SES) are
  signature-verified, replay-protected, and audited, exercised against the
  SES mailbox simulator; the same discipline as the payment webhooks.
- Account deletion removes personal data, revokes all sessions, and is
  audited; the data-retention note is published with the docs (the test
  environment only ever holds developer-owned addresses).
- A killed job mid-run is retried without duplicate effects.

## M4: MFA and social login

TOTP enrollment and verification with recovery codes, and OAuth login (Google
and GitHub) through openid-client with explicit account-linking rules. SPA
pages for enrollment, challenge, and recovery.

Acceptance:
- TOTP setup, challenge, drift window, and recovery-code consumption covered
  by tests (otplib generates codes in tests; no phone needed).
- OAuth flows tested against a stub OIDC provider in CI and manually against
  the real providers in the deployed test environment.
- Rate limits and lockout apply to TOTP and recovery attempts; enrollment and
  disablement are audited and notified.
- An account with MFA enabled cannot be accessed by password alone, and a
  linked OAuth login does not bypass the TOTP challenge; both proven by test.

## M5: Authorization

RBAC (roles and permissions in Postgres, enforced in a Fastify preHandler)
plus the policy module for money rules: who may initiate, view, refund, or
reconcile a transaction, with amount ceilings. Admin surface for role
assignment. This lands before payments so the money endpoints are born
authorized: M5 delivers the enforcement mechanism and the identity-domain
matrix, and the money cells are finalized against real request shapes as the
M6 and M7 endpoints land, rather than invented ahead of them.

Acceptance:
- A documented permission matrix (role x action) for the identity domain with
  a test per cell, including the deny cases; money rows are added with their
  endpoints in M6 and M7 under the same test-per-cell rule.
- Policy module is pure functions with unit tests; decisions include a
  reason usable in audit entries.
- Role changes take effect on the next request (no session re-issue needed)
  and are audited.
- Deny-by-default proven: an endpoint added without an explicit policy fails
  closed and fails CI.

## M6: Payments core

Stripe integration: payment intent creation with idempotency keys (ours and
Stripe's), the Payment Element flow in the SPA, the webhook inbox (signature
verification, replay rejection, out-of-order tolerance) with the mapping layer
that turns raw Stripe events into the internal event model, refunds, and
payment views gated by M5 policies.

Acceptance:
- A test-mode card payment succeeds end to end locally (Stripe CLI
  forwarding) and in the deployed test environment.
- Replayed, tampered, and stale webhook deliveries are rejected or no-op;
  proven by tests that send real signed payloads.
- Inbox processing consumes internal events only; Stripe type names do not
  appear outside the mapping module, so M7 builds on the internal model
  without touching the M6 pipeline.
- Event types without a handler yet (disputes arrive before M7) are stored
  and marked unprocessed, not failed.
- Creating the same payment twice with one idempotency key produces one
  charge; a network retry mid-create produces one charge.
- Declines and failures surface correctly in the SPA; no raw card data
  touches the API (asserted by the absence of any card field in the API
  schema).

## M7: Ledger and reconciliation

The double-entry ledger: append-only journal in integer minor units with the
balance invariant enforced by the database, postings driven by the internal
event model from the inbox, dispute handling, and the daily reconciliation job
with a discrepancy report. Reconciliation compares the ledger against Stripe's
balance transactions, which are the record for settled amounts and fees;
webhook events are a delivery channel, not the source of truth. Admin views
for ledger and reconciliation, gated by M5.

Acceptance:
- Every money movement (charge, refund, dispute, fee) produces balanced
  journal entries; the invariant is a database constraint with a test that
  proves an unbalanced insert fails.
- UPDATE and DELETE on ledger tables are denied to the app role; corrections
  are reversing entries; proven by tests.
- Reconciliation detects a seeded gap (a provider event deliberately withheld
  from the inbox) and reports it; a clean run reports zero discrepancies.
- The scheduled job runs daily (EventBridge Scheduler to ECS RunTask) while
  the test environment is up, and its outcome is visible in logs and the
  admin view.

## M8: Hardening and presentation

The portfolio surface: threat model written down (assets, actors, trust
boundaries, mitigations mapped to code), OpenTelemetry tracing with manual
spans on the domain intersections, Grafana Cloud and Sentry wired, log
shipping, the backup and restore rehearsal, dependency and secret scanning
verified end to end, README with architecture diagram, and the full e2e happy
path (register, verify, MFA login, pay, refund, reconcile) running nightly in
CI against the composed stack with real sandbox events; the same suite targets
the AWS environment whenever it is up. E2e users are namespaced so views can
filter them, and within any environment's lifetime the append-only rule means
they are never purged.

Acceptance:
- Threat model reviewed against the implemented code, with each mitigation
  pointing at the module that implements it.
- One trace shows a payment from HTTP request through webhook to ledger
  posting, with the trace id present in the corresponding log lines.
- A database restore from backup is performed once and documented.
- README alone is enough for a stranger to run, understand, and evaluate the
  system; OpenAPI spec published; no TODOs, dead code, or commented-out code
  anywhere in main.

## Sequencing rationale

Deployability lands at M1, not the end, because the cookie topology, the
HTTPS reachability that webhooks will need, and the migration pipeline are
riskiest-first concerns that features then inherit for free. Identity precedes money because the money endpoints must be
born behind real authorization (M5), which needs users, sessions, and roles to
exist. The ledger follows the payment integration because its postings are
driven by the webhook inbox built in M6. Anything that adds a service or a
vendor beyond docs/RESEARCH.md needs an ADR first.
