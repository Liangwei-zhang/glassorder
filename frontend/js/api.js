const API_BASE = '';
const TOKEN_KEY = 'glassorder_token';
const USER_KEY = 'glassorder_user';
const MOTION_ITEM_SELECTOR = [
  '.stat-tile',
  '.pickup-stat-card',
  '.dashboard-task-card',
  '.customer-rank-card',
  '.worker-hero',
  '.worker-stage-card',
  '.empty-state',
  '.row',
  '.customer-rank-pill',
  '.worker-company',
  '.skel-row',
].join(',');

let motionTier = 'off';
let motionRevealObserver = null;
let motionSchedule = 0;
let motionBoundCount = 0;
let transitionLoaderDepth = 0;
let transitionLoaderShownAt = 0;
let transitionLoaderCloseTimer = null;
const motionRoots = new Set();
const authFileCache = new Map();
let overlayDepth = 0;
let installPromptEvent = null;
let pwaRuntimeBound = false;
let updateRefreshHandlerBound = false;
let pendingRefreshAction = null;

function appHaptic(pattern = 10) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch (_) {}
}

function isStandaloneMode() {
  return Boolean(
    (typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(display-mode: standalone)').matches)
    || (typeof navigator !== 'undefined' && navigator.standalone)
  );
}

function isIosBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/i.test(ua);
  const standalone = Boolean(navigator.standalone);
  return iOS && webkit && !standalone;
}

function isPwaInstallSuppressed() {
  if (typeof document === 'undefined') return false;
  const html = document.documentElement;
  const body = document.body;
  return Boolean(
    (html && html.dataset && html.dataset.pwaInstall === 'off')
    || (body && body.dataset && body.dataset.pwaInstall === 'off')
  );
}

function lockAppOverlay() {
  overlayDepth += 1;
  if (overlayDepth === 1 && document.body) document.body.classList.add('app-overlay-open');
}

function unlockAppOverlay() {
  overlayDepth = Math.max(0, overlayDepth - 1);
  if (overlayDepth === 0 && document.body) document.body.classList.remove('app-overlay-open');
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getMotionTier() {
  if (prefersReducedMotion()) return 'off';
  if (typeof navigator === 'undefined') return 'premium';
  const connection = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
  if (connection && connection.saveData) return 'lite';
  const cores = Number(navigator.hardwareConcurrency || 0);
  const memory = Number(navigator.deviceMemory || 0);
  if ((cores && cores <= 4) || (memory && memory <= 3)) return 'lite';
  return 'premium';
}

function motionItemLimit() {
  return motionTier === 'premium' ? 56 : 24;
}

function flashMotion(el, className, ttl = 420) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove(className);
  // Force a style flush so repeated successful actions replay the feedback.
  void el.offsetWidth;
  el.classList.add(className);
  window.setTimeout(() => {
    if (el && el.classList) el.classList.remove(className);
  }, ttl);
}

function animateNumber(el, duration = 680) {
  if (!el || prefersReducedMotion()) return;
  const raw = String(el.textContent || '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return;
  const target = Number(raw);
  if (!Number.isFinite(target)) return;
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
  const start = target > 12 ? Math.max(0, Math.floor(target * 0.72)) : 0;
  const startTime = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const value = start + (target - start) * eased;
    el.textContent = decimals ? value.toFixed(decimals) : String(Math.round(value));
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = raw;
  }
  requestAnimationFrame(tick);
}

function animateNumbers(root = document) {
  if (prefersReducedMotion()) return;
  root.querySelectorAll('.num-big, .pickup-stat-card .value, .worker-hero-num, .worker-pending-pill .count').forEach((el) => {
    if (el.dataset.countAnimated === el.textContent) return;
    el.dataset.countAnimated = el.textContent;
    animateNumber(el, motionTier === 'lite' ? 360 : 680);
  });
}

function pwaBannerRoot() {
  if (typeof document === 'undefined' || !document.body) return null;
  let root = document.getElementById('pwa-banner-stack');
  if (!root) {
    root = document.createElement('div');
    root.id = 'pwa-banner-stack';
    root.className = 'pwa-banner-stack';
    document.body.appendChild(root);
  }
  return root;
}

function closePwaBanner(id) {
  const root = document.getElementById('pwa-banner-stack');
  if (!root) return;
  const item = root.querySelector(`[data-banner-id="${id}"]`);
  if (!item) return;
  item.classList.add('leave');
  window.setTimeout(() => item.remove(), 180);
}

function renderPwaBanner({ id, tone = '', title = '', body = '', primaryText = '', secondaryText = '', onPrimary = null, onSecondary = null, sticky = false }) {
  const root = pwaBannerRoot();
  if (!root) return;
  const existing = root.querySelector(`[data-banner-id="${id}"]`);
  if (existing) existing.remove();
  const item = document.createElement('section');
  item.className = `pwa-banner ${tone}`.trim();
  item.dataset.bannerId = id;
  if (sticky) item.dataset.sticky = '1';
  item.innerHTML = `
    <div class="pwa-banner-copy">
      <strong>${esc(title)}</strong>
      ${body ? `<span>${esc(body)}</span>` : ''}
    </div>
    <div class="pwa-banner-actions">
      ${secondaryText ? `<button type="button" class="btn btn-ghost pwa-banner-btn" data-role="secondary">${esc(secondaryText)}</button>` : ''}
      ${primaryText ? `<button type="button" class="btn btn-primary pwa-banner-btn" data-role="primary">${esc(primaryText)}</button>` : ''}
    </div>`;
  root.appendChild(item);
  item.addEventListener('click', (event) => {
    const role = event.target && event.target.dataset ? event.target.dataset.role : '';
    if (role === 'primary' && typeof onPrimary === 'function') onPrimary();
    if (role === 'secondary' && typeof onSecondary === 'function') onSecondary();
  });
  scheduleMotion(item);
}

function setPwaModeClasses() {
  if (typeof document === 'undefined' || !document.body) return;
  const standalone = isStandaloneMode();
  document.body.classList.toggle('pwa-installed', standalone);
  document.body.classList.toggle('pwa-browser', !standalone);
  document.body.dataset.appMode = standalone ? 'installed' : 'browser';
}

async function launchInstallPrompt() {
  if (isPwaInstallSuppressed()) {
    closePwaBanner('install');
    closePwaBanner('ios-install');
    return;
  }
  if (installPromptEvent && typeof installPromptEvent.prompt === 'function') {
    installPromptEvent.prompt();
    try { await installPromptEvent.userChoice; } catch (_) {}
    return;
  }
  if (isIosBrowser()) {
    renderPwaBanner({
      id: 'ios-install',
      tone: 'info',
      title: t('installIosTitle'),
      body: t('installIosBody'),
      primaryText: t('confirm'),
      secondaryText: t('installDismiss'),
      onPrimary: () => closePwaBanner('ios-install'),
      onSecondary: () => closePwaBanner('ios-install'),
      sticky: true,
    });
  }
}

function refreshAppShellLabels() {
  setPwaModeClasses();
  const installed = isStandaloneMode();
  const suppressInstall = isPwaInstallSuppressed();
  document.querySelectorAll('[data-app-line-browser]').forEach((el) => {
    el.textContent = t(installed ? el.dataset.appLineInstalled : el.dataset.appLineBrowser);
  });
  document.querySelectorAll('[data-install-hide-installed]').forEach((el) => {
    el.hidden = installed || suppressInstall;
  });
  document.querySelectorAll('[data-install-only-browser]').forEach((el) => {
    el.hidden = installed || suppressInstall;
  });
}

function showInstallBanner() {
  if (isStandaloneMode() || isPwaInstallSuppressed()) {
    closePwaBanner('install');
    closePwaBanner('ios-install');
    return;
  }
  if (installPromptEvent) {
    renderPwaBanner({
      id: 'install',
      tone: 'info',
      title: t('installAvailable'),
      body: t('appBrowserLine'),
      primaryText: t('installApp'),
      secondaryText: t('installDismiss'),
      onPrimary: () => { closePwaBanner('install'); launchInstallPrompt(); },
      onSecondary: () => closePwaBanner('install'),
    });
    return;
  }
  if (isIosBrowser()) {
    renderPwaBanner({
      id: 'ios-install',
      tone: 'info',
      title: t('installIosTitle'),
      body: t('installIosBody'),
      primaryText: t('confirm'),
      secondaryText: t('installDismiss'),
      onPrimary: () => closePwaBanner('ios-install'),
      onSecondary: () => closePwaBanner('ios-install'),
    });
  }
}

function showOfflineBanner() {
  renderPwaBanner({
    id: 'offline',
    tone: 'warn',
    title: t('networkError'),
    body: t('offlineBanner'),
    sticky: true,
  });
}

function hideOfflineBanner() {
  closePwaBanner('offline');
}

function showUpdateBanner() {
  if (isPwaInstallSuppressed()) {
    closePwaBanner('update-ready');
    return;
  }
  if (pendingRefreshAction) return;
  pendingRefreshAction = () => {
    sessionStorage.removeItem('__sw_reloaded__');
    location.reload();
  };
  renderPwaBanner({
    id: 'update-ready',
    tone: 'success',
    title: t('updateReady'),
    body: t('updateReadyBody'),
    primaryText: t('updateNow'),
    secondaryText: t('installDismiss'),
    onPrimary: () => pendingRefreshAction && pendingRefreshAction(),
    onSecondary: () => closePwaBanner('update-ready'),
    sticky: true,
  });
}

function initPwaRuntime() {
  if (pwaRuntimeBound || typeof window === 'undefined') return;
  pwaRuntimeBound = true;
  setPwaModeClasses();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    if (isPwaInstallSuppressed()) {
      installPromptEvent = null;
      closePwaBanner('install');
      closePwaBanner('ios-install');
      return;
    }
    installPromptEvent = event;
    refreshAppShellLabels();
    showInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    closePwaBanner('install');
    closePwaBanner('ios-install');
    refreshAppShellLabels();
    toast(t('appInstalledLine'), { type: 'success', ttl: 2200 });
  });
  window.addEventListener('online', () => {
    hideOfflineBanner();
    toast(t('onlineBack'), { type: 'success', ttl: 1800 });
  });
  window.addEventListener('offline', () => {
    showOfflineBanner();
  });
  if (!navigator.onLine) showOfflineBanner();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      refreshAppShellLabels();
      showInstallBanner();
    }, { once: true });
  } else {
    refreshAppShellLabels();
    showInstallBanner();
  }
}

function revealMotionElement(el) {
  if (!el || !el.classList) return;
  function markVisible(target) {
    if (target.dataset.motionDoneHook !== '1') {
      target.dataset.motionDoneHook = '1';
      target.addEventListener('animationend', () => target.classList.add('motion-done'), { once: true });
    }
    target.classList.add('motion-visible');
  }
  if (motionRevealObserver) {
    motionRevealObserver.observe(el);
  } else {
    markVisible(el);
  }
}

function primeMotionElements(root = document) {
  if (motionTier === 'off') return;
  const doc = root && root.ownerDocument ? root.ownerDocument : document;
  const limit = motionItemLimit();
  const candidates = [];
  if (root && root.nodeType === 1 && root.matches && root.matches(MOTION_ITEM_SELECTOR)) {
    candidates.push(root);
  }
  if (root && root.querySelectorAll) {
    root.querySelectorAll(MOTION_ITEM_SELECTOR).forEach((el) => candidates.push(el));
  }
  candidates.forEach((el) => {
    if (!el || el.dataset.motionBound === '1' || motionBoundCount >= limit) return;
    if (el.closest && el.closest('.modal-backdrop, .customer-picker-results')) return;
    el.dataset.motionBound = '1';
    el.style.setProperty('--motion-delay', `${motionTier === 'lite' ? 0 : Math.min(motionBoundCount, 10) * 22}ms`);
    el.classList.add('motion-item');
    motionBoundCount += 1;
    revealMotionElement(el);
  });
}

function scheduleMotion(root = document) {
  if (motionTier === 'off') return;
  motionRoots.add(root || document);
  if (motionSchedule) return;
  motionSchedule = requestAnimationFrame(() => {
    motionSchedule = 0;
    const roots = Array.from(motionRoots);
    motionRoots.clear();
    roots.forEach((root) => {
      primeMotionElements(root);
      animateNumbers(root && root.querySelectorAll ? root : document);
    });
  });
}

function preloadTransitionGif() {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.src = '/icons/loading.gif';
}

function ensureTransitionLoader() {
  let overlay = document.querySelector('.page-transition-loader');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'page-transition-loader';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = '<div class="page-transition-loader-box"><img src="/icons/loading.gif" alt=""></div>';
  document.body.appendChild(overlay);
  return overlay;
}

function showTransitionLoader() {
  if (typeof document === 'undefined' || !document.body) return () => {};
  const overlay = ensureTransitionLoader();
  let closed = false;
  transitionLoaderDepth += 1;
  transitionLoaderShownAt = transitionLoaderShownAt || performance.now();
  if (transitionLoaderCloseTimer) {
    clearTimeout(transitionLoaderCloseTimer);
    transitionLoaderCloseTimer = null;
  }
  requestAnimationFrame(() => overlay.classList.add('open'));
  return (options) => {
    if (closed) return;
    closed = true;
    hideTransitionLoader(options);
  };
}

function hideTransitionLoader({ minMs = 180 } = {}) {
  const overlay = document.querySelector('.page-transition-loader');
  if (!overlay) return;
  transitionLoaderDepth = Math.max(0, transitionLoaderDepth - 1);
  if (transitionLoaderDepth > 0) return;
  const elapsed = performance.now() - transitionLoaderShownAt;
  const delay = Math.max(0, minMs - elapsed);
  transitionLoaderCloseTimer = window.setTimeout(() => {
    overlay.classList.remove('open');
    transitionLoaderShownAt = 0;
    if (transitionLoaderCloseTimer) {
      clearTimeout(transitionLoaderCloseTimer);
      transitionLoaderCloseTimer = null;
    }
    transitionLoaderCloseTimer = window.setTimeout(() => {
      if (!overlay.classList.contains('open')) overlay.remove();
      transitionLoaderCloseTimer = null;
    }, 190);
  }, delay);
}

async function withGlobalLoader(fn, options = {}) {
  const close = showTransitionLoader();
  try {
    return await fn();
  } finally {
    close({ minMs: options.minMs || 260 });
  }
}

function resetTransitionState() {
  transitionLoaderDepth = 0;
  transitionLoaderShownAt = 0;
  if (transitionLoaderCloseTimer) {
    clearTimeout(transitionLoaderCloseTimer);
    transitionLoaderCloseTimer = null;
  }
  if (document.body) document.body.classList.remove('page-leaving');
  document.querySelectorAll('.page-transition-loader').forEach((overlay) => overlay.remove());
}

function initPageMotion() {
  if (typeof document === 'undefined' || prefersReducedMotion()) return;
  motionTier = getMotionTier();
  if (motionTier === 'off') return;
  if (typeof IntersectionObserver !== 'undefined') {
    motionRevealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting && entry.intersectionRatio <= 0) return;
        const target = entry.target;
        if (target.dataset.motionDoneHook !== '1') {
          target.dataset.motionDoneHook = '1';
          target.addEventListener('animationend', () => target.classList.add('motion-done'), { once: true });
        }
        target.classList.add('motion-visible');
        motionRevealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '120px 0px', threshold: 0.01 });
  }
  function markReady() {
    if (!document.body) return;
    document.body.classList.add('motion-ready', 'luxury-motion', `motion-${motionTier}`);
    document.body.dataset.motionTier = motionTier;
    preloadTransitionGif();
    scheduleMotion(document);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markReady, { once: true });
  } else {
    requestAnimationFrame(markReady);
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.target || anchor.hasAttribute('download') || anchor.closest('[data-no-transition]')) return;
    let url;
    try { url = new URL(anchor.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    if (url.href === location.href || url.hash && url.pathname === location.pathname && url.search === location.search) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
    const file = url.pathname.split('/').pop() || '';
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')).toLowerCase() : '';
    if (ext && ext !== '.html') return;

    event.preventDefault();
    if (document.body.classList.contains('page-leaving')) return;
    document.body.classList.add('page-leaving');
    showTransitionLoader();
    window.setTimeout(() => { location.href = url.href; }, 240);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest('.btn, .row, .bottom-nav a, .fab, .customer-rank-pill, .customer-picker-option, .stage-tab, .stage-btn, .menu-trigger, .add-trigger')
      : null;
    if (!target || target.disabled || target.dataset.ripple === 'off') return;
    if (motionTier === 'lite' && target.matches('.row, .customer-picker-option')) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    target.querySelectorAll(':scope > .touch-ripple').forEach((r) => r.remove());
    const ripple = document.createElement('span');
    ripple.className = 'touch-ripple';
    const size = Math.max(rect.width, rect.height) * 1.45;
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 620);
  }, { passive: true });

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) scheduleMotion(node);
      });
    }
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', resetTransitionState);
  window.addEventListener('pagehide', resetTransitionState);
  window.addEventListener('popstate', resetTransitionState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetTransitionState();
  });
}

initPageMotion();
initPwaRuntime();
initNativeContextMenuGuard();

// PWA: register service worker + inject manifest/iOS meta tags once per page load.
(function injectPwaTags() {
  if (typeof document === 'undefined') return;
  if (isPwaInstallSuppressed()) return;
  const head = document.head;
  if (!head) return;
  if (!head.querySelector('link[rel="manifest"]')) {
    const m = document.createElement('link');
    m.rel = 'manifest';
    m.href = '/manifest.json';
    head.appendChild(m);
  }
  if (!head.querySelector('link[rel="icon"]')) {
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/png';
    icon.sizes = '32x32';
    icon.href = '/icons/favicon-32.png';
    head.appendChild(icon);
  }
  if (!head.querySelector('meta[name="theme-color"]')) {
    const tc = document.createElement('meta');
    tc.name = 'theme-color';
    tc.content = '#18181b';
    head.appendChild(tc);
  }
  if (!head.querySelector('link[rel="apple-touch-icon"]')) {
    const a = document.createElement('link');
    a.rel = 'apple-touch-icon';
    a.href = '/icons/apple-touch-icon.png';
    head.appendChild(a);
  }
  if (!head.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const am = document.createElement('meta');
    am.name = 'apple-mobile-web-app-capable';
    am.content = 'yes';
    head.appendChild(am);
  }
  if (!head.querySelector('meta[name="mobile-web-app-capable"]')) {
    const mw = document.createElement('meta');
    mw.name = 'mobile-web-app-capable';
    mw.content = 'yes';
    head.appendChild(mw);
  }
  if (!head.querySelector('meta[name="apple-mobile-web-app-title"]')) {
    const at = document.createElement('meta');
    at.name = 'apple-mobile-web-app-title';
    at.content = 'Glass';
    head.appendChild(at);
  }
})();
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !isPwaInstallSuppressed()) {
  // One-shot cache nuke for this release — guarantees stale 'stale-while-revalidate'
  // caches from earlier SW versions cannot serve outdated HTML.
  const NUKE_KEY = '__sw_nuke_2026_06_08_pickup_hold_release__';
  if (!localStorage.getItem(NUKE_KEY)) {
    localStorage.setItem(NUKE_KEY, '1');
    if (window.caches && caches.keys) {
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
    }
    if (navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister().catch(() => {}));
      }).catch(() => {});
    }
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Force update check on every page load — sw.js itself is no-cache,
      // so a server-side change ships within one navigation.
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });
    }).catch(() => {});
    setTimeout(() => sessionStorage.removeItem('__sw_reloaded__'), 5000);
  });
}
const STAGES = ['cut', 'edge', 'tempered', 'polish', 'finished'];
// Backwards-compat: STAGE_ZH proxy resolves through i18n at access time.
const STAGE_ZH = new Proxy({}, {
  get(_, key) {
    return typeof stageLabel === 'function' ? stageLabel(key) : key;
  },
});

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function setSession(token, user) {
  authFileCache.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) {}
  });
  authFileCache.clear();
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function logout() {
  authFileCache.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) {}
  });
  authFileCache.clear();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  location.href = 'login.html';
}

function ensureAuth() {
  if (!getToken()) {
    location.href = 'login.html';
    return false;
  }
  return true;
}

// Redirect non-matching roles away from a page. Returns true if user passes.
// Worker visiting a boss-only page is sent to their workstation.
function requireRolePage(...allowed) {
  if (!ensureAuth()) return false;
  const user = getUser();
  if (!user || !allowed.includes(user.role)) {
    if (user && user.role === 'worker') {
      location.replace('worker-queue.html');
    } else {
      location.replace('index.html');
    }
    return false;
  }
  return true;
}

function bossNav(active) {
  const items = [
    ['orders', 'boss-dashboard.html', '订单', 'navOrders'],
    ['shop', 'worker-queue.html', '车间', 'navShop'],
    ['pickup', 'pickup-batches.html', '取货', 'navPickup'],
    ['customers', 'customers.html', '客户', 'navCustomers'],
    ['summary', 'summary.html', '汇总', 'navSummary'],
  ];
  return `<nav class="bottom-nav" aria-label="boss navigation">${items.map(([key, href, fallback, labelKey]) => `
    <a href="${href}" class="${key === active ? 'active' : ''}">
      <span class="nav-icon">${key === 'orders' ? '□' : key === 'shop' ? '◇' : key === 'pickup' ? '✓' : key === 'customers' ? '○' : '∑'}</span>
      <span>${esc(typeof t === 'function' ? t(labelKey) : fallback)}</span>
    </a>`).join('')}</nav>`;
}

function injectBossNav(active) {
  document.body.classList.add('has-bottom-nav');
  if (document.querySelector('.bottom-nav')) return;
  document.body.insertAdjacentHTML('beforeend', bossNav(active));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token && options.auth !== false) headers.set('Authorization', `Bearer ${token}`);

  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(API_BASE + path, { ...options, headers, body });
  } catch (err) {
    const message = typeof t === 'function' ? t('networkError') : 'Network error';
    const error = new Error(message);
    error.cause = err;
    throw error;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  if (res.status === 401 && options.auth !== false && !path.startsWith('/api/auth/')) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (!location.pathname.endsWith('/login.html') && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
    }
  }
  if (!res.ok) {
    const fallback = (typeof t === 'function' ? t('requestFailed') : 'Request failed');
    const message = data && data.error ? data.error : `${fallback} (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function authFileUrl(path) {
  if (!path) return '';
  if (!String(path).startsWith('/uploads/')) return path;
  if (authFileCache.has(path)) return authFileCache.get(path);

  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(API_BASE + path, { headers, cache: 'no-store' });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (!location.pathname.endsWith('/login.html') && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
    }
  }
  if (!res.ok) {
    const fallback = typeof t === 'function' ? t('requestFailed') : 'Request failed';
    throw new Error(`${fallback} (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  authFileCache.set(path, url);
  return url;
}

async function openAuthFile(path) {
  const tab = window.open('', '_blank', 'noopener');
  try {
    const url = await authFileUrl(path);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank', 'noopener');
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

async function login(loginName, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { login: loginName, password },
  });
  setSession(data.token, data.user);
  return data.user;
}

function pieceClass(p) {
  if (p.broken) return 'piece broken';
  if (p.rework) return 'piece rework';
  if (p.hold) return 'piece hold';
  if (p.stage === 'finished') return 'piece done';
  return 'piece pending';
}

function orderProgress(o) {
  const total = Number(o.total_pieces || (o.pieces ? o.pieces.length : 0));
  if (!total) return 0;
  const finished = Number(o.finished_pieces || (o.pieces ? o.pieces.filter(p => p.stage === 'finished').length : 0));
  return Math.round((finished / total) * 100);
}

function reworkCount(o) {
  if (o.rework_pieces !== undefined) return Number(o.rework_pieces || 0);
  return (o.pieces || []).filter(p => p.rework).length;
}

function brokenCount(o) {
  if (o.broken_pieces !== undefined) return Number(o.broken_pieces || 0);
  return (o.pieces || []).filter(p => p.broken).length;
}

function orderCodeText(value) {
  const raw = typeof value === 'object' && value ? value.order_number : value;
  const code = String(raw || '').trim();
  if (!code) return 'PO -';
  return /^PO\b/i.test(code) ? code : `PO ${code}`;
}

function orderTitle(o) {
  return `${esc(orderCodeText(o))} · ${esc(o.company)}`;
}

function isOverdue(o) {
  if (o.archived_at || !o.deadline || o.status === 'ready_pickup' || o.status === 'picked_up') return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(o.deadline + 'T00:00:00');
  return deadline < today;
}

function statusBadge(o) {
  if (o.archived_at) return `<span class="badge badge-done">${esc(t('statusArchived'))}</span>`;
  if (o.pickup_status === 'partial') return `<span class="badge badge-pickup">${esc(t('statusPartialPickup'))}</span>`;
  if (o.status === 'ready_pickup') return `<span class="badge badge-pickup">${esc(t('statusReadyPickup'))}</span>`;
  if (o.status === 'picked_up') return `<span class="badge badge-done">${esc(t('statusPickedUp'))}</span>`;
  return `<span class="badge badge-prod">${esc(t('statusInProduction'))}</span>`;
}

function toast(msg, opts) {
  if (msg === undefined || msg === null) return;
  const variant = opts && opts.type ? String(opts.type) : '';
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (variant ? ' ' + variant : '');
  el.textContent = String(msg);
  stack.appendChild(el);
  // cap stack at 4 entries — drop the oldest
  while (stack.children.length > 4) {
    const old = stack.firstElementChild;
    if (!old) break;
    old.remove();
  }
  const TTL = (opts && opts.ttl) || 2600;
  if (variant === 'success') appHaptic([12, 20, 12]);
  else if (variant === 'danger') appHaptic([18, 30, 18]);
  setTimeout(() => {
    el.classList.add('toast-leave');
    setTimeout(() => el.remove(), 220);
  }, TTL);
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(v) {
  return esc(v);
}

function normText(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '');
}

function customerSearchText(c) {
  return normText([
    c && c.company,
    c && c.contact_name,
    c && c.phone,
    c && c.email,
    c && c.email_cc,
    c && c.notes,
  ].filter(Boolean).join(' '));
}

function customerLabel(c) {
  if (!c) return '';
  return [c.company, c.contact_name, c.phone].filter(Boolean).join(' · ');
}

function initCustomerPicker({ root, customers, onSelect, placeholder, emptyText } = {}) {
  const el = typeof root === 'string' ? document.querySelector(root) : root;
  if (!el) throw new Error('customer picker root missing');
  let list = Array.isArray(customers) ? customers.slice() : [];
  let selectedId = '';
  let activeIndex = 0;
  let open = false;
  const ph = placeholder || t('customerSearchPlaceholder');
  const empty = emptyText || t('customerSearchEmpty');

  el.className = (el.className ? el.className + ' ' : '') + 'customer-picker';
  el.innerHTML = `
    <input class="form-input" type="search" autocomplete="off" id="${escAttr(el.id || 'customerPicker')}-input" placeholder="${escAttr(ph)}">
    <span class="customer-picker-count"></span>
    <input type="hidden" class="customer-picker-value">
    <div class="customer-picker-results" hidden></div>`;

  const input = el.querySelector('input[type="search"]');
  const count = el.querySelector('.customer-picker-count');
  const value = el.querySelector('.customer-picker-value');
  const results = el.querySelector('.customer-picker-results');

  function filtered() {
    const q = normText(input.value);
    if (!q) return list.slice(0, 40);
    return list
      .map((c, index) => {
        const fields = [c.company, c.contact_name, c.phone, c.email, c.email_cc].map(normText);
        const haystack = customerSearchText(c);
        if (!haystack.includes(q)) return null;
        let score = 40;
        if (fields.some((f) => f === q)) score = 0;
        else if (fields.some((f) => f.startsWith(q))) score = 1;
        else {
          const best = fields.reduce((min, f) => {
            const pos = f.indexOf(q);
            return pos >= 0 ? Math.min(min, pos) : min;
          }, 999);
          score = Math.min(30, best);
        }
        return { c, score, index };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, 40)
      .map((row) => row.c);
  }

  function render() {
    const rows = filtered();
    count.textContent = list.length ? tn('customerSearchCount', { n: list.length }) : '';
    activeIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
    if (!open) {
      results.hidden = true;
      return;
    }
    results.hidden = false;
    if (!rows.length) {
      results.innerHTML = `<div class="customer-picker-empty">${esc(empty)}</div>`;
      return;
    }
    results.innerHTML = rows.map((c, i) => `
      <button type="button" class="customer-picker-option ${i === activeIndex ? 'active' : ''}" data-id="${c.id}">
        <div class="customer-picker-name">${esc(c.company || '')}</div>
        <div class="customer-picker-meta">${esc([c.contact_name, c.phone, c.email, c.email_cc].filter(Boolean).join(' · ') || t('noPhone'))}</div>
      </button>`).join('');
  }

  function choose(id) {
    const c = list.find((item) => String(item.id) === String(id));
    if (!c) return;
    selectedId = String(c.id);
    value.value = selectedId;
    input.value = customerLabel(c);
    open = false;
    render();
    if (typeof onSelect === 'function') onSelect(c);
  }

  input.addEventListener('input', () => {
    selectedId = '';
    value.value = '';
    activeIndex = 0;
    open = true;
    render();
  });
  input.addEventListener('focus', () => {
    open = true;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const rows = filtered();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      activeIndex = Math.min(rows.length - 1, activeIndex + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      render();
    } else if (e.key === 'Enter') {
      if (open && rows[activeIndex]) {
        e.preventDefault();
        choose(rows[activeIndex].id);
      }
    } else if (e.key === 'Escape') {
      open = false;
      render();
    }
  });
  results.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.customer-picker-option');
    if (!opt) return;
    e.preventDefault();
    choose(opt.dataset.id);
  });
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target)) {
      open = false;
      render();
    }
  });

  render();

  return {
    setCustomers(nextCustomers) {
      list = Array.isArray(nextCustomers) ? nextCustomers.slice() : [];
      selectedId = '';
      value.value = '';
      input.value = '';
      activeIndex = 0;
      render();
    },
    select(id) { choose(id); },
    getValue() { return selectedId || value.value || ''; },
    getSelected() { return list.find((c) => String(c.id) === String(this.getValue())) || null; },
    focus() { input.focus(); },
  };
}

function emptyState(text, icon) {
  // Default uses an inline SVG mark — avoids hex/emoji noise and matches the design system.
  const safeIcon = icon
    ? `<div style="font-size:40px; margin-bottom:10px;">${esc(icon)}</div>`
    : `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-3); margin-bottom:10px;" aria-hidden="true">
         <circle cx="12" cy="12" r="9"></circle>
         <line x1="8" y1="12" x2="16" y2="12"></line>
       </svg>`;
  return `<div class="empty-state">${safeIcon}<div>${esc(text)}</div></div>`;
}

let _popMenuClose = null;
function isPopMenuOpen() {
  return Boolean(_popMenuClose || document.querySelector('.menu-pop'));
}

function popMenu(anchorEl, items, options = {}) {
  closePopMenu();
  if (!anchorEl) return;
  const openedAt = Date.now();
  const ignoreOutsideClickMs = Number(options.ignoreOutsideClickMs || 0);
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu-pop';
  const closeLabel = typeof t === 'function' ? t('closeMenu') : 'Close menu';
  const itemHtml = items.map((item, i) => {
    if (item.divider) return '<div class="menu-divider"></div>';
    const cls = item.danger ? 'danger' : '';
    const dis = item.disabled ? 'disabled' : '';
    return `<button type="button" data-idx="${i}" class="${cls}" ${dis}>${esc(item.label)}</button>`;
  }).join('');
  menu.innerHTML = `
    <div class="menu-pop-head">
      <button type="button" class="menu-pop-close" data-close-pop-menu aria-label="${escAttr(closeLabel)}">X</button>
    </div>
    ${itemHtml}`;
  // Position off-screen first to measure size, then snap to a viewport-safe spot.
  menu.style.visibility = 'hidden';
  menu.style.top = '0px';
  menu.style.left = '0px';
  document.body.appendChild(menu);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const margin = 8;
  const mobileSheet = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 640px)').matches;
  if (mobileSheet) {
    menu.classList.add('sheet');
    menu.style.maxHeight = `calc(100vh - ${margin * 2}px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`;
    menu.style.overflowY = 'auto';
    menu.style.top = 'auto';
    menu.style.left = `${margin}px`;
    menu.style.right = `${margin}px`;
    menu.style.bottom = `calc(${margin}px + env(safe-area-inset-bottom, 0px))`;
    menu.style.width = 'auto';
  } else {
    // Cap to viewport height (allow scrolling inside if too tall).
    if (mh > vh - margin * 2) {
      menu.style.maxHeight = (vh - margin * 2) + 'px';
      menu.style.overflowY = 'auto';
    }
    // Vertical: prefer below anchor; flip up if below would overflow.
    let top = rect.bottom + 6;
    if (top + mh > vh - margin) {
      top = Math.max(margin, rect.top - mh - 6);
    }
    // Horizontal: prefer right-aligned to anchor; clamp into viewport.
    let left = rect.right - mw;
    if (left < margin) left = margin;
    if (left + mw > vw - margin) left = vw - margin - mw;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }
  menu.style.visibility = 'visible';
  lockAppOverlay();
  appHaptic(12);

  function close() {
    if (menu.parentNode) menu.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    unlockAppOverlay();
    _popMenuClose = null;
  }
  function onDocClick(e) {
    if (menu.contains(e.target)) return;
    if (ignoreOutsideClickMs && Date.now() - openedAt < ignoreOutsideClickMs) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  menu.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-pop-menu]')) {
      close();
      return;
    }
    const btn = e.target.closest('button[data-idx]');
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.idx)];
    close();
    if (item && typeof item.onClick === 'function') item.onClick();
  });
  _popMenuClose = close;
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  }, 0);
}

function closePopMenu() {
  if (_popMenuClose) _popMenuClose();
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  overlayDepth = 0;
  if (document.body) document.body.classList.remove('app-overlay-open');
}

function confirmModal({ title, body, confirmText, cancelText, danger = false } = {}) {
  const ok = confirmText || t('confirm');
  const no = cancelText || t('cancel');
  const ttl = title || t('confirmTitle');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal">
        <div style="text-align:center; margin-bottom: 12px;">
          <div style="font-size: 20px; font-weight: 700; letter-spacing:-0.01em;">${esc(ttl)}</div>
          ${body ? `<div style="color:var(--text-2); margin-top: 8px; font-size: 14px;">${esc(body)}</div>` : ''}
        </div>
        <div style="display:flex; gap: 10px; margin-top: 14px;">
          <button class="btn btn-ghost" style="flex:1;" data-role="cancel" type="button">${esc(no)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" style="flex:1;" data-role="ok" type="button">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    lockAppOverlay();
    appHaptic(12);
    requestAnimationFrame(() => overlay.classList.add('open'));
    const okBtn = overlay.querySelector('[data-role="ok"]');
    setTimeout(() => { try { okBtn.focus(); } catch (e) {} }, 30);

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      overlay.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      unlockAppOverlay();
      setTimeout(() => overlay.remove(), 220);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); close(true); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
      const role = e.target && e.target.dataset && e.target.dataset.role;
      if (role === 'cancel') close(false);
      if (role === 'ok') close(true);
    });
  });
}

function promptModal({ title, body, placeholder, confirmText, cancelText, required = true, maxLength = 300, danger = false } = {}) {
  const ok = confirmText || t('confirm');
  const no = cancelText || t('cancel');
  const ttl = title || t('confirmTitle');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal">
        <div style="margin-bottom: 12px;">
          <div style="font-size: 20px; font-weight: 700; letter-spacing:-0.01em;">${esc(ttl)}</div>
          ${body ? `<div style="color:var(--text-2); margin-top: 8px; font-size: 14px;">${esc(body)}</div>` : ''}
        </div>
        <textarea class="form-textarea" data-role="input" rows="4" maxlength="${Number(maxLength) || 300}" placeholder="${escAttr(placeholder || '')}"></textarea>
        <div class="row-sub" data-role="hint" style="margin-top:8px;"></div>
        <div style="display:flex; gap: 10px; margin-top: 14px;">
          <button class="btn btn-ghost" style="flex:1;" data-role="cancel" type="button">${esc(no)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" style="flex:1;" data-role="ok" type="button">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    lockAppOverlay();
    appHaptic(12);
    requestAnimationFrame(() => overlay.classList.add('open'));
    const input = overlay.querySelector('[data-role="input"]');
    const hint = overlay.querySelector('[data-role="hint"]');
    setTimeout(() => { try { input.focus(); } catch (e) {} }, 60);

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      overlay.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      unlockAppOverlay();
      setTimeout(() => overlay.remove(), 220);
      resolve(result);
    }
    function submit() {
      const value = String(input.value || '').trim();
      if (required && !value) {
        hint.textContent = placeholder || ttl;
        input.focus();
        return;
      }
      close(value || null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.stopPropagation(); submit(); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
      const role = e.target && e.target.dataset && e.target.dataset.role;
      if (role === 'cancel') close(null);
      if (role === 'ok') submit();
    });
  });
}

// Shows a button as busy: disabled + spinner via CSS aria-busy.
// Wraps an async function; restores label on completion.
function withBusy(btn, fn, restoreLabel) {
  if (!btn) return fn();
  if (btn.dataset.busy === '1') return Promise.resolve();
  const original = restoreLabel || btn.textContent;
  let succeeded = false;
  btn.dataset.busy = '1';
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  return Promise.resolve()
    .then(() => fn())
    .then((result) => {
      succeeded = true;
      return result;
    })
    .finally(() => {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.dataset.busy = '';
      btn.textContent = original;
      if (succeeded) flashMotion(btn, 'btn-done');
    });
}

let _errorStateSeq = 0;
function errorState(message, actionLabel, action) {
  const retryId = 'retry-action-' + (++_errorStateSeq);
  const retry = actionLabel && action
    ? `<button class="btn btn-primary cta" type="button" id="${retryId}" style="margin-top:14px;">${esc(actionLabel)}</button>`
    : '';
  setTimeout(() => {
    const btn = document.getElementById(retryId);
    if (btn && action) btn.onclick = action;
  }, 0);
  return `<div class="empty-state">
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--danger); margin-bottom:10px;" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
    <div>${esc(message || (typeof t === 'function' ? t('requestFailed') : 'Request failed'))}</div>
    ${retry}
  </div>`;
}

// Skeleton row HTML for list placeholders while data loads.
function skeletonRows(n) {
  let html = '<div class="card" style="padding:0; overflow:hidden;">';
  for (let i = 0; i < n; i += 1) {
    html += `<div class="skel-row">
      <div class="skel" style="height:14px; width:${50 + (i % 3) * 12}%;"></div>
      <div class="skel" style="height:11px; width:${30 + (i % 3) * 8}%; margin-top:8px;"></div>
    </div>`;
  }
  return html + '</div>';
}

function renderSectionHeader(title, meta = '') {
  return `<div class="section-head">
    <strong>${esc(title || '')}</strong>
    ${meta ? `<span>${esc(meta)}</span>` : ''}
  </div>`;
}

function renderStatCells(items = [], options = {}) {
  const className = options.className || 'metrics-grid';
  return `<div class="${escAttr(className)}">${items.map((item) => `
    <div class="metric-cell ${item.tone ? escAttr(item.tone) : ''}">
      <b>${esc(String(item.value ?? 0))}</b>
      <span>${esc(item.label || '')}</span>
    </div>`).join('')}</div>`;
}

function renderPanel({ title = '', meta = '', body = '', className = '' } = {}) {
  return `<section class="section-panel ${escAttr(className)}">
    ${title ? renderSectionHeader(title, meta) : ''}
    ${body || ''}
  </section>`;
}

function renderPickupSteps(steps = [], note = '') {
  return `${steps.map((step) => `
    <div class="pickup-step ${step.done ? 'done' : ''} ${step.active ? 'active' : ''}">
      <span>${esc(String(step.number))}</span><em>${esc(step.label || '')}</em>
    </div>`).join('')}
    ${note ? `<div class="pickup-selected-note">${esc(note)}</div>` : ''}`;
}

function initNativeContextMenuGuard() {
  if (typeof document === 'undefined') return;
  const appListSelector = [
    '.row',
    '.piece',
    '.worker-company',
    '.worker-order-row',
    '.pickup-order-panel',
    '.customer-list-panel',
    '.summary-panel',
    '.pickup-stat-card',
    '.customer-rank-card',
    '.customer-rank-pill',
    '.dashboard-task-card',
    '.stat-tile',
    '.bottom-nav a',
    '.fab',
  ].join(',');
  const editableSelector = 'input, textarea, select, [contenteditable="true"], canvas, .sig-pad';
  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(editableSelector)) return;
    if (target.closest(appListSelector)) {
      event.preventDefault();
    }
  }, true);
}

function debounce(fn, wait = 160) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    initCustomerPicker,
    customerSearchText,
    normText,
    debounce,
    scheduleMotion,
    showTransitionLoader,
    hideTransitionLoader,
    withGlobalLoader,
    resetTransitionState,
    promptModal,
    renderSectionHeader,
    renderStatCells,
    renderPanel,
    renderPickupSteps,
  });
}
