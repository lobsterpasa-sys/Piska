import { api, ensureLogin, renderTopbar, getRealtime, mountFriends, chatWidget, toast, esc, initials, colorFor, publicUrl } from '/shared/hub.js';
import { VoiceEngine, EFFECT_NAMES } from '/shared/voice-engine.js';

const $ = (id) => document.getElementById(id);
const account = await ensureLogin('voice');
const topbar = renderTopbar('voice', account);
const limits = account.plan.limits;
const rt = getRealtime();
const engine = new VoiceEngine({ rt, limits });
window.__voicePeers = engine.peers; // для диагностики и автотестов
const friends = mountFriends(topbar, { inviteTarget: () => (engine.active ? 'voice' : null) });

// ---------- Лобби ----------
async function loadRooms() {
  try {
    const { rooms } = await api('/api/rooms/voice');
    $('rooms').innerHTML = rooms.length
      ? rooms.map((r) => `<div class="list-item"><div class="grow"><b>${esc(r.id)}</b><div class="muted small">${r.members}/${r.capacity} в комнате</div></div><button class="btn sm" data-room="${esc(r.id)}">Войти</button></div>`).join('')
      : '<p class="muted">Пока пусто. Создайте свою комнату!</p>';
    $('rooms').querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => joinRoom(b.dataset.room)));
  } catch (e) { $('rooms').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
$('refresh').addEventListener('click', loadRooms);
loadRooms();

$('effect').innerHTML = Object.entries(EFFECT_NAMES).map(([k, n]) => {
  const locked = !limits.voiceEffects.includes(k);
  return `<option value="${k}" ${locked ? 'disabled' : ''}>${n}${locked ? ' 🔒 Premium' : ''}</option>`;
}).join('');

// ---------- Карточки участников ----------
function peerCard(p, self = false) {
  const el = document.createElement('div');
  el.className = 'peer';
  el.dataset.peer = p.id;
  el.innerHTML = `
    <div class="avatar" style="background:${colorFor(p.username)}">${esc(initials(p.username))}</div>
    <div class="name">${esc(p.username)}${self ? ' (вы)' : ''} ${p.premium ? '⭐' : ''}</div>
    <div class="state-ico"></div>
    ${self ? '' : '<input type="range" min="0" max="100" value="100" aria-label="Громкость">'}`;
  el.querySelector('input')?.addEventListener('input', (e) => engine.setPeerVolume(p.id, e.target.value / 100));
  return el;
}

function addPeerCard(p) {
  if (!document.querySelector(`[data-peer="${p.id}"]`)) $('peers').append(peerCard(p));
  updatePeerState(p.id, p);
  renderInfo();
}

function updatePeerState(id, st) {
  const el = document.querySelector(`[data-peer="${id}"] .state-ico`);
  if (!el) return;
  el.textContent = [st.muted ? '🔇 выкл. микрофон' : '', st.effect && st.effect !== 'none' ? `✨ ${EFFECT_NAMES[st.effect]}` : ''].filter(Boolean).join(' · ');
}

function renderInfo() {
  $('room-info').textContent = `${$('peers').children.length} в комнате · звук до ${limits.voiceBitrateKbps} кбит/с`;
}

// ---------- События движка ----------
let chat = null;

engine.addEventListener('joined', ({ detail: m }) => {
  $('lobby').classList.add('hidden');
  $('room-view').classList.remove('hidden');
  $('room-title').textContent = `# ${m.room}${m.private ? ' 🔒' : ''}`;
  $('peers').innerHTML = '';
  $('peers').append(peerCard({ id: m.selfId, username: account.user.username, premium: account.plan.id === 'premium' }, true));
  m.peers.forEach(addPeerCard);
  history.replaceState(null, '', `#room=${encodeURIComponent(m.room)}`);
  chat = chatWidget($('chat'), (text) => rt.send({ type: 'voice:chat', text }));
  chat.system(`Вы вошли в комнату ${m.room} (мест: ${m.capacity})`);
  updatePeerState(m.selfId, { muted: engine.muted, effect: engine.effect });
  renderInfo();
  friends.render();
});
engine.addEventListener('peer-joined', ({ detail: p }) => { chat?.system(`${p.username} присоединился`); addPeerCard(p); });
engine.addEventListener('peer-left', ({ detail: { peerId, info } }) => {
  if (info) chat?.system(`${info.username} вышел`);
  document.querySelector(`[data-peer="${peerId}"]`)?.remove();
  renderInfo();
});
engine.addEventListener('peer-state', ({ detail: m }) => updatePeerState(m.peerId, m));
engine.addEventListener('speaking', ({ detail: m }) => document.querySelector(`[data-peer="${m.peerId}"] .avatar`)?.classList.toggle('speaking', m.speaking));
engine.addEventListener('level', ({ detail: { level } }) => { $('level').style.width = `${level * 100}%`; });
engine.addEventListener('conn', ({ detail: { peerId, state } }) => {
  const card = document.querySelector(`[data-peer="${peerId}"]`);
  if (card) card.dataset.conn = state;
  if (state === 'failed') toast('Не удалось соединиться с участником. Возможно, нужна сеть получше.', 'bad');
});
engine.addEventListener('autoplay-blocked', () => toast('Нажмите в любом месте страницы, чтобы включить звук'));
document.addEventListener('click', () => { for (const p of engine.peers.values()) p.audioEl?.play().catch(() => {}); });

rt.on('voice:chat', (m) => chat?.add(m.from.username, m.text));
rt.on('error', (m) => {
  toast(m.message, 'bad');
  if (['room-full', 'bad-password', 'premium-required', 'bad-room'].includes(m.code) && $('room-view').classList.contains('hidden')) engine.abort();
});

// ---------- Действия ----------
async function joinRoom(name, password = '') {
  try {
    await engine.join(name, password);
  } catch {
    toast('Нет доступа к микрофону. Разрешите его в настройках браузера.', 'bad');
  }
}

function leaveRoom() {
  engine.leave();
  $('room-view').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
  friends.render();
  loadRooms();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(e.target.room.value.trim(), e.target.password.value);
});
$('leave').addEventListener('click', leaveRoom);
$('mute').addEventListener('click', () => {
  engine.setMuted(!engine.muted);
  $('mute').textContent = engine.muted ? '🔇' : '🎙️';
  $('mute').classList.toggle('danger', engine.muted);
  updatePeerState(engine.selfId, { muted: engine.muted, effect: engine.effect });
});
$('effect').addEventListener('change', (e) => {
  engine.setEffect(e.target.value);
  updatePeerState(engine.selfId, { muted: engine.muted, effect: e.target.value });
});

// Рация: микрофон включается, только пока зажат пробел или кнопка.
$('ptt').addEventListener('change', (e) => {
  engine.setPushToTalk(e.target.checked);
  $('ptt-hold').classList.toggle('hidden', !e.target.checked);
});
const talk = (on) => {
  engine.setTalking(on);
  $('ptt-hold').classList.toggle('talking', on && engine.pushToTalk);
};
$('ptt-hold').addEventListener('pointerdown', () => talk(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('ptt-hold').addEventListener(ev, () => talk(false));
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && engine.pushToTalk && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); talk(true); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') talk(false); });
window.addEventListener('blur', () => talk(false));

$('call-friends').addEventListener('click', () => friends.open());
$('invite').addEventListener('click', async () => {
  const link = `${publicUrl('/voice')}#room=${encodeURIComponent(engine.room)}&join=1`;
  try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch { prompt('Ссылка-приглашение:', link); }
});

// Ссылка-приглашение или приглашение от друга: #room=имя&join=1
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('room')) {
  $('room').value = params.get('room');
  if (params.get('join') === '1') joinRoom(params.get('room'));
}
