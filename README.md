# authledger

Identity and payments in one production-shaped system: a hand-built
authentication and authorization layer, and a Stripe-integrated payments
domain with a double-entry ledger and reconciliation. The two domains
intersect on purpose: authorization decides who may initiate, view, refund,
or reconcile a transaction.

Status: walking skeleton. The API serves health endpoints and an OpenAPI
document; the SPA is a placeholder that reports API health. Domain milestones
land in order; see [docs/PLAN.md](docs/PLAN.md).

Stack decisions and their reasoning are recorded in
[docs/RESEARCH.md](docs/RESEARCH.md); decisions made while building are
appended to [docs/DECISIONS.md](docs/DECISIONS.md).

## Layout

| Path      | Contents                                                    |
| --------- | ----------------------------------------------------------- |
| `api/`    | Fastify service: routes, config, db client, SQL migrations  |
| `web/`    | Vite + React SPA                                            |
| `shared/` | TypeBox schemas and types shared between api and web        |
| `docs/`   | Research, plan, and architecture decision records           |

## Running locally

Requirements: Node 24+, Docker with Compose.

```sh
make setup   # copy .env.example to .env, install, build shared
make dev     # start Postgres and Mailpit, then run api and web in watch mode
make seed    # migrate and insert the fixed demo user (idempotent)
```

The API listens on 8000, the web dev server on 5173 and proxies `/api` to the
API so the browser sees one origin, matching the deployed topology. Swagger UI
is at `/api/docs` in development. Mailpit's inbox UI is on 8025.

Database workflow: migrations are plain SQL run by node-pg-migrate
(`make migrate`), and query types are generated from the live schema
(`make codegen`) and committed; CI fails if they drift.

The Stripe CLI webhook forwarder is a compose profile, off by default:
`docker compose --profile stripe up` once `STRIPE_SECRET_KEY` is set in
`.env`. Keys outside production must be test-mode (`sk_test_`); the API
refuses to boot otherwise.
