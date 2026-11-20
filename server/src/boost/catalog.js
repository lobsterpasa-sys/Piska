/**
 * Каталог игр и узлов ускорителя.
 *
 * Как работает ускоритель (по образцу GearUP): трафик игры идёт не «как попало»
 * через загруженные маршруты провайдера, а на ближайший к игроку узел нашей сети,
 * и оттуда по хорошему каналу к игровому серверу. Каждый узел — это процесс
 * relay-main.js на VPS в нужном городе.
 *
 * Узлы задаются переменной окружения BOOST_NODES (JSON-массив). Без неё есть
 * только один узел — локальный, для разработки и тестов.
 */
// android — имена пакетов игры: приложение Boost пропускает через узел только их трафик.
export const GAMES = [
  { id: 'pubg-mobile', name: 'PUBG Mobile', platforms: ['android', 'ios'], regions: ['eu', 'me', 'asia'], android: ['com.tencent.ig'] },
  { id: 'cod-mobile', name: 'Call of Duty: Mobile', platforms: ['android', 'ios'], regions: ['eu', 'na', 'asia'], android: ['com.activision.callofduty.shooter'] },
  { id: 'standoff2', name: 'Standoff 2', platforms: ['android', 'ios'], regions: ['eu', 'ru'], android: ['com.axlebolt.standoff2'] },
  { id: 'cs2', name: 'Counter-Strike 2', platforms: ['pc'], regions: ['eu', 'ru', 'na'] },
  { id: 'dota2', name: 'Dota 2', platforms: ['pc'], regions: ['eu', 'ru', 'asia'] },
  { id: 'valorant', name: 'VALORANT', platforms: ['pc'], regions: ['eu', 'na', 'asia'] },
  { id: 'fortnite', name: 'Fortnite', platforms: ['pc', 'android', 'console'], regions: ['eu', 'na'], android: ['com.epicgames.fortnite'] },
  { id: 'genshin', name: 'Genshin Impact', platforms: ['pc', 'android', 'ios'], regions: ['eu', 'asia', 'na'], android: ['com.miHoYo.GenshinImpact'] },
  { id: 'roblox', name: 'Roblox', platforms: ['pc', 'android', 'ios'], regions: ['eu', 'na'], android: ['com.roblox.client'] },
  { id: 'minecraft', name: 'Minecraft', platforms: ['pc', 'android', 'ios'], regions: ['eu', 'na', 'ru'], android: ['com.mojang.minecraftpe'] },
];

export function loadNodes(env = process.env) {
  if (env.BOOST_NODES) {
    const nodes = JSON.parse(env.BOOST_NODES);
    if (!Array.isArray(nodes)) throw new Error('BOOST_NODES должен быть JSON-массивом');
    return nodes.map((n) => ({
      id: String(n.id),
      name: String(n.name ?? n.id),
      region: String(n.region ?? 'eu'),
      host: String(n.host),
      udpPort: Number(n.udpPort),
      probeUrl: n.probeUrl ? String(n.probeUrl) : null,
      premium: Boolean(n.premium),
    }));
  }
  return [
    {
      id: 'local',
      name: 'Локальный узел (dev)',
      region: 'local',
      host: '127.0.0.1',
      udpPort: Number(env.RELAY_PORT ?? 40000),
      probeUrl: null, // null = замер пинга через основной сервер
      premium: false,
    },
  ];
}
