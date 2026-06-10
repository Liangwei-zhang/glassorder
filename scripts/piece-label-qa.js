#!/usr/bin/env node
/* QA for per-piece production label PDF generation and order-detail UI. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const UPLOADS_QA = path.join(ROOT, 'backend/uploads-codex-qa');

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

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function localUploadPath(publicPath) {
  return path.join(UPLOADS_QA, String(publicPath || '').replace(/^\/uploads\//, ''));
}

function listShapePreviews() {
  const dir = path.join(UPLOADS_QA, 'labels', 'shape-previews');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^shape-[a-f0-9]+\.png$/i.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, size: fs.statSync(file).size };
    });
}

function assertShapePreviewsCreated(before, order) {
  const beforeFiles = new Set(before.map((row) => row.file));
  const created = listShapePreviews().filter((row) => !beforeFiles.has(row.file));
  if (created.length < order.pieces.length) {
    throw new Error(`expected ${order.pieces.length} new shape previews, got ${created.length}`);
  }
  for (const row of created) {
    if (row.size < 500) throw new Error(`shape preview too small: ${row.file} ${row.size}`);
  }
}

async function createQaOrder(session, stamp) {
  const customer = (await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Piece Label QA ${stamp}`,
      contact_name: 'QA',
      email: `piece-label-${stamp}@example.test`,
    }),
  })).customer;

  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% piece label qa ${stamp}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customer.id));
  form.set('priority', 'rush');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260604 Piece Label PO LABEL-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', {
    method: 'POST',
    headers: auth(session),
    body: form,
  });
  const order = (await api(`/api/orders/${created.order.id}`, { headers: auth(session) })).order;
  return { customer, order };
}

function assertLabelPdf(publicPath, { order, customer, expectedCount }) {
  const file = localUploadPath(publicPath);
  if (!fs.existsSync(file)) throw new Error(`label PDF missing: ${file}`);
  const stat = fs.statSync(file);
  if (stat.size < 1000) throw new Error(`label PDF unexpectedly small: ${stat.size}`);
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1] || 0);
  if (pages !== expectedCount) throw new Error(`expected ${expectedCount} label pages, got ${pages}`);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  const flat = normalizeText(text);
  const required = [
    order.order_number,
    customer.company.toUpperCase(),
    'WORKFLOW',
    'SUMP:',
    'CCUT01',
    'CPACKING',
  ];
  for (const needle of required) {
    if (!flat.includes(normalizeText(needle))) {
      throw new Error(`label PDF missing ${needle}: ${text.slice(0, 700)}`);
    }
  }
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function browserQa(session, order) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));
    const labelResponses = [];
    page.on('response', async (res) => {
      if (res.url().includes(`/api/orders/${order.id}/labels`) && res.request().method() === 'POST') {
        try { labelResponses.push(await res.json()); } catch (_) {}
      }
    });

    await seedSession(page, session);
    await page.goto(`${BASE}/boss-order-detail.html?id=${order.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 10000 });
    await page.waitForFunction(() => /玻璃生产标签|Glass Production Labels/.test(document.body.textContent || ''), null, { timeout: 10000 });

    const popup1 = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.locator('button', { hasText: /打印全部标签|Print All Labels/ }).click();
    await page.waitForFunction(() => document.querySelector('.toast.success'), null, { timeout: 15000 });
    const opened1 = await popup1;
    if (opened1) await opened1.close();

    await page.locator('button', { hasText: /单片标签|Piece Label/ }).first().click();
    await page.waitForFunction(() => {
      const text = document.body.textContent || '';
      return /已生成 1 张标签|1 labels generated/.test(text);
    }, null, { timeout: 15000 });

    await page.locator('#kebab').click();
    const menuLabels = await page.locator('.menu-pop button').evaluateAll((buttons) => buttons.map((btn) => btn.textContent.trim()));
    if (!menuLabels.some((label) => /打印玻璃标签|Print glass labels/.test(label))) {
      throw new Error(`order menu missing label action: ${JSON.stringify(menuLabels)}`);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) throw new Error(`order detail label UI overflow ${overflow}px`);
    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    if (!labelResponses.some((row) => row && row.count === order.pieces.length)) {
      throw new Error(`browser did not generate all labels: ${JSON.stringify(labelResponses)}`);
    }
    if (!labelResponses.some((row) => row && row.count === 1)) {
      throw new Error(`browser did not generate single label: ${JSON.stringify(labelResponses)}`);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  const session = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const { customer, order } = await createQaOrder(session, stamp);
  if (!order.pieces || order.pieces.length !== 8) {
    throw new Error(`expected sample order to have 8 pieces, got ${order.pieces && order.pieces.length}`);
  }
  const shapePreviewsBefore = listShapePreviews();

  const allLabels = await api(`/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (allLabels.count !== order.pieces.length) throw new Error(`all label count invalid: ${JSON.stringify(allLabels)}`);
  assertLabelPdf(allLabels.label_pdf_path, { order, customer, expectedCount: order.pieces.length });
  assertShapePreviewsCreated(shapePreviewsBefore, order);

  const singleLabels = await api(`/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [order.pieces[0].id] }),
  });
  if (singleLabels.count !== 1) throw new Error(`single label count invalid: ${JSON.stringify(singleLabels)}`);
  assertLabelPdf(singleLabels.label_pdf_path, { order, customer, expectedCount: 1 });

  const badPiece = await fetch(`${BASE}/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [999999999] }),
  });
  if (badPiece.status !== 400) throw new Error(`bad piece_id should return 400, got ${badPiece.status}`);

  await browserQa(session, order);
  console.log(`PIECE LABEL QA PASS order=${order.id} labels=${allLabels.count}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
