#!/usr/bin/env node
/* QA for the default cut -> edge -> tempered -> polish -> finished workflow. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

(async () => {
  const session = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
  const headers = auth(session);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const customerRes = await api('/api/customers', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Workflow QA ${stamp}`,
      contact_name: 'QA',
      email: `workflow-${stamp}@example.test`,
    }),
  });

  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% workflow qa ${stamp}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerRes.customer.id));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260603 Workflow QA PO WF-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers, body: form });
  let detail = await api(`/api/orders/${created.order.id}`, { headers });
  const piece = detail.order.pieces[0];
  if (!piece.required_steps.includes('polish')) {
    throw new Error(`new order piece missing polish: ${JSON.stringify(piece.required_steps)}`);
  }
  if (piece.required_steps.join(',') !== 'cut,edge,tempered,polish') {
    throw new Error(`unexpected default workflow: ${piece.required_steps.join(',')}`);
  }

  const expectedStages = ['edge', 'tempered', 'polish', 'finished'];
  let current = piece;
  for (let i = 0; i < expectedStages.length; i += 1) {
    const advanced = await api(`/api/pieces/${current.id}/advance`, {
      method: 'POST',
      headers,
    });
    current = advanced.piece;
    if (current.stage !== expectedStages[i]) {
      throw new Error(`advance ${i + 1} expected ${expectedStages[i]}, got ${current.stage}`);
    }
  }

  const polishQueue = await api(`/api/pieces?stage=polish&order_id=${created.order.id}`, { headers });
  if (polishQueue.pieces.some((row) => Number(row.id) === Number(piece.id))) {
    throw new Error('finished piece should no longer appear in polish queue');
  }

  const secondPiece = detail.order.pieces[1];
  for (let i = 0; i < 3; i += 1) {
    await api(`/api/pieces/${secondPiece.id}/advance`, { method: 'POST', headers });
  }
  const polishQueueAfter = await api(`/api/pieces?stage=polish&order_id=${created.order.id}`, { headers });
  if (!polishQueueAfter.pieces.some((row) => Number(row.id) === Number(secondPiece.id))) {
    throw new Error('piece should appear in polish queue after third advance');
  }

  detail = await api(`/api/orders/${created.order.id}`, { headers });
  const secondAfter = detail.order.pieces.find((row) => Number(row.id) === Number(secondPiece.id));
  if (!secondAfter || secondAfter.next_step !== 'polish') {
    throw new Error(`expected second piece next_step polish, got ${secondAfter && secondAfter.next_step}`);
  }

  console.log(`PIECE WORKFLOW QA PASS order=${created.order.id} piece=${piece.id} polish_piece=${secondPiece.id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
