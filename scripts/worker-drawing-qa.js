#!/usr/bin/env node
/* Browser QA for worker drawing previous/next navigation and swipe. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createOrder(session) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customer = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Drawing QA ${stamp}`,
      contact_name: 'QA',
      email: `drawing-${stamp}@example.test`,
    }),
  });
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% drawing qa ${stamp}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customer.customer.id));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260605 Drawing QA PO DRAW-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function waitFullTitle(page, pattern) {
  await page.waitForFunction((source) => {
    const re = new RegExp(source);
    return re.test(document.getElementById('fullTitle')?.textContent || '');
  }, pattern.source, { timeout: 10000 });
}

async function waitDrawingIdle(page) {
  await page.waitForTimeout(360);
  await page.waitForFunction(() => {
    const img = document.getElementById('fullDrawing');
    return !document.querySelector('#viewer .drawing-transition-img')
      && !(img && img.classList.contains('drawing-animating'))
      && !(img && img.classList.contains('drawing-dragging'));
  }, null, { timeout: 10000 });
}

async function waitPreviewLayer(page, label) {
  const seen = await page.waitForFunction(() => {
    const preview = document.querySelector('#viewer .drawing-preview-img');
    if (!preview) return false;
    const style = getComputedStyle(preview);
    const rect = preview.getBoundingClientRect();
    return Number(style.opacity) > 0.1 && rect.width > 0 && rect.height > 0;
  }, null, { timeout: 1800 }).then(() => true).catch(() => false);
  if (!seen) throw new Error(`${label} did not reveal adjacent drawing preview`);
}

async function assertTransitionSeen(page, label) {
  const seen = await page.waitForFunction(() => (
    !!document.querySelector('#viewer .drawing-transition-img')
    || document.getElementById('fullDrawing')?.classList.contains('drawing-animating')
  ), null, { timeout: 1500 }).then(() => true).catch(() => false);
  if (!seen) throw new Error(`${label} did not show drawing transition`);
}

(async () => {
  const session = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
  const detail = await createOrder(session);
  const order = detail.order;
  if (!order.pieces || order.pieces.length < 3) throw new Error('expected at least 3 pieces');

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
    const cdp = await context.newCDPSession(page);

    await seedSession(page, session);
    await page.goto(BASE + `/worker-pieces.html?id=${order.id}&stage=all`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.getElementById('pwa-banner-stack')?.remove();
    });
    await page.waitForSelector('#grid [data-id]');
    await page.locator('#grid [data-id]').nth(0).click();
    await page.waitForSelector('#pieceModal.open');
    await page.waitForSelector('#mDrawing img', { timeout: 10000 });
    await page.locator('#mDrawing').click();
    await page.waitForSelector('#drawingModal.open');
    await page.waitForSelector('#fullDrawing[src]');
    await waitFullTitle(page, /第 1 片|Piece #1/);

    const initialNav = await page.evaluate(() => ({
      prevDisabled: document.getElementById('drawingPrevBtn').disabled,
      nextDisabled: document.getElementById('drawingNextBtn').disabled,
      sub: document.getElementById('fullSub').textContent,
    }));
    if (!initialNav.prevDisabled || initialNav.nextDisabled || !/1\/8/.test(initialNav.sub)) {
      throw new Error(`initial drawing nav invalid: ${JSON.stringify(initialNav)}`);
    }

    const nextClick = page.locator('#drawingNextBtn').click();
    await assertTransitionSeen(page, 'next button');
    await nextClick;
    await waitFullTitle(page, /第 2 片|Piece #2/);
    await waitDrawingIdle(page);
    const secondNav = await page.evaluate(() => ({
      prevDisabled: document.getElementById('drawingPrevBtn').disabled,
      nextDisabled: document.getElementById('drawingNextBtn').disabled,
      sub: document.getElementById('fullSub').textContent,
    }));
    if (secondNav.prevDisabled || secondNav.nextDisabled || !/2\/8/.test(secondNav.sub)) {
      throw new Error(`second drawing nav invalid: ${JSON.stringify(secondNav)}`);
    }

    const beforeShortDrag = await page.locator('#fullDrawing').evaluate((img) => {
      const rect = img.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    let box = await page.locator('#viewer').boundingBox();
    if (!box) throw new Error('viewer missing');
    let y = box.y + box.height / 2;
    let startX = box.x + box.width / 2;
    let endX = startX + 36;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
      modifiers: 0,
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y: y + 1 }],
      modifiers: 0,
    });
    await waitPreviewLayer(page, 'short drag');
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers: 0,
    });
    await waitDrawingIdle(page);
    await waitFullTitle(page, /第 2 片|Piece #2/);
    const afterShortDrag = await page.locator('#fullDrawing').evaluate((img) => {
      const rect = img.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    if (Math.abs(afterShortDrag.left - beforeShortDrag.left) > 3 || Math.abs(afterShortDrag.top - beforeShortDrag.top) > 3) {
      throw new Error(`short drawing drag did not snap back: ${JSON.stringify({ beforeShortDrag, afterShortDrag })}`);
    }

    await page.locator('#drawingPrevBtn').click();
    await waitFullTitle(page, /第 1 片|Piece #1/);
    await waitDrawingIdle(page);

    box = await page.locator('#viewer').boundingBox();
    if (!box) throw new Error('viewer missing');
    y = box.y + box.height / 2;
    startX = box.x + box.width - 40;
    endX = box.x + 40;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
      modifiers: 0,
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: (startX + endX) / 2, y: y + 2 }],
      modifiers: 0,
    });
    await waitPreviewLayer(page, 'swipe drag');
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y: y + 3 }],
      modifiers: 0,
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers: 0,
    });
    await waitFullTitle(page, /第 2 片|Piece #2/);
    await waitDrawingIdle(page);

    const final = await page.evaluate(() => ({
      title: document.getElementById('fullTitle').textContent,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      modalOpen: document.getElementById('drawingModal').classList.contains('open'),
    }));
    if (!final.modalOpen || final.overflow > 2) {
      throw new Error(`drawing modal layout invalid: ${JSON.stringify(final)}`);
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    console.log(`WORKER DRAWING QA PASS order=${order.id} title=${final.title}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
