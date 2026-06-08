#!/usr/bin/env node
/* API smoke for piece-level cross-order pickup batches. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8781';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = text;
  }
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
  return text ? JSON.parse(text) : null;
}

async function login(loginName, password) {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
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

function headers(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% pickup batch smoke ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('note', `pickup batch smoke ${suffix}`);
  form.set('pdf', new File([pdf], `Glass Order - 260606 Pickup Batch PO PBS-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: headers(session), body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers: headers(session) });
  const pieceIds = detail.order.pieces.map((piece) => piece.id);
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...headers(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: pieceIds }),
  });
  await api(`/api/orders/${created.order.id}/ready`, { method: 'POST', headers: headers(session) });
  return api(`/api/orders/${created.order.id}`, { headers: headers(session) });
}

(async () => {
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const worker = await loginAny([['worker', 'worker123'], ['workerdemo', 'worker123456']]);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customer = await api('/api/customers', {
    method: 'POST',
    headers: { ...headers(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Pickup Batch Smoke ${stamp}`,
      contact_name: 'QA',
      email: `pickup-batch-${stamp}@example.test`,
    }),
  });
  const orderA = await createOrder(boss, customer.customer.id, stamp, 'A');
  const orderB = await createOrder(boss, customer.customer.id, stamp, 'B');
  const pickA = orderA.order.pieces[0].id;
  const pickB = orderB.order.pieces[1].id;

  const available = await api(`/api/pickups/available?customer_id=${customer.customer.id}`, { headers: headers(boss) });
  if (available.total_pieces !== 16 || available.orders.length !== 2) {
    throw new Error(`expected 16 available pieces across 2 orders, got ${available.total_pieces}/${available.orders.length}`);
  }

  await expectStatus('/api/pickups/available?customer_id=1', 403, { headers: headers(worker) });

  const batchRes = await api('/api/pickups/batches', {
    method: 'POST',
    headers: { ...headers(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      piece_ids: [pickA, pickB],
      signer_name: 'Smoke Pickup',
      signer_phone: '403-555-0130',
    }),
  });
  const batch = batchRes.batch;
  if (!batch || batch.items.length !== 2 || !batch.slip_pdf_path || batch.signature_path) {
    throw new Error('unsigned batch create missing items/slip or unexpectedly stored signature');
  }
  const afterA = await api(`/api/orders/${orderA.order.id}`, { headers: headers(boss) });
  const afterB = await api(`/api/orders/${orderB.order.id}`, { headers: headers(boss) });
  if (afterA.order.picked_pieces !== 1 || afterB.order.picked_pieces !== 1) {
    throw new Error(`expected one picked piece in each order, got ${afterA.order.picked_pieces}/${afterB.order.picked_pieces}`);
  }
  if (afterA.order.pickup_status !== 'partial' || afterB.order.pickup_status !== 'partial') {
    throw new Error(`expected partial statuses, got ${afterA.order.pickup_status}/${afterB.order.pickup_status}`);
  }

  await expectStatus(`/api/orders/${orderA.order.id}/archive`, 400, { method: 'POST', headers: headers(boss) });

  const revert = await api(`/api/pickups/batches/${batch.id}/revert`, {
    method: 'POST',
    headers: { ...headers(boss), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [pickA], reason: 'smoke partial revert' }),
  });
  if (revert.reverted !== 1) throw new Error('expected one reverted pickup item');
  const revertedA = await api(`/api/orders/${orderA.order.id}`, { headers: headers(boss) });
  const stillB = await api(`/api/orders/${orderB.order.id}`, { headers: headers(boss) });
  if (revertedA.order.picked_pieces !== 0 || revertedA.order.pickup_status !== 'ready') {
    throw new Error(`expected order A ready after piece revert, got ${revertedA.order.picked_pieces}/${revertedA.order.pickup_status}`);
  }
  if (stillB.order.picked_pieces !== 1 || stillB.order.pickup_status !== 'partial') {
    throw new Error(`expected order B still partial, got ${stillB.order.picked_pieces}/${stillB.order.pickup_status}`);
  }

  await expectStatus(`/api/pickups/batches/${batch.id}/revert`, 403, {
    method: 'POST',
    headers: { ...headers(worker), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'worker should fail' }),
  });

  console.log(`PICKUP BATCH SMOKE PASS customer=${customer.customer.id} batch=${batch.id} orders=${orderA.order.id},${orderB.order.id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
