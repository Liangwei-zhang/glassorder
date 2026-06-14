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
  const file = new File([pdf], `Glass Order - 260601 Browser QA PO BROWSER-${stamp}.pdf`, { type: 'application/pdf' });
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
  return {
    orderId,
    customerId: customer.customer.id,
    orderNumber: created.order.order_number,
    company: customer.customer.company,
  };
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
  const box = await page.locator('#customerSig').boundingBox();
  if (!box) throw new Error('signature canvas missing');
  const points = [
    { clientX: box.x + 30, clientY: box.y + 30 },
    { clientX: box.x + 70, clientY: box.y + 52 },
    { clientX: box.x + 110, clientY: box.y + 48 },
    { clientX: box.x + 150, clientY: box.y + 34 },
  ];
  await page.dispatchEvent('#customerSig', 'pointerdown', { ...points[0], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  for (const point of points.slice(1)) {
    await page.dispatchEvent('#customerSig', 'pointermove', { ...point, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 });
  }
  await page.dispatchEvent('#customerSig', 'pointerup', { ...points[points.length - 1], pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 0 });
}

async function waitSelectedCount(page, expected) {
  await page.waitForFunction((n) => (
    document.querySelectorAll('[data-piece]:checked').length === n
      && new RegExp(`(已选 ${n} 片|${n} selected)`, 'i').test(document.querySelector('#pickupStepper')?.textContent || '')
  ), expected, { timeout: 10000 });
}

async function dashboardStatValues(page) {
  await page.waitForTimeout(820);
  return page.evaluate(() => (
    [...document.querySelectorAll('.dashboard-stats .num-big')]
      .map((el) => (el.dataset.countAnimated || el.textContent || '').trim())
  ));
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

      // Dashboard fuzzy search: order numbers should match even when separators are omitted.
      await page.goto(BASE + '/boss-dashboard.html', { waitUntil: 'networkidle' });
      const dashboardStatsBeforeSearch = await dashboardStatValues(page);
      const compactOrderSearch = seeded.orderNumber.replace(/[^0-9A-Za-z]/g, '');
      const searchResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('search') === compactOrderSearch
          && response.status() === 200;
      }, { timeout: 10000 });
      await page.fill('#search', compactOrderSearch);
      await searchResponse;
      await page.waitForFunction((orderNumber) => {
        const rows = [...document.querySelectorAll('#list .row')];
        return rows.length === 1 && rows[0].textContent.includes(orderNumber);
      }, seeded.orderNumber, { timeout: 10000 });
      const dashboardSearchQa = await page.evaluate((orderNumber) => {
        const rows = [...document.querySelectorAll('#list .row')];
        const stats = [...document.querySelectorAll('.dashboard-stats .num-big')]
          .map((el) => (el.dataset.countAnimated || el.textContent || '').trim());
        return {
          count: rows.length,
          hasTarget: rows.some((row) => row.textContent.includes(orderNumber)),
          stats,
          text: document.querySelector('#list')?.textContent || '',
        };
      }, seeded.orderNumber);
      if (!dashboardSearchQa.hasTarget || dashboardSearchQa.count !== 1) {
        throw new Error(`dashboard fuzzy order search failed: ${JSON.stringify(dashboardSearchQa)}`);
      }
      if (JSON.stringify(dashboardSearchQa.stats) !== JSON.stringify(dashboardStatsBeforeSearch)) {
        throw new Error(`dashboard stats changed during search: ${JSON.stringify({ before: dashboardStatsBeforeSearch, after: dashboardSearchQa.stats })}`);
      }
      checks.push('Dashboard fuzzy order search');

      // Dashboard filters: stats act as shortcuts and the dense filter row is collapsed.
      const dashboardFilterQa = await page.evaluate(() => ({
        visibleFilters: [...document.querySelectorAll('.dashboard-filter-bar .filter-btn')].map((btn) => btn.textContent.trim()),
        statShortcuts: [...document.querySelectorAll('[data-quick-filter]')].map((btn) => btn.dataset.quickFilter),
        priorityCards: document.querySelectorAll('.dashboard-task-card').length,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      if (dashboardFilterQa.visibleFilters.length !== 3
        || !dashboardFilterQa.visibleFilters.some((label) => /已取货|Picked Up/i.test(label))
        || !dashboardFilterQa.visibleFilters.some((label) => /筛选|Filter/i.test(label))
        || !dashboardFilterQa.statShortcuts.includes('ready_pickup')
        || dashboardFilterQa.priorityCards < 1
        || dashboardFilterQa.overflow > 2) {
        throw new Error(`dashboard collapsed filters failed: ${JSON.stringify(dashboardFilterQa)}`);
      }
      await page.locator('#moreFilterBtn').click();
      const secondaryFilters = await page.locator('.menu-pop button').evaluateAll((buttons) => buttons.map((btn) => btn.textContent.trim()));
      if (!secondaryFilters.some((label) => /归档|Archive/i.test(label))
        || !secondaryFilters.some((label) => /加急|Rush/i.test(label))
        || !secondaryFilters.some((label) => /逾期|Overdue/i.test(label))
        || !secondaryFilters.some((label) => /生产中|In Production/i.test(label))
        || !secondaryFilters.some((label) => /可取货|Ready for Pickup/i.test(label))
        || !secondaryFilters.some((label) => /待补片|Rework/i.test(label))) {
        throw new Error(`dashboard secondary filters missing expected actions: ${JSON.stringify(secondaryFilters)}`);
      }
      await page.keyboard.press('Escape');
      const quickPickupResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('status') === 'ready_pickup'
          && response.status() === 200;
      }, { timeout: 10000 });
      await page.locator('[data-quick-filter="ready_pickup"]').click();
      await quickPickupResponse;
      const quickPickupActive = await page.locator('[data-quick-filter="ready_pickup"]').evaluate((el) => el.classList.contains('active'));
      if (!quickPickupActive) throw new Error('ready pickup stat shortcut did not become active');
      const beforeFilterStats = await dashboardStatValues(page);
      await page.locator('[data-quick-filter="in_production"]').click();
      await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('status') === 'in_production'
          && response.status() === 200;
      }, { timeout: 10000 });
      const afterProductionStats = await dashboardStatValues(page);
      await page.locator('[data-quick-filter="ready_pickup"]').click();
      await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('status') === 'ready_pickup'
          && response.status() === 200;
      }, { timeout: 10000 });
      const afterReadyStats = await dashboardStatValues(page);
      await page.locator('[data-quick-filter="rework"]').click();
      await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('filter') === 'rework'
          && response.status() === 200;
      }, { timeout: 10000 });
      const afterReworkStats = await dashboardStatValues(page);
      const dashboardStatsStable = {
        before: beforeFilterStats,
        afterProduction: afterProductionStats,
        afterReady: afterReadyStats,
        afterRework: afterReworkStats,
      };
      const stableJson = JSON.stringify(dashboardStatsStable.before);
      if (JSON.stringify(dashboardStatsStable.afterProduction) !== stableJson
        || JSON.stringify(dashboardStatsStable.afterReady) !== stableJson
        || JSON.stringify(dashboardStatsStable.afterRework) !== stableJson) {
        throw new Error(`dashboard stats changed across filters: ${JSON.stringify(dashboardStatsStable)}`);
      }
      checks.push('Dashboard collapsed filter UX');

      await page.goto(BASE + '/boss-dashboard.html', { waitUntil: 'networkidle' });

      // Dashboard long-press menu: list row exposes the detail-page quick actions.
      const row = page.locator(`.order-row[data-order-id="${seeded.orderId}"]`);
      const rowBox = await row.boundingBox();
      if (!rowBox) throw new Error('dashboard order row missing for long-press menu');
      const longPressPoint = { clientX: rowBox.x + rowBox.width / 2, clientY: rowBox.y + rowBox.height / 2 };
      await row.dispatchEvent('pointerdown', {
        ...longPressPoint,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
      });
      await page.waitForSelector('.menu-pop button', { timeout: 10000 });
      await row.dispatchEvent('pointerup', {
        ...longPressPoint,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 0,
      });
      const menuLabels = await page.locator('.menu-pop button').evaluateAll((buttons) => buttons.map((btn) => btn.textContent.trim()));
      if (!menuLabels.some((label) => /修改订单|Edit order/i.test(label))
        || !menuLabels.some((label) => /通知可取货|Mark Ready/i.test(label))
        || !menuLabels.some((label) => /订单详情|Order Detail/i.test(label))) {
        throw new Error(`dashboard long-press menu missing expected actions: ${JSON.stringify(menuLabels)}`);
      }
      await page.locator('.menu-pop button', { hasText: /修改订单|Edit order/i }).click();
      await page.waitForSelector('#dashboardEditModal.open');
      await page.locator('#dashboardEditModal .btn-ghost').click();
      checks.push('Dashboard long-press order menu');

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
      const pickupHref = await page.locator('#actions a.btn-success').getAttribute('href');
      if (!pickupHref || !pickupHref.includes(`pickup-search.html?order_id=${seeded.orderId}`)) {
        throw new Error(`Q4 detail pickup action should use piece-level pickup flow, got ${pickupHref}`);
      }
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

      // Q4 pickup confirmation modal: detail action and legacy pickup-sign route must both land in piece-level pickup flow.
      await page.goto(BASE + `/pickup-sign.html?id=${seeded.orderId}`, { waitUntil: 'networkidle' });
      await page.waitForURL(new RegExp(`pickup-search\\.html\\?order_id=${seeded.orderId}$`), { timeout: 10000 });
      await page.waitForSelector('[data-piece]');
      const piecesFromLegacy = await page.locator('[data-piece]').count();
      if (piecesFromLegacy !== 8) throw new Error(`legacy pickup-sign redirect should show 8 selectable pieces, got ${piecesFromLegacy}`);
      await page.locator('[data-piece]').nth(0).check();
      await waitSelectedCount(page, 1);
      await page.locator('[data-piece]').nth(2).check();
      await waitSelectedCount(page, 2);
      await page.locator('#submitBtn').click();
      await page.waitForSelector('.modal-backdrop.open');
      const pickupModal = await page.locator('.modal-backdrop.open').textContent();
      if (!/签字二维码|Signing QR|二维码/i.test(pickupModal || '')) {
        throw new Error(`Q4 pickup QR confirmation modal missing: ${pickupModal}`);
      }
      await page.locator('.modal-backdrop.open [data-role="ok"]').click();
      await page.waitForSelector('#qrCard:not([style*="display:none"]) svg', { timeout: 10000 });
      const signUrl = await page.locator('#qrLink').textContent();
      if (!/customer-sign\.html\?t=/.test(signUrl || '')) throw new Error(`Q4 pickup QR url missing: ${signUrl}`);
      const disabledWhileQr = await page.locator('[data-piece]:disabled').count();
      if (disabledWhileQr < 2) throw new Error(`pickup QR should lock selected piece checks, disabled=${disabledWhileQr}`);

      const customerPage = await context.newPage();
      await customerPage.goto(signUrl.trim(), { waitUntil: 'networkidle' });
      await customerPage.waitForSelector('#customerSig', { timeout: 10000 });
      const customerSignText = await customerPage.locator('body').textContent();
      if (!/签收确认|Pickup Sign-off/.test(customerSignText || '') || !/本次取货|Pickup pieces/.test(customerSignText || '')) {
        throw new Error(`customer QR sign page missing summary: ${customerSignText}`);
      }
      if (/客户管理|Customers|403-555|example\.test/.test(customerSignText || '')) {
        throw new Error(`customer QR sign page leaked sensitive/admin text: ${customerSignText}`);
      }
      await customerPage.fill('#signerName', 'Browser QA Signer');
      await customerPage.fill('#signerPhone', '403-555-1212');
      await drawSignature(customerPage);
      await customerPage.locator('#submitSignBtn').click();
      await customerPage.waitForFunction(() => /签收完成|Signature Submitted/.test(document.body.textContent || ''), null, { timeout: 10000 });
      await customerPage.close();

      await page.waitForURL(/pickup-batch-detail\.html\?id=/, { timeout: 15000 });
      const createdBatchId = new URL(page.url()).searchParams.get('id');
      const signedBatch = await api(`/api/pickups/batches/${createdBatchId}`, { headers: authHeaders(session) });
      if (!signedBatch.batch.signature_path) throw new Error('QR signed browser pickup should store signature_path');
      const batchText = await page.locator('#body').textContent();
      if (!/第 1 片|Piece #1/.test(batchText || '') || !/第 3 片|Piece #3/.test(batchText || '') || !/订单数|Orders/.test(batchText || '')) {
        throw new Error('Q4 piece-level pickup batch detail missing selected pieces');
      }
      checks.push('Q4 QR customer pickup sign-off');

      // Q5 detail timeline after partial piece-level pickup.
      await page.goto(BASE + `/boss-order-detail.html?id=${seeded.orderId}`, { waitUntil: 'networkidle' });
      const detailText = await page.locator('#body').textContent();
      if (!/事件时间线|Timeline/.test(detailText || '') || !/片取货|Piece picked up/.test(detailText || '')) {
        throw new Error('Q5 timeline missing piece-level pickup event');
      }
      checks.push('Q5 piece-level timeline');

      // Q8 piece-level pickup state: selected customer still has the unpicked pieces available.
      await page.goto(BASE + '/pickup-search.html', { waitUntil: 'networkidle' });
      await page.fill('#customerPicker input[type="search"]', seeded.company);
      await page.locator(`.customer-picker-option[data-id="${seeded.customerId}"]`).click();
      const remainingAvailable = await api(`/api/pickups/available?customer_id=${seeded.customerId}`, { headers: authHeaders(session) });
      const remainingPieceIds = (remainingAvailable.pieces || [])
        .filter((item) => Number(item.order_id) === Number(seeded.orderId))
        .map((item) => item.id);
      if (remainingPieceIds.length !== 6) {
        throw new Error(`expected 6 remaining pieces before final pickup, got ${remainingPieceIds.length}`);
      }
      await page.waitForFunction((ids) => {
        const visible = [...document.querySelectorAll('#available [data-piece]')]
          .filter((input) => ids.includes(Number(input.dataset.piece)));
        return visible.length === ids.length;
      }, remainingPieceIds, { timeout: 10000 });
      const visibleRemainingPieces = await page.locator('#available [data-piece]').evaluateAll((inputs, ids) => (
        inputs.filter((input) => ids.includes(Number(input.dataset.piece))).length
      ), remainingPieceIds);
      if (visibleRemainingPieces !== 6) {
        throw new Error(`Q8 expected 6 visible remaining pickup pieces, got ${visibleRemainingPieces}`);
      }
      checks.push('Q8 partial pickup remainder');

      // Finish remaining pieces so the active orders page can expose it under the picked-up filter.
      const finalPickup = await api('/api/pickups/batches', {
        method: 'POST',
        headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: seeded.customerId,
          piece_ids: remainingPieceIds,
          signer_name: 'Browser QA Final',
          signer_phone: '403-555-3434',
          signature_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        }),
      });
      if (!finalPickup.batch || !finalPickup.batch.items || finalPickup.batch.items.length !== 6) {
        throw new Error(`final pickup batch failed: ${JSON.stringify(finalPickup)}`);
      }

      await page.goto(BASE + '/boss-dashboard.html', { waitUntil: 'networkidle' });
      const pickedResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/orders'
          && url.searchParams.get('status') === 'picked_up'
          && response.status() === 200;
      }, { timeout: 10000 });
      await page.locator('[data-filter="picked_up"]').click();
      await pickedResponse;
      await page.waitForSelector(`.order-row[data-order-id="${seeded.orderId}"]`, { timeout: 10000 });
      const pickedRow = page.locator(`.order-row[data-order-id="${seeded.orderId}"]`);
      const pickedBox = await pickedRow.boundingBox();
      if (!pickedBox) throw new Error('picked-up order row missing after filter');
      const pickedLongPressPoint = { clientX: pickedBox.x + pickedBox.width / 2, clientY: pickedBox.y + pickedBox.height / 2 };
      await pickedRow.dispatchEvent('pointerdown', {
        ...pickedLongPressPoint,
        pointerId: 8,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
      });
      await page.waitForSelector('.menu-pop button', { timeout: 10000 });
      await pickedRow.dispatchEvent('pointerup', {
        ...pickedLongPressPoint,
        pointerId: 8,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 0,
      });
      const pickedMenuLabels = await page.locator('.menu-pop button').evaluateAll((buttons) => buttons.map((btn) => btn.textContent.trim()));
      if (!pickedMenuLabels.some((label) => /移入归档|Move to archive/i.test(label))
        || !pickedMenuLabels.some((label) => /重发交割单|Resend Slip/i.test(label))) {
        throw new Error(`picked-up long-press menu missing archive/slip actions: ${JSON.stringify(pickedMenuLabels)}`);
      }
      await page.keyboard.press('Escape');
      checks.push('Dashboard picked-up filter and archive menu');
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
