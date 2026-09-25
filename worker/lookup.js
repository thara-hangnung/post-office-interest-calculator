const DATE_PATTERN = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;

export function normalizeDate(value) {
  const match = String(value ?? '').trim().match(DATE_PATTERN);
  if (!match) return '';
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
}

function parseDate(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const [day, month, year] = normalized.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addYears(date, years) {
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));
}

function wholeMonthsBetween(start, end) {
  if (end < start) return -1;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return months;
}

export function countInstallments(record, asOf = new Date()) {
  const opening = parseDate(record.dateOfOpening ?? record.date_of_opening);
  if (!opening || asOf < opening) return 0;
  const maturity = parseDate(record.dateOfMaturity ?? record.date_of_maturity) || addYears(opening, 5);
  const end = asOf < maturity ? asOf : maturity;
  return Math.max(0, Math.min(60, wholeMonthsBetween(opening, end) + 1));
}

export function estimateDeposit(record, asOf = new Date()) {
  const monthlyInstallment = Number(record.monthlyInstallment ?? record.monthly_installment);
  const installments = countInstallments(record, asOf);
  const validMonthly = Number.isFinite(monthlyInstallment) && monthlyInstallment >= 0;
  return {
    installments,
    monthlyInstallment: validMonthly ? monthlyInstallment : 0,
    estimatedDeposit: validMonthly ? monthlyInstallment * installments : 0
  };
}

function maskMiddle(value, visibleStart, visibleEnd) {
  const text = String(value ?? '');
  if (text.length <= visibleStart + visibleEnd) return text;
  return `${text.slice(0, visibleStart)}${'•'.repeat(Math.max(3, text.length - visibleStart - visibleEnd))}${text.slice(-visibleEnd)}`;
}

export function maskAccount(value) {
  return maskMiddle(value, 4, 4);
}

export function maskCif(value) {
  return maskMiddle(value, 2, 3);
}

export function publicRecord(record, asOf = new Date()) {
  const estimate = estimateDeposit(record, asOf);
  const manualCount = Number(record.manualDepositCount ?? record.manual_deposit_count ?? 0);
  const manualTotal = Number(record.manualDepositTotal ?? record.manual_deposit_total ?? 0);
  const hasManualDeposits = Number.isFinite(manualCount) && manualCount > 0;
  const openingValue = record.dateOfOpening ?? record.date_of_opening;
  const maturityValue = record.dateOfMaturity ?? record.date_of_maturity;
  const opening = parseDate(openingValue);
  const storedMaturity = normalizeDate(maturityValue);
  const maturity = storedMaturity || (opening ? addYears(opening, 5).toISOString().slice(0, 10).split('-').reverse().join('-') : '');
  const manualDate = record.lastDepositDate ?? record.last_deposit_date;
  return {
    name: record.name ?? '',
    accountNo: maskAccount(record.accountNo ?? record.account_no),
    cif: maskCif(record.cif),
    dateOfOpening: normalizeDate(openingValue),
    dateOfMaturity: maturity,
    maturityEstimated: !storedMaturity,
    dateOfBirth: normalizeDate(record.dateOfBirth ?? record.date_of_birth),
    monthlyInstallment: estimate.monthlyInstallment,
    completedInstallments: hasManualDeposits ? manualCount : estimate.installments,
    estimatedDeposit: hasManualDeposits ? (Number.isFinite(manualTotal) ? manualTotal : 0) : estimate.estimatedDeposit,
    depositSource: hasManualDeposits ? 'manual' : 'estimate',
    asOf: hasManualDeposits ? (normalizeDate(manualDate) || asOf.toISOString().slice(0, 10)) : asOf.toISOString().slice(0, 10)
  };
}
