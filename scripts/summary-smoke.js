#!/usr/bin/env node
/* Summary API and page smoke. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  return { status: res.status, data };
}
async function login(loginName, password) {
  const res = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${loginName}: ${res.status}`);
  return res.data;
}

(async () => {
  const boss = await login('bossdemo', 'boss123456');
  const worker = await login('workerdemo', 'worker123456');
  const bossSummary = await api('/api/summary/overview', { headers: { Authorization: `Bearer ${boss.token}` } });
  if (bossSummary.status !== 200 || !bossSummary.data.totals || !Array.isArray(bossSummary.data.by_customer)) {
    throw new Error(`boss summary failed ${bossSummary.status}`);
  }
  const workerSummary = await api('/api/summary/overview', { headers: { Authorization: `Bearer ${worker.token}` } });
  if (workerSummary.status !== 403) throw new Error(`worker summary expected 403 got ${workerSummary.status}`);
  const customer = bossSummary.data.by_customer.find(c => Number(c.orders || 0) > 0);
  if (customer) {
    const detail = await api(`/api/summary/customers/${customer.customer_id}`, { headers: { Authorization: `Bearer ${boss.token}` } });
    if (detail.status !== 200 || !Array.isArray(detail.data.orders)) throw new Error(`customer summary failed ${detail.status}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('glassorder_token', token);
      localStorage.setItem('glassorder_user', JSON.stringify(user));
      localStorage.setItem('glassorder_lang', 'zh');
    }, { token: boss.token, user: boss.user });
    await page.goto(BASE + '/summary.html', { waitUntil: 'networkidle' });
    const text = await page.locator('#body').textContent();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (!/按状态汇总|By Status/.test(text || '') || !/按客户汇总|By Customer/.test(text || '')) {
      throw new Error('summary page sections missing');
    }
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    if (errors.length) throw new Error(errors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`SUMMARY SMOKE PASS orders=${bossSummary.data.totals.orders} customers=${bossSummary.data.by_customer.length}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
