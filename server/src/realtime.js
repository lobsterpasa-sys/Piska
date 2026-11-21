import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_CHAT = 500;
const MAX_QUEUE = 50;

/**
 * Медиа-ссылка для совместного просмотра (аналог Rave).
 * YouTube — через официальный IFrame-плеер; прямые ссылки на видео (mp4/webm) — через <video>.
 * Netflix/Disney+/Prime требуют партнёрских договоров и DRM — в MVP их нет.
 */
export function parseMedia(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let videoId = null;
  if (host === 'youtu.be') videoId = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') videoId = u.searchParams.get('v');
    else if (/^\/(shorts|embed|live)\//.test(u.pathname)) videoId = u.pathname.split('/')[2];
  }
  if (videoId) return /^[a-zA-Z0-9_-]{6,20}$/.test(videoId) ? { kind: 'youtube', videoId, url: u.href } : null;
  if (/\.(mp4|webm|ogg|m4v|mov)$/i.test(u.pathname)) return { kind: 'video', url: u.href };
  return null;
}

export function currentPosition(state, now = Date.now()) {
  return state.playing ? state.position + (now - state.updatedAt) / 1000 : state.position;
}

export function attachRealtime(server, { authenticate, onAppUsed, friendIdsOf = () => [], areFriends = () => false, log = () => {} }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const rooms = new Map(); // `${kind}:${id}` -> room
  const byUser = new Map(); // userId -> Set<client> (один аккаунт может быть открыт в нескольких приложениях)

  /** Где сейчас пользователь: для статуса «играет в Voice: squad» у друзей. */
  function activityOf(userId) {
    for (const c of byUser.get(userId) ?? []) {
      for (const key of c.rooms) {
        const room = rooms.get(key);
        if (room && !room.linked) return { app: room.kind, room: room.password ? null : room.id, private: Boolean(room.password) };
      }
    }
    return null;
  }
  const isOnline = (userId) => (byUser.get(userId)?.size ?? 0) > 0;
  function notifyUser(userId, msg) {
    for (const c of byUser.get(userId) ?? []) send(c, msg);
  }
  function announcePresence(userId) {
    const msg = { type: 'presence', userId, online: isOnline(userId), activity: activityOf(userId) };
    for (const fid of friendIdsOf(userId)) notifyUser(fid, msg);
  }

  const send = (client, msg) => {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  };
  const broadcast = (room, msg, exceptId) => {
    for (const m of room.members.values()) if (m.id !== exceptId) send(m, msg);
  };
  const memberList = (room) => [...room.members.values()].map((m) => ({
    id: m.id, userId: m.user.id, username: m.user.username, premium: m.plan.id === 'premium', ...m.roomState.get(room.key),
  }));

  function watchSnapshot(room) {
    const s = room.state;
    return {
      type: 'watch:state',
      room: room.id,
      media: s.media,
      playing: s.playing,
      position: currentPosition(s),
      serverTime: Date.now(),
      queue: s.queue,
      hostId: room.hostId,
      hostOnly: s.hostOnly,
      members: memberList(room),
    };
  }

  function join(client, kind, msg) {
    let id = String(msg.room ?? '');
    let linkedWatch = null;
    if (kind === 'voice' && msg.watch) {
      // Голосовой чат внутри комнаты просмотра: доступен только её участникам.
      linkedWatch = roomOf(client, 'watch');
      if (!linkedWatch || linkedWatch.id !== id) return send(client, { type: 'error', code: 'not-in-room', message: 'Сначала зайдите в комнату просмотра' });
      id = `@${id}`;
    } else if (!ROOM_ID_RE.test(id)) {
      return send(client, { type: 'error', code: 'bad-room', message: 'Название комнаты: 1–40 символов, латиница, цифры, - и _' });
    }
    const key = `${kind}:${id}`;
    let room = rooms.get(key);
    if (!room) {
      const wantsPrivate = !linkedWatch && Boolean(msg.password);
      if (wantsPrivate && !client.plan.limits.privateRooms) {
        return send(client, { type: 'error', code: 'premium-required', message: 'Приватные комнаты с паролем доступны в Premium' });
      }
      room = {
        key, kind, id,
        ownerId: client.user.id,
        capacity: linkedWatch ? linkedWatch.capacity : kind === 'voice' ? client.plan.limits.voiceRoomSize : client.plan.limits.watchRoomSize,
        linked: Boolean(linkedWatch),
        password: wantsPrivate ? String(msg.password) : null,
        invited: new Set(), // друзья, приглашённые в приватную комнату, входят без пароля
        members: new Map(),
        hostId: client.id,
        state: kind === 'watch' ? { media: null, playing: false, position: 0, updatedAt: Date.now(), queue: [], hostOnly: false } : null,
        createdAt: Date.now(),
      };
      rooms.set(key, room);
    } else {
      if (room.members.has(client.id)) return;
      const invited = room.invited.has(client.user.id);
      if (room.password && !invited && room.password !== String(msg.password ?? '')) {
        return send(client, { type: 'error', code: 'bad-password', message: 'Неверный пароль комнаты' });
      }
      if (room.members.size >= room.capacity) {
        return send(client, { type: 'error', code: 'room-full', message: `Комната заполнена (${room.capacity} мест). У Premium до 20 мест.` });
      }
    }
    // Один клиент — одна комната каждого типа.
    for (const k of client.rooms) if (k.startsWith(`${kind}:`)) leave(client, k);

    room.members.set(client.id, client);
    client.rooms.add(key);
    client.roomState.set(key, kind === 'voice' ? { muted: false, effect: 'none' } : {});
    onAppUsed?.(client.user.id, kind);

    if (kind === 'voice') {
      send(client, {
        type: 'voice:joined', room: id, selfId: client.id, capacity: room.capacity,
        private: Boolean(room.password), peers: memberList(room).filter((p) => p.id !== client.id),
      });
      broadcast(room, { type: 'voice:peer-joined', peer: memberList(room).find((p) => p.id === client.id) }, client.id);
    } else {
      send(client, { type: 'watch:joined', room: id, selfId: client.id, capacity: room.capacity, private: Boolean(room.password) });
      broadcast(room, watchSnapshot(room));
    }
    log(`${client.user.username} joined ${key} (${room.members.size}/${room.capacity})`);
    announcePresence(client.user.id);
  }

  function leave(client, key) {
    const room = rooms.get(key);
    if (room?.kind === 'watch') {
      const linkedKey = `voice:@${room.id}`;
      if (client.rooms.has(linkedKey)) leave(client, linkedKey);
    }
    client.rooms.delete(key);
    client.roomState.delete(key);
    if (!room || !room.members.delete(client.id)) return;
    if (client.user && !client.closing) announcePresence(client.user.id);
    if (room.members.size === 0) { rooms.delete(key); return; }
    if (room.hostId === client.id) room.hostId = room.members.keys().next().value;
    if (room.kind === 'voice') broadcast(room, { type: 'voice:peer-left', peerId: client.id });
    else broadcast(room, watchSnapshot(room));
  }

  const roomOf = (client, kind) => {
    for (const k of client.rooms) if (k.startsWith(`${kind}:`)) return rooms.get(k);
    return null;
  };

  function chat(client, kind, text) {
    const room = roomOf(client, kind);
    if (!room) return;
    const clean = String(text ?? '').trim().slice(0, MAX_CHAT);
    if (!clean) return;
    const now = Date.now();
    client.chatTimes = client.chatTimes.filter((t) => now - t < 5000);
    if (client.chatTimes.length >= 8) return send(client, { type: 'error', code: 'slow-down', message: 'Слишком часто. Подождите пару секунд.' });
    client.chatTimes.push(now);
    broadcast(room, { type: `${kind}:chat`, from: { id: client.id, username: client.user.username }, text: clean, at: now });
  }

  function watchControl(client, msg) {
    const room = roomOf(client, 'watch');
    if (!room) return;
    const s = room.state;
    const isHost = room.hostId === client.id;
    if (s.hostOnly && !isHost && msg.action !== 'queue-add') {
      return send(client, { type: 'error', code: 'host-only', message: 'Управлять может только ведущий' });
    }
    const pos = Number.isFinite(msg.position) && msg.position >= 0 ? msg.position : currentPosition(s);
    const now = Date.now();
    switch (msg.action) {
      case 'load': {
        const media = parseMedia(msg.url);
        if (!media) return send(client, { type: 'error', code: 'bad-url', message: 'Поддерживаются ссылки YouTube и прямые ссылки на видео (.mp4, .webm)' });
        Object.assign(s, { media, playing: true, position: 0, updatedAt: now });
        break;
      }
      case 'play': Object.assign(s, { playing: true, position: pos, updatedAt: now }); break;
      case 'pause': Object.assign(s, { playing: false, position: pos, updatedAt: now }); break;
      case 'seek': Object.assign(s, { position: pos, updatedAt: now }); break;
      case 'queue-add': {
        const media = parseMedia(msg.url);
        if (!media) return send(client, { type: 'error', code: 'bad-url', message: 'Некорректная ссылка' });
        if (s.queue.length >= MAX_QUEUE) return send(client, { type: 'error', code: 'queue-full', message: 'Очередь заполнена' });
        s.queue.push({ ...media, addedBy: client.user.username });
        break;
      }
      case 'next': {
        const nextMedia = s.queue.shift();
        if (!nextMedia) return;
        const { addedBy, ...media } = nextMedia;
        Object.assign(s, { media, playing: true, position: 0, updatedAt: now });
        break;
      }
      case 'host-only': {
        if (!isHost) return send(client, { type: 'error', code: 'host-only', message: 'Только ведущий меняет эту настройку' });
        s.hostOnly = Boolean(msg.value);
        break;
      }
      default: return;
    }
    broadcast(room, { ...watchSnapshot(room), by: client.user.username, action: msg.action });
  }

  wss.on('connection', (ws) => {
    const client = { id: randomUUID(), ws, user: null, plan: null, rooms: new Set(), roomState: new Map(), chatTimes: [] };
    ws.isAlive = true;
    const authTimer = setTimeout(() => { if (!client.user) ws.close(4001, 'auth timeout'); }, 10_000);
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));

      if (!client.user) {
        if (msg.type !== 'auth') return send(client, { type: 'error', code: 'unauthorized', message: 'Сначала войдите' });
        const auth = authenticate(msg.token);
        if (!auth) { send(client, { type: 'error', code: 'unauthorized', message: 'Сессия истекла, войдите снова' }); return ws.close(4001, 'unauthorized'); }
        client.user = auth.user;
        client.plan = auth.plan;
        clearTimeout(authTimer);
        if (!byUser.has(client.user.id)) byUser.set(client.user.id, new Set());
        const first = byUser.get(client.user.id).size === 0;
        byUser.get(client.user.id).add(client);
        send(client, { type: 'ready', selfId: client.id, user: client.user, plan: client.plan.id });
        if (first) announcePresence(client.user.id);
        return;
      }

      switch (msg.type) {
        case 'voice:join': return join(client, 'voice', msg);
        case 'watch:join': return join(client, 'watch', msg);
        case 'voice:leave': { const r = roomOf(client, 'voice'); return r && leave(client, r.key); }
        case 'watch:leave': { const r = roomOf(client, 'watch'); return r && leave(client, r.key); }
        case 'voice:chat': return chat(client, 'voice', msg.text);
        case 'watch:chat': return chat(client, 'watch', msg.text);
        case 'watch:control': return watchControl(client, msg);
        case 'watch:sync': { const r = roomOf(client, 'watch'); return r && send(client, watchSnapshot(r)); }
        case 'voice:signal': {
          // Пересылка WebRTC-сигналов (offer/answer/ICE) — сам звук идёт напрямую между участниками.
          const room = roomOf(client, 'voice');
          const target = room?.members.get(msg.to);
          if (target) send(target, { type: 'voice:signal', from: client.id, data: msg.data });
          return;
        }
        case 'voice:state': {
          const room = roomOf(client, 'voice');
          if (!room) return;
          const st = client.roomState.get(room.key);
          if (typeof msg.muted === 'boolean') st.muted = msg.muted;
          if (typeof msg.effect === 'string') {
            if (!client.plan.limits.voiceEffects.includes(msg.effect)) {
              return send(client, { type: 'error', code: 'premium-required', message: 'Этот эффект голоса доступен в Premium' });
            }
            st.effect = msg.effect;
          }
          broadcast(room, { type: 'voice:peer-state', peerId: client.id, ...st });
          return;
        }
        case 'invite': {
          // Позвать друга в свою комнату (Voice или Watch).
          const app = msg.app === 'watch' ? 'watch' : 'voice';
          const room = roomOf(client, app);
          const to = Number(msg.to);
          if (!room) return send(client, { type: 'error', code: 'not-in-room', message: 'Сначала зайдите в комнату' });
          if (!areFriends(client.user.id, to)) return send(client, { type: 'error', code: 'not-friends', message: 'Звать можно только друзей' });
          if (!isOnline(to)) return send(client, { type: 'error', code: 'offline', message: 'Друг сейчас не в сети' });
          const now = Date.now();
          client.chatTimes = client.chatTimes.filter((t) => now - t < 5000);
          if (client.chatTimes.length >= 8) return send(client, { type: 'error', code: 'slow-down', message: 'Слишком часто. Подождите пару секунд.' });
          client.chatTimes.push(now);
          room.invited.add(to);
          notifyUser(to, { type: 'invite', from: { id: client.user.id, username: client.user.username }, app, room: room.id, private: Boolean(room.password) });
          return send(client, { type: 'invite:sent', to, app, room: room.id });
        }
        case 'voice:speaking': {
          const room = roomOf(client, 'voice');
          if (room) broadcast(room, { type: 'voice:speaking', peerId: client.id, speaking: Boolean(msg.speaking) }, client.id);
          return;
        }
        default: return;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      client.closing = true;
      for (const key of [...client.rooms]) leave(client, key);
      if (client.user) {
        const set = byUser.get(client.user.id);
        set?.delete(client);
        if (set && set.size === 0) byUser.delete(client.user.id);
        announcePresence(client.user.id);
      }
    });
  });

  // Отключаем «зависшие» соединения (телефон ушёл в сон, пропала сеть).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    isOnline,
    activityOf,
    notifyUser,
    announcePresence,
    /** Разорвать все соединения пользователя (смена пароля, удаление аккаунта). */
    disconnectUser(userId, reason = 'session-ended') {
      for (const c of [...(byUser.get(userId) ?? [])]) c.ws.close(4001, reason);
    },
    listRooms(kind) {
      return [...rooms.values()]
        .filter((r) => r.kind === kind && !r.password && !r.linked)
        .map((r) => ({
          id: r.id, members: r.members.size, capacity: r.capacity,
          nowPlaying: r.state?.media ? r.state.media.url : undefined,
        }))
        .sort((a, b) => b.members - a.members)
        .slice(0, 50);
    },
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}
