import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, http, register, makePremium } from './helpers.js';
import { signToken, verifyToken, hashPassword, verifyPassword } from '../server/src/auth.js';

let ctx;
before(async () => { ctx = await startHub(); });
after(() => ctx.stop());

test('пароли хешируются и проверяются', () => {
  const h = hashPassword('secret-pass');
  assert.notEqual(h, 'secret-pass');
  assert.ok(verifyPassword('secret-pass', h));
  assert.ok(!verifyPassword('wrong-pass', h));
});

test('токены: подпись, подделка, срок действия', () => {
  const t = signToken({ sub: 1, kind: 'session' }, 'k', 60);
  assert.equal(verifyToken(t, 'k').sub, 1);
  assert.equal(verifyToken(t, 'other-key'), null);
  const [data, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 2, kind: 'session', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, 'k'), null);
  assert.equal(verifyToken(signToken({ sub: 1 }, 'k', -10), 'k'), null);
  assert.equal(verifyToken(`${data}`, 'k'), null);
});

test('регистрация, вход по email и по нику', async () => {
  const reg = await register(ctx.base, 'alice');
  assert.ok(reg.token);
  assert.equal(reg.user.username, 'alice');
  assert.equal(reg.plan.id, 'free');
  assert.equal(reg.user.password_hash, undefined, 'хеш пароля не должен утекать');

  const byEmail = await http(ctx.base, '/api/auth/login', { method: 'POST', body: { login: 'alice@test.dev', password: 'password123' } });
  assert.equal(byEmail.status, 200);
  const byName = await http(ctx.base, '/api/auth/login', { method: 'POST', body: { login: 'ALICE', password: 'password123' } });
  assert.equal(byName.status, 200);
  const bad = await http(ctx.base, '/api/auth/login', { method: 'POST', body: { login: 'alice', password: 'nope-nope' } });
  assert.equal(bad.status, 401);
});

test('валидация и дубликаты при регистрации', async () => {
  await register(ctx.base, 'bob');
  const dup = await http(ctx.base, '/api/auth/register', { method: 'POST', body: { email: 'BOB@test.dev', username: 'bob2', password: 'password123' } });
  assert.equal(dup.status, 409);
  const short = await http(ctx.base, '/api/auth/register', { method: 'POST', body: { email: 'x@test.dev', username: 'xx_x', password: '123' } });
  assert.equal(short.status, 400);
  const badName = await http(ctx.base, '/api/auth/register', { method: 'POST', body: { email: 'y@test.dev', username: 'имя', password: 'password123' } });
  assert.equal(badName.status, 400);
  const badJson = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(badJson.status, 400);
});

test('ЕДИНЫЙ АККАУНТ: один токен открывает все три приложения', async () => {
  const { token } = await register(ctx.base, 'carol', { app: 'voice' });
  let me = (await http(ctx.base, '/api/me', { token })).body;
  assert.deepEqual(me.apps.map((a) => a.app), ['voice']);

  for (const app of ['watch', 'boost']) {
    const r = await http(ctx.base, `/api/apps/${app}/link`, { method: 'POST', token });
    assert.equal(r.status, 200);
  }
  me = (await http(ctx.base, '/api/me', { token })).body;
  assert.deepEqual(me.apps.map((a) => a.app).sort(), ['boost', 'voice', 'watch']);
  assert.equal((await http(ctx.base, '/api/apps/unknown/link', { method: 'POST', token })).status, 404);
});

test('без токена или с плохим токеном — 401', async () => {
  assert.equal((await http(ctx.base, '/api/me')).status, 401);
  assert.equal((await http(ctx.base, '/api/me', { token: 'garbage' })).status, 401);
  const boostToken = signToken({ sub: 1, kind: 'boost' }, 'test-secret', 60);
  assert.equal((await http(ctx.base, '/api/me', { token: boostToken })).status, 401, 'токен игровой сессии не должен давать доступ к аккаунту');
});

test('Premium: покупка, продление, отмена автопродления', async () => {
  const { token } = await register(ctx.base, 'dave');
  const plans = (await http(ctx.base, '/api/plans')).body;
  assert.equal(plans.paymentsMode, 'test');
  assert.deepEqual(plans.plans.map((p) => p.id), ['free', 'premium']);

  const acc = await makePremium(ctx.base, token);
  assert.equal(acc.plan.id, 'premium');
  const firstExpiry = acc.subscription.expiresAt;
  assert.ok(firstExpiry > Date.now() + 29 * 864e5);

  const renewed = (await http(ctx.base, '/api/subscription/checkout', { method: 'POST', token, body: { plan: 'premium', months: 3 } })).body;
  assert.ok(renewed.subscription.expiresAt >= firstExpiry + 89 * 864e5, 'продление добавляется к текущему сроку');

  const cancelled = (await http(ctx.base, '/api/subscription/cancel', { method: 'POST', token })).body;
  assert.equal(cancelled.plan.id, 'premium', 'Premium работает до конца оплаченного периода');
  assert.equal(cancelled.subscription.autoRenew, false);

  assert.equal((await http(ctx.base, '/api/subscription/checkout', { method: 'POST', token, body: { plan: 'free' } })).status, 400);
  assert.equal((await http(ctx.base, '/api/subscription/checkout', { method: 'POST', token, body: { plan: 'premium', months: 7 } })).status, 400);
});

test('истёкший Premium превращается в Free', async () => {
  const { token, user } = await register(ctx.base, 'erin');
  ctx.hub.db.prepare('INSERT INTO subscriptions (user_id, plan, expires_at, auto_renew, updated_at) VALUES (?, ?, ?, 1, ?)').run(user.id, 'premium', Date.now() - 1000, Date.now());
  const me = (await http(ctx.base, '/api/me', { token })).body;
  assert.equal(me.plan.id, 'free');
});

test('в продакшен-режиме оплаты тестовая активация запрещена', async () => {
  const prod = await startHub({ paymentsMode: 'live' });
  try {
    const { token } = await register(prod.base, 'frank');
    const r = await http(prod.base, '/api/subscription/checkout', { method: 'POST', token, body: { plan: 'premium', months: 1 } });
    assert.equal(r.status, 501);
  } finally { await prod.stop(); }
});

test('ограничение частоты входа (защита от перебора)', async () => {
  const limited = await startHub({ authRateLimit: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await http(limited.base, '/api/auth/login', { method: 'POST', body: { login: 'x', password: 'y' } })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  } finally { await limited.stop(); }
});

test('веб-страницы приложений отдаются', async () => {
  for (const p of ['/', '/voice', '/watch', '/boost', '/shared/hub.js']) {
    const r = await fetch(ctx.base + p);
    assert.equal(r.status, 200, p);
  }
});
