/**
 * Общий клиент Hub — подключается во всех трёх приложениях.
 * Хранит токен единого аккаунта: вошли в одном приложении — вошли во всех.
 */
const TOKEN_KEY = 'hub.token';

/**
 * В мобильном приложении (Capacitor) страницы лежат внутри приложения, а API — на сервере.
 * Сборка кладёт рядом config.js: window.HUB_CONFIG = { native, app, apiBase }.
 */
export const CONFIG = window.HUB_CONFIG ?? {};
export const IS_NATIVE = Boolean(CONFIG.native);
const SERVER_KEY = 'hub.server';
function savedServer() { try { return localStorage.getItem(SERVER_KEY); } catch { return null; } }
// В приложении адрес сервера можно поменять на экране входа (например, на адрес компьютера в Wi-Fi).
const API_BASE = String((IS_NATIVE && savedServer()) || CONFIG.apiBase || '').replace(/\/$/, '');
export const apiUrl = (path) => API_BASE + path;
/** Публичная ссылка (для приглашений): ведёт на сайт, даже если открыто из приложения. */
export const publicUrl = (path) => (API_BASE || location.origin) + path;

/** Адрес страницы: на сайте — /voice, в приложении Hub — файл внутри приложения. */
export function pageUrl(app) {
  if (!IS_NATIVE) return app === 'account' ? '/' : `/${app}`;
  if (app === 'account') return '/account.html';
  return `/${app}/index.html`;
}

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

export const APP_META = {
  voice: { title: 'Voice', icon: '🎧', desc: 'Голосовой чат для игроков: комнаты, эффекты голоса, баланс громкости' },
  watch: { title: 'Watch', icon: '🍿', desc: 'Совместный просмотр: YouTube и видео синхронно с друзьями + чат' },
  boost: { title: 'Boost', icon: '⚡', desc: 'Ускоритель игр: выбор лучшего узла, меньше пинг и потерь' },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function getToken() { return storage.get(TOKEN_KEY); }
export function setToken(t) { storage.set(TOKEN_KEY, t); }
export function logout() { storage.del(TOKEN_KEY); location.href = pageUrl('account'); }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(text, kind = '', action = null) {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.style.marginLeft = '10px';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.onClick(); });
    el.append(btn);
  }
  box.append(el);
  setTimeout(() => el.remove(), action ? 15000 : 4000);
}

/** Форма входа/регистрации. Возвращает Promise<account> после успешного входа. */
export function authForm(container, appName) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <div class="tabs" role="tablist">
        <button type="button" class="active" data-tab="login">Вход</button>
        <button type="button" data-tab="register">Регистрация</button>
      </div>
      <form data-form="login">
        <label for="l-login">Email или ник</label>
        <input id="l-login" name="login" autocomplete="username" required>
        <label for="l-pass">Пароль</label>
        <input id="l-pass" name="password" type="password" autocomplete="current-password" required>
        <div class="error"></div>
        <button class="btn" style="width:100%">Войти</button>
      </form>
      <form data-form="register" class="hidden">
        <label for="r-email">Email</label>
        <input id="r-email" name="email" type="email" autocomplete="email" required>
        <label for="r-user">Ник</label>
        <input id="r-user" name="username" autocomplete="nickname" required minlength="3" maxlength="20" pattern="[a-zA-Z0-9_]+">
        <label for="r-pass">Пароль (от 8 символов)</label>
        <input id="r-pass" name="password" type="password" autocomplete="new-password" required minlength="8">
        <div class="error"></div>
        <button class="btn" style="width:100%">Создать аккаунт</button>
      </form>
      <p class="muted small" style="margin-top:12px">Один аккаунт для Voice, Watch и Boost.</p>
      ${IS_NATIVE ? `<details style="margin-top:8px"><summary class="muted small">⚙ Сервер: ${esc(API_BASE)}</summary>
        <form data-server class="row" style="margin-top:8px">
          <input name="server" value="${esc(API_BASE)}" placeholder="https://hub.example.com" inputmode="url" autocomplete="off">
          <button class="btn sm ghost">OK</button>
        </form></details>` : ''}`;
    container.querySelector('[data-server]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = e.target.server.value.trim().replace(/\/$/, '');
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(v)) { toast('Адрес вида https://hub.example.com или http://192.168.1.10:3000', 'bad'); return; }
      try { localStorage.setItem(SERVER_KEY, v); } catch { /* */ }
      location.reload();
    });
    const tabs = container.querySelectorAll('[data-tab]');
    tabs.forEach((t) => t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      container.querySelectorAll('form[data-form]').forEach((f) => f.classList.toggle('hidden', f.dataset.form !== t.dataset.tab));
    }));
    container.querySelectorAll('form[data-form]').forEach((form) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = form.dataset.form;
      const body = Object.fromEntries(new FormData(form));
      body.app = appName;
      const errEl = form.querySelector('.error');
      const btn = form.querySelector('button');
      errEl.textContent = '';
      btn.disabled = true;
      try {
        const data = await api(`/api/auth/${kind}`, { method: 'POST', body });
        setToken(data.token);
        resolve(data);
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }));
  });
}

/**
 * Гарантирует, что пользователь вошёл. Если токен уже есть (вход был в любом
 * из приложений) — просто привязывает это приложение к аккаунту, без регистрации.
 */
export async function ensureLogin(appName) {
  if (getToken()) {
    try {
      return await api(`/api/apps/${appName}/link`, { method: 'POST' });
    } catch (e) {
      if (e.status !== 401) throw e;
      storage.del(TOKEN_KEY);
    }
  }
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const meta = APP_META[appName];
  overlay.innerHTML = `<div class="card"><h2>${meta.icon} ${meta.title}</h2><p class="muted">Войдите в аккаунт Hub, чтобы продолжить.</p><div class="auth"></div></div>`;
  document.body.append(overlay);
  const account = await authForm(overlay.querySelector('.auth'), appName);
  overlay.remove();
  return account;
}

export function renderTopbar(appName, account) {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const premium = account?.plan?.id === 'premium';
  bar.innerHTML = `
    <a class="brand" href="${pageUrl('account')}"><span class="dot"></span>Hub</a>
    <nav class="appnav">
      ${Object.entries(APP_META).map(([k, m]) => `<a href="${pageUrl(k)}" class="${k === appName ? 'active' : ''}">${m.icon} ${m.title}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    ${account ? `<div class="userchip">
      <span class="badge ${premium ? 'premium' : ''}">${premium ? 'Premium' : 'Free'}</span>
      <a href="${pageUrl('account')}" style="color:inherit;text-decoration:none" data-testid="username">${esc(account.user.username)}</a>
    </div>` : ''}`;
  document.body.prepend(bar);
  renderTabbar(appName);
  if (appName) showIosInstallHint(); // на главной вместо всплывающей подсказки — карточка

  return bar;
}

/** Нижнее меню на телефоне — как в обычных приложениях. */
function renderTabbar(appName) {
  if (document.querySelector('.tabbar')) return;
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  nav.setAttribute('aria-label', 'Разделы');
  const tabs = [['account', '🏠', 'Hub'], ...Object.entries(APP_META).map(([k, m]) => [k, m.icon, m.title])];
  nav.innerHTML = tabs.map(([k, icon, title]) => `
    <a href="${pageUrl(k)}" class="${(appName ?? 'account') === k ? 'active' : ''}" data-tab-link="${k}">
      <span class="tab-icon">${icon}</span><span>${title}</span>
    </a>`).join('');
  document.body.append(nav);
  document.body.classList.add('has-tabbar');
}

/** WebSocket-соединение с автопереподключением. */
export class Realtime {
  constructor() {
    this.handlers = new Map();
    this.queue = [];
    this.ready = false;
    this.closedByUser = false;
    this.retry = 0;
    this.#connect();
  }

  #connect() {
    const base = API_BASE || `${location.protocol}//${location.host}`;
    this.ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    this.ws.addEventListener('open', () => {
      this.retry = 0;
      this.ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ready') {
        this.ready = true;
        this.selfId = msg.selfId;
        for (const m of this.queue.splice(0)) this.ws.send(JSON.stringify(m));
      }
      for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
      for (const fn of this.handlers.get('*') ?? []) fn(msg);
    });
    this.ws.addEventListener('close', (ev) => {
      this.ready = false;
      for (const fn of this.handlers.get('disconnect') ?? []) fn(ev);
      if (this.closedByUser) return;
      if (ev.code === 4001) {
        // Пароль сменили на другом устройстве или аккаунт удалён — выходим.
        if (ev.reason === 'password-changed') {
          // Если пароль сменили на этом устройстве, здесь уже сохранён новый токен: просто переподключаемся.
          setTimeout(async () => {
            try { await api('/api/me'); this.#connect(); } catch { storage.del(TOKEN_KEY); location.href = pageUrl('account'); }
          }, 1500);
        } else if (['account-deleted', 'unauthorized'].includes(ev.reason)) {
          storage.del(TOKEN_KEY);
          location.href = pageUrl('account');
        }
        return;
      }
      const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
      setTimeout(() => this.#connect(), delay);
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  send(msg) {
    if (this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  close() { this.closedByUser = true; this.ws.close(); }
}

export function chatWidget(container, onSend) {
  container.classList.add('chat');
  container.innerHTML = `
    <div class="messages" data-testid="chat-messages" aria-live="polite"></div>
    <form><input name="text" placeholder="Сообщение…" maxlength="500" autocomplete="off"><button class="btn">➤</button></form>`;
  const list = container.querySelector('.messages');
  const form = container.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = form.text.value.trim();
    if (text) onSend(text);
    form.text.value = '';
  });
  return {
    add(from, text) {
      const el = document.createElement('div');
      el.className = 'msg';
      el.innerHTML = `<b>${esc(from)}</b>${esc(text)}`;
      list.append(el);
      list.scrollTop = list.scrollHeight;
    },
    system(text) {
      const el = document.createElement('div');
      el.className = 'msg system';
      el.textContent = text;
      list.append(el);
      list.scrollTop = list.scrollHeight;
    },
  };
}

export function initials(name) { return String(name || '?').slice(0, 2).toUpperCase(); }

export function colorFor(str) {
  let h = 2166136261;
  for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return `hsl(${(h >>> 0) % 360} 65% 50%)`;
}

// ---------- Общее соединение и друзья ----------

let shared = null;
/** Одно WebSocket-соединение на страницу: комнаты, статусы друзей, приглашения. */
export function getRealtime() {
  shared ??= new Realtime();
  return shared;
}

export function roomLink(app, room) {
  return `${pageUrl(app)}#room=${encodeURIComponent(room)}&join=1`;
}

const APP_LABEL = { voice: '🎧 Voice', watch: '🍿 Watch' };

/**
 * Панель друзей в верхней строке каждого приложения.
 * inviteTarget() возвращает 'voice' | 'watch' | null — куда можно позвать друга прямо сейчас.
 */
let friendsInstance = null;
export function mountFriends(topbar, { inviteTarget = () => null } = {}) {
  // Повторный вызов (перерисовка страницы) переносит ту же панель в новую верхнюю строку.
  if (friendsInstance) { topbar.querySelector('.userchip')?.before(friendsInstance.btn); return friendsInstance; }
  const rt = getRealtime();
  const btn = document.createElement('button');
  btn.className = 'btn ghost sm';
  btn.dataset.testid = 'friends-btn';
  btn.innerHTML = '👥 <span data-count></span>';
  topbar.querySelector('.userchip')?.before(btn);

  const panel = document.createElement('aside');
  panel.className = 'drawer hidden';
  panel.dataset.testid = 'friends-panel';
  panel.innerHTML = `
    <div class="row"><h2 class="grow" style="margin:0">Друзья</h2><button class="btn ghost sm" data-close aria-label="Закрыть">✕</button></div>
    <form class="row" data-add style="margin:12px 0">
      <input name="username" placeholder="Ник друга" autocomplete="off" required>
      <button class="btn sm">Добавить</button>
    </form>
    <div data-body></div>`;
  document.body.append(panel);

  let data = { friends: [], incoming: [], outgoing: [] };

  function render() {
    const online = data.friends.filter((f) => f.online).length;
    btn.querySelector('[data-count]').textContent = data.incoming.length ? `${online} · 🔔${data.incoming.length}` : String(online);
    const target = inviteTarget();
    const body = panel.querySelector('[data-body]');
    const section = (title, items) => (items.length ? `<h3 style="margin:16px 0 8px">${title}</h3><div class="list">${items.join('')}</div>` : '');
    body.innerHTML = [
      section('Заявки в друзья', data.incoming.map((f) => `
        <div class="list-item"><b class="grow">${esc(f.username)}</b>
          <button class="btn sm" data-accept="${f.id}">Принять</button>
          <button class="btn ghost sm" data-remove="${f.id}" aria-label="Отклонить">✕</button></div>`)),
      section(`В друзьях · ${online} в сети`, data.friends.map((f) => {
        const act = f.activity;
        const where = !f.online ? '<span class="muted small">не в сети</span>'
          : act ? `<span class="small" style="color:var(--ok)">${APP_LABEL[act.app] ?? act.app}${act.room ? `: ${esc(act.room)}` : ' (приватная комната)'}</span>`
            : '<span class="small" style="color:var(--ok)">в сети</span>';
        return `<div class="list-item" data-friend="${esc(f.username)}">
          <span class="presence ${f.online ? 'on' : ''}"></span>
          <div class="grow" style="min-width:0"><b>${esc(f.username)}</b><div>${where}</div></div>
          ${f.online && target ? `<button class="btn sm" data-invite="${f.id}">Позвать</button>` : ''}
          ${f.online && act?.room && !target ? `<button class="btn ghost sm" data-go="${esc(roomLink(act.app, act.room))}">Зайти</button>` : ''}
          <button class="btn ghost sm" data-remove="${f.id}" title="Удалить из друзей" aria-label="Удалить">✕</button>
        </div>`;
      })),
      section('Отправленные заявки', data.outgoing.map((f) => `
        <div class="list-item"><span class="grow">${esc(f.username)} <span class="muted small">ждёт ответа</span></span>
          <button class="btn ghost sm" data-remove="${f.id}">Отменить</button></div>`)),
    ].join('') || '<p class="muted">Добавьте друзей по нику: вы будете видеть, кто в сети и где сейчас играет или смотрит, и звать их в свою комнату.</p>';
  }

  async function refresh() {
    try { data = await api('/api/friends'); render(); } catch { /* офлайн */ }
  }

  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.close !== undefined) panel.classList.add('hidden');
      else if (t.dataset.go) goTo(t.dataset.go);
      else if (t.dataset.accept) { data = await api(`/api/friends/${t.dataset.accept}/accept`, { method: 'POST' }); render(); }
      else if (t.dataset.remove) {
        if (!confirm('Удалить?')) return;
        data = await api(`/api/friends/${t.dataset.remove}`, { method: 'DELETE' }); render();
      } else if (t.dataset.invite) {
        rt.send({ type: 'invite', app: inviteTarget(), to: Number(t.dataset.invite) });
      }
    } catch (err) { toast(err.message, 'bad'); }
  });
  panel.querySelector('[data-add]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      data = await api('/api/friends/request', { method: 'POST', body: { username: e.target.username.value.trim() } });
      e.target.reset();
      render();
      toast('Заявка отправлена');
    } catch (err) { toast(err.message, 'bad'); }
  });
  btn.addEventListener('click', () => { panel.classList.toggle('hidden'); if (!panel.classList.contains('hidden')) refresh(); });

  rt.on('presence', (m) => {
    const f = data.friends.find((x) => x.id === m.userId);
    if (f) { Object.assign(f, { online: m.online, activity: m.activity }); render(); } else refresh();
  });
  rt.on('friends:changed', (m) => {
    if (m.request) toast(`${m.request} хочет добавить вас в друзья`, '', { label: 'Открыть', onClick: () => { panel.classList.remove('hidden'); } });
    if (m.accepted) toast(`${m.accepted} теперь ваш друг`);
    refresh();
  });
  rt.on('invite', (m) => {
    toast(`${m.from.username} зовёт вас в ${APP_LABEL[m.app]}${m.private ? '' : `: ${m.room}`}`, '', {
      label: 'Зайти', onClick: () => goTo(roomLink(m.app, m.room)),
    });
  });
  rt.on('invite:sent', () => toast('Приглашение отправлено'));
  rt.on('ready', refresh);

  friendsInstance = { btn, refresh, render, open: () => { panel.classList.remove('hidden'); refresh(); } };
  return friendsInstance;
}

/** Переход по ссылке; если это та же страница с другим #, перезагружаем её (для автовхода в комнату). */
export function goTo(url) {
  const sameDoc = url.startsWith('/') && url.split('#')[0] === location.pathname;
  location.href = url;
  if (sameDoc) location.reload();
}

// ---------- Приложение Hub для Android: ссылки-приглашения и кнопка «назад» ----------

/** Разбор ссылок вида hubapp://room?app=voice&name=squad (не полагаемся на URL() для нестандартных схем). */
export function parseDeepLink(url) {
  const m = /^hubapp:\/\/([^/?#]+)\/?(?:\?([^#]*))?/.exec(String(url));
  if (!m) return null;
  return { action: m[1], params: new URLSearchParams(m[2] ?? '') };
}

export function handleDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link) return;
  const app = link.params.get('app');
  if (link.action === 'room' && APP_META[app]) goTo(roomLink(app, link.params.get('name') ?? ''));
  else if (link.action === 'open') goTo(APP_META[app] ? pageUrl(app) : pageUrl('account'));
}

if (IS_NATIVE) {
  const App = window.Capacitor?.Plugins?.App;
  App?.addListener('appUrlOpen', ({ url }) => handleDeepLink(url));
  App?.getLaunchUrl?.().then((r) => {
    // Обрабатываем ссылку запуска один раз за запуск приложения.
    if (r?.url && sessionStorage.getItem('hub.launch') !== r.url) { sessionStorage.setItem('hub.launch', r.url); handleDeepLink(r.url); }
  }).catch(() => {});
  App?.addListener('backButton', ({ canGoBack }) => {
    const drawer = document.querySelector('.drawer:not(.hidden)');
    if (drawer) drawer.classList.add('hidden');
    else if (canGoBack) history.back();
    else App.minimizeApp?.();
  });
}

// ---------- Установка на экран «Домой» (PWA) ----------

export const IS_STANDALONE = (() => {
  try { return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch { return false; }
})();
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

if (!IS_NATIVE && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  document.dispatchEvent(new CustomEvent('hub:installable'));
});

/** Можно ли предложить установку и как: 'prompt' (Android/ПК Chrome), 'ios' (инструкция), null. */
export function installMode() {
  if (IS_NATIVE || IS_STANDALONE) return null;
  if (deferredInstall) return 'prompt';
  if (IS_IOS) return 'ios';
  return null;
}

export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  return outcome === 'accepted';
}

/** Значок «Поделиться» как в Safari: квадрат со стрелкой вверх. */
export const SHARE_ICON = '<svg class="share-ico" viewBox="0 0 24 24" width="16" height="16" aria-label="Поделиться" role="img"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Подсказка на iPhone: как установить Hub на экран «Домой». Показывается, пока её не закроют. */
export function showIosInstallHint() {
  if (installMode() !== 'ios' || storage.get('hub.iosHintClosed') || document.querySelector('.install-hint')) return;
  const el = document.createElement('div');
  el.className = 'install-hint';
  el.dataset.testid = 'ios-install-hint';
  el.innerHTML = `
    <img src="/icons/hub-180.png" alt="" width="44" height="44">
    <div class="grow"><b>Установите Hub на iPhone</b>
      <div class="small">Нажмите ${SHARE_ICON} «Поделиться», затем «На экран „Домой“». Один вход — Voice, Watch и Boost.</div></div>
    <button class="btn ghost sm" aria-label="Закрыть">✕</button>`;
  el.querySelector('button').addEventListener('click', () => {
    storage.set('hub.iosHintClosed', '1');
    el.remove();
    document.body.classList.remove('has-hint');
  });
  document.body.append(el);
  document.body.classList.add('has-hint'); // место внизу, чтобы подсказка не закрывала кнопки
}
