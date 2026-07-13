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
