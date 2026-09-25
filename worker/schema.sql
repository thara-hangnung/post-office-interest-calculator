CREATE TABLE IF NOT EXISTS recurring_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_no TEXT NOT NULL,
  cif TEXT NOT NULL,
  date_of_opening TEXT NOT NULL,
  date_of_maturity TEXT,
  date_of_birth TEXT NOT NULL,
  monthly_installment REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_deposits_lookup
  ON recurring_deposits (account_no, date_of_birth);
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
