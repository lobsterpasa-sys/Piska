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
const API_BASE = String(CONFIG.apiBase ?? '').replace(/\/$/, '');
export const apiUrl = (path) => API_BASE + path;
/** Публичная ссылка (для приглашений): ведёт на сайт, даже если открыто из приложения. */
export const publicUrl = (path) => (API_BASE || location.origin) + path;
const schemeOf = (app) => `hub${app}`;

/** Адрес страницы: на сайте — /voice, в приложении — свой файл или другое приложение Hub. */
export function pageUrl(app) {
  if (!IS_NATIVE) return app === 'account' ? '/' : `/${app}`;
  if (app === 'account') return '/account.html';
  if (app === CONFIG.app) return `/${app}/index.html`;
  return `${schemeOf(app)}://open`;
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
      <p class="muted small" style="margin-top:12px">Один аккаунт для Voice, Watch и Boost.</p>`;
    const tabs = container.querySelectorAll('[data-tab]');
    tabs.forEach((t) => t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      container.querySelectorAll('form').forEach((f) => f.classList.toggle('hidden', f.dataset.form !== t.dataset.tab));
    }));
    container.querySelectorAll('form').forEach((form) => form.addEventListener('submit', async (e) => {
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
  overlay.innerHTML = `<div class="card"><h2>${meta.icon} ${meta.title}</h2><p class="muted">Войдите в аккаунт Hub, чтобы продолжить.</p><div class="sso"></div><div class="auth"></div></div>`;
  document.body.append(overlay);
  if (IS_NATIVE) nativeSsoButtons(overlay.querySelector('.sso'), appName);
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
  return bar;
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
  if (IS_NATIVE && app !== CONFIG.app) return `${schemeOf(app)}://room?name=${encodeURIComponent(room)}`;
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
  if (IS_NATIVE && /^hub\w+:\/\//.test(url)) { openExternal(url); return; }
  location.href = url;
  if (sameDoc) location.reload();
}

// ---------- Мобильное приложение: вход через другое приложение Hub и глубокие ссылки ----------

const plugins = () => window.Capacitor?.Plugins ?? {};

function openExternal(url) {
  const launcher = plugins().AppLauncher;
  if (launcher) return launcher.openUrl({ url }).catch(() => toast('Приложение не установлено', 'bad'));
  location.href = url;
}

/** Кнопки «Войти через Hub Voice/Watch/Boost» — только для установленных приложений. */
async function nativeSsoButtons(box, appName) {
  const launcher = plugins().AppLauncher;
  if (!launcher) return;
  for (const [k, m] of Object.entries(APP_META)) {
    if (k === appName) continue;
    let installed = false;
    try { installed = (await launcher.canOpenUrl({ url: `${schemeOf(k)}://open` })).value; } catch { /* нет доступа */ }
    if (!installed) continue;
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.style.cssText = 'width:100%;margin-bottom:8px';
    b.textContent = `${m.icon} Войти через Hub ${m.title}`;
    b.addEventListener('click', () => openExternal(`${schemeOf(k)}://sso?for=${appName}`));
    box.append(b);
  }
  if (box.children.length) box.insertAdjacentHTML('beforeend', '<p class="muted small" style="text-align:center">или</p>');
}

/** Разбор ссылок вида hubvoice://sso?for=watch (не полагаемся на URL() для нестандартных схем). */
export function parseDeepLink(url) {
  const m = /^hub(\w+):\/\/([^/?#]+)\/?(?:\?([^#]*))?/.exec(String(url));
  if (!m) return null;
  return { app: m[1], action: m[2], params: new URLSearchParams(m[3] ?? '') };
}

export async function handleDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link || link.app !== CONFIG.app) return;
  const { action, params } = link;
  if (action === 'open') { if (location.pathname !== pageUrl(CONFIG.app)) location.href = pageUrl(CONFIG.app); return; }
  if (action === 'room') { goTo(roomLink(CONFIG.app, params.get('name') ?? '')); return; }
  if (action === 'sso') {
    // Другое приложение Hub просит войти в этот же аккаунт.
    const target = params.get('for');
    if (!APP_META[target] || target === CONFIG.app) return;
    if (!getToken()) { toast('Сначала войдите в аккаунт здесь', 'bad'); return; }
    try {
      const me = await api('/api/me');
      if (!confirm(`Войти в Hub ${APP_META[target].title} как ${me.user.username}?`)) return;
      const { code } = await api('/api/auth/sso/code', { method: 'POST', body: { app: target } });
      openExternal(`${schemeOf(target)}://sso-callback?code=${encodeURIComponent(code)}`);
    } catch (e) { toast(e.message, 'bad'); }
    return;
  }
  if (action === 'sso-callback') {
    try {
      const data = await api('/api/auth/sso/exchange', { method: 'POST', body: { code: params.get('code'), app: CONFIG.app } });
      setToken(data.token);
      location.href = pageUrl(CONFIG.app);
    } catch (e) { toast(e.message, 'bad'); }
  }
}

if (IS_NATIVE) {
  const { App } = plugins();
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
