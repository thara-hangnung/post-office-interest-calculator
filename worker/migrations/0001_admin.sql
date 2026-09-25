ALTER TABLE recurring_deposits ADD COLUMN created_at TEXT;
ALTER TABLE recurring_deposits ADD COLUMN updated_at TEXT;
ALTER TABLE recurring_deposits ADD COLUMN deleted_at TEXT;

UPDATE recurring_deposits
SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
    updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS recurring_deposits_active
  ON recurring_deposits (deleted_at, name);
CREATE INDEX IF NOT EXISTS recurring_deposits_account
  ON recurring_deposits (account_no);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  record_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created
  ON admin_audit_log (created_at);
