// Генерация иконок Hub (PNG) из SVG через Chromium: node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(OUT, { recursive: true });

/** Иконка Hub: три точки цветов Voice, Watch и Boost на тёмном фоне. full=true — на весь квадрат (maskable). */
function hubSvg(full) {
  const r = full ? 0 : 112;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="30%" cy="20%" r="90%"><stop offset="0" stop-color="#262b45"/><stop offset="1" stop-color="#0b0d14"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="512" height="512" rx="${r}" fill="url(#g)"/>
  <g transform="translate(256 262) scale(${full ? 0.78 : 1})">
    <g filter="url(#glow)" opacity=".8">
      <circle cx="-86" cy="40" r="44" fill="#7c5cff"/><circle cx="0" cy="-60" r="44" fill="#ff4f8b"/><circle cx="86" cy="40" r="44" fill="#19d38a"/>
    </g>
    <path d="M-86 40 L0 -60 L86 40 Z" fill="none" stroke="#ffffff" stroke-opacity=".25" stroke-width="10" stroke-linejoin="round"/>
    <circle cx="-86" cy="40" r="40" fill="#7c5cff"/><circle cx="0" cy="-60" r="40" fill="#ff4f8b"/><circle cx="86" cy="40" r="40" fill="#19d38a"/>
  </g>
</svg>`;
}

writeFileSync(join(OUT, 'favicon.svg'), hubSvg(false));
const browser = await chromium.launch();
const page = await browser.newPage();
const targets = [
  ['hub-180.png', 180, false], ['hub-192.png', 192, false], ['hub-512.png', 512, false],
  ['hub-maskable-512.png', 512, true],
];
for (const [name, size, full] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${hubSvg(full)}`);
  // Для iOS фон должен быть непрозрачным (иначе углы станут чёрными) — у apple-touch-icon рисуем на весь квадрат.
  const opaque = name === 'hub-180.png';
  if (opaque) await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${hubSvg(true)}`);
  writeFileSync(join(OUT, name), await page.screenshot({ omitBackground: !opaque, type: 'png' }));
  console.log('icons/' + name);
}
await browser.close();
