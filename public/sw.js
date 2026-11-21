// Service worker Hub: интерфейс открывается мгновенно и без сети.
// Стратегия «сначала сеть»: всегда свежая версия, а из кеша — только если сети нет.
const CACHE = 'hub-v2';
const SHELL = [
  '/', '/voice', '/watch', '/boost', '/offline.html',
  '/shared/style.css', '/shared/hub.js', '/shared/voice-engine.js',
  '/voice/voice.js', '/watch/watch.js', '/boost/boost.js',
  '/manifest.webmanifest', '/icons/favicon.svg', '/icons/hub-180.png', '/icons/hub-192.png', '/icons/hub-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API, WebSocket и чужие сайты не трогаем.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch {
      // Для переходов ищем по адресу без параметров (?from=… и т. п.).
      const cached = req.mode === 'navigate'
        ? await caches.match(url.origin + url.pathname, { ignoreVary: true })
        : await caches.match(req, { ignoreVary: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('/offline.html');
      return Response.error();
    }
  })());
});
