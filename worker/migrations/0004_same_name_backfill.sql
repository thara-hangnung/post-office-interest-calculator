-- One-time backfill: a blank record inherits the CIF and date of birth of a
-- same-name account, so an imported PDF row is usable without retyping.
-- MIN() makes the donor deterministic when a name has several, and rows whose
-- same-name accounts disagree keep their blanks for the admin to resolve.
UPDATE recurring_deposits AS t
SET cif = s.cif,
    date_of_birth = s.date_of_birth,
    needs_details = CASE WHEN t.date_of_opening = '' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
FROM (
  SELECT name COLLATE NOCASE AS name_key, MIN(cif) AS cif, MIN(date_of_birth) AS date_of_birth
  FROM recurring_deposits
  WHERE deleted_at IS NULL AND cif <> '' AND date_of_birth <> ''
  GROUP BY name COLLATE NOCASE
) AS s
WHERE t.name = s.name_key COLLATE NOCASE
  AND t.deleted_at IS NULL
  AND (t.cif = '' OR t.date_of_birth = '');

INSERT INTO admin_audit_log (admin_email, action)
VALUES ('tharahangnung@gmail.com', 'backfill_same_name');
