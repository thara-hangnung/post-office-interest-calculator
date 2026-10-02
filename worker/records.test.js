import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Runs the real SQL out of index.js against schema.sql, so a column that goes
// NOT NULL (or a same-name rule that stops matching) fails here, not on D1.
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const worker = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const sql = (marker) => {
  const start = worker.indexOf(marker);
  if (start < 0) throw new Error(`could not find SQL in index.js: ${marker}`);
  const end = worker.indexOf('`', start);
  return worker.slice(start, end);
};

db.prepare(sql('INSERT INTO recurring_deposits (name, account_no, cif'))
  .run(JSON.stringify([{ a: '020000000099', n: 'KUNJAMMA', m: 500, o: '01-01-2020', y: '' }]));
const pdfCreated = db.prepare('SELECT cif, date_of_birth, needs_details FROM recurring_deposits WHERE account_no = ?').get('020000000099');
if (pdfCreated.cif !== '' || pdfCreated.date_of_birth !== '' || Number(pdfCreated.needs_details) !== 1) {
  throw new Error(`PDF-created record must start blank and needs_details: ${JSON.stringify(pdfCreated)}`);
}

const conflictCheck = sql('SELECT account_no FROM recurring_deposits');
const fillBlanks = sql('UPDATE recurring_deposits\n    SET cif = ?');
const name = 'KUNJAMMA';
const birth = '12-05-1985';
const cif = '1234567890';
const sameName = (...binds) => db.prepare(conflictCheck).all(name, ...binds);

// Blank sibling: no conflict, and it inherits the saved identity.
if (sameName(0, cif, birth).length) throw new Error('blank same-name record must not count as a conflict');
db.prepare(fillBlanks).run(cif, birth, name, 0);
const filled = db.prepare('SELECT cif, date_of_birth, needs_details FROM recurring_deposits WHERE account_no = ?').get('020000000099');
if (filled.cif !== cif || filled.date_of_birth !== birth || Number(filled.needs_details) !== 0) {
  throw new Error(`same-name record must inherit CIF and DOB: ${JSON.stringify(filled)}`);
}

// A sibling that already disagrees is a conflict, never a silent overwrite.
db.prepare('INSERT INTO recurring_deposits (name, account_no, cif, date_of_opening, date_of_birth, monthly_installment) VALUES (?, ?, ?, ?, ?, ?)').run('kunjamma', '020000000098', '999', '01-01-2020', '01-01-1990', 500);
if (sameName(0, cif, birth).map((row) => row.account_no).join() !== '020000000098') {
  throw new Error('conflict must name the account that disagrees');
}
if (sameName(0, '999', '01-01-1990').map((row) => row.account_no).join() !== '020000000099') {
  throw new Error('the filled sibling must conflict once it holds different details');
}
const solo = db.prepare('INSERT INTO recurring_deposits (name, account_no, cif, date_of_opening, date_of_birth, monthly_installment) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').get('SOLO', '020000000097', '555', '01-01-2020', '02-02-1991', 500);
if (db.prepare(conflictCheck).all('SOLO', Number(solo.id), '555', '02-02-1991').length) throw new Error('a record must not conflict with itself');

console.log('worker record tests passed');
