// Проверка сборки приложения Hub для Android в браузере: страницы приложения раздаются с одного адреса
// (как внутри приложения), а API и WebSocket — на другом (сервер Hub).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import { startHub, register } from '../helpers.js';
import { buildWww } from '../../mobile/build.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let ctx; let browser; let shell; let shellBase; let tmp;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'hub-mobile-'));
  const app = express();
  shell = http.createServer(app);
  await new Promise((r) => shell.listen(0, '127.0.0.1', r));
  shellBase = `http://127.0.0.1:${shell.address().port}`;
  ctx = await startHub({ env: { CORS_ORIGINS: shellBase } });
  buildWww(tmp, ctx.base);
  app.use(express.static(join(tmp, 'www')));
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => {
  await browser?.close();
  await ctx?.stop();
  await new Promise((r) => shell.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('сборка Hub: всё в одном приложении, без манифеста и service worker', () => {
  for (const f of ['account.html', 'voice/index.html', 'watch/index.html', 'boost/index.html', 'config.js']) assert.ok(existsSync(join(tmp, 'www', f)), f);
  for (const f of ['sw.js', 'manifest.webmanifest']) assert.ok(!existsSync(join(tmp, 'www', f)), f);
});

test('приложение Hub: вход один раз, переходы между разделами, API на другом сервере', async () => {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await register(ctx.base, 'mob_user');

  await page.goto(`${shellBase}/`);
  await page.waitForURL(/\/account\.html/);
  await page.fill('#l-login', 'mob_user');
  await page.fill('#l-pass', 'password123');
  await page.click('form[data-form="login"] button');
  await page.waitForSelector('#apps');

  // Нижнее меню ведёт на страницы внутри приложения
  const tabs = await page.$$eval('.tabbar a', (as) => as.map((a) => a.getAttribute('href')));
  assert.deepEqual(tabs, ['/account.html', '/voice/index.html', '/watch/index.html', '/boost/index.html']);
  assert.ok(await page.isVisible('.tabbar'));

  await page.click('.tabbar a[data-tab-link="voice"]');
  await page.waitForURL(/\/voice\/index\.html/);
  await page.waitForSelector('[data-testid="username"]');
  assert.equal(await page.locator('.overlay').count(), 0, 'повторный вход не нужен');
  await page.fill('#room', 'mobile-room');
  await page.click('[data-testid="join-voice"]');
  await page.waitForSelector('#room-view:not(.hidden)');
  const link = await page.evaluate(async () => (await import('/shared/hub.js')).publicUrl('/voice'));
  assert.equal(link, `${ctx.base}/voice`, 'ссылка-приглашение ведёт на сайт');

  await page.click('.tabbar a[data-tab-link="watch"]');
  await page.waitForSelector('[data-testid="join-watch"]');
  await page.click('.tabbar a[data-tab-link="boost"]');
  await page.waitForSelector('[data-game="standoff2"]');
  assert.deepEqual(errors, []);
  await context.close();
});

test('ссылка-приглашение hubapp:// открывает нужную комнату', async () => {
  const u = await register(ctx.base, 'mob_link');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${shellBase}/account.html`);
  await page.evaluate((t) => localStorage.setItem('hub.token', t), u.token);
  const hub = await page.evaluateHandle(() => import('/shared/hub.js'));
  assert.deepEqual(
    await page.evaluate((m) => { const l = m.parseDeepLink('hubapp://room?app=watch&name=party'); return [l.action, l.params.get('app'), l.params.get('name')]; }, hub),
    ['room', 'watch', 'party'],
  );
  assert.equal(await page.evaluate((m) => m.parseDeepLink('https://evil.example.com'), hub), null);
  await page.evaluate((m) => m.handleDeepLink('hubapp://room?app=watch&name=party'), hub);
  await page.waitForURL(/\/watch\/index\.html#room=party&join=1/);
  await page.waitForSelector('#room-view:not(.hidden)');
  assert.match(await page.textContent('#room-title'), /party/);
  await context.close();
});
