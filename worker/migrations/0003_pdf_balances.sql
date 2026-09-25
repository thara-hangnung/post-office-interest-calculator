ALTER TABLE recurring_deposits ADD COLUMN needs_details INTEGER NOT NULL DEFAULT 0;

ALTER TABLE recurring_deposit_entries
  ADD COLUMN installment_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recurring_deposit_entries
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
