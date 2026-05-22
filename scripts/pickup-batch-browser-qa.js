#!/usr/bin/env node
/* Browser QA for boss piece-level pickup batch flow. */
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
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function login(name, password) {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: name, password }),
  });
}
function auth(session) { return { Authorization: `Bearer ${session.token}` }; }

async function createReadyOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([fs.readFileSync(SAMPLE_PDF), Buffer.from(`\n% browser pickup ${stamp} ${suffix}\n`)]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('pdf', new File([pdf], `browser-pickup-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  const detail = await api(`/api/orders/${created.order.id}`, { headers: auth(session) });
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: detail.order.pieces.map(p => p.id) }),
  });
  await api(`/api/orders/${created.order.id}/ready`, { method: 'POST', headers: auth(session) });
  return created.order.id;
}

async function seedCustomerWithOrders(session) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const c = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: `Browser Pickup ${stamp}`, contact_name: 'QA', email: `browser-pickup-${stamp}@example.test` }),
  });
  await createReadyOrder(session, c.customer.id, stamp, 'A');
  await createReadyOrder(session, c.customer.id, stamp, 'B');
  return c.customer;
}

async function draw(page) {
  const box = await page.locator('#sig').boundingBox();
  if (!box) throw new Error('signature canvas missing');
  const points = [
    { clientX: box.x + 20, clientY: box.y + 30 },
    { clientX: box.x + 55, clientY: box.y + 48 },
    { clientX: box.x + 90, clientY: box.y + 62 },
    { clientX: box.x + 120, clientY: box.y + 70 },
  ];
  await page.dispatchEvent('#sig', 'pointerdown', { ...points[0], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  for (const point of points.slice(1)) {
    await page.dispatchEvent('#sig', 'pointermove', { ...point, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  }
  await page.dispatchEvent('#sig', 'pointerup', { ...points[points.length - 1], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 0 });
}

(async () => {
  const boss = await login('bossdemo', 'boss123456');
  const customer = await seedCustomerWithOrders(boss);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('glassorder_token', token);
      localStorage.setItem('glassorder_user', JSON.stringify(user));
      localStorage.setItem('glassorder_lang', 'zh');
    }, { token: boss.token, user: boss.user });
    await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
    await page.fill('#customerPicker input[type="search"]', customer.company);
    await page.locator(`.customer-picker-option[data-id="${customer.id}"]`).click();
    await page.waitForSelector('[data-piece]');
    const checks = await page.locator('[data-piece]').count();
    if (checks < 16) throw new Error(`expected at least 16 available pieces, got ${checks}`);
    await page.locator('[data-piece]').nth(0).check();
    await page.waitForFunction(() => /已选 1 片|1 selected/.test(document.querySelector('#selectedSummary')?.textContent || ''), null, { timeout: 10000 });
    await page.locator('[data-piece]').nth(8).check();
    await page.waitForFunction(() => /已选 2 片|2 selected/.test(document.querySelector('#selectedSummary')?.textContent || ''), null, { timeout: 10000 });
    await page.fill('#name', 'Browser Pickup Signer');
    await draw(page);
    await page.click('#submitBtn');
    await page.waitForSelector('.modal-backdrop.open');
    await page.locator('.modal-backdrop.open [data-role="ok"]').click();
    await page.waitForURL(/pickup-batch-detail\.html\?id=/, { timeout: 15000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('button')].some((btn) => /下载|Download/.test(btn.textContent || ''))
    ), null, { timeout: 10000 });
    const detailUrl = page.url();
    const detailText = await page.locator('#body').textContent();
    if (!/Browser Pickup|第 1 片|第 2 片|Piece/.test(detailText || '') || !/订单数|Orders/.test(detailText || '')) throw new Error('batch detail did not render pieces/summary');
    await page.goto(BASE + '/pickup-batches.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#pickupSearch', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.pickup-stat-card').length === 4, null, { timeout: 10000 });
    const initialTitle = await page.locator('#listTitle').textContent();
    if (!/可取订单|Ready Orders/.test(initialTitle || '')) throw new Error(`pickup default view should be ready orders: ${initialTitle}`);
    const activeCardStyle = await page.locator('.pickup-stat-card.active').evaluate((el) => {
      const style = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      return {
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        bgImage: style.backgroundImage,
        afterContent: after.content,
      };
    });
    if (activeCardStyle.borderWidth !== '1px'
      || !/rgb\(24,\s*24,\s*27\)/.test(activeCardStyle.borderColor)
      || !/rgba\(24,\s*24,\s*27,\s*0\.08\)/.test(activeCardStyle.boxShadow)
      || activeCardStyle.bgImage !== 'none'
      || activeCardStyle.afterContent !== 'none') {
      throw new Error(`pickup active card style diverges from order dashboard: ${JSON.stringify(activeCardStyle)}`);
    }

    await page.locator('.pickup-stat-card[data-view="unpicked"]').click();
    await page.waitForFunction(() => /未取片|Unpicked/.test(document.querySelector('#listTitle')?.textContent || ''), null, { timeout: 10000 });
    const unpickedText = await page.locator('#list').textContent();
    if (!unpickedText.includes(customer.company)) throw new Error('unpicked tab should include target customer');

    await page.locator('.pickup-stat-card[data-view="batches"]').click();
    await page.waitForFunction(() => /提货批次|Pickup Batches/.test(document.querySelector('#listTitle')?.textContent || ''), null, { timeout: 10000 });
    await page.fill('#pickupSearch', customer.company);
    await page.waitForFunction((company) => {
      const rows = [...document.querySelectorAll('#list .row')];
      return rows.length === 1 && rows[0].textContent.includes(company);
    }, customer.company, { timeout: 10000 });
    const searchMeta = await page.locator('#pickupSearchMeta').textContent();
    if (!/显示 1 \//.test(searchMeta || '') && !/Showing 1 \//.test(searchMeta || '')) {
      throw new Error(`pickup batch search meta invalid: ${searchMeta}`);
    }
    await page.fill('#pickupSearch', 'no-such-pickup-batch-' + Date.now());
    await page.waitForFunction(() => /没有匹配内容|No matching records/.test(document.querySelector('#list')?.textContent || ''), null, { timeout: 10000 });
    await page.goto(detailUrl, { waitUntil: 'networkidle' });
    let nativeDialogOpened = false;
    page.once('dialog', async dialog => {
      nativeDialogOpened = true;
      await dialog.dismiss();
    });
    await page.locator('.menu-trigger').first().click();
    await page.locator('.menu-pop button', { hasText: /回退|Revert/ }).click();
    await page.waitForSelector('.modal-backdrop.open textarea', { timeout: 10000 });
    await page.fill('.modal-backdrop.open textarea', 'browser qa revert');
    await page.locator('.modal-backdrop.open [data-role="ok"]').click();
    await page.waitForTimeout(800);
    if (nativeDialogOpened) throw new Error('pickup revert should use in-app modal, not native dialog');
    const after = await page.locator('#body').textContent();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (!/已回退|Reverted/.test(after || '')) throw new Error('reverted marker missing');
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    await page.goto(BASE + '/pickup-batches.html', { waitUntil: 'networkidle' });
    await page.locator('.pickup-stat-card[data-view="reverted"]').click();
    await page.fill('#pickupSearch', customer.company);
    await page.waitForFunction((company) => {
      const text = document.querySelector('#list')?.textContent || '';
      return text.includes(company) && /已回退|Reverted/.test(text);
    }, customer.company, { timeout: 10000 });
    if (errors.length) throw new Error(errors.join(' | '));
    console.log(`PICKUP BATCH BROWSER QA PASS customer=${customer.id} url=${page.url()}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
