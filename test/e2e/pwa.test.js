// Веб-приложение Hub для iPhone (и любого телефона): установка на экран, нижнее меню, работа без сети.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startHub, register } from '../helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.E2E_SCREENSHOTS;

const IPHONE = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

let ctx; let browser;
before(async () => {
  ctx = await startHub();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await ctx?.stop(); });

const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test('манифест и иконки для установки на экран', async () => {
  const res = await fetch(`${ctx.base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.short_name, 'Hub');
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.shortcuts.map((s) => s.url), ['/voice', '/watch', '/boost']);
  for (const icon of m.icons) {
    const r = await fetch(ctx.base + icon.src);
    assert.equal(r.status, 200, icon.src);
    const [w, h] = pngSize(Buffer.from(await r.arrayBuffer()));
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  const apple = await fetch(`${ctx.base}/icons/hub-180.png`);
  assert.deepEqual(pngSize(Buffer.from(await apple.arrayBuffer())), [180, 180]);
  const html = await (await fetch(`${ctx.base}/voice`)).text();
  for (const tag of ['apple-mobile-web-app-capable', 'apple-touch-icon', 'viewport-fit=cover', 'rel="manifest"']) assert.ok(html.includes(tag), tag);
});

test('iPhone: подсказка «На экран Домой», нижнее меню, один вход на все разделы', async () => {
  const context = await browser.newContext(IPHONE);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const u = await register(ctx.base, 'iphone_user');
  await page.goto(`${ctx.base}/`);
  await page.evaluate((t) => localStorage.setItem('hub.token', t), u.token);
  await page.reload();
  await page.waitForSelector('#apps');

  assert.match(await page.textContent('#install'), /На экран „Домой“/);
  assert.equal(await page.locator('[data-testid="ios-install-hint"]').count(), 0, 'на главной — только карточка');
  assert.ok(await page.isVisible('.tabbar'));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-iphone-hub.png` });

  // В разделах — всплывающая подсказка; закрытая больше не появляется
  await page.click('.tabbar a[data-tab-link="voice"]');
  await page.waitForSelector('[data-testid="ios-install-hint"]');
  await page.click('[data-testid="ios-install-hint"] button');
  await page.reload();
  await page.waitForSelector('[data-testid="username"]');
  assert.equal(await page.locator('[data-testid="ios-install-hint"]').count(), 0);
  await page.click('.tabbar a[data-tab-link="account"]');
  await page.waitForSelector('#apps');

  for (const tab of ['voice', 'watch', 'boost']) {
    await page.click(`.tabbar a[data-tab-link="${tab}"]`);
    await page.waitForURL(new RegExp(`/${tab}$`));
    await page.waitForSelector('[data-testid="username"]');
    assert.equal(await page.locator('.overlay').count(), 0, `${tab}: без повторного входа`);
    assert.equal(await page.getAttribute(`.tabbar a[data-tab-link="${tab}"]`, 'class'), 'active');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${tab}: горизонтальная прокрутка ${overflow}px`);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/10-iphone-boost.png` });
  assert.deepEqual(errors, []);
  await context.close();
});

test('установленное приложение (с экрана «Домой») не показывает подсказку', async () => {
  const context = await browser.newContext(IPHONE);
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  await page.goto(`${ctx.base}/`);
  await page.waitForSelector('#auth');
  assert.equal(await page.locator('[data-testid="ios-install-hint"]').count(), 0);
  assert.ok(await page.locator('#install').evaluate((el) => el.classList.contains('hidden')));
  await context.close();
});

test('без интернета: интерфейс открывается из памяти, иначе — страница «Нет подключения»', async () => {
  const context = await browser.newContext(IPHONE);
  const page = await context.newPage();
  await page.goto(`${ctx.base}/voice`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // теперь страница под контролем service worker
  await page.evaluate(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);
  await page.goto(`${ctx.base}/watch`);
  assert.equal(await page.title(), 'Hub Watch');
  await page.goto(`${ctx.base}/voice?from=offline`);
  assert.equal(await page.title(), 'Hub Voice');
  await page.goto(`${ctx.base}/some/unknown/page`);
  assert.match(await page.textContent('h1'), /Нет подключения/);
  await context.setOffline(false);
  await context.close();
});
