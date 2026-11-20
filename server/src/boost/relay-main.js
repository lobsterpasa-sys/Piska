// Запуск отдельного узла ускорителя на VPS: `RELAY_SECRET=... RELAY_PORT=40000 npm run relay`
// RELAY_SECRET должен совпадать с HUB_SECRET основного сервера.
import { UdpRelay } from './relay.js';

const secret = process.env.RELAY_SECRET ?? process.env.HUB_SECRET;
if (!secret) {
  console.error('Укажите RELAY_SECRET (тот же, что HUB_SECRET на основном сервере)');
  process.exit(1);
}
const relay = new UdpRelay({ secret, port: Number(process.env.RELAY_PORT ?? 40000) });
const port = await relay.start();
console.log(`Boost relay node слушает UDP :${port}`);
