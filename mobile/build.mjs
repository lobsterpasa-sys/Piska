#!/usr/bin/env node
/**
 * Сборка мобильных приложений Hub Voice / Hub Watch / Hub Boost (Capacitor, Android).
 *
 *   node mobile/build.mjs [voice|watch|boost|all] [--api=https://hub.example.com] [--apk]
 *
 * Без --apk — только готовит Android-проекты (их можно открыть в Android Studio).
 * С --apk — ещё и собирает отладочные APK в mobile/dist/ (нужен Android SDK: ANDROID_HOME).
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
const APPS = JSON.parse(readFileSync(join(MOBILE, 'apps.json'), 'utf8'));


const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: 'inherit', env: process.env });

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : [];
  });
}

/** Веб-часть приложения: те же страницы, что на сайте, + config.js с настройками. */
export function buildWww(app, dir, apiBase) {
  const www = join(dir, 'www');
  rmSync(www, { recursive: true, force: true });
  cpSync(join(ROOT, 'public'), www, { recursive: true });
  // В приложение кладём только своё приложение и страницу аккаунта.
  for (const other of Object.keys(APPS)) if (other !== app) rmSync(join(www, other), { recursive: true, force: true });
  rmSync(join(www, 'manifest.webmanifest'), { force: true });

  const config = { native: true, app, apiBase, scheme: APPS[app].scheme };
  writeFileSync(join(www, 'config.js'), `window.HUB_CONFIG = ${JSON.stringify(config)};\n`);

  // Страница аккаунта — account.html, а стартовая страница сразу открывает приложение.
  const account = readFileSync(join(www, 'index.html'), 'utf8');
  writeFileSync(join(www, 'account.html'), account);
  writeFileSync(join(www, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APPS[app].name}</title><style>body{background:#0b0d14}</style>
<script>location.replace('/${app}/index.html' + location.hash);</script>\n`);

  // config.js подключается раньше остальных скриптов на каждой странице.
  for (const file of htmlFiles(www)) {
    const html = readFileSync(file, 'utf8');
    if (html.includes('/config.js')) continue;
    writeFileSync(file, html.replace(/<head>/i, '<head>\n  <script src="/config.js"></script>'));
  }
}

/** Права и глубокие ссылки в AndroidManifest.xml. */
/** Нативный код (mobile/native/<app>) копируется в Android-проект при каждой сборке. */
function copyNative(app, dir) {
  const src = join(MOBILE, 'native', app);
  if (!existsSync(src)) return;
  const pkgPath = APPS[app].appId.replace(/\./g, '/');
  if (existsSync(join(src, 'java'))) cpSync(join(src, 'java'), join(dir, 'android/app/src/main/java'), { recursive: true });
  if (existsSync(join(src, 'test'))) {
    rmSync(join(dir, 'android/app/src/test/java', pkgPath, 'ExampleUnitTest.java'), { force: true });
    cpSync(join(src, 'test'), join(dir, 'android/app/src/test/java'), { recursive: true });
  }
}

function patchManifest(app, dir, secure) {
  const path = join(dir, 'android/app/src/main/AndroidManifest.xml');
  let xml = readFileSync(path, 'utf8');
  const { scheme, permissions = [] } = APPS[app];

  const perms = ['android.permission.INTERNET', ...permissions];
  for (const p of perms) {
    if (!xml.includes(`"${p}"`)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
  }

  // hubvoice://… открывает это приложение (вход через другое приложение Hub, приглашения в комнаты).
  if (!xml.includes(`android:scheme="${scheme}"`)) {
    xml = xml.replace(/(<activity[\s\S]*?<\/intent-filter>)/, `$1
            <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${scheme}" />
            </intent-filter>`);
  }

  // Android 11+: чтобы видеть, какие ещё приложения Hub (и для Boost — какие игры) установлены.
  xml = xml.replace(/\s*<queries>[\s\S]*?<\/queries>\n?/, '\n');
  {
    const others = Object.entries(APPS).filter(([k]) => k !== app).map(([, a]) => a.scheme);
    const intents = others.map((s) => `        <intent>\n            <action android:name="android.intent.action.VIEW" />\n            <data android:scheme="${s}" />\n        </intent>`).join('\n');
    const games = app === 'boost' ? GAMES.flatMap((g) => g.android ?? []).map((pkg) => `\n        <package android:name="${pkg}" />`).join('') : '';
    xml = xml.replace('<application', `<queries>\n${intents}${games}\n    </queries>\n\n    <application`);
  }

  // VPN-сервис ускорителя.
  if (app === 'boost' && !xml.includes('BoostVpnService')) {
    xml = xml.replace('</application>', `    <service
            android:name=".BoostVpnService"
            android:permission="android.permission.BIND_VPN_SERVICE"
            android:exported="false">
            <intent-filter>
                <action android:name="android.net.VpnService" />
            </intent-filter>
        </service>
    </application>`);
  }

  // Тестовые сборки разрешают http, чтобы подключаться к серверу на компьютере в той же Wi-Fi-сети.
  // Для публикации собирайте с --secure и сервером на https.
  if (!secure && !xml.includes('usesCleartextTraffic')) {
    xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  }
  writeFileSync(path, xml);
}

// Простые векторные иконки: наушники, «play», молния — на фоне цвета приложения.
const ICON_PATHS = {
  voice: '<path android:strokeColor="#FFFFFF" android:strokeWidth="6" android:strokeLineCap="round" android:fillColor="#00000000" android:pathData="M36,64 L36,54 A18,18 0 0 1 72,54 L72,64"/>'
    + '<path android:fillColor="#FFFFFF" android:pathData="M30,58 h12 v20 h-8 a4,4 0 0 1 -4,-4 z M66,58 h12 v16 a4,4 0 0 1 -4,4 h-8 z"/>',
  watch: '<path android:fillColor="#FFFFFF" android:pathData="M45,36 L75,54 L45,72 Z"/>',
  boost: '<path android:fillColor="#FFFFFF" android:pathData="M60,28 L38,58 L52,58 L47,80 L70,48 L56,48 Z"/>',
};

function patchIcons(app, dir) {
  const res = join(dir, 'android/app/src/main/res');
  const { color } = APPS[app];
  writeFileSync(join(res, 'drawable/hub_icon_fg.xml'), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    ${ICON_PATHS[app]}
</vector>\n`);
  writeFileSync(join(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${color}</color>
</resources>\n`);
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    writeFileSync(join(res, 'mipmap-anydpi-v26', name), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/hub_icon_fg"/>
</adaptive-icon>\n`);
  }
  // Заставка при запуске: тёмный фон и иконка приложения.
  writeFileSync(join(res, 'drawable/hub_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item><color android:color="#0B0D14"/></item>
    <item android:width="96dp" android:height="96dp" android:gravity="center">
        <shape android:shape="oval"><solid android:color="${color}"/></shape>
    </item>
    <item android:width="96dp" android:height="96dp" android:gravity="center" android:drawable="@drawable/hub_icon_fg"/>
</layer-list>\n`);
  const styles = join(res, 'values/styles.xml');
  writeFileSync(styles, readFileSync(styles, 'utf8').replace('@drawable/splash<', '@drawable/hub_splash<'));
}

function main() {
const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'all';
const apiBase = (args.find((a) => a.startsWith('--api='))?.slice(6) ?? 'http://10.0.2.2:3000').replace(/\/$/, '');
const buildApk = args.includes('--apk');
const secure = args.includes('--secure');
if (secure && !apiBase.startsWith('https://')) { console.error('С --secure адрес сервера должен быть https://'); process.exit(1); }
const targets = which === 'all' ? Object.keys(APPS) : [which];
for (const t of targets) if (!APPS[t]) { console.error(`Неизвестное приложение: ${t}`); process.exit(1); }

mkdirSync(join(MOBILE, 'dist'), { recursive: true });
for (const app of targets) {
  const meta = APPS[app];
  const dir = join(MOBILE, app);
  console.log(`\n=== ${meta.name} (${meta.appId}) → API ${apiBase}`);
  mkdirSync(dir, { recursive: true });
  // Capacitor ищет плагины по зависимостям в package.json; сами пакеты лежат в корневом node_modules.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const capDeps = Object.fromEntries(Object.entries(rootPkg.devDependencies).filter(([k]) => k.startsWith('@capacitor/') && k !== '@capacitor/cli'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `hub-${app}-mobile`, private: true, dependencies: capDeps }, null, 2)}\n`);
  writeFileSync(join(dir, 'capacitor.config.json'), `${JSON.stringify({
    appId: meta.appId,
    appName: meta.name,
    webDir: 'www',
    backgroundColor: '#0b0d14',
    android: { allowMixedContent: !secure },
    server: { androidScheme: 'https' },
  }, null, 2)}\n`);
  buildWww(app, dir, apiBase);

  const cap = join(ROOT, 'node_modules/@capacitor/cli/bin/capacitor');
  if (!existsSync(join(dir, 'android'))) run(process.execPath, [cap, 'add', 'android'], dir);
  run(process.execPath, [cap, 'sync', 'android'], dir);
  copyNative(app, dir);
  patchManifest(app, dir, secure);
  patchIcons(app, dir);

  if (buildApk) {
    if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
      console.error('Для сборки APK задайте ANDROID_HOME (путь к Android SDK).');
      process.exit(1);
    }
    const android = join(dir, 'android');
    const tasks = existsSync(join(MOBILE, 'native', app, 'test')) ? ['testDebugUnitTest', 'assembleDebug'] : ['assembleDebug'];
    run(join(android, 'gradlew'), [...tasks, '--no-daemon', '-q'], android);
    const apk = join(android, 'app/build/outputs/apk/debug/app-debug.apk');
    const out = join(MOBILE, 'dist', `hub-${app}-debug.apk`);
    copyFileSync(apk, out);
    console.log(`APK: ${out}`);
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
