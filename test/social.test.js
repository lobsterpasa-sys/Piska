import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, http, register, makePremium, wsClient } from './helpers.js';

let ctx;
before(async () => { ctx = await startHub(); });
after(() => ctx.stop());

const friends = (token) => http(ctx.base, '/api/friends', { token }).then((r) => r.body);

async function befriend(a, b) {
  await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: b.user.username } });
  await http(ctx.base, `/api/friends/${a.user.id}/accept`, { method: 'POST', token: b.token });
}

test('друзья: заявка, принятие, список, удаление', async () => {
  const a = await register(ctx.base, 'fr_anna');
  const b = await register(ctx.base, 'fr_boris');

  const sent = await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: 'FR_BORIS' } });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.outgoing.map((f) => f.username), ['fr_boris']);
  assert.deepEqual((await friends(b.token)).incoming.map((f) => f.username), ['fr_anna']);

  assert.equal((await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: 'fr_boris' } })).status, 409);
  assert.equal((await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: 'fr_anna' } })).status, 400);
  assert.equal((await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: 'nobody_here' } })).status, 404);
  // Принять чужую заявку от своего имени нельзя
  assert.equal((await http(ctx.base, `/api/friends/${b.user.id}/accept`, { method: 'POST', token: a.token })).status, 404);

  const acc = await http(ctx.base, `/api/friends/${a.user.id}/accept`, { method: 'POST', token: b.token });
  assert.equal(acc.status, 200);
  assert.deepEqual(acc.body.friends.map((f) => f.username), ['fr_anna']);
  assert.deepEqual((await friends(a.token)).friends.map((f) => f.username), ['fr_boris']);

  const del = await http(ctx.base, `/api/friends/${b.user.id}`, { method: 'DELETE', token: a.token });
  assert.equal(del.status, 200);
  assert.deepEqual((await friends(b.token)).friends, []);
});

test('встречные заявки сразу делают друзьями', async () => {
  const a = await register(ctx.base, 'fr_cross1');
  const b = await register(ctx.base, 'fr_cross2');
  await http(ctx.base, '/api/friends/request', { method: 'POST', token: a.token, body: { username: 'fr_cross2' } });
  const r = await http(ctx.base, '/api/friends/request', { method: 'POST', token: b.token, body: { username: 'fr_cross1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.friends.map((f) => f.username), ['fr_cross1']);
});

test('статус «в сети» и где сейчас друг — во всех приложениях', async () => {
  const a = await register(ctx.base, 'pr_alex');
  const b = await register(ctx.base, 'pr_bella');
  await befriend(a, b);
  assert.equal((await friends(a.token)).friends[0].online, false);

  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);
  const online = await ca.next('presence', (m) => m.userId === b.user.id && m.online);
  assert.equal(online.activity, null);

  cb.send({ type: 'voice:join', room: 'duo' });
  await cb.next('voice:joined');
  const act = await ca.next('presence', (m) => m.userId === b.user.id && m.activity);
  assert.deepEqual(act.activity, { app: 'voice', room: 'duo', private: false });
  const list = await friends(a.token);
  assert.equal(list.friends[0].online, true);
  assert.equal(list.friends[0].activity.room, 'duo');

  await cb.close();
  const off = await ca.next('presence', (m) => m.userId === b.user.id && !m.online);
  assert.equal(off.activity, null);
  await ca.close();
});

test('не-друзья не видят статус друг друга', async () => {
  const a = await register(ctx.base, 'pr_stranger1');
  const b = await register(ctx.base, 'pr_stranger2');
  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);
  cb.send({ type: 'voice:join', room: 'hidden' });
  await cb.next('voice:joined');
  await assert.rejects(ca.next('presence', (m) => m.userId === b.user.id, 400));
  await ca.close(); await cb.close();
});

test('приглашение друга в комнату, в т.ч. в приватную без пароля', async () => {
  const host = await register(ctx.base, 'inv_host');
  const guest = await register(ctx.base, 'inv_guest');
  const stranger = await register(ctx.base, 'inv_stranger');
  await makePremium(ctx.base, host.token);
  await befriend(host, guest);

  const ch = await wsClient(ctx.base, host.token);
  const cg = await wsClient(ctx.base, guest.token);
  const cs = await wsClient(ctx.base, stranger.token);

  ch.send({ type: 'invite', app: 'watch', to: guest.user.id });
  assert.equal((await ch.next('error')).code, 'not-in-room');

  ch.send({ type: 'watch:join', room: 'vip', password: 'secret' });
  await ch.next('watch:joined');
  ch.send({ type: 'invite', app: 'watch', to: stranger.user.id });
  assert.equal((await ch.next('error')).code, 'not-friends');

  ch.send({ type: 'invite', app: 'watch', to: guest.user.id });
  await ch.next('invite:sent');
  const inv = await cg.next('invite');
  assert.deepEqual(inv, { type: 'invite', from: { id: host.user.id, username: 'inv_host' }, app: 'watch', room: 'vip', private: true });

  // Приглашённый входит без пароля, посторонний — нет
  cg.send({ type: 'watch:join', room: 'vip' });
  await cg.next('watch:joined');
  cs.send({ type: 'watch:join', room: 'vip' });
  assert.equal((await cs.next('error')).code, 'bad-password');

  // У друзей приватная комната не раскрывается
  const list = await friends(guest.token);
  assert.deepEqual(list.friends[0].activity, { app: 'watch', room: null, private: true });
  await Promise.all([ch, cg, cs].map((c) => c.close()));
});

test('смена пароля: другие устройства выходят, это остаётся', async () => {
  const u = await register(ctx.base, 'pw_user');
  const other = await wsClient(ctx.base, u.token);
  const wrong = await http(ctx.base, '/api/account/password', { method: 'POST', token: u.token, body: { current: 'bad-pass', next: 'newpassword1' } });
  assert.equal(wrong.status, 403);
  const short = await http(ctx.base, '/api/account/password', { method: 'POST', token: u.token, body: { current: 'password123', next: '123' } });
  assert.equal(short.status, 400);

  const closed = new Promise((r) => other.ws.once('close', (code) => r(code)));
  const ok = await http(ctx.base, '/api/account/password', { method: 'POST', token: u.token, body: { current: 'password123', next: 'newpassword1' } });
  assert.equal(ok.status, 200);
  assert.equal(await closed, 4001, 'открытое соединение разорвано');
  assert.equal((await http(ctx.base, '/api/me', { token: u.token })).status, 401, 'старый токен больше не действует');
  assert.equal((await http(ctx.base, '/api/me', { token: ok.body.token })).status, 200, 'новый токен работает');
  const login = await http(ctx.base, '/api/auth/login', { method: 'POST', body: { login: 'pw_user', password: 'newpassword1' } });
  assert.equal(login.status, 200);
});

test('удаление аккаунта', async () => {
  const u = await register(ctx.base, 'del_user');
  const f = await register(ctx.base, 'del_friend');
  await befriend(u, f);
  assert.equal((await http(ctx.base, '/api/account', { method: 'DELETE', token: u.token, body: { password: 'wrong-pass' } })).status, 403);
  assert.equal((await http(ctx.base, '/api/account', { method: 'DELETE', token: u.token, body: { password: 'password123' } })).status, 204);
  assert.equal((await http(ctx.base, '/api/me', { token: u.token })).status, 401);
  assert.deepEqual((await friends(f.token)).friends, [], 'аккаунт исчез из списков друзей');
  const again = await http(ctx.base, '/api/auth/register', { method: 'POST', body: { email: 'del_user@test.dev', username: 'del_user', password: 'password123' } });
  assert.equal(again.status, 201, 'email и ник освободились');
});

test('конфигурация ICE-серверов для голосового чата', async () => {
  const r = await http(ctx.base, '/api/config');
  assert.equal(r.body.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  const custom = await startHub({ env: { ICE_SERVERS: JSON.stringify([{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }]) } });
  try {
    const c = await http(custom.base, '/api/config');
    assert.equal(c.body.iceServers[0].urls, 'turn:turn.example.com:3478');
  } finally { await custom.stop(); }
});
