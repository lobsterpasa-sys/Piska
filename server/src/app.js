import express from 'express';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, validateRegistration, createRateLimiter } from './auth.js';
import { PLANS, planFor } from './plans.js';
import { attachRealtime } from './realtime.js';
import { GAMES, loadNodes } from './boost/catalog.js';
import { UdpRelay, splitHostPort, isPrivateAddress } from './boost/relay.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const APPS = ['voice', 'watch', 'boost'];
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 дней
const BOOST_TTL = 60 * 60 * 6; // 6 часов на игровую сессию

/**
 * Создаёт весь бэкенд Hub. Возвращает { server, start, stop, ... }.
 * Опции удобны для тестов: in-memory база, случайный порт, встроенный relay-узел.
 */
export function createHub(options = {}) {
  const env = options.env ?? process.env;
  const secret = options.secret ?? env.HUB_SECRET ?? randomBytes(32).toString('hex');
  const db = options.db ?? openDb(options.dbFile ?? env.DB_FILE ?? ':memory:');
  const paymentsMode = options.paymentsMode ?? env.PAYMENTS_MODE ?? 'test';
  const allowPrivateTargets = options.allowPrivateTargets ?? env.ALLOW_PRIVATE_TARGETS === '1';
  const log = options.log ?? ((...a) => console.log('[hub]', ...a));
  let nodes = options.nodes ?? loadNodes(env);
  const embeddedRelay = options.embeddedRelay ?? !env.BOOST_NODES;
  let relay = null;

  const q = {
    insertUser: db.prepare('INSERT INTO users (email, username, password_hash, created_at) VALUES (?, ?, ?, ?)'),
    userByLogin: db.prepare('SELECT * FROM users WHERE email = ? OR username = ?'),
    userById: db.prepare('SELECT id, email, username, created_at, token_version FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT id, username FROM users WHERE username = ?'),
    passwordHash: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    friendRow: db.prepare('SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'),
    insertFriend: db.prepare("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)"),
    acceptFriend: db.prepare("UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"),
    deleteFriend: db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'),
    friendsOf: db.prepare(`SELECT u.id, u.username, f.status, f.requester_id, f.created_at FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY u.username`),
    acceptedIds: db.prepare(`SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
      FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`),
    friendCount: db.prepare('SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ? OR addressee_id = ?'),
    sub: db.prepare('SELECT * FROM subscriptions WHERE user_id = ?'),
    upsertSub: db.prepare(`INSERT INTO subscriptions (user_id, plan, expires_at, auto_renew, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, expires_at = excluded.expires_at, auto_renew = excluded.auto_renew, updated_at = excluded.updated_at`),
    setAutoRenew: db.prepare('UPDATE subscriptions SET auto_renew = ?, updated_at = ? WHERE user_id = ?'),
    insertPayment: db.prepare('INSERT INTO payments (user_id, plan, months, amount, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    linkApp: db.prepare(`INSERT INTO app_links (user_id, app, first_used_at, last_used_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, app) DO UPDATE SET last_used_at = excluded.last_used_at`),
    apps: db.prepare('SELECT app, first_used_at, last_used_at FROM app_links WHERE user_id = ? ORDER BY first_used_at'),
  };

  const publicUser = (u) => ({ id: u.id, email: u.email, username: u.username, createdAt: u.created_at });
  const linkApp = (userId, app) => { if (APPS.includes(app)) q.linkApp.run(userId, app, Date.now(), Date.now()); };
  const sessionToken = (user) => signToken({ sub: user.id, kind: 'session', v: user.token_version ?? 0 }, secret, TOKEN_TTL);
  const friendIdsOf = (userId) => q.acceptedIds.all(userId, userId, userId).map((r) => r.id);
  const areFriends = (a, b) => {
    const row = q.friendRow.get(a, b, b, a);
    return Boolean(row && row.status === 'accepted');
  };

  function authenticate(token) {
    const payload = verifyToken(token, secret);
    if (!payload || payload.kind !== 'session') return null;
    const user = q.userById.get(payload.sub);
    // После смены пароля версия растёт и старые токены на других устройствах перестают действовать.
    if (!user || (payload.v ?? 0) !== user.token_version) return null;
    return { user: publicUser(user), plan: planFor(q.sub.get(user.id)) };
  }

  function account(userId) {
    const user = q.userById.get(userId);
    const sub = q.sub.get(userId);
    const plan = planFor(sub);
    return {
      user: publicUser(user),
      plan,
      subscription: plan.id === 'premium'
        ? { plan: 'premium', expiresAt: sub.expires_at, autoRenew: Boolean(sub.auto_renew) }
        : { plan: 'free', expiresAt: null, autoRenew: false },
      apps: q.apps.all(userId).map((a) => ({ app: a.app, firstUsedAt: a.first_used_at, lastUsedAt: a.last_used_at })),
    };
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === '1');
  app.use(express.json({ limit: '32kb' }));

  // Мобильные приложения (Capacitor) открывают страницы с origin https://localhost и ходят в API кросс-доменно.
  const corsOrigins = new Set(['https://localhost', 'capacitor://localhost',
    ...(env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)]);
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && corsOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'microphone=(self), camera=()',
    });
    next();
  });

  const authLimiter = createRateLimiter({ windowMs: 60_000, max: options.authRateLimit ?? 20 });
  const requireAuth = (req, res, next) => {
    const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const auth = authenticate(token);
    if (!auth) return res.status(401).json({ error: 'Требуется вход' });
    req.user = auth.user;
    req.plan = auth.plan;
    next();
  };

  app.get('/healthz', (req, res) => res.json({ ok: true, time: Date.now() }));

  // ---------- Единый аккаунт ----------
  app.post('/api/auth/register', (req, res) => {
    if (authLimiter(`reg:${req.ip}`)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
    const err = validateRegistration(req.body);
    if (err) return res.status(400).json({ error: err });
    const { email, username, password } = req.body;
    try {
      const { lastInsertRowid } = q.insertUser.run(email.trim(), username.trim(), hashPassword(password), Date.now());
      const userId = Number(lastInsertRowid);
      if (APPS.includes(req.body.app)) linkApp(userId, req.body.app);
      res.status(201).json({ token: sessionToken(q.userById.get(userId)), ...account(userId) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Такой email или ник уже занят' });
      throw e;
    }
  });

  app.post('/api/auth/login', (req, res) => {
    if (authLimiter(`login:${req.ip}`)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const user = login && q.userByLogin.get(login, login);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    if (APPS.includes(req.body.app)) linkApp(user.id, req.body.app);
    res.json({ token: sessionToken(user), ...account(user.id) });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json(account(req.user.id)));

  // ---------- Вход через другое приложение Hub (без повторного ввода пароля) ----------
  // Приложение, где пользователь уже вошёл, выдаёт одноразовый код на 60 секунд для конкретного
  // приложения; то обменивает код на свой токен. Сам токен между приложениями не передаётся.
  const ssoCodes = new Map(); // code -> { userId, app, exp }
  const SSO_TTL = 60_000;
  app.post('/api/auth/sso/code', requireAuth, (req, res) => {
    const target = req.body?.app;
    if (!APPS.includes(target)) return res.status(400).json({ error: 'Неизвестное приложение' });
    const now = Date.now();
    for (const [c, v] of ssoCodes) if (v.exp < now) ssoCodes.delete(c);
    if (ssoCodes.size > 10_000) return res.status(503).json({ error: 'Попробуйте позже' });
    const code = randomBytes(24).toString('base64url');
    ssoCodes.set(code, { userId: req.user.id, app: target, exp: now + SSO_TTL });
    res.json({ code, expiresIn: SSO_TTL / 1000 });
  });

  app.post('/api/auth/sso/exchange', (req, res) => {
    if (authLimiter(`sso:${req.ip}`)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
    const code = String(req.body?.code ?? '');
    const entry = ssoCodes.get(code);
    ssoCodes.delete(code); // одноразовый, даже если проверка ниже не прошла
    if (!entry || entry.exp < Date.now() || entry.app !== req.body?.app) return res.status(401).json({ error: 'Код недействителен или устарел' });
    const user = q.userById.get(entry.userId);
    if (!user) return res.status(401).json({ error: 'Аккаунт не найден' });
    linkApp(user.id, entry.app);
    res.json({ token: sessionToken(user), ...account(user.id) });
  });

  // Приложение отмечает, что пользователь вошёл в него этим же аккаунтом.
  app.post('/api/apps/:app/link', requireAuth, (req, res) => {
    if (!APPS.includes(req.params.app)) return res.status(404).json({ error: 'Неизвестное приложение' });
    linkApp(req.user.id, req.params.app);
    res.json(account(req.user.id));
  });

  // ---------- Настройки аккаунта ----------
  app.post('/api/account/password', requireAuth, (req, res) => {
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (authLimiter(`pw:${req.user.id}`)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
    if (!verifyPassword(current, q.passwordHash.get(req.user.id).password_hash)) return res.status(403).json({ error: 'Текущий пароль неверный' });
    if (next.length < 8 || next.length > 128) return res.status(400).json({ error: 'Пароль: от 8 до 128 символов' });
    q.setPassword.run(hashPassword(next), req.user.id);
    realtime.disconnectUser(req.user.id, 'password-changed');
    // Это устройство остаётся в аккаунте с новым токеном, остальные выходят.
    res.json({ token: sessionToken(q.userById.get(req.user.id)), ...account(req.user.id) });
  });

  // Удаление аккаунта (обязательно для публикации в App Store и Google Play).
  app.delete('/api/account', requireAuth, (req, res) => {
    if (!verifyPassword(String(req.body?.password ?? ''), q.passwordHash.get(req.user.id).password_hash)) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    const friends = friendIdsOf(req.user.id);
    q.deleteUser.run(req.user.id);
    realtime.disconnectUser(req.user.id, 'account-deleted');
    for (const fid of friends) realtime.notifyUser(fid, { type: 'friends:changed' });
    res.status(204).end();
  });

  // Настройки для клиентов: STUN/TURN-серверы для голосового чата.
  app.get('/api/config', (req, res) => {
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (env.ICE_SERVERS) { try { iceServers = JSON.parse(env.ICE_SERVERS); } catch { /* оставляем STUN по умолчанию */ } }
    res.json({ iceServers });
  });

  // ---------- Друзья (общие для всех трёх приложений) ----------
  const MAX_FRIENDS = 500;
  function friendsPayload(userId) {
    const rows = q.friendsOf.all(userId, userId, userId);
    const friends = [];
    const incoming = [];
    const outgoing = [];
    for (const r of rows) {
      const base = { id: r.id, username: r.username, since: r.created_at };
      if (r.status === 'accepted') friends.push({ ...base, online: realtime.isOnline(r.id), activity: realtime.activityOf(r.id) });
      else if (r.requester_id === userId) outgoing.push(base);
      else incoming.push(base);
    }
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
    return { friends, incoming, outgoing };
  }

  app.get('/api/friends', requireAuth, (req, res) => res.json(friendsPayload(req.user.id)));

  app.post('/api/friends/request', requireAuth, (req, res) => {
    const target = q.userByName.get(String(req.body?.username ?? '').trim());
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя добавить самого себя' });
    const existing = q.friendRow.get(req.user.id, target.id, target.id, req.user.id);
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'Вы уже друзья' });
    if (existing && existing.requester_id === req.user.id) return res.status(409).json({ error: 'Заявка уже отправлена' });
    if (existing) {
      // Встречная заявка: просто принимаем её.
      q.acceptFriend.run(target.id, req.user.id);
      realtime.notifyUser(target.id, { type: 'friends:changed', accepted: req.user.username });
      realtime.announcePresence(req.user.id);
      realtime.announcePresence(target.id);
      return res.json(friendsPayload(req.user.id));
    }
    if (q.friendCount.get(req.user.id, req.user.id).n >= MAX_FRIENDS) return res.status(400).json({ error: 'Слишком много друзей и заявок' });
    q.insertFriend.run(req.user.id, target.id, Date.now());
    realtime.notifyUser(target.id, { type: 'friends:changed', request: req.user.username });
    res.status(201).json(friendsPayload(req.user.id));
  });

  app.post('/api/friends/:id/accept', requireAuth, (req, res) => {
    const otherId = Number(req.params.id);
    const { changes } = q.acceptFriend.run(otherId, req.user.id);
    if (!changes) return res.status(404).json({ error: 'Заявка не найдена' });
    realtime.notifyUser(otherId, { type: 'friends:changed', accepted: req.user.username });
    realtime.announcePresence(req.user.id);
    realtime.announcePresence(otherId);
    res.json(friendsPayload(req.user.id));
  });

  // Удалить из друзей, отклонить входящую или отменить исходящую заявку.
  app.delete('/api/friends/:id', requireAuth, (req, res) => {
    const otherId = Number(req.params.id);
    const { changes } = q.deleteFriend.run(req.user.id, otherId, otherId, req.user.id);
    if (!changes) return res.status(404).json({ error: 'Не найдено' });
    realtime.notifyUser(otherId, { type: 'friends:changed' });
    res.json(friendsPayload(req.user.id));
  });

  // ---------- Подписки ----------
  app.get('/api/plans', (req, res) => res.json({ plans: Object.values(PLANS), paymentsMode }));

  app.post('/api/subscription/checkout', requireAuth, (req, res) => {
    const plan = PLANS[req.body?.plan];
    const months = Number(req.body?.months ?? 1);
    if (!plan || plan.id === 'free') return res.status(400).json({ error: 'Неизвестный тариф' });
    if (![1, 3, 12].includes(months)) return res.status(400).json({ error: 'Период: 1, 3 или 12 месяцев' });
    if (paymentsMode !== 'test') {
      // Здесь подключается реальная оплата: App Store / Google Play Billing / Stripe / ЮKassa.
      // Подписка активируется только из вебхука платёжной системы после подтверждения оплаты.
      return res.status(501).json({ error: 'Реальная оплата ещё не подключена' });
    }
    const now = Date.now();
    const current = q.sub.get(req.user.id);
    const base = current?.plan === 'premium' && current.expires_at > now ? current.expires_at : now;
    const expiresAt = base + months * 30 * 24 * 3600 * 1000;
    const discount = months === 12 ? 0.6 : months === 3 ? 0.85 : 1;
    q.upsertSub.run(req.user.id, plan.id, expiresAt, 1, now);
    q.insertPayment.run(req.user.id, plan.id, months, Math.round(plan.priceMonthly * months * discount * 100) / 100, 'test', now);
    res.json(account(req.user.id));
  });

  app.post('/api/subscription/cancel', requireAuth, (req, res) => {
    // Отмена автопродления: Premium работает до конца оплаченного периода.
    q.setAutoRenew.run(0, Date.now(), req.user.id);
    res.json(account(req.user.id));
  });

  // ---------- Комнаты ----------
  let realtime;
  app.get('/api/rooms/:kind', requireAuth, (req, res) => {
    if (!['voice', 'watch'].includes(req.params.kind)) return res.status(404).json({ error: 'Нет такого типа комнат' });
    res.json({ rooms: realtime.listRooms(req.params.kind) });
  });

  // ---------- Ускоритель ----------
  app.get('/api/boost/games', requireAuth, (req, res) => res.json({ games: GAMES }));

  app.get('/api/boost/nodes', requireAuth, (req, res) => {
    res.json({
      nodes: nodes.map((n) => ({ ...n, locked: n.premium && !req.plan.limits.boostPremiumNodes })),
      multipath: req.plan.limits.boostMultipath,
    });
  });

  // Пустой ответ для замера задержки (клиент меряет время запроса).
  app.get('/api/boost/probe', (req, res) => res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).status(204).end());

  app.post('/api/boost/session', requireAuth, (req, res) => {
    const game = GAMES.find((g) => g.id === req.body?.gameId);
    const node = nodes.find((n) => n.id === req.body?.nodeId);
    if (!game) return res.status(400).json({ error: 'Выберите игру' });
    if (!node) return res.status(400).json({ error: 'Выберите узел' });
    if (node.premium && !req.plan.limits.boostPremiumNodes) return res.status(403).json({ error: 'Этот узел доступен в Premium' });

    let target = null;
    if (req.body.target) {
      let host;
      try { [host] = splitHostPort(req.body.target); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!allowPrivateTargets && isPrivateAddress(host)) return res.status(400).json({ error: 'Внутренние адреса запрещены' });
      target = String(req.body.target);
    }
    linkApp(req.user.id, 'boost');
    // Токен без target — для мобильного приложения (режим мультиплекса), с target — для одного сервера.
    const sessionToken = signToken({ sub: req.user.id, kind: 'boost', game: game.id, node: node.id, ...(target ? { target } : {}) }, secret, BOOST_TTL);
    // Встроенный узел работает на том же сервере: телефону нужен его внешний адрес, а не 127.0.0.1.
    const host = node.id === 'local' && embeddedRelay ? (env.RELAY_PUBLIC_HOST ?? req.hostname) : node.host;
    res.json({
      game, node: { id: node.id, name: node.name, region: node.region, host, udpPort: node.udpPort },
      sessionToken, expiresIn: BOOST_TTL, multipath: req.plan.limits.boostMultipath,
    });
  });

  // ---------- Статика (веб-версии приложений) ----------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  for (const name of APPS) app.get(`/${name}`, (req, res) => res.sendFile(join(PUBLIC_DIR, name, 'index.html')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
    log('error', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  const server = http.createServer(app);
  realtime = attachRealtime(server, { authenticate, onAppUsed: linkApp, friendIdsOf, areFriends, log: options.quiet ? () => {} : log });

  return {
    app, server, db, secret,
    get nodes() { return nodes; },
    get relay() { return relay; },
    async start(port = Number(env.PORT ?? 3000), host = env.HOST ?? '0.0.0.0') {
      if (embeddedRelay) {
        relay = new UdpRelay({ secret, port: options.relayPort ?? Number(env.RELAY_PORT ?? 40000), host: env.RELAY_HOST ?? '0.0.0.0', allowPrivate: allowPrivateTargets });
        const relayPort = await relay.start();
        nodes = nodes.map((n) => (n.id === 'local' ? { ...n, udpPort: relayPort } : n));
      }
      await new Promise((resolve) => server.listen(port, host, resolve));
      return server.address().port;
    },
    async stop() {
      await realtime.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (relay) await relay.stop();
      db.close();
    },
  };
}
