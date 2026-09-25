import { normalizeDate, publicRecord } from './lookup.js';

const ALLOWED_ORIGINS = new Set([
  'https://thara-hangnung.github.io',
  'http://localhost:8784',
  'http://127.0.0.1:8784'
]);
const rateWindows = new Map();

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function allowRequest(request) {
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response('Forbidden', { status: 403 });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(request, { ok: true });
    }
    if (request.method !== 'POST' || url.pathname !== '/api/lookup') {
      return jsonResponse(request, { error: 'Not found' }, 404);
    }
    if (!allowRequest(request)) {
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
        SELECT name, account_no, cif, date_of_opening, date_of_maturity, date_of_birth, monthly_installment
        FROM recurring_deposits
        WHERE account_no = ? AND date_of_birth = ?
        LIMIT 1
      `).bind(accountNo, dateOfBirth).first();
      if (!record) return jsonResponse(request, { code: 'not-found', error: 'No matching recurring deposit was found.' }, 404);
      return jsonResponse(request, publicRecord(record));
    } catch {
      return jsonResponse(request, { code: 'server', error: 'Lookup service is temporarily unavailable.' }, 500);
    }
  }
};
