import { createHub } from './app.js';

if (!process.env.HUB_SECRET) {
  console.warn('[hub] HUB_SECRET не задан — используется случайный ключ, после перезапуска все выйдут из аккаунтов.');
}
const hub = createHub({ dbFile: process.env.DB_FILE ?? 'data/hub.db' });
const port = await hub.start();
console.log(`[hub] Сервер запущен: http://localhost:${port}`);
console.log(`[hub]   Аккаунт: /   Voice: /voice   Watch: /watch   Boost: /boost`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await hub.stop(); process.exit(0); });
}
