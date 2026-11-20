import dgram from 'node:dgram';
import net from 'node:net';
import { verifyToken } from '../auth.js';

/**
 * UDP-ретранслятор — сердце ускорителя.
 *
 * Протокол:
 *   1. Клиент шлёт на узел пакет `HELLO <sessionToken>`.
 *      Токен подписан основным сервером и содержит адрес игрового сервера (target)
 *      и срок действия — узлу не нужна база данных.
 *   2. Узел отвечает `OK` и выделяет под клиента отдельный UDP-сокет к игровому серверу.
 *   3. Дальше все пакеты клиента пересылаются на игровой сервер, ответы — обратно.
 *
 * На устройстве игрока трафик игры перехватывает нативный клиент
 * (VpnService на Android, NetworkExtension на iOS, драйвер TUN/WinDivert на ПК)
 * и заворачивает его на этот узел.
 */
export class UdpRelay {
  constructor({ secret, port = 0, host = '0.0.0.0', idleTimeoutMs = 60_000, maxSessions = 5000 }) {
    this.secret = secret;
    this.port = port;
    this.host = host;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map(); // "ip:port" клиента -> { upstream, target, lastSeen, stats }
    this.socket = dgram.createSocket('udp4');
    this.sweeper = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.on('message', (msg, rinfo) => this.#onClientPacket(msg, rinfo));
      this.socket.bind(this.port, this.host, () => {
        this.socket.off('error', reject);
        this.port = this.socket.address().port;
        this.sweeper = setInterval(() => this.#sweep(), Math.min(this.idleTimeoutMs, 10_000));
        this.sweeper.unref();
        resolve(this.port);
      });
    });
  }

  async stop() {
    clearInterval(this.sweeper);
    for (const key of [...this.sessions.keys()]) this.#close(key);
    await new Promise((r) => this.socket.close(r));
  }

  #onClientPacket(msg, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    const session = this.sessions.get(key);

    if (msg.length > 6 && msg.subarray(0, 6).toString() === 'HELLO ') {
      const payload = verifyToken(msg.subarray(6).toString(), this.secret);
      if (!payload || payload.kind !== 'boost' || !payload.target) {
        this.socket.send('ERR bad-token', rinfo.port, rinfo.address);
        return;
      }
      if (!session && this.sessions.size >= this.maxSessions) {
        this.socket.send('ERR busy', rinfo.port, rinfo.address);
        return;
      }
      if (session) this.#close(key);
      this.#open(key, rinfo, payload);
      this.socket.send('OK', rinfo.port, rinfo.address);
      return;
    }

    if (!session) return; // неизвестный отправитель — молча игнорируем
    session.lastSeen = Date.now();
    session.stats.up += msg.length;
    session.upstream.send(msg, session.target.port, session.target.host);
  }

  #open(key, rinfo, payload) {
    const [host, portStr] = splitHostPort(payload.target);
    const upstream = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const session = {
      upstream,
      target: { host, port: Number(portStr) },
      lastSeen: Date.now(),
      userId: payload.sub,
      stats: { up: 0, down: 0 },
    };
    upstream.on('message', (data) => {
      session.lastSeen = Date.now();
      session.stats.down += data.length;
      this.socket.send(data, rinfo.port, rinfo.address);
    });
    upstream.on('error', () => this.#close(key));
    this.sessions.set(key, session);
  }

  #close(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    try { s.upstream.close(); } catch { /* уже закрыт */ }
  }

  #sweep() {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [key, s] of this.sessions) if (s.lastSeen < cutoff) this.#close(key);
  }
}

export function splitHostPort(target) {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(target));
  if (!m) throw new Error('target должен быть в формате host:port');
  return [m[1], m[2]];
}

/** Запрещаем направлять трафик во внутренние сети (иначе узел станет открытым прокси). */
export function isPrivateAddress(host) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  }
  return false;
}
