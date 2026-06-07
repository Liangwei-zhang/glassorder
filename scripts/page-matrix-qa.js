#!/usr/bin/env node
/* Broad browser page matrix QA for launch readiness. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function login(loginName, password) {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
}

async function loginAny(candidates) {
  let lastError = null;
  for (const item of candidates) {
    try {
      return await login(item[0], item[1]);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('login failed');
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function createReadyOrder(session, customerId, stamp, suffix) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% page matrix qa ${stamp} ${suffix}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-05-30');
  form.set('pdf', new File([pdf], `page-matrix-${stamp}-${suffix}.pdf`, { type: 'application/pdf' }));
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

async function createMatrixData(session) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const customerRes = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `Page Matrix ${stamp}`,
      contact_name: 'QA',
      email: `page-matrix-${stamp}@example.test`,
    }),
  });
  const customer = customerRes.customer;
  const orderA = await createReadyOrder(session, customer.id, stamp, 'A');
  const orderB = await createReadyOrder(session, customer.id, stamp, 'B');
  const batchRes = await api('/api/pickups/batches', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      piece_ids: [orderA.order.pieces[0].id, orderB.order.pieces[1].id],
      signer_name: 'Page Matrix Signer',
      signer_phone: '403-555-0140',
      signature_base64: SIG,
    }),
  });
  return {
    customer,
    orderId: orderA.order.id,
    batchId: batchRes.batch.id,
  };
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function checkPage(page, pagePath, expected, label) {
  await page.goto(BASE + pagePath, { waitUntil: 'networkidle' });
  if (expected.url) await page.waitForURL(expected.url, { timeout: 10000 });
  if (expected.selector) await page.waitForSelector(expected.selector, { timeout: 10000 });
  if (expected.text) {
    const body = await page.locator('body').textContent();
    if (!expected.text.test(body || '')) throw new Error(`${label} missing text ${expected.text}`);
  }
  const qa = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const bottomNav = document.querySelector('.bottom-nav');
    const actionBar = document.querySelector('.action-bar');
    const navRect = bottomNav ? bottomNav.getBoundingClientRect() : null;
    const actionRect = actionBar ? actionBar.getBoundingClientRect() : null;
    const overlap = !!(navRect && actionRect && !(actionRect.bottom <= navRect.top || actionRect.top >= navRect.bottom));
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
    const bodyText = clone.textContent || '';
    return {
      overflow,
      bottomNavCount: document.querySelectorAll('.bottom-nav').length,
      bottomNavItems: document.querySelectorAll('.bottom-nav a').length,
      hasActionBar: !!actionBar,
      overlap,
      hasNaN: /\bNaN\b/.test(bodyText),
      hasUndefined: /\bundefined\b/.test(bodyText),
    };
  });
  if (qa.overflow > 2) throw new Error(`${label} horizontal overflow ${qa.overflow}px`);
  if (qa.overlap) throw new Error(`${label} bottom nav overlaps action bar`);
  if (qa.hasNaN || qa.hasUndefined) throw new Error(`${label} rendered invalid text ${JSON.stringify(qa)}`);
  if (expected.bossNav && (qa.bottomNavCount !== 1 || qa.bottomNavItems !== 5)) {
    throw new Error(`${label} expected boss nav, got ${JSON.stringify(qa)}`);
  }
  if (expected.noBottomNav && qa.bottomNavCount !== 0) {
    throw new Error(`${label} expected no bottom nav, got ${JSON.stringify(qa)}`);
  }
  if (expected.noActionBarWithNav && qa.bottomNavCount && qa.hasActionBar) {
    throw new Error(`${label} has both bottom nav and action bar`);
  }
  if (expected.pickupFab) {
    const fab = await page.locator('.fab[href="pickup-search.html"]').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        rightGap: window.innerWidth - rect.right,
        bottomGap: window.innerHeight - rect.bottom,
        navGap: nav ? nav.top - rect.bottom : null,
        topbarActionCount: document.querySelectorAll('.topbar .topbar-action').length,
      };
    });
    if (fab.text !== '+') throw new Error(`${label} pickup FAB should be plus, got ${JSON.stringify(fab)}`);
    if (fab.rightGap < 8 || fab.bottomGap < 70 || fab.navGap < 20) {
      throw new Error(`${label} pickup FAB placement invalid ${JSON.stringify(fab)}`);
    }
    if (fab.topbarActionCount !== 0) {
      throw new Error(`${label} should not keep topbar pickup action ${JSON.stringify(fab)}`);
    }
  }
}

(async () => {
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const worker = await loginAny([['worker', 'worker123'], ['workerdemo', 'worker123456']]);
  const data = await createMatrixData(boss);
  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false },
  ];
  const checks = [];
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: vp.viewport,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${vp.name}: ${msg.text()}`); });
      page.on('pageerror', (err) => errors.push(`${vp.name}: ${err.message}`));

      await checkPage(page, '/login.html', { selector: '#form', noBottomNav: true }, `${vp.name} login`);
      await page.goto(BASE + '/boss-workspace.html', { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/login\.html$/, { timeout: 10000 });
      checks.push(`${vp.name} unauth boss redirect`);

      await seedSession(page, boss);
      const bossPages = [
        ['/boss-workspace.html', { url: /boss-dashboard\.html$/, selector: '#list', bossNav: true, noActionBarWithNav: true }],
        ['/boss-dashboard.html', { selector: '#list', bossNav: true, noActionBarWithNav: true }],
        ['/boss-dashboard.html?archived=1', { selector: '#list', bossNav: true, noActionBarWithNav: true }],
        ['/customers.html', { selector: '#list', bossNav: true, noActionBarWithNav: true }],
        ['/boss-new-order.html', { selector: '#customerPicker input[type="search"]', noBottomNav: true }],
        [`/boss-order-detail.html?id=${data.orderId}`, { selector: '#body', noBottomNav: true }],
        ['/worker-queue.html', { selector: '#list', bossNav: true, noActionBarWithNav: true }],
        [`/worker-pieces.html?id=${data.orderId}&stage=all`, { selector: '#grid', noBottomNav: true }],
        ['/pickup-batches.html', { selector: '#list', bossNav: true, noActionBarWithNav: true, pickupFab: true }],
        ['/pickup-search.html', { selector: '#customerPicker input[type="search"]', noBottomNav: true }],
        [`/pickup-batch-detail.html?id=${data.batchId}`, { selector: '#body', bossNav: true, noActionBarWithNav: true }],
        ['/summary.html', { selector: '#body', bossNav: true, noActionBarWithNav: true }],
        [`/summary-customer.html?id=${data.customer.id}`, { selector: '#body', noBottomNav: true }],
      ];
      for (const [pagePath, expected] of bossPages) {
        await checkPage(page, pagePath, expected, `${vp.name} boss ${pagePath}`);
        checks.push(`${vp.name} boss ${pagePath}`);
      }

      await seedSession(page, worker);
      await checkPage(page, '/worker-queue.html', { selector: '#list', noBottomNav: true }, `${vp.name} worker queue`);
      await checkPage(page, `/worker-pieces.html?id=${data.orderId}&stage=all`, { selector: '#grid', noBottomNav: true }, `${vp.name} worker pieces`);
      for (const bossOnly of ['/boss-workspace.html', '/boss-dashboard.html', '/pickup-batches.html', '/summary.html', '/customers.html']) {
        await checkPage(page, bossOnly, { url: /worker-queue\.html$/, selector: '#list', noBottomNav: true }, `${vp.name} worker blocked ${bossOnly}`);
      }
      checks.push(`${vp.name} worker role gates`);

      if (errors.length) throw new Error(errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`PAGE MATRIX QA PASS checks=${checks.length}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
