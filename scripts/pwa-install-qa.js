#!/usr/bin/env node
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';

async function checkBrowserMode(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return page.evaluate(() => ({
    appMode: document.body.dataset.appMode || '',
    installButton: !!document.querySelector('[data-install-only-browser]:not([hidden]) button'),
    appLine: [...document.querySelectorAll('[data-app-line-browser]')].map((el) => el.textContent.trim()),
  }));
}

async function checkStandaloneMode(browser, path) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = original(query);
      if (query === '(display-mode: standalone)') {
        return { ...result, matches: true };
      }
      return result;
    };
  });
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const state = await page.evaluate(() => ({
    appMode: document.body.dataset.appMode || '',
    installHidden: [...document.querySelectorAll('[data-install-only-browser]')].every((el) => el.hidden),
    appLine: [...document.querySelectorAll('[data-app-line-browser]')].map((el) => el.textContent.trim()),
  }));
  await context.close();
  return state;
}

async function checkOfflineBanner(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForSelector('#pwa-banner-stack .pwa-banner.warn', { timeout: 5000 });
  const state = await page.evaluate(() => ({
    text: document.querySelector('#pwa-banner-stack .pwa-banner.warn')?.textContent || '',
  }));
  await page.context().setOffline(false);
  return state;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const loginBrowser = await checkBrowserMode(page, '/login.html');
    if (loginBrowser.appMode !== 'browser' || !loginBrowser.installButton) {
      throw new Error(`login browser mode invalid ${JSON.stringify(loginBrowser)}`);
    }

    const indexBrowser = await checkBrowserMode(page, '/index.html');
    if (indexBrowser.appMode !== 'browser' || !indexBrowser.installButton) {
      throw new Error(`index browser mode invalid ${JSON.stringify(indexBrowser)}`);
    }

    const offline = await checkOfflineBanner(page, '/login.html');
    if (!/离线|offline/i.test(offline.text)) {
      throw new Error(`offline banner missing ${JSON.stringify(offline)}`);
    }

    const loginStandalone = await checkStandaloneMode(browser, '/login.html');
    if (loginStandalone.appMode !== 'installed' || !loginStandalone.installHidden) {
      throw new Error(`login standalone invalid ${JSON.stringify(loginStandalone)}`);
    }

    const indexStandalone = await checkStandaloneMode(browser, '/index.html');
    if (indexStandalone.appMode !== 'installed' || !indexStandalone.installHidden) {
      throw new Error(`index standalone invalid ${JSON.stringify(indexStandalone)}`);
    }

    await context.close();
    console.log('PWA INSTALL QA PASS');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
