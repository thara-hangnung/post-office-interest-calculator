import { deriveDates, parseDepositPages, planImport, shiftMonths, parsePdfDate, formatPdfDate } from './pdf-import.js';

const X = { serial: 41.5, accountNo: 83, name: 169.5, denomination: 294, monthPaid: 398, nextDue: 481 };
const item = (x, str, y) => ({ x, y, str, width: String(str).length * 6, height: 10, fontSize: 8.4 });
const dataRow = (y, serial, accountNo, name, denomination, paid, due) => {
  const cells = [item(X.serial, String(serial), y), item(X.accountNo, accountNo, y)];
  if (name !== null) cells.push(item(X.name, name, y));
  cells.push(item(X.denomination, `${denomination}.00 Cr.`, y), item(X.monthPaid, String(paid), y));
  if (due) cells.push(item(X.nextDue, due, y));
  return cells;
};

const pages = [[
  item(338, 'Printed on 25-09-2026 21:17:12 PM', 610),
  item(X.name, 'Account Name', 503.7),
  item(X.accountNo, 'Account No', 503.7),
  ...dataRow(200, 1, '020000000001', 'MATCHED NAME', 3000, 10, '25-10-2026'),
  ...dataRow(181.5, 2, '020000000002', null, 500, 89, '03-05-2029'),
  item(X.name, 'WRAPPED FIRST LINE', 187),
  item(X.name, 'WRAPPED SECOND LINE', 176),
  ...dataRow(163, 3, '020000000003', 'NO DUE DATE', 1000, 60, ''),
  ...dataRow(144.5, 4, '020000000004', 'BRAND NEW ACCOUNT', 2000, 0, '14-10-2026'),
  ...dataRow(126, 5, '020000000005', 'RETURNING', 900, 20, '15-10-2026')
]];

const parsed = parseDepositPages(pages);
if (parsed.printedOn !== '25-09-2026') throw new Error('printed-on date not found');
if (parsed.rows.length !== 5) throw new Error(`expected 5 rows, got ${parsed.rows.length}`);

const [matched, wrapped, noDue, fresh, returning] = parsed.rows;
if (returning.accountNo !== '020000000005') throw new Error('returning row parsed wrong');
if (matched.accountNo !== '020000000001' || matched.name !== 'MATCHED NAME') throw new Error('matched row parsed wrong');
if (matched.monthlyInstallment !== 3000 || matched.monthPaidUpTo !== 10 || matched.nextDueDate !== '25-10-2026') throw new Error('matched row values parsed wrong');
if (wrapped.name !== 'WRAPPED FIRST LINE WRAPPED SECOND LINE') throw new Error(`wrapped name wrong: ${wrapped.name}`);
if (!wrapped.nameFromWrappedLines) throw new Error('wrapped name not flagged');
if (noDue.nextDueDate !== '' || noDue.name !== 'NO DUE DATE') throw new Error('row without due date parsed wrong');
if (fresh.monthPaidUpTo !== 0) throw new Error('zero-installment row parsed wrong');

const matchedDates = deriveDates(matched);
if (matchedDates.opening !== '25-12-2025') throw new Error(`opening derivation wrong: ${matchedDates.opening}`);
if (matchedDates.maturity !== '25-12-2030' || matchedDates.term !== 1) throw new Error('maturity derivation wrong');

const wrappedDates = deriveDates(wrapped);
if (wrappedDates.opening !== '03-12-2021') throw new Error(`extended-term opening wrong: ${wrappedDates.opening}`);
if (wrappedDates.term !== 2 || wrappedDates.maturity !== '03-12-2031') throw new Error('extended-term maturity wrong');
if (!wrappedDates.warnings.includes('extended-term')) throw new Error('extended term not flagged');

const fallbackDates = deriveDates(noDue, '01-06-2021');
if (fallbackDates.opening !== '01-06-2021' || fallbackDates.maturity !== '01-06-2026') throw new Error('existing opening fallback wrong');
if (!fallbackDates.warnings.includes('no-next-due-date')) throw new Error('missing due date not flagged');

const freshDates = deriveDates(fresh);
if (freshDates.opening !== '' || freshDates.maturity !== '') throw new Error('zero-installment row must not derive dates');
if (!freshDates.warnings.includes('no-installments-yet')) throw new Error('zero installments not flagged');

if (formatPdfDate(shiftMonths(parsePdfDate('31-01-2026'), -1)) !== '31-12-2025') throw new Error('month-end clamping wrong');
if (formatPdfDate(shiftMonths(parsePdfDate('31-03-2026'), -1)) !== '28-02-2026') throw new Error('february clamping wrong');

const records = [
  { id: 1, accountNo: '020000000001', name: 'MATCHED NAME', monthlyInstallment: 3000, opening: '25-12-2025', installments: 10, balance: 30000, deletedAt: '' },
  { id: 2, accountNo: '020000000002', name: 'OLD NAME', monthlyInstallment: 500, opening: '03-12-2021', installments: 89, balance: 44500, deletedAt: '' },
  { id: 3, accountNo: '020000000003', name: 'NO DUE DATE', monthlyInstallment: 1000, opening: '01-06-2021', installments: 60, balance: 60000, deletedAt: '' },
  { id: 5, accountNo: '020000000009', name: 'NOT IN PDF', monthlyInstallment: 700, opening: '01-01-2020', installments: 12, balance: 8400, deletedAt: '' },
  { id: 6, accountNo: '020000000005', name: 'RETURNING', monthlyInstallment: 900, opening: '01-01-2022', installments: 0, balance: 0, deletedAt: '2026-09-25 10:00:00' }
];

const plan = planImport({ rows: parsed.rows, printedOn: parsed.printedOn, records, liveCount: 5 });
if (plan.problems.some((problem) => problem.level === 'error')) throw new Error(`unexpected plan errors: ${JSON.stringify(plan.problems)}`);
if (plan.counts.rows !== 5 || plan.counts.created !== 1 || plan.counts.restored !== 1 || plan.counts.updated !== 1 || plan.counts.unchanged !== 2) {
  throw new Error(`action counts wrong: ${JSON.stringify(plan.counts)}`);
}
if (plan.counts.nameChanges !== 1) throw new Error('name change not detected');
if (plan.counts.missing !== 1 || plan.missing[0].accountNo !== '020000000009') throw new Error('missing account not detected');
if (plan.counts.wrappedNames !== 1) throw new Error('wrapped name not counted');
if (plan.batchId !== 'pdf-2026-09-25') throw new Error(`batch id wrong: ${plan.batchId}`);
if (plan.totals.before !== 134500 || plan.totals.after !== 152500) throw new Error(`totals wrong: ${JSON.stringify(plan.totals)}`);
const restore = plan.changes.find((change) => change.accountNo === '020000000005');
if (restore.action !== 'restore') throw new Error(`soft-deleted account must be restored, got ${restore.action}`);
if (restore.opening !== '15-02-2025' || restore.maturity !== '15-02-2030') throw new Error(`restored dates wrong: ${restore.opening} ${restore.maturity}`);

const restored = plan.changes.find((change) => change.accountNo === '020000000002');
if (restored.action !== 'update' || !restored.nameChanged) throw new Error('name change not planned as update');

const samePlan = planImport({
  rows: parsed.rows,
  printedOn: parsed.printedOn,
  records: parsed.rows.map((row, index) => {
    const derived = deriveDates(row);
    return {
      id: index + 1,
      accountNo: row.accountNo,
      name: row.name,
      monthlyInstallment: row.monthlyInstallment,
      opening: derived.opening,
      installments: row.monthPaidUpTo,
      balance: Math.round(row.monthlyInstallment * row.monthPaidUpTo * 100) / 100,
      deletedAt: ''
    };
  }),
  liveCount: 5
});
if (samePlan.counts.created !== 0 || samePlan.counts.updated !== 0 || samePlan.counts.unchanged !== 5) {
  throw new Error(`re-importing the same PDF must be a no-op: ${JSON.stringify(samePlan.counts)}`);
}

const shrunk = planImport({
  rows: [{ ...matched, monthPaidUpTo: 4 }],
  printedOn: '26-09-2026',
  records,
  liveCount: 1
});
if (!shrunk.problems.some((problem) => problem.level === 'error' && problem.message.includes('fewer paid installments'))) {
  throw new Error('installment decrease must block the import');
}
const shrunkAllowed = planImport({ rows: [{ ...matched, monthPaidUpTo: 4 }], printedOn: '26-09-2026', records, allowDecrease: true, liveCount: 1 });
if (shrunkAllowed.problems.some((problem) => problem.level === 'error')) throw new Error('allowed decrease still blocked');
if (!shrunkAllowed.changes[0].warnings.includes('installments-decreased')) throw new Error('decrease not flagged on the change');

const partial = planImport({ rows: parsed.rows.slice(0, 1), printedOn: parsed.printedOn, records, liveCount: 5 });
if (!partial.problems.some((problem) => problem.level === 'error' && problem.message.includes('partial or changed report'))) {
  throw new Error('truncated PDF must be refused');
}

const duplicated = planImport({ rows: [matched, { ...matched, serial: 2 }], printedOn: parsed.printedOn, records, liveCount: 1 });
if (!duplicated.problems.some((problem) => problem.message.includes('appears twice'))) throw new Error('duplicate account must be refused');

const outOfOrder = planImport({ rows: [{ ...matched, serial: 2 }], printedOn: parsed.printedOn, records, liveCount: 1 });
if (!outOfOrder.problems.some((problem) => problem.message.includes('not sequential'))) throw new Error('non-sequential rows must be refused');

const empty = planImport({ rows: [], printedOn: '', records, liveCount: 5 });
if (!empty.problems.some((problem) => problem.message.includes('No deposit rows'))) throw new Error('empty PDF must be refused');

console.log('worker pdf import tests passed');
