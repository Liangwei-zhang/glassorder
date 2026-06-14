#!/usr/bin/env node
/* QA for default workflow plus optional polishing and finished-piece corrections. */
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
  if (piece.required_steps.includes('polish')) {
    throw new Error(`new order piece should not require polish by default: ${JSON.stringify(piece.required_steps)}`);
  }
  if (piece.required_steps.join(',') !== 'cut,edge,tempered') {
    throw new Error(`unexpected default workflow: ${piece.required_steps.join(',')}`);
  }

  const expectedStages = ['edge', 'tempered', 'finished'];
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
    throw new Error('default finished piece should not appear in polish queue');
  }

  const secondPiece = detail.order.pieces[1];
  for (let i = 0; i < 3; i += 1) {
    await api(`/api/pieces/${secondPiece.id}/advance`, { method: 'POST', headers });
  }
  const sentPolish = await api(`/api/pieces/${secondPiece.id}/send-polish`, { method: 'POST', headers });
  if (sentPolish.piece.stage !== 'polish') {
    throw new Error(`send-polish expected stage polish, got ${sentPolish.piece.stage}`);
  }
  if (!sentPolish.piece.required_steps.includes('polish') || sentPolish.piece.next_step !== 'polish') {
    throw new Error(`send-polish did not add optional polish: ${JSON.stringify(sentPolish.piece.required_steps)} next=${sentPolish.piece.next_step}`);
  }
  const polishQueueAfter = await api(`/api/pieces?stage=polish&order_id=${created.order.id}`, { headers });
  if (!polishQueueAfter.pieces.some((row) => Number(row.id) === Number(secondPiece.id))) {
    throw new Error('piece should appear in polish queue after send-polish');
  }
  const polished = await api(`/api/pieces/${secondPiece.id}/advance`, { method: 'POST', headers });
  if (polished.piece.stage !== 'finished') {
    throw new Error(`polish advance expected finished, got ${polished.piece.stage}`);
  }

  detail = await api(`/api/orders/${created.order.id}`, { headers });
  const secondAfter = detail.order.pieces.find((row) => Number(row.id) === Number(secondPiece.id));
  if (!secondAfter || secondAfter.stage !== 'finished' || secondAfter.next_step !== null) {
    throw new Error(`expected second piece finished after polishing, got ${secondAfter && secondAfter.stage} next=${secondAfter && secondAfter.next_step}`);
  }

  const thirdPiece = detail.order.pieces[2];
  for (let i = 0; i < 3; i += 1) {
    await api(`/api/pieces/${thirdPiece.id}/advance`, { method: 'POST', headers });
  }
  detail = await api(`/api/orders/${created.order.id}`, { headers });
  const unfinished = detail.order.pieces.filter((row) => row.stage !== 'finished').map((row) => row.id);
  if (unfinished.length) {
    await api('/api/pieces/batch', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', piece_ids: unfinished }),
    });
  }
  await api(`/api/orders/${created.order.id}/ready`, { method: 'POST', headers });
  const returned = await api(`/api/pieces/${thirdPiece.id}/return-previous`, { method: 'POST', headers });
  if (returned.piece.stage !== 'tempered' || returned.piece.next_step !== 'tempered') {
    throw new Error(`return previous expected tempered, got ${returned.piece.stage} next=${returned.piece.next_step}`);
  }
  const orderAfterReturn = await api(`/api/orders/${created.order.id}`, { headers });
  if (orderAfterReturn.order.status !== 'in_production') {
    throw new Error(`order should return to in_production after previous step, got ${orderAfterReturn.order.status}`);
  }
  await api(`/api/pieces/${thirdPiece.id}/advance`, { method: 'POST', headers });
  const redone = await api(`/api/pieces/${thirdPiece.id}/redo`, { method: 'POST', headers });
  if (redone.piece.stage !== 'cut' || redone.piece.rework !== true || redone.piece.broken !== false) {
    throw new Error(`redo expected cut rework=true broken=false, got ${JSON.stringify({ stage: redone.piece.stage, rework: redone.piece.rework, broken: redone.piece.broken })}`);
  }

  console.log(`PIECE WORKFLOW QA PASS order=${created.order.id} piece=${piece.id} polish_piece=${secondPiece.id} redo_piece=${thirdPiece.id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
