import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, register, wsClient, http } from './helpers.js';
import { parseMedia, currentPosition } from '../server/src/realtime.js';

let ctx;
before(async () => { ctx = await startHub(); });
after(() => ctx.stop());

test('распознавание ссылок YouTube и видео', () => {
  assert.equal(parseMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10').videoId, 'dQw4w9WgXcQ');
  assert.equal(parseMedia('https://youtu.be/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');
  assert.equal(parseMedia('https://m.youtube.com/shorts/abcdefghijk').videoId, 'abcdefghijk');
  assert.equal(parseMedia('https://cdn.example.com/film.mp4').kind, 'video');
  assert.equal(parseMedia('javascript:alert(1)'), null);
  assert.equal(parseMedia('https://example.com/page.html'), null);
  assert.equal(parseMedia('https://youtube.com/watch?v=<script>'), null);
  assert.equal(parseMedia('not a url'), null);
});

test('расчёт текущей позиции видео', () => {
  assert.equal(currentPosition({ playing: false, position: 42, updatedAt: 0 }, 99_999), 42);
  assert.equal(currentPosition({ playing: true, position: 10, updatedAt: 1000 }, 6000), 15);
});

test('совместный просмотр: синхронизация play/pause/seek у всех', async () => {
  const a = await register(ctx.base, 'wat_a');
  const b = await register(ctx.base, 'wat_b');
  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);

  ca.send({ type: 'watch:join', room: 'cinema' });
  await ca.next('watch:joined');
  const s0 = await ca.next('watch:state');
  assert.equal(s0.hostId, ca.ready.selfId, 'первый вошедший — ведущий');
  assert.equal(s0.media, null);

  cb.send({ type: 'watch:join', room: 'cinema' });
  await cb.next('watch:joined');
  await cb.next('watch:state');
  const sJoin = await ca.next('watch:state', (m) => m.members.length === 2);
  assert.deepEqual(sJoin.members.map((m) => m.username).sort(), ['wat_a', 'wat_b']);

  ca.send({ type: 'watch:control', action: 'load', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const loaded = await cb.next('watch:state', (m) => m.action === 'load');
  assert.equal(loaded.media.kind, 'youtube');
  assert.equal(loaded.playing, true);
  assert.equal(loaded.by, 'wat_a');

  cb.send({ type: 'watch:control', action: 'pause', position: 30.5 });
  const paused = await ca.next('watch:state', (m) => m.action === 'pause');
  assert.equal(paused.playing, false);
  assert.equal(paused.position, 30.5);

  ca.send({ type: 'watch:control', action: 'seek', position: 100 });
  const seeked = await cb.next('watch:state', (m) => m.action === 'seek');
  assert.equal(seeked.position, 100);

  cb.send({ type: 'watch:control', action: 'play', position: 100 });
  await ca.next('watch:state', (m) => m.action === 'play');
  await new Promise((r) => setTimeout(r, 300));
  ca.send({ type: 'watch:sync' });
  const synced = await ca.next('watch:state', (m) => !m.action);
  assert.ok(synced.position > 100.2 && synced.position < 101.5, `позиция идёт вперёд: ${synced.position}`);

  const rooms = (await http(ctx.base, '/api/rooms/watch', { token: a.token })).body.rooms;
  assert.equal(rooms.find((r) => r.id === 'cinema').nowPlaying, 'https://youtu.be/dQw4w9WgXcQ');

  await ca.close();
  const afterLeave = await cb.next('watch:state', (m) => m.members.length === 1);
  assert.equal(afterLeave.hostId, cb.ready.selfId, 'ведущий переходит к оставшемуся');
  await cb.close();
});

test('очередь видео и «следующее»', async () => {
  const a = await register(ctx.base, 'wat_q');
  const c = await wsClient(ctx.base, a.token);
  c.send({ type: 'watch:join', room: 'queue' });
  await c.next('watch:state');
  c.send({ type: 'watch:control', action: 'queue-add', url: 'https://cdn.example.com/a.mp4' });
  c.send({ type: 'watch:control', action: 'queue-add', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const q = await c.next('watch:state', (m) => m.queue.length === 2);
  assert.equal(q.queue[0].addedBy, 'wat_q');
  c.send({ type: 'watch:control', action: 'next' });
  const n = await c.next('watch:state', (m) => m.action === 'next');
  assert.equal(n.media.url, 'https://cdn.example.com/a.mp4');
  assert.equal(n.media.addedBy, undefined);
  assert.equal(n.queue.length, 1);
  c.send({ type: 'watch:control', action: 'load', url: 'https://evil.example.com/x.html' });
  assert.equal((await c.next('error')).code, 'bad-url');
  await c.close();
});

test('режим «управляет только ведущий»', async () => {
  const h = await register(ctx.base, 'host1');
  const g = await register(ctx.base, 'guest2');
  const ch = await wsClient(ctx.base, h.token);
  const cg = await wsClient(ctx.base, g.token);
  ch.send({ type: 'watch:join', room: 'strict' });
  await ch.next('watch:state');
  cg.send({ type: 'watch:join', room: 'strict' });
  await cg.next('watch:state');

  cg.send({ type: 'watch:control', action: 'host-only', value: true });
  assert.equal((await cg.next('error')).code, 'host-only');

  ch.send({ type: 'watch:control', action: 'host-only', value: true });
  await cg.next('watch:state', (m) => m.hostOnly === true);
  cg.send({ type: 'watch:control', action: 'pause', position: 1 });
  assert.equal((await cg.next('error')).code, 'host-only');
  cg.send({ type: 'watch:control', action: 'queue-add', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const q = await ch.next('watch:state', (m) => m.queue.length === 1);
  assert.equal(q.queue[0].addedBy, 'guest2', 'гости могут предлагать видео в очередь');
  await ch.close(); await cg.close();
});

test('Free-комната просмотра — до 4 человек', async () => {
  const cs = [];
  for (let i = 0; i < 5; i++) {
    const u = await register(ctx.base, `wcap${i}`);
    const c = await wsClient(ctx.base, u.token);
    c.send({ type: 'watch:join', room: 'small' });
    cs.push(c);
  }
  for (let i = 0; i < 4; i++) await cs[i].next('watch:joined');
  assert.equal((await cs[4].next('error')).code, 'room-full');
  await Promise.all(cs.map((c) => c.close()));
});

test('голосовой чат комнаты просмотра: только для участников, не виден в списке Voice', async () => {
  const a = await register(ctx.base, 'wv_alpha');
  const b = await register(ctx.base, 'wv_beta');
  const ca = await wsClient(ctx.base, a.token);
  const cb = await wsClient(ctx.base, b.token);

  ca.send({ type: 'voice:join', room: 'party', watch: true });
  assert.equal((await ca.next('error')).code, 'not-in-room');

  ca.send({ type: 'watch:join', room: 'party' });
  await ca.next('watch:joined');
  ca.send({ type: 'voice:join', room: 'party', watch: true });
  const j = await ca.next('voice:joined');
  assert.equal(j.room, '@party');
  assert.equal(j.capacity, 4, 'вместимость как у комнаты просмотра');

  // Обычный вход в «@party» запрещён валидацией имени
  cb.send({ type: 'voice:join', room: '@party' });
  assert.equal((await cb.next('error')).code, 'bad-room');

  cb.send({ type: 'watch:join', room: 'party' });
  await cb.next('watch:joined');
  cb.send({ type: 'voice:join', room: 'party', watch: true });
  const jb = await cb.next('voice:joined');
  assert.equal(jb.peers[0].username, 'wv_alpha');

  await ca.next('voice:peer-joined');
  const voiceRooms = (await http(ctx.base, '/api/rooms/voice', { token: a.token })).body.rooms;
  assert.ok(!voiceRooms.some((r) => r.id.startsWith('@')));

  // Выход из комнаты просмотра выводит и из её голосового чата
  cb.send({ type: 'watch:leave' });
  const left = await ca.next('voice:peer-left');
  assert.equal(left.peerId, cb.ready.selfId);
  await ca.close(); await cb.close();
});
