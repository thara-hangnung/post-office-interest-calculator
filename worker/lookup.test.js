import { countInstallments, estimateDeposit, maskAccount, maskCif, normalizeDate, publicRecord } from './lookup.js';

const record = {
  name: 'TEST RECURRING DEPOSIT',
  account_no: '000000000000',
  cif: '000000000',
  date_of_opening: '17-02-2026',
  date_of_maturity: '17-02-2031',
  date_of_birth: '23-05-1985',
  monthly_installment: 3000
};

if (normalizeDate('4/11/1966') !== '04-11-1966') throw new Error('date normalization failed');
if (maskAccount(record.account_no) !== '0000••••0000') throw new Error('account masking failed');
if (maskCif(record.cif) !== '00••••000') throw new Error('CIF masking failed');
if (countInstallments(record, new Date('2026-09-25T00:00:00Z')) !== 8) throw new Error('installment count failed');
if (estimateDeposit(record, new Date('2026-09-25T00:00:00Z')).estimatedDeposit !== 24000) throw new Error('estimate failed');
if (countInstallments(record, new Date('2032-01-01T00:00:00Z')) !== 60) throw new Error('installment cap failed');
if (publicRecord(record, new Date('2026-09-25T00:00:00Z')).dateOfMaturity !== '17-02-2031') throw new Error('public record failed');
const manualRecord = { ...record, manual_deposit_count: 3, manual_deposit_total: 7500, last_deposit_date: '20-09-2026' };
const manualPublic = publicRecord(manualRecord, new Date('2026-09-25T00:00:00Z'));
if (manualPublic.completedInstallments !== 3 || manualPublic.estimatedDeposit !== 7500 || manualPublic.depositSource !== 'manual' || manualPublic.asOf !== '20-09-2026') throw new Error('manual deposit override failed');
console.log('worker lookup tests passed');
