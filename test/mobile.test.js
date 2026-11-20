import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, http, register } from './helpers.js';

let ctx;
before(async () => { ctx = await startHub({ env: { CORS_ORIGINS: 'https://hub.example.com' } }); });
after(() => ctx.stop());

test('CORS: мобильные приложения могут обращаться к API, чужие сайты — нет', async () => {
  for (const origin of ['https://localhost', 'capacitor://localhost', 'https://hub.example.com']) {
    const pre = await fetch(`${ctx.base}/api/me`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(pre.status, 204, origin);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  }
  const evil = await fetch(`${ctx.base}/api/plans`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('вход через другое приложение: одноразовый код вместо пароля', async () => {
  const u = await register(ctx.base, 'sso_user', { app: 'voice' });
  // Voice выдаёт код для Watch
  const { body: { code } } = await http(ctx.base, '/api/auth/sso/code', { method: 'POST', token: u.token, body: { app: 'watch' } });
  assert.ok(code.length >= 30);

  // Код для Watch нельзя использовать в Boost
  const wrongApp = await http(ctx.base, '/api/auth/sso/exchange', { method: 'POST', body: { code, app: 'boost' } });
  assert.equal(wrongApp.status, 401);
  // ...и после неудачной попытки он сгорает
  const burned = await http(ctx.base, '/api/auth/sso/exchange', { method: 'POST', body: { code, app: 'watch' } });
  assert.equal(burned.status, 401);

  const { body: { code: code2 } } = await http(ctx.base, '/api/auth/sso/code', { method: 'POST', token: u.token, body: { app: 'watch' } });
  const ok = await http(ctx.base, '/api/auth/sso/exchange', { method: 'POST', body: { code: code2, app: 'watch' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'sso_user');
  assert.ok(ok.body.apps.some((a) => a.app === 'watch'), 'Watch привязан к аккаунту');
  assert.equal((await http(ctx.base, '/api/me', { token: ok.body.token })).status, 200);

  const reuse = await http(ctx.base, '/api/auth/sso/exchange', { method: 'POST', body: { code: code2, app: 'watch' } });
  assert.equal(reuse.status, 401, 'код одноразовый');

  assert.equal((await http(ctx.base, '/api/auth/sso/code', { method: 'POST', body: { app: 'watch' } })).status, 401, 'нужен вход');
  assert.equal((await http(ctx.base, '/api/auth/sso/code', { method: 'POST', token: u.token, body: { app: 'other' } })).status, 400);
});

test('код входа истекает через 60 секунд', async (t) => {
  const u = await register(ctx.base, 'sso_late');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { body: { code } } = await http(ctx.base, '/api/auth/sso/code', { method: 'POST', token: u.token, body: { app: 'boost' } });
  t.mock.timers.tick(61_000);
  const r = await http(ctx.base, '/api/auth/sso/exchange', { method: 'POST', body: { code, app: 'boost' } });
  assert.equal(r.status, 401);
});
