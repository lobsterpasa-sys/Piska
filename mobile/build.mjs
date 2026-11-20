#!/usr/bin/env node
/**
 * Сборка мобильных приложений Hub Voice / Hub Watch / Hub Boost (Capacitor, Android).
 *
 *   node mobile/build.mjs [voice|watch|boost|all] [--api=https://hub.example.com] [--apk]
 *
 * Без --apk — только готовит Android-проекты (их можно открыть в Android Studio).
 * С --apk — ещё и собирает отладочные APK в mobile/dist/ (нужен Android SDK: ANDROID_HOME).
 * --api — адрес сервера Hub. По умолчанию http://10.0.2.2:3000 (это ваш компьютер из эмулятора Android).
 */
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
function patchManifest(app, dir, apiBase) {
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

  // Android 11+: чтобы видеть, какие ещё приложения Hub установлены.
  if (!xml.includes('<queries>')) {
    const others = Object.entries(APPS).filter(([k]) => k !== app).map(([, a]) => a.scheme);
    const intents = others.map((s) => `        <intent>\n            <action android:name="android.intent.action.VIEW" />\n            <data android:scheme="${s}" />\n        </intent>`).join('\n');
    xml = xml.replace('<application', `<queries>\n${intents}\n    </queries>\n\n    <application`);
  }

  // Локальный сервер для разработки работает по http.
  if (apiBase.startsWith('http://') && !xml.includes('usesCleartextTraffic')) {
    xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  }
  writeFileSync(path, xml);
}

function main() {
const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'all';
const apiBase = (args.find((a) => a.startsWith('--api='))?.slice(6) ?? 'http://10.0.2.2:3000').replace(/\/$/, '');
const buildApk = args.includes('--apk');
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
    android: { allowMixedContent: apiBase.startsWith('http://') },
    server: { androidScheme: 'https' },
  }, null, 2)}\n`);
  buildWww(app, dir, apiBase);

  const cap = join(ROOT, 'node_modules/@capacitor/cli/bin/capacitor');
  if (!existsSync(join(dir, 'android'))) run(process.execPath, [cap, 'add', 'android'], dir);
  run(process.execPath, [cap, 'sync', 'android'], dir);
  patchManifest(app, dir, apiBase);

  if (buildApk) {
    if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
      console.error('Для сборки APK задайте ANDROID_HOME (путь к Android SDK).');
      process.exit(1);
    }
    const android = join(dir, 'android');
    run(join(android, 'gradlew'), ['assembleDebug', '--no-daemon', '-q'], android);
    const apk = join(android, 'app/build/outputs/apk/debug/app-debug.apk');
    const out = join(MOBILE, 'dist', `hub-${app}-debug.apk`);
    copyFileSync(apk, out);
    console.log(`APK: ${out}`);
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
