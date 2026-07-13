# Phase 0: stack research and decisions

Date: 2026-07-12. Every price, free-tier limit, version number, and support
status below was checked against the linked page on that date rather than
recalled. Where a figure is likely to move soon (survey data, monthly API
releases, LTS transitions), the section says so.

The project is a full-stack, production-shaped application with two domains
that intersect on purpose: a hand-built identity layer (authentication and
authorization) and a payments integration with a double-entry ledger and
reconciliation. It is built by one developer, in public, on a near-zero budget,
with AWS credits available for a demo. Decisions optimize for
production-realism, job-market signal, and defensibility under review.

## Decision matrix

| Area | Decision | Runner-up | Deciding factor |
|---|---|---|---|
| Backend | TypeScript on Node.js 24 LTS, Fastify v5 | Go with chi | Posting volume for TS/JS, one language across the stack, primitives stay visible |
| Auth | Hand-rolled on argon2, otplib, openid-client; server-side sessions in Postgres; RBAC plus a policy module | better-auth as schedule fallback | The auth domain is half the portfolio; outsourcing it deletes the evidence |
| Payments | Stripe PaymentIntents, pinned API version, sandboxes, CLI webhook forwarding | Adyen | Only sandbox that exercises disputes, refunds, and replayed webhooks without friction |
| Database | Postgres 18; Kysely with kysely-codegen; SQL-first migrations via node-pg-migrate | Drizzle | Ledger invariants live in hand-written DDL; queries stay recognizable as SQL |
| Frontend | Vite, React, TanStack Router and Query; SPA, no BFF | React Router 8 framework mode | Single auth enforcement point; complexity budget stays on the backend |
| Local dev | Compose for Postgres, Mailpit, Stripe CLI; app on host | Full-container with Compose Watch | Native hot reload and debugger; parity proven in CI instead |
| Production | On-demand AWS test environment on credits: CloudFront default domain fronting S3 (SPA) and ECS Fargate (API), RDS Postgres | Fly.io + Neon + Pages standing demo at roughly $4/month | Personal project: no standing public demo and no purchased domain; credits cover testing |
| Observability | pino, OpenTelemetry (Jaeger v2 in dev, Grafana Cloud in prod), Sentry free tier, split health endpoints | Honeycomb | One free account holds logs, traces, and metrics, correlated by trace id |
| CI/CD | GitHub Actions: ci.yml gate plus deploy.yml; gitleaks, osv-scanner, Dependabot | none close | Free on public repos; the workflow files are part of the portfolio |
| Email | Amazon SES (sandbox, address-only identity) behind a mailer interface; Mailpit in dev and CI | Resend, if a public demo ever needs arbitrary recipients | Address identities need no domain; sandbox covers developer-owned recipients |

The deployment goal was revised on 2026-07-12, after review: this is a
personal project with local-first development and an on-demand AWS test
environment on credits, not a standing public demo. The originally
recommended standing-demo route (Fly.io, Neon, Cloudflare Pages, and a
purchased domain) stays documented in the production section, both as the
record of the comparison and as the switch to pull if a permanent demo URL is
ever wanted. Cross-cutting problems found when checking decisions against
each other are resolved in "Cross-cutting decisions" below; the most
consequential is cookie topology, resolved by serving the SPA and the API
from a single origin.

## Backend stack

The stack has to carry hand-built auth (password hashing, TOTP, OAuth login,
session and token lifecycle) and a payments integration (provider SDK, webhook
verification, a double-entry ledger), and it has to read well when a senior
engineer opens the repo. Job-market signal carries the most weight, so that
goes first.

### Job-market signal

[DevJobsScanner's analysis of roughly 3M job offers across 2025](https://www.devjobsscanner.com/blog/top-8-most-demanded-programming-languages/)
puts JavaScript/TypeScript first at about 30% of postings that name a language
(162K offers), ahead of Python at about 20% and Java at about 17%. The
[2025 Stack Overflow survey](https://survey.stackoverflow.co/2025/technology)
shows the same ordering in usage: JavaScript 66%, Python 57.9%, TypeScript
43.6%, Java 29.4%, Go 16.4%. Among back-end frameworks, Node.js sits at 48.7%,
with FastAPI (14.8%) and Spring Boot (14.7%) next. These figures are the latest
published; the 2026 survey lands around late July and may shift them, though
an ordering this wide rarely inverts in a year. For full-stack roles the case
is simpler: TypeScript is the one language that covers both ends of the repo,
so a portfolio aimed at backend plus full-stack listings hits two markets with
one codebase. Go is the growth story, particularly in fintech and cloud
infrastructure, but its absolute posting volume sits well below the JS/TS pool.

### TypeScript: NestJS, Fastify, Hono

NestJS is the most recognized Node framework name in job ads and holds 6.7%
usage against Fastify's 2.9% in the same survey. It is actively maintained,
current at [v11.1.28](https://github.com/nestjs/nest/releases). The problem is
what it does to this project: Nest's decorator and DI layer turns token
lifecycles, webhook verification, and policy checks into framework
configuration. The repo's whole argument is that the author understands those
mechanics, and hiding them behind `@UseGuards` weakens it. Nest-heavy CRUD is
also the look most associated with tutorial output.

Fastify, current at [v5.10.0](https://github.com/fastify/fastify/releases), is
the opposite trade. It gives routing, JSON-schema validation on every request
and reply, lifecycle hooks, and first-party plugins for rate limiting, cookies,
and CSRF, while sessions, RBAC, audit logging, and the ledger stay hand-written
and visible. It is also the engine NestJS itself can run on, so the choice
reads as taking the primitives without the ceremony.

[Hono](https://hono.dev/) (4.12.x) is the multi-runtime, edge-first option. For
a long-lived server with Postgres, server-side sessions, and webhook consumers,
edge portability buys nothing, and its server-side middleware ecosystem is
thinner than Fastify's.

On the runtime: [Node.js 24 is the current LTS line, supported until April
2028](https://endoflife.date/nodejs) (it moves from Active LTS to Maintenance
in October 2026). Bun 1.3 is credible for greenfield work but
[still has gaps around native addons](https://dev.to/alexcloudstar/bun-compatibility-in-2026-what-actually-works-what-does-not-and-when-to-switch-23eb),
and argon2 is exactly the kind of native dependency this project leans on. A
production-shaped repo runs the boring LTS runtime; state that in the README
and move on.

### Go, Python, Java

Go with chi is the strongest alternative and the code would read very well to a
senior reviewer: int64 minor units, `x/crypto/argon2`, explicit error handling,
one static binary. Go is current at [1.26.x](https://go.dev/doc/devel/release).
It loses on the top-weighted criterion, posting volume, and it forces a second
language for the front end, which splits a solo developer's effort.

FastAPI has real momentum (up 5 points year over year in the survey) but
remains [pre-1.0 at 0.139.0](https://github.com/fastapi/fastapi/releases), and
its type story rests on gradual Python typing plus Pydantic doing at runtime
what TypeScript does at compile time. Django 5.2 LTS is
[supported until April 2028](https://endoflife.date/django) but has the
opposite problem: `django.contrib.auth` already does most of what this project
exists to demonstrate, so hand-building beside it reads as fighting the
framework. [Spring Boot 4.1 is current](https://endoflife.date/spring-boot) and
enterprise demand for Java is durable, but the same objection applies with more
force: Spring Security is the reason to pick Spring, and this project needs to
build what Spring Security provides.

### Payments and auth primitives

Payments does not differentiate the candidates.
[Stripe maintains official server SDKs for Ruby, PHP, Java, Python, Node, .NET, and Go](https://docs.stripe.com/sdks/server-side),
and [Adyen covers the same set](https://docs.adyen.com/development-resources/libraries).
stripe-node ships full TypeScript types. Auth primitives on Node are mature:
[argon2](https://www.npmjs.com/package/argon2) binds the reference
implementation, [otplib](https://github.com/yeojz/otplib) implements RFC 6238
TOTP, and [openid-client](https://github.com/panva/openid-client) is an OpenID
Certified client for the OAuth login flows. Nothing has to be imported
wholesale from an auth framework, which is the point.

### Decision

TypeScript on Node.js 24 LTS with Fastify v5, strict tsconfig, schema
validation at every boundary. Accepted tradeoffs: Fastify's name recognition in
job ads is far below NestJS and Spring, so the market signal rides on
TypeScript and Node rather than the framework name; more wiring falls on the
author, which is deliberate here; and JavaScript number semantics demand
discipline for money, so the ledger stores BIGINT in Postgres and the app
treats minor units as integers checked against Number.MAX_SAFE_INTEGER at the
boundary, where Go's int64 would have made that free.

## Auth approach

The options come in three shapes: a managed provider (Auth0, Clerk, Supabase
Auth), a self-hosted IdP (Keycloak, Ory Kratos/Hydra), or auth built in-process
on maintained primitives, either through a framework like better-auth or
directly. For a product under deadline the managed provider usually wins. This
project has a different objective: the auth domain is half the portfolio, and
outsourcing it deletes the thing the repo is supposed to prove.

### Managed providers

[Auth0's free plan](https://auth0.com/pricing) covers 25,000 MAU but excludes
MFA and RBAC, two items on this project's required list; B2C Essentials starts
at $35/month. [Clerk](https://clerk.com/pricing) is free to 50,000 monthly
retained users (raised from 10,000 in
[February 2026](https://saasprices.net/blog/clerk-free-plan-changes)) with Pro
at $25/month, and its prebuilt components are the fastest path to shipped auth.
[Supabase Auth](https://supabase.com/pricing) includes 50,000 MAU on the free
plan but assumes the Supabase Postgres stack. All three fit the budget. None
fit the goal: a hiring manager reading a repo wired to Clerk middleware learns
that the author can follow vendor docs, and nothing about whether they
understand refresh rotation, revocation, or session fixation.

### Self-hosted IdPs

Keycloak is current at
[26.7.0, released July 2026](https://www.keycloak.org/2026/07/keycloak-2670-released),
and actively developed, but it is a JVM service that must run continuously,
which on a near-zero budget ties the demo to AWS credits. Its own Node.js
adapter, [keycloak-connect, is deprecated](https://www.npmjs.com/package/keycloak-connect);
the recommended path is openid-client, so a Fastify app writes OIDC
relying-party code either way. Ory Kratos is Apache-2 licensed and active
([v26.3.1 shipped July 2026](https://changelog.ory.com/announcements/ory-network-ory-hydra-ory-kratos-ory-polis-v26-3-1-released)),
headless, and the closest in philosophy, but covering the full feature list
means operating Kratos plus Hydra alongside the app. Both convert the auth work
from engineering the flows into operating someone else's implementation of
them. That is a real production skill, but it is the weaker signal here, and
the payments-authorization intersection stays custom code regardless.

### better-auth

[better-auth](https://github.com/better-auth/better-auth/releases) is the
current default for TypeScript teams that want auth in-process without writing
the flows: 1.6.23 is the latest stable (published late June 2026) with a 1.7.0
release candidate out the first week of July, and it has plugins for 2FA and
organizations. It is the fallback if the hand-rolled layer slips the schedule.
It is not the pick because it owns the session schema and the flow logic, so
the repo's interesting diff would again read as configuration.

### Building on primitives

The Lucia precedent frames the thesis: the maintainer
[deprecated Lucia v3 by March 2025](https://github.com/lucia-auth/lucia/discussions/1714)
and turned the project into a guide on implementing sessions from scratch,
arguing the flows are short and the abstraction cost exceeded the code it
saved. Every flow in scope is documented:
[OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
names argon2id as the first-choice hash, TOTP is RFC 6238, social login is
OAuth 2.0 authorization code with PKCE.

The red-flag line is precise. Red flag: inventing primitives, meaning your own
hash construction, your own token format, your own crypto, or passwords under
unsalted fast hashes. Green flag: composing maintained primitives into
documented flows. Concretely: [argon2](https://www.npmjs.com/package/argon2)
(node binding, v0.44.0; last release August 2025, a stable small-surface
library rather than a fast-moving one) for hashing, crypto.randomBytes for
opaque tokens with only hashes stored server-side,
[otplib](https://www.npmjs.com/package/otplib) (13.4.1, published May 2026) for
TOTP, and [openid-client](https://github.com/panva/openid-client) (6.8.4,
published April 2026, panva's certified OpenID RP library) for Google and
GitHub login. Arctic is the lighter alternative but has not published since May
2025, so openid-client is the safer dependency. Sessions are opaque server-side
records in Postgres, not stateless JWTs, which makes revocation and
active-session management plain queries instead of a blocklist workaround.
[@fastify/rate-limit](https://www.npmjs.com/package/@fastify/rate-limit)
(11.1.0, published June 2026) covers per-route limits; lockout and security
audit logging are ordinary tables and hooks.

Authorization: hand-rolled RBAC (roles and permissions in Postgres, checked in
a Fastify preHandler) covers the core, and the money rules (who may refund, who
may reconcile, amount ceilings) are where ABAC earns its evaluation.
[node-casbin](https://www.npmjs.com/package/casbin) (5.51.1, published June
2026) and [Cerbos](https://github.com/cerbos/cerbos) (Apache-2.0 PDP) are both
maintained; Cerbos as a sidecar is the right answer at team scale but adds a
service. The pick is a hand-rolled policy module of pure, tested decision
functions, with Cerbos named as the growth path.

### Decision

Hand-roll the auth layer on Fastify from the primitives above, with server-side
sessions, hand-rolled RBAC, and a small policy module for the payments rules.
CSRF and CORS policy belongs to this layer too, since no framework supplies a
default here: SameSite=Lax HttpOnly cookies, Origin validation on every
state-changing route, and a credentialed CORS allowlist, with the payment
webhook route exempt because it authenticates by signature instead of cookies
(details under "Cross-cutting decisions"). Document Auth0 as the deadline
answer and better-auth as the fallback.

## Payments: primary transaction API

The payments domain needs a provider whose sandbox can exercise the full
transaction lifecycle without real money: payment intents, declines, refunds,
disputes, and the webhook traffic that drives a double-entry ledger and a
reconciliation job. The integration also has to be one that a hiring manager
can evaluate on sight. Five candidates: Stripe, Adyen, PayPal (with Braintree),
Square, and Plaid.

### Stripe

Stripe's test environment covers every flow this project defines.
[Test card numbers](https://docs.stripe.com/testing) simulate declines, refund
failures, and disputes; card 4000000000000259 produces a charge that is
disputed, so the dispute handler and the ledger entries it writes can be tested
end to end. [Sandboxes](https://docs.stripe.com/sandboxes) are isolated copies
of the account with their own API keys, webhook endpoints, and data; an account
gets up to five, which cleanly separates development from the demo deployment.

Webhook tooling is the strongest of the group. Signatures arrive in the
Stripe-Signature header as t=timestamp,v1=hmac, and the SDKs
[reject events older than five minutes by default](https://docs.stripe.com/webhooks),
which is the replay protection this project must demonstrate. The CLI forwards
live sandbox events to localhost with
[stripe listen --forward-to](https://docs.stripe.com/cli/listen) and fabricates
real API objects with [stripe trigger](https://docs.stripe.com/stripe-cli/triggers),
including [charge.dispute.created](https://github.com/stripe/stripe-cli/wiki/Trigger-command:-Supported-events).
Events can be re-sent from the Dashboard or with stripe events resend, which is
exactly what a reconciliation job needs when testing missed-event recovery. For
reconciliation itself, webhooks are only the delivery channel: the record for
settled amounts and fees is
[Stripe's balance transactions](https://docs.stripe.com/reports/balance-transaction-types),
and that is what the daily job compares the ledger against.

[Idempotency keys](https://docs.stripe.com/api/idempotent_requests) are a
documented header on every POST: up to 255 characters, the stored response is
replayed on retry (including errors), and keys are pruned after at least 24
hours. That 24-hour window is short enough that the project's own idempotency
layer in the database still has a job to do, which is the right lesson to show.

Versioning is date plus release name. The current stable version is
[2026-06-24.dahlia](https://docs.stripe.com/changelog); Stripe ships monthly
dated releases and twice-yearly named releases that may contain
[breaking changes](https://docs.stripe.com/api/versioning), so the pinned
version gets re-checked at integration time rather than copied from this doc.
Pinning the version in code and recording the upgrade path is itself a
defensible decision to document.
[Test clocks](https://docs.stripe.com/billing/testing/test-clocks) simulate the
passage of time, but they act on Billing objects, so for a one-off payments
project they are a minor benefit rather than a selling point.

### Adyen

Adyen is credible infrastructure with HMAC-signed webhooks,
[test webhooks fired from the Customer Area](https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures)
with recalculated signatures, and
[idempotency keys valid for at least 7 days](https://docs.adyen.com/development-resources/api-idempotency),
longer than Stripe's window. Versioning is major-only, with
[Checkout v72 recommended for new integrations](https://www.adyen.com/the-latest/upgrade-to-checkout-v72-for-more-reliable-payment-flows).
What it lacks is a local-forwarding CLI (the workflow leans on the Customer
Area and a Postman collection) and the account onboarding is built for
enterprises. For a portfolio read by mostly US reviewers it carries less
recognition per hour invested.

### PayPal and Braintree

PayPal's sandbox supports
[negative testing](https://developer.paypal.com/tools/sandbox/negative-testing/)
through simulation headers and test values, including the Disputes API. Two
problems. Idempotency via
[PayPal-Request-Id](https://developer.paypal.com/api/rest/reference/idempotency/)
is documented per API, with Orders v2 storing the id for 6 hours by default and
72 only after talking to an account manager, which is a weak base for
demonstrating retry safety. And the webhook simulator emits
[mock events that cannot pass verification because they belong to no webhook subscription](https://dev.to/lightningdev123/setting-up-and-testing-paypal-webhooks-locally-without-guesswork-56c6),
so testing signature checks requires real sandbox transactions, and sandbox
delivery reliability has a
[documented history of complaints](https://hookdeck.com/webhooks/platforms/guide-to-paypal-webhooks-features-and-best-practices).
Braintree's sandbox handles
[instantly-disputed test cards and dispute webhooks](https://developer.paypal.com/braintree/docs/guides/disputes/testing-go-live/php)
well, but the developer experience centers on the Control Panel and its market
position is fading.

### Square

Square's sandbox can
[trigger disputes with specific charge amounts and resolve them by submitting evidence named evidence_won or evidence_lost](https://developer.squareup.com/docs/disputes-api/sandbox-testing).
The catch: sandbox disputes are not visible in the Developer Console or the
Square Dashboard, and the
[sandbox dashboard is a limited subset](https://developer.squareup.com/docs/devtools/sandbox/overview)
where refunds can be viewed but not issued. Workable, but the ecosystem and the
signal are smaller.

### Plaid

Plaid is bank-rail infrastructure, not a card processor.
[Transfer's sandbox](https://plaid.com/docs/transfer/sandbox/) has simulation
endpoints and a test clock, but ACH means returns instead of card disputes and
no intent-shaped flow. It is a plausible later addition for account funding,
not a primary.

### Decision

Stripe, using the PaymentIntents API pinned to the current stable version
(2026-06-24.dahlia at the time of writing), one sandbox for development and one
for the demo, with the CLI driving local webhook work. The integration is the
most legible to reviewers, and its test surface is the only one that exercises
disputes, refund failures, and replayed webhooks without friction. Accepted
tradeoffs: Stripe is the default choice, so the differentiation must come from
the ledger and reconciliation depth, not the provider; the twice-yearly
breaking releases make version pinning mandatory; test mode diverges from
production on async behavior (most test-card refunds settle instantly); and
Stripe event shapes will leak into the ledger unless mapped through an internal
event model, which the design treats as a requirement (see "Webhook event
inbox" below).

## Database

### Postgres, justified

The presumed default holds, and the ledger is the workload that decides it.
Double-entry rows in integer minor units need 64-bit integer arithmetic, CHECK
constraints, foreign keys, and a commit-time guarantee that each journal
entry's debits equal its credits. Postgres enforces all of that inside the
database: a deferrable constraint trigger for the balance invariant, REVOKE
UPDATE/DELETE plus a guard trigger for append-only tables, and transactional
DDL so a failed migration rolls back instead of leaving half a schema. The
other stores in this app (auth sessions, security audit log, webhook events)
are plain relational tables and give no reason to add a second engine; a unique
index on the provider's event id is the webhook replay defense, and the audit
log is an insert-only table with a JSONB detail column. A document store cannot
enforce the ledger invariants, and SQLite would run the code but reads as a toy
under a payments project. Postgres is also the job-market answer:
[55.6% usage and the most admired database in the Stack Overflow 2025 survey](https://survey.stackoverflow.co/2025/technology).
Current release is
[Postgres 18, shipped 2025-09-25](https://www.postgresql.org/about/news/postgresql-18-released-3142/),
at [minor 18.4 as of May 2026](https://www.postgresql.org/about/news/postgresql-184-1710-1614-1518-and-1423-released-3297/);
its uuidv7() function gives index-friendly primary keys on the hot append-only
tables. Pin the compose image to the newest major that RDS offers (expected
to be 18; confirming this is an acceptance item for project setup).

### What the ledger forces on the schema and the tooling

Amounts are BIGINT minor units with an ISO 4217 currency column, never floats
or decimal strings. Append-only is enforced by the database, not the
application: the app role gets INSERT and SELECT on ledger and audit tables,
and corrections are reversing entries. One wire-format detail drives the
query-layer choice: int8 exceeds what a JS number holds above 2^53, so
[node-postgres returns bigint columns as strings by default](https://github.com/brianc/node-pg-types),
and the layer above must surface that decision instead of coercing silently.
The grants, triggers, and deferrable constraints are not expressible in
Prisma's schema language or Drizzle's TypeScript schema; whichever tool wins,
the interesting DDL lives in hand-written SQL migrations.

### Query layer: Prisma, Drizzle, Kysely, raw pg

[Prisma 7 shipped 2025-11-19 and replaced the Rust query engine with a TypeScript query compiler](https://www.infoq.com/news/2026/01/prisma-7-performance/);
the [latest release is 7.8.0](https://registry.npmjs.org/prisma/latest). It has
the strongest brand recognition in job posts and the heaviest abstraction.
Prisma Migrate diffs its own DSL, so the trigger and grant DDL sits in edited
migration SQL the DSL cannot see, and every later diff must be checked against
it. The client also hides SQL, the opposite of the signal this project wants.
Drizzle's [stable npm channel is 0.45.2 while v1.0 sits at release candidate](https://registry.npmjs.org/drizzle-orm)
(rc.1 landed 2026-04-30,
[v1 reworks the relational query API and casing rules](https://orm.drizzle.team/roadmap)),
so adopting it now means either an aging 0.x line or rc churn. It is the
runner-up: SQL-flavored, generates SQL migrations, accepts custom SQL files.
[Kysely 0.29.3](https://registry.npmjs.org/kysely/latest) is a type-safe SQL
builder with no schema DSL and no runtime engine; paired with
[kysely-codegen 0.20.0](https://registry.npmjs.org/kysely-codegen/latest) it
derives types from the live database, which makes the hand-written DDL the
single source of truth. Raw [pg 8.22.0](https://registry.npmjs.org/pg/latest)
([31.5M weekly downloads](https://api.npmjs.org/downloads/point/last-week/pg),
the driver everything above sits on) gives full control but loses compile-time
checking across refactors.

Pick Kysely over pg, with raw SQL through pg for the few reconciliation CTEs
where a builder obstructs. Queries stay recognizable as SQL to a reviewer,
types come from the real schema, and there is no ORM layer to explain away in
an interview. In the Go runner-up stack the equivalent choice would be sqlc
over pgx; the reasoning ports directly.

### Migrations

SQL-first: numbered .sql files run by
[node-pg-migrate](https://github.com/salsita/node-pg-migrate/releases), stable
at 8.0.4. Its development is quiet (the last stable landed December 2024 and
the v9 alpha line has stalled), which is acceptable for a small tool whose job
is running SQL files in order; Kysely's built-in Migrator (TypeScript up/down
files) is the fallback if the dependency ever becomes a liability. Plain SQL
files are easier to review in a repo meant to be read. Regenerate
kysely-codegen types after each migration and commit them; CI enforces this
(see CI/CD).

### Pooling and hosting

Fastify v5 on Node 24 runs as one long-lived process, so an in-process pg.Pool
with a small max is enough; an external pooler matters when many processes or
serverless functions multiply connections, or when the host caps
max_connections low. Local dev runs Postgres 18 in Docker Compose (see local
development); the on-demand test environment uses RDS Postgres, where the same
pg.Pool needs no external pooler at this scale. The standing-demo alternative
would sit on
[Neon's free plan (100 CU-hours/month, 0.5 GB storage, mandatory scale-to-zero)](https://neon.com/docs/introduction/plans),
which [bundles PgBouncer in transaction mode behind its -pooler hostname](https://neon.com/docs/connect/connection-pooling)
and imposes pooled-vs-direct URL discipline plus sleep-friendly access
patterns; that analysis lives with the production section and only matters if
that target returns.

## Frontend

The backend decision (TypeScript on Node 24, Fastify v5) fixes the shape of
this choice. The API is a standalone server that owns sessions, OAuth
callbacks, RBAC, and the ledger. The frontend question is therefore not "which
metaframework" but "does a second server belong between the browser and that
API at all". The auth flow is the deciding concern: where the session check
runs, how cookies and CSRF behave under SSR, and how OAuth redirects land when
the API is a separate origin.

### Next.js (App Router)

Current release is [16.2.10 on the Next 16 LTS line](https://endoflife.date/nextjs),
with Next 15 security support ending October 21, 2026. Next assumes it is your
backend. Pointed at a separate Fastify API, it becomes a BFF: every
server-rendered fetch must forward the session cookie to Fastify, authed
responses must be excluded from Next's caching layers, and the session check
ends up split between the API (enforcement) and the Next server (redirects).
That split is where Next got burned:
[CVE-2025-29927](https://nvd.nist.gov/vuln/detail/CVE-2025-29927), a CVSS 9.1
authorization bypass patched in March 2025, let a spoofed
`x-middleware-subrequest` header skip middleware auth checks on self-hosted
deployments. It is historical now, and Next 16 has since
[renamed middleware.ts to proxy.ts](https://nextjs.org/docs/messages/middleware-to-proxy)
partly to make its advisory, network-boundary role explicit, but it
illustrates exactly the class of confusion a split session check invites. The
conclusion for this project: with Next you operate a second server whose auth
logic must not be trusted anyway, and you pay for it in cookie forwarding,
cache discipline, and a second deployment. That is scope taken from the
backend, which is the point of the portfolio.

### React Router framework mode

The comparison started at v7;
[v8 shipped June 17, 2026](https://remix.run/blog/react-router-v8) as a small
major (ESM-only, Node 22.22+, React 19.2.7+, Vite 7+), and the same post
declares React Router v6 and Remix v2 end-of-life while Remix 3 continues as an
unrelated zero-dependency framework. The loader/action model with cookie
sessions is cleaner than Next's caching story, and framework mode remains
supported in v8. The structural problem is identical though: loaders run on a
React Router server that proxies authed calls to Fastify, so the BFF tax
applies. The Remix to RR7 to RR8 lineage also costs recognition; a reviewer has
to know the history to credit it.

### SvelteKit

Latest is [2.69.2 on npm](https://www.npmjs.com/package/@sveltejs/kit),
actively developed. Its server integration is the best designed of the three:
hooks.server.ts gives one place to resolve the session, and cross-origin form
posts are rejected by default. If the backend were SvelteKit too, this would be
a real contender. Against a separate Fastify API it is again a BFF, and it
swaps React out of the stack: the
[Stack Overflow 2025 survey](https://survey.stackoverflow.co/2025/technology)
has Svelte at 7.2% usage versus React at 44.7%. For a portfolio read against
typical job postings, that narrows the audience without reducing the work.

### Plain SPA: Vite, React, TanStack Router, TanStack Query

No frontend server. Fastify issues an HttpOnly, SameSite=Lax session cookie at
login and at the OAuth callback (the provider redirects to the API, which sets
the cookie and 302s back to the app), so the session check runs in exactly one
place. CSRF is the API's problem and is specified there; there are no
server-rendered forms to protect and no SSR cache to poison. TanStack Router
(currently [1.170.17](https://github.com/TanStack/router/releases)) gives typed
routes and beforeLoad guards for redirect-to-login and role-gated views,
treated as UX only since the API enforces. TanStack Query handles retries,
401-driven refresh, and cache invalidation after refunds and reconciliation
runs, which maps directly onto the payment domain. TanStack Start, the SSR
layer, is [still a release candidate](https://tanstack.com/start/latest), but
the SPA path uses only stable packages. The app deploys as static files from
S3 behind CloudFront in the test environment.

### Decision

Plain SPA with Vite, React, TanStack Router, and TanStack Query, with cookie
sessions issued by Fastify and no BFF. It keeps a single auth enforcement
point, keeps the complexity budget on the backend where this portfolio spends
it, and still shows the highest-demand frontend skill set (React at 44.7%
versus Next.js at 20.8% in the same survey). Skipping a metaframework is itself
a defensible written decision; an SSR layer in front of an API-owned session
would be architecture theater here. The one requirement it imposes is same-site
topology: the SPA and the API must share an origin, or at least sibling
subdomains of one registrable domain, so the session cookie flows without
third-party cookie problems. That requirement is resolved by the single-origin
CloudFront topology under "Cross-cutting decisions".

## Local development

The local story has one target: a fresh clone runs `docker compose up` plus one
make target and gets a working system with users, roles, payments, webhooks,
and email, without touching any dashboard. Parity matters most for the parts
that behave differently in production (Postgres, webhook signatures, SMTP);
iteration speed matters most for the app process itself. The setup splits along
that line.

### What runs in containers vs on the host

Stateful and protocol-shaped dependencies run under Docker Compose: PostgreSQL
18 (current major, at minor
[18.4 as of May 2026](https://www.postgresql.org/about/news/postgresql-184-1710-1614-1518-and-1423-released-3297/);
19 is in beta and the next quarterly minor is due around August, so the exact
pin gets set at scaffold time), Mailpit for SMTP, and the Stripe CLI as a
long-running webhook listener. The app process runs on the host with its native
hot reload and debugger. This hybrid is what most working teams do: no
file-sync layer in the edit-run loop, and attaching a debugger is a plain local
operation.

The full-container alternative is
[Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)
(`develop.watch` with sync and rebuild actions), which requires Compose 2.22 or
later and is long past experimental; current Compose is
[v5.3.1, released July 7, 2026](https://github.com/docker/compose/releases). It
works, but it inserts a sync step into every edit and complicates debugger
attach for no local gain, since prod parity of the app image is already proven
by CI building and running the same Dockerfile. Keep a
`docker compose --profile full up` variant that runs the app container for
smoke-testing the image; skip watch as the daily loop.

One wrinkle from the split: containers that must reach the host app (the
webhook forwarder) target `host.docker.internal`, which on Linux needs
`extra_hosts: ["host.docker.internal:host-gateway"]` in the service definition.

### Webhook forwarding

The Stripe CLI runs as a compose service using the official
[`stripe/stripe-cli` image](https://docs.stripe.com/stripe-cli/install).
[`stripe listen --forward-to host.docker.internal:8000/webhooks/stripe`](https://docs.stripe.com/cli/listen)
streams sandbox events to the local endpoint and prints a `whsec_` signing
secret, so the local handler verifies real signatures instead of stubbing
verification. [`stripe trigger`](https://docs.stripe.com/stripe-cli/use-cli)
generates payment_intent, refund, and dispute events on demand. The CLI is
actively maintained ([v1.43.7, July 9, 2026](https://github.com/stripe/stripe-cli/releases)).

No mainstream alternative provider ships an equivalent; PayPal, Adyen, and
Braintree webhooks reach localhost only through a public tunnel. If that path
is ever needed, a
[Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
is free, needs no account, and hands out a random trycloudflare.com URL per
run; [ngrok's free plan](https://ngrok.com/docs/pricing-limits/free-plan-limits)
keeps a persistent dev domain but caps at 1 GB and 20,000 HTTP requests per
month and shows an interstitial page. Document the tunnel option in the README
and do not build on it: tunnels expose a dev machine and quick-tunnel URLs
churn on every restart.

### Local email

Mailpit is the email catcher: SMTP on 1025, web UI and REST API on 8025. It is
the maintained drop-in for MailHog with the same default ports;
[MailHog's last release was v1.0.1 in August 2020](https://github.com/mailhog/MailHog),
while Mailpit shipped
[v1.30.4 on July 9, 2026](https://github.com/axllent/mailpit/releases),
including security fixes. The REST API is the real win: integration tests for
email verification and password reset fetch the message and extract the token
through it, so those flows get asserted end to end without a mail provider
account.

### Env and secrets conventions

A committed `.env.example` lists every variable with a comment and a safe
default; the git-ignored `.env` holds real values;
[direnv](https://github.com/direnv/direnv/releases) (v2.37.1, the latest
release, from mid-2025; the project moves slowly) exports that same `.env` into
the host shell so the host-run app and the compose services read identical
config. Compose interpolates `${VAR}` from the same file, leaving exactly one
place a value can be wrong.

[Compose file secrets](https://docs.docker.com/compose/how-tos/use-secrets/)
(mounted at `/run/secrets/`) are the right pattern when a real secret exists,
but local dev holds only Stripe sandbox keys, Mailpit needs no credentials, and
the host-run app would not see the mounts anyway. Skip them locally and state
in the doc that production uses the platform secret store. Two guards carry the
production signal instead: startup refuses to boot in non-production if the
Stripe key does not start with `sk_test_`, and `.env` is git-ignored from the
first commit.

### Seed data

Seeding is an explicit, idempotent command (`make seed`, wrapping a one-off
compose run), not an entrypoint side effect, so wiping a volume and re-seeding
stay separate deliberate steps. The seed creates one user per role (admin,
support, customer, auditor) with fixed UUIDs so manual testing and docs
reference the same records, the chart of ledger accounts, and a handful of
completed and refunded sandbox payments so reconciliation has data on first
boot. Provider-side state comes from `stripe trigger` rather than hand-created
dashboard objects, which keeps the whole scenario reproducible from the repo
alone.

## Production deployment

The app needs four things in production shape: an HTTPS endpoint that can
accept payment-provider webhooks while the environment is up, Postgres, a
scheduled reconciliation job, and secrets kept out of the repo.

The section below compares the free-tier platforms under the original goal of
a standing public demo that outlives the AWS credits. That goal was dropped
(personal project, on-demand testing only), which flips the platform question
from "who stays awake free" to "what runs cleanly on credits and tears down to
zero". The comparison is kept because it is the record of why the standing
demo would cost about $4/month if ever wanted, and because two of its findings
(the Public Suffix List cookie problem and the workerd argon2 blocker) still
shape the design.

### The field, under the standing-demo goal

[Render's free tier](https://render.com/docs/free) spins web services down
after 15 minutes idle, restarts take about a minute, free Postgres expires 30
days after creation (14-day grace, then deletion), and
[cron jobs have no free instance type](https://render.com/docs/cronjobs)
(they bill at a $1/month minimum). That is three strikes for this project. Paid
Render works fine but costs about
[$7 for a Starter service plus $6-7 for the smallest Postgres](https://kuberns.com/blogs/render-pricing/),
the most expensive of the small-PaaS options here.

[Railway](https://docs.railway.com/pricing/plans) gives a one-time $5 trial
credit, then the Hobby plan is $5/month with $5 of usage included. It is a good
product and a defensible pick, but an always-on API plus an always-on Postgres
tends to burn past the included credit, and Railway-hosted Postgres is less
interesting on a resume than a dedicated Postgres provider.

[Vercel's Hobby plan](https://vercel.com/docs/plans/hobby) is free and generous
for functions, but it is restricted to non-commercial personal use,
[cron runs at most once per day](https://vercel.com/docs/cron-jobs/usage-and-pricing),
and a functions-only API pushes rate-limit counters and session state into
external stores earlier than this project wants. Fine for the frontend, wrong
shape for this API.

[Supabase's free plan](https://supabase.com/pricing) pauses projects after one
week of inactivity, which is fatal for a portfolio opened weeks after the last
commit. Its bundled auth also blurs the project's central claim of having built
auth by hand. Pro at $25/month is out of budget.

[Cloudflare Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)
allows 100k requests/day with cron triggers included, and the Paid plan is
$5/month minimum with 10M requests and 30M CPU-ms;
[Containers](https://developers.cloudflare.com/containers/pricing/) ride on
that plan with 25 GiB-hours of memory and 375 vCPU-minutes included. The
blocker is the workerd runtime: native addons such as argon2 do not run there,
which is a poor fit for a password-hashing-heavy auth service. Cloudflare stays
in the picture for static frontend hosting, where
[Pages](https://developers.cloudflare.com/pages/platform/limits/) gives 500
builds/month free.

[Fly.io has no free tier](https://fly.io/docs/about/pricing/); the smallest
always-on machine (shared-cpu-1x, 256 MB) runs $1.94 to $3.14 per month
depending on region, with extra RAM near $5/GB per 30 days. In exchange you get
a real container on a real VM with automatic TLS, `fly secrets` for runtime
secrets, health checks, and scheduled Machines that bill only while running.

[Neon's Free plan](https://neon.com/docs/introduction/plans) gives 100
CU-hours/month and 0.5 GB storage per project with scale-to-zero after 5
minutes. The paid Launch tier is pure usage: $0.106/CU-hour and $0.35/GB-month,
so the upgrade path has no cliff.

### Decision: an on-demand AWS environment, no domain purchase

The test environment runs entirely on AWS credits and is stood up and torn
down by the deploy pipeline. Two verified constraints fix its shape.

First, AWS App Runner, the obvious "container with a free HTTPS URL" answer,
[closed to new customers on April 30, 2026](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html);
AWS points new workloads at ECS instead. So the API runs as one ECS Fargate
task behind an ALB.

Second, an ALB alone cannot serve valid HTTPS without a purchased domain:
[ACM refuses certificates for Amazon-owned names such as elb.amazonaws.com](https://docs.aws.amazon.com/acm/latest/userguide/troubleshooting-cert-requests.html).
CloudFront closes that gap: a distribution's default `*.cloudfront.net`
hostname
[carries an AWS-provided TLS certificate at no charge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-viewers-to-cloudfront.html),
and [per-path cache behaviors](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html)
route `/api/*` (all HTTP methods, caching disabled) to the ALB origin while
the default behavior serves the SPA from S3.
[CloudFront's free plan covers 1M requests and 100 GB/month](https://aws.amazon.com/cloudfront/pricing/).
The browser therefore sees a single origin: session cookies are first-party,
SameSite=Lax works untouched, and no CORS configuration exists to get wrong.
[Stripe requires webhook endpoints to be public HTTPS URLs](https://docs.stripe.com/webhooks)
and has no domain-ownership requirement, so the `cloudfront.net` URL is a
valid webhook target.

One accepted weakness, stated rather than hidden: the CloudFront-to-ALB leg
runs plain HTTP because the ALB cannot present a valid certificate on its
default name. For a test environment this is tolerable with two mitigations
(ALB ingress restricted to CloudFront's managed prefix list, and a
CloudFront-injected origin header verified by the app); the first move of any
real deployment is a domain plus an ACM certificate, which removes the
weakness and costs about $12/year.

The rest of the environment: RDS Postgres, Secrets Manager for runtime
secrets, EventBridge Scheduler
[firing an ECS RunTask](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html)
for the daily reconciliation while the environment exists, and CloudWatch for
logs. Rough monthly cost without credits, single-AZ, tasks in public subnets
to avoid a NAT gateway: one ARM Fargate task at 0.5 vCPU/1 GB is about $14 at
[$0.04048/vCPU-hr and $0.004445/GB-hr less the 20% ARM discount](https://aws.amazon.com/fargate/pricing/);
the ALB roughly $20 with LCUs;
[db.t4g.micro at $0.016/hr](https://instances.vantage.sh/aws/rds/db.t4g.micro)
plus 20 GB gp3 about $15;
[Secrets Manager at $0.40/secret/month](https://aws.amazon.com/secrets-manager/pricing/)
under $2; CloudFront $0 on the free plan. Total near $50-55/month while up,
covered by credits, and close to zero torn down (ECR images and the S3 bucket
cost pennies).
[Aurora Serverless v2 can pause at 0 ACUs](https://aws.amazon.com/blogs/database/introducing-scaling-to-0-capacity-with-amazon-aurora-serverless-v2/)
at $0.12/ACU-hour, but resume latency makes it a poor webhook target; take the
fixed-price micro instance.

### The standing-demo alternative, if the goal returns

API on Fly.io (smallest always-on machine, $1.94 to $3.14/month by region),
Postgres on Neon Free (with the app designed to let scale-to-zero work),
frontend on Cloudflare Pages, one purchased domain for same-site cookies and
email sending. About $4/month plus $10-12/year, indefinitely. Nothing in the
application code differs between the two targets except configuration; the
deploy pipeline isolates the platform in one job.

### What changes at real scale

The architecture holds; the tiers change. RDS goes multi-AZ, the single
Fargate task becomes a service with several tasks and target tracking, a
domain and ACM certificate replace the default CloudFront hostname, rate
limiting and session revocation move from in-process plus Postgres to a
managed Redis, a WAF goes in front, and reconciliation gets a dead-letter
queue and alerting instead of a log line.

## Observability

The project needs four things: structured logs, distributed traces, error
tracking, and health checks. The bar is production-shaped, not
production-scaled: a reviewer should see request-scoped correlation IDs, trace
context in logs, verified free-tier backends, and correct probe semantics,
without the repo dragging around a self-hosted metrics stack that a solo demo
cannot justify.

### Structured logging

Use [pino](https://www.npmjs.com/package/pino) (10.3.1 on npm) with pino-http
for request logging. It writes one JSON object per line to stdout, which is
what every log shipper and platform log drain expects, and it is the default
logger in Fastify, so the choice costs nothing.

Log shape conventions, enforced from the first commit: fixed keys `level`,
`time`, `msg`, `service`, `env`, plus `req_id` on every request-scoped line and
`user_id` once authenticated. Accept an inbound `X-Request-Id` header or
generate one, hold it in AsyncLocalStorage so deep call sites log it without
threading parameters, and echo it in the response header so a bug report can be
matched to its log lines. Webhook handlers also log the provider's event id.
Configure pino's `redact` option for authorization headers, cookies, and token
fields; a payments project that leaks credentials into logs fails review on the
spot. Pretty printing (pino-pretty) is a dev dependency only. The security
audit log from the identity domain is a database table with its own retention
rules, not log lines; app logs carry the audit event id as a reference.

Logs need a destination too: in the AWS test environment, ECS ships container
stdout to CloudWatch Logs natively, so a failed reconciliation task leaves
something to read after the task is gone. Local dev reads stdout directly,
prettified.

### Tracing

OpenTelemetry for JavaScript has
[traces and metrics stable, with logs still in development](https://opentelemetry.io/docs/languages/js/);
the core SDK packages are on a stable 2.x line while the `sdk-node`
metapackage and OTLP exporters ship from the experimental release train, which
is the normal state of OTel JS and fine to build on. Instrument the HTTP
server, Postgres, and outbound calls to the payment provider with the contrib
auto-instrumentations, then add manual spans where the domains intersect:
webhook signature verification, ledger posting, reconciliation runs, and
authorization decisions, with attributes for payment intent id, idempotency
key, and the authz verdict. The pino instrumentation injects `trace_id` into
every log line, which is the correlation story reviewers look for.

For backends: the primary trace store is
[Jaeger v2](https://www.jaegertracing.io/download/) all-in-one in the existing
docker compose file; v1 reached end of life on 2025-12-31 and v2 (2.19.0 at
the time of checking; it releases roughly monthly) is a distribution of the
OTel Collector, so using it also signals current knowledge. Since the deployed
environment is ephemeral, a managed trace backend is optional rather than
load-bearing; if one is wanted while the environment is up,
[Grafana Cloud's free tier](https://grafana.com/pricing/) (50 GB traces, 50 GB
logs, 10k active metric series per month, 14-day retention) takes OTLP with no
vendor lock, and beats
[Honeycomb's free plan](https://www.honeycomb.io/pricing) (20M events/month,
[60-day retention](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage))
and [Axiom](https://axiom.co/pricing) (500 GB/month, 30-day retention) by
holding all three signals in one account, correlated by trace id.

### Error tracking

Use [Sentry's free Developer plan](https://sentry.io/pricing/): 5k
errors/month, 1 user, 30-day lookback, 5M spans. The 1-user cap matches a solo
project and 5k errors/month is far above demo traffic. Run Sentry for errors
and release tagging only, with its tracing sample rate at zero, so
OpenTelemetry stays the single tracing pipeline.
[GlitchTip](https://glitchtip.com/blog) is the self-hosted fallback: actively
maintained (6.2 shipped 2026-06-22 with OTel support), speaks the Sentry SDK
wire protocol, and runs in docker compose. It stays a fallback because
self-hosting an error tracker adds a service to operate and back up while
demonstrating nothing the Sentry integration does not; if Sentry's free limits
change, the migration is a DSN swap.

### Health checks

Two endpoints with the split Kubernetes defines for
[liveness and readiness probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/),
which every deploy platform's health-check URL maps onto. `/healthz` (liveness)
answers only "is this process able to make progress": it checks nothing
external, because a liveness probe that touches the database turns a DB outage
into a restart loop. `/readyz` (readiness) answers "should this instance
receive traffic": a `SELECT 1` on the connection pool and a check that
migrations are applied. It deliberately excludes the payment provider's API; a
provider outage should degrade payment endpoints (surfaced by error rates and
traces), not pull the whole app out of rotation. Both return JSON with
per-check status and 200 or 503; the ALB target group points at `/readyz`.

Deliberately out of scope: self-hosted Loki/Tempo/Mimir, alerting and on-call
tooling, and dashboard sprawl. One Grafana dashboard (request rate, latency,
error rate, webhook processing lag) is the ceiling.

## CI/CD

The CI platform decision is not close. The repo lives on GitHub, and Actions is
[free for public repositories on standard GitHub-hosted runners](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions),
with [20 concurrent jobs on the Free plan, a 6 hour per-job cap, and 10 GB of cache per repository](https://docs.github.com/en/actions/reference/limits).
This pipeline gets nowhere near those limits. CircleCI or Buildkite would add
an account and a token for no signal a reviewer cares about, and on a public
repo the workflow files are themselves part of the portfolio.

### Workflow structure

Two workflows. `ci.yml` runs on every pull request and on push to `main` with
parallel jobs plus a fan-in:

- `lint` and `typecheck`, each restoring the package cache via
  `actions/setup-node` keyed on the lockfile.
- `test`: unit and integration tests with Postgres as a service container and
  the payment provider mocked at the HTTP boundary. No live provider calls on
  PRs.
- `types-in-sync`: runs migrations against a scratch Postgres, regenerates
  kysely-codegen types, and fails on a non-empty git diff, so schema and types
  cannot drift silently.
- `build`: compile plus `docker build`, with BuildKit layer cache on the GHA
  cache backend (`cache-from`/`cache-to: type=gha`), inside the 10 GB repo
  cache budget. The job boots the built image and runs one argon2 hash as a
  smoke test, because native modules are exactly what breaks between a
  host-run dev loop and a container image.
- `gitleaks` and `osv-scanner` (below).

All are required status checks in a ruleset;
[rulesets with required status checks are free on public repositories](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
so a red check blocks merge.

`deploy.yml` is dispatched manually (workflow_dispatch) to stand up, update,
or tear down the on-demand environment: `e2e`, then the chosen action,
serialized with a `concurrency` group. E2e runs against a composed stack
inside the runner (the built app image, Postgres, and the Stripe CLI
forwarding real sandbox events) and therefore needs real test-mode keys, which
forces the placement:
[secrets are not passed to workflows triggered from a forked repository](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions),
so e2e on fork PRs cannot work even if we wanted it. A nightly scheduled run
of the same e2e suite catches provider-side drift without needing any deployed
environment.

### Migrations relative to deploy

Migrations run inside the deploy job, before new code takes traffic: a one-off
ECS task with the same image, and the deploy aborts if it fails. (The Fly
equivalent, `release_command` in `fly.toml`, applies only if the standing-demo
target ever exists.) Migrations follow expand/contract so the previous release
keeps working against the new schema during rollout; the rule is documented
next to the migration tooling. No automatic down-migrations in CI; rollback is
redeploying the prior image against the already-expanded schema. The brief
single-machine cutover window is covered by Stripe's webhook retries landing in
an idempotent handler (see "Webhook event inbox").

### Secret scanning: push protection plus gitleaks

Two layers. First, enable repository-level secret scanning and push protection
in settings.
[User-level push protection is on by default for pushes to public repos, but it does not generate alerts on bypass unless repo-level push protection is also enabled](https://docs.github.com/en/code-security/concepts/secret-security/push-protection),
and the bypass audit trail is the point. Second,
[gitleaks-action v3](https://github.com/gitleaks/gitleaks-action) as a required
CI check with custom rules for the things GitHub's detectors do not know about,
such as our webhook signing secrets. Version matters: v3 (released 2026-05-30)
runs on Node 24; v2 stops working entirely on 2026-09-16 when Node 20 leaves
GitHub-hosted runners. No license key is needed on a personal account.
Trufflehog is the credible alternative; its differentiator is live verification
of candidate credentials, which means CI making outbound calls with strings
that might be secrets. On top of push protection that is more machinery than
the repo needs, so one scanner, gitleaks.

### Dependency auditing: Dependabot plus osv-scanner, no npm audit gate

[Dependabot version updates with grouped updates](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/controlling-dependencies-updated#groups)
run weekly so one person is not triaging fifteen PRs every Monday, with
Dependabot security alerts on. In CI, the
[osv-scanner reusable workflow in PR-diff mode reports only vulnerabilities newly introduced by the PR](https://google.github.io/osv-scanner/github-action/),
which is the property that makes it safe as a merge blocker: it avoids the npm
audit failure mode where one unfixable transitive advisory turns every open PR
red. A weekly scheduled full scan covers pre-existing findings. `npm audit`
adds nothing on top of this against the same advisory data and is skipped as a
gate.

### Deploy job, platform-agnostic

The platform decision is isolated in one step of one job. Primary path is AWS:
[OIDC role assumption via `aws-actions/configure-aws-credentials` with `id-token: write`, which removes the need for stored IAM access keys](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services).
The Fly path
([`superfly/flyctl-actions` with `flyctl deploy --remote-only` and an app-scoped deploy token](https://fly.io/docs/launch/continuous-deployment-with-github-actions/))
is documented for the standing-demo alternative. Either way the job interface
is the same: image in, migration step, traffic cutover. Workflow hygiene throughout: top-level `permissions: contents: read`,
third-party actions pinned to commit SHAs.

### Accepted tradeoffs

E2e regressions are caught on main, not on the PR; deploy gates on e2e, so a
broken main cannot ship, but it can go red. gitleaks-action is EULA-licensed
rather than OSI open source and would need a (free) license key if the repo
moved into an org. osv-scanner diff mode lets pre-existing vulnerabilities
merge silently between scheduled scans. And the pipeline is fully coupled to
GitHub, which is the correct trade for a public portfolio repo.

## Transactional email

The identity domain sends email verification links, password reset links, MFA
enrollment notices, and security alerts (new-device login, account lockout).
Volume is small: a portfolio deployment sends tens of messages on a busy demo
day. The decision is about free-tier fit today, deliverability, API shape, and
how cleanly the provider stays out of the local development loop. Six providers
were compared: Resend, Postmark, SendGrid, Mailgun, Amazon SES, and Brevo.

SendGrid drops out first. Twilio
[retired the free plan effective May 27, 2025](https://www.twilio.com/en-us/changelog/sendgrid-free-plan);
there has been no free API tier for over a year, and recommending it in 2026
would read as a stale tutorial habit, which is the exact signal this project is
trying to avoid.

Mailgun's [free plan allows 100 emails per day with one custom sending domain](https://www.mailgun.com/pricing/).
That covers the volume, but it offers no advantage here over the
transactional-first options and was eliminated on that basis.

Brevo has the largest free quota:
[up to 300 emails per day once the account is approved for sending](https://www.brevo.com/pricing/).
The quota is shared between marketing and transactional mail, sending starts
only after a manual account review, and the product is a marketing suite with
an API attached. Nothing disqualifying, but for a repo meant to be read by
engineers it is the weakest API-first story in the group.

Postmark has the strongest deliverability reputation in the transactional
niche. Its
[developer plan is free at 100 emails per month and never expires; the Basic plan is $15/month for 10,000 emails](https://postmarkapp.com/pricing).
The 100-per-month cap is the problem: one afternoon of demo signups, each
triggering a verification mail plus a security notification, exhausts it, and
the next step is a paid plan.

Amazon SES is the cheapest at scale:
[$0.10 per 1,000 outbound emails, with up to 3,000 message charges free per month for the first 12 months on new accounts](https://aws.amazon.com/ses/pricing/),
and the existing AWS credits would cover the demo regardless. The friction is
operational. New accounts sit in a
[sandbox that only delivers to verified addresses, capped at 200 messages per 24 hours, until a manual production-access review passes](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html),
and SES leaves bounce and complaint handling for you to assemble from SNS
notifications. That is genuine production work, but it spends effort on a third
domain when the two chosen ones already carry the signal.

Resend's
[free tier is 3,000 emails per month, capped at 100 per day, with one verified domain and webhooks included; the Pro plan is $20/month for 50,000](https://resend.com/pricing).
The API is transactional-first with
[official SDKs for the mainstream backend languages](https://resend.com/docs/introduction),
and its webhook events for delivered, bounced, and complained mail map directly
onto the signed-webhook and audit-log patterns this project already builds for
payments. It also has the best test story of the group:
[documented test recipients such as delivered@resend.dev and bounced@resend.dev simulate delivery outcomes without damaging domain reputation](https://resend.com/docs/dashboard/emails/send-test-emails).

The comparison above was run under the standing-public-demo goal, where
Resend won on free-tier fit and test story. Dropping that goal changes the
constraint that decides: every provider requires a verified domain before
delivering to arbitrary recipients, and this project now buys no domain. That
leaves SES as the working choice, because it is the one provider where an
[email address alone can be verified as a sending identity, with no DNS or DKIM setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html),
and its sandbox restrictions (delivery only to verified addresses, 200
messages per 24 hours) describe a personal test environment exactly. The
[mailbox simulator addresses](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
exercise bounce and complaint paths without reputation risk, and the AWS
credits cover the negligible cost.

Recommendation: a narrow mailer interface with two drivers. Development and
CI use SMTP pointed at
[Mailpit](https://github.com/axllent/mailpit/releases), which is actively
maintained (v1.30.4, released 2026-07-09) and exposes an HTTP API, so
integration tests can assert that a verification email went out and extract
the link from it with no network egress. The AWS test environment uses SES in
sandbox mode with the developer's verified address, sends dispatched from the
job queue, retried on failure, and recorded in the security audit log.
Delivery-failure notifications arrive via SNS and get signature verification
and replay protection analogous to the payment webhooks. Resend remains the
named pick if a public demo with arbitrary recipients ever returns; that
decision arrives together with the domain purchase.

Accepted tradeoffs: no stranger can receive email from the deployed test
environment, which is the point of the sandbox but means registration flows
there only work for verified addresses; the SES API is less ergonomic than
Resend's and its failure notifications need an SNS integration rather than a
plain webhook; and if the public-demo goal returns, the email decision reopens
with the domain purchase.

## Cross-cutting decisions

Checking the ten decisions against each other surfaced problems that no single
area owned. Each gets an owner here; the significant ones become ADRs in
docs/DECISIONS.md when implementation starts.

### Cookie topology: one origin instead of a purchased domain

The frontend decision requires the SPA and the API to be same-site. The
original hosting pick put them on `*.pages.dev` and `*.fly.dev`, and both
suffixes are on the [Public Suffix List](https://publicsuffix.org/), so the
two hostnames are different registrable domains: a SameSite=Lax session cookie
set by the API would never accompany the SPA's requests, and SameSite=None
would make it a third-party cookie that Safari and increasingly Chrome refuse.
Login would work in no browser. Catching this in a design doc is cheaper than
catching it in production; it is the reason the standing-demo route required
buying a domain.

The on-demand AWS environment dissolves the problem instead of buying its way
out: one CloudFront distribution serves the SPA and routes `/api/*` to the
API, so the browser sees a single origin and the session cookie is first-party
by construction. Local dev has the same shape, with the Vite dev server
proxying `/api` to the host-run Fastify process. The e2e suite asserts the
cookie round-trip on whichever topology it runs against. If a standing public
demo ever returns, the domain purchase comes back with it (sibling subdomains
`app.` and `api.`, cookie set host-only on the API host), along with DKIM and
SPF records for real outbound email.

### CSRF, owned by the auth layer

Hand-rolled cookie auth means no framework supplies these defaults, and a
hand-built auth portfolio with an unhandled CSRF story fails review
immediately. Per the
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html):
SameSite=Lax as the baseline, plus Origin validation on every state-changing
route (reject requests whose Origin header is not the app's own origin). The
single-origin topology means the API emits no CORS headers at all, which is
the strictest possible cross-origin posture and one less policy to get wrong.
The payment and email webhook routes are exempt from Origin checks and take no
cookies; they authenticate by provider signature. All of it gets dedicated
tests, including the negative cases.

### Environment lifecycle and cost control

The test environment is ephemeral: stood up by a manually dispatched deploy,
used, and torn down to a near-zero bill. Teardown is scripted, verified
against the console, and part of the walking-skeleton milestone's acceptance,
because an "on-demand" environment that is annoying to destroy quietly becomes
a permanent one at $50/month of burned credits. A thin persistent layer
survives teardown deliberately: the CloudFront distribution, the S3 bucket,
and the ECR repository all cost approximately nothing idle, and keeping them
keeps the public URL stable, so the Stripe webhook registration and the OAuth
redirect URIs stay valid across stand-ups instead of needing dashboard edits
every time. Teardown removes the expensive parts: the ECS service, the ALB,
RDS, and the scheduler. Database contents are
disposable by design between stand-ups; the one restore rehearsal (see the
plan) uses RDS snapshots or a logical dump. The earlier standing-demo analysis
imposed sleep-friendly database access patterns for Neon's compute cap; those
constraints are gone, and health probes and job polling can touch RDS freely.

### Webhook event inbox and the job queue

Stripe's event shapes, retry behavior, and 24-hour idempotency window must not
leak into the ledger, and webhook handlers must survive replays, out-of-order
delivery, and the deploy cutover window. The pattern: the webhook route
verifies the signature, inserts the raw event into an `inbox` table keyed by
the provider's event id (the unique index makes replays a no-op), returns 2xx,
and processing happens in the same process immediately after, transactionally
with the ledger postings. A sweeper retries failed or missed inbox rows on the
job runner's schedule, and the daily reconciliation closes whatever gap
remains. Email sends ride the same queue with retries.

The job runner is [pg-boss](https://github.com/timgit/pg-boss), a
Postgres-backed queue, rather than Redis and BullMQ. One stateful service
instead of two, and exactly-once job semantics on the database the app
already trusts. Redis is deliberately deferred: on a single API instance,
rate-limit counters live in process memory and lockout state lives in Postgres,
which is correct at this scale and is named as the thing that changes first at
real scale. Current version and configuration get pinned in an ADR at
adoption time.

### Two smaller picks: API spec and repo layout

The OpenAPI spec is generated from the Fastify route schemas via
@fastify/swagger. The schemas already exist for request and reply validation,
so the spec is a byproduct of code that must be written anyway, not a parallel
artifact that drifts. The repo is a single npm-workspaces monorepo (api, web,
shared types): one developer with one deploy pipeline gains nothing from
separate repos or a heavier workspace tool, and a shared types package is the
cheapest way to keep the SPA honest about API shapes.

### Environment strategy

Two environments: local (compose, Mailpit, a dev Stripe sandbox) and the
on-demand AWS test environment (its own Stripe sandbox, SES in sandbox mode).
No standing staging or demo environment. Each environment has its own Stripe
sandbox because two ledgers must never consume one event stream; the sandbox
association survives teardown, so a re-provisioned environment reconciles
against the same provider history or starts from a fresh sandbox, and which of
the two happens is an explicit choice in the deploy workflow, not an
accident.

## Deferred to the plan

Real requirements that are design tasks for implementation milestones, not
stack research:

- Backup and restore: state the recovery point objective for the ledger, use
  RDS snapshots plus scheduled logical dumps while the environment is up, and
  rehearse a restore once before calling it done.
- Session and token housekeeping: expiry and purge jobs for sessions, reset
  tokens, and verification tokens; logout-all-devices.
- PII policy: pino redaction rules, account deletion, and a data-retention
  note for a public demo that collects real email addresses.
- CI test-database strategy: Postgres service container, per-test transaction
  rollback or template databases, fixtures, and property tests for ledger
  invariants (entries balance, no orphan postings).
- SPA per-environment configuration: `VITE_API_URL` set at build time per
  deploy target (under the single-origin topology this is simply `/api`).
- Only relevant if a standing public demo ever returns: bot protection on
  registration and reset endpoints
  ([Cloudflare Turnstile is free](https://developers.cloudflare.com/turnstile/plans/))
  and an external uptime poller on `/healthz` with email alerts.
