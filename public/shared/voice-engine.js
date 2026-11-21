/**
 * Голосовой движок: микрофон → эффекты → WebRTC напрямую к каждому участнику.
 * Используется в Voice и в голосовом чате комнат Watch.
 */
import { api } from '/shared/hub.js';

export const EFFECT_NAMES = { none: 'Без эффекта', echo: 'Эхо', robot: 'Робот', radio: 'Рация', deep: 'Бас', chipmunk: 'Тонкий голос' };

let iceServersPromise = null;
function iceServers() {
  iceServersPromise ??= api('/api/config').then((c) => c.iceServers).catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
  return iceServersPromise;
}

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
  return {
    input, output,
    dispose() {
      nodes.forEach((n) => { try { n.stop?.(); n.disconnect(); } catch { /* уже отключён */ } });
      input.disconnect(); output.disconnect();
    },
  };
}

export class VoiceEngine extends EventTarget {
  /**
   * @param {object} o
   * @param {import('/shared/hub.js').Realtime} o.rt  общее WebSocket-соединение
   * @param {object} o.limits лимиты тарифа (битрейт)
   */
  constructor({ rt, limits }) {
    super();
    this.rt = rt;
    this.limits = limits;
    this.audio = null;
    this.room = null;
    this.password = '';
    this.selfId = null;
    this.peers = new Map(); // peerId -> { info, pc, audioEl, volume }
    this.known = new Map();
    this.muted = false;
    this.pttHeld = false;
    this.pushToTalk = false;
    this.effect = 'none';
    this.speaking = false;

    rt.on('voice:joined', (m) => this.#onJoined(m));
    rt.on('voice:peer-joined', ({ peer }) => { this.known.set(peer.id, peer); this.#emit('peer-joined', peer); });
    rt.on('voice:peer-left', ({ peerId }) => {
      const info = this.known.get(peerId);
      this.#removePeer(peerId);
      this.known.delete(peerId);
      this.#emit('peer-left', { peerId, info });
    });
    rt.on('voice:signal', (m) => this.#onSignal(m).catch((e) => console.warn('signal', e)));
    rt.on('voice:peer-state', (m) => this.#emit('peer-state', m));
    rt.on('voice:speaking', (m) => this.#emit('speaking', m));
    rt.on('disconnect', () => { for (const id of [...this.peers.keys()]) this.#removePeer(id); });
    // После переподключения (пропал интернет) возвращаемся в ту же комнату.
    rt.on('ready', () => { if (this.room) rt.send({ type: 'voice:join', room: this.room, password: this.password, ...this.opts }); });
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get active() { return Boolean(this.room); }

  async #startAudio() {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(mic);
    const dest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    this.audio = { ctx, mic, src, dest, analyser, track: dest.stream.getAudioTracks()[0], chain: null };
    this.setEffect(this.effect);
    this.#monitor();
  }

  /** opts.watch = true — голосовой чат комнаты просмотра с тем же названием. */
  async join(room, password = '', opts = {}) {
    if (!this.audio) await this.#startAudio(); // бросит исключение, если нет доступа к микрофону
    await this.audio.ctx.resume();
    this.room = room;
    this.password = password;
    this.opts = opts;
    this.#applyTrackEnabled();
    this.rt.send({ type: 'voice:join', room, password, ...opts });
  }

  leave() {
    if (!this.room) return;
    this.rt.send({ type: 'voice:leave' });
    this.room = null;
    for (const id of [...this.peers.keys()]) this.#removePeer(id);
    this.known.clear();
    // Освобождаем микрофон, чтобы не горел индикатор записи.
    if (this.audio) {
      this.audio.mic.getTracks().forEach((t) => t.stop());
      this.audio.ctx.close();
      this.audio = null;
    }
    this.#emit('left');
  }

  /** Сбросить комнату, если сервер отказал во входе. */
  abort() {
    this.room = null;
    if (this.audio) { this.audio.mic.getTracks().forEach((t) => t.stop()); this.audio.ctx.close(); this.audio = null; }
  }

  setEffect(name) {
    this.effect = name;
    if (!this.audio) return;
    const a = this.audio;
    if (a.chain) { a.src.disconnect(a.chain.input); a.chain.dispose(); }
    a.chain = buildEffect(a.ctx, name);
    a.src.connect(a.chain.input);
    a.chain.output.connect(a.dest);
    if (this.room) this.rt.send({ type: 'voice:state', effect: name });
  }

  setMuted(muted) {
    this.muted = muted;
    this.#applyTrackEnabled();
    if (this.room) this.rt.send({ type: 'voice:state', muted: this.#effectivelyMuted() });
  }

  /** Режим рации: микрофон работает только пока зажата кнопка (или пробел). */
  setPushToTalk(on) {
    this.pushToTalk = on;
    this.pttHeld = false;
    this.#applyTrackEnabled();
    if (this.room) this.rt.send({ type: 'voice:state', muted: this.#effectivelyMuted() });
  }

  setTalking(held) {
    if (!this.pushToTalk || this.pttHeld === held) return;
    this.pttHeld = held;
    this.#applyTrackEnabled();
  }

  #effectivelyMuted() { return this.muted || (this.pushToTalk && !this.pttHeld); }

  #applyTrackEnabled() {
    if (this.audio) this.audio.track.enabled = !this.#effectivelyMuted();
  }

  setPeerVolume(peerId, volume) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.volume = volume;
    if (p.audioEl) p.audioEl.volume = volume;
  }

  #monitor() {
    const a = this.audio;
    const data = new Uint8Array(a.analyser.fftSize);
    const tick = () => {
      if (this.audio !== a) return;
      a.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      this.#emit('level', { level: Math.min(1, rms * 4) });
      const now = rms > 0.04 && a.track.enabled;
      if (now !== this.speaking) {
        this.speaking = now;
        if (this.room) this.rt.send({ type: 'voice:speaking', speaking: now });
        this.#emit('speaking', { peerId: this.selfId, speaking: now });
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  async #onJoined(m) {
    this.selfId = m.selfId;
    this.#emit('joined', m);
    if (this.effect !== 'none') this.rt.send({ type: 'voice:state', effect: this.effect });
    if (this.#effectivelyMuted()) this.rt.send({ type: 'voice:state', muted: true });
    const ice = await iceServers();
    for (const p of m.peers) {
      this.known.set(p.id, p);
      const { pc } = this.#createPeer(p, ice);
      await pc.setLocalDescription(await pc.createOffer());
      this.rt.send({ type: 'voice:signal', to: p.id, data: { sdp: pc.localDescription } });
    }
  }

  #createPeer(info, ice) {
    const pc = new RTCPeerConnection({ iceServers: ice });
    const peer = { info, pc, audioEl: null, volume: 1 };
    this.peers.set(info.id, peer);
    const sender = pc.addTrack(this.audio.track, this.audio.dest.stream);
    pc.onicecandidate = (e) => { if (e.candidate) this.rt.send({ type: 'voice:signal', to: info.id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (!peer.audioEl) {
        peer.audioEl = new Audio();
        peer.audioEl.autoplay = true;
        peer.audioEl.volume = peer.volume;
      }
      peer.audioEl.srcObject = e.streams[0];
      peer.audioEl.play().catch(() => this.#emit('autoplay-blocked'));
    };
    pc.onconnectionstatechange = () => {
      this.#emit('conn', { peerId: info.id, state: pc.connectionState });
      if (pc.connectionState === 'connected') {
        // Битрейт зависит от тарифа (Premium — более чистый звук).
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = this.limits.voiceBitrateKbps * 1000;
        sender.setParameters(params).catch(() => {});
      }
    };
    return peer;
  }

  #removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.close();
    if (p.audioEl) p.audioEl.srcObject = null;
    this.peers.delete(id);
  }

  async #onSignal({ from, data }) {
    let peer = this.peers.get(from);
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!this.audio) return;
        if (!peer) peer = this.#createPeer(this.known.get(from) ?? { id: from, username: '…' }, await iceServers());
        await peer.pc.setRemoteDescription(data.sdp);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.rt.send({ type: 'voice:signal', to: from, data: { sdp: peer.pc.localDescription } });
      } else if (peer) {
        await peer.pc.setRemoteDescription(data.sdp);
      }
    } else if (data.candidate && peer) {
      await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}
