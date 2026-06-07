#!/usr/bin/env node
/* Browser QA for motion polish: transitions, reduced motion, and mobile fit. */
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

async function readMotionState(page) {
  return page.evaluate(() => {
    const body = document.body;
    const content = document.querySelector('.center-col, .content-shell, .boss-shell, .worker-shell');
    const nav = document.querySelector('.bottom-nav');
    const fab = document.querySelector('.fab');
    const firstRow = document.querySelector('.row');
    const stat = document.querySelector('.stat-tile, .pickup-stat-card, .worker-hero');
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const fabRect = fab ? fab.getBoundingClientRect() : null;
    const rowStyle = firstRow ? getComputedStyle(firstRow) : null;
    const statStyle = stat ? getComputedStyle(stat) : null;
    const contentStyle = content ? getComputedStyle(content) : null;
    const loader = document.querySelector('.page-transition-loader');
    const loaderImg = loader ? loader.querySelector('img') : null;
    const statNum = document.querySelector('.num-big, .pickup-stat-card .value, .worker-hero-num');
    return {
      motionReady: body.classList.contains('motion-ready'),
      luxuryMotion: body.classList.contains('luxury-motion'),
      motionTier: body.dataset.motionTier || '',
      premiumClass: body.classList.contains('motion-premium'),
      liteClass: body.classList.contains('motion-lite'),
      pageLeaving: body.classList.contains('page-leaving'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      navCount: document.querySelectorAll('.bottom-nav a').length,
      navHeight: navRect ? navRect.height : 0,
      fabNavGap: navRect && fabRect ? navRect.top - fabRect.bottom : null,
      contentAnimation: contentStyle ? contentStyle.animationName : '',
      rowAnimation: rowStyle ? rowStyle.animationName : '',
      statAnimation: statStyle ? statStyle.animationName : '',
      bottomNavAnimation: nav ? getComputedStyle(nav).animationName : '',
      loaderPresent: !!loader,
      loaderOpen: !!(loader && loader.classList.contains('open')),
      loaderImg: loaderImg ? loaderImg.getAttribute('src') : '',
      statCountAnimated: statNum ? statNum.dataset.countAnimated || '' : '',
      motionItems: document.querySelectorAll('.motion-item').length,
      visibleMotionItems: document.querySelectorAll('.motion-visible').length,
      rowWillChange: rowStyle ? rowStyle.willChange : '',
      contentVisibility: rowStyle ? rowStyle.contentVisibility : '',
      activeInfinite: [...document.getAnimations()]
        .filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)
        .map((a) => a.animationName || (a.effect.target && a.effect.target.className) || 'anonymous')
        .slice(0, 16),
    };
  });
}

async function sampleFrameBudget(page, label, samples = 90) {
  const metrics = await page.evaluate((count) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    function tick(now) {
      frames.push(now - last);
      last = now;
      if (frames.length >= count) {
        const sorted = frames.slice().sort((a, b) => a - b);
        const max = Math.max(...frames);
        const avg = frames.reduce((sum, v) => sum + v, 0) / frames.length;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
        resolve({
          frames: frames.length,
          avg,
          p95,
          max,
          over50: frames.filter((v) => v > 50).length,
        });
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), samples);
  if (metrics.over50 > 1 || metrics.p95 > 45 || metrics.max > 140) {
    throw new Error(`${label} animation frame budget exceeded ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function assertBossMotion(page, pagePath, label) {
  await page.goto(BASE + pagePath, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.classList.contains('motion-ready'), null, { timeout: 10000 });
  const state = await readMotionState(page);
  if (!state.motionReady) throw new Error(`${label} missing motion-ready`);
  if (!state.luxuryMotion) throw new Error(`${label} missing luxury-motion`);
  if (!state.motionTier || (!state.premiumClass && !state.liteClass)) {
    throw new Error(`${label} missing motion tier ${JSON.stringify(state)}`);
  }
  if (state.overflow > 2) throw new Error(`${label} horizontal overflow ${state.overflow}px`);
  if (state.navCount !== 5) throw new Error(`${label} expected 5 nav items, got ${state.navCount}`);
  if (!/page-enter|none/.test(state.contentAnimation)) {
    throw new Error(`${label} unexpected content animation ${JSON.stringify(state)}`);
  }
  if (state.navHeight > 74) throw new Error(`${label} bottom nav too tall ${JSON.stringify(state)}`);
  if (state.fabNavGap !== null && state.fabNavGap < 20) {
    throw new Error(`${label} FAB overlaps nav ${JSON.stringify(state)}`);
  }
  if (!state.statCountAnimated) {
    throw new Error(`${label} stats should be marked for count animation ${JSON.stringify(state)}`);
  }
  if (state.motionItems > 56) {
    throw new Error(`${label} should cap animated items ${JSON.stringify(state)}`);
  }
  if (state.visibleMotionItems < 1) {
    throw new Error(`${label} should reveal motion items ${JSON.stringify(state)}`);
  }
  if (state.activeInfinite.length > 10) {
    throw new Error(`${label} too many infinite animations ${JSON.stringify(state)}`);
  }
  return state;
}

(async () => {
  const boss = await loginAny([['admin', 'admin123'], ['bossdemo', 'boss123456']]);
  const worker = await loginAny([['worker', 'worker123'], ['workerdemo', 'worker123456']]);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    for (const viewport of [
      { width: 412, height: 915 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
    ]) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${viewport.width}: ${msg.text()}`); });
      page.on('pageerror', (err) => errors.push(`${viewport.width}: ${err.message}`));
      await seedSession(page, boss);

      await assertBossMotion(page, '/boss-dashboard.html', `${viewport.width} dashboard`);
      const dashboardFrame = await sampleFrameBudget(page, `${viewport.width} dashboard`);
      await page.locator('[data-quick-filter="ready_pickup"]').click();
      await page.waitForFunction(() => {
        const loader = document.querySelector('.page-transition-loader.open');
        return !!loader && loader.querySelector('img[src="/icons/loading.gif"]');
      }, null, { timeout: 5000 });
      const filterLoader = await page.evaluate(() => {
        const loader = document.querySelector('.page-transition-loader.open');
        const style = loader ? getComputedStyle(loader) : null;
        return {
          present: !!loader,
          img: loader?.querySelector('img')?.getAttribute('src') || '',
          backdropFilter: style ? (style.backdropFilter || style.webkitBackdropFilter || '') : '',
          bg: style ? style.backgroundImage || style.backgroundColor : '',
        };
      });
      if (!filterLoader.present || filterLoader.img !== '/icons/loading.gif' || !/blur/.test(filterLoader.backdropFilter)) {
        throw new Error(`${viewport.width} dashboard filter loader missing blur/gif ${JSON.stringify(filterLoader)}`);
      }
      await page.waitForFunction(() => !document.querySelector('.page-transition-loader'), null, { timeout: 10000 });
      const leaving = page.waitForFunction(() => document.body.classList.contains('page-leaving'), null, { timeout: 5000 });
      await page.locator('.bottom-nav a[href="pickup-batches.html"]').click();
      await leaving;
      const leavingState = await readMotionState(page);
      if (!leavingState.loaderPresent || leavingState.loaderImg !== '/icons/loading.gif') {
        throw new Error(`${viewport.width} transition loader missing gif ${JSON.stringify(leavingState)}`);
      }
      if (!leavingState.luxuryMotion) {
        throw new Error(`${viewport.width} transition should keep luxury motion ${JSON.stringify(leavingState)}`);
      }
      await page.waitForURL(/pickup-batches\.html$/, { timeout: 10000 });
      const pickup = await assertBossMotion(page, '/pickup-batches.html', `${viewport.width} pickup`);
      if (!/surface-in/.test(pickup.statAnimation)) {
        throw new Error(`${viewport.width} pickup stats should animate ${JSON.stringify(pickup)}`);
      }
      const pickupFrame = await sampleFrameBudget(page, `${viewport.width} pickup`);
      if (dashboardFrame.avg > 30 || pickupFrame.avg > 30) {
        throw new Error(`${viewport.width} average frame budget too high ${JSON.stringify({ dashboardFrame, pickupFrame })}`);
      }

      await seedSession(page, worker);
      await page.goto(BASE + '/worker-queue.html', { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.body.classList.contains('motion-ready'), null, { timeout: 10000 });
      const workerState = await readMotionState(page);
      if (!workerState.luxuryMotion) throw new Error(`${viewport.width} worker missing luxury motion`);
      if (workerState.navCount !== 0) throw new Error(`${viewport.width} worker should not have bottom nav`);
      if (workerState.overflow > 2) throw new Error(`${viewport.width} worker overflow ${JSON.stringify(workerState)}`);
      if (!/surface-in/.test(workerState.statAnimation)) {
        throw new Error(`${viewport.width} worker hero should animate ${JSON.stringify(workerState)}`);
      }
      await sampleFrameBudget(page, `${viewport.width} worker`, 60);
      await context.close();
    }

    const reduced = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    await seedSession(reducedPage, boss);
    await reducedPage.goto(BASE + '/boss-dashboard.html', { waitUntil: 'networkidle' });
    await reducedPage.waitForSelector('.bottom-nav', { timeout: 10000 });
    const reducedState = await readMotionState(reducedPage);
    if (reducedState.motionReady) throw new Error(`reduced motion should not mark motion-ready ${JSON.stringify(reducedState)}`);
    if (reducedState.luxuryMotion) throw new Error(`reduced motion should not mark luxury-motion ${JSON.stringify(reducedState)}`);
    if (reducedState.loaderPresent) throw new Error(`reduced motion should not show transition loader ${JSON.stringify(reducedState)}`);
    if (reducedState.motionTier) throw new Error(`reduced motion should not set motion tier ${JSON.stringify(reducedState)}`);
    if (reducedState.overflow > 2) throw new Error(`reduced motion overflow ${JSON.stringify(reducedState)}`);
    await reduced.close();

    if (errors.length) throw new Error(errors.join(' | '));
    console.log('MOTION BROWSER QA PASS viewports=3 reduced-motion=1');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
