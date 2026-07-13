-- OAuth-only accounts have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- A social identity linked to a user. One provider account maps to one user.
CREATE TABLE provider_identities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX provider_identities_user_idx ON provider_identities (user_id);

-- The in-flight authorization: the PKCE verifier and nonce that the callback
-- needs, keyed by the state. Short-lived; the callback also binds the state to
-- the browser via a cookie, so a stolen state alone cannot complete a login.
CREATE TABLE oauth_flows (
  state text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  code_verifier text NOT NULL,
  nonce text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
