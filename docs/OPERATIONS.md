# Operations

The runbook: how to run, test, observe, deploy, and recover AuthLedger. The
Terraform detail lives in [infra/README.md](../infra/README.md); this page is
the day-to-day view.

## Local development

```sh
make setup   # .env from the example, npm install, build shared
make dev     # Postgres + Mailpit in Docker, api + web in watch mode
make seed    # migrate and insert the demo user (idempotent)
```

- SPA: http://localhost:5173 (proxies /api to the API on 8000)
- Mailpit inbox: http://localhost:8025
- Swagger UI: http://localhost:5173/api/docs (development only)
- Become admin: set `ADMIN_EMAIL=<your registered address>` in `.env` and
  restart; the boot grant is audited.
- Live payments need the webhook forwarder:
  `docker compose --profile stripe up -d stripe-cli` (test-mode keys in
  `.env`; the API refuses a non-test key outside production).
- Stop everything: `make down` plus Ctrl-C on `make dev`.

## Tests and gates

```sh
make test                # api integration tests against real Postgres
npm run e2e -w web       # Playwright composed-stack e2e
npm run typecheck && npm run lint
npm run knip             # dead-code and dependency scan
make backup-drill        # dump, restore into a throwaway db, prove equality
```

CI runs lint, typecheck (including OpenAPI and generated-types drift checks),
tests, an image-boot smoke, e2e, gitleaks, and osv-scanner on every push to
main and every pull request.

## The nightly

`.github/workflows/nightly.yml` (03:23 UTC, also dispatchable) runs the whole
e2e suite plus the full money journey against real Stripe test mode: register,
verify, MFA, pay, settle through a forwarded webhook, refund, reconcile. It
needs the `STRIPE_SECRET_KEY` repo secret. On failure it uploads the
Playwright report and traces as artifacts; GitHub emails the repo owner on a
red scheduled run.

## Scheduled reconciliation

In the deployed environment, EventBridge Scheduler starts the
`authledger-reconcile` task daily (same image, command override).
Every run, scheduled or via `POST /api/admin/reconcile`, lands in the
`reconciliations` history with status ok or failed; a failed run also reports
to Sentry tagged `job=reconcile`. Run it locally with
`npm run job:reconcile -w api`. Fetches are windowed on the last successful
run and fail loudly rather than under-scan.

## Observability

Tracing and error reporting are off unless configured:

- `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS`: OTLP/HTTP
  traces (Grafana Cloud Tempo in this setup; service `authledger-api`). Every
  log line carries `trace_id` when a span is active, so logs and traces join.
- `OTEL_TRACES_CONSOLE=true`: print spans to stdout instead, no account
  needed.
- `SENTRY_DSN`: server errors (thrown 5xx, provider-call failures, job
  failures), with the trace id stamped on each event.

Deployed tasks read all three from Secrets Manager / task env; locally they
come from `.env`.

## Deploy lifecycle

```sh
gh workflow run deploy.yml -f action=standup    # ~18 minutes; bills hourly
gh workflow run deploy.yml -f action=update     # redeploy code to a live env
gh workflow run deploy.yml -f action=teardown   # back to ~$0.40/month idle
```

The public URL (CloudFront) survives teardown: the SPA keeps serving and
`/api/*` answers 502 while the environment is down. Before the first standup
after a fresh persistent apply, push the account-issued secret values (Stripe
key, OTLP header, Sentry DSN); the runbook with exact commands is in
[infra/README.md](../infra/README.md). A task referencing a valueless secret
fails to start.

Known gap while SES has no production identity: the deployed environment
cannot deliver email, so registration works but verification links never
arrive. Local dev has the full feature set via Mailpit.

## Recovery

- Application rollback: revert the commit, dispatch `update`; migrations are
  expand/contract and up-only, and the ECS circuit breaker rolls a
  failing service update back automatically.
- Database: production uses RDS automated snapshots; `make backup-drill`
  rehearses the logical dump/restore path locally.
- A failed scheduled reconciliation shows in the admin history (status
  failed with the error), in Sentry, and as a non-zero ECS task exit; the next
  day's run self-heals the scan window.
