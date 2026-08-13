-- Splits money operations out of admin: finance handles
-- payments and the ledger, including refunds past the policy ceiling, without
-- inheriting identity administration. Admin keeps every permission.
INSERT INTO roles (name, description) VALUES
  ('finance', 'Money operations: view and refund payments, run reconciliation');

INSERT INTO role_permissions (role_id, action)
SELECT r.id, p.action
FROM roles r, permissions p
WHERE r.name = 'finance'
  AND p.action IN (
    'payments.view_any',
    'payments.refund',
    'payments.refund_over_ceiling',
    'ledger.view',
    'ledger.reconcile'
  );
