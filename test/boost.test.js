import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startHub, http, register, makePremium } from './helpers.js';
import { isPrivateAddress, splitHostPort } from '../server/src/boost/relay.js';
import { loadNodes } from '../server/src/boost/catalog.js';

let ctx;
before(async () => {
  ctx = await startHub({
    nodes: [
      { id: 'local', name: 'Local', region: 'local', host: '127.0.0.1', udpPort: 0, probeUrl: null, premium: false },
      { id: 'fra-pro', name: 'Frankfurt Pro', region: 'eu', host: '127.0.0.1', udpPort: 0, probeUrl: null, premium: true },
    ],
    embeddedRelay: true,
  });
});
after(() => ctx.stop());

/** Фейковый игровой сервер: отвечает «PONG:<данные>». */
async function fakeGameServer() {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, r) => s.send(Buffer.concat([Buffer.from('PONG:'), msg]), r.port, r.address));
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return s;
}

function udpClient() {
  const s = dgram.createSocket('udp4');
  const inbox = [];
  const waiters = [];
  s.on('message', (m) => { const w = waiters.shift(); if (w) w(m.toString()); else inbox.push(m.toString()); });
  return {
    send: (data, port) => new Promise((r) => s.send(data, port, '127.0.0.1', r)),
    recv: (timeout = 2000) => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
      const w = (m) => { clearTimeout(t); resolve(m); };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('udp timeout')); }, timeout);
      waiters.push(w);
    })),
    close: () => s.close(),
  };
}

test('каталог игр и узлов', async () => {
  const { token } = await register(ctx.base, 'gamer');
  const games = (await http(ctx.base, '/api/boost/games', { token })).body.games;
  assert.ok(games.length >= 10);
  assert.ok(games.some((g) => g.id === 'standoff2'));
  const { nodes, multipath } = (await http(ctx.base, '/api/boost/nodes', { token })).body;
  assert.equal(multipath, false);
  assert.equal(nodes.find((n) => n.id === 'fra-pro').locked, true);
  assert.equal(nodes.find((n) => n.id === 'local').locked, false);
});

test('замер пинга: probe-эндпоинт отвечает быстро и без кеша', async () => {
  const r = await fetch(`${ctx.base}/api/boost/probe`);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('премиум-узел недоступен на Free и доступен на Premium', async () => {
  const { token } = await register(ctx.base, 'gamer2');
  const denied = await http(ctx.base, '/api/boost/session', { method: 'POST', token, body: { gameId: 'cs2', nodeId: 'fra-pro' } });
  assert.equal(denied.status, 403);
  await makePremium(ctx.base, token);
  const ok = await http(ctx.base, '/api/boost/session', { method: 'POST', token, body: { gameId: 'cs2', nodeId: 'fra-pro' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.multipath, true);
  const me = (await http(ctx.base, '/api/me', { token })).body;
  assert.ok(me.apps.some((a) => a.app === 'boost'));
});

test('UDP-ретранслятор: пакеты игры идут через узел и обратно', async (t) => {
  const game = await fakeGameServer();
  const gamePort = game.address().port;
  const { token } = await register(ctx.base, 'gamer3');
  const s = await http(ctx.base, '/api/boost/session', {
    method: 'POST', token, body: { gameId: 'pubg-mobile', nodeId: 'local', target: `127.0.0.1:${gamePort}` },
  });
  assert.equal(s.status, 200);
  const relayPort = ctx.hub.relay.port;
  assert.equal(s.body.node.udpPort, relayPort);

  const c = udpClient();
  t.after(() => { c.close(); game.close(); });
  // До рукопожатия пакеты игнорируются
  await c.send('early', relayPort);
  await assert.rejects(c.recv(300));

  await c.send(`HELLO ${s.body.sessionToken}`, relayPort);
  assert.equal(await c.recv(), 'OK');
  await c.send('move:1,2', relayPort);
  assert.equal(await c.recv(), 'PONG:move:1,2');

  // Замер задержки через ретранслятор
  const t0 = performance.now();
  await c.send('ping', relayPort);
  assert.equal(await c.recv(), 'PONG:ping');
  assert.ok(performance.now() - t0 < 50, 'локальная задержка через узел минимальна');

  assert.equal(ctx.hub.relay.sessions.size >= 1, true);
});

test('ретранслятор отклоняет поддельные и чужие токены', async (t) => {
  const c = udpClient();
  t.after(() => c.close());
  const relayPort = ctx.hub.relay.port;
  await c.send('HELLO not-a-token', relayPort);
  assert.equal(await c.recv(), 'ERR bad-token');
  const { token } = await register(ctx.base, 'gamer4');
  await c.send(`HELLO ${token}`, relayPort); // токен аккаунта — не токен игровой сессии
  assert.equal(await c.recv(), 'ERR bad-token');
});

test('защита от открытого прокси: внутренние адреса запрещены', async () => {
  const strict = await startHub({ allowPrivateTargets: false, embeddedRelay: false });
  try {
    const { token } = await register(strict.base, 'gamer5');
    for (const target of ['127.0.0.1:22', '10.0.0.5:3306', '192.168.1.1:80', 'localhost:6379', '[::1]:5432']) {
      const r = await http(strict.base, '/api/boost/session', { method: 'POST', token, body: { gameId: 'cs2', nodeId: 'local', target } });
      assert.equal(r.status, 400, target);
    }
    const ok = await http(strict.base, '/api/boost/session', { method: 'POST', token, body: { gameId: 'cs2', nodeId: 'local', target: '8.8.8.8:27015' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.sessionToken);
  } finally { await strict.stop(); }
});

test('вспомогательные функции адресов и конфигурация узлов', () => {
  assert.deepEqual(splitHostPort('1.2.3.4:27015'), ['1.2.3.4', '27015']);
  assert.deepEqual(splitHostPort('[2001:db8::1]:443'), ['2001:db8::1', '443']);
  assert.throws(() => splitHostPort('nope'));
  assert.ok(isPrivateAddress('172.20.0.1'));
  assert.ok(!isPrivateAddress('172.32.0.1'));
  assert.ok(!isPrivateAddress('95.100.1.1'));
  const nodes = loadNodes({ BOOST_NODES: JSON.stringify([{ id: 'msk', name: 'Москва', region: 'ru', host: 'msk.example.com', udpPort: 40000, premium: true }]) });
  assert.equal(nodes[0].premium, true);
  assert.equal(loadNodes({})[0].id, 'local');
  assert.throws(() => loadNodes({ BOOST_NODES: '{}' }));
});
