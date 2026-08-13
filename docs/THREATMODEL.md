# Threat model

The threats this system defends against, and the code that defends against each.
Every mitigation below names a file you can open and read. Where a risk is
accepted rather than mitigated, that is said plainly.

## Scope and assumptions

The deployed environment is a personal test environment (docs/RESEARCH.md,
docs/DATA.md): Stripe runs in test mode, SES runs in its sandbox, and the only
addresses in the database belong to the developer. So the model treats money and
email as real (the code paths are the production ones) while the blast radius of
a live incident is near zero.

Assumptions taken as given, not defended here: Postgres, Stripe, and AWS are
trusted operators; TLS terminates at CloudFront and the ALB; the deploy
pipeline's OIDC role and Terraform state are controlled by the developer.

## Assets

- User credentials and the sessions derived from them.
- Second-factor secrets (TOTP) and recovery codes.
- The authorization state: who holds which role.
- Money records: payments, refunds, and the double-entry ledger.
- The Stripe secret key and webhook signing secret.
- The audit log, whose value is that it cannot be quietly rewritten.

## Trust boundaries

1. Browser to API. Same origin in both dev and prod (docs topology in the
   README). Cookies are the only ambient credential; the API emits no CORS
   headers.
2. Stripe to API. Inbound webhooks cross from an external system and are
   authenticated by signature, not by cookie.
3. API to Postgres. The database enforces invariants the application cannot be
   trusted to hold alone (ledger balance, append-only history).
4. API to SES/SNS. Outbound mail and inbound bounce/complaint notifications.

## Threats and mitigations

### Authentication

| Threat | Mitigation | Where |
| --- | --- | --- |
| Password cracking after a DB leak | argon2id at OWASP parameters (64 MiB, 3 iterations) | `api/src/domain/passwords.ts` |
| Session token theft from a DB leak | Only a SHA-256 of the 256-bit token is stored; the token itself lives only in the cookie | `api/src/domain/sessions.ts` |
| Session token theft via XSS | HttpOnly, SameSite=Lax, Secure-in-prod cookie; the token never reaches JavaScript | `api/src/plugins/session-auth.ts` |
| Account enumeration | Login runs a dummy argon2 verify on unknown emails so timing does not distinguish them; the reply is identical for unknown-email and wrong-password | `api/src/domain/passwords.ts`, `api/src/domain/accounts.ts` |
| Online password guessing | Per-account lockout after N failures (`locked_until`), plus per-route rate limits | `api/src/domain/accounts.ts`, `api/src/server.ts` |
| MFA bypass or half-auth escalation | The post-password state is a short-lived challenge cookie scoped to one path, never a session; TOTP codes are single-use with replay protection | `api/src/plugins/session-auth.ts`, `api/src/domain/mfa.ts` |
| TOTP secret exposure | Secrets are AES-256-GCM encrypted at rest | `api/src/domain/encryption.ts` |
| OAuth login CSRF / code interception | State and PKCE/nonce bound to the flow; conservative account linking | `api/src/routes/oauth.ts`, `api/src/domain/oauth.ts` |

### Authorization

| Threat | Mitigation | Where |
| --- | --- | --- |
| A new route ships with no access check | Deny-by-default boot check: the server refuses to start if any `/api` route declares no policy | `api/src/plugins/authz-guard.ts` |
| Privilege escalation via a stale session | Permissions resolve per request from the user's roles, so a revoke lands on the next request | `api/src/plugins/session-auth.ts` |
| IDOR on a self route (reaching another user's resource) | Self routes scope every query by the caller's id; a cross-user id is a 404, not a leak (test: authz.test.ts) | `api/src/routes/account.ts` |
| Locking everyone out of role management | The last admin cannot be demoted | `api/src/routes/admin.ts`, `api/src/domain/authz.ts` |
| Over-broad refunds | Refunds require a money role (finance or admin), kept apart from identity administration; the ceiling permission is separate from `payments.refund` so a narrower routine-refund grant can be seeded without schema change (the seeded money roles deliberately hold both) | `api/src/domain/authz.ts`, `api/src/domain/policy.ts`, `api/migrations/0012_finance_role.sql` |
| Silent permission probing | Every authenticated 403 is audited with actor, method, and route template; floods are summarized past ten a minute and the admin surface is rate limited, so the audit trail cannot be grown or buried by the prober | `api/src/plugins/authz-guard.ts`, `api/src/routes/admin.ts` |

### Request forgery (CSRF)

Cookie auth plus SameSite=Lax is the baseline; the active defense is an Origin
check on every state-changing request, since the API sends no CORS headers.
Routes that authenticate by signature (webhooks) opt out with
`config.skipOriginCheck`. See `api/src/plugins/origin-check.ts`.

### Payment integrity

| Threat | Mitigation | Where |
| --- | --- | --- |
| Forged webhook drives a fake payment | Signature verified with `constructEvent` (HMAC over the signing secret) before anything is read | `api/src/routes/stripe-webhooks.ts` |
| Webhook replay or out-of-order delivery | An inbox keyed by provider event id dedupes; the handler is idempotent and order-tolerant | `api/src/routes/stripe-webhooks.ts` |
| A Stripe schema change corrupts our model | Stripe types stay behind a mapping layer; the payment model and ledger never see a Stripe type | `api/src/domain/stripe-mapping.ts` |
| Double charge on a retried request | Idempotency keys, ours and Stripe's, on intent creation | `api/src/routes/payments.ts` |
| Refunding past the captured amount by splitting | Per-payment cumulative-ceiling tracking in a refunds table, checked under the row | `api/src/domain/payments.ts`, `api/migrations/0008_refunds.sql` |

### Ledger integrity

The ledger's invariants are enforced in Postgres, not the application, so a bug
or a compromised app process cannot write a bad ledger.

- An entry's postings must sum to zero: a deferred constraint trigger
  (`ledger_balanced`) rejects an unbalanced entry at commit.
- The ledger is append-only: UPDATE and DELETE triggers reject any change, so a
  correction must be a reversing entry.

See `api/migrations/0009_ledger.sql`. The application also refuses to submit an
unbalanced entry (`postEntry` in `api/src/domain/ledger.ts`), so the trigger is
the backstop, not the first line.

### Data at rest and secrets

- No plaintext passwords, session tokens, or reset/verification tokens; hashes
  only (docs/DATA.md).
- Secrets come from the environment; production secrets live in AWS Secrets
  Manager (`infra/`), never in the repo. The config layer refuses a non-test
  Stripe key outside production (`api/src/config.ts`).
- Authorization headers, cookies, and set-cookie are redacted from logs.

### Auditability

Security-relevant actions are written to an append-only audit log with actor,
IP, and user agent (`api/src/domain/audit.ts`). It has no foreign key to the
user row, so a user deletion is itself an audited event that outlives the
account (docs/DATA.md).

## Residual and accepted risks

- No CSP or Subresource Integrity on the SPA yet; XSS is mitigated by HttpOnly
  cookies and React's default escaping, not by a content policy. Tracked for M8.
- Rate limits are per-instance in-memory; a multi-instance deploy would want a
  shared store. Single-instance today.
- The payments browser click-through is not covered by an automated e2e, because
  Stripe Radar serves a captcha to automated browsers; settlement is proven by
  server-side and API tests instead.
