#!/usr/bin/env node
/* Browser QA for the legacy manual Phase 2 checklist. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

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
    throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function login() {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
}

function authHeaders(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createQaOrder(session) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customer = await api('/api/customers', {
    method: 'POST',
    headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Browser QA ${stamp}`,
      contact_name: 'QA',
      email: `browser-${stamp}@example.test`,
    }),
  });

  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% browser qa ${stamp}\n`),
  ]);
  const file = new File([pdf], `browser-qa-${stamp}.pdf`, { type: 'application/pdf' });
  const form = new FormData();
  form.set('customer_id', String(customer.customer.id));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('note', 'browser qa');
  form.set('pdf', file);
  const created = await api('/api/orders', {
    method: 'POST',
    headers: authHeaders(session),
    body: form,
  });
  const orderId = created.order.id;
  const detail = await api(`/api/orders/${orderId}`, { headers: authHeaders(session) });
  const pieceIds = detail.order.pieces.map((piece) => piece.id);
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: pieceIds }),
  });
  return { orderId, customerId: customer.customer.id };
}

async function seedSession(page, session, roleUser) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: roleUser || session.user });
}

async function expectNoConsoleErrors(page, fn) {
  const errors = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  const onPageError = (err) => errors.push(err.message);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    await fn();
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
}

async function drawSignature(page) {
  const box = await page.locator('#sig').boundingBox();
  if (!box) throw new Error('signature canvas missing');
  const points = [
    { clientX: box.x + 30, clientY: box.y + 30 },
    { clientX: box.x + 70, clientY: box.y + 52 },
    { clientX: box.x + 110, clientY: box.y + 48 },
    { clientX: box.x + 150, clientY: box.y + 34 },
  ];
  await page.dispatchEvent('#sig', 'pointerdown', { ...points[0], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  for (const point of points.slice(1)) {
    await page.dispatchEvent('#sig', 'pointermove', { ...point, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  }
  await page.dispatchEvent('#sig', 'pointerup', { ...points[points.length - 1], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 0 });
}

async function main() {
  const session = await login();
  const seeded = await createQaOrder(session);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const checks = [];

  try {
    await expectNoConsoleErrors(page, async () => {
      // Q7 login page: no production credentials prefilled, required + placeholders exist.
      await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
      const loginValue = await page.locator('#login').inputValue();
      const passwordValue = await page.locator('#password').inputValue();
      const required = await page.evaluate(() => (
        document.getElementById('login').required
        && document.getElementById('password').required
        && !document.getElementById('form').checkValidity()
      ));
      const placeholders = await page.evaluate(() => ({
        login: document.getElementById('login').getAttribute('placeholder'),
        password: document.getElementById('password').getAttribute('placeholder'),
      }));
      if (loginValue || passwordValue || !required || !placeholders.login || !placeholders.password) {
        throw new Error('Q7 login form validation failed');
      }
      checks.push('Q7 login required/placeholders');

      // Q3 auth redirect: no token on a protected boss page must route to login.
      await page.evaluate(() => {
        localStorage.removeItem('glassorder_token');
        localStorage.removeItem('glassorder_user');
      });
      await page.goto(BASE + '/boss-dashboard.html', { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/login\.html$/, { timeout: 5000 });
      checks.push('Q3 auth redirect');

      await seedSession(page, session);

      // Q4 boss ready confirmation modal.
      await page.goto(BASE + `/boss-order-detail.html?id=${seeded.orderId}`, { waitUntil: 'networkidle' });
      await page.locator('button', { hasText: /通知可取货|Mark Ready/ }).click();
      await page.waitForSelector('.modal-backdrop.open');
      const readyModal = await page.locator('.modal-backdrop.open').textContent();
      if (!/通知可取货|Mark as ready/i.test(readyModal || '')) {
        throw new Error('Q4 ready confirmation modal missing');
      }
      await page.locator('.modal-backdrop.open [data-role="ok"]').click();
      await page.waitForSelector('.modal-backdrop.open', { state: 'detached' });
      await page.waitForFunction(() => document.body.textContent.includes('调出取货签字') || document.body.textContent.includes('Pickup Sign'));
      checks.push('Q4 ready confirm modal');

      // Q6 worker grid: readable piece sizes, logout visible, no horizontal overflow.
      await page.goto(BASE + `/worker-pieces.html?id=${seeded.orderId}&stage=all`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#grid [data-id]');
      const workerQa = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const logoutVisible = !!document.querySelector('.logout-btn') && getComputedStyle(document.querySelector('.logout-btn')).display !== 'none';
        const sizeText = [...document.querySelectorAll('#grid .psize')].map((el) => el.textContent.trim()).find(Boolean) || '';
        return { overflow, logoutVisible, sizeText };
      });
      if (workerQa.overflow > 2 || !workerQa.logoutVisible || !/\d+×\d+/.test(workerQa.sizeText)) {
        throw new Error(`Q6 worker grid failed: ${JSON.stringify(workerQa)}`);
      }
      checks.push('Q6 worker grid');

      // Q4 pickup confirmation modal.
      await page.goto(BASE + `/pickup-sign.html?id=${seeded.orderId}`, { waitUntil: 'networkidle' });
      await page.fill('#name', 'Browser QA Signer');
      await page.fill('#phone', '403-555-1212');
      await drawSignature(page);
      await page.locator('#submitBtn').click();
      await page.waitForSelector('.modal-backdrop.open');
      const pickupModal = await page.locator('.modal-backdrop.open').textContent();
      if (!/确认取货|Confirm Pickup/i.test(pickupModal || '')) {
        throw new Error('Q4 pickup confirmation modal missing');
      }
      await page.locator('.modal-backdrop.open [data-role="ok"]').click();
      await page.waitForURL(/pickup-slip\.html/, { timeout: 15000 });
      checks.push('Q4 pickup confirm modal');

      // Q5 detail timeline + slip download after pickup.
      await page.goto(BASE + `/boss-order-detail.html?id=${seeded.orderId}`, { waitUntil: 'networkidle' });
      const detailText = await page.locator('#body').textContent();
      const hasSlip = await page.locator('a[href^="/uploads/slips/"]').count();
      if (!/事件时间线|Timeline/.test(detailText || '') || !/客户取货|Picked up/.test(detailText || '') || hasSlip < 1) {
        throw new Error('Q5 timeline or slip card missing after pickup');
      }
      checks.push('Q5 timeline and slip');

      // Q8 empty state style: selected customer has no remaining pickup pieces.
      await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
      await page.fill('#customerPicker input[type="search"]', `Browser QA`);
      await page.locator(`.customer-picker-option[data-id="${seeded.customerId}"]`).click();
      await page.waitForSelector('#available .empty-state');
      checks.push('Q8 empty state');
    });
  } finally {
    await browser.close();
  }

  console.log(`BROWSER QA PASS order=${seeded.orderId} checks=${checks.join(' | ')}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
