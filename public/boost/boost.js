import { api, ensureLogin, renderTopbar, mountFriends, toast, esc, apiUrl, pageUrl, IS_NATIVE } from '/shared/hub.js';

const $ = (id) => document.getElementById(id);
const account = await ensureLogin('boost');
mountFriends(renderTopbar('boost', account));

const PLATFORM = { pc: '💻 ПК', android: '🤖 Android', ios: '🍏 iOS', console: '🎮 Консоль' };
const STORE_KEY = 'boost.last';

const [{ games }, nodeData] = await Promise.all([api('/api/boost/games'), api('/api/boost/nodes')]);
const nodes = nodeData.nodes;
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { /* */ }
let selectedGame = games.find((g) => g.id === saved.game)?.id ?? null;
let selectedNode = nodes.find((n) => n.id === saved.node && !n.locked)?.id ?? null;
const results = new Map(); // nodeId -> { ping, jitter, loss }

// В приложении для Android ускорение выполняет нативный VPN-сервис (HubBoostPlugin).
const native = IS_NATIVE ? window.Capacitor?.Plugins?.HubBoost : null;
let installedPkgs = new Set();
if (native) {
  try {
    const all = games.flatMap((g) => g.android ?? []);
    installedPkgs = new Set((await native.installed({ packages: all })).packages);
  } catch { /* старое приложение без плагина */ }
}
const isInstalled = (g) => (g.android ?? []).some((p) => installedPkgs.has(p));

$('multipath').textContent = nodeData.multipath
  ? '⭐ Мультипуть включён: трафик дублируется по двум маршрутам для защиты от потерь.'
  : 'Премиум-узлы и мультипуть (защита от потерь) доступны в Premium.';

// ---------- Замер качества соединения ----------
async function probeOnce(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    await fetch(`${url}${url.includes('?') ? '&' : '?'}r=${Math.random()}`, { cache: 'no-store', signal: ctrl.signal, mode: 'cors' });
    return performance.now() - t0;
  } catch {
    return null; // потерян
  } finally {
    clearTimeout(timer);
  }
}

export function summarize(samples) {
  const ok = samples.filter((s) => s != null);
  const loss = samples.length ? (samples.length - ok.length) / samples.length : 1;
  if (!ok.length) return { ping: null, jitter: null, loss };
  const ping = ok.reduce((a, b) => a + b, 0) / ok.length;
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  jitter = ok.length > 1 ? jitter / (ok.length - 1) : 0;
  return { ping, jitter, loss };
}

const probeUrl = (n) => n.probeUrl ?? apiUrl('/api/boost/probe');

async function measure(node, count = 10) {
  await probeOnce(probeUrl(node)); // прогрев соединения
  const samples = [];
  for (let i = 0; i < count; i++) samples.push(await probeOnce(probeUrl(node)));
  return summarize(samples);
}

// Оценка узла: пинг важнее всего, но джиттер и потери сильно портят игру.
const score = (r) => (r.ping == null ? Infinity : r.ping + 2 * r.jitter + 500 * r.loss);
const cls = (v, good, mid) => (v == null ? '' : v <= good ? 'good' : v <= mid ? 'mid' : 'badv');

// ---------- Отрисовка ----------
function renderGames() {
  const q = $('search').value.trim().toLowerCase();
  const list = games.filter((g) => !q || g.name.toLowerCase().includes(q));
  if (native) list.sort((a, b) => Number(isInstalled(b)) - Number(isInstalled(a)));
  $('games').innerHTML = list
    .map((g) => `<button class="game ${g.id === selectedGame ? 'active' : ''}" data-game="${g.id}">
      <b>${esc(g.name)}</b><div class="plat">${native
        ? (isInstalled(g) ? '<span class="good">✓ установлена</span>' : g.android ? 'не установлена' : 'нет версии для Android')
        : g.platforms.map((p) => PLATFORM[p]).join(' · ')}</div></button>`).join('');
  $('games').querySelectorAll('[data-game]').forEach((b) => b.addEventListener('click', () => {
    selectedGame = b.dataset.game;
    persist();
    renderGames();
    renderSummary();
  }));
}

function renderNodes() {
  const best = [...results.entries()].filter(([id]) => !nodes.find((n) => n.id === id).locked).sort((a, b) => score(a[1]) - score(b[1]))[0]?.[0];
  $('nodes').innerHTML = nodes.map((n) => {
    const r = results.get(n.id);
    return `<div class="list-item node ${n.id === best ? 'best' : ''}" data-node-row="${n.id}">
      <div><b>${esc(n.name)}</b> ${n.premium ? '<span class="badge premium">Premium</span>' : ''}
        <div class="muted small">${esc(n.region.toUpperCase())}${n.id === best ? ' · <span class="good">лучший</span>' : ''}</div></div>
      <div class="metric ${cls(r?.ping, 60, 120)}">${r?.ping != null ? Math.round(r.ping) : '—'}<small>мс</small></div>
      <div class="metric hide-sm ${cls(r?.jitter, 10, 30)}">${r?.jitter != null ? Math.round(r.jitter) : '—'}<small>джиттер</small></div>
      <div class="metric hide-sm ${cls(r ? r.loss * 100 : null, 0, 2)}">${r ? Math.round(r.loss * 100) + '%' : '—'}<small>потери</small></div>
      ${n.locked
        ? `<a class="btn sm gold" href="${pageUrl('account')}">🔒</a>`
        : `<button class="btn sm ${n.id === selectedNode ? '' : 'ghost'}" data-node="${n.id}">${n.id === selectedNode ? '✓' : 'Выбрать'}</button>`}
    </div>`;
  }).join('');
  $('nodes').querySelectorAll('[data-node]').forEach((b) => b.addEventListener('click', () => {
    selectedNode = b.dataset.node;
    persist();
    renderNodes();
    renderSummary();
  }));
}

function renderSummary() {
  const g = games.find((x) => x.id === selectedGame);
  const n = nodes.find((x) => x.id === selectedNode);
  // Вне Android-приложения (iPhone, ПК) предлагаем ключ Hysteria 2, если узел его поддерживает.
  $('hy2-box').classList.toggle('hidden', Boolean(native) || !n?.hy2 || n.locked);
  $('hy2-result').classList.add('hidden');
  $('summary').textContent = g && n ? `${g.name} → ${n.name}` : 'Выберите игру и узел';
  $('boost').disabled = !(g && n);
}

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ game: selectedGame, node: selectedNode })); } catch { /* */ }
}

async function testAll() {
  $('test').disabled = true;
  $('test').textContent = 'Проверяем…';
  for (const n of nodes) {
    results.set(n.id, await measure(n, 8));
    renderNodes();
  }
  if (!selectedNode) {
    const best = [...results.entries()].filter(([id]) => !nodes.find((n) => n.id === id).locked).sort((a, b) => score(a[1]) - score(b[1]))[0];
    if (best) { selectedNode = best[0]; persist(); renderNodes(); renderSummary(); }
  }
  $('test').disabled = false;
  $('test').textContent = 'Проверить пинг';
}

// ---------- Сессия ускорения + живой мониторинг ----------
let monitor = null;
let pingHistory = [];

function drawChart() {
  const c = $('chart');
  const ctx = c.getContext('2d');
  const w = c.width; const h = c.height;
  ctx.clearRect(0, 0, w, h);
  const vals = pingHistory.filter((v) => v != null);
  if (!vals.length) return;
  const max = Math.max(50, ...vals) * 1.2;
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#19d38a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pingHistory.forEach((v, i) => {
    const x = (i / 59) * w;
    const y = v == null ? h : h - (v / max) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  for (const [i, v] of pingHistory.entries()) {
    if (v == null) { ctx.fillStyle = '#ff5c7a'; ctx.fillRect((i / 59) * w - 2, h - 8, 4, 8); }
  }
}

function showStats(ping, jitter, loss) {
  $('s-ping').textContent = ping != null && ping >= 0 ? Math.round(ping) : '—';
  $('s-jitter').textContent = jitter != null ? Math.round(jitter) : '—';
  $('s-loss').textContent = `${Math.round((loss ?? 0) * 100)}%`;
}

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`);

/** Android: настоящее ускорение через VPN-сервис. */
async function startNativeBoost() {
  const game = games.find((g) => g.id === selectedGame);
  if (!isInstalled(game)) throw new Error(game.android ? 'Эта игра не установлена на телефоне' : 'У этой игры нет версии для Android');
  const session = await api('/api/boost/session', { method: 'POST', body: { gameId: selectedGame, nodeId: selectedNode } });
  await native.start({ host: session.node.host, port: session.node.udpPort, token: session.sessionToken, packages: game.android, game: game.name });
  $('boost').textContent = 'СТОП';
  $('boost').classList.add('on');
  $('session-info').textContent = 'Подключаемся к узлу…';
  pingHistory = [];
  monitor = setInterval(async () => {
    const st = await native.status();
    if (st.state === 'error') { stopBoost(); toast(st.error || 'Не удалось запустить ускорение', 'bad'); return; }
    if (st.state === 'stopped') { stopBoost(); return; }
    if (st.state === 'running') {
      pingHistory.push(st.rttMs >= 0 ? st.rttMs : null);
      if (pingHistory.length > 60) pingHistory.shift();
      showStats(st.rttMs, st.jitterMs, st.loss);
      drawChart();
      $('session-info').innerHTML = `⚡ Ускорение работает: <b>${esc(session.game.name)}</b> через узел <b>${esc(session.node.name)}</b>.<br>
        Запускайте игру. Трафик через узел: ↑ ${fmtBytes(st.upBytes)} · ↓ ${fmtBytes(st.downBytes)}.<br>
        <span class="muted">Пинг показан до узла. Через узел идёт UDP игры (матчи), лобби и загрузки — напрямую.</span>`;
    }
  }, 1000);
}

async function startBoost() {
  if (native) return startNativeBoost();
  const node = nodes.find((n) => n.id === selectedNode);
  const session = await api('/api/boost/session', { method: 'POST', body: { gameId: selectedGame, nodeId: selectedNode } });
  $('boost').textContent = 'СТОП';
  $('boost').classList.add('on');
  $('session-info').innerHTML = `✅ Сессия активна: <b>${esc(session.game.name)}</b> через узел <b>${esc(session.node.name)}</b> (${esc(session.node.host)}:${session.node.udpPort}).<br>
    В веб-версии выполняется подбор узла и контроль качества связи. Чтобы пустить игру через узел, используйте приложение Hub Boost для Android.`;
  pingHistory = [];
  monitor = setInterval(async () => {
    const v = await probeOnce(probeUrl(node), 1500);
    pingHistory.push(v);
    if (pingHistory.length > 60) pingHistory.shift();
    const s = summarize(pingHistory);
    showStats(s.ping, s.jitter, s.loss);
    drawChart();
  }, 1000);
}

function stopBoost() {
  if (native) native.stop().catch(() => {});
  clearInterval(monitor);
  monitor = null;
  $('boost').textContent = 'УСКОРИТЬ';
  $('boost').classList.remove('on');
  $('session-info').textContent = 'Ускорение остановлено.';
}

$('hy2-get').addEventListener('click', async () => {
  try {
    const p = await api('/api/boost/hy2/profile', { method: 'POST', body: { nodeId: selectedNode } });
    $('hy2-qr').innerHTML = p.qrSvg; // SVG сгенерирован нашим сервером
    $('hy2-uri').value = p.uri;
    $('hy2-result').classList.remove('hidden');
  } catch (e) { toast(e.message, 'bad'); }
});
$('hy2-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('hy2-uri').value); toast('Ключ скопирован'); } catch { $('hy2-uri').select(); }
});

$('boost').addEventListener('click', async () => {
  try { if (monitor) stopBoost(); else await startBoost(); } catch (e) { toast(e.message, 'bad'); }
});
$('test').addEventListener('click', testAll);
$('search').addEventListener('input', renderGames);

renderGames();
renderNodes();
renderSummary();

// Если ускорение уже работает (приложение открыли заново) — показываем его.
if (native) {
  native.status().then((st) => {
    if (st.state !== 'running') return;
    $('session-info').textContent = `⚡ Ускорение работает: ${st.game ?? ''}`;
    $('boost').textContent = 'СТОП';
    $('boost').classList.add('on');
    monitor = setInterval(async () => {
      const s2 = await native.status();
      if (s2.state !== 'running') { stopBoost(); return; }
      pingHistory.push(s2.rttMs >= 0 ? s2.rttMs : null);
      if (pingHistory.length > 60) pingHistory.shift();
      showStats(s2.rttMs, s2.jitterMs, s2.loss);
      drawChart();
    }, 1000);
  }).catch(() => {});
}
