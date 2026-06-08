#!/usr/bin/env node
/* Security regression checks for launch-blocking QA findings. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8781';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const PNG_1X1 = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'frontend', 'icons', 'icon-192.png')).toString('base64')}`;

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function request(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  return { res, data };
}

async function api(apiPath, opts = {}) {
  const { res, data } = await request(apiPath, opts);
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function expectStatus(label, apiPath, expected, opts = {}) {
  const { res, data } = await request(apiPath, opts);
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function login(name, password) {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: name, password }),
  });
}

async function loginAny(candidates) {
  let lastError = null;
  for (const item of candidates) {
    try {
      return await login(item[0], item[1]);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('login failed');
}

function uniquePdf(stamp) {
  return Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% security regression ${stamp}\n`),
  ]);
}

async function createCustomer(boss, stamp) {
  const data = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Security QA ${stamp}`,
      contact_name: 'QA',
      email: `security-${stamp}@example.test`,
    }),
  });
  return data.customer;
}

async function createOrder(boss, customerId, stamp) {
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('pdf', new File([uniquePdf(`${stamp}-valid`)], `Glass Order - 260612 Security QA PO SEC-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(boss), body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers: auth(boss) });
  return detail.order;
}

async function expectBadPriority(boss, customerId, stamp) {
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'bad');
  form.set('pdf', new File([uniquePdf(`${stamp}-bad-priority`)], `Glass Order - 260613 Security Bad PO SECBAD-${stamp}.pdf`, { type: 'application/pdf' }));
  await expectStatus('invalid priority', '/api/orders', 400, {
    method: 'POST',
    headers: auth(boss),
    body: form,
  });
}

async function main() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const worker = await loginAny([['worker', 'worker123'], ['workerdemo', 'worker123456']]);
  const customer = await createCustomer(boss, stamp);
  await expectBadPriority(boss, customer.id, stamp);
  const order = await createOrder(boss, customer.id, stamp);
  const pieceIds = order.pieces.map((piece) => piece.id);
  const drawingPath = order.pieces[0].drawing_path;

  await expectStatus('worker order list forbidden', '/api/orders', 403, { headers: auth(worker) });
  await expectStatus('worker order stats forbidden', '/api/orders/stats', 403, { headers: auth(worker) });
  await expectStatus('worker order detail forbidden', `/api/orders/${order.id}`, 403, { headers: auth(worker) });
  await expectStatus('worker customer list forbidden', '/api/customers', 403, { headers: auth(worker) });
  const workerPieces = await api(`/api/pieces?order_id=${order.id}`, { headers: auth(worker) });
  if (!workerPieces.pieces || workerPieces.pieces.length !== pieceIds.length) {
    throw new Error('worker pieces endpoint no longer returns the job grid');
  }

  await expectStatus('anonymous drawing forbidden', drawingPath, 401);
  await expectStatus('worker drawing allowed', drawingPath, 200, { headers: auth(worker) });
  await expectStatus('boss drawing allowed', drawingPath, 200, { headers: auth(boss) });
  await expectStatus('anonymous source pdf forbidden', order.pdf_path, 401);
  await expectStatus('worker source pdf forbidden', order.pdf_path, 403, { headers: auth(worker) });
  await expectStatus('boss source pdf allowed', order.pdf_path, 200, { headers: auth(boss) });

  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: pieceIds }),
  });
  await api(`/api/orders/${order.id}/ready`, { method: 'POST', headers: auth(boss) });

  await expectStatus('single pickup invalid png', `/api/orders/${order.id}/pickup`, 400, {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ signer_name: 'Bad Signature', signature_base64: 'abc' }),
  });
  await expectStatus('batch pickup invalid png', '/api/pickups/batches', 400, {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pieceIds[0]], signer_name: 'Bad Signature', signature_base64: 'abc' }),
  });

  const batchData = await api('/api/pickups/batches', {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pieceIds[0]], signer_name: 'Security Signer', signature_base64: PNG_1X1 }),
  });
  const batch = batchData.batch;
  if (!batch || !batch.slip_pdf_path || !batch.signature_path) throw new Error('valid pickup batch did not produce files');

  await expectStatus('anonymous slip forbidden', batch.slip_pdf_path, 401);
  await expectStatus('worker slip forbidden', batch.slip_pdf_path, 403, { headers: auth(worker) });
  await expectStatus('boss slip allowed', batch.slip_pdf_path, 200, { headers: auth(boss) });
  await expectStatus('anonymous signature forbidden', batch.signature_path, 401);
  await expectStatus('worker signature forbidden', batch.signature_path, 403, { headers: auth(worker) });
  await expectStatus('boss signature allowed', batch.signature_path, 200, { headers: auth(boss) });

  const noSignatureBatchData = await api('/api/pickups/batches', {
    method: 'POST',
    headers: { ...auth(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pieceIds[1]], signer_name: 'No Signature Signer' }),
  });
  const noSignatureBatch = noSignatureBatchData.batch;
  if (!noSignatureBatch || !noSignatureBatch.slip_pdf_path || noSignatureBatch.signature_path) {
    throw new Error(`unsigned pickup batch should create slip without signature_path: ${JSON.stringify(noSignatureBatch)}`);
  }
  await expectStatus('unsigned slip boss allowed', noSignatureBatch.slip_pdf_path, 200, { headers: auth(boss) });

  console.log(`SECURITY REGRESSION PASS order=${order.id} batch=${batch.id}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
