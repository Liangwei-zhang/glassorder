#!/usr/bin/env node
/* QA for fuzzy customer search in customer-heavy workflows. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';
const SAMPLE_PDF = require('path').join(__dirname, '..', 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const fs = require('fs');

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function login() {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createReadyOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% customer quick qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('pdf', new File([pdf], `Glass Order - 260608 Customer Quick PO CUST-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers: auth(session) });
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: detail.order.pieces.map((p) => p.id) }),
  });
  await api(`/api/orders/${created.order.id}/ready`, { method: 'POST', headers: auth(session) });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

async function seedCustomers(session) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const target = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Sohal Glass ${stamp} TARGET`,
      contact_name: `Needle ${stamp}`,
      phone: `403-77${String(stamp).slice(-4)}`,
      email: `needle-${stamp}@example.test`,
    }),
  });
  const creates = [];
  for (let i = 0; i < 80; i += 1) {
    creates.push(api('/api/customers', {
      method: 'POST',
      headers: { ...auth(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: `Sohal Glass Similar ${stamp}-${String(i).padStart(3, '0')}`,
        contact_name: `Contact ${i}`,
        phone: `403-55${String(i).padStart(4, '0')}`,
        email: `similar-${stamp}-${i}@example.test`,
      }),
    }));
  }
  await Promise.all(creates);
  const major = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Mega Customer ${stamp}`,
      contact_name: 'Big Account',
      phone: `403-88${String(stamp).slice(-4)}`,
      email: `mega-${stamp}@example.test`,
    }),
  });
  const frequent = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Frequent Pickup ${stamp}`,
      contact_name: 'Repeat Pickup',
      phone: `403-99${String(stamp).slice(-4)}`,
      email: `frequent-${stamp}@example.test`,
    }),
  });
  for (let i = 0; i < 3; i += 1) {
    await createReadyOrder(session, major.customer.id, stamp, `mega-${i}`);
  }
  const pickupOrderA = await createReadyOrder(session, frequent.customer.id, stamp, 'pickup-A');
  const pickupOrderB = await createReadyOrder(session, frequent.customer.id, stamp, 'pickup-B');
  for (const order of [pickupOrderA, pickupOrderB]) {
    await api('/api/pickups/batches', {
      method: 'POST',
      headers: { ...auth(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piece_ids: [order.order.pieces[0].id],
        signer_name: 'Customer Quick QA',
        signer_phone: '403-555-0160',
        signature_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      }),
    });
  }
  return { target: target.customer, major: major.customer, frequent: frequent.customer };
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

(async () => {
  const session = await login();
  const seeded = await seedCustomers(session);
  const target = seeded.target;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  try {
    await seedSession(page, session);

    await page.goto(BASE + '/boss-new-order.html', { waitUntil: 'networkidle' });
    await page.fill('#customerPicker input[type="search"]', target.phone.slice(-4));
    await page.waitForSelector(`.customer-picker-option[data-id="${target.id}"]`);
    const optionCount = await page.locator('.customer-picker-option').count();
    if (optionCount > 40) throw new Error(`new-order picker rendered too many options: ${optionCount}`);
    await page.locator(`.customer-picker-option[data-id="${target.id}"]`).click();
    const selected = await page.evaluate(() => customerPicker.getValue());
    if (String(selected) !== String(target.id)) throw new Error(`new-order selected ${selected}, expected ${target.id}`);

    await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
    await page.fill('#customerPicker input[type="search"]', target.email);
    await page.waitForSelector(`.customer-picker-option[data-id="${target.id}"]`);
    await page.locator(`.customer-picker-option[data-id="${target.id}"]`).click();
    const pickupSelected = await page.evaluate(() => customerPicker.getValue());
    if (String(pickupSelected) !== String(target.id)) throw new Error(`pickup selected ${pickupSelected}, expected ${target.id}`);

    await page.goto(BASE + '/customers.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('.customer-rank-card');
    const quickText = await page.locator('#customerQuickStats').innerText();
    if (!quickText.includes('大客户') || !quickText.includes('常来客户')) {
      throw new Error(`quick stats missing titles: ${quickText}`);
    }
    if (!quickText.includes(seeded.major.company) || !quickText.includes(seeded.frequent.company)) {
      throw new Error(`quick stats missing seeded customers: ${quickText}`);
    }
    await page.locator('.customer-rank-pill', { hasText: seeded.major.company }).click();
    await page.waitForSelector(`.customer-row-highlight[data-cid="${seeded.major.id}"]`);
    const focusedRows = await page.locator('#list [data-cid]').count();
    if (focusedRows !== 1) throw new Error(`quick stat focus expected one row, got ${focusedRows}`);

    await page.fill('#customerSearch', target.email);
    await page.waitForFunction((id) => {
      const row = document.querySelector(`[data-cid="${id}"]`);
      return !!row && row.textContent.includes('TARGET');
    }, String(target.id));
    const visibleRows = await page.locator('#list [data-cid]').count();
    if (visibleRows !== 1) throw new Error(`customer list filter expected one result, got ${visibleRows}`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    if (errors.length) throw new Error(errors.join(' | '));
    console.log(`CUSTOMER SEARCH QA PASS target=${target.id} major=${seeded.major.id} frequent=${seeded.frequent.id} visibleRows=${visibleRows}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
