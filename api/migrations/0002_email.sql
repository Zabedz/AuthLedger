ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Single-use tokens for email verification and password reset. Only the
-- SHA-256 of the token is stored here, the same as sessions (the plaintext
-- lives transiently in the send-email job payload; see docs/DATA.md).
-- consumed_at makes reuse a no-op; expires_at bounds the window.
CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

-- One row per logical email, for the per-account daily cap and idempotent
-- delivery. dedupe_key is the send job's identity: the handler claims a row
-- before sending and marks sent_at after, so a retried job that finds the row
-- already sent skips it. user_id is null for mail to an address with no
-- account.
CREATE TABLE email_dispatches (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  recipient citext NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX email_dispatches_user_created_idx ON email_dispatches (user_id, created_at);
