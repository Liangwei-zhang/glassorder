/* Glass Factory — i18n runtime. Requires window.__I18N_ZH__ and __I18N_EN__ already set. */
const LANG_KEY = 'glassorder_lang';
const I18N = { zh: window.__I18N_ZH__ || {}, en: window.__I18N_EN__ || {} };

function currentLang() {
  return localStorage.getItem(LANG_KEY) || 'zh';
}

function t(key) {
  const lang = currentLang();
  return (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
}

function tn(key, vars) {
  let s = t(key);
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
  }
  return s;
}

function stageLabel(stage) {
  const map = {
    cut: t('stageCut'),
    edge: t('stageEdge'),
    tempered: t('stageTempered'),
    polish: t('stagePolish'),
    finished: t('stageFinished'),
  };
  return map[stage] || stage;
}

function eventLabel(action) {
  const key = 'evt_' + action;
  const v = t(key);
  return v === key ? action : v;
}

function relativeTime(s) {
  if (!s) return '';
  const ts = Date.parse(s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return s;
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('justNow');
  if (min < 60) return tn('minAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tn('hourAgo', { n: hr });
  const d = Math.floor(hr / 24);
  if (d < 30) return tn('dayAgo', { n: d });
  return new Date(ts).toLocaleDateString();
}

function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang === 'en' ? 'en' : 'zh');
  applyI18n();
  if (typeof onLangChange === 'function') onLangChange();
}

function toggleLang() {
  setLang(currentLang() === 'zh' ? 'en' : 'zh');
}

function langButtonHTML() {
  return `<button class="lang-btn" onclick="toggleLang()" type="button">${esc(t('language'))}</button>`;
}

function injectLangButton() {
  if (document.querySelector('.lang-btn')) return;
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const logoutBtn = topbar.querySelector('.logout-btn');
  if (logoutBtn) {
    logoutBtn.insertAdjacentHTML('beforebegin', langButtonHTML());
  } else {
    topbar.insertAdjacentHTML('beforeend', langButtonHTML());
  }
}

function applyI18n() {
  document.documentElement.lang = currentLang() === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  const btn = document.querySelector('.lang-btn');
  if (btn) btn.textContent = t('language');
}

document.addEventListener('DOMContentLoaded', () => {
  injectLangButton();
  applyI18n();
});
