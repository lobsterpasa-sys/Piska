import WebSocket from 'ws';
import { createHub } from '../server/src/app.js';

export async function startHub(opts = {}) {
  const hub = createHub({ secret: 'test-secret', quiet: true, log: () => {}, relayPort: 0, allowPrivateTargets: true, authRateLimit: 1000, env: {}, ...opts });
  const port = await hub.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return { hub, base, port, stop: () => hub.stop() };
}

export async function http(base, path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let n = 0;
export async function register(base, name = `user${++n}`, extra = {}) {
  const r = await http(base, '/api/auth/register', {
    method: 'POST', body: { email: `${name}@test.dev`, username: name, password: 'password123', ...extra },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function makePremium(base, token) {
  const r = await http(base, '/api/subscription/checkout', { method: 'POST', token, body: { plan: 'premium', months: 1 } });
  if (r.status !== 200) throw new Error('checkout failed');
  return r.body;
}

/** WebSocket-клиент для тестов: ждёт сообщения нужного типа. */
export async function wsClient(base, token) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const client = {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, pred = () => true, timeout = 3000) {
      const match = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout waiting for ${type}; inbox: ${JSON.stringify(inbox.map((x) => x.type))}`)); }
        }, timeout);
      });
    },
    drain() { inbox.length = 0; },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  if (token) {
    client.send({ type: 'auth', token });
    client.ready = await client.next('ready');
  }
  return client;
}
