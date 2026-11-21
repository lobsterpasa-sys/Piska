import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.js';

let ctx;
before(async () => { ctx = await startHub({ env: { CORS_ORIGINS: 'https://hub.example.com' } }); });
after(() => ctx.stop());

test('CORS: мобильные приложения могут обращаться к API, чужие сайты — нет', async () => {
  for (const origin of ['https://localhost', 'capacitor://localhost', 'https://hub.example.com']) {
    const pre = await fetch(`${ctx.base}/api/me`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(pre.status, 204, origin);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  }
  const evil = await fetch(`${ctx.base}/api/plans`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});
