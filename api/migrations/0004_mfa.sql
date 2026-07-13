-- TOTP secret is AES-256-GCM ciphertext (iv, auth tag, ciphertext), never
-- plaintext. totp_enabled_at is set only after a code is confirmed, so a
-- stored-but-unconfirmed secret does not gate login.
ALTER TABLE users ADD COLUMN totp_secret bytea;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
-- The highest TOTP time step already accepted, so a code cannot be replayed
-- within its validity window.
ALTER TABLE users ADD COLUMN totp_last_step bigint;

-- Single-use recovery codes, stored as SHA-256 like session tokens.
CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

-- The password-ok-awaiting-second-factor state (ADR-010): a short-lived,
-- single-use token issued after the password check, exchanged for a session
-- once the second factor verifies. Never a flag on a session row.
CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
