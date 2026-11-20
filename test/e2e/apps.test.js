// Сквозные тесты в настоящем браузере (Chromium + Playwright).
// Микрофон эмулируется флагами Chromium, поэтому голосовой чат проверяется по-настоящему.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { startHub } from '../helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.E2E_SCREENSHOTS; // папка для скриншотов (необязательно)

let ctx;
let browser;
before(async () => {
  ctx = await startHub();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await ctx?.stop(); });

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

async function newUser(name) {
  const context = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ctx.base + '/');
  await page.click('[data-tab="register"]');
  await page.fill('#r-email', `${name}@e2e.dev`);
  await page.fill('#r-user', name);
  await page.fill('#r-pass', 'password123');
  await page.click('form[data-form="register"] button');
  await page.waitForSelector('#apps');
  return { context, page, errors };
}

test('единый аккаунт: регистрация один раз — вход во все три приложения + Premium', async () => {
  const { context, page, errors } = await newUser('e2e_main');
  await shot(page, '1-account');
  for (const app of ['voice', 'watch', 'boost']) {
    await page.goto(`${ctx.base}/${app}`);
    await page.waitForSelector('[data-testid="username"]');
    assert.equal(await page.locator('.overlay').count(), 0, `в ${app} не должно быть повторного входа`);
    assert.equal(await page.textContent('[data-testid="username"]'), 'e2e_main');
  }
  await page.goto(ctx.base + '/');
  for (const app of ['voice', 'watch', 'boost']) {
    assert.match(await page.textContent(`[data-testid="app-${app}"]`), /Подключено/);
  }
  await page.click('[data-testid="buy-premium"]');
  await page.waitForSelector('.badge.premium');
  await shot(page, '2-premium');
  // Premium сразу виден в другом приложении
  await page.goto(`${ctx.base}/voice`);
  await page.waitForSelector('.badge.premium');
  const robotDisabled = await page.locator('#effect option[value="robot"]').evaluate((o) => o.disabled);
  assert.equal(robotDisabled, false, 'эффекты Premium разблокированы');
  assert.deepEqual(errors, []);
  await context.close();
});

test('вход в приложение без аккаунта показывает форму, после входа — работает', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ctx.base}/boost`);
  await page.waitForSelector('.overlay');
  await page.fill('#l-login', 'e2e_main');
  await page.fill('#l-pass', 'password123');
  await page.click('form[data-form="login"] button');
  await page.waitForSelector('[data-testid="username"]');
  assert.equal(await page.locator('.overlay').count(), 0);
  await context.close();
});

test('Voice: два игрока слышат друг друга (WebRTC соединение установлено)', async () => {
  const a = await newUser('e2e_voice_a');
  const b = await newUser('e2e_voice_b');
  for (const u of [a, b]) {
    await u.page.goto(`${ctx.base}/voice`);
    await u.page.fill('#room', 'e2e-squad');
    await u.page.click('[data-testid="join-voice"]');
    await u.page.waitForSelector('#room-view:not(.hidden)');
  }
  // У каждого появляется карточка друга и соединение переходит в connected
  await a.page.waitForSelector('.peer[data-conn="connected"]', { timeout: 15000 });
  await b.page.waitForSelector('.peer[data-conn="connected"]', { timeout: 15000 });
  assert.equal(await a.page.locator('.peer').count(), 2);

  // Звук реально приходит: по WebRTC идут входящие аудиопакеты
  await a.page.waitForFunction(async () => {
    for (const { pc } of window.__voicePeers.values()) {
      const stats = await pc.getStats();
      for (const r of stats.values()) if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 1000) return true;
    }
    return false;
  }, null, { timeout: 10000, polling: 500 });

  // Чат комнаты
  await b.page.fill('#chat input', 'всем привет');
  await b.page.press('#chat input', 'Enter');
  await a.page.waitForSelector('text=всем привет');

  // Отключение микрофона видно другому
  await b.page.click('[data-testid="mute"]');
  await a.page.waitForSelector('text=выкл. микрофон');
  await shot(a.page, '3-voice');

  await b.page.click('#leave');
  await a.page.waitForFunction(() => document.querySelectorAll('.peer').length === 1);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.context.close();
  await b.context.close();
});

test('Watch: участники, очередь и чат синхронизируются', async () => {
  const a = await newUser('e2e_watch_a');
  const b = await newUser('e2e_watch_b');
  for (const u of [a, b]) {
    await u.page.goto(`${ctx.base}/watch`);
    await u.page.fill('#room', 'e2e-cinema');
    await u.page.click('[data-testid="join-watch"]');
    await u.page.waitForSelector('#room-view:not(.hidden)');
  }
  await a.page.waitForFunction(() => document.querySelectorAll('[data-member]').length === 2);
  assert.match(await a.page.textContent('[data-testid="members"]'), /e2e_watch_a 👑/);

  await b.page.fill('[data-testid="url-input"]', 'https://youtu.be/dQw4w9WgXcQ');
  await b.page.click('button[value="queue-add"]');
  await a.page.waitForSelector('#queue >> text=youtu.be/dQw4w9WgXcQ');
  await a.page.waitForSelector('text=добавил видео в очередь');

  await a.page.fill('#chat input', 'запускаю');
  await a.page.press('#chat input', 'Enter');
  await b.page.waitForSelector('text=запускаю');
  await shot(a.page, '4-watch');

  // Ведущий включает режим «только ведущий» — у гостя он виден
  await a.page.check('#host-only');
  await b.page.waitForFunction(() => document.getElementById('host-only').checked);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.context.close();
  await b.context.close();
});

test('Boost: выбор игры, замер пинга, запуск ускорения и мониторинг', async () => {
  const u = await newUser('e2e_boost');
  await u.page.goto(`${ctx.base}/boost`);
  await u.page.click('[data-game="standoff2"]');
  await u.page.click('[data-testid="test-nodes"]');
  await u.page.waitForSelector('[data-node-row="local"] .metric.good', { timeout: 10000 });
  assert.equal(await u.page.isDisabled('[data-testid="boost"]'), false, 'лучший узел выбран автоматически');
  await u.page.click('[data-testid="boost"]');
  await u.page.waitForSelector('text=Сессия активна');
  await u.page.waitForFunction(() => /^\d+$/.test(document.getElementById('s-ping').textContent), null, { timeout: 5000 });
  await shot(u.page, '5-boost');
  await u.page.click('[data-testid="boost"]');
  await u.page.waitForSelector('text=Ускорение остановлено');
  assert.deepEqual(u.errors, []);
  await u.context.close();
});

test('мобильная вёрстка: нет горизонтальной прокрутки', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  for (const p of ['/', '/voice', '/watch', '/boost']) {
    await page.goto(ctx.base + p);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${p}: горизонтальный скролл ${overflow}px`);
  }
  await context.close();
});
