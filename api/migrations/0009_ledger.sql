-- Double-entry ledger. Every money movement is a balanced journal entry: its
-- postings sum to zero, enforced by the database, not the application. The
-- ledger is append-only; a mistake is corrected with a reversing entry.
-- Amounts are signed integer minor units: a debit is positive, a credit
-- negative.

-- The chart of accounts (reference data). Normal balance is by kind: assets and
-- expenses are debit-normal, income is credit-normal.
CREATE TABLE ledger_accounts (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('asset', 'income', 'expense'))
);

INSERT INTO ledger_accounts (code, name, kind) VALUES
  ('stripe_receivable', 'Funds owed by the provider', 'asset'),
  ('revenue', 'Payment revenue', 'income'),
  ('fees', 'Provider processing fees', 'expense'),
  ('refunds', 'Refunds to customers', 'expense'),
  ('disputes', 'Disputed and charged-back amounts', 'expense');

-- One journal entry per money movement. reference is the provider id (intent,
-- refund, dispute) so a redelivered event posts once.
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('charge', 'refund', 'fee', 'dispute', 'reversal')),
  reference text NOT NULL,
  currency text NOT NULL CHECK (char_length(currency) = 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference)
);

CREATE TABLE ledger_postings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  entry_id uuid NOT NULL REFERENCES ledger_entries (id),
  account text NOT NULL REFERENCES ledger_accounts (code),
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_postings_entry_idx ON ledger_postings (entry_id);
CREATE INDEX ledger_postings_account_idx ON ledger_postings (account);

-- The balance invariant: an entry's postings sum to zero. Deferred so a
-- multi-posting entry is checked once the whole entry is written, at commit.
CREATE FUNCTION ledger_entry_balanced() RETURNS trigger AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0) INTO imbalance
  FROM ledger_postings WHERE entry_id = NEW.entry_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'ledger entry % is unbalanced by %', NEW.entry_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();

-- Append-only: correcting the ledger means a reversing entry, so UPDATE and
-- DELETE are refused on both tables.
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only; correct with a reversing entry';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
