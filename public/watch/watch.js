import { api, ensureLogin, renderTopbar, Realtime, chatWidget, toast, esc, initials, colorFor } from '/shared/hub.js';

const $ = (id) => document.getElementById(id);
const account = await ensureLogin('watch');
renderTopbar('watch', account);

const DRIFT_LIMIT = 1.5; // секунд — если расхождение больше, перематываем

// ---------- Лобби ----------
async function loadRooms() {
  try {
    const { rooms } = await api('/api/rooms/watch');
    $('rooms').innerHTML = rooms.length
      ? rooms.map((r) => `<div class="list-item"><div class="grow" style="min-width:0"><b>${esc(r.id)}</b><div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.members}/${r.capacity} · ${r.nowPlaying ? esc(r.nowPlaying) : 'ничего не играет'}</div></div><button class="btn sm" data-room="${esc(r.id)}">Войти</button></div>`).join('')
      : '<p class="muted">Пока пусто. Создайте комнату и позовите друзей!</p>';
    $('rooms').querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => joinRoom(b.dataset.room)));
  } catch (e) { $('rooms').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
$('refresh').addEventListener('click', loadRooms);
loadRooms();

// ---------- Плееры ----------
let ytApi = null;
function loadYouTubeApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Не удалось загрузить YouTube'));
    document.head.append(s);
  });
  return ytApi;
}

/** Единый интерфейс над YouTube-плеером и <video>. */
class Player {
  constructor(el, onUser) {
    this.el = el;
    this.onUser = onUser;
    this.kind = null;
    this.key = null;
    this.suppressUntil = 0;
  }

  get suppressed() { return Date.now() < this.suppressUntil; }
  quiet(ms = 900) { this.suppressUntil = Date.now() + ms; }

  async load(media) {
    const key = media.kind === 'youtube' ? `yt:${media.videoId}` : `v:${media.url}`;
    if (key === this.key) return;
    this.key = key;
    this.destroy();
    this.kind = media.kind;
    this.quiet(2500);
    if (media.kind === 'youtube') {
      const YT = await loadYouTubeApi();
      const holder = document.createElement('div');
      this.el.replaceChildren(holder);
      await new Promise((resolve) => {
        this.yt = new YT.Player(holder, {
          videoId: media.videoId,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => resolve(),
            onStateChange: (e) => {
              if (this.suppressed) return;
              if (e.data === YT.PlayerState.PLAYING) this.onUser('play', this.time());
              else if (e.data === YT.PlayerState.PAUSED) this.onUser('pause', this.time());
              else if (e.data === YT.PlayerState.ENDED) this.onUser('ended');
            },
          },
        });
      });
    } else {
      const v = document.createElement('video');
      v.src = media.url;
      v.controls = true;
      v.playsInline = true;
      v.dataset.testid = 'video';
      v.addEventListener('play', () => !this.suppressed && this.onUser('play', v.currentTime));
      v.addEventListener('pause', () => !this.suppressed && !v.ended && this.onUser('pause', v.currentTime));
      v.addEventListener('seeked', () => !this.suppressed && this.onUser('seek', v.currentTime));
      v.addEventListener('ended', () => this.onUser('ended'));
      this.el.replaceChildren(v);
      this.video = v;
      await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); });
    }
  }

  time() {
    if (this.yt?.getCurrentTime) return this.yt.getCurrentTime();
    return this.video?.currentTime ?? 0;
  }

  playing() {
    if (this.yt?.getPlayerState) return this.yt.getPlayerState() === 1;
    return this.video ? !this.video.paused : false;
  }

  apply(shouldPlay, position) {
    this.quiet();
    if (Math.abs(this.time() - position) > DRIFT_LIMIT) {
      if (this.yt?.seekTo) this.yt.seekTo(position, true);
      else if (this.video) this.video.currentTime = position;
    }
    if (shouldPlay && !this.playing()) {
      if (this.yt?.playVideo) this.yt.playVideo();
      else this.video?.play().catch(() => toast('Нажмите ▶ на видео, чтобы начать (ограничение браузера)'));
    } else if (!shouldPlay && this.playing()) {
      if (this.yt?.pauseVideo) this.yt.pauseVideo();
      else this.video?.pause();
    }
  }

  destroy() {
    this.yt?.destroy?.();
    this.yt = null;
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    this.video = null;
  }

  clear() {
    this.destroy();
    this.key = null;
    this.el.innerHTML = '<div class="empty">Вставьте ссылку на YouTube или видео ниже ⬇️</div>';
  }
}

// ---------- Комната ----------
let rt = null;
let roomName = null;
let state = null; // последнее состояние комнаты
let recvAt = 0;
let chat = null;

const expectedPosition = () => (state ? state.position + (state.playing ? (performance.now() - recvAt) / 1000 : 0) : 0);
const isHost = () => state && rt && state.hostId === rt.selfId;

const player = new Player($('player'), (action, position) => {
  if (!rt) return;
  if (action === 'ended') { if (isHost()) rt.send({ type: 'watch:control', action: 'next' }); return; }
  rt.send({ type: 'watch:control', action, position });
});

async function applyState(s) {
  state = s;
  recvAt = performance.now();
  renderMembers();
  renderQueue();
  $('host-only-wrap').classList.toggle('hidden', !isHost());
  $('host-only').checked = s.hostOnly;
  if (!s.media) { player.clear(); return; }
  await player.load(s.media);
  // Состояние могло обновиться, пока грузился плеер.
  player.apply(state.playing, expectedPosition());
}

function renderMembers() {
  $('members').innerHTML = state.members.map((m) => `
    <span class="member" data-member="${esc(m.id)}">
      <span class="avatar" style="background:${colorFor(m.username)}">${esc(initials(m.username))}</span>
      ${esc(m.username)}${m.id === state.hostId ? ' 👑' : ''}${m.premium ? ' ⭐' : ''}
    </span>`).join('');
}

function renderQueue() {
  $('queue').innerHTML = state.queue.length
    ? state.queue.map((q, i) => `<div class="list-item"><span class="muted">${i + 1}.</span><span class="url grow">${q.kind === 'youtube' ? '▶️ YouTube' : '🎞️ Видео'} · ${esc(q.url)}</span><span class="muted small">${esc(q.addedBy)}</span></div>`).join('')
    : '<p class="muted small" style="margin:0">Очередь пуста</p>';
}

// Периодическая подстройка: если у кого-то видео «уехало», возвращаем его к общему времени.
setInterval(() => {
  if (!state?.media || !player.key) return;
  if (player.playing() !== state.playing || Math.abs(player.time() - expectedPosition()) > DRIFT_LIMIT) {
    player.apply(state.playing, expectedPosition());
  }
}, 2000);

function joinRoom(name, password = '') {
  roomName = name;
  rt = new Realtime();
  rt.on('ready', () => rt.send({ type: 'watch:join', room: roomName, password }));
  rt.on('error', (m) => {
    toast(m.message, 'bad');
    if (['room-full', 'bad-password', 'premium-required', 'bad-room'].includes(m.code) && $('room-view').classList.contains('hidden')) {
      rt.close(); rt = null;
    }
  });
  rt.on('watch:joined', (m) => {
    $('lobby').classList.add('hidden');
    $('room-view').classList.remove('hidden');
    $('room-title').textContent = `# ${m.room}${m.private ? ' 🔒' : ''}`;
    location.hash = `room=${encodeURIComponent(m.room)}`;
    chat = chatWidget($('chat'), (text) => rt.send({ type: 'watch:chat', text }));
    chat.system(`Вы в комнате ${m.room} (мест: ${m.capacity})`);
  });
  rt.on('watch:state', (s) => {
    if (s.by && s.by !== account.user.username && chat) {
      const what = { load: 'включил новое видео', play: 'продолжил', pause: 'поставил на паузу', seek: 'перемотал', 'queue-add': 'добавил видео в очередь', next: 'включил следующее' }[s.action];
      if (what) chat.system(`${s.by} ${what}`);
    }
    applyState(s).catch((e) => toast(e.message, 'bad'));
  });
  rt.on('watch:chat', (m) => chat?.add(m.from.username, m.text));
}

function leaveRoom() {
  rt?.send({ type: 'watch:leave' });
  rt?.close();
  rt = null;
  state = null;
  player.clear();
  $('room-view').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
  loadRooms();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(e.target.room.value.trim(), e.target.password.value);
});
$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const action = e.submitter?.value ?? 'load';
  const url = e.target.url.value.trim();
  if (!url) return;
  rt?.send({ type: 'watch:control', action, url });
  e.target.url.value = '';
});
$('next').addEventListener('click', () => rt?.send({ type: 'watch:control', action: 'next' }));
$('host-only').addEventListener('change', (e) => rt?.send({ type: 'watch:control', action: 'host-only', value: e.target.checked }));
$('leave').addEventListener('click', leaveRoom);
$('invite').addEventListener('click', async () => {
  const link = `${location.origin}/watch#room=${encodeURIComponent(roomName)}`;
  try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch { prompt('Ссылка-приглашение:', link); }
});

const fromHash = new URLSearchParams(location.hash.slice(1)).get('room');
if (fromHash) $('room').value = fromHash;
