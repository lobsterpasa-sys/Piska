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
 * Режим «мультиплекс» (HELLO2) — для мобильного приложения, которое перехватывает весь UDP игры:
 *   клиент → узел:  [0x01][IPv4 назначения: 4 байта][порт назначения: 2][порт приложения: 2][данные]
 *   узел → клиент:  [0x01][IPv4 источника: 4][порт источника: 2][порт приложения: 2][данные]
 *   пинг:           [0x02][8 байт метки] — узел сразу отвечает тем же (замер задержки до узла)
 *   Для каждой пары (порт приложения, назначение) узел держит свой UDP-сокет.
 *   Внутренние адреса запрещены, число потоков на клиента ограничено.
 *
 * На устройстве игрока трафик игры перехватывает нативный клиент
 * (VpnService на Android, NetworkExtension на iOS, драйвер TUN/WinDivert на ПК)
 * и заворачивает его на этот узел.
 */
export class UdpRelay {
  constructor({ secret, port = 0, host = '0.0.0.0', idleTimeoutMs = 60_000, maxSessions = 5000, maxFlows = 64, allowPrivate = false }) {
    this.maxFlows = maxFlows;
    this.allowPrivate = allowPrivate;
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

    if (msg.length > 7 && msg.subarray(0, 7).toString() === 'HELLO2 ') {
      const payload = verifyToken(msg.subarray(7).toString(), this.secret);
      if (!payload || payload.kind !== 'boost') { this.socket.send('ERR bad-token', rinfo.port, rinfo.address); return; }
      if (session?.mux && session.userId === payload.sub) { // повторное приветствие: потоки сохраняем
        session.lastSeen = Date.now();
        this.socket.send('OK2', rinfo.port, rinfo.address);
        return;
      }
      if (!session && this.sessions.size >= this.maxSessions) { this.socket.send('ERR busy', rinfo.port, rinfo.address); return; }
      if (session) this.#close(key);
      this.sessions.set(key, { mux: true, rinfo, flows: new Map(), lastSeen: Date.now(), userId: payload.sub, stats: { up: 0, down: 0 } });
      this.socket.send('OK2', rinfo.port, rinfo.address);
      return;
    }

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
    if (session.mux) { this.#onMuxPacket(session, msg); return; }
    session.stats.up += msg.length;
    session.upstream.send(msg, session.target.port, session.target.host);
  }

  #onMuxPacket(session, msg) {
    const type = msg[0];
    if (type === 0x02 && msg.length === 9) { // пинг до узла
      this.socket.send(msg, session.rinfo.port, session.rinfo.address);
      return;
    }
    if (type !== 0x01 || msg.length < 9) return;
    const dstIp = `${msg[1]}.${msg[2]}.${msg[3]}.${msg[4]}`;
    const dstPort = msg.readUInt16BE(5);
    const appPort = msg.readUInt16BE(7);
    if (dstPort === 0 || (!this.allowPrivate && isPrivateAddress(dstIp))) return;
    const flowKey = `${appPort}>${dstIp}:${dstPort}`;
    let flow = session.flows.get(flowKey);
    if (!flow) {
      if (session.flows.size >= this.maxFlows) {
        // Освобождаем самый старый поток.
        const [oldKey, old] = [...session.flows.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        try { old.sock.close(); } catch { /* */ }
        session.flows.delete(oldKey);
      }
      const sock = dgram.createSocket('udp4');
      flow = { sock, lastSeen: Date.now() };
      const header = Buffer.alloc(9);
      header[0] = 0x01;
      dstIp.split('.').forEach((o, i) => { header[1 + i] = Number(o); });
      header.writeUInt16BE(appPort, 7);
      sock.on('message', (data, from) => {
        flow.lastSeen = Date.now();
        session.stats.down += data.length;
        const h = Buffer.from(header);
        // Ответ может прийти с другого порта того же сервера — сообщаем фактический источник.
        if (net.isIPv4(from.address)) from.address.split('.').forEach((o, i) => { h[1 + i] = Number(o); });
        h.writeUInt16BE(from.port, 5);
        this.socket.send(Buffer.concat([h, data]), session.rinfo.port, session.rinfo.address);
      });
      sock.on('error', () => { session.flows.delete(flowKey); try { sock.close(); } catch { /* */ } });
      session.flows.set(flowKey, flow);
    }
    flow.lastSeen = Date.now();
    session.stats.up += msg.length - 9;
    flow.sock.send(msg.subarray(9), dstPort, dstIp);
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
    if (s.mux) { for (const f of s.flows.values()) { try { f.sock.close(); } catch { /* */ } } return; }
    try { s.upstream.close(); } catch { /* уже закрыт */ }
  }

  #sweep() {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [key, s] of this.sessions) {
      if (s.lastSeen < cutoff) { this.#close(key); continue; }
      if (s.mux) for (const [fk, f] of s.flows) if (f.lastSeen < cutoff) { try { f.sock.close(); } catch { /* */ } s.flows.delete(fk); }
    }
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
