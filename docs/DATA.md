# Data handling

What personal data the system stores, why, and how long it lives. The deployed
environment is a personal test environment (docs/RESEARCH.md): it only ever
holds addresses the developer controls, and SES runs in sandbox mode, so it
never delivers to third parties.

## What is collected

- Email address and an argon2id password hash (users).
- Session records: an IP address and user agent per session, for the
  active-session view and new-device notices.
- A security audit log: security-relevant events with actor, IP, and user
  agent.
- Email dispatch records: recipient and kind per message sent, for the
  per-account daily cap.
- Email suppression records: an address SES reported as a bounce or complaint,
  kept so the system never mails it again.

Raw passwords are never stored. Session tokens and verification/reset tokens
are stored as SHA-256 hashes in their own tables. A verification or reset
token also rides, in plaintext, inside the queued email job that carries its
link; that row is deleted within minutes of the email being sent (short
pg-boss retention on the send-email queue), and the token is single-use and
short-lived (1 hour for reset, 24 hours for verification). Authorization
headers, cookies, and set-cookie are redacted from logs (ADR-004).

## Retention

- Sessions are deleted after their 30-day absolute expiry by the daily purge.
- Verification and reset tokens are deleted once consumed or expired by the
  same purge.
- The audit log is append-only and retained for the life of the environment;
  it deliberately outlives the user row it references (no foreign key), so a
  deletion is itself auditable.
- Email dispatch records are retained for the life of the environment; they
  hold a recipient address and a message kind, no content.

## Deletion

Account deletion (DELETE /api/auth/account) removes the user row, which
cascades to sessions and tokens and nulls the user reference on dispatch
records. The deletion is audited before the row is removed, and the user is
notified. What survives by design is the audit trail, now dissociated from any
live account.
