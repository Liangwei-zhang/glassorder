#!/usr/bin/env node
/* Browser QA for worker and pickup select-all controls. */
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

async function login() {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
}

async function createCustomer(session, stamp) {
  return api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Select All QA ${stamp}`,
      contact_name: 'QA',
      email: `select-all-${stamp}@example.test`,
    }),
  });
}

async function createOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% select all qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260604 Select All PO SELECT-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', {
    method: 'POST',
    headers: auth(session),
    body: form,
  });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

async function completePieces(session, pieces) {
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: pieces.map((p) => p.id) }),
  });
}

async function advancePieces(session, pieces, count) {
  for (let i = 0; i < count; i += 1) {
    await api('/api/pieces/batch', {
      method: 'POST',
      headers: { ...auth(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'advance', piece_ids: pieces.map((p) => p.id) }),
    });
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

async function removePwaBanner(page) {
  await page.evaluate(() => {
    document.getElementById('pwa-banner-stack')?.remove();
  });
}

async function waitSummary(page, n) {
  await page.waitForFunction((count) => {
    const text = document.getElementById('selectedSummary')?.textContent || '';
    return new RegExp(`已选 ${count} 片|${count} selected`).test(text);
  }, n, { timeout: 10000 });
}

(async () => {
  const session = await login();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customer = (await createCustomer(session, stamp)).customer;

  const workerOrder = (await createOrder(session, customer.id, stamp, 'worker')).order;
  const cutIds = workerOrder.pieces.slice(0, 3).map((p) => p.id);
  const temperedPieces = workerOrder.pieces.slice(3, 7);
  await advancePieces(session, temperedPieces, 2);

  const pickupA = (await createOrder(session, customer.id, stamp, 'pickup-a')).order;
  const pickupB = (await createOrder(session, customer.id, stamp, 'pickup-b')).order;
  await completePieces(session, pickupA.pieces);
  await completePieces(session, pickupB.pieces);
  await api(`/api/orders/${pickupA.id}/ready`, { method: 'POST', headers: auth(session) });
  await api(`/api/orders/${pickupB.id}/ready`, { method: 'POST', headers: auth(session) });

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

    await seedSession(page, session);
    await page.goto(BASE + `/worker-pieces.html?id=${workerOrder.id}&stage=cut`, { waitUntil: 'networkidle' });
    await removePwaBanner(page);
    await page.waitForSelector('#grid [data-id]');
    await page.locator('#selectToggle').click();
    await page.locator('#selectAllViewBtn').click();
    const cutState = await page.evaluate(() => ({
      visible: document.querySelectorAll('#grid [data-id]').length,
      selected: document.querySelectorAll('#grid .piece.selected').length,
      selectedIds: [...selectedIds].sort((a, b) => a - b),
      buttonDisabled: document.getElementById('selectAllViewBtn').disabled,
    }));
    if (cutState.visible !== 4 || cutState.selected !== 4 || !cutState.buttonDisabled) {
      throw new Error(`worker cut select-all failed: ${JSON.stringify(cutState)}`);
    }
    if (!cutIds.every((id) => cutState.selectedIds.includes(id))) {
      throw new Error(`worker cut select-all missing cut ids: ${JSON.stringify(cutState)}`);
    }
    await page.locator('#clearSelectionBtn').click();
    const clearState = await page.evaluate(() => ({
      selected: document.querySelectorAll('#grid .piece.selected').length,
      ids: [...selectedIds],
    }));
    if (clearState.selected !== 0 || clearState.ids.length !== 0) {
      throw new Error(`worker clear selection failed: ${JSON.stringify(clearState)}`);
    }

    await page.locator('.stage-tab[data-stage="tempered"]').click();
    await page.locator('#selectAllViewBtn').click();
    const temperedState = await page.evaluate(() => ({
      visible: document.querySelectorAll('#grid [data-id]').length,
      selected: document.querySelectorAll('#grid .piece.selected').length,
      ids: [...selectedIds],
    }));
    if (temperedState.visible !== 4 || temperedState.selected !== 4 || temperedState.ids.length !== 4) {
      throw new Error(`worker tempered select-all failed: ${JSON.stringify(temperedState)}`);
    }

    await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
    await removePwaBanner(page);
    await page.fill('#customerPicker input[type="search"]', customer.company);
    await page.locator(`.customer-picker-option[data-id="${customer.id}"]`).click();
    await page.waitForSelector('[data-piece]');
    const availableCount = await page.locator('[data-piece]').count();
    if (availableCount !== 16) throw new Error(`expected 16 pickup pieces, got ${availableCount}`);

    await page.locator('#pickupSelectAllBtn').click();
    await waitSummary(page, 16);
    const pickupAll = await page.evaluate(() => ({
      checked: document.querySelectorAll('[data-piece]:checked').length,
      selected: selected.size,
    }));
    if (pickupAll.checked !== 16 || pickupAll.selected !== 16) {
      throw new Error(`pickup page select-all failed: ${JSON.stringify(pickupAll)}`);
    }

    await page.locator('#pickupClearAllBtn').click();
    const pickupClear = await page.evaluate(() => ({
      checked: document.querySelectorAll('[data-piece]:checked').length,
      selected: selected.size,
      summary: document.getElementById('selectedSummary')?.textContent || '',
    }));
    if (pickupClear.checked !== 0 || pickupClear.selected !== 0 || !/确认取货|Confirm Pickup/.test(pickupClear.summary)) {
      throw new Error(`pickup clear-all failed: ${JSON.stringify(pickupClear)}`);
    }

    await page.locator('.pickup-order-actions button').first().click();
    await waitSummary(page, 8);
    const firstOrder = await page.locator('.pickup-order-panel').first().evaluate((panel) => ({
      checkedInOrder: panel.querySelectorAll('[data-piece]:checked').length,
      allChecked: document.querySelectorAll('[data-piece]:checked').length,
    }));
    if (firstOrder.checkedInOrder !== 8 || firstOrder.allChecked !== 8) {
      throw new Error(`pickup order select-all failed: ${JSON.stringify(firstOrder)}`);
    }
    await page.locator('.pickup-order-actions button').nth(1).click();
    const orderClear = await page.evaluate(() => ({
      checked: document.querySelectorAll('[data-piece]:checked').length,
      selected: selected.size,
    }));
    if (orderClear.checked !== 0 || orderClear.selected !== 0) {
      throw new Error(`pickup order clear failed: ${JSON.stringify(orderClear)}`);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) throw new Error(`select-all page overflow ${overflow}px`);
    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    console.log(`SELECT ALL QA PASS worker_order=${workerOrder.id} customer=${customer.id}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
