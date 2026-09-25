import adminHtml from './public/admin.html';
import { normalizeDate, publicRecord } from './lookup.js';

const PUBLIC_ORIGINS = new Set([
  'https://thara-hangnung.github.io',
  'http://localhost:8784',
  'http://127.0.0.1:8784'
]);
const rateWindows = new Map();

function requestOrigin(request) {
  return new URL(request.url).origin;
}

function isAllowedOrigin(request, origin) {
  return !origin || origin === requestOrigin(request) || PUBLIC_ORIGINS.has(origin);
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    ...securityHeaders(),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, PATCH, DELETE',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
  if (origin && isAllowedOrigin(request, origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function textResponse(request, body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { ...corsHeaders(request), 'Content-Type': contentType } });
}

function allowPublicRequest(request) {
  const now = Date.now();
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    if (rateWindows.size > 5000) rateWindows.clear();
    return true;
  }
  current.count += 1;
  return current.count <= 20;
}

async function getAdminEmail(ctx, env) {
  const expected = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!expected || !ctx.access) return '';
  try {
    const identity = await ctx.access.getIdentity();
    const email = String(identity?.email || '').trim().toLowerCase();
    return email === expected ? email : '';
  } catch {
    return '';
  }
}

function requireSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === requestOrigin(request);
}

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function textValue(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateRecord(input, existing = {}) {
  const name = textValue(input.name ?? existing.name, 200);
  const accountNo = String(input.accountNo ?? existing.account_no ?? '').replace(/\s+/g, '');
  const cif = textValue(input.cif ?? existing.cif, 32);
  const dateOfOpening = normalizeDate(input.dateOfOpening ?? existing.date_of_opening);
  const maturityInput = input.dateOfMaturity ?? existing.date_of_maturity ?? '';
  const dateOfMaturity = maturityInput ? normalizeDate(maturityInput) : '';
  const dateOfBirth = normalizeDate(input.dateOfBirth ?? existing.date_of_birth);
  const monthlyInstallment = Number(input.monthlyInstallment ?? existing.monthly_installment);

  if (!name) throw new Error('Name is required.');
  if (!/^\d{8,20}$/.test(accountNo)) throw new Error('Account number must contain 8 to 20 digits.');
  if (!cif) throw new Error('CIF is required.');
  if (!dateOfOpening) throw new Error('Enter a valid opening date.');
  if (maturityInput && !dateOfMaturity) throw new Error('Enter a valid maturity date.');
  if (!dateOfBirth) throw new Error('Enter a valid date of birth.');
  if (!Number.isFinite(monthlyInstallment) || monthlyInstallment < 0 || monthlyInstallment > 10_000_000) {
    throw new Error('Enter a valid monthly installment.');
  }

  return { name, accountNo, cif, dateOfOpening, dateOfMaturity, dateOfBirth, monthlyInstallment };
}

function adminRecord(row) {
  return {
    id: Number(row.id),
    name: row.name,
    accountNo: row.account_no,
    cif: row.cif,
    dateOfOpening: row.date_of_opening,
    dateOfMaturity: row.date_of_maturity || '',
    dateOfBirth: row.date_of_birth,
    monthlyInstallment: Number(row.monthly_installment),
    manualDepositTotal: Number(row.manual_deposit_total || 0),
    manualDepositCount: Number(row.manual_deposit_count || 0),
    lastDepositDate: row.last_deposit_date || '',
    lastDepositBatchId: row.last_deposit_batch_id || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    deletedAt: row.deleted_at || null
  };
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 20_000) throw new Error('Request body is too large.');
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

async function audit(env, email, action, recordId = null, batchId = null) {
  await env.DB.prepare(`
    INSERT INTO admin_audit_log (admin_email, action, record_id, batch_id)
    VALUES (?, ?, ?, ?)
  `).bind(email, action, recordId, batchId).run();
}

function recordSelect(where = '') {
  return `
    SELECT id, name, account_no, cif, date_of_opening, date_of_maturity, date_of_birth,
           monthly_installment, created_at, updated_at, deleted_at,
           COALESCE((SELECT SUM(e.amount) FROM recurring_deposit_entries e
                     WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL), 0) AS manual_deposit_total,
           (SELECT COUNT(*) FROM recurring_deposit_entries e
            WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL) AS manual_deposit_count,
           (SELECT MAX(e.deposit_date) FROM recurring_deposit_entries e
            WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL) AS last_deposit_date,
           (SELECT e.batch_id FROM recurring_deposit_entries e
            WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL
            ORDER BY e.id DESC LIMIT 1) AS last_deposit_batch_id
    FROM recurring_deposits
    ${where}
  `;
}

async function listRecords(request, env) {
  const url = new URL(request.url);
  const query = textValue(url.searchParams.get('q'), 100);
  const includeDeleted = url.searchParams.get('includeDeleted') === '1';
  const page = parsePositiveInteger(url.searchParams.get('page'), 1, 100000);
  const pageSize = parsePositiveInteger(url.searchParams.get('pageSize'), 50, 100);
  const where = includeDeleted ? 'WHERE 1 = 1' : 'WHERE deleted_at IS NULL';
  const searchWhere = query
    ? `${where} AND (name LIKE ? OR account_no LIKE ? OR cif LIKE ?)`
    : where;
  const pattern = `%${query}%`;
  const countStatement = env.DB.prepare(`SELECT COUNT(*) AS total FROM recurring_deposits ${searchWhere}`);
  const count = query
    ? await countStatement.bind(pattern, pattern, pattern).first()
    : await countStatement.first();
  const records = await env.DB.prepare(`
    ${recordSelect(searchWhere)}
    ORDER BY name COLLATE NOCASE, id
    LIMIT ? OFFSET ?
  `).bind(...(query ? [pattern, pattern, pattern] : []), pageSize, (page - 1) * pageSize).all();

  return {
    records: (records.results || []).map(adminRecord),
    total: Number(count?.total || 0),
    page,
    pageSize
  };
}

async function getRecord(env, id, includeDeleted = true) {
  const where = includeDeleted ? 'WHERE id = ?' : 'WHERE id = ? AND deleted_at IS NULL';
  return env.DB.prepare(recordSelect(where)).bind(id).first();
}

async function createRecord(request, env, email) {
  if (!requireSameOrigin(request)) throw new Error('Invalid request origin.');
  const input = await readJson(request);
  const values = validateRecord(input);
  const inserted = await env.DB.prepare(`
    INSERT INTO recurring_deposits
      (name, account_no, cif, date_of_opening, date_of_maturity, date_of_birth, monthly_installment)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(values.name, values.accountNo, values.cif, values.dateOfOpening, values.dateOfMaturity, values.dateOfBirth, values.monthlyInstallment).first();
  const id = Number(inserted.id);
  await audit(env, email, 'create', id);
  return getRecord(env, id);
}

async function updateRecord(request, env, email, id) {
  if (!requireSameOrigin(request)) throw new Error('Invalid request origin.');
  const existing = await getRecord(env, id);
  if (!existing) return null;
  const input = await readJson(request);
  const values = validateRecord(input, existing);
  await env.DB.prepare(`
    UPDATE recurring_deposits
    SET name = ?, account_no = ?, cif = ?, date_of_opening = ?, date_of_maturity = ?,
        date_of_birth = ?, monthly_installment = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(values.name, values.accountNo, values.cif, values.dateOfOpening, values.dateOfMaturity, values.dateOfBirth, values.monthlyInstallment, id).run();
  await audit(env, email, 'update', id);
  return getRecord(env, id);
}

async function deleteRecord(env, email, id) {
  const result = await env.DB.prepare(`
    UPDATE recurring_deposits
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(id).run();
  if (!result.meta.changes) return false;
  await audit(env, email, 'delete', id);
  return true;
}

async function restoreRecord(env, email, id) {
  const result = await env.DB.prepare(`
    UPDATE recurring_deposits
    SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NOT NULL
  `).bind(id).run();
  if (!result.meta.changes) return false;
  await audit(env, email, 'restore', id);
  return true;
}

function normalizeAdminDate(value) {
  const iso = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return normalizeDate(`${iso[3]}-${iso[2]}-${iso[1]}`);
  return normalizeDate(value);
}

function normalizedDateToIso(value) {
  const [day, month, year] = value.split('-');
  return `${year}-${month}-${day}`;
}

function recordIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 100);
}

async function createDepositBatch(request, env, email) {
  if (!requireSameOrigin(request)) throw new Error('Invalid request origin.');
  const input = await readJson(request);
  const ids = recordIdList(input.recordIds);
  const depositDate = normalizeAdminDate(input.depositDate);
  const todayIso = new Date().toISOString().slice(0, 10);
  if (!ids.length) throw new Error('Select at least one active record.');
  if (!depositDate || normalizedDateToIso(depositDate) > todayIso) throw new Error('Choose a valid deposit date that is not in the future.');
  const placeholders = ids.map(() => '?').join(',');
  const records = await env.DB.prepare(`
    SELECT id, monthly_installment
    FROM recurring_deposits
    WHERE id IN (${placeholders}) AND deleted_at IS NULL
  `).bind(...ids).all();
  if (!records.results?.length) throw new Error('No active records were found.');
  const batchId = crypto.randomUUID();
  const statements = records.results.map(record => env.DB.prepare(`
    INSERT INTO recurring_deposit_entries (record_id, amount, deposit_date, batch_id, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(record.id, Number(record.monthly_installment || 0), depositDate, batchId, email));
  await env.DB.batch(statements);
  await audit(env, email, 'deposit_batch', null, batchId);
  return {
    batchId,
    depositDate,
    records: records.results.length,
    totalAmount: records.results.reduce((sum, record) => sum + Number(record.monthly_installment || 0), 0)
  };
}

async function reverseDepositBatch(request, env, email) {
  if (!requireSameOrigin(request)) throw new Error('Invalid request origin.');
  const input = await readJson(request);
  const batchId = String(input.batchId ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Invalid deposit batch.');
  const result = await env.DB.prepare(`
    UPDATE recurring_deposit_entries
    SET reversed_at = CURRENT_TIMESTAMP, reversed_by = ?
    WHERE batch_id = ? AND reversed_at IS NULL
  `).bind(email, batchId).run();
  if (!result.meta.changes) throw new Error('Deposit batch was already reversed or not found.');
  await audit(env, email, 'reverse_deposit_batch', null, batchId);
  return { batchId, reversed: result.meta.changes };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportRecords(request, env, email) {
  const url = new URL(request.url);
  const includeDeleted = url.searchParams.get('includeDeleted') === '1';
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const result = await env.DB.prepare(`${recordSelect(where)} ORDER BY name COLLATE NOCASE, id`).all();
  const header = ['Name', 'Account number', 'CIF', 'Date of birth', 'Opening date', 'Maturity date', 'Monthly installment', 'Manual deposits', 'Manual deposit count', 'Last deposit date'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of result.results || []) {
    lines.push([
      row.name,
      row.account_no,
      row.cif,
      row.date_of_birth,
      row.date_of_opening,
      row.date_of_maturity || '',
      row.monthly_installment,
      row.manual_deposit_total,
      row.manual_deposit_count,
      row.last_deposit_date || ''
    ].map(csvCell).join(','));
  }
  await audit(env, email, 'export');
  return new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="recurring-deposits.csv"'
    }
  });
}

async function serveAdmin(request) {
  return new Response(adminHtml, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

async function handleAdminApi(request, env, ctx, url) {
  const email = await getAdminEmail(ctx, env);
  if (!email) return jsonResponse(request, { code: 'unauthorized', error: 'Administrator access is required.' }, 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requireSameOrigin(request)) {
    return jsonResponse(request, { code: 'forbidden', error: 'Invalid request origin.' }, 403);
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/session') {
    return jsonResponse(request, { email });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/records') {
    return jsonResponse(request, await listRecords(request, env));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/records') {
    try {
      const row = await createRecord(request, env, email);
      return jsonResponse(request, { record: adminRecord(row) }, 201);
    } catch (error) {
      const message = error?.message || 'Could not create record.';
      const conflict = message.includes('UNIQUE');
      return jsonResponse(request, { code: conflict ? 'conflict' : 'invalid', error: conflict ? 'An account number and date of birth already exist.' : message }, conflict ? 409 : 400);
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/export') {
    return exportRecords(request, env, email);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/audit') {
    const result = await env.DB.prepare('SELECT id, admin_email, action, record_id, batch_id, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 100').all();
    return jsonResponse(request, { entries: result.results || [] });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/records/deposit') {
    try {
      return jsonResponse(request, await createDepositBatch(request, env, email), 201);
    } catch (error) {
      return jsonResponse(request, { error: error?.message || 'Could not record deposits.' }, 400);
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/deposits/reverse') {
    try {
      return jsonResponse(request, await reverseDepositBatch(request, env, email));
    } catch (error) {
      return jsonResponse(request, { error: error?.message || 'Could not reverse deposits.' }, 400);
    }
  }

  const match = url.pathname.match(/^\/api\/admin\/records\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (request.method === 'GET') {
      const row = await getRecord(env, id, true);
      return row ? jsonResponse(request, { record: adminRecord(row) }) : jsonResponse(request, { error: 'Record not found.' }, 404);
    }
    if (request.method === 'PATCH') {
      try {
        const row = await updateRecord(request, env, email, id);
        return row ? jsonResponse(request, { record: adminRecord(row) }) : jsonResponse(request, { error: 'Record not found.' }, 404);
      } catch (error) {
        return jsonResponse(request, { error: error?.message || 'Could not update record.' }, 400);
      }
    }
    if (request.method === 'DELETE') {
      const changed = await deleteRecord(env, email, id);
      return changed ? jsonResponse(request, { deleted: true }) : jsonResponse(request, { error: 'Record not found or already deleted.' }, 404);
    }
  }

  const restoreMatch = url.pathname.match(/^\/api\/admin\/records\/(\d+)\/restore$/);
  if (request.method === 'POST' && restoreMatch) {
    const changed = await restoreRecord(env, email, Number(restoreMatch[1]));
    return changed ? jsonResponse(request, { restored: true }) : jsonResponse(request, { error: 'Record not found or is not deleted.' }, 404);
  }

  return jsonResponse(request, { error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (!isAllowedOrigin(request, origin)) return textResponse(request, 'Forbidden', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return jsonResponse(request, { ok: true });

    if (url.pathname === '/admin' || url.pathname === '/admin.html' || url.pathname.startsWith('/admin/')) {
      const email = await getAdminEmail(ctx, env);
      if (!email) return textResponse(request, 'Administrator access is required.', 403);
      return serveAdmin(request);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdminApi(request, env, ctx, url);
    }

    if (request.method !== 'POST' || url.pathname !== '/api/lookup') {
      return jsonResponse(request, { error: 'Not found' }, 404);
    }
    if (!allowPublicRequest(request)) {
      return jsonResponse(request, { code: 'rate-limit', error: 'Please try again later.' }, 429);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return jsonResponse(request, { code: 'invalid', error: 'Enter a valid account number and date of birth.' }, 400);
    }

    const accountNo = String(input?.accountNo ?? '').replace(/\s+/g, '');
    const dateOfBirth = normalizeDate(input?.dateOfBirth);
    if (!/^\d{8,14}$/.test(accountNo) || !dateOfBirth) {
      return jsonResponse(request, { code: 'invalid', error: 'Enter a valid account number and date of birth.' }, 400);
    }

    try {
      const record = await env.DB.prepare(`
        SELECT name, account_no, cif, date_of_opening, date_of_maturity, date_of_birth, monthly_installment,
               COALESCE((SELECT SUM(e.amount) FROM recurring_deposit_entries e
                         WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL), 0) AS manual_deposit_total,
               (SELECT COUNT(*) FROM recurring_deposit_entries e
                WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL) AS manual_deposit_count,
               (SELECT MAX(e.deposit_date) FROM recurring_deposit_entries e
                WHERE e.record_id = recurring_deposits.id AND e.reversed_at IS NULL) AS last_deposit_date
        FROM recurring_deposits
        WHERE account_no = ? AND date_of_birth = ? AND deleted_at IS NULL
        LIMIT 1
      `).bind(accountNo, dateOfBirth).first();
      if (!record) return jsonResponse(request, { code: 'not-found', error: 'No matching recurring deposit was found.' }, 404);
      return jsonResponse(request, publicRecord(record));
    } catch {
      return jsonResponse(request, { code: 'server', error: 'Lookup service is temporarily unavailable.' }, 500);
    }
  }
};
