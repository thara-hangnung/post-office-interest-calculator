ALTER TABLE admin_audit_log ADD COLUMN batch_id TEXT;

CREATE TABLE IF NOT EXISTS recurring_deposit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  deposit_date TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_at TEXT,
  reversed_by TEXT
);

CREATE INDEX IF NOT EXISTS recurring_deposit_entries_record
  ON recurring_deposit_entries (record_id, reversed_at, deposit_date);
CREATE INDEX IF NOT EXISTS recurring_deposit_entries_batch
  ON recurring_deposit_entries (batch_id);
