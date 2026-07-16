-- A scheduled reconciliation run that fails must still leave a row, or the
-- admin view shows silence instead of a failure. Existing rows were all
-- successful runs, so the default backfills them correctly.
ALTER TABLE reconciliations
  ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  ADD COLUMN error text;
