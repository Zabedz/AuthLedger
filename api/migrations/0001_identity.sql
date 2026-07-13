CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Opaque server-side sessions: the cookie carries a random token, the table
-- stores only its SHA-256, so a database leak does not yield usable cookies.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  user_id uuid,
  session_id uuid,
  ip inet,
  user_agent text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_user_id_at_idx ON audit_events (user_id, at);
