CREATE TABLE IF NOT EXISTS recurring_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_no TEXT NOT NULL,
  cif TEXT NOT NULL,
  date_of_opening TEXT NOT NULL,
  date_of_maturity TEXT,
  date_of_birth TEXT NOT NULL,
  monthly_installment REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_deposits_lookup
  ON recurring_deposits (account_no, date_of_birth);
