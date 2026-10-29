'use strict';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN');
const fmtQuota = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const value = Number(n), unit = value >= 100000000 ? 100000000 : value >= 10000 ? 10000 : 1;
  return unit === 1 ? fmtInt(value) : `${(value / unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit === 10000 ? '万' : '亿'}`;
};
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtCompactTime = (ts) => {
  if (!ts) return '时间未知';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const options = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleString('zh-CN', options);
};
const fmtDur = (ms) => {
  if (ms === null || ms === undefined) return '—';
  if (ms < 0) return '已过期';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr} 小时 ${m % 60} 分`;
  return `${Math.floor(hr / 24)} 天`;
};

const fmtPlanRemaining = (ms) => {
  if (ms <= 0) return '已到期';
  const hours = Math.floor(ms / 3600000);
  if (hours < 48) return `${fmtDur(ms)}后到期`;
  const days = Math.floor(hours / 24), rest = hours % 24;
  return `${days} 天${rest ? ` ${rest} 小时` : ''}后到期`;
};

const ICONS = {
  dashboard: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  trending: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  scroll: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 1 5.83 3 3 0 0 1 4.17 4.17 3 3 0 0 1 5.83 1 3 3 0 0 1 5.83-1 3 3 0 0 1 4.17-4.17 3 3 0 0 1-1-5.83 3 3 0 0 1-4.17-4.17 3 3 0 0 1-5.83-1 3 3 0 0 1-5.83 1A3 3 0 0 1 2 9z"/><circle cx="12" cy="12" r="2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
};
const icon = (name, size = 16) =>
  `<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

let TOKEN = sessionStorage.getItem('z2a_token') || localStorage.getItem('z2a_token') || '';
let RUNTIME = null;
let currentPage = 'dashboard';

async function api(path, opts = {}) {
  // Fastify 会拒绝空 body 搭配 JSON Content-Type。
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && currentPage !== 'login') { showLogin(); throw new Error('未登录'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.msg || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const t = h(`<div class="toast" role="status">${icon(type === 'ok' ? 'shield' : 'zap', 14)}${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 400); // transitionend 兜底
  }, 2500);
}

let composing = false;
let imeGuardUntil = 0;
const safariImeGuard = /^((?!chrome|chromium|crios|android|edg).)*safari/i.test(navigator.userAgent);
function isImeComposing(e) {
  return composing || e.isComposing || e.keyCode === 229 || (safariImeGuard && performance.now() < imeGuardUntil);
}
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => { composing = false; imeGuardUntil = performance.now() + 500; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest?.('form')) return;
  if (composing || e.isComposing || e.keyCode === 229) {
    e.stopPropagation();
  } else if (safariImeGuard && performance.now() < imeGuardUntil) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
document.addEventListener('submit', (e) => {
  if (composing) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const card = $('.login-card');
  const btn = $('#login-form button[type=submit]');
  btn.classList.add('loading');
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { password: $('#login-password').value } });
    TOKEN = r.token;
    localStorage.setItem('z2a_token', TOKEN);
    $('#login-error').textContent = '';
    boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  } finally { btn.classList.remove('loading'); }
});
$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  TOKEN = ''; logCache = null; localStorage.removeItem('z2a_token'); sessionStorage.removeItem('z2a_token'); showLogin();
});

function applyThemeBtn() {
  const label = $('#theme-btn-label');
  if (label) label.textContent = document.documentElement.classList.contains('dark') ? '深色' : '浅色';
}
function setTheme(mode) {
  if (mode === 'system') localStorage.removeItem('z2a_theme');
  else localStorage.setItem('z2a_theme', mode);
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  const selector = $('#s-theme');
  if (selector) { selector.value = mode; syncSelect(selector); }
  applyThemeBtn();
}
$('#theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  root.classList.remove('theme-swap');
  void root.offsetWidth;
  root.classList.add('theme-swap');
  setTheme(root.classList.contains('dark') ? 'light' : 'dark');
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem('z2a_theme')) setTheme('system');
});
applyThemeBtn();

const PAGES = [
  ['dashboard', '仪表盘', 'dashboard'], '|',
  ['accounts', '账号', 'users'], ['claims', '领卡', 'gift'], ['keys', '密钥', 'key'], '|',
  ['usage', '用量', 'trending'], ['logs', '日志', 'scroll'], ['groups', '分组', 'folder'], ['settings', '设置', 'settings'],
];
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '<div class="dock"></div>';
  const dock = $('.dock', nav);
  for (const entry of PAGES) {
    if (entry === '|') { dock.appendChild(h('<span class="dock-sep"></span>')); continue; }
    const [id, label, ic] = entry;
    const b = h(`<button class="dock-item${id === currentPage ? ' active' : ''}" data-page="${id}" aria-label="${label}" ${id === currentPage ? 'aria-current="page"' : ''}>
      <span class="di">${icon(ic, 16)}</span><span class="tip">${label}</span>
    </button>`);
    b.addEventListener('click', () => { currentPage = id; delete $('#main').dataset.fp; renderNav(); render(); });
    dock.appendChild(b);
  }
}

let pendingRender = null;
let lastRefreshAt = 0;
async function render(opts = {}) {
  const main = $('#main');
  if (main.dataset.loading === '1') { pendingRender = opts; return; }
  main.dataset.loading = '1';
  // 自动刷新关掉入场动画（避免闪动）；用户主动导航保留 fade-up
  main.classList.toggle('no-anim', !!opts.swap);
  try {
    if (currentPage === 'dashboard') await pageDashboard(main);
    else if (currentPage === 'accounts') await pageAccounts(main);
    else if (currentPage === 'claims') await pageClaims(main);
    else if (currentPage === 'usage') await pageUsage(main);
    else if (currentPage === 'keys') await pageKeys(main);
    else if (currentPage === 'groups') await pageGroups(main);
    else if (currentPage === 'settings') await pageSettings(main);
    else if (currentPage === 'logs') await pageLogs(main);
    enhanceSelects(main);
  } catch (e) {
    main.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  } finally {
    lastRefreshAt = Date.now();
    delete main.dataset.loading;
    if (pendingRender) { const next = pendingRender; pendingRender = null; render(next); }
  }
}

const selectControls = new WeakMap();
let openSelect = null;
let selectId = 0;
function syncSelect(select) { selectControls.get(select)?.sync(); }
function enhanceSelects(root) {
  root.querySelectorAll('select:not([multiple])').forEach((select) => {
    if (selectControls.has(select)) return;
    const label = select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent.trim() || select.parentElement?.querySelector('b')?.textContent.trim() || '选择选项';
    const wrapper = document.createElement('span');
    wrapper.className = `select-control${select.classList.contains('round') ? ' select-control-round' : ''}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'select-list';
    list.id = `select-list-${++selectId}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    list.hidden = true;
    if (typeof list.showPopover === 'function') list.setAttribute('popover', 'manual');
    trigger.setAttribute('aria-controls', list.id);
    select.before(wrapper);
    wrapper.append(select, trigger, list);
    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    let active = select.selectedIndex;
    let typeahead = '', typedAt = 0;
    const enabled = () => [...select.options].map((o, i) => o.disabled ? -1 : i).filter((i) => i >= 0);
    const sync = () => {
      trigger.disabled = select.disabled;
      trigger.innerHTML = `<span class="select-value"></span><svg class="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
      $('.select-value', trigger).textContent = select.selectedOptions[0]?.textContent || '请选择';
    };
    const paint = () => {
      list.replaceChildren();
      [...select.options].forEach((option, index) => {
        const item = document.createElement('div');
        item.id = `${list.id}-option-${index}`;
        item.className = 'select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        if (option.disabled) item.setAttribute('aria-disabled', 'true');
        if (index === active) item.classList.add('is-active');
        const text = document.createElement('span');
        text.textContent = option.textContent;
        item.appendChild(text);
        if (index === select.selectedIndex) item.insertAdjacentHTML('beforeend', '<span class="select-check" aria-hidden="true">✓</span>');
        item.addEventListener('pointerdown', (e) => e.preventDefault());
        item.addEventListener('click', () => { if (!option.disabled) choose(index); });
        list.appendChild(item);
      });
      if (active >= 0) {
        trigger.setAttribute('aria-activedescendant', `${list.id}-option-${active}`);
        const item = list.children[active];
        if (item && item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
        else if (item && item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
      }
    };
    const close = () => {
      if (list.hasAttribute('popover') && !list.hidden) list.hidePopover();
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      if (openSelect?.trigger === trigger) openSelect = null;
    };
    const open = () => {
      if (select.disabled || !enabled().length) return;
      openSelect?.close();
      active = select.selectedIndex >= 0 && !select.options[select.selectedIndex].disabled ? select.selectedIndex : enabled()[0];
      list.hidden = false;
      if (list.hasAttribute('popover')) list.showPopover();
      trigger.setAttribute('aria-expanded', 'true');
      openSelect = { trigger, wrapper, close };
      paint();
      const rect = trigger.getBoundingClientRect(), height = Math.min(list.scrollHeight, 260);
      const up = innerHeight - rect.bottom < height + 12 && rect.top > height + 12;
      wrapper.classList.toggle('select-open-up', up);
      if (list.hasAttribute('popover')) {
        list.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - Math.max(rect.width, 180) - 8))}px`;
        list.style.top = `${up ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
        list.style.width = `${Math.max(rect.width, 180)}px`;
      }
    };
    const choose = (index) => {
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      sync(); close(); trigger.focus();
      if (changed) { select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    trigger.addEventListener('click', () => list.hidden ? open() : close());
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { close(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        if (list.hidden) { open(); return; }
        const indices = enabled(), current = indices.indexOf(active);
        active = e.key === 'Home' ? indices[0] : e.key === 'End' ? indices.at(-1) : indices[Math.max(0, Math.min(indices.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))];
        paint(); return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && !list.hidden) { e.preventDefault(); choose(active); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
        e.preventDefault();
        if (list.hidden) open();
        typeahead = performance.now() - typedAt > 700 ? e.key : typeahead + e.key;
        typedAt = performance.now();
        const match = enabled().find((i) => select.options[i].textContent.trim().toLocaleLowerCase().startsWith(typeahead.toLocaleLowerCase()));
        if (match !== undefined) { active = match; paint(); }
      }
    });
    select.addEventListener('change', sync);
    selectControls.set(select, { sync });
    sync();
  });
}
document.addEventListener('pointerdown', (e) => { if (openSelect && !openSelect.wrapper.contains(e.target)) openSelect.close(); });
document.addEventListener('scroll', (e) => { if (openSelect && !openSelect.wrapper.contains(e.target)) openSelect.close(); }, true);
window.addEventListener('resize', () => openSelect?.close());

function modal(title, contentEl) {
  const bg = h('<div class="modal-bg"></div>');
  const box = h(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1"><div class="modal-header"><div><span class="modal-eyebrow">ZCODE2API</span><h2>${esc(title)}</h2></div><button type="button" class="modal-close" aria-label="关闭弹窗">×</button></div><div class="modal-body"></div></div>`);
  $('.modal-body', box).appendChild(contentEl);
  const trigger = document.activeElement;
  let closing = false;
  const close = (afterClose) => {
    if (closing || contentEl.dataset.submitting === 'true' || !document.body.contains(bg)) return;
    closing = true;
    if (openSelect && box.contains(openSelect.wrapper)) openSelect.close();
    document.removeEventListener('keydown', onKey);
    bg.classList.add('closing');
    const finish = () => {
      if (!bg.isConnected) return;
      bg.remove();
      if (afterClose) afterClose();
      else if (!document.querySelector('.modal-bg') && trigger?.isConnected) trigger.focus();
    };
    bg.addEventListener('transitionend', (event) => { if (event.target === bg) finish(); });
    setTimeout(finish, 350);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !isImeComposing(e)) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...box.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length);
    if (!focusable.length) { e.preventDefault(); box.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  bg.appendChild(box);
  $('.modal-close', box).addEventListener('click', () => close());
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  enhanceSelects(contentEl);
  (contentEl.querySelector('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)') || box).focus();
  return { close };
}

function confirmAction(title, message, confirmLabel = '删除') {
  return new Promise((resolve) => {
    const form = h(`<div class="confirm-content"><p>${esc(message)}</p><div class="modal-actions"><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn danger-solid" data-confirm>${esc(confirmLabel)}</button></div></div>`);
    const dialog = modal(title, form);
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; dialog.close(); resolve(result); };
    $('[data-cancel]', form).addEventListener('click', () => finish(false));
    $('[data-confirm]', form).addEventListener('click', () => finish(true));
    const observer = new MutationObserver(() => { if (!form.isConnected) { observer.disconnect(); finish(false); } });
    observer.observe(document.body, { childList: true });
  });
}

function pagehead(title, desc = '', actionsHtml = '') {
  return `<div class="pagehead fade-up">
    <div><h1 class="tt">${esc(title)}</h1>${desc ? `<p class="desc">${esc(desc)}</p>` : ''}</div>
    ${actionsHtml ? `<div class="acts">${actionsHtml}</div>` : ''}
  </div>`;
}

function statcard(label, value, { tone = 'neutral', hint = '', icon: ic = '' } = {}) {
  return `<div class="statcard">
    <div class="head"><span class="t">${esc(label)}</span>${ic ? `<span class="ico tone-${tone}">${icon(ic, 13)}</span>` : ''}</div>
    <div class="stat tone-${tone}">${value}</div>
    ${hint ? `<div class="d">${esc(hint)}</div>` : ''}
  </div>`;
}

/* 新插入的进度条从 0 生长到目标宽度 */
function growBars(scope) {
  (scope || document).querySelectorAll('.bar:not(.grown)').forEach((bar) => {
    bar.classList.add('grown');
    const i = bar.firstElementChild;
    if (!i) return;
    const target = i.style.width;
    i.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { i.style.width = target; }));
  });
}

async function pageDashboard(main) {
  const d = await api('/api/dashboard');
  // 自动刷新防抖：数据指纹未变时不重绘
  const fp = JSON.stringify([d.summary, d.busy_24h]);
  if (main.dataset.fp === fp) return;
  main.dataset.fp = fp;
  const accountNames = new Map(d.summary.accounts.map((a) => [a.id, a.platform_name || a.label || a.id]));
  const usePct = d.summary.totalGranted ? Math.round(d.summary.totalUsed / d.summary.totalGranted * 100) : 0;
  const busyPct = d.busy_24h.total ? Math.round(d.busy_24h.busy / d.busy_24h.total * 100) : 0;
  main.innerHTML = `
  ${pagehead('仪表盘', '免费额度池健康度与今日用量总览（每 5 秒自动刷新）')}
  <section class="stagger">
    <div class="cards multicol">
      ${statcard('剩余额度（token）', fmtInt(d.summary.totalRemaining), { tone: 'accent', icon: 'zap', hint: d.summary.totalPending ? `另有 ${fmtInt(d.summary.totalPending)} token 待生效` : undefined })}
      ${statcard('待生效（token）', fmtInt(d.summary.totalPending), { tone: d.summary.totalPending ? 'info' : 'neutral', icon: 'timer', hint: d.summary.totalPending ? '已领取、到达生效时间后可用' : '当前没有待生效额度' })}
      ${statcard('累计消耗', fmtInt(d.summary.totalUsed), { tone: 'info', icon: 'activity' })}
      ${statcard('活跃账号', `${d.summary.activeCount}<small> / ${d.summary.count}</small>`, { tone: d.summary.activeCount ? 'success' : 'danger', icon: 'users', hint: d.summary.activeCount ? '额度正常' : '无可用账号' })}
      ${statcard('已用比例（当前卡）', usePct + '%', { tone: usePct >= 80 ? 'danger' : usePct >= 50 ? 'warning' : 'neutral', icon: 'gauge' })}
      ${statcard('24h busy 率', busyPct + '%', { tone: busyPct >= 30 ? 'warning' : 'neutral', icon: 'timer', hint: '3008 并发上限占比' })}
    </div>
  </section>
  <section><h2>${icon('users', 15)} 账号卡片</h2><div class="cards" id="acc-cards"></div></section>`;
  const wrap = $('#acc-cards');
  if (!d.summary.accounts.length) wrap.innerHTML = '<p class="muted">暂无已纳管账号。</p>';
  for (const a of d.summary.accounts) {
    const pct = a.total ? Math.round(a.used / a.total * 100) : 0;
    wrap.appendChild(h(`<div class="card accrow">
      <div class="accrow-top">
        <span class="avatar">${esc((accountNames.get(a.id) || '?').slice(0, 1))}</span>
        <span class="accrow-name" title="${esc(a.label || a.id)}">${esc(accountNames.get(a.id))}</span>
        <span class="badge ${esc(a.status)}">● ${esc(a.status)}</span>
        <span class="badge sm">${esc(a.family)}</span>
        <span class="accrow-num">剩余 <b class="tone-accent">${fmtInt(a.remaining)}</b><span class="muted"> / ${fmtInt(a.total)}</span></span>
        <span class="accrow-num">24h <b>${fmtInt(a.delta24h)}</b></span>
        <span class="accrow-num">卡到期 <b>${a.card_expires_at ? fmtDur(a.card_expires_at - Date.now()) : '—'}</b></span>
      </div>
      <div class="bar${pct >= 80 ? ' danger' : pct >= 50 ? ' warn' : ''}"><i style="width:${pct}%"></i></div>
      ${(a.pending_buckets || []).length ? `<p class="muted" style="font-size:12px;margin:4px 0 0" title="${esc(a.pending_buckets.map((p) => `${p.name} ${fmtInt(p.total)} ${p.unit || 'token'}，${fmtTime(p.effective_at)} 生效`).join('；'))}">待生效：${esc(a.pending_buckets.map((p) => `${p.name} ${fmtInt(p.total)}（${fmtDur(p.effective_at - Date.now())}后）`).join('；'))}</p>` : ''}
      ${a.last_error ? `<p class="error" style="font-size:12px;margin:0">${esc(a.last_error)}</p>` : ''}
    </div>`));
  }
  growBars(wrap);

}

window._accFilter = window._accFilter || { q: '', status: 'all', sort: 'default' };
const ACC_STATUS = { active: '可用', cooldown: '冷却中', needs_relogin: '需授权', unverified: '待验证', web_only: '仅网页', expired: '已过期' };

function filterAccounts(accounts, groups, filter) {
  const query = (filter.q || '').trim().toLowerCase();
  const result = accounts.filter(a => {
    if (filter.status === 'needs_relogin' ? !['needs_relogin', 'unverified'].includes(a.status) : filter.status !== 'all' && a.status !== filter.status) return false;
    return !query || `${a.label} ${a.platform_name || ''} ${a.customer_id || ''} ${a.id} ${(a.capabilities || []).join(' ')} ${groups[a.group_id] || ''}`.toLowerCase().includes(query);
  });
  if (filter.sort === 'remaining') result.sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
  if (filter.sort === 'expiring') result.sort((a, b) => (a.card_expires_at || Infinity) - (b.card_expires_at || Infinity));
  return result;
}

function accountQuotaMarkup(account) {
  const live = (account.quota_buckets || []).map(bucket => `<div class="quota-entry">
    <div class="quota-entry-top"><span>${esc(bucket.name)}</span><strong title="${esc(fmtInt(bucket.remaining))} token">${fmtQuota(bucket.remaining)}</strong></div>
    <div class="quota-entry-meta"><span>总额 ${fmtQuota(bucket.total)}</span><span title="${esc(fmtTime(bucket.expires_at))}">${esc(fmtCompactTime(bucket.expires_at))} 到期</span></div>
  </div>`).join('');
  const pending = (account.pending_buckets || []).map(bucket => `<div class="quota-entry quota-entry-pending">
    <div class="quota-entry-top"><span>${esc(bucket.name)} <em>待生效</em></span><strong title="${esc(fmtInt(bucket.total))} token">${fmtQuota(bucket.total)}</strong></div>
    <div class="quota-entry-meta"><span>已领取</span><span title="${esc(fmtTime(bucket.effective_at))}">${bucket.effective_at > Date.now() ? `${esc(fmtCompactTime(bucket.effective_at))} 生效` : '等待余额刷新'}</span></div>
  </div>`).join('');
  return `<div class="quota-ledger">${live || `<p class="quiet-message">${account.has_zcode_jwt ? account.last_balance ? '暂无生效额度' : '等待余额查询' : '网页账号不参与推理'}</p>`}${pending}</div>`;
}
async function pageAccounts(main) {
  const [accounts, groups] = await Promise.all([api('/api/accounts'), api('/api/groups')]);
  window._accCache = accounts;
  renderAccPage(accounts, groups);
}
function renderAccPage(accounts, groups) {
  const main = $('#main');
  const gmap = Object.fromEntries(groups.map((g) => [g.id, g.name]));
  const f = window._accFilter;
  const statusCounts = {};
  for (const a of accounts) statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
  const attention = (statusCounts.needs_relogin || 0) + (statusCounts.unverified || 0);
  const remaining = accounts.reduce((sum, a) => sum + (Number(a.remaining) || 0), 0);
  const pending = accounts.reduce((sum, a) => sum + (Number(a.pending_total) || 0), 0);
  const pill = (v, label) => `<button type="button" data-st="${v}" aria-pressed="${f.status === v}" class="${f.status === v ? 'active' : ''}">${label}<span class="cnt">${v === 'all' ? accounts.length : v === 'needs_relogin' ? attention : statusCounts[v] || 0}</span></button>`;
  main.innerHTML = `
  ${pagehead('账号管理', '查看各模型额度、待生效奖励与账号状态。', `<button class="btn" id="accounts-refresh">${icon('refresh', 14)}刷新</button><button class="btn primary" id="add-btn">${icon('plus', 14)}添加账号</button>`)}
  <section class="overview-strip account-overview" aria-label="账号概览">
    <div><span>当前可用额度</span><strong title="${esc(fmtInt(remaining))} token">${fmtQuota(remaining)}<small> token</small></strong><p>已查询账号的可用余额</p></div>
    <div><span>已领取 · 待生效</span><strong title="${esc(fmtInt(pending))} token">${fmtQuota(pending)}<small> token</small></strong><p>未计入当前可用额度</p></div>
    <div><span>账号状态</span><strong>${statusCounts.active || 0}<small> / ${accounts.length} 可用</small></strong><p>${attention ? `${attention} 个账号需要授权或验证` : '授权和余额自动检查'}</p></div>
  </section>
  <div class="management-toolbar">
    <div class="searchbox">${icon('search', 14)}<input id="acc-q" aria-label="搜索账号" placeholder="搜索账号、ID、模型或分组" value="${esc(f.q)}"></div>
    <select id="acc-sort" class="round" aria-label="账号排序"><option value="default">默认顺序</option><option value="remaining">可用额度优先</option><option value="expiring">最近到期优先</option></select>
    <span id="acc-match-count" class="result-count" aria-live="polite"></span>
  </div>
  <nav class="status-pills account-filters" id="acc-status" aria-label="按账号状态筛选">${pill('all', '全部')}${pill('active', '可用')}${pill('needs_relogin', '需处理')}${pill('cooldown', '冷却中')}${pill('expired', '已过期')}${pill('web_only', '仅网页')}</nav>
  <section><div id="acc-table"></div></section>`;
  $('#add-btn').addEventListener('click', () => addAccountModal(groups));
  $('#accounts-refresh').addEventListener('click', () => render({ swap: true }));
  $('#acc-q').addEventListener('input', (e) => { f.q = e.target.value; renderAccTable(); });
  $('#acc-sort').value = f.sort || 'default';
  $('#acc-sort').addEventListener('change', (e) => { f.sort = e.target.value; renderAccTable(); });
  $('#acc-status').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-st]');
    if (!b) return;
    f.status = b.dataset.st;
    $$('#acc-status button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderAccTable();
  });
  renderAccTable();

  function renderAccTable() {
    const list = filterAccounts(accounts, gmap, f);
    $('#acc-match-count').textContent = `${list.length} / ${accounts.length} 个账号`;
    const tbl = $('#acc-table');
    if (!list.length) { tbl.innerHTML = `<div class="management-empty">${icon('users', 24)}<h3>${accounts.length ? '没有匹配的账号' : '添加第一个账号'}</h3><p>${accounts.length ? '尝试其他关键词，或切换账号状态。' : '通过 OAuth 授权或导入本机凭据开始使用。'}</p></div>`; return; }
    tbl.innerHTML = `<div class="tablecard account-table"><table><colgroup><col style="width:20%"><col style="width:9%"><col style="width:32%"><col style="width:8%"><col style="width:12%"><col style="width:8%"><col style="width:11%"></colgroup>
      <tr><th>账号</th><th>状态</th><th>模型额度 <span class="table-hint">token</span></th><th>24h 用量</th><th>套餐到期</th><th>分组</th><th>操作</th></tr>
      ${list.map((a) => {
        return `<tr data-acc-id="${esc(a.id)}">
        <td data-label="账号"><div class="cell-name"><span class="avatar">${esc((a.platform_name || a.label || '?').slice(0, 1))}</span><span class="nm"><b title="${esc(a.label)}">${esc(a.platform_name || a.label)}</b><span class="account-family">${a.family === 'zai' ? 'Z.ai' : 'BigModel'}${a.platform_name && a.label !== a.platform_name ? ` · ${esc(a.label)}` : ''}</span></span></div><div class="account-id-line"><span class="mono account-platform-id">${esc(a.customer_id || '账号 ID 未获取')}</span>${a.customer_id ? `<button type="button" class="text-action" data-act="copy" data-id="${esc(a.customer_id)}" aria-label="复制账号 ID">复制</button>` : ''}</div></td>
        <td data-label="状态"><span class="badge ${esc(a.status)}">● ${ACC_STATUS[a.status] || a.status}</span>${a.has_web_jwt ? `<br><span class="${a.web_cookie_expires_at && a.web_cookie_expires_at - Date.now() <= 7 * 86400000 ? 'error' : 'muted'}" style="font-size:11px">Cookie：${a.web_cookie_expires_at ? (a.web_cookie_expires_at <= Date.now() ? '已到期' : fmtDur(a.web_cookie_expires_at - Date.now()) + '后到期') : '到期时间未知'}</span>` : ''}${a.last_error ? `<br><span class="error" style="font-size:11px">${esc(a.last_error)}</span>` : ''}</td>
        <td data-label="模型额度" class="account-quota-cell">${accountQuotaMarkup(a)}</td>
        <td data-label="24h 用量" class="numeric-cell" title="${esc(fmtInt(a.delta24h))}">${fmtQuota(a.delta24h)}</td>
        <td data-label="套餐到期"><div class="plan-expiry"><b title="${esc(a.card_expires_at ? fmtTime(a.card_expires_at) : '套餐到期时间未知')}">${esc(fmtCompactTime(a.card_expires_at))}</b>${a.card_expires_at ? `<span>${esc(fmtPlanRemaining(a.card_expires_at - Date.now()))}</span>` : ''}</div></td>
        <td data-label="分组"><span class="group-label">${esc(gmap[a.group_id] || '待分组')}</span></td>
        <td data-label="操作" class="account-actions"><div class="account-action-row">
          <button class="ibtn" data-act="renew" data-id="${esc(a.id)}" aria-label="续期">${icon('refresh', 14)}<span class="tip">续期</span></button>
          <button class="ibtn" data-act="verify" data-id="${esc(a.id)}" aria-label="验证连通性">${icon('zap', 14)}<span class="tip">验证连通性</span></button>
          <details class="account-action-menu"><summary aria-label="更多账号操作">···</summary><div><button type="button" data-act="edit" data-id="${esc(a.id)}">${icon('pencil', 14)}编辑账号</button><button type="button" class="danger" data-act="del" data-id="${esc(a.id)}">${icon('trash', 14)}删除账号</button></div></details>
        </div></td></tr>`;
      }).join('')}</table></div>`;
    tbl.onclick = onAccountAction;
  }
}

function btnLoading(btn, on) { btn.classList.toggle('loading', !!on); }

async function onAccountAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  btn.closest('.account-action-menu')?.removeAttribute('open');
  const id = btn.dataset.id;
  if (btn.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(id); toast('账号 ID 已复制', 'ok'); }
    catch { toast('复制失败，请手动选择账号 ID', 'err'); }
    return;
  }
  if (btn.dataset.act === 'del') {
    if (!await confirmAction('删除账号', '确定删除该账号？凭据与快照将一并清除。')) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/accounts/${id}`, { method: 'DELETE' });
      toast(r.ok ? '已删除' : (r.error || '删除失败'), r.ok ? 'ok' : 'err');
      if (r.ok) render();
    } catch (err) { toast('删除失败：' + err.message, 'err'); btn.disabled = false; }
  } else if (btn.dataset.act === 'renew') {
    const accounts = await api('/api/accounts');
    const a = accounts.find((item) => item.id === id);
    if (!a) return toast('账号不存在', 'err');
    addAccountModal([], a);
  } else if (btn.dataset.act === 'verify') {
    btn.disabled = true;
    btnLoading(btn, true);
    try {
      const r = await api(`/api/accounts/${id}/verify`, { method: 'POST' });
      toast(`验证：${r.status}${r.reason ? '（' + r.reason + '）' : ''}`, r.ok ? 'ok' : 'err');
      render();
    } catch (err) { toast('验证失败：' + err.message, 'err'); }
    btnLoading(btn, false);
    btn.disabled = false;
  } else if (btn.dataset.act === 'edit') {
    const [accounts, groups] = await Promise.all([api('/api/accounts'), api('/api/groups')]);
    const a = accounts.find((x) => x.id === id);
    const form = h(`<div>
      <div class="kv" style="margin-bottom:12px"><b>备注</b><input id="e-label" value="${esc(a.label)}"></div>
      <div class="kv" style="margin-bottom:12px"><b>分组</b><select id="e-group">
        <option value="">待分组</option>
        ${groups.map((g) => `<option value="${esc(g.id)}" ${a.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select></div>
      <div class="kv" style="margin-bottom:6px"><b>出站代理</b><input id="e-proxy" placeholder="http://127.0.0.1:7890（留空直连）" value="${esc(a.proxy_url || '')}"></div>
      <p class="muted" style="margin:0 0 12px">该账号全部出站（推理+平台轮询）走此代理；保存后对下一次 HTTP 请求生效。</p>
      <div class="row"><button class="btn primary" id="e-save">保存</button></div></div>`);
    const m = modal('编辑账号', form);
    $('#e-save', form).addEventListener('click', async () => {
      try {
        await api(`/api/accounts/${id}`, { method: 'PATCH', body: { label: $('#e-label', form).value, group_id: $('#e-group', form).value || null, proxy_url: $('#e-proxy', form).value.trim() || null } });
        toast('已保存', 'ok'); m.close(); render();
      } catch (err) { toast('保存失败：' + err.message, 'err'); }
    });
  }
}

function addAccountModal(groups, target = null) {
  const form = h(`<div>
    <section class="import-option">
      <h2>① 本机导入（推荐）</h2>
      <p class="muted" style="margin:0">读取本机 ZCode 客户端凭据（~/.zcode/v2/credentials.json），自动解密并加验。</p>
      <div class="row"><button class="btn primary" id="i-local">从本机导入</button></div>
    </section>
    <section class="import-option">
      <h2>② OAuth 授权（新账号）</h2>
      <div class="row">
        <select id="i-provider"><option value="bigmodel">国内 BigModel</option><option value="zai">国际 Z.ai</option></select>
        <button class="btn primary" id="i-oauth">开始授权</button>
      </div>
      <div id="oauth-box" style="margin-top:10px"></div><div id="oauth-pending" style="margin-top:8px"></div>
    </section>
    <section class="import-option">
      <h2>③ Cookie 导入（受限：仅资料/营销，不可 balance/推理）</h2>
      <div class="row"><input id="i-cookie" style="flex:1" placeholder="粘贴网页 JWT（bigmodel_token_production 的值）"></div>
      <label class="muted" style="display:block;margin-top:8px">Cookie 到期时间（可选，按浏览器显示填写；未填写时尝试读取 JWT）<input id="i-cookie-expiry" type="datetime-local"></label>
      <div class="row" style="margin-top:8px"><button class="btn" id="i-cookie-btn">导入</button></div>
    </section></div>`);
  const m = modal(target ? '更新账号凭据：' + target.label : '添加账号', form);
  if (target) {
    $('#i-local', form).closest('section').remove();
    $('#i-provider', form).value = target.family;
    $('#i-provider', form).disabled = true;
    syncSelect($('#i-provider', form));
    $('#i-cookie-btn', form).textContent = '验证并更新 Cookie';
    form.insertAdjacentHTML('afterbegin', '<p class="muted">重新授权会更新此账号；网页 Cookie 需从浏览器重新获取，验证不会延长上游有效期。</p>');
  }
  if (!target)
  $('#i-local', form).addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btnLoading(btn, true);
    try {
      const r = await api('/api/accounts/import-local', { method: 'POST', body: {} });
      if (r.ok) { toast(`已导入 ${r.imported} 个账号`, 'ok'); m.close(); render(); }
      else toast(firstReason(r), 'err');
    } catch (err) { toast(err.message, 'err'); }
    btnLoading(btn, false);
  });
  const startOAuth = async () => {
    const btn = $('#i-oauth', form);
    btnLoading(btn, true);
    try {
      const r = await api('/api/accounts/oauth/start', { method: 'POST', body: { provider: $('#i-provider', form).value, account_id: target?.id } });
      showOAuthFlow(r);
    } catch (err) { toast(err.message, 'err'); }
    btnLoading(btn, false);
  };
  $('#i-oauth', form).addEventListener('click', startOAuth);
  let watchTimer;
  const stopWatch = () => { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } };
  function showOAuthFlow(r) {
    stopWatch();
    const box = $('#oauth-box', form);
    const expiresAt = Number(r.expires_at) || 0;
    box.innerHTML = `
      <div class="row" style="gap:8px;margin:0 0 10px">
        <button class="btn primary" id="oauth-open">${icon('plug', 14)}打开授权页面</button>
        <button class="btn" id="oauth-copy">复制链接</button>
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:12px">在浏览器完成登录后回到本页面：授权成功会自动提示并加入账号库。链接剩余有效期 <b id="oauth-expire" class="mono">${expiresAt ? fmtDur(expiresAt - Date.now()) : '—'}</b></p>
      <div class="row" style="gap:10px;align-items:center">
        <span class="muted" id="oauth-status" style="display:inline-flex;align-items:center;gap:6px"><span class="spinner"></span>等待授权…</span>
        <button class="btn" id="oauth-checknow" style="height:26px;padding:0 10px;font-size:12px">我已完成登录，立即检查</button>
      </div>`;
    $('#oauth-open', box).addEventListener('click', () => window.open(r.authorize_url, '_blank', 'noopener'));
    $('#oauth-copy', box).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.authorize_url); toast('授权链接已复制', 'ok'); } catch { toast('复制失败，请从授权按钮的标签页地址栏手动复制', 'err'); }
    });
    $('#oauth-checknow', box).addEventListener('click', () => check());
    const setStage = (text, busy = true) => {
      const el = $('#oauth-status', box);
      if (el) el.innerHTML = `${busy ? '<span class="spinner"></span>' : ''}${esc(text)}`;
    };
    async function check() {
      if (!document.body.contains(box)) { stopWatch(); return; }
      try {
        const status = await api(`/api/accounts/oauth/status/${encodeURIComponent(r.flow_id)}`);
        if (!document.body.contains(box)) { stopWatch(); return; }
        if (status.status === 'done') return showOAuthDone(status);
        if (['failed', 'expired', 'cancelled'].includes(status.status)) return showOAuthFail(status);
        setStage(status.status === 'exchanging' ? '处理授权结果…' : (status.error || '等待授权…'));
        const exp = $('#oauth-expire', box);
        if (exp && expiresAt) exp.textContent = fmtDur(expiresAt - Date.now());
      } catch (err) { setStage('状态查询失败：' + err.message, false); }
    }
    function showOAuthDone(status) {
      stopWatch();
      const x = status.result || {};
      const alreadyToasted = window._oauthSeen.has(r.flow_id);
      noteFlowSeen(r.flow_id);
      const accId = status.account_id || x.id || null;
      box.innerHTML = `
        <div class="oauth-result ${x.verified ? 'ok' : 'warn'}">
          <p class="${x.verified ? 'ok-text' : 'error'}" style="margin:0 0 4px;font-weight:600">${x.verified ? '✓ 登录成功，账号已加入账号库' : '✓ 登录成功，但验证未通过'}</p>
          <p class="muted" style="margin:0 0 10px;font-size:12px">${x.updated ? '已有账号的凭据已更新' : '新账号已建档并开始额度轮询'}${accId ? ` · ID <span class="mono">${esc(accId)}</span>` : ''}${x.verified ? '，balance 验证通过' : `，原因：${esc(String(x.reason || x.status || '未知'))}`}</p>
          <div class="row" style="gap:8px">
            <button class="btn primary" id="oauth-done">完成</button>
            ${!x.updated && accId ? '<button class="btn" id="oauth-view">查看账号</button>' : ''}
          </div>
        </div>`;
      if (!alreadyToasted) {
        toast(x.updated ? `账号凭据已更新${x.verified ? '，验证通过' : '，验证未通过'}` : (x.verified ? '登录成功，账号已加入账号库' : '账号已入库，但验证未通过'), x.verified ? 'ok' : 'err');
      }
      $('#oauth-done', box).addEventListener('click', () => { m.close(); render(); });
      $('#oauth-view', box)?.addEventListener('click', () => { m.close(); viewAccount(accId); });
    }
    function showOAuthFail(status) {
      stopWatch();
      noteFlowSeen(r.flow_id);
      const msg = status.error || { failed: '授权失败', expired: '授权链接已过期', cancelled: '授权已取消' }[status.status] || status.status;
      box.innerHTML = `
        <div class="oauth-result warn">
          <p class="error" style="margin:0 0 8px;font-weight:600">授权未完成：${esc(String(msg))}</p>
          <div class="row" style="gap:8px"><button class="btn" id="oauth-restart">重新开始授权</button></div>
        </div>`;
      $('#oauth-restart', box).addEventListener('click', startOAuth);
    }
    watchTimer = setInterval(check, 2000);
    check();
  }
  api('/api/accounts/oauth/pending').then((flows) => {
    const matching = flows.filter((x) => target ? x.target_id === target.id : !x.target_id);
    const pending = $('#oauth-pending', form);
    if (!matching.length) return;
    pending.innerHTML = matching.map((f, i) => `<button class="btn" data-flow-index="${i}">继续未完成的 ${esc(f.provider)} 授权</button>`).join(' ');
    pending.addEventListener('click', (e) => { const b = e.target.closest('[data-flow-index]'); if (b) showOAuthFlow(matching[Number(b.dataset.flowIndex)]); });
  }).catch(() => {});
  $('#i-cookie-btn', form).addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btnLoading(btn, true);
    try {
      const r = await api(target ? `/api/accounts/${target.id}/refresh-cookie` : '/api/accounts/import-cookie', { method: 'POST', body: { webJwt: $('#i-cookie', form).value.trim(), family: $('#i-provider', form).value, expiresAt: $('#i-cookie-expiry', form).value ? new Date($('#i-cookie-expiry', form).value).getTime() : null } });
      if (r.ok) { toast(target ? '网页会话已更新' : '已导入（web_only 受限账号）', 'ok'); m.close(); render(); }
      else toast(r.error || r.reason || '导入失败', 'err');
    } catch (err) { toast(err.message, 'err'); }
    btnLoading(btn, false);
  });
}

function firstReason(r) {
  if (r.error) return r.error;
  if (r.results?.length) return r.results.map((x) => x.reason || (x.ok ? '成功' : '失败')).join('; ');
  return '导入失败';
}

/* ---------- OAuth 授权全局回执 ----------
   弹窗只是入口之一：用户可能关掉弹窗、切走页面甚至刷新后再完成登录。
   服务端把「已完成且未被确认」的授权流程持久化在 oauth_flows.noticed_at，
   这里每 5s 收割一次，保证登录成功一定有提示 + 账号库刷新。 */
window._oauthSeen = window._oauthSeen || new Set();
function noteFlowSeen(flowId) {
  if (!flowId || window._oauthSeen.has(flowId)) return;
  window._oauthSeen.add(flowId);
  api('/api/accounts/oauth/ack', { method: 'POST', body: { flow_ids: [flowId] } }).catch(() => {});
}
function startOauthWatcher() {
  if (window._oauthWatchTimer) clearInterval(window._oauthWatchTimer);
  window._oauthWatchTimer = setInterval(async () => {
    // 弹窗打开时由弹窗内的 watch 负责（避免双重提示）；后台标签页与未登录时静默
    if (!TOKEN || document.hidden || document.querySelector('.modal-bg')) return;
    let w;
    try { w = await api('/api/accounts/oauth/watch'); } catch { return; }
    for (const f of w.notified || []) {
      if (window._oauthSeen.has(f.flow_id)) continue;
      noteFlowSeen(f.flow_id);
      const x = f.result || {};
      if (f.status === 'done') {
        toast((x.updated ? '账号凭据已更新' : '登录成功，新账号已加入账号库') + (x.verified ? '（验证通过）' : `（验证未通过：${x.reason || x.status || ''}）`), x.verified ? 'ok' : 'err');
        if (['dashboard', 'accounts'].includes(currentPage) && $('#main').dataset.loading !== '1') render({ swap: true }).catch(() => {});
      } else {
        toast(`${f.provider} 授权未完成：${f.error || f.status}`, 'err');
      }
    }
  }, 5000);
}

/** 跳到账号页并高亮新入库的账号行 */
async function viewAccount(id) {
  window._highlightAccId = id;
  currentPage = 'accounts';
  delete $('#main').dataset.fp;
  renderNav();
  try { await render(); } catch { return; }
  const row = document.querySelector(`#acc-table tr[data-acc-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add('hl');
    row.scrollIntoView({ block: 'center' });
    setTimeout(() => row.classList.remove('hl'), 4000);
  }
}

async function pageUsage(main) {
  const s = await api('/api/usage/stats?hours=' + (window._usageHours || 24));
  const sum = (field) => s.byHour.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  const requests = sum('reqs'), success = sum('ok'), input = sum('tin'), output = sum('tout');
  const maxReq = Math.max(1, ...s.byHour.map((row) => Number(row.reqs) || 0));
  const categories = {
    model: { label: '模型', columns: ['模型', '请求', 'Tokens'], rows: s.byModel.map((r) => `<tr><td>${esc(r.model || '未知')}</td><td>${fmtInt(r.reqs)}</td><td class="mono">${fmtInt((r.tin || 0) + (r.tout || 0))}</td></tr>`) },
    key: { label: '密钥', columns: ['密钥', '请求', 'Tokens'], rows: s.byKey.map((r) => `<tr><td>${esc(r.name || r.key_id || '匿名')}</td><td>${fmtInt(r.reqs)}</td><td class="mono">${fmtInt(r.tokens || 0)}</td></tr>`) },
    account: { label: '账号', columns: ['账号', '请求', '成功', 'Busy', 'Tokens'], rows: s.byAccount.map((r) => `<tr><td>${esc(r.label || r.account_id || '未分配')}</td><td>${fmtInt(r.reqs)}</td><td>${fmtInt(r.ok || 0)}</td><td>${fmtInt(r.busy || 0)}</td><td class="mono">${fmtInt(r.tokens || 0)}</td></tr>`) },
    status: { label: '状态', columns: ['状态', '次数'], rows: s.byStatus.map((r) => `<tr><td>${esc(r.status || '未知')}</td><td>${fmtInt(r.n)}</td></tr>`) },
  };
  const detailState = window._usageDetail || (window._usageDetail = { tab: 'model', pages: {} });
  if (!categories[detailState.tab]) detailState.tab = 'model';
  main.innerHTML = `
  ${pagehead('用量统计', '统计本项目网关的请求记录，不包含客户端直接发起的请求。',
    `<select id="u-hours" class="round" aria-label="统计时间范围"><option value="24">近 24 小时</option><option value="168">近 7 天</option><option value="720">近 30 天</option></select><button class="btn" id="usage-refresh">${icon('refresh', 14)}刷新</button>`)}
  <section><div class="cards multicol usage-summary">
    ${statcard('请求数', fmtInt(requests), { tone: 'info', icon: 'activity' })}
    ${statcard('成功率', requests ? `${(success / requests * 100).toFixed(1)}%` : '—', { tone: 'success', icon: 'shield', hint: `${fmtInt(success)} 次成功` })}
    ${statcard('Token 用量', fmtInt(input + output), { tone: 'accent', icon: 'zap', hint: `输入 ${fmtInt(input)} · 输出 ${fmtInt(output)}` })}
    ${statcard('首 Token 时间 P50 / P95', s.ttft ? `${fmtInt(s.ttft.p50)}<small> / ${fmtInt(s.ttft.p95)} ms</small>` : '—', { icon: 'timer', hint: '仅统计成功请求' })}
  </div></section>
  <section><div class="usage-heading"><h2>${icon('trending', 15)} 请求趋势</h2><span class="muted">${s.time_unit === 'day' ? '按天' : '按小时'} · 仅显示有记录的时段</span></div>
    ${s.byHour.length ? `<div class="usage-trend">${s.byHour.map((r) => {
      const label = String(r.bucket || '未知时段').replace('T', ' ').replace(':00:00', ':00');
      const description = `${label}：${fmtInt(r.reqs)} 次请求，${fmtInt((r.tin || 0) + (r.tout || 0))} tokens`;
      return `<div class="usage-trend-row" title="${esc(description)}" aria-label="${esc(description)}"><span class="usage-period mono">${esc(label)}</span><span class="usage-track"><i style="width:${Math.max(0, Math.min(100, (Number(r.reqs) || 0) / maxReq * 100))}%"></i></span><span class="usage-count">${fmtInt(r.reqs)}</span></div>`;
    }).join('')}</div>` : '<div class="usage-empty usage-trend">所选时间范围内暂无请求记录</div>'}
  </section>
  <section><h2>${icon('layers', 15)} 用量明细</h2><div id="usage-detail"></div></section>`;
  const detail = $('#usage-detail', main);
  const renderDetail = (focusTab = false) => {
    const { tab, pages } = detailState;
    const current = categories[tab];
    const total = current.rows.length, pageCount = Math.max(1, Math.ceil(total / 10));
    const page = Math.max(1, Math.min(pages[tab] || 1, pageCount));
    pages[tab] = page;
    const rows = current.rows.slice((page - 1) * 10, page * 10);
    const pageNumbers = [];
    for (let i = 1; i <= pageCount; i++) {
      if (i === 1 || i === pageCount || Math.abs(i - page) <= 2) pageNumbers.push(i);
      else if (pageNumbers.at(-1) !== '…') pageNumbers.push('…');
    }
    detail.innerHTML = `<nav class="section-tabs usage-tabs" role="tablist" aria-label="用量明细分类">${Object.entries(categories).map(([id, group]) => `<button type="button" class="tab${id === tab ? ' active' : ''}" role="tab" id="usage-tab-${id}" aria-selected="${id === tab}" aria-controls="usage-detail-panel" tabindex="${id === tab ? '0' : '-1'}" data-usage-tab="${id}">${group.label}<span class="cnt">${fmtInt(group.rows.length)}</span></button>`).join('')}</nav>
      <div class="usage-panel" role="tabpanel" id="usage-detail-panel" aria-labelledby="usage-tab-${tab}">
        ${rows.length ? `<div class="tablecard"><table><thead><tr>${current.columns.map((col) => `<th>${col}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="usage-empty">所选分类暂无数据</p>'}
        <div class="pager usage-pager" aria-label="用量明细分页"><button type="button" data-usage-page="prev" aria-label="上一页" ${page === 1 ? 'disabled' : ''}>‹</button>${pageNumbers.map((n) => n === '…' ? '<span aria-hidden="true">…</span>' : `<button type="button" data-usage-page="${n}" aria-label="第 ${n} 页" ${n === page ? 'class="cur" aria-current="page"' : ''}>${n}</button>`).join('')}<button type="button" data-usage-page="next" aria-label="下一页" ${page === pageCount ? 'disabled' : ''}>›</button><span class="pinfo">共 ${fmtInt(total)} 条</span></div>
      </div>`;
    if (focusTab) detail.querySelector(`[data-usage-tab="${tab}"]`)?.focus();
  };
  detail.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-usage-tab]');
    if (tab && tab.dataset.usageTab !== detailState.tab) { detailState.tab = tab.dataset.usageTab; renderDetail(true); return; }
    const button = e.target.closest('[data-usage-page]');
    if (button && !button.disabled) {
      const action = button.dataset.usagePage;
      detailState.pages[detailState.tab] = action === 'next' ? detailState.pages[detailState.tab] + 1 : action === 'prev' ? detailState.pages[detailState.tab] - 1 : Number(action);
      renderDetail();
      detail.querySelector(`[data-usage-page="${detailState.pages[detailState.tab]}"]`)?.focus();
    }
  });
  detail.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-usage-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = Object.keys(categories), index = ids.indexOf(detailState.tab);
    detailState.tab = e.key === 'Home' ? ids[0] : e.key === 'End' ? ids.at(-1) : ids[(index + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    renderDetail(true);
  });
  renderDetail();
  $('#u-hours').value = String(window._usageHours || 24);
  $('#u-hours').addEventListener('change', (e) => { window._usageHours = Number(e.target.value); detailState.pages = {}; render(); });
  $('#usage-refresh').addEventListener('click', () => render());
}

async function pageKeys(main) {
  const keys = await api('/api/keys');
  main.innerHTML = `
  ${pagehead('API 密钥', '对外反代网关的分发密钥：Bearer / x-api-key 鉴权 · 配额与白名单 · 密钥级默认思考档位',
    `<button class="btn primary" id="add-key">${icon('plus', 14)}新建密钥</button>`)}
  <section style="animation-delay:50ms"><div id="key-table" class="fade-up"></div>
  <p class="muted" style="margin:0">接入示例：<code>Authorization: Bearer &lt;密钥&gt;</code> → <code>POST http://127.0.0.1:${RUNTIME?.gateway_port}/v1/chat/completions</code>（OpenAI）或 <code>/v1/messages</code>（Anthropic）</p></section>`;
  $('#key-table').innerHTML = keys.length ? `<div class="tablecard"><table>
    <tr><th>名称</th><th>尾号</th><th>配额</th><th>已用</th><th>分组链</th><th>默认档位</th><th>白名单</th><th>状态</th><th>操作</th></tr>
    ${keys.map((k) => `<tr>
      <td><b style="font-size:13px">${esc(k.name)}</b><br><span class="muted" style="font-size:11px">${fmtTime(k.created_at)}</span></td>
      <td class="mono">…${esc(k.key_tail)}</td>
      <td class="mono">${k.quota_limit === null ? '不限' : fmtInt(k.quota_limit)}</td>
      <td class="mono">${fmtInt(k.used_units)}</td>
      <td style="font-size:11px">${(k.group_order || []).join(' → ') || '默认链'}</td>
      <td>${k.default_level ? `<span class="badge">${esc(k.default_level)}</span>` : '<span class="muted">全局</span>'}</td>
      <td style="font-size:11px">${k.model_whitelist.length ? k.model_whitelist.map((m) => `<span class="badge sm">${esc(m)}</span>`).join(' ') : '全部模型'}${k.ip_whitelist.length ? '<br>IP: ' + esc(k.ip_whitelist.join(',')) : ''}</td>
      <td>${k.enabled ? '<span class="ok-text">● 启用</span>' : '<span class="muted">禁用</span>'}</td>
      <td><div class="row" style="gap:6px;justify-content:flex-end"><button class="btn" style="height:28px;padding:0 10px;font-size:12px" data-edit="${esc(k.id)}">编辑</button><button class="btn danger" style="height:28px;padding:0 10px;font-size:12px" data-del="${esc(k.id)}">删除</button></div></td></tr>`).join('')}
  </table></div>` : '<p class="muted">还没有密钥。</p>';
  $('#key-table').addEventListener('click', async (e) => {
    const del = e.target.closest('button[data-del]');
    const edit = e.target.closest('button[data-edit]');
    if (del) {
      if (!await confirmAction('删除密钥', '确定删除该密钥？使用此密钥的客户端将无法继续访问。')) return;
      try {
        await api(`/api/keys/${del.dataset.del}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        render();
      } catch (err) { toast('删除失败：' + err.message, 'err'); }
    } else if (edit) {
      const k = keys.find((x) => x.id === edit.dataset.edit);
      const form = h(`<div>
        <div class="kv"><b>名称</b><input id="k-name" value="${esc(k.name)}"></div>
        <div class="kv"><b>配额(总token)</b><input id="k-quota" type="number" value="${k.quota_limit ?? ''}" placeholder="留空不限"></div>
        <div class="kv"><b>分组链</b><input id="k-chain" value="${esc((k.group_order || []).join(','))}" placeholder="g_xxx,g_yyy（逗号分隔，空=默认链）"></div>
        <div class="kv"><b>默认思考档位</b><select id="k-level">
          <option value="" ${!k.default_level ? 'selected' : ''}>跟随全局设置</option>
          <option value="low" ${k.default_level === 'low' ? 'selected' : ''}>low（最快）</option>
          <option value="high" ${k.default_level === 'high' ? 'selected' : ''}>high（深思）</option>
          <option value="max" ${k.default_level === 'max' ? 'selected' : ''}>max</option>
        </select></div>
        <div class="kv"><b>模型白名单</b><input id="k-models" value="${esc(k.model_whitelist.join(','))}" placeholder="逗号分隔，空=全部"></div>
        <div class="kv"><b>IP 白名单</b><input id="k-ips" value="${esc(k.ip_whitelist.join(','))}" placeholder="逗号分隔，支持 1.2.3.*，空=不限"></div>
        <div class="kv"><b>黏住分钟</b><input id="k-sticky" type="number" value="${k.sticky_minutes}"></div>
        <div class="kv"><b>启用</b><input id="k-enabled" type="checkbox" ${k.enabled ? 'checked' : ''}></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="k-save">保存</button></div></div>`);
      const m = modal('编辑密钥', form);
      $('#k-save', form).addEventListener('click', async () => {
        const chain = $('#k-chain', form).value.split(',').map((s) => s.trim()).filter(Boolean);
        try {
          await api(`/api/keys/${k.id}`, { method: 'PATCH', body: {
            name: $('#k-name', form).value,
            quota_limit: $('#k-quota', form).value === '' ? null : Number($('#k-quota', form).value),
            group_order: chain.length ? chain : null,
            default_level: $('#k-level', form).value || null,
            model_whitelist: $('#k-models', form).value.split(',').map((s) => s.trim()).filter(Boolean),
            ip_whitelist: $('#k-ips', form).value.split(',').map((s) => s.trim()).filter(Boolean),
            sticky_minutes: Number($('#k-sticky', form).value) || 0,
            enabled: $('#k-enabled', form).checked,
          } });
          toast('已保存', 'ok'); m.close(); render();
        } catch (err) { toast('保存失败：' + err.message, 'err'); }
      });
    }
  });
  $('#add-key').addEventListener('click', () => {
    const form = h(`<form class="dialog-form"><p class="dialog-intro">为使用网关的客户端创建独立密钥，方便管理用量与访问权限。</p><label class="dialog-field">密钥名称<input name="name" maxlength="80" placeholder="例如：Claude Code" required></label><p class="dialog-error error" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-cancel>取消</button><button type="submit" class="btn primary">创建密钥</button></div></form>`);
    const m = modal('新建密钥', form);
    $('[data-cancel]', form).addEventListener('click', () => m.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) { $('.dialog-error', form).textContent = '请输入密钥名称。'; return; }
      const btn = $('button[type=submit]', form);
      if (btn.disabled) return;
      btn.disabled = true;
      form.dataset.submitting = 'true';
      btnLoading(btn, true);
      try {
        const r = await api('/api/keys', { method: 'POST', body: { name } });
        render();
        delete form.dataset.submitting;
        m.close(() => {
          const result = h(`<div class="secret-result"><p class="dialog-intro">密钥只显示一次，请立即复制并妥善保存。</p><pre class="log">${esc(r.secret)}</pre><div class="modal-actions"><button type="button" class="btn primary" data-copy>复制密钥</button></div></div>`);
          modal('密钥已创建', result);
          $('[data-copy]', result).addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(r.secret); toast('已复制', 'ok'); }
            catch { toast('复制失败，请手动选择并复制密钥', 'err'); }
          });
        });
      } catch (err) { $('.dialog-error', form).textContent = '创建失败：' + err.message; }
      finally { delete form.dataset.submitting; btn.disabled = false; btnLoading(btn, false); }
    });
  });
}

async function pageGroups(main) {
  const groups = await api('/api/groups');
  main.innerHTML = `
  ${pagehead('分组调度链', '分组按顺序调度 · 策略决定账号排序（primary 主力 / backup 兜底）',
    `<button class="btn primary" id="add-group">${icon('plus', 14)}新建分组</button>`)}
  <section id="group-list" style="animation-delay:50ms">
  ${groups.length ? `<div class="tablecard fade-up"><table><tr><th>名称</th><th>角色</th><th>族过滤</th><th>策略</th><th>临期窗口</th><th>操作</th></tr>
    ${groups.map((g) => `<tr><td><div class="cell-name"><span class="avatar">${esc((g.name || '?').slice(0, 1))}</span><span class="nm"><b>${esc(g.name)}</b></span></div></td>
      <td><span class="badge ${g.role === 'primary' ? 'active' : ''}">${esc(g.role)}</span></td><td>${esc(g.family_filter || '混合')}</td>
      <td class="mono">${esc(g.policy)}</td><td>${g.urgent_window_min} 分</td>
      <td><div class="row" style="justify-content:flex-end"><button class="btn danger" style="height:28px;padding:0 10px;font-size:12px" data-del="${esc(g.id)}">删除</button></div></td></tr>`).join('')}</table></div>`
    : '<p class="muted">暂无分组。</p>'}</section>`;
  $('#add-group').addEventListener('click', () => {
    const form = h(`<form class="dialog-form"><p class="dialog-intro">设置账号池的角色与调度顺序，创建后可将账号加入分组。</p><label class="dialog-field">分组名称<input name="name" maxlength="80" placeholder="例如：默认池" required></label><div class="dialog-grid"><label class="dialog-field">角色<select name="role"><option value="primary">主力</option><option value="backup">备用</option></select></label><label class="dialog-field">账号类型<select name="family"><option value="">全部类型</option><option value="bigmodel">国内 BigModel</option><option value="zai">国际 Z.ai</option></select></label></div><label class="dialog-field">调度策略<select name="policy"><option value="balanced">均衡调度</option><option value="expiring_first">临期优先</option><option value="remaining_desc">剩余额度优先</option></select></label><p class="dialog-error error" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-cancel>取消</button><button type="submit" class="btn primary">创建分组</button></div></form>`);
    const m = modal('新建分组', form);
    $('[data-cancel]', form).addEventListener('click', () => m.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) { $('.dialog-error', form).textContent = '请输入分组名称。'; return; }
      const btn = $('button[type=submit]', form);
      if (btn.disabled) return;
      btn.disabled = true;
      form.dataset.submitting = 'true';
      btnLoading(btn, true);
      try {
        const r = await api('/api/groups', { method: 'POST', body: { name, role: form.elements.role.value, policy: form.elements.policy.value, family_filter: form.elements.family.value || null } });
        if (!r.ok) throw new Error(r.error || '创建失败');
        delete form.dataset.submitting;
        m.close(); toast('分组已创建', 'ok'); render();
      } catch (err) { $('.dialog-error', form).textContent = '创建失败：' + err.message; }
      finally { delete form.dataset.submitting; btn.disabled = false; btnLoading(btn, false); }
    });
  });
  $('#group-list').addEventListener('click', async (e) => {
    const del = e.target.closest('button[data-del]');
    if (!del) return;
    if (!await confirmAction('删除分组', '确定删除该分组？分组内仍有账号时无法删除。')) return;
    try {
      const r = await api(`/api/groups/${del.dataset.del}`, { method: 'DELETE' });
      toast(r.ok ? '已删除' : r.error, r.ok ? 'ok' : 'err');
      render();
    } catch (err) { toast('删除失败：' + err.message, 'err'); }
  });
}

async function pageSettings(main) {
  const s = await api('/api/settings');
  main.innerHTML = `
  ${pagehead('设置', '保存即热更新 · 端口在 config.json 固定')}
  <section style="animation-delay:50ms">
    <div class="formcard fade-up"><h3>运行设置</h3>
    <div class="fieldgrid">
      <label class="f">外观<select id="s-theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label class="f">推理通道<input value="HTTP 直连" readonly></label>
      <label class="f">轮询间隔(秒)<input id="s-poll" type="number" value="${s.poll_interval_sec}"></label>
      <label class="f">抖动(秒)<input id="s-jitter" type="number" value="${s.poll_jitter_sec}"></label>
      <label class="f">轮询并发<input id="s-conc" type="number" value="${s.poll_concurrency}"></label>
      <label class="f">默认思考档位<select id="s-level"><option value="low" ${s.default_reasoning_level === 'low' ? 'selected' : ''}>low（最快）</option><option value="high" ${s.default_reasoning_level === 'high' ? 'selected' : ''}>high（深思）</option><option value="max" ${s.default_reasoning_level === 'max' ? 'selected' : ''}>max</option></select></label>
      <label class="f">客户端版本<input id="s-ver" value="${esc(s.app_version)}"></label>
      <label class="f check">自动领卡<input id="s-claim" type="checkbox" ${s.claim_auto_enabled ? 'checked' : ''}> 周期(分)<input id="s-claimmin" type="number" value="${s.claim_auto_min}" style="width:76px"></label>
    </div>
    <p class="muted" style="margin:0">模型别名（JSON）：</p>
    <textarea id="s-aliases" style="min-height:56px">${esc(JSON.stringify(s.aliases, null, 2))}</textarea>
    <p class="muted" style="margin:0">重试参数（JSON）：</p>
    <textarea id="s-retry" style="min-height:120px">${esc(JSON.stringify(s.retry, null, 2))}</textarea>
    <p class="muted" style="margin:0">限流先换号，全池限流后重试 10 秒，不限次数。HTTP 超时（毫秒；total_timeout_ms 为 0 表示不限制整轮时长）：</p>
    <textarea id="s-http" style="min-height:100px">${esc(JSON.stringify(s.http, null, 2))}</textarea>
    <div class="foot"><button class="btn primary" id="s-save">保存</button></div></div>
  </section>
  <section>
    <div class="formcard"><h3>${icon('plug', 14)} 端口</h3>
    <p class="muted" style="margin:0">Web ${RUNTIME?.web_port ?? s.web_port} · 网关 ${RUNTIME?.gateway_port ?? s.gateway_port} —— 要固定端口，在项目根目录 config.json 配置 web_port / gateway_port（0=随机）后重启</p>
  </div>
  </section>
  `;
  $('#s-theme').value = localStorage.getItem('z2a_theme') || 'system';
  $('#s-theme').addEventListener('change', (e) => setTheme(e.target.value));
  $('#s-save').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    btnLoading(btn, true);
    try {
      const body = {
        poll_interval_sec: Number($('#s-poll').value), poll_jitter_sec: Number($('#s-jitter').value),
        poll_concurrency: Number($('#s-conc').value), claim_auto_enabled: $('#s-claim').checked,
        claim_auto_min: Number($('#s-claimmin').value),
        default_reasoning_level: $('#s-level').value,
        app_version: $('#s-ver').value,
        inference_driver: 'http', http: JSON.parse($('#s-http').value),
        aliases: JSON.parse($('#s-aliases').value), retry: JSON.parse($('#s-retry').value),
      };
      await api('/api/settings', { method: 'PUT', body });
      toast('已保存并热更新', 'ok');
    } catch (err) { toast('保存失败：' + err.message, 'err'); }
    btnLoading(btn, false);
  });

}

const LOG_PAGE_SIZE = 10;
window._logPage = window._logPage || {};
window._logTab = window._logTab || 'logs';
let logCache = null;
function pagerHtml(total, page, id) {
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  const cur = Math.min(page, pages);
  window._logPage[id] = cur;
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - cur) <= 2) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return `<div class="pager usage-pager" data-pager="${id}" aria-label="日志分页">
    <button type="button" data-pg="prev" aria-label="上一页" ${cur === 1 ? 'disabled' : ''}>‹</button>
    ${nums.map((n) => n === '…' ? '<span aria-hidden="true">…</span>' : `<button type="button" data-pg="${n}" aria-label="第 ${n} 页" ${n === cur ? 'class="cur" aria-current="page"' : ''}>${n}</button>`).join('')}
    <button type="button" data-pg="next" aria-label="下一页" ${cur === pages ? 'disabled' : ''}>›</button>
    <span class="pinfo">共 ${fmtInt(total)} 条</span>
  </div>`;
}
function bindPager(scope, totalOf, rerender) {
  scope.querySelectorAll('.pager[data-pager]').forEach((p) => {
    p.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pg]');
      if (!btn || btn.disabled) return;
      const id = p.dataset.pager;
      const pages = Math.max(1, Math.ceil(totalOf(id) / LOG_PAGE_SIZE));
      let cur = window._logPage[id] || 1;
      const pg = btn.dataset.pg;
      if (pg === 'first') cur = 1;
      else if (pg === 'prev') cur = Math.max(1, cur - 1);
      else if (pg === 'next') cur = Math.min(pages, cur + 1);
      else if (pg === 'last') cur = pages;
      else cur = Number(pg);
      if (cur === window._logPage[id]) return;
      window._logPage[id] = cur;
      Promise.resolve(rerender()).then(() => scope.querySelector(`[data-pager="${id}"] [data-pg="${cur}"]`)?.focus());
    });
  });
}

async function pageLogs(main) {
  if (!logCache || Date.now() - logCache.ts > 15000) {
    const data = await Promise.all([
      api('/api/usage/logs?limit=80'), api('/api/schedule-logs?limit=40'), api('/api/audit?limit=50'),
    ]);
    logCache = { data, ts: Date.now() };
  }
  const [logs, sched, aud] = logCache.data;
  const st = window._logPage;
  const f = window._logFilter = window._logFilter || { hours: 'all', status: 'all', model: 'all' };
  const tab = window._logTab;
  const since = f.hours === 'all' ? 0 : Date.now() - Number(f.hours) * 3600e3;
  const flt = (rows) => rows.filter((r) => {
    if (since && (r.ts || 0) < since) return false;
    if (f.status !== 'all' && (r.status || '') !== f.status) return false;
    if (f.model !== 'all' && (r.model || '') !== f.model) return false;
    return true;
  });
  const F = flt(logs);
  const models = [...new Set(logs.map((r) => r.model).filter(Boolean))];
  const okN = F.filter((r) => r.status === 'success').length;
  const errN = F.filter((r) => r.status && r.status !== 'success' && r.status !== 'busy').length;
  const busyN = F.filter((r) => r.status === 'busy').length;
  const ttfts = F.map((r) => r.ttft_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const p50 = ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null;
  const tok = F.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0);
  const lp = Math.min(st.logs || 1, Math.max(1, Math.ceil(F.length / LOG_PAGE_SIZE)));
  const sp = Math.min(st.sched || 1, Math.max(1, Math.ceil(sched.length / LOG_PAGE_SIZE)));
  const ap = Math.min(st.audit || 1, Math.max(1, Math.ceil(aud.length / LOG_PAGE_SIZE)));
  st.logs = lp; st.sched = sp; st.audit = ap;
  const logsView = F.slice((lp - 1) * LOG_PAGE_SIZE, lp * LOG_PAGE_SIZE);
  const schedView = sched.slice((sp - 1) * LOG_PAGE_SIZE, sp * LOG_PAGE_SIZE);
  const audView = aud.slice((ap - 1) * LOG_PAGE_SIZE, ap * LOG_PAGE_SIZE);
  const hourLabel = { all: '全部时间', 24: '近 24 小时', 168: '近 7 天', 720: '近 30 天' };

  /* 顶部胶囊 Tab（参考站 账号|任务 形态），带计数徽标 */
  const tabsHtml = `<nav class="section-tabs fade-up" style="animation-delay:50ms" role="tablist" aria-label="日志分区">
    ${[['logs', '调用记录', 'scroll', F.length], ['sched', '调度时间线', 'timer', sched.length], ['audit', '审计', 'shield', aud.length]]
      .map(([id, label, ic, n]) => `<button type="button" class="tab${tab === id ? ' active' : ''}" data-ltab="${id}" role="tab" id="log-tab-${id}" aria-controls="log-panel" aria-selected="${tab === id}" tabindex="${tab === id ? '0' : '-1'}">${icon(ic, 13)}${label}<span class="cnt">${n}</span></button>`).join('')}
  </nav>`;

  const emptyBox = (ic, text) => `<div class="empty">${icon(ic, 22)}<span>${text}</span></div>`;
  const statusBadge = (s) => s === 'success' ? '<span class="badge ok">success</span>'
    : s === 'busy' ? '<span class="badge busy">busy</span>'
    : `<span class="badge err">${esc(s || 'error')}</span>`;

  let body = '';
  if (tab === 'logs') {
    body = `
    <section class="fade-up" style="animation-delay:100ms">
      <div class="toolbar">
        <select id="lf-hours" class="round" aria-label="时间范围">${Object.entries(hourLabel).map(([v, l]) => `<option value="${v}" ${f.hours === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="lf-status" class="round" aria-label="状态筛选">
          <option value="all" ${f.status === 'all' ? 'selected' : ''}>全部状态</option>
          <option value="success" ${f.status === 'success' ? 'selected' : ''}>success</option>
          <option value="busy" ${f.status === 'busy' ? 'selected' : ''}>busy</option>
          <option value="error" ${f.status === 'error' ? 'selected' : ''}>error</option>
        </select>
        <select id="lf-model" class="round" aria-label="模型筛选">
          <option value="all" ${f.model === 'all' ? 'selected' : ''}>全部模型</option>
          ${models.map((m) => `<option value="${esc(m)}" ${f.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn" id="lf-reset">${icon('refresh', 14)}重置</button>
      </div>
      <div class="cards multicol">
        ${statcard('调用总数', fmtInt(F.length), { tone: 'neutral', icon: 'scroll' })}
        ${statcard('成功 / busy', `${okN}<small> / ${busyN}</small>`, { tone: 'success', icon: 'shield' })}
        ${statcard('失败', fmtInt(errN), { tone: errN ? 'danger' : 'neutral', icon: 'zap' })}
        ${statcard('TTFT P50', p50 !== null ? `${p50}<small> ms</small>` : '—', { tone: 'info', icon: 'timer' })}
        ${statcard('Token 消耗', fmtInt(tok), { tone: 'accent', icon: 'activity' })}
      </div>
    </section>
    <section class="fade-up" style="animation-delay:150ms">
      ${F.length ? `<div class="tablecard"><table><colgroup><col style="width:118px"><col style="width:104px"><col style="width:12%"><col style="width:15%"><col style="width:74px"><col style="width:40px"><col style="width:64px"><col style="width:72px"><col style="width:22%"></colgroup>
        <tr><th>时间</th><th>密钥</th><th>账号</th><th>模型</th><th>状态</th><th>尝试</th><th>TTFT</th><th>tokens</th><th>错误</th></tr>
        ${logsView.map((r) => `<tr><td class="mono" style="white-space:nowrap">${fmtTime(r.ts)}</td><td>${esc(r.key_name || r.key_id || '—')}</td><td>${esc(r.account_label || r.account_id || '—')}</td>
          <td class="mono" style="color:var(--foreground)">${esc(r.model)}${r.reasoning_level ? ` <span class="badge sm">${esc(r.reasoning_level)}</span>` : ''}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="mono">${r.attempt_count}</td><td class="mono">${r.ttft_ms ?? '—'}</td><td class="mono">${fmtInt((r.tokens_in || 0) + (r.tokens_out || 0))}</td>
          <td class="mono" style="font-size:11px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.error_message || '')}">${esc(r.error_message || '')}</td></tr>`).join('')}</table></div>${pagerHtml(F.length, lp, 'logs')}`
      : emptyBox('scroll', '当前筛选条件下暂无请求')}
    </section>`;
  } else if (tab === 'sched') {
    const candInfo = (raw) => {
      try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(arr)) {
          const picked = arr.find((x) => x && x.picked);
          return { n: arr.length, label: picked?.label || picked?.account || '' };
        }
      } catch { /* 非 JSON 按原文显示 */ }
      return { n: null, label: String(raw ?? '—') };
    };
    body = `<section class="fade-up" style="animation-delay:100ms">
      ${sched.length ? `<div class="tablecard"><table><colgroup><col style="width:132px"><col style="width:170px"><col style="width:110px"><col style="width:180px"><col></colgroup>
        <tr><th>时间</th><th>请求 ID</th><th>策略</th><th>选中账号</th><th>候选</th></tr>
        ${schedView.map((r) => {
          const c = candInfo(r.candidates);
          return `<tr><td class="mono" style="white-space:nowrap">${fmtTime(r.ts)}</td><td class="mono">${esc(r.request_id)}</td>
          <td><span class="badge">${esc(r.policy || '—')}</span></td><td>${esc(r.picked || '—')}</td><td>${c.n !== null ? `<span class="badge plain">候选 ${c.n}</span>${c.label ? ` <span class="muted" style="font-size:11px">${esc(c.label)}</span>` : ''}` : esc(c.label)}</td></tr>`;
        }).join('')}</table></div>${pagerHtml(sched.length, sp, 'sched')}`
      : emptyBox('timer', '暂无调度记录——首次推理后这里会显示选路时间线')}
    </section>`;
  } else {
    body = `<section class="fade-up" style="animation-delay:100ms">
      ${aud.length ? `<div class="tablecard"><table><colgroup><col style="width:132px"><col style="width:120px"><col style="width:140px"><col></colgroup>
        <tr><th>时间</th><th>动作</th><th>操作者</th><th>详情</th></tr>
        ${audView.map((r) => `<tr><td class="mono" style="white-space:nowrap">${fmtTime(r.ts)}</td><td><span class="badge">${esc(r.action)}</span></td><td class="mono">${esc(r.actor)}</td><td class="mono" style="font-size:11px">${esc(r.detail || '')}</td></tr>`).join('')}</table></div>${pagerHtml(aud.length, ap, 'audit')}`
      : emptyBox('shield', '暂无审计记录')}
    </section>`;
  }

  main.innerHTML = `
  ${pagehead('请求日志', '查看最近的调用、调度与审计记录 · 调用最多 80 条，调度最多 40 条，审计最多 50 条', `<button class="btn" id="log-refresh">${icon('refresh', 14)}刷新</button>`)}
  ${tabsHtml}
  <div role="tabpanel" id="log-panel" aria-labelledby="log-tab-${tab}">${body}</div>`;

  $('#log-refresh', main).addEventListener('click', () => { logCache = null; render({ swap: true }); });
  // Tab 切换：swap 重渲染（无入场闪动），同 Tab 重复点击忽略
  $$('button[data-ltab]', main).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.ltab === tab) return;
    window._logTab = b.dataset.ltab;
    render({ swap: true }).then(() => main.querySelector(`[data-ltab="${window._logTab}"]`)?.focus());
  }));
  main.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = ['logs', 'sched', 'audit'];
    const index = ids.indexOf(window._logTab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    window._logTab = ids[next];
    render({ swap: true }).then(() => main.querySelector(`[data-ltab="${ids[next]}"]`)?.focus());
  });
  if (tab === 'logs') {
    const onFilter = () => {
      f.hours = $('#lf-hours').value; f.status = $('#lf-status').value; f.model = $('#lf-model').value;
      st.logs = 1;
      render({ swap: true });
    };
    $('#lf-hours').addEventListener('change', onFilter);
    $('#lf-status').addEventListener('change', onFilter);
    $('#lf-model').addEventListener('change', onFilter);
    $('#lf-reset').addEventListener('click', () => { window._logFilter = { hours: 'all', status: 'all', model: 'all' }; st.logs = 1; render({ swap: true }); });
    bindPager(main, () => F.length, () => render({ swap: true }));
  }
  if (tab === 'sched') bindPager(main, () => sched.length, () => render({ swap: true }));
  if (tab === 'audit') bindPager(main, () => aud.length, () => render({ swap: true }));
}

async function boot() {
  if (!TOKEN) return showLogin();
  try {
    RUNTIME = await api('/api/runtime-info');
  } catch {
    // token 失效
    TOKEN = ''; localStorage.removeItem('z2a_token');
    return showLogin();
  }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const ports = `web:${RUNTIME.web_port} · gateway:${RUNTIME.gateway_port}`;
  const pl2 = $('#ports-label2');
  if (pl2) pl2.textContent = ports;
  renderNav();
  render();
  startOauthWatcher();
  // 实时刷新：看板 5s（额度/槽位监控），账号页 15s（状态机变化），其余页面不自动刷
  if (window._refreshTimer) clearInterval(window._refreshTimer);
  window._refreshTimer = setInterval(() => {
    if (document.hidden) return;
    const period = currentPage === 'dashboard' ? 5000 : currentPage === 'accounts' ? 15000 : 0;
    if (!period || Date.now() - lastRefreshAt < period) return;
    const main = $('#main');
    if (document.querySelector('.modal-bg') || main.dataset.loading === '1') return;
    if (currentPage === 'accounts' && (main.contains(document.activeElement) || main.querySelector('details[open]') || openSelect)) return;
    render({ swap: true }).catch(() => {});
  }, 5000);
}
boot();
