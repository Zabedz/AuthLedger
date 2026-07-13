-- The outcome of each reconciliation run, so the admin view and the logs have a
-- trail and a scheduled run leaves a record. Discrepancies are kept inline for a
-- small, bounded report.
CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  checked int NOT NULL,
  fees_posted_minor bigint NOT NULL,
  discrepancy_count int NOT NULL,
  discrepancies jsonb NOT NULL
);

CREATE INDEX reconciliations_ran_at_idx ON reconciliations (ran_at DESC);

-- A read-only ledger view is a separate permission from running reconciliation,
-- which mutates the ledger, matching the payments.view_any vs payments.refund
-- split. Admin holds both.
INSERT INTO permissions (action, description) VALUES
  ('ledger.view', 'View ledger balances and reconciliation history');

INSERT INTO role_permissions (role_id, action)
SELECT r.id, 'ledger.view' FROM roles r WHERE r.name = 'admin';
