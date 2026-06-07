#!/usr/bin/env node
/* Browser QA for role redirects and boss bottom navigation. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';

async function loginApi(loginName, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`login failed ${loginName}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function loginAny(candidates) {
  let lastError = null;
  for (const item of candidates) {
    try {
      return await loginApi(item[0], item[1]);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('login failed');
}

async function seedSession(page, session) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('glassorder_token', token);
    localStorage.setItem('glassorder_user', JSON.stringify(user));
    localStorage.setItem('glassorder_lang', 'zh');
  }, { token: session.token, user: session.user });
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 2) throw new Error(`${label} horizontal overflow ${overflow}px`);
}

async function assertBossNav(page, active, label) {
  await page.waitForSelector('.bottom-nav');
  const nav = await page.evaluate(() => ({
    count: document.querySelectorAll('.bottom-nav a').length,
    text: document.querySelector('.bottom-nav').textContent,
    active: document.querySelector('.bottom-nav a.active') && document.querySelector('.bottom-nav a.active').textContent,
  }));
  if (nav.count !== 5) throw new Error(`${label} expected 5 nav items, got ${nav.count}`);
  for (const word of ['订单', '车间', '取货', '客户', '汇总']) {
    if (!nav.text.includes(word)) throw new Error(`${label} nav missing ${word}: ${nav.text}`);
  }
  if (!nav.active || !nav.active.includes(active)) throw new Error(`${label} active nav expected ${active}, got ${nav.active}`);
  await assertNoOverflow(page, label);
}

async function loginViaUi(page, loginName, password, expectedUrl) {
  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.fill('#login', loginName);
  await page.fill('#password', password);
  await page.locator('#submitBtn').click();
  await page.waitForURL(expectedUrl, { timeout: 10000 });
}

(async () => {
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const worker = await loginAny([['worker', 'worker123'], ['workerdemo', 'worker123456']]);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  try {
    await loginViaUi(page, 'admin', 'admin123', /boss-dashboard\.html$/);
    await assertBossNav(page, '订单', 'boss dashboard');

    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/boss-dashboard\.html$/, { timeout: 10000 });
    await assertBossNav(page, '订单', 'boss index redirect');

    await page.locator('.bottom-nav a[href="pickup-batches.html"]').click();
    await page.waitForURL(/pickup-batches\.html$/);
    await assertBossNav(page, '取货', 'boss pickup nav');

    await page.locator('.bottom-nav a[href="summary.html"]').click();
    await page.waitForURL(/summary\.html$/);
    await assertBossNav(page, '汇总', 'boss summary nav');

    await page.locator('.bottom-nav a[href="customers.html"]').click();
    await page.waitForURL(/customers\.html$/);
    await assertBossNav(page, '客户', 'boss customer nav');

    await page.locator('.bottom-nav a[href="worker-queue.html"]').click();
    await page.waitForURL(/worker-queue\.html$/);
    await assertBossNav(page, '车间', 'boss shop nav');

    await loginViaUi(page, 'worker', 'worker123', /worker-queue\.html$/);
    await page.waitForSelector('.topbar-title');
    const workerNavCount = await page.locator('.bottom-nav').count();
    if (workerNavCount !== 0) throw new Error(`worker should not see bottom nav, got ${workerNavCount}`);
    await assertNoOverflow(page, 'worker queue');

    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/worker-queue\.html$/, { timeout: 10000 });
    if (await page.locator('.bottom-nav').count()) throw new Error('worker index redirect shows bottom nav');

    await seedSession(page, worker);
    await page.goto(BASE + '/summary.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/worker-queue\.html$/, { timeout: 10000 });
    if (await page.locator('.bottom-nav').count()) throw new Error('worker summary redirect shows bottom nav');

    await seedSession(page, worker);
    await page.goto(BASE + '/pickup-batches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/worker-queue\.html$/, { timeout: 10000 });
    if (await page.locator('.bottom-nav').count()) throw new Error('worker pickup redirect shows bottom nav');

    await seedSession(page, boss);
    await page.goto(BASE + '/boss-workspace.html', { waitUntil: 'networkidle' });
    await page.waitForURL(/boss-dashboard\.html$/, { timeout: 10000 });
    await assertBossNav(page, '订单', 'boss legacy workspace redirect');

    if (errors.length) throw new Error(errors.join(' | '));
    console.log('NAVIGATION BROWSER QA PASS boss=bottom-nav worker=no-nav');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
