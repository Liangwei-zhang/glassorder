#!/usr/bin/env node
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8781';

async function checkBrowserMode(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return page.evaluate(() => ({
    appMode: document.body.dataset.appMode || '',
    installButton: !!document.querySelector('[data-install-only-browser]:not([hidden]) button'),
    appLine: [...document.querySelectorAll('[data-app-line-browser]')].map((el) => el.textContent.trim()),
    appLogo: (() => {
      const img = document.querySelector('.app-logo');
      return img ? {
        src: img.getAttribute('src') || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
      } : null;
    })(),
    favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || '',
    appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || '',
  }));
}

async function checkLogoAssets(page) {
  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  const state = await page.evaluate(async () => {
    const manifestRes = await fetch('/manifest.json');
    const manifest = await manifestRes.json();
    const paths = [
      '/icons/logo.jpg',
      '/icons/favicon-32.png',
      '/icons/apple-touch-icon.png',
      ...manifest.icons.map((icon) => `/${icon.src.replace(/^\/+/, '')}`),
    ];
    const loaded = [];
    for (const src of paths) {
      const img = new Image();
      img.src = src;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(`image failed ${src}`));
      });
      loaded.push({ src, width: img.naturalWidth, height: img.naturalHeight });
    }
    return {
      manifestIcons: manifest.icons,
      loaded,
      serviceWorkerVersion: await fetch('/sw.js').then((res) => res.text()).then((text) => {
        const match = text.match(/const VERSION = '([^']+)'/);
        return match ? match[1] : '';
      }),
    };
  });
  const expectedSizes = new Map([
    ['/icons/favicon-32.png', '32x32'],
    ['/icons/apple-touch-icon.png', '180x180'],
    ['/icons/icon-192.png', '192x192'],
    ['/icons/icon-512.png', '512x512'],
    ['/icons/icon-maskable-512.png', '512x512'],
  ]);
  for (const item of state.loaded) {
    if (item.width <= 0 || item.height <= 0) throw new Error(`logo asset did not load ${JSON.stringify(item)}`);
    const expected = expectedSizes.get(item.src);
    if (expected && `${item.width}x${item.height}` !== expected) {
      throw new Error(`logo asset size mismatch ${JSON.stringify({ item, expected })}`);
    }
  }
  if (!state.manifestIcons.some((icon) => icon.src === 'icons/icon-maskable-512.png' && /maskable/.test(icon.purpose || ''))) {
    throw new Error(`manifest maskable icon missing ${JSON.stringify(state.manifestIcons)}`);
  }
  if (!/(official-logo|login-ui|qr-sign|customer-no-install|direct-sign|piece-hold|mirror-edge|mirror-polish-edge|delete-order|barcode-scan|scan-style)/.test(state.serviceWorkerVersion)) {
    throw new Error(`service worker cache version did not update ${state.serviceWorkerVersion}`);
  }
  return state;
}

async function checkCustomerSignInstallSuppressed(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await page.goto(BASE + '/customer-sign.html?t=qa-no-token', { waitUntil: 'networkidle' });
  await page.waitForSelector('#state', { timeout: 5000 });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
  });
  await page.waitForTimeout(120);
  const state = await page.evaluate(async () => {
    let serviceWorkerRegistrations = 0;
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      serviceWorkerRegistrations = (await navigator.serviceWorker.getRegistrations()).length;
    }
    return {
      suppressMarker: document.body.dataset.pwaInstall || '',
      appMode: document.body.dataset.appMode || '',
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '',
      appleMobileCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content') || '',
      mobileWebAppCapable: document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute('content') || '',
      serviceWorkerRegistrations,
      banners: [...document.querySelectorAll('#pwa-banner-stack .pwa-banner')].map((el) => ({
        id: el.dataset.bannerId || '',
        text: el.textContent.trim(),
      })),
      installControlsHidden: [...document.querySelectorAll('[data-install-only-browser]')].every((el) => el.hidden),
    };
  });
  await context.close();
  return state;
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
    if (loginBrowser.appMode !== 'browser' || !loginBrowser.installButton
      || !loginBrowser.appLogo || loginBrowser.appLogo.src !== 'icons/logo.jpg'
      || loginBrowser.appLogo.width <= 0 || !/favicon-32\.png$/.test(loginBrowser.favicon)
      || !/apple-touch-icon\.png$/.test(loginBrowser.appleTouchIcon)) {
      throw new Error(`login browser mode invalid ${JSON.stringify(loginBrowser)}`);
    }

    const indexBrowser = await checkBrowserMode(page, '/index.html');
    if (indexBrowser.appMode !== 'browser' || !indexBrowser.installButton
      || !indexBrowser.appLogo || indexBrowser.appLogo.src !== 'icons/logo.jpg'
      || indexBrowser.appLogo.width <= 0 || !/favicon-32\.png$/.test(indexBrowser.favicon)
      || !/apple-touch-icon\.png$/.test(indexBrowser.appleTouchIcon)) {
      throw new Error(`index browser mode invalid ${JSON.stringify(indexBrowser)}`);
    }

    await checkLogoAssets(page);

    const offline = await checkOfflineBanner(page, '/login.html');
    if (!/离线|offline/i.test(offline.text)) {
      throw new Error(`offline banner missing ${JSON.stringify(offline)}`);
    }

    const customerInstall = await checkCustomerSignInstallSuppressed(browser);
    if (customerInstall.suppressMarker !== 'off' || customerInstall.banners.some((banner) => (
      ['install', 'ios-install', 'update-ready'].includes(banner.id)
    )) || customerInstall.manifest || customerInstall.appleMobileCapable
      || customerInstall.mobileWebAppCapable || customerInstall.serviceWorkerRegistrations) {
      throw new Error(`customer sign install prompt not suppressed ${JSON.stringify(customerInstall)}`);
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
