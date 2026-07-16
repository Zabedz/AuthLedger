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

## ADR-016: OAuth social login and the MFA challenge cookie (2026-07-13)

Context: M4b adds Google (OIDC) and GitHub (OAuth2) login, which must not
weaken the password/MFA guarantees or hand the SPA any bearer secret. It also
revisits how the MFA challenge from ADR-015 reaches the second-factor step.
Decision: providers hide behind one OAuthClient seam (begin/complete). Google
uses openid-client's discovery with PKCE and id_token nonce validation, with
the discovered Configuration memoized per client (a failed discovery is not
cached). GitHub is plain OAuth2 (no id_token): after the code exchange the
client reads GitHub's /user and /user/emails REST endpoints and takes identity
from the verified primary address, never the public profile email (which is
null when the user keeps it private). The authorization flow is bound to the
browser: /start stores state, PKCE verifier, and nonce in an expiring
single-use oauth_flows row and sets an al_oauth_state cookie scoped to
/api/auth/oauth; /callback rejects unless the URL state matches that cookie,
then consumes the flow. Account linking is conservative: an existing
provider_identity logs in; otherwise a verified provider email links to or
creates the account owning that address; an unverified or already-claimed
email never touches an existing account and instead gets a synthetic
${provider}-${id}@users.noreply.authledger address. The OAuth callback reuses
the MFA gate and completeLogin (both through a shared beginMfaChallenge helper),
so a linked account with TOTP on gets a challenge and a redirect to /mfa, never
a session. The MFA challenge token now rides in an HttpOnly al_mfa cookie scoped
to /api/auth/login/mfa (its only reader) instead of the login response body, so
the password step and the OAuth step feed /login/mfa the same way and the token
is never exposed to SPA JavaScript. A public /oauth/providers endpoint lists
only wired-up providers so the sign-in screen shows no dead buttons.
Consequences: password_hash is nullable (OAuth-only accounts have none), and
provider_identities carries a unique (provider, provider_user_id). The
challenge-cookie move supersedes ADR-015's body-returned challenge. Client
secrets stay server-side; the SPA only ever sees provider names and follows
full-page redirects. Deferred: a per-provider allowlist of redirect origins if
more clients are added, and graceful retry (rather than a one-shot error) when
two genuinely simultaneous first-logins collide on the identity unique
constraint (safe today, since a retry links to the now-existing identity).

## ADR-017: Authorization: RBAC, deny-by-default, and a money policy module (2026-07-13)

Context: M5 adds authorization before payments so the money endpoints are born
gated. It must enforce coarse role permissions, express finer money rules
(ownership, amount ceilings), and make an endpoint added without a policy fail
closed rather than open.
Decision: RBAC splits by change cadence. The role x action matrix is reference
data seeded in migration 0006 (roles, permissions, role_permissions), versioned
with the code that enforces it and mirrored by the PERMISSION_ACTIONS and
ROLE_NAMES literal types in domain/authz.ts; which user holds which role is
runtime data in user_roles. Permissions resolve per request in the session-auth
preHandler (loadPermissions joins user_roles to role_permissions), so a grant or
revoke takes effect on the next request without reissuing the session, and
request.auth carries the permission set. Enforcement is two layers: every /api
route declares a policy in its Fastify config ('public', 'self', or
{ permission }), and an onRoute/onReady guard (authz-guard.ts) refuses to boot
if any route lacks one, so a new endpoint fails the deny-by-default check (and
CI) instead of defaulting to open; requirePermission is the request-time check
of the same action. The authorize(action) helper bundles the preHandler and the
policy config so the enforced and declared actions cannot drift. The admin
surface lives at /api/admin (user list, role grant/revoke, audit read, revoke
another user's sessions), each gated by its permission and audited. The first
admin is granted at boot from ADMIN_EMAIL (idempotent, a no-op until that
account exists). Money authorization that a single permission cannot express
(ownership, a refund ceiling above which a second capability is required) is a
separate module of pure functions (domain/policy.ts) returning a decision plus a
reason for the audit log; capabilities are injected, so the functions stay
database-free and unit-tested, and the money cells are finalized against real
request shapes as the M6/M7 endpoints land.
Consequences: 'self' is a policy class meaning session-required-own-resource; it
asserts a session (requireAuth) but the ownership check stays in each handler
(the routes act only on req.auth.user), so 'self' is a classification, not extra
enforcement. Every authenticated request runs one extra join to load
permissions, accepted for now over lazy loading. Money capabilities are a second
vocabulary from RBAC permission actions until M6 wires them into the permissions
table. Deferred: auditing 403 denials, pagination cursors on the admin lists
(offset paging for now), and a lazy per-request permission load if the eager
join shows up in profiling. M6 obligations when it calls the policy module:
seed the money capabilities as permission rows and collapse MoneyCapability into
PermissionAction, confirm the refund ceiling value (possibly config, not
source), and validate a refund amount is positive before the policy check (the
pure function does not range-check its input).

## ADR-018: Payments foundation: webhook inbox and internal event model (2026-07-13)

Context: M6 adds Stripe payments. The account-independent parts land first (the
webhook inbox, the mapping to an internal model, and payment views); the live
PaymentIntent and refund flow (M6b) needs a Stripe test key and builds on these
seams.
Decision: Stripe stays behind an anti-corruption boundary. The webhook route
verifies the signature and hands the raw event to mapStripeEvent, the only
module that names Stripe event or object types; it returns an
InternalPaymentEvent (defined in the Stripe-free payments domain) or null for a
type not modeled yet. Everything downstream, including M7's ledger, sees only
the internal model. The inbox is provider_events keyed by the Stripe event id:
every delivery is recorded once, so a replay conflicts and is a no-op, and the
claim-and-apply runs in one transaction so a processing failure rolls the claim
back and the retry reprocesses. An event with no handler is stored 'unhandled',
not failed, so a type modeled later is not lost. Out-of-order deliveries are
absorbed by a last_event_at high-water mark plus a terminal-status lock
(succeeded, failed, and canceled never move), so a late event is a no-op rather
than a downgrade. Signature verification needs the exact bytes, so the Stripe
plugin keeps the raw request buffer through a plugin-scoped application/json
parser while other routes keep JSON parsing; without a webhook secret the route
fails closed with a 503. The M5 placeholder MoneyCapability type collapses into
the RBAC PermissionAction: the money actions are seeded in migration 0007 and
granted to admin, and payment views are gated 'self' with the
owner-or-payments.view_any decision made in the policy module, not the route.
Money is integer minor units; amount_minor is bigint in Postgres, surfaced as a
JS number in the view, which is exact for realistic amounts.
Consequences: M6b adds PaymentIntent creation (our idempotency_key plus Stripe's
idempotency key), refunds, and the SPA Payment Element against these seams
without touching the inbox. The Stripe secret key and webhook signing secret are
required for the live flow. Deferred: a dedicated finance role (admin holds all
money permissions for now); carrying money as a string end to end if amounts
could exceed 2^53 minor units; disputes (M7) land as 'unhandled' inbox rows
until their handler exists.

## ADR-019: Live payment flow: intent creation, refunds, and idempotency (2026-07-13)

Context: M6b puts real payments through the M6a foundation, needing a Stripe test
key: PaymentIntent creation, refunds, and the publishable key for the SPA. The
flow was proven end to end against Stripe test mode (create, confirm a test card,
webhook to succeeded; idempotent create; partial and idempotent refund).
Decision: creating a payment (POST /api/payments) requires an Idempotency-Key
header, scoped to the user and passed as Stripe's idempotency key, so a client
retry is one charge on both sides; the row is upserted on our key and the
payment_created audit fires only on a genuine insert, not on a retry. Refunds
(POST /api/payments/:id/refund) are gated by the payments.refund permission plus
the canRefundPayment ceiling policy, and every refund is a row in a refunds table
keyed by its own idempotency key, so a retried refund is a no-op. The cumulative
refunded total both bounds a new refund (it cannot exceed the remaining balance)
and is what the ceiling is checked against, so several sub-ceiling partial
refunds cannot be split around the ceiling. The Stripe calls and the create DB
write are wrapped, so a provider or database failure returns a clean 502 or 503,
never a leaked error message. A public GET /api/payments/config serves only the
publishable key (never the secret or webhook secret) for the SPA. These endpoints
take the shared injected Stripe client, so tests drive them with a stub and no
network.
Consequences: the SPA Payment Element (M6c) consumes /config and the client
secret from create. The intent is card only (payment_method_types: ['card']),
which renders a deterministic card form; the SPA mounts the Payment Element with
the client secret and confirms with redirect: 'if_required'. The client mints one
idempotency key per attempt (rotated when the amount changes or a payment
finishes), so a resubmit is one charge. The full browser confirm cannot be
automated: Stripe Radar serves an hCaptcha to automated browsers, so the click
through to settlement was proven with the server-side live flow (create, confirm
a test card via the API, webhook to succeeded) rather than a headless e2e, and
the Payment Element mounting/rendering was verified in a real browser. Deferred
to M7: reconciliation to catch an out-of-band 'unmatched' event, refund and
dispute ledger postings, and a finance role holding payments.refund_over_ceiling
(admin holds it now). The reviews that shaped this ADR (a four-lens adversarial
pass on the API, then a pass on the SPA) caught the split-refund ceiling bypass,
the same-amount refund idempotency-key collision, the non-idempotent create
audit, and the unwrapped Stripe error path; all are closed here.

## ADR-020: Double-entry ledger with a database-enforced balance invariant (2026-07-13)

Context: M7 adds the ledger. Every money movement has to be recorded as balanced
journal entries with the invariant enforced by the database (not the
application), the ledger has to be append-only, and postings are driven by the
internal event model from the webhook inbox.
Decision: a posting is a signed integer minor amount on one column (a debit is
positive, a credit negative) and an entry's postings sum to zero; a debit/credit
pair would carry the same information with more columns and a redundant sign.
The chart of accounts is reference data (ledger_accounts, seeded in migration
0009). An entry carries a unique (kind, reference), where reference is the
provider id, so a redelivered event posts once. The balance invariant is a
DEFERRABLE INITIALLY DEFERRED constraint trigger that checks SUM(amount_minor)=0
for the entry at commit, so a multi-posting entry is validated as a whole; this
is the database constraint the plan asks for, not app logic. The ledger is
append-only: BEFORE UPDATE and DELETE triggers refuse edits on both tables, and
a correction is a reversing entry (kind 'reversal' with opposite postings, which
leaves both rows in place). This is the project's first use of plpgsql
triggers/functions, which is the right tool for an integrity rule the database
must own. The ledger is Stripe-free: it references a movement by the provider
intent id (a string), so it does not depend on the payments schema or on Stripe,
and reconciliation (M7b) and tracing (M8) build on it. The webhook route is the
composition point: on a settled charge it posts Dr stripe_receivable, Cr revenue
for the gross in the same transaction as the payment status update, so a payment
and its journal entry commit together or not at all.
Consequences: postEntry must run inside a transaction (the webhook provides one)
so the entry and its postings commit together; the postings are written as one
multi-row insert, and the deferred constraint catches an imbalance at commit.
accountBalance sums in SQL over bigint so many rows keep precision. TRUNCATE
bypasses the append-only row triggers and is used only to reset the ledger
between tests; the application never truncates. Deferred to M7b: refund and
dispute postings (those events currently land 'unhandled' in provider_events),
fee postings and the daily reconciliation against Stripe balance transactions
(the source of truth for settled amounts and fees, after which stripe_receivable
reflects the net owed), and admin ledger and reconciliation views gated by M5.

## ADR-021: Reconciliation against provider balance transactions (2026-07-13)

Context: M7 reconciles the ledger against the provider. Stripe balance
transactions are the record of settled amounts and fees; the webhook is a
delivery channel, not the source of truth, and the settlement webhook does not
carry the fee.
Decision: reconcile(db, stripe) lists the provider's balance transactions (a
pull, not a webhook push), posts each transaction's fee to the ledger (Dr fees,
Cr stripe_receivable) keyed by the balance-transaction id so a re-run is a no-op,
and flags a settled charge whose payment intent has no ledger charge as a
discrepancy. Posting fees here is why the charge posts gross at settlement and
stripe_receivable nets to what the provider actually owes only after
reconciliation. Because a balance transaction is pulled, not pushed, its Stripe
coupling lives in reconcile() rather than behind the webhook mapping module: the
anti-corruption boundary for a pull is the reconcile function, which turns
balance transactions into ledger effects. Each run's outcome is persisted in a
reconciliations table (migration 0010) for the admin view and the logs;
runAndRecordReconciliation wraps reconcile plus the insert, and the scheduled
daily job (EventBridge to ECS RunTask, deferred to an AWS standup) calls the same
function. The admin surface is POST /api/admin/reconcile (run now), GET
/reconciliations (history), and GET /ledger (balances grouped by account and
currency so mixed minor units are never summed), all gated by ledger.reconcile
and the reconcile run audited.
Consequences: the Stripe object vocabulary stays in mapBalanceTransaction
alongside mapStripeEvent, so reconcile() sees only Settlements and the ledger
stays provider-free (the "one place" seam holds for the pull as it does for the
push). What "reconciled" means here is bounded: it flags an intent-backed settled
charge missing from the ledger, one-directional (not the reverse, not an amount
mismatch), and only charge/payment balance transactions are treated as
settlements, so payout and transfer principals are not modeled and
stripe_receivable is the recognized net, not the literal provider balance.
A single balance-transaction page (limit 100, no has_more paging, no created
window) suffices for this project's volume; a higher-volume or long-idle job
would page and window on the newest reconciliations.ran_at, which also keeps the
M8 nightly reconcile correct as the never-purged e2e data accumulates. Deferred:
the EventBridge to ECS schedule (needs an AWS standup) with structured run
logging and a status/error column so a failed scheduled run is visible in the
admin view; pagination with the ran_at watermark; refund and dispute fee
reversals; the reverse-direction and amount-mismatch checks; and a per-currency
fees-posted summary (the postings are currency-tagged; only the summary metric
sums across currencies).

## ADR-022: Distributed tracing with hand-written spans (2026-07-14)

Context: M8 wants one trace that runs from an HTTP request through the Stripe
webhook to the ledger posting, with the trace id on every log line, and an
exporter that only ships when a collector is configured. The service is ESM, and
OpenTelemetry auto-instrumentation patches modules through a loader hook that is
awkward under ESM and pulls in a large instrumentation surface.
Decision: instrument by hand. tracing.ts builds a NodeTracerProvider and registers
it only when an exporter is chosen: OTEL_EXPORTER_OTLP_ENDPOINT selects a batched
OTLP/HTTP exporter, OTEL_TRACES_CONSOLE selects the console exporter for local
inspection, and with neither set the provider is never registered. A Fastify
plugin (plugins/tracing) opens one SERVER span per request and keeps it active for
the whole request by wrapping the Fastify continuation in context.with, the same
way the existing request-id AsyncLocalStorage wraps it; the span is renamed to the
matched route template on response so its name stays low-cardinality. postEntry in
the ledger domain opens a child span around its inserts, so a webhook or a
reconciliation run traces down to the write. The log mixin reads the active span
and adds trace_id and span_id, so logs and traces join on trace_id. The domain
function reaches for @opentelemetry/api, which is a no-op when no provider is
registered, so tracing stays a single dependency at the domain edge rather than a
parameter threaded through every signature.
Consequences: with no exporter configured, no provider is registered, the API's
tracer and getActiveSpan are the built-in no-ops, and the request hooks are not
registered at all, so the default path is unchanged and effectively free; tests
and the OpenAPI generator build the server with tracing off and are untouched.
Coverage is deliberately narrow: only the HTTP span and the ledger posting are
instrumented, not individual database queries or outbound calls, which keeps the
trace readable and avoids the auto-instrumentation footprint; a query-level span
can be added later behind the same provider if a latency question needs it. This
is the first cross-cutting import into the otherwise db-in/data-out domain, so it
is bounded by a rule: the domain may import @opentelemetry/api, the
no-op-until-registered facade, but never the SDK or an exporter, so the heavy
packages stay in the composition root. Span attributes carry no secret or PII,
because a span bypasses the pino redaction path (logging.ts) and reaches the
collector as written; the current ledger.kind, reference, currency, and
posting_count are safe, and a Stripe intent id is not PII.
Because the spans are manual, a new subsystem that should appear in a trace has to
be instrumented on purpose, which is the cost of not patching modules. The OTLP
exporter reads the standard OTEL_ environment variables (endpoint, headers) rather
than taking wiring in code, so pointing at Grafana Cloud or any collector is
configuration, and the collector account itself is the remaining gated piece.

## ADR-023: Sentry for error tracking, kept apart from tracing (2026-07-14)

Context: M8 wants error tracking (grouping, alerting, stack context) that AWS has
no first-class equivalent for. Sentry fills that, but its Node SDK is built on
OpenTelemetry and, left to its defaults, registers its own tracer provider and
patches http, fetch, and framework modules. The service already has an
OpenTelemetry provider that ships traces to a collector (ADR-022), so an
unconstrained Sentry.init would fight it.
Decision: run Sentry as an error reporter only, fully apart from the tracing
provider. startSentry initializes the client only when SENTRY_DSN is set, with
tracesSampleRate 0 (traces are OpenTelemetry's job), skipOpenTelemetrySetup so it
never registers a second provider, defaultIntegrations off with only the
event-shaping integrations kept (inbound filters, linked errors, dedupe, context
lines, and the uncaught-exception and unhandled-rejection handlers), so nothing
patches a module or opens a span. The unhandled-rejection handler runs in strict
mode, so a stray rejection still crashes the process (Node's default) after the
event is captured, rather than being downgraded to a warning that leaves the
process running in an unknown state. A hand-written Fastify onError hook (in
plugins/sentry) reports thrown failures worth reporting: it filters on the
error's own status (a thrown error with no status is an unexpected 500, a 4xx is
a client error and skipped), because the reply status is not yet set when onError
runs, which is also why Sentry's own default filter would misjudge it. onError
only fires for a thrown or rejected error, not a returned reply, so a catch site
that turns a failure into reply.code(5xx) (the Stripe create and refund paths in
routes/payments) calls reportServerError so those, the most page-worthy errors in
the app, are not silently dropped. beforeSend stamps the active OpenTelemetry
trace_id and span_id onto the event, so an issue links back to its trace.
sendDefaultPii is off and both capture paths attach only the method and route
template, so no header, cookie, query, or body reaches Sentry.
Consequences: with no DSN, the client is never initialized and the onError hook
is never registered, so tests and the OpenAPI generator are untouched and the
default path is unchanged; sentryEnabled is the one predicate both the bootstrap
and the registration read, so they cannot drift. Errors and traces stay in
separate systems joined only by trace_id, which keeps each backend swappable (the
reason for not adopting AWS X-Ray or CloudWatch here is recorded in
docs/RESEARCH.md: the app is mostly local and only briefly on AWS, so a backend
decoupled from the AWS runtime fits). Capture calls (the onError hook and
reportServerError) stay at the composition-root, plugin, and route edge; they do
not go into the db-in/data-out domain, which keeps to the same rule ADR-022 set
for the tracing facade. Turning on release health or performance later is
re-enabling the dropped integrations behind the same DSN.

## ADR-024: The scheduled reconciliation run is a one-off task, not a queue job (2026-07-16)

Context: ADR-021 deferred the daily reconciliation schedule. The app already has
a pg-boss queue for email work, so the obvious move was a pg-boss cron job. But
the queue lives inside the API service process: a reconciliation scheduled there
runs on whichever instance holds the singleton, competes with request traffic,
and disappears entirely if the service is scaled to zero, which this project's
ephemeral environment regularly is. The deploy already runs one-off work (the
migrate task) as a separate ECS task from the same image with a command
override, started by the deploy workflow.
Decision: the schedule follows the migrate pattern, not the queue. A thin
entrypoint (jobs/reconcile.ts) assembles config, Sentry, tracing, a pino logger
from the same loggerOptions the API uses, a pool, and a Stripe client, then
calls runAndRecordReconciliation, the same function the admin endpoint calls.
EventBridge Scheduler starts it daily via ecs:RunTask on a dedicated task
family. The process exits 0 on success (discrepancies are a finding for the
admin view, logged at warn, not a failure) and 1 on failure, so the task state
reflects the outcome. runAndRecordReconciliation now records a failed run in
the reconciliations table (status and error columns, migration 0011) before
rethrowing, so the run history never shows silence for a run that broke; the
admin list endpoint surfaces both columns. The whole run is wrapped in a
reconciliation.scheduled_run span and failures are reported to Sentry tagged
job=reconcile.
Consequences: the job needs no live API instance and no queue singleton; it
scales to zero with the rest of the ephemeral stack and costs nothing between
runs. The same code path serves the button and the schedule, so proving one
proves the other. Three hedges are accepted: a run that dies before it can
write the failure row (OOM, SIGKILL) still leaves silence, visible only as a
missing day in the history and a failed task in ECS; failure recording shares
the database with the thing it reports on, so a database outage is reported by
Sentry and the exit code, not the history; and a run the scheduler never
manages to start (an ecs:RunTask invoke failure) leaves neither a row nor a
Sentry event, mitigated by the scheduler's invoke retries and self-healing at
the next day's run, since every run re-scans the latest page idempotently. On
a failed row, checked and fees_posted_minor read 0 regardless of how far the
run got before breaking; fees post per settlement in their own transactions,
so the ledger, not the run history, is authoritative for what a partial run
posted, and a re-run skips what already landed without recounting it. The
deferred pagination watermark (ADR-021) must key off the newest status ok row,
not the newest row. The Terraform for the schedule lives in the ephemeral
stack and is proven at the next standup.

## ADR-025: Reconciliation windows on the last successful run (2026-07-16)

Context: ADR-021 shipped reconciliation over a single unwindowed page of 100
balance transactions and recorded paging and windowing as deferred. With the
nightly e2e and the daily schedule both writing to one Stripe test account, the
latest-100 snapshot will eventually stop covering a full day, and a silent
under-scan is the worst failure mode a reconciliation can have.
Decision: the fetch windows on the newest status ok run (a failed run does not
advance the watermark), overlapped by an hour so a transaction created while
the previous run was in flight is re-read; fee posting is idempotent, so the
overlap is free. Within the window the fetch pages on has_more, and a window
still holding more after ten pages fails the run with an explicit error rather
than under-scanning quietly; the failure lands in the run history like any
other. The first run ever scans one unwindowed page, which covers the whole
test history at this volume. The missing-charge check now also compares
amounts: a settled charge whose ledger posting disagrees with the provider's
gross is flagged as an amount mismatch, since a wrong amount is worse than a
missing row and was previously invisible. Whether the comparison is meaningful
is keyed off the balance transaction's exchange rate, not off currency
equality: an unconverted settlement must agree with the ledger on both
currency and gross (a currency disagreement there is itself flagged), while a
converted one (a usd charge on a gbp account, which is exactly what the test
account does) arrives as a different currency and can be compared on neither.
Verifying converted amounts would need the exchange rate and a tolerance;
deferred until a multi-currency ledger exists to need it.
Consequences: discrepancy detection is windowed, so a charge that goes missing
from the ledger after its window has passed stays undetected until a manual
unwindowed run; that trade is accepted because the ledger is append-only and
the webhook and reconcile paths are the only writers. Two deferrals remain
recorded rather than built. The reverse-direction check (a ledger charge with
no settled provider transaction) needs a settlement-status model to avoid
flagging every fresh charge between webhook and settlement, so it waits for a
real need. The unmatched-inbox reprocessor (ADR-018) stays deferred: an
unmatched event means an intent this system never created, reconciliation now
flags the settled ones every run, and replaying provider events against a
payment row that appeared later has no trigger in the current flows.
