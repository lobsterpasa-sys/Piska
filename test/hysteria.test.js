// Сквозная проверка с настоящим Hysteria 2 (сервер и клиент).
// Запуск: HYSTERIA_BIN=/путь/к/hysteria npm test   (без HYSTERIA_BIN тест пропускается)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import net from 'node:net';
import { startHub, http, register } from './helpers.js';

const BIN = process.env.HYSTERIA_BIN;
const skip = !BIN || !existsSync(BIN) ? 'HYSTERIA_BIN не задан' : false;

let ctx; let dir; let pin; const procs = [];
const HY_PORT = 20000 + Math.floor(Math.random() * 20000);
let udpEcho; let tcpEcho;

function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
}

function run(args, name) {
  const p = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  p.name = name;
  procs.push(p);
  return p;
}

function serverConfig(file, { acl }) {
  writeFileSync(file, `listen: 127.0.0.1:${HY_PORT}
tls:
  cert: ${join(dir, 'cert.pem')}
  key: ${join(dir, 'key.pem')}
auth:
  type: http
  http:
    url: ${ctx.base}/api/boost/hy2/auth
${acl ? `acl:
  inline:
    - reject(127.0.0.0/8)
    - direct(all)
` : ''}`);
}

async function clientWithForwarding(uri, name) {
  const udpPort = await freePort();
  const tcpPort = await freePort();
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, `server: "${uri}"
udpForwarding:
  - listen: 127.0.0.1:${udpPort}
    remote: 127.0.0.1:${udpEcho.address().port}
tcpForwarding:
  - listen: 127.0.0.1:${tcpPort}
    remote: 127.0.0.1:${tcpEcho.address().port}
`);
  const proc = run(['client', '-c', file], name);
  return { proc, udpPort, tcpPort };
}

async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw last ?? new Error('timeout');
}

function tcpRoundTrip(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let data = '';
    s.setTimeout(2000, () => { s.destroy(); reject(new Error('tcp timeout')); });
    s.on('connect', () => s.write(text));
    s.on('data', (d) => { data += d; if (data.length >= text.length) { s.end(); resolve(data); } });
    s.on('error', reject);
    s.on('close', () => { if (data.length < text.length) reject(new Error(`tcp closed: "${data}"`)); });
  });
}

function udpRoundTrip(port, text) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('udp timeout')); }, 1500);
    s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m.toString()); });
    s.send(text, port, '127.0.0.1');
  });
}

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'hub-hy2-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=hy.test', '-addext', 'subjectAltName=DNS:hy.test'], { stdio: 'ignore' });
  pin = execFileSync('openssl', ['x509', '-in', join(dir, 'cert.pem'), '-noout', '-fingerprint', '-sha256']).toString().trim().split('=')[1];
  ctx = await startHub({
    nodes: [{ id: 'local', name: 'Local', region: 'local', host: '127.0.0.1', udpPort: 0, probeUrl: null, premium: false,
      hy2: { port: HY_PORT, sni: 'hy.test', pinSHA256: pin, insecure: false, obfsPassword: null, host: '127.0.0.1' } }],
  });
  udpEcho = dgram.createSocket('udp4');
  udpEcho.on('message', (m, r) => udpEcho.send(Buffer.concat([Buffer.from('echo:'), m]), r.port, r.address));
  await new Promise((r) => udpEcho.bind(0, '127.0.0.1', r));
  tcpEcho = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => tcpEcho.listen(0, '127.0.0.1', r));
});

after(async () => {
  if (process.env.HY_DEBUG) for (const p of procs) console.error(`----- ${p.name}\n${p.log}`);
  for (const p of procs) p.kill('SIGKILL');
  if (skip) return;
  udpEcho?.close();
  tcpEcho?.close();
  await ctx?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('Hysteria 2: ссылка из Hub работает в настоящем клиенте — UDP и TCP через узел', { skip }, async () => {
  serverConfig(join(dir, 'server.yaml'), { acl: false });
  const server = run(['server', '-c', join(dir, 'server.yaml')], 'server');

  const u = await register(ctx.base, 'hy_user');
  const prof = await http(ctx.base, '/api/boost/hy2/profile', { method: 'POST', token: u.token, body: { nodeId: 'local' } });
  assert.equal(prof.status, 200);
  assert.match(prof.body.uri, /^hysteria2:\/\/[\w.-]+@127\.0\.0\.1:\d+\/\?sni=hy\.test&pinSHA256=[0-9A-F%:]+&insecure=1#/);
  assert.match(prof.body.qrSvg, /^<svg/);

  const c = await clientWithForwarding(prof.body.uri, 'client-ok');
  assert.equal(await waitFor(() => udpRoundTrip(c.udpPort, 'shot')), 'echo:shot', 'UDP (матч) идёт через Hysteria');
  assert.equal(await waitFor(() => tcpRoundTrip(c.tcpPort, 'lobby')), 'lobby', 'TCP (лобби) тоже идёт через Hysteria');
  c.proc.kill('SIGKILL');

  // Поддельный ключ узел не пускает
  const bad = await clientWithForwarding(prof.body.uri.replace(/\/\/[\w.-]+@/, '//forged.token@'), 'client-bad');
  await assert.rejects(waitFor(() => udpRoundTrip(bad.udpPort, 'x'), 4000));
  assert.match(bad.proc.log, /auth|authentication|unauthorized|failed/i, 'клиент сообщает об ошибке входа');
  bad.proc.kill('SIGKILL');

  // Смена пароля отзывает выданный ключ
  const pw = await http(ctx.base, '/api/account/password', { method: 'POST', token: u.token, body: { current: 'password123', next: 'newpassword1' } });
  assert.equal(pw.status, 200);
  const revoked = await clientWithForwarding(prof.body.uri, 'client-revoked');
  await assert.rejects(waitFor(() => udpRoundTrip(revoked.udpPort, 'x'), 4000));
  revoked.proc.kill('SIGKILL');
  server.kill('SIGKILL');
});

test('Hysteria 2: узел не пускает во внутренние сети (ACL из комплекта)', { skip }, async () => {
  serverConfig(join(dir, 'server-acl.yaml'), { acl: true });
  const server = run(['server', '-c', join(dir, 'server-acl.yaml')], 'server-acl');
  const u = await register(ctx.base, 'hy_acl');
  const prof = await http(ctx.base, '/api/boost/hy2/profile', { method: 'POST', token: u.token, body: { nodeId: 'local' } });
  const c = await clientWithForwarding(prof.body.uri, 'client-acl');
  await new Promise((r) => setTimeout(r, 1500));
  await assert.rejects(tcpRoundTrip(c.tcpPort, 'x'), 'TCP на 127.0.0.1 отклонён');
  await assert.rejects(udpRoundTrip(c.udpPort, 'x'), 'UDP на 127.0.0.1 отклонён');
  c.proc.kill('SIGKILL');
  server.kill('SIGKILL');
});
