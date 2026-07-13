-- Refunds, tracked per row so the cumulative refunded amount is the sum over a
-- payment. idempotency_key makes a retried refund request a no-op instead of a
-- second refund, and the running total is what the refund ceiling is checked
-- against, so several partial refunds cannot be split around it.
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  provider_refund_id text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refunds_payment_idx ON refunds (payment_id);
