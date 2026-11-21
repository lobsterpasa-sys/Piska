import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, http, register, makePremium, wsClient } from './helpers.js';

let ctx;
before(async () => { ctx = await startHub(); });
after(() => ctx.stop());

test('без авторизации WebSocket ничего не позволяет', async () => {
  const c = await wsClient(ctx.base);
  c.send({ type: 'voice:join', room: 'x' });
  const err = await c.next('error');
  assert.equal(err.code, 'unauthorized');
  c.send({ type: 'auth', token: 'bad' });
  await new Promise((r) => c.ws.once('close', r));
});

test('ping/pong работает для замера задержки', async () => {
  const c = await wsClient(ctx.base);
  c.send({ type: 'ping', t: 123 });
  const pong = await c.next('pong');
  assert.equal(pong.t, 123);
  await c.close();
});

test('голосовая комната: вход, сигналинг WebRTC, чат, выход', async () => {
  const a = await register(ctx.base, 'vox_a');
  const b = await register(ctx.base, 'vox_b');
  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);

  ca.send({ type: 'voice:join', room: 'squad' });
  const ja = await ca.next('voice:joined');
  assert.deepEqual(ja.peers, []);
  assert.equal(ja.capacity, 5);

  cb.send({ type: 'voice:join', room: 'squad' });
  const jb = await cb.next('voice:joined');
  assert.equal(jb.peers.length, 1);
  assert.equal(jb.peers[0].username, 'vox_a');
  const joined = await ca.next('voice:peer-joined');
  assert.equal(joined.peer.username, 'vox_b');

  // Сигналинг доходит только до адресата
  cb.send({ type: 'voice:signal', to: ja.selfId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const sig = await ca.next('voice:signal');
  assert.equal(sig.from, jb.selfId);
  assert.equal(sig.data.sdp.type, 'offer');

  cb.send({ type: 'voice:chat', text: '  <b>го в игру</b>  ' });
  const chat = await ca.next('voice:chat');
  assert.equal(chat.text, '<b>го в игру</b>', 'сервер обрезает пробелы, экранирует клиент');
  assert.equal(chat.from.username, 'vox_b');

  cb.send({ type: 'voice:state', muted: true });
  const st = await ca.next('voice:peer-state');
  assert.equal(st.muted, true);

  const rooms = (await http(ctx.base, '/api/rooms/voice', { token: a.token })).body.rooms;
  assert.deepEqual(rooms.find((r) => r.id === 'squad'), { id: 'squad', members: 2, capacity: 5 });

  await cb.close();
  const left = await ca.next('voice:peer-left');
  assert.equal(left.peerId, jb.selfId);
  await ca.close();
});

test('сигнал в чужую комнату не пересылается', async () => {
  const a = await register(ctx.base, 'vox_c');
  const b = await register(ctx.base, 'vox_d');
  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);
  ca.send({ type: 'voice:join', room: 'room-a' });
  const ja = await ca.next('voice:joined');
  cb.send({ type: 'voice:join', room: 'room-b' });
  await cb.next('voice:joined');
  cb.send({ type: 'voice:signal', to: ja.selfId, data: { hack: true } });
  await assert.rejects(ca.next('voice:signal', () => true, 400));
  await ca.close(); await cb.close();
});

test('лимит мест: Free — 5 человек, Premium-комната — 20', async () => {
  const clients = [];
  for (let i = 0; i < 6; i++) {
    const u = await register(ctx.base, `cap${i}`);
    const c = await wsClient(ctx.base, u.token);
    clients.push(c);
    c.send({ type: 'voice:join', room: 'full' });
  }
  for (let i = 0; i < 5; i++) await clients[i].next('voice:joined');
  const err = await clients[5].next('error');
  assert.equal(err.code, 'room-full');

  const owner = await register(ctx.base, 'capowner');
  await makePremium(ctx.base, owner.token);
  const co = await wsClient(ctx.base, owner.token);
  co.send({ type: 'voice:join', room: 'big' });
  assert.equal((await co.next('voice:joined')).capacity, 20);

  await Promise.all([...clients, co].map((c) => c.close()));
});

test('эффекты голоса и приватные комнаты — только Premium', async () => {
  const free = await register(ctx.base, 'freeguy');
  const cf = await wsClient(ctx.base, free.token);
  cf.send({ type: 'voice:join', room: 'secret', password: 'pw' });
  assert.equal((await cf.next('error')).code, 'premium-required');

  cf.send({ type: 'voice:join', room: 'open' });
  await cf.next('voice:joined');
  cf.send({ type: 'voice:state', effect: 'robot' });
  assert.equal((await cf.next('error')).code, 'premium-required');

  const prem = await register(ctx.base, 'premguy');
  await makePremium(ctx.base, prem.token);
  const cp = await wsClient(ctx.base, prem.token);
  cp.send({ type: 'voice:join', room: 'secret', password: 'pw' });
  const j = await cp.next('voice:joined');
  assert.equal(j.private, true);
  // Второе устройство того же Premium-аккаунта заходит в открытую комнату
  const cp2 = await wsClient(ctx.base, prem.token);
  cp2.send({ type: 'voice:join', room: 'open' });
  await cp2.next('voice:joined');
  cp2.send({ type: 'voice:state', effect: 'robot' });
  const st = await cf.next('voice:peer-state');
  assert.equal(st.effect, 'robot');

  // Вход в приватную комнату: неверный пароль / верный пароль
  const other = await register(ctx.base, 'guest1');
  const cg = await wsClient(ctx.base, other.token);
  cg.send({ type: 'voice:join', room: 'secret', password: 'wrong' });
  assert.equal((await cg.next('error')).code, 'bad-password');
  cg.send({ type: 'voice:join', room: 'secret', password: 'pw' });
  await cg.next('voice:joined');

  const list = (await http(ctx.base, '/api/rooms/voice', { token: free.token })).body.rooms;
  assert.ok(!list.some((r) => r.id === 'secret'), 'приватные комнаты не видны в общем списке');
  await Promise.all([cf, cp, cp2, cg].map((c) => c.close()));
});

test('некорректное название комнаты и антиспам в чате', async () => {
  const u = await register(ctx.base, 'spammer');
  const c = await wsClient(ctx.base, u.token);
  c.send({ type: 'voice:join', room: '../etc' });
  assert.equal((await c.next('error')).code, 'bad-room');
  c.send({ type: 'voice:join', room: 'spam' });
  await c.next('voice:joined');
  for (let i = 0; i < 10; i++) c.send({ type: 'voice:chat', text: `msg ${i}` });
  assert.equal((await c.next('error')).code, 'slow-down');
  await c.close();
});
