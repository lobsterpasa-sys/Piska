/**
 * Общий клиент Hub — подключается во всех трёх приложениях.
 * Хранит токен единого аккаунта: вошли в одном приложении — вошли во всех.
 */
const TOKEN_KEY = 'hub.token';

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
export function logout() { storage.del(TOKEN_KEY); location.href = '/'; }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(text, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.append(el);
  setTimeout(() => el.remove(), 4000);
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
    <a class="brand" href="/"><span class="dot"></span>Hub</a>
    <nav class="appnav">
      ${Object.entries(APP_META).map(([k, m]) => `<a href="/${k}" class="${k === appName ? 'active' : ''}">${m.icon} ${m.title}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    ${account ? `<div class="userchip">
      <span class="badge ${premium ? 'premium' : ''}">${premium ? 'Premium' : 'Free'}</span>
      <a href="/" style="color:inherit;text-decoration:none" data-testid="username">${esc(account.user.username)}</a>
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      if (this.closedByUser || ev.code === 4001) return;
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
