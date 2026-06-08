#!/usr/bin/env node
/* UI regression QA for fixed bottom bars, narrow controls, and scroll reachability. */
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

async function loginAny(candidates) {
  let lastError = null;
  for (const [login, password] of candidates) {
    try {
      return await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('login failed');
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createCustomer(session, stamp) {
  const res = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `UI QA ${stamp}`,
      contact_name: 'QA',
      phone: '403-555-0198',
      email: `ui-${stamp}@example.test`,
    }),
  });
  return res.customer;
}

async function createOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% ui regression qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260611 UI Regression PO UI-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', { method: 'POST', headers: auth(session), body: form });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

async function completeOrder(session, order) {
  await api('/api/pieces/batch', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', piece_ids: order.pieces.map((p) => p.id) }),
  });
  await api(`/api/orders/${order.id}/ready`, { method: 'POST', headers: auth(session) });
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function removeTransientUi(page) {
  await page.evaluate(() => {
    document.getElementById('pwa-banner-stack')?.remove();
    document.querySelectorAll('.toast').forEach((el) => el.remove());
  });
}

async function settleMotion(page) {
  await page.waitForTimeout(650);
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 2) throw new Error(`${label} horizontal overflow ${overflow}px`);
}

async function assertBottomItemReachable(page, label, rowSelector) {
  const result = await page.evaluate(async (selector) => {
    const rows = Array.from(document.querySelectorAll(selector))
      .filter((el) => el.offsetParent !== null);
    const nav = document.querySelector('.bottom-nav');
    if (!nav) return { hasNav: false, rows: rows.length };
    const last = rows[rows.length - 1];
    if (!last) return { hasNav: true, rows: 0 };
    for (let i = 0; i < 3; i += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rowRect = last.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      hasNav: true,
      rows: rows.length,
      rowBottom: rowRect.bottom,
      navTop: navRect.top,
      gap: navRect.top - rowRect.bottom,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    };
  }, rowSelector);
  if (!result.hasNav) throw new Error(`${label} expected bottom nav`);
  if (!result.rows) throw new Error(`${label} has no rows for reachability check`);
  if (result.gap < -2) {
    throw new Error(`${label} last row remains under bottom nav: ${JSON.stringify(result)}`);
  }
}

async function assertActionBarReachable(page, label, contentSelector) {
  const result = await page.evaluate(async (selector) => {
    const action = document.querySelector('.action-bar');
    const target = document.querySelector(selector);
    if (!action || !target) return { hasAction: !!action, hasTarget: !!target };
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const actionRect = action.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      hasAction: true,
      hasTarget: true,
      targetBottom: targetRect.bottom,
      actionTop: actionRect.top,
      gap: actionRect.top - targetRect.bottom,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    };
  }, contentSelector);
  if (!result.hasAction || !result.hasTarget) {
    throw new Error(`${label} missing action bar/target ${JSON.stringify(result)}`);
  }
  if (result.gap < -2) {
    throw new Error(`${label} content remains under action bar: ${JSON.stringify(result)}`);
  }
}

async function assertButtonsFit(page, label, selector) {
  const result = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) return { found: false };
    const rootRect = root.getBoundingClientRect();
    const buttons = Array.from(root.querySelectorAll('button, a.btn')).filter((el) => el.offsetParent !== null);
    return {
      found: true,
      root: {
        width: rootRect.width,
        height: rootRect.height,
        left: rootRect.left,
        right: rootRect.right,
      },
      buttons: buttons.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || el.getAttribute('aria-label') || '').trim(),
          width: rect.width,
          height: rect.height,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          clippedX: el.scrollWidth > el.clientWidth + 1,
          clippedY: el.scrollHeight > el.clientHeight + 1,
          outOfBar: rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1,
        };
      }),
    };
  }, selector);
  if (!result.found) throw new Error(`${label} missing ${selector}`);
  const bad = result.buttons.filter((btn) => btn.clippedX || btn.clippedY || btn.outOfBar);
  if (bad.length) throw new Error(`${label} clipped/overflow buttons: ${JSON.stringify({ root: result.root, bad })}`);
}

async function gotoBossPage(page, session, pagePath, waitSelector) {
  await seedSession(page, session);
  await page.goto(BASE + pagePath, { waitUntil: 'networkidle' });
  await page.waitForSelector(waitSelector, { timeout: 10000 });
  await removeTransientUi(page);
  await settleMotion(page);
}

(async () => {
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customer = await createCustomer(boss, stamp);
  const workerOrder = (await createOrder(boss, customer.id, stamp, 'worker')).order;
  const pickupOrder = (await createOrder(boss, customer.id, stamp, 'pickup')).order;
  await completeOrder(boss, pickupOrder);

  const browser = await chromium.launch({ headless: true });
  const checks = [];
  try {
    for (const viewport of [
      { name: 'mobile-320', width: 320, height: 740, isMobile: true, hasTouch: true },
      { name: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true },
      { name: 'desktop', width: 1280, height: 900, isMobile: false, hasTouch: false },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${viewport.name}: ${msg.text()}`); });
      page.on('pageerror', (err) => errors.push(`${viewport.name}: ${err.message}`));

      const bottomNavPages = [
        ['/boss-dashboard.html', '#list .row', '#list'],
        ['/customers.html', '#list .row', '#list'],
        ['/worker-queue.html', '#list .row', '#list'],
        ['/pickup-batches.html', '#list .row', '#list'],
      ];
      for (const [pagePath, rowSelector, waitSelector] of bottomNavPages) {
        await gotoBossPage(page, boss, pagePath, waitSelector);
        await assertNoHorizontalOverflow(page, `${viewport.name} ${pagePath}`);
        await assertBottomItemReachable(page, `${viewport.name} ${pagePath}`, rowSelector);
        checks.push(`${viewport.name} ${pagePath}`);
      }

      await gotoBossPage(page, boss, `/worker-pieces.html?id=${workerOrder.id}&stage=cut`, '#grid [data-id]');
      await page.locator('#selectToggle').click();
      await page.waitForSelector('.action-bar.select-actions');
      await assertNoHorizontalOverflow(page, `${viewport.name} worker select`);
      await assertButtonsFit(page, `${viewport.name} worker select`, '.action-bar.select-actions');
      await assertActionBarReachable(page, `${viewport.name} worker select`, '#grid [data-id]:last-child');
      checks.push(`${viewport.name} worker select`);

      await gotoBossPage(page, boss, `/pickup-search.html?customer_id=${customer.id}`, '#customerPicker input[type="search"]');
      await page.fill('#customerPicker input[type="search"]', customer.company);
      await page.locator(`.customer-picker-option[data-id="${customer.id}"]`).click();
      await page.waitForSelector('[data-piece]');
      await page.locator('#pickupSelectAllBtn').click();
      await page.waitForSelector('#signatureCard:not([style*="display:none"])');
      await assertNoHorizontalOverflow(page, `${viewport.name} pickup`);
      await assertButtonsFit(page, `${viewport.name} pickup action`, '.action-bar');
      await assertButtonsFit(page, `${viewport.name} pickup bulk`, '.pickup-bulk-actions');
      await assertButtonsFit(page, `${viewport.name} pickup order actions`, '.pickup-order-actions');
      await assertActionBarReachable(page, `${viewport.name} pickup`, '#signatureCard');
      checks.push(`${viewport.name} pickup`);

      if (errors.length) throw new Error(errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`UI REGRESSION QA PASS checks=${checks.length} customer=${customer.id} worker_order=${workerOrder.id} pickup_order=${pickupOrder.id}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
