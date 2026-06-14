#!/usr/bin/env node
/* API QA for QR-based customer pickup signing. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function loadEnvForDb() {
  let inferredEnv = '.env';
  try {
    if (new URL(BASE).port === '8783') inferredEnv = '.env.codex-qa';
  } catch (err) {
    inferredEnv = '.env';
  }
  const envFile = process.env.ENV_FILE
    ? path.resolve(ROOT, process.env.ENV_FILE)
    : path.join(ROOT, 'backend', inferredEnv);
  if (!fs.existsSync(envFile)) return;
  const backendDir = path.join(ROOT, 'backend');
  const text = fs.readFileSync(envFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if ((key === 'DB_PATH' || key === 'UPLOADS_DIR') && value && !path.isAbsolute(value)) {
      value = path.resolve(backendDir, value);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvForDb();
const db = require('../backend/db');

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function expectStatus(apiPath, status, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  if (res.status !== status) {
    throw new Error(`${apiPath} expected ${status} got ${res.status}: ${text}`);
  }
  try { return text ? JSON.parse(text) : null; } catch (_) { return text; }
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

function tokenFromUrl(url) {
  const parsed = new URL(url);
  return parsed.searchParams.get('t');
}

async function login(name, password) {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: name, password }),
  });
}

async function createReadyOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% pickup qr sign qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260608 QR Sign PO QR-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers: auth(session) });
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: detail.order.pieces.map((piece) => piece.id) }),
  });
  await api(`/api/orders/${created.order.id}/ready`, { method: 'POST', headers: auth(session) });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

async function createCustomer(session, stamp, suffix = '') {
  const body = {
    company: `QR Sign QA ${stamp}${suffix}`,
    contact_name: 'Private Contact',
    phone: `403-555-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    email: `qr-sign-${stamp}${suffix}@example.test`,
  };
  return api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRequest(session, pieceIds) {
  return api('/api/pickups/sign-requests', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: pieceIds }),
  });
}

function assertPublicSummarySafe(publicData) {
  const raw = JSON.stringify(publicData);
  for (const forbidden of ['customer_phone', 'customer_email', 'email', 'phone', 'Private Contact']) {
    if (raw.includes(forbidden)) throw new Error(`public sign payload leaked ${forbidden}: ${raw}`);
  }
  if (!publicData.customer || !publicData.customer.company) {
    throw new Error(`public sign payload missing company: ${raw}`);
  }
  if (!Array.isArray(publicData.orders) || !publicData.orders.length) {
    throw new Error(`public sign payload missing orders: ${raw}`);
  }
}

(async () => {
  const boss = await login('admin', 'admin123');
  const worker = await login('worker', 'worker123');
  const headers = auth(boss);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customerRes = await createCustomer(boss, stamp);
  const customerId = customerRes.customer.id;
  const orderA = await createReadyOrder(boss, customerId, stamp, 'A');
  const orderB = await createReadyOrder(boss, customerId, stamp, 'B');
  const pickA = orderA.order.pieces[0].id;
  const pickB = orderB.order.pieces[1].id;

  await expectStatus('/api/pickups/sign-requests', 401, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pickA] }),
  });
  await expectStatus('/api/pickups/sign-requests', 403, {
    method: 'POST',
    headers: { ...auth(worker), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pickA] }),
  });

  const signReq = await createRequest(boss, [pickA, pickB]);
  const request = signReq.request;
  if (!request.sign_url || !request.qr_svg || request.status !== 'pending' || request.total_pieces !== 2) {
    throw new Error(`invalid sign request response: ${JSON.stringify(request)}`);
  }
  if (!/customer-sign\.html\?t=/.test(request.sign_url) || !/<svg[\s\S]*<\/svg>/.test(request.qr_svg)) {
    throw new Error('sign request did not include customer page url and qr svg');
  }
  const token = tokenFromUrl(request.sign_url);
  if (!token || token.length < 30) throw new Error(`weak or missing token: ${token}`);
  const stored = db.prepare('SELECT token_hash FROM pickup_sign_requests WHERE id = ?').get(request.id);
  if (!stored || stored.token_hash === token || stored.token_hash.length !== 64) {
    throw new Error(`token was not stored as sha256 hash: ${JSON.stringify(stored)}`);
  }

  const publicData = await api(`/api/pickups/sign/${encodeURIComponent(token)}`);
  assertPublicSummarySafe(publicData);
  if (publicData.summary.total_pieces !== 2 || publicData.summary.order_count !== 2) {
    throw new Error(`unexpected public summary: ${JSON.stringify(publicData.summary)}`);
  }

  await expectStatus(`/api/pickups/sign/${encodeURIComponent(token)}`, 400, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signer_name: 'QR QA' }),
  });
  const signed = await api(`/api/pickups/sign/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signer_name: 'QR QA Signer',
      signer_phone: '403-555-1100',
      signature_base64: SIG,
    }),
  });
  if (!signed.batch_id || signed.status !== 'signed') throw new Error(`invalid signed response: ${JSON.stringify(signed)}`);
  await expectStatus(`/api/pickups/sign/${encodeURIComponent(token)}`, 410);
  await expectStatus(`/api/pickups/sign/${encodeURIComponent(token)}`, 410, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signer_name: 'Replay', signature_base64: SIG }),
  });

  const polled = await api(`/api/pickups/sign-requests/${request.id}`, { headers });
  if (polled.request.status !== 'signed' || Number(polled.request.pickup_batch_id) !== Number(signed.batch_id)) {
    throw new Error(`boss poll did not show signed batch: ${JSON.stringify(polled)}`);
  }
  const batch = await api(`/api/pickups/batches/${signed.batch_id}`, { headers });
  if (batch.batch.items.length !== 2 || !batch.batch.signature_path || !batch.batch.slip_pdf_path) {
    throw new Error(`signed batch missing items/signature/slip: ${JSON.stringify(batch.batch)}`);
  }
  const afterA = await api(`/api/orders/${orderA.order.id}`, { headers });
  const afterB = await api(`/api/orders/${orderB.order.id}`, { headers });
  if (afterA.order.picked_pieces !== 1 || afterB.order.picked_pieces !== 1) {
    throw new Error(`expected partial pickup after QR sign, got ${afterA.order.picked_pieces}/${afterB.order.picked_pieces}`);
  }

  const cancelCustomer = await createCustomer(boss, stamp, '-cancel');
  const cancelOrder = await createReadyOrder(boss, cancelCustomer.customer.id, stamp, 'CANCEL');
  const cancelReq = await createRequest(boss, [cancelOrder.order.pieces[0].id]);
  const cancelToken = tokenFromUrl(cancelReq.request.sign_url);
  const cancelled = await api(`/api/pickups/sign-requests/${cancelReq.request.id}/cancel`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'qa cancel' }),
  });
  if (cancelled.request.status !== 'cancelled') throw new Error(`cancel failed: ${JSON.stringify(cancelled)}`);
  await expectStatus(`/api/pickups/sign/${encodeURIComponent(cancelToken)}`, 410);
  await expectStatus(`/api/pickups/sign/${encodeURIComponent(cancelToken)}`, 410, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signer_name: 'Cancelled', signature_base64: SIG }),
  });

  const expireCustomer = await createCustomer(boss, stamp, '-expire');
  const expireOrder = await createReadyOrder(boss, expireCustomer.customer.id, stamp, 'EXPIRE');
  const expireReq = await createRequest(boss, [expireOrder.order.pieces[0].id]);
  const expireToken = tokenFromUrl(expireReq.request.sign_url);
  db.prepare(`
    UPDATE pickup_sign_requests
    SET expires_at = datetime('now', '-1 minute')
    WHERE id = ?
  `).run(expireReq.request.id);
  await expectStatus(`/api/pickups/sign/${encodeURIComponent(expireToken)}`, 410);
  const expiredPoll = await api(`/api/pickups/sign-requests/${expireReq.request.id}`, { headers });
  if (expiredPoll.request.status !== 'expired') throw new Error(`expired poll failed: ${JSON.stringify(expiredPoll)}`);

  const holdCustomer = await createCustomer(boss, stamp, '-hold');
  const holdOrder = await createReadyOrder(boss, holdCustomer.customer.id, stamp, 'HOLD');
  const holdPiece = holdOrder.order.pieces[0].id;
  await api('/api/pickups/hold-order', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: holdOrder.order.id, hold: true }),
  });
  await expectStatus('/api/pickups/sign-requests', 400, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [holdPiece] }),
  });

  console.log(`PICKUP QR SIGN QA PASS customer=${customerId} batch=${signed.batch_id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
