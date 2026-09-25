const COLUMN_ANCHORS = [
  { field: 'serial', x: 41.5 },
  { field: 'accountNo', x: 83 },
  { field: 'name', x: 169.5 },
  { field: 'denomination', x: 294 },
  { field: 'monthPaid', x: 398 },
  { field: 'nextDue', x: 481 }
];
const ANCHOR_TOLERANCE = 8;
const NAME_LINE_WINDOW = 6.5;
const HEADER_TEXT = new Set([
  'ACCOUNT NO', 'ACCOUNT NAME', 'DENOMINATION', 'MONTH PAID UPTO',
  'NEXT RD INSTALLMENT DUE', 'DATE', 'SELECT'
]);
const RD_TERM_MONTHS = 60;
const MAX_MONTHLY_INSTALLMENT = 10_000_000;

export function normalizePdfDate(value) {
  const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(String(value || '').trim());
  if (!match) return '';
  const [, day, month, year] = match;
  return `${day.padStart(2, '0')}-${month.padStart(2, '0')}-${year}`;
}

export function parsePdfDate(value) {
  const normalized = normalizePdfDate(value);
  if (!normalized) return null;
  const [day, month, year] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1 || date.getUTCFullYear() !== year) return null;
  return date;
}

export function formatPdfDate(date) {
  if (!date) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

export function shiftMonths(date, months) {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function columnFor(x) {
  let best = null;
  let bestDistance = ANCHOR_TOLERANCE + 1;
  for (const anchor of COLUMN_ANCHORS) {
    const distance = Math.abs(x - anchor.x);
    if (distance < bestDistance) {
      best = anchor.field;
      bestDistance = distance;
    }
  }
  return best;
}

function parseAmount(value) {
  const cleaned = String(value || '').replace(/,/g, '').replace(/[^0-9.]/g, '');
  const match = /^\d*\.?\d+/.exec(cleaned);
  return match ? Number(match[0]) : 0;
}

function collectLines(pages) {
  const lines = [];
  for (const [page, items] of (pages || []).entries()) {
    const byY = new Map();
    for (const item of items) {
      const text = String(item?.str ?? '').trim();
      if (!text) continue;
      const key = Math.round(item.y * 2) / 2;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push({ x: item.x, text });
    }
    for (const [y, cells] of byY.entries()) lines.push({ y, cells, page });
  }
  return lines;
}

function lineCells(line) {
  const cells = { nameParts: [] };
  for (const cell of line.cells.sort((a, b) => a.x - b.x)) {
    const field = columnFor(cell.x);
    if (!field) continue;
    if (field === 'name') {
      cells.nameParts.push(cell.text);
      continue;
    }
    cells[field] = (cells[field] ? `${cells[field]} ${cell.text}` : cell.text).trim();
  }
  return cells;
}

export function parseDepositPages(pages) {
  const lines = collectLines(pages).sort((a, b) => b.y - a.y);
  let printedOn = '';
  const rows = [];
  const orphans = [];

  for (const line of lines) {
    const cells = lineCells(line);
    for (const cell of line.cells) {
      const match = /Printed on (\d{1,2}-\d{1,2}-\d{4})/.exec(cell.text);
      if (match && !printedOn) printedOn = normalizePdfDate(match[1]);
    }
    const name = cells.nameParts.filter(Boolean).join(' ').trim();
    if (cells.serial && /^\d{1,4}$/.test(cells.serial) && /^\d{8,20}$/.test(cells.accountNo || '')) {
      rows.push({
        page: line.page,
        serial: Number(cells.serial),
        accountNo: cells.accountNo,
        name,
        monthlyInstallment: parseAmount(cells.denomination),
        monthPaidUpTo: /^\d{1,4}$/.test(cells.monthPaid || '') ? Number(cells.monthPaid) : 0,
        nextDueDate: normalizePdfDate(cells.nextDue),
        nameFromWrappedLines: false
      });
      continue;
    }
    if (name && !HEADER_TEXT.has(name.toUpperCase())) orphans.push({ y: line.y, page: line.page, name });
  }

  const serialY = new Map();
  for (const line of lines) {
    const cells = lineCells(line);
    if (cells.serial && /^\d{1,4}$/.test(cells.serial) && /^\d{8,20}$/.test(cells.accountNo || '')) {
      serialY.set(Number(cells.serial), { y: line.y, page: line.page });
    }
  }

  const wrapped = new Map();
  const remaining = [];
  for (const orphan of orphans) {
    let target = null;
    let targetDistance = NAME_LINE_WINDOW + 1;
    for (const [serial, position] of serialY) {
      if (position.page !== orphan.page) continue;
      const distance = Math.abs(position.y - orphan.y);
      if (distance <= NAME_LINE_WINDOW && distance < targetDistance) {
        target = serial;
        targetDistance = distance;
      }
    }
    if (target === null) {
      remaining.push(orphan);
      continue;
    }
    if (!wrapped.has(target)) wrapped.set(target, []);
    wrapped.get(target).push({ y: orphan.y, name: orphan.name });
  }

  for (const [serial, parts] of wrapped) {
    const row = rows.find((candidate) => candidate.serial === serial);
    if (!row) continue;
    if (row.name) continue;
    row.name = parts.sort((a, b) => b.y - a.y).map((part) => part.name).join(' ').trim();
    row.nameFromWrappedLines = true;
  }

  const nearestSerialFor = (orphan) => {
    let best = null;
    let bestDistance = Infinity;
    for (const [serial, position] of serialY) {
      if (position.page !== orphan.page) continue;
      const distance = Math.abs(position.y - orphan.y);
      if (distance < bestDistance) {
        best = serial;
        bestDistance = distance;
      }
    }
    return best;
  };
  for (const orphan of remaining) {
    const serial = nearestSerialFor(orphan);
    const row = rows.find((candidate) => candidate.serial === serial);
    if (!row) continue;
    row.name = row.name ? `${row.name} ${orphan.name}` : orphan.name;
    row.nameFromWrappedLines = true;
  }

  return {
    printedOn,
    rows: rows.sort((a, b) => a.serial - b.serial)
  };
}

export function deriveDates(row, existingOpening = '') {
  const warnings = [];
  const paid = Number(row.monthPaidUpTo) || 0;
  const dueDate = parsePdfDate(row.nextDueDate);
  let opening = paid > 0 && dueDate ? formatPdfDate(shiftMonths(dueDate, -paid)) : '';
  if (!opening) {
    opening = normalizePdfDate(existingOpening);
    if (opening) warnings.push('opening-date-fallback');
    else warnings.push('opening-date-missing');
  }
  if (paid < 1) warnings.push('no-installments-yet');
  if (!row.nextDueDate) warnings.push('no-next-due-date');
  const term = paid > 0 ? Math.ceil(paid / RD_TERM_MONTHS) : 1;
  if (term > 1) warnings.push('extended-term');
  const maturity = opening ? formatPdfDate(shiftMonths(parsePdfDate(opening), RD_TERM_MONTHS * term)) : '';
  return { opening, maturity, term, warnings };
}

export function validateRows(rows) {
  const problems = [];
  if (!rows.length) {
    problems.push({ level: 'error', message: 'No deposit rows were found in the PDF.' });
    return problems;
  }
  const serials = rows.map((row) => row.serial);
  for (let index = 0; index < serials.length; index += 1) {
    if (serials[index] !== index + 1) {
      problems.push({ level: 'error', message: 'Row numbers are not sequential; the PDF layout may have changed.' });
      break;
    }
  }
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.accountNo)) problems.push({ level: 'error', message: `Account ${row.accountNo} appears twice in the PDF.` });
    seen.add(row.accountNo);
    if (!row.name) problems.push({ level: 'error', message: `Account ${row.accountNo} has no name.` });
    if (!Number.isFinite(row.monthlyInstallment) || row.monthlyInstallment <= 0 || row.monthlyInstallment > MAX_MONTHLY_INSTALLMENT) {
      problems.push({ level: 'error', message: `Account ${row.accountNo} has an unreadable denomination.` });
    }
    if (!Number.isInteger(row.monthPaidUpTo) || row.monthPaidUpTo < 0) {
      problems.push({ level: 'error', message: `Account ${row.accountNo} has an unreadable installment count.` });
    }
  }
  return problems;
}

export function planImport({ rows, printedOn, records, allowDecrease = false, liveCount = 0 }) {
  const problems = validateRows(rows);
  const byAccount = new Map(records.map((record) => [record.accountNo, record]));
  const seen = new Set();
  const changes = [];
  let decreases = 0;

  for (const row of rows) {
    seen.add(row.accountNo);
    const record = byAccount.get(row.accountNo);
    const derived = deriveDates(row, record?.opening || '');
    const balance = Math.round(row.monthlyInstallment * row.monthPaidUpTo * 100) / 100;
    if (!record) {
      changes.push({
        accountNo: row.accountNo,
        action: 'create',
        name: row.name,
        monthlyInstallment: row.monthlyInstallment,
        monthPaidUpTo: row.monthPaidUpTo,
        balanceBefore: 0,
        balanceAfter: balance,
        opening: derived.opening,
        maturity: derived.maturity,
        nameFromWrappedLines: row.nameFromWrappedLines,
        warnings: derived.warnings
      });
      continue;
    }
    const balanceBefore = record.balance || 0;
    const installmentsBefore = record.installments || 0;
    const installmentChanged = Math.abs((record.monthlyInstallment || 0) - row.monthlyInstallment) > 0.005;
    const nameChanged = (record.name || '').trim().toUpperCase() !== row.name.trim().toUpperCase();
    const countDropped = row.monthPaidUpTo < installmentsBefore;
    if (countDropped) decreases += 1;
    changes.push({
      accountNo: row.accountNo,
      action: record.deletedAt ? 'restore' : nameChanged || installmentChanged || balance !== balanceBefore || derived.opening !== (record.opening || '') ? 'update' : 'unchanged',
      name: row.name,
      monthlyInstallment: row.monthlyInstallment,
      monthPaidUpTo: row.monthPaidUpTo,
      installmentsBefore,
      balanceBefore,
      balanceAfter: balance,
      nameChanged,
      installmentChanged,
      opening: derived.opening,
      maturity: derived.maturity,
      nameFromWrappedLines: row.nameFromWrappedLines,
      warnings: countDropped ? [...derived.warnings, 'installments-decreased'] : derived.warnings
    });
  }

  if (decreases > 0) {
    problems.push({
      level: allowDecrease ? 'warn' : 'error',
      message: allowDecrease
        ? `${decreases} account(s) show fewer paid installments than the current balance.`
        : `${decreases} account(s) show fewer paid installments than the current balance. Re-run with decreases allowed if this is correct.`
    });
  }
  if (liveCount > 0 && rows.length < Math.floor(liveCount / 2)) {
    problems.push({ level: 'error', message: `The PDF has ${rows.length} rows but ${liveCount} live records exist. This looks like a partial or changed report.` });
  }

  const missing = records.filter((record) => !seen.has(record.accountNo) && !record.deletedAt);
  const counts = {
    rows: rows.length,
    created: changes.filter((change) => change.action === 'create').length,
    restored: changes.filter((change) => change.action === 'restore').length,
    updated: changes.filter((change) => change.action === 'update').length,
    unchanged: changes.filter((change) => change.action === 'unchanged').length,
    nameChanges: changes.filter((change) => change.nameChanged).length,
    installmentChanges: changes.filter((change) => change.installmentChanged).length,
    increases: changes.filter((change) => change.balanceAfter > change.balanceBefore).length,
    decreases,
    wrappedNames: changes.filter((change) => change.nameFromWrappedLines).length,
    missing: missing.length
  };
  const warnings = [];
  const seenWarning = new Set();
  for (const change of changes) {
    for (const warning of change.warnings) {
      if (warning === 'installments-decreased' || warning === 'extended-term') continue;
      if (seenWarning.has(warning)) continue;
      seenWarning.add(warning);
      warnings.push(warning);
    }
  }

  return {
    printedOn,
    batchId: `pdf-${printedOn ? printedOn.split('-').reverse().join('-') : 'import'}`,
    problems,
    warnings,
    counts,
    totals: {
      before: Math.round(changes.reduce((sum, change) => sum + change.balanceBefore, 0) * 100) / 100,
      after: Math.round(changes.reduce((sum, change) => sum + change.balanceAfter, 0) * 100) / 100
    },
    changes,
    missing: missing.map((record) => ({ id: record.id, accountNo: record.accountNo, name: record.name }))
  };
}
