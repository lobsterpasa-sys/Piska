#!/usr/bin/env node
/**
 * Сборка мобильного приложения Hub (Voice + Watch + Boost в одном) для Android, на Capacitor.
 *
 *   node mobile/build.mjs [--api=https://hub.example.com] [--apk] [--secure]
 *
 * Без --apk — только готовит Android-проект mobile/hub/android (его можно открыть в Android Studio).
 * С --apk — ещё и собирает отладочный APK в mobile/dist/ (нужен Android SDK: ANDROID_HOME).
 * --api — адрес сервера Hub. По умолчанию http://10.0.2.2:3000 (это ваш компьютер из эмулятора Android).
 *         В приложении адрес можно поменять на экране входа (⚙ Сервер).
 * --secure — сборка для публикации: только https, без http-трафика.
 */
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { GAMES } = await import(pathToFileURL(join(ROOT, 'server/src/boost/catalog.js')).href);
const MOBILE = join(ROOT, 'mobile');
const APP = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8'));
const DIR = join(MOBILE, 'hub');

const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: 'inherit', env: process.env });

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : [];
  });
}

/** Веб-часть приложения: те же страницы, что на сайте, + config.js с настройками. */
export function buildWww(dir, apiBase) {
  const www = join(dir, 'www');
  rmSync(www, { recursive: true, force: true });
  cpSync(join(ROOT, 'public'), www, { recursive: true });
  // Внутри приложения не нужны: установка на экран и service worker.
  for (const f of ['manifest.webmanifest', 'sw.js', 'offline.html']) rmSync(join(www, f), { force: true });

  writeFileSync(join(www, 'config.js'), `window.HUB_CONFIG = ${JSON.stringify({ native: true, apiBase })};\n`);

  // Главная страница Hub — account.html; index.html просто открывает её.
  writeFileSync(join(www, 'account.html'), readFileSync(join(www, 'index.html'), 'utf8'));
  writeFileSync(join(www, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP.name}</title><style>body{background:#0b0d14}</style>
<script>location.replace('/account.html' + location.hash);</script>\n`);

  for (const file of htmlFiles(www)) {
    let html = readFileSync(file, 'utf8');
    if (html.includes('/config.js')) continue;
    // config.js подключается раньше остальных скриптов; ссылка на манифест не нужна.
    html = html.replace(/<head>/i, '<head>\n  <script src="/config.js"></script>').replace(/\s*<link rel="manifest"[^>]*>/, '');
    writeFileSync(file, html);
  }
}

/** Нативный код (mobile/native) копируется в Android-проект при каждой сборке. */
function copyNative(dir) {
  const src = join(MOBILE, 'native');
  cpSync(join(src, 'java'), join(dir, 'android/app/src/main/java'), { recursive: true });
  const testDir = join(dir, 'android/app/src/test/java');
  rmSync(join(testDir, 'com/getcapacitor/myapp'), { recursive: true, force: true });
  cpSync(join(src, 'test'), testDir, { recursive: true });
}

/** Права, ссылки hubapp://, список игр и VPN-сервис в AndroidManifest.xml. */
function patchManifest(dir, secure) {
  const path = join(dir, 'android/app/src/main/AndroidManifest.xml');
  let xml = readFileSync(path, 'utf8');

  for (const p of ['android.permission.INTERNET', ...APP.permissions]) {
    if (!xml.includes(`"${p}"`)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
  }

  // hubapp://room?app=voice&name=squad — приглашения в комнаты открывают приложение.
  if (!xml.includes(`android:scheme="${APP.scheme}"`)) {
    xml = xml.replace(/(<activity[\s\S]*?<\/intent-filter>)/, `$1
            <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${APP.scheme}" />
            </intent-filter>`);
  }

  // Android 11+: чтобы Boost видел, какие игры установлены.
  xml = xml.replace(/\s*<queries>[\s\S]*?<\/queries>\n?/, '\n');
  const games = GAMES.flatMap((g) => g.android ?? []).map((pkg) => `        <package android:name="${pkg}" />`).join('\n');
  xml = xml.replace('<application', `<queries>\n${games}\n    </queries>\n\n    <application`);

  if (!xml.includes('BoostVpnService')) {
    xml = xml.replace('</application>', `    <service
            android:name=".boost.BoostVpnService"
            android:permission="android.permission.BIND_VPN_SERVICE"
            android:exported="false">
            <intent-filter>
                <action android:name="android.net.VpnService" />
            </intent-filter>
        </service>
    </application>`);
  }

  // Тестовые сборки разрешают http, чтобы подключаться к серверу на компьютере в той же Wi-Fi-сети.
  if (!secure && !xml.includes('usesCleartextTraffic')) {
    xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  }
  writeFileSync(path, xml);
}

/** Иконка Hub: три точки (Voice, Watch, Boost), как на сайте. */
function patchIcons(dir) {
  const res = join(dir, 'android/app/src/main/res');
  const dot = (cx, cy, color) => `<path android:fillColor="${color}" android:pathData="M${cx - 9},${cy} a9,9 0 1,0 18,0 a9,9 0 1,0 -18,0"/>`;
  writeFileSync(join(res, 'drawable/hub_icon_fg.xml'), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:strokeColor="#40FFFFFF" android:strokeWidth="2.5" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="M35,64 L54,42 L73,64 Z"/>
    ${dot(35, 64, '#7C5CFF')}
    ${dot(54, 42, '#FF4F8B')}
    ${dot(73, 64, '#19D38A')}
</vector>\n`);
  writeFileSync(join(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#151827</color>
</resources>\n`);
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    writeFileSync(join(res, 'mipmap-anydpi-v26', name), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/hub_icon_fg"/>
</adaptive-icon>\n`);
  }
  writeFileSync(join(res, 'drawable/hub_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item><color android:color="#0B0D14"/></item>
    <item android:width="160dp" android:height="160dp" android:gravity="center" android:drawable="@drawable/hub_icon_fg"/>
</layer-list>\n`);
  const styles = join(res, 'values/styles.xml');
  writeFileSync(styles, readFileSync(styles, 'utf8').replace('@drawable/splash<', '@drawable/hub_splash<'));
}

function main() {
  const args = process.argv.slice(2);
  const apiBase = (args.find((a) => a.startsWith('--api='))?.slice(6) ?? 'http://10.0.2.2:3000').replace(/\/$/, '');
  const buildApk = args.includes('--apk');
  const secure = args.includes('--secure');
  if (secure && !apiBase.startsWith('https://')) { console.error('С --secure адрес сервера должен быть https://'); process.exit(1); }

  console.log(`=== ${APP.name} (${APP.appId}) → API ${apiBase}`);
  mkdirSync(DIR, { recursive: true });
  mkdirSync(join(MOBILE, 'dist'), { recursive: true });
  // Capacitor ищет плагины по зависимостям в package.json; сами пакеты лежат в корневом node_modules.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const capDeps = Object.fromEntries(Object.entries(rootPkg.devDependencies).filter(([k]) => k.startsWith('@capacitor/') && k !== '@capacitor/cli'));
  writeFileSync(join(DIR, 'package.json'), `${JSON.stringify({ name: 'hub-mobile', private: true, dependencies: capDeps }, null, 2)}\n`);
  writeFileSync(join(DIR, 'capacitor.config.json'), `${JSON.stringify({
    appId: APP.appId,
    appName: APP.name,
    webDir: 'www',
    backgroundColor: '#0b0d14',
    android: { allowMixedContent: !secure },
    server: { androidScheme: 'https' },
  }, null, 2)}\n`);
  buildWww(DIR, apiBase);

  const cap = join(ROOT, 'node_modules/@capacitor/cli/bin/capacitor');
  if (!existsSync(join(DIR, 'android'))) run(process.execPath, [cap, 'add', 'android'], DIR);
  run(process.execPath, [cap, 'sync', 'android'], DIR);
  copyNative(DIR);
  patchManifest(DIR, secure);
  patchIcons(DIR);

  if (buildApk) {
    if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
      console.error('Для сборки APK задайте ANDROID_HOME (путь к Android SDK).');
      process.exit(1);
    }
    const android = join(DIR, 'android');
    run(join(android, 'gradlew'), ['testDebugUnitTest', 'assembleDebug', '--no-daemon', '-q'], android);
    const out = join(MOBILE, 'dist', 'hub-debug.apk');
    copyFileSync(join(android, 'app/build/outputs/apk/debug/app-debug.apk'), out);
    console.log(`APK: ${out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
