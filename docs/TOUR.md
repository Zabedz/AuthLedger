# A tour of AuthLedger

What the app looks like to use, screen by screen. Everything below runs
locally with `make dev` (see [OPERATIONS.md](OPERATIONS.md)); the deployed
environment serves the same SPA behind CloudFront.

## Sign in and registration

The front door. Social login buttons appear here when Google or GitHub OAuth
credentials are configured.

![Sign-in screen](media/01-sign-in.png)

Registration never signs you in: the account starts unverified, and the reply
is the same whether or not the address was new, so the form is not an
account-existence oracle.

![Registration](media/02-register.png)
![Check your email](media/03-check-your-email.png)

## Email verification

In development, mail lands in Mailpit (http://localhost:8025) instead of a
real inbox; production uses SES. The verification link is single-use and
expires.

![Mailpit inbox](media/04-mailpit-inbox.png)
![Verified](media/05-verified.png)

## The account page

One page carries the whole signed-in surface: payments, two-factor
enrollment, active sessions with per-device revocation, and account deletion.
The session cookie is opaque, HttpOnly, and SameSite=Lax; only its hash is
stored server-side.

![Signed in](media/06-signed-in.png)

## Two-factor authentication

Enrollment shows the TOTP secret (and otpauth URL) for any authenticator app,
then single-use recovery codes. The half-authenticated state between password
and code is a short-lived challenge cookie scoped to one endpoint, never a
session.

![MFA enrollment](media/07-mfa-enroll.png)
![Recovery codes](media/08-recovery-codes.png)

The next sign-in asks for the code:

![Two-factor challenge](media/09-two-factor.png)

## Payments

Checkout uses Stripe's Payment Element against a PaymentIntent created by the
API with idempotency keys on both sides. In test mode, card
4242 4242 4242 4242 with any future expiry settles; the signed webhook drives
the payment to succeeded and posts the double-entry ledger charge in the same
transaction.

![Stripe Payment Element](media/10-payment-element.png)

## Administration

Role holders see the admin section: users with role grant/revoke (admin,
auditor, finance), the audit log, and session revocation. Every authenticated
403 anywhere in the API lands in that audit log. The money surface (ledger
balances, reconciliation runs, refunds) is API-level, gated by the finance and
admin roles.

![Admin panel](media/11-admin-panel.png)

## The API console

In development the OpenAPI document renders as Swagger UI at `/api/docs`; the
same document is committed at [openapi.json](openapi.json) and drift-checked
in CI. This is the surface for refunds, ledger balances, and reconciliation.

![Swagger UI](media/12-swagger-ui.png)

## Regenerating this media

The journey registers a fixed demo address, so it needs a fresh database each
time:

```sh
docker compose up -d --wait db mailpit
docker compose exec db psql -U authledger -d postgres \
  -c 'DROP DATABASE IF EXISTS authledger_e2e' -c 'CREATE DATABASE authledger_e2e'
DATABASE_URL=postgres://authledger:authledger@localhost:5432/authledger_e2e \
  npm run migrate:up -w api
cd web && STRIPE_SECRET_KEY=... STRIPE_PUBLISHABLE_KEY=... \
  npx playwright test --config playwright.capture.config.ts
```

The journey writes fresh screenshots into docs/media and records a video under
web/test-results; the ffmpeg conversion to the README GIF is in the capture
config header.
