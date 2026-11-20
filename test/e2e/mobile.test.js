// Проверка мобильной сборки в браузере: страницы приложения раздаются с одного адреса
// (как внутри приложения), а API и WebSocket — на другом (сервер Hub).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
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
  // Сервер приложения-оболочки (имитирует https://localhost внутри Capacitor).
  tmp = mkdtempSync(join(tmpdir(), 'hub-mobile-'));
  const app = express();
  shell = http.createServer(app);
  await new Promise((r) => shell.listen(0, '127.0.0.1', r));
  shellBase = `http://127.0.0.1:${shell.address().port}`;
  ctx = await startHub({ env: { CORS_ORIGINS: shellBase } });
  buildWww('voice', tmp, ctx.base);
  app.use(express.static(join(tmp, 'www')));
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => {
  await browser?.close();
  await ctx?.stop();
  await new Promise((r) => shell.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('мобильная сборка Voice: вход, API и WebSocket на другом сервере', async () => {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await register(ctx.base, 'mob_user');

  await page.goto(`${shellBase}/`);
  await page.waitForURL(/\/voice\/index\.html/);
  await page.waitForSelector('.overlay');
  await page.fill('#l-login', 'mob_user');
  await page.fill('#l-pass', 'password123');
  await page.click('form[data-form="login"] button');
  await page.waitForSelector('[data-testid="username"]');

  // В приложении нет соседних приложений — ссылки ведут на hubwatch:// и hubboost://
  const navLinks = await page.$$eval('.appnav a', (as) => as.map((a) => a.getAttribute('href')));
  assert.deepEqual(navLinks, ['/voice/index.html', 'hubwatch://open', 'hubboost://open']);
  assert.equal(await page.getAttribute('.brand', 'href'), '/account.html');

  await page.fill('#room', 'mobile-room');
  await page.click('[data-testid="join-voice"]');
  await page.waitForSelector('#room-view:not(.hidden)');
  // Ссылка-приглашение ведёт на сайт, а не на внутренний адрес приложения
  const link = await page.evaluate(async () => (await import('/shared/hub.js')).publicUrl('/voice'));
  assert.equal(link, `${ctx.base}/voice`);

  await page.goto(`${shellBase}/account.html`);
  await page.waitForSelector('#apps');
  assert.deepEqual(errors, []);
  await context.close();
});

test('вход через другое приложение Hub по глубокой ссылке с одноразовым кодом', async () => {
  const u = await register(ctx.base, 'mob_sso');
  // Приложение Watch (где пользователь уже вошёл) выдаёт код для Voice
  const res = await fetch(`${ctx.base}/api/auth/sso/code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: JSON.stringify({ app: 'voice' }),
  });
  const { code } = await res.json();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${shellBase}/account.html`);
  await page.waitForSelector('#auth');
  const hub = await page.evaluateHandle(() => import('/shared/hub.js'));
  assert.deepEqual(
    await page.evaluate((m) => { const l = m.parseDeepLink('hubvoice://sso-callback?code=abc'); return [l.app, l.action, l.params.get('code')]; }, hub),
    ['voice', 'sso-callback', 'abc'],
  );
  await page.evaluate(([m, c]) => m.handleDeepLink(`hubvoice://sso-callback?code=${c}`), [hub, code]);
  await page.waitForURL(/\/voice\/index\.html/);
  await page.waitForSelector('[data-testid="username"]');
  assert.equal(await page.textContent('[data-testid="username"]'), 'mob_sso');
  // Ссылка, адресованная другому приложению, игнорируется
  assert.equal(await page.evaluate(async () => { const m = await import('/shared/hub.js'); await m.handleDeepLink('hubwatch://sso-callback?code=x'); return location.pathname; }), '/voice/index.html');
  await context.close();
});
