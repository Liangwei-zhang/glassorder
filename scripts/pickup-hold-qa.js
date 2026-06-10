#!/usr/bin/env node
/* QA for pickup order/customer HOLD behavior. */
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

async function completeOrder(session, orderId) {
  const detail = await api(`/api/orders/${orderId}`, { headers: auth(session) });
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: detail.order.pieces.map((piece) => piece.id) }),
  });
  await api(`/api/orders/${orderId}/ready`, { method: 'POST', headers: auth(session) });
  return api(`/api/orders/${orderId}`, { headers: auth(session) });
}

async function createOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% pickup hold qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260604 Pickup Hold PO HOLD-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  return completeOrder(session, created.order.id);
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function browserHoldReleaseFlow(session, customer, orderA) {
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
    await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
    await page.fill('#customerPicker input[type="search"]', customer.company);
    await page.locator(`.customer-picker-option[data-id="${customer.id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-piece]').length === 16, null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-piece]:disabled').length === 0, null, { timeout: 10000 });

    const orderPanel = page.locator(`.pickup-order-panel[data-pickup-order="${orderA.order.id}"]`);
    await orderPanel.locator('.pickup-order-actions button').nth(2).click();
    await page.locator('.modal-backdrop.open [data-role="ok"]').last().click();
    await page.waitForFunction((orderId) => {
      const panel = document.querySelector(`.pickup-order-panel[data-pickup-order="${orderId}"]`);
      return panel && panel.querySelectorAll('[data-piece]:disabled').length === 8;
    }, orderA.order.id, { timeout: 10000 });
    const afterOrderHold = await orderPanel.evaluate((panel) => ({
      disabledPieces: panel.querySelectorAll('[data-piece]:disabled').length,
      buttons: [...panel.querySelectorAll('.pickup-order-actions button')].map((btn) => ({
        text: btn.textContent.trim(),
        disabled: btn.disabled,
      })),
    }));
    if (afterOrderHold.disabledPieces !== 8 || !afterOrderHold.buttons[2].disabled || afterOrderHold.buttons[3].disabled) {
      throw new Error(`order hold buttons should leave release enabled: ${JSON.stringify(afterOrderHold)}`);
    }

    await orderPanel.locator('.pickup-order-actions button').nth(3).click();
    await page.locator('.modal-backdrop.open [data-role="ok"]').last().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-piece]:disabled').length === 0, null, { timeout: 10000 });

    await page.locator('.pickup-customer-hold-actions button').nth(0).click();
    await page.locator('.modal-backdrop.open [data-role="ok"]').last().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-piece]:disabled').length === 16, null, { timeout: 10000 });
    const afterCustomerHold = await page.evaluate(() => ({
      disabledPieces: document.querySelectorAll('[data-piece]:disabled').length,
      buttons: [...document.querySelectorAll('.pickup-customer-hold-actions button')].map((btn) => ({
        text: btn.textContent.trim(),
        disabled: btn.disabled,
      })),
    }));
    if (afterCustomerHold.disabledPieces !== 16 || !afterCustomerHold.buttons[0].disabled || afterCustomerHold.buttons[1].disabled) {
      throw new Error(`customer hold buttons should leave release enabled: ${JSON.stringify(afterCustomerHold)}`);
    }

    await page.locator('.pickup-customer-hold-actions button').nth(1).click();
    await page.locator('.modal-backdrop.open [data-role="ok"]').last().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-piece]:disabled').length === 0, null, { timeout: 10000 });

    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
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
  const headers = auth(session);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customerRes = await api('/api/customers', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Pickup Hold QA ${stamp}`,
      contact_name: 'QA',
      email: `pickup-hold-${stamp}@example.test`,
    }),
  });
  const customer = customerRes.customer;
  const customerId = customer.id;
  const orderA = await createOrder(session, customerId, stamp, 'A');
  const orderB = await createOrder(session, customerId, stamp, 'B');

  let available = await api(`/api/pickups/available?customer_id=${customerId}`, { headers });
  if (available.total_pieces !== 16 || available.hold_pieces !== 0) {
    throw new Error(`expected 16 available pieces, got ${available.total_pieces} hold=${available.hold_pieces}`);
  }

  const holdOrder = await api('/api/pickups/hold-order', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderA.order.id, hold: true }),
  });
  if (holdOrder.changed !== 8 || holdOrder.total !== 8 || holdOrder.hold !== true) {
    throw new Error(`unexpected hold-order result: ${JSON.stringify(holdOrder)}`);
  }
  available = await api(`/api/pickups/available?customer_id=${customerId}`, { headers });
  if (available.total_pieces !== 8 || available.orders.length !== 1) {
    throw new Error(`hold order should hide 8 pieces by default, got ${available.total_pieces}/${available.orders.length}`);
  }
  const withHold = await api(`/api/pickups/available?customer_id=${customerId}&include_hold=1`, { headers });
  if (withHold.total_pieces !== 16 || withHold.hold_pieces !== 8 || withHold.orders.length !== 2) {
    throw new Error(`include_hold expected 16 with 8 held, got ${withHold.total_pieces}/${withHold.hold_pieces}/${withHold.orders.length}`);
  }
  const heldPieceId = withHold.orders.find((order) => Number(order.order_id) === Number(orderA.order.id)).pieces[0].id;
  await expectStatus('/api/pickups/batches', 400, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece_ids: [heldPieceId], signer_name: 'Hold QA' }),
  });

  const unholdOrder = await api('/api/pickups/hold-order', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderA.order.id, hold: false }),
  });
  if (unholdOrder.changed !== 8 || unholdOrder.hold !== false) {
    throw new Error(`unexpected unhold-order result: ${JSON.stringify(unholdOrder)}`);
  }
  available = await api(`/api/pickups/available?customer_id=${customerId}`, { headers });
  if (available.total_pieces !== 16) {
    throw new Error(`unhold order should restore 16 pieces, got ${available.total_pieces}`);
  }

  const holdCustomer = await api('/api/pickups/hold-customer', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, hold: true }),
  });
  if (holdCustomer.changed !== 16 || holdCustomer.total !== 16 || holdCustomer.orders.length !== 2) {
    throw new Error(`unexpected hold-customer result: ${JSON.stringify(holdCustomer)}`);
  }
  available = await api(`/api/pickups/available?customer_id=${customerId}`, { headers });
  if (available.total_pieces !== 0) {
    throw new Error(`customer hold should hide all pieces by default, got ${available.total_pieces}`);
  }
  const customerWithHold = await api(`/api/pickups/available?customer_id=${customerId}&include_hold=1`, { headers });
  if (customerWithHold.total_pieces !== 16 || customerWithHold.hold_pieces !== 16) {
    throw new Error(`include_hold after customer hold expected 16 held, got ${customerWithHold.total_pieces}/${customerWithHold.hold_pieces}`);
  }

  const unholdCustomer = await api('/api/pickups/hold-customer', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, hold: false }),
  });
  if (unholdCustomer.changed !== 16 || unholdCustomer.hold !== false) {
    throw new Error(`unexpected unhold-customer result: ${JSON.stringify(unholdCustomer)}`);
  }
  available = await api(`/api/pickups/available?customer_id=${customerId}`, { headers });
  if (available.total_pieces !== 16 || available.hold_pieces !== 0) {
    throw new Error(`unhold customer should restore 16 pieces, got ${available.total_pieces} hold=${available.hold_pieces}`);
  }

  await browserHoldReleaseFlow(session, customer, orderA);

  console.log(`PICKUP HOLD QA PASS customer=${customerId} orders=${orderA.order.id},${orderB.order.id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
