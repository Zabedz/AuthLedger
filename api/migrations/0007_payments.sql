-- Payments and the Stripe webhook inbox. Money movement is tracked in integer
-- minor units; the ledger (M7) posts against these. Stripe stays behind the
-- webhook route and the mapping module, so nothing here names a Stripe type.

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Our idempotency key: one create attempt maps to one row even if retried.
  idempotency_key text NOT NULL UNIQUE,
  -- Set once the intent exists at the provider; unique so a webhook resolves to
  -- exactly one row.
  provider_intent_id text UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (char_length(currency) = 3),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'processing', 'succeeded', 'failed', 'canceled')),
  -- The provider event time of the last event applied, so an out-of-order or
  -- replayed delivery cannot move the row backwards.
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_user_idx ON payments (user_id);

-- The webhook inbox, keyed by the provider event id. Every delivery is recorded
-- once, so a replay is a no-op. status distinguishes three outcomes so a
-- reprocessor can find the ones to retry: 'processed' (applied or a correct
-- no-op), 'unhandled' (no handler for this event type yet), and 'unmatched' (a
-- handled type whose payment row did not exist yet, e.g. a fast webhook racing
-- the intent-id write; retried once the row appears).
CREATE TABLE provider_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('processed', 'unhandled', 'unmatched')),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- The money capabilities join the same permission vocabulary as the identity
-- actions (they were a placeholder set in M5's policy module). Admin holds all
-- of them; finer roles come with the M7 endpoints.
INSERT INTO permissions (action, description) VALUES
  ('payments.view_any', 'View payments belonging to any user'),
  ('payments.refund', 'Refund a payment up to the ceiling'),
  ('payments.refund_over_ceiling', 'Refund a payment above the ceiling'),
  ('ledger.reconcile', 'Run reconciliation against the provider');

INSERT INTO role_permissions (role_id, action)
SELECT r.id, p.action
FROM roles r
JOIN permissions p ON p.action IN (
  'payments.view_any',
  'payments.refund',
  'payments.refund_over_ceiling',
  'ledger.reconcile'
)
WHERE r.name = 'admin';
