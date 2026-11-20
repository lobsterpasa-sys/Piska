import { api, ensureLogin, renderTopbar, Realtime, chatWidget, toast, esc, initials, colorFor } from '/shared/hub.js';

const EFFECT_NAMES = { none: 'Без эффекта', echo: 'Эхо', robot: 'Робот', radio: 'Рация', deep: 'Бас', chipmunk: 'Тонкий голос' };
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const $ = (id) => document.getElementById(id);
const account = await ensureLogin('voice');
renderTopbar('voice', account);
const limits = account.plan.limits;

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

// ---------- Звук: микрофон + эффекты ----------
let audio = null; // { ctx, mic, src, dest, track, analyser, chain }

function buildEffect(ctx, name) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodes = [];
  const add = (n) => { nodes.push(n); return n; };
  switch (name) {
    case 'echo': {
      const delay = add(ctx.createDelay(1)); delay.delayTime.value = 0.22;
      const fb = add(ctx.createGain()); fb.gain.value = 0.35;
      input.connect(output); input.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(output);
      break;
    }
    case 'robot': {
      // Кольцевая модуляция: голос умножается на низкочастотную синусоиду.
      const mod = add(ctx.createGain()); mod.gain.value = 0;
      const osc = add(ctx.createOscillator()); osc.frequency.value = 50; osc.connect(mod.gain); osc.start();
      input.connect(mod); mod.connect(output);
      break;
    }
    case 'radio': {
      const hp = add(ctx.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = 500;
      const lp = add(ctx.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 3000;
      const shaper = add(ctx.createWaveShaper());
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(3 * x); }
      shaper.curve = curve;
      input.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(output);
      break;
    }
    case 'deep': {
      const shelf = add(ctx.createBiquadFilter()); shelf.type = 'lowshelf'; shelf.frequency.value = 250; shelf.gain.value = 10;
      const lp = add(ctx.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 1200;
      input.connect(shelf); shelf.connect(lp); lp.connect(output);
      break;
    }
    case 'chipmunk': {
      const hp = add(ctx.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = 900;
      const peak = add(ctx.createBiquadFilter()); peak.type = 'peaking'; peak.frequency.value = 3500; peak.gain.value = 9;
      input.connect(hp); hp.connect(peak); peak.connect(output);
      break;
    }
    default: input.connect(output);
  }
  return { input, output, dispose() { nodes.forEach((n) => { try { n.stop?.(); n.disconnect(); } catch { /* */ } }); input.disconnect(); output.disconnect(); } };
}

async function startAudio() {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(mic);
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  audio = { ctx, mic, src, dest, analyser, track: dest.stream.getAudioTracks()[0], chain: null };
  setEffect('none');
  monitorLevel();
}

function setEffect(name) {
  if (!audio) return;
  if (audio.chain) { audio.src.disconnect(audio.chain.input); audio.chain.dispose(); }
  audio.chain = buildEffect(audio.ctx, name);
  audio.src.connect(audio.chain.input);
  audio.chain.output.connect(audio.dest);
}

let speaking = false;
function monitorLevel() {
  const data = new Uint8Array(audio.analyser.fftSize);
  const tick = () => {
    if (!audio) return;
    audio.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / data.length);
    $('level').style.width = `${Math.min(100, rms * 400)}%`;
    const now = rms > 0.04 && audio.track.enabled;
    if (now !== speaking) {
      speaking = now;
      rt?.send({ type: 'voice:speaking', speaking });
      document.querySelector(`[data-peer="${rt?.selfId}"] .avatar`)?.classList.toggle('speaking', speaking);
    }
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- WebRTC: звук напрямую между участниками ----------
let rt = null;
let roomName = null;
const peers = new Map(); // peerId -> { info, pc, audioEl, volume }
window.__voicePeers = peers; // для диагностики и автотестов

function peerCard(p, self = false) {
  const el = document.createElement('div');
  el.className = 'peer';
  el.dataset.peer = p.id;
  el.innerHTML = `
    <div class="avatar" style="background:${colorFor(p.username)}">${esc(initials(p.username))}</div>
    <div class="name">${esc(p.username)}${self ? ' (вы)' : ''} ${p.premium ? '⭐' : ''}</div>
    <div class="state-ico"></div>
    ${self ? '' : '<input type="range" min="0" max="100" value="100" aria-label="Громкость">'}`;
  el.querySelector('input')?.addEventListener('input', (e) => {
    const peer = peers.get(p.id);
    if (peer) { peer.volume = e.target.value / 100; if (peer.audioEl) peer.audioEl.volume = peer.volume; }
  });
  return el;
}

function updatePeerState(id, st) {
  const el = document.querySelector(`[data-peer="${id}"] .state-ico`);
  if (!el) return;
  el.textContent = [st.muted ? '🔇 выкл. микрофон' : '', st.effect && st.effect !== 'none' ? `✨ ${EFFECT_NAMES[st.effect]}` : ''].filter(Boolean).join(' · ');
}

function renderInfo() {
  $('room-info').textContent = `${peers.size + 1} в комнате · звук до ${limits.voiceBitrateKbps} кбит/с`;
}

function createPeer(info) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { info, pc, audioEl: null, volume: 1 };
  peers.set(info.id, peer);
  const sender = pc.addTrack(audio.track, audio.dest.stream);
  pc.onicecandidate = (e) => { if (e.candidate) rt.send({ type: 'voice:signal', to: info.id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    if (!peer.audioEl) {
      peer.audioEl = new Audio();
      peer.audioEl.autoplay = true;
      peer.audioEl.volume = peer.volume;
    }
    peer.audioEl.srcObject = e.streams[0];
    peer.audioEl.play().catch(() => toast('Нажмите в любом месте страницы, чтобы включить звук'));
  };
  pc.onconnectionstatechange = () => {
    const card = document.querySelector(`[data-peer="${info.id}"]`);
    if (card) card.dataset.conn = pc.connectionState;
    if (pc.connectionState === 'connected') {
      // Битрейт зависит от тарифа (Premium — более чистый звук).
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = limits.voiceBitrateKbps * 1000;
      sender.setParameters(params).catch(() => {});
    }
  };
  if (!document.querySelector(`[data-peer="${info.id}"]`)) $('peers').append(peerCard(info));
  updatePeerState(info.id, info);
  renderInfo();
  return peer;
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  if (p.audioEl) p.audioEl.srcObject = null;
  peers.delete(id);
  document.querySelector(`[data-peer="${id}"]`)?.remove();
  renderInfo();
}

async function callPeer(info) {
  const { pc } = createPeer(info);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  rt.send({ type: 'voice:signal', to: info.id, data: { sdp: pc.localDescription } });
}

async function onSignal({ from, data }) {
  let peer = peers.get(from);
  if (data.sdp) {
    if (data.sdp.type === 'offer') {
      if (!peer) peer = createPeer(knownPeers.get(from) ?? { id: from, username: '…' });
      await peer.pc.setRemoteDescription(data.sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      rt.send({ type: 'voice:signal', to: from, data: { sdp: peer.pc.localDescription } });
    } else if (peer) {
      await peer.pc.setRemoteDescription(data.sdp);
    }
  } else if (data.candidate && peer) {
    await peer.pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

const knownPeers = new Map();
let chat;

async function joinRoom(name, password = '') {
  if (!audio) {
    try { await startAudio(); } catch {
      toast('Нет доступа к микрофону. Разрешите его в настройках браузера.', 'bad');
      return;
    }
  }
  await audio.ctx.resume();
  roomName = name;
  rt = new Realtime();
  rt.on('error', (m) => {
    toast(m.message, 'bad');
    if (['room-full', 'bad-password', 'premium-required', 'bad-room'].includes(m.code) && !peers.size && $('room-view').classList.contains('hidden')) {
      rt.close(); rt = null;
    }
  });
  rt.on('voice:joined', async (m) => {
    $('lobby').classList.add('hidden');
    $('room-view').classList.remove('hidden');
    $('room-title').textContent = `# ${m.room}${m.private ? ' 🔒' : ''}`;
    $('peers').innerHTML = '';
    $('peers').append(peerCard({ id: m.selfId, username: account.user.username, premium: account.plan.id === 'premium' }, true));
    location.hash = `room=${encodeURIComponent(m.room)}`;
    chat = chatWidget($('chat'), (text) => rt.send({ type: 'voice:chat', text }));
    chat.system(`Вы вошли в комнату ${m.room} (мест: ${m.capacity})`);
    for (const p of m.peers) { knownPeers.set(p.id, p); await callPeer(p); }
    renderInfo();
  });
  rt.on('voice:peer-joined', ({ peer }) => {
    knownPeers.set(peer.id, peer);
    chat?.system(`${peer.username} присоединился`);
    if (!document.querySelector(`[data-peer="${peer.id}"]`)) $('peers').append(peerCard(peer));
  });
  rt.on('voice:peer-left', ({ peerId }) => {
    const p = knownPeers.get(peerId);
    if (p) chat?.system(`${p.username} вышел`);
    removePeer(peerId);
    knownPeers.delete(peerId);
  });
  rt.on('voice:signal', (m) => onSignal(m).catch((e) => console.warn('signal', e)));
  rt.on('voice:peer-state', (m) => updatePeerState(m.peerId, m));
  rt.on('voice:speaking', (m) => document.querySelector(`[data-peer="${m.peerId}"] .avatar`)?.classList.toggle('speaking', m.speaking));
  rt.on('voice:chat', (m) => chat?.add(m.from.username, m.text));
  rt.on('disconnect', () => { for (const id of [...peers.keys()]) removePeer(id); });
  rt.on('ready', () => { if (roomName) rt.send({ type: 'voice:join', room: roomName, password }); });
}

function leaveRoom() {
  rt?.send({ type: 'voice:leave' });
  rt?.close();
  rt = null;
  roomName = null;
  for (const id of [...peers.keys()]) removePeer(id);
  $('room-view').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
  loadRooms();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(e.target.room.value.trim(), e.target.password.value);
});
$('leave').addEventListener('click', leaveRoom);
$('mute').addEventListener('click', () => {
  if (!audio) return;
  audio.track.enabled = !audio.track.enabled;
  const muted = !audio.track.enabled;
  $('mute').textContent = muted ? '🔇' : '🎙️';
  $('mute').classList.toggle('danger', muted);
  rt?.send({ type: 'voice:state', muted });
  updatePeerState(rt?.selfId, { muted, effect: $('effect').value });
});
$('effect').addEventListener('change', (e) => {
  setEffect(e.target.value);
  rt?.send({ type: 'voice:state', effect: e.target.value });
  updatePeerState(rt?.selfId, { muted: !audio?.track.enabled, effect: e.target.value });
});
$('invite').addEventListener('click', async () => {
  const link = `${location.origin}/voice#room=${encodeURIComponent(roomName)}`;
  try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch { prompt('Ссылка-приглашение:', link); }
});

const fromHash = new URLSearchParams(location.hash.slice(1)).get('room');
if (fromHash) $('room').value = fromHash;
