#!/usr/bin/env node
/* QA for per-piece production label PDF generation and order-detail UI. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createPieceLabelsPdf } = require('../backend/services/pieceLabels');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const UPLOADS_QA = path.join(ROOT, 'backend/uploads-codex-qa');
const EXPECTED_LABEL_COMPANY = process.env.LABEL_COMPANY_NAME || process.env.COMPANY_NAME || 'SUNSHINE TEMPERED GLASS';
const EXPECTED_LABEL_SIZES = {
  '100x150': { width: 100 * 72 / 25.4, height: 150 * 72 / 25.4 },
  '80x60': { width: 80 * 72 / 25.4, height: 60 * 72 / 25.4 },
};

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
  const uniqueDrawings = new Set((order.pieces || [])
    .map((piece) => piece.drawing_path)
    .filter(Boolean));
  const expected = uniqueDrawings.size || order.pieces.length;
  if (created.length < expected) {
    throw new Error(`expected ${expected} new shape previews, got ${created.length}`);
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

function assertPageSize(info, expectedSize) {
  if (!expectedSize) return;
  const expected = EXPECTED_LABEL_SIZES[expectedSize];
  if (!expected) throw new Error(`unknown expected label size ${expectedSize}`);
  const match = info.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m);
  if (!match) throw new Error(`pdfinfo missing Page size: ${info}`);
  const actualWidth = Number(match[1]);
  const actualHeight = Number(match[2]);
  const close = (a, b) => Math.abs(a - b) < 1;
  if (!close(actualWidth, expected.width) || !close(actualHeight, expected.height)) {
    throw new Error(`expected ${expectedSize} page, got ${actualWidth} x ${actualHeight} pts`);
  }
}

function assertLabelPdf(publicPath, { order, customer, expectedCount, expectedSize = '100x150' }) {
  const file = localUploadPath(publicPath);
  if (!fs.existsSync(file)) throw new Error(`label PDF missing: ${file}`);
  const stat = fs.statSync(file);
  if (stat.size < 1000) throw new Error(`label PDF unexpectedly small: ${stat.size}`);
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1] || 0);
  if (pages !== expectedCount) throw new Error(`expected ${expectedCount} label pages, got ${pages}`);
  assertPageSize(info, expectedSize);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  const flat = normalizeText(text);
  const expectedTag = ((order.pieces || []).find((piece) => piece.tag) || {}).tag;
  const required = [
    order.order_number,
    customer.company.toUpperCase(),
    EXPECTED_LABEL_COMPANY,
    'WORKFLOW',
    'SUMP:',
    'CCUT01',
    'CPACKING',
  ];
  if (expectedTag) {
    required.push('Tag:', expectedTag);
  }
  for (const needle of required) {
    if (!flat.includes(normalizeText(needle))) {
      throw new Error(`label PDF missing ${needle}: ${text.slice(0, 700)}`);
    }
  }
  for (const blocked of ['SHIPPING', 'CSHIPPING', 'SHIP:']) {
    if (flat.includes(normalizeText(blocked))) {
      throw new Error(`label PDF should not contain ${blocked}: ${text.slice(0, 700)}`);
    }
  }
  if (text.includes('...') || text.includes('…')) {
    throw new Error(`label PDF should not ellipsize text: ${text.slice(0, 700)}`);
  }
}

async function assertMarksDrivePieceMarker() {
  const stamp = Date.now();
  const outputPath = path.join('/tmp', `glassorder-marks-label-${stamp}.pdf`);
  const order = {
    id: 900000 + Math.floor(Math.random() * 10000),
    order_number: `MARK-QA-${stamp}`,
    priority: 'rush',
    company: 'Mark QA Customer',
  };
  const pieces = [1, 2].map((pieceNo) => ({
    id: 800000 + pieceNo,
    piece_no: pieceNo,
    size: '17" × 16-5/16"',
    type: 'CLEAR TEMPERED',
    thickness: '10mm',
    weight: '9.5lb',
    piece_note: 'Flat Polish 2 Long 2 Short As Shown · Tempered logo · Marks: P1',
  }));
  await createPieceLabelsPdf({
    order,
    pieces,
    outputPath,
    uploadsBase: UPLOADS_QA,
    labelSize: '100x150',
  });
  const text = execFileSync('pdftotext', [outputPath, '-'], { encoding: 'utf8' });
  const pages = text.split('\f').filter((page) => page.trim());
  if (pages.length !== 2) throw new Error(`marks marker QA expected 2 pages, got ${pages.length}`);
  pages.forEach((page, index) => {
    if (!page.includes('Marks: P1')) throw new Error(`marks marker QA page ${index + 1} missing Marks: P1`);
    if (!/(^|\n)P1\n/.test(page)) throw new Error(`marks marker QA page ${index + 1} missing top marker P1: ${page.slice(0, 500)}`);
  });
  if (/(^|\n)P2\n/.test(pages[1])) {
    throw new Error(`marks marker QA second page used piece counter P2 instead of Marks: P1: ${pages[1].slice(0, 500)}`);
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
    await page.waitForFunction(() => /标签纸尺寸|Label paper/.test(document.body.textContent || ''), null, { timeout: 10000 });

    const popup1 = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.locator('button', { hasText: /打印全部标签|Print All Labels/ }).click();
    await page.waitForFunction(() => document.querySelector('.toast.success'), null, { timeout: 15000 });
    const opened1 = await popup1;
    if (opened1) await opened1.close();

    await page.locator('[data-label-size="80x60"]').click();
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
    if (!labelResponses.some((row) => row && row.count === order.pieces.length && row.label_size === '100x150')) {
      throw new Error(`browser did not generate all labels: ${JSON.stringify(labelResponses)}`);
    }
    if (!labelResponses.some((row) => row && row.count === 1 && row.label_size === '80x60')) {
      throw new Error(`browser did not generate single label: ${JSON.stringify(labelResponses)}`);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  await assertMarksDrivePieceMarker();

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
  if (!order.pieces.every((piece) => piece.tag === 'Bathroom')) {
    throw new Error(`expected all sample pieces to parse Location as tag Bathroom: ${JSON.stringify(order.pieces.map((piece) => piece.tag))}`);
  }
  const shapePreviewsBefore = listShapePreviews();

  const allLabels = await api(`/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (allLabels.count !== order.pieces.length) throw new Error(`all label count invalid: ${JSON.stringify(allLabels)}`);
  if (allLabels.label_size !== '100x150') throw new Error(`default label_size invalid: ${JSON.stringify(allLabels)}`);
  assertLabelPdf(allLabels.label_pdf_path, { order, customer, expectedCount: order.pieces.length, expectedSize: '100x150' });
  assertShapePreviewsCreated(shapePreviewsBefore, order);

  const singleLabels = await api(`/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [order.pieces[0].id], label_size: '80x60' }),
  });
  if (singleLabels.count !== 1) throw new Error(`single label count invalid: ${JSON.stringify(singleLabels)}`);
  if (singleLabels.label_size !== '80x60') throw new Error(`single label_size invalid: ${JSON.stringify(singleLabels)}`);
  assertLabelPdf(singleLabels.label_pdf_path, { order, customer, expectedCount: 1, expectedSize: '80x60' });

  const badSize = await fetch(`${BASE}/api/orders/${order.id}/labels`, {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ label_size: '4x6' }),
  });
  if (badSize.status !== 400) throw new Error(`bad label_size should return 400, got ${badSize.status}`);

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
