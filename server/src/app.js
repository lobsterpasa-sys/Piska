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
    userById: db.prepare('SELECT id, email, username, created_at FROM users WHERE id = ?'),
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

  function authenticate(token) {
    const payload = verifyToken(token, secret);
    if (!payload || payload.kind !== 'session') return null;
    const user = q.userById.get(payload.sub);
    if (!user) return null;
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
      res.status(201).json({ token: signToken({ sub: userId, kind: 'session' }, secret, TOKEN_TTL), ...account(userId) });
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
    res.json({ token: signToken({ sub: user.id, kind: 'session' }, secret, TOKEN_TTL), ...account(user.id) });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json(account(req.user.id)));

  // Приложение отмечает, что пользователь вошёл в него этим же аккаунтом.
  app.post('/api/apps/:app/link', requireAuth, (req, res) => {
    if (!APPS.includes(req.params.app)) return res.status(404).json({ error: 'Неизвестное приложение' });
    linkApp(req.user.id, req.params.app);
    res.json(account(req.user.id));
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
    const sessionToken = target ? signToken({ sub: req.user.id, kind: 'boost', game: game.id, node: node.id, target }, secret, BOOST_TTL) : null;
    res.json({
      game, node: { id: node.id, name: node.name, region: node.region, host: node.host, udpPort: node.udpPort },
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
  realtime = attachRealtime(server, { authenticate, onAppUsed: linkApp, log: options.quiet ? () => {} : log });

  return {
    app, server, db, secret,
    get nodes() { return nodes; },
    get relay() { return relay; },
    async start(port = Number(env.PORT ?? 3000), host = env.HOST ?? '0.0.0.0') {
      if (embeddedRelay) {
        relay = new UdpRelay({ secret, port: options.relayPort ?? Number(env.RELAY_PORT ?? 40000), host: '127.0.0.1' });
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
