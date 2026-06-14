#!/usr/bin/env node
/* Verify worker piece actions stay local and do not refetch the full order. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';
const WORKFLOW_STEPS = ['cut', 'edge', 'tempered'];
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findActionablePiece(headers) {
  const orders = await api('/api/orders?status=in_production&limit=100', { headers });
  for (const row of orders.orders || []) {
    const detail = await api(`/api/orders/${row.id}`, { headers });
    const piece = detail.order.pieces.find((p) => {
      if (p.stage === 'finished' || p.hold) return false;
      if (p.next_step) return true;
      const required = Array.isArray(p.required_steps) && p.required_steps.length ? p.required_steps : WORKFLOW_STEPS;
      const completed = Array.isArray(p.completed_steps) ? p.completed_steps : [];
      return required.some((step) => !completed.includes(step));
    });
    if (piece) return { order: detail.order, piece };
  }
  return null;
}

async function createPerfOrder(headers) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customerRes = await api('/api/customers', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Perf QA ${stamp}`,
      contact_name: 'QA',
      email: `perf-${stamp}@example.test`,
    }),
  });
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% perf qa ${stamp}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerRes.customer.id));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('pdf', new File([pdf], `Glass Order - 260609 Perf QA PO PERF-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers, body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers });
  const piece = detail.order.pieces.find((p) => p.stage !== 'finished' && !p.hold && p.next_step);
  if (!piece) throw new Error(`Created perf order has no actionable piece: ${created.order.id}`);
  return { order: detail.order, piece };
}

(async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
  const headers = { Authorization: `Bearer ${login.token}` };
  const picked = await createPerfOrder(headers).catch(async () => {
    const fallback = await findActionablePiece(headers);
    if (!fallback) throw new Error('No actionable in-production piece for perf QA');
    return fallback;
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const requests = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/api/')) {
        requests.push(`${req.method()} ${url.pathname}${url.search}`);
      }
    });

    await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('glassorder_token', token);
      localStorage.setItem('glassorder_user', JSON.stringify(user));
      localStorage.setItem('glassorder_lang', 'zh');
    }, { token: login.token, user: login.user });

    await page.goto(BASE + `/worker-pieces.html?id=${picked.order.id}&stage=all`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`#grid [data-id="${picked.piece.id}"]`);
    requests.length = 0;

    await page.locator(`#grid [data-id="${picked.piece.id}"]`).click();
    await page.waitForSelector('#pieceModal.open');
    await page.waitForSelector('#mActions .btn-success');
    const before = process.hrtime.bigint();
    await page.locator('#mActions .btn-success').click();
    await page.waitForFunction(() => !document.getElementById('pieceModal').classList.contains('open'));
    await page.waitForTimeout(120);
    const elapsed = Number(process.hrtime.bigint() - before) / 1e6;

    const fullOrderFetches = requests.filter((r) => r.includes(`/api/orders/${picked.order.id}`));
    const advanceCalls = requests.filter((r) => r.includes('/api/pieces/') && r.includes('/advance'));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    if (fullOrderFetches.length) {
      throw new Error(`Unexpected full order refetch after piece action: ${fullOrderFetches.join(', ')}`);
    }
    if (advanceCalls.length !== 1) {
      throw new Error(`Expected one advance call, got ${advanceCalls.length}: ${requests.join(', ')}`);
    }
    if (overflow > 2) {
      throw new Error(`Horizontal overflow ${overflow}px`);
    }
    console.log(`WORKER PERF PASS order=${picked.order.id} piece=${picked.piece.id} actionElapsed=${elapsed.toFixed(1)}ms apiCalls=${requests.join(' | ')}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
