/**
 * The community app allows no in-app navigation (security review L3).
 * Before: packages/pwa/capacitor.config.ts listed the official API, broker and web hosts in server.allowNavigation for both
 * editions. Capacitor 8 adds every allowNavigation origin to the origins its native bridge answers, so a chat link
 * (target="_blank") to one of those hosts could load inside the community app's WebView and call its plugins (ring context,
 * FCM token, share …). Now the community edition's list is empty; the official edition reads its own list from
 * src/ext-official/capacitor.json (not in the community repository), and capacitor.config.ts names no host at all, so the
 * export scan no longer needs to exempt it.
 * The real capacitor.config.ts, compiled the way the Capacitor CLI loads it (TypeScript → CommonJS, run with __dirname).
 *
 *   node scripts/review/capacitor_navigation_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const PWA = dirname(SRC);
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

const source = readFileSync(join(PWA, 'capacitor.config.ts'), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code;
/** what `cap sync` gets for an edition */
function configFor(edition) {
  const mod = { exports: {} };
  const env = { ...process.env };
  if (edition) env.AEGIS_EDITION = edition; else delete env.AEGIS_EDITION;
  new Function('require', 'module', 'exports', '__dirname', 'process', code)(require, mod, mod.exports, PWA, { env });
  return mod.exports.default ?? mod.exports;
}

check('community edition: no in-app navigation at all', () => {
  const cfg = configFor('chat');
  assert.deepEqual(cfg.server.allowNavigation, [], 'allowNavigation is empty');
  assert.equal(cfg.appId, process.env.AEGIS_CHAT_APP_ID || 'com.aegisrd.talk.community');
});

check('capacitor.config.ts names no host (the official list lives in src/ext-official)', () => {
  assert.doesNotMatch(source, /https?:\/\//, 'no URL in the file');
  const allowlist = join(root, 'scripts/oss/official-host-allowlist.txt');
  if (existsSync(allowlist)) {
    const entries = readFileSync(allowlist, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.ok(!entries.includes('packages/pwa/capacitor.config.ts'), 'not exempted from the export scan any more');
  }
});

const officialList = join(SRC, 'ext-official/capacitor.json');
if (existsSync(officialList)) {
  check('official edition: its own list from src/ext-official/capacitor.json', () => {
    const want = JSON.parse(readFileSync(officialList, 'utf8')).allowNavigation;
    assert.ok(Array.isArray(want) && want.length > 0);
    assert.deepEqual(configFor('official').server.allowNavigation, want);
    assert.deepEqual(configFor(undefined).server.allowNavigation, want, 'official is the default in this tree');
  });
} else {
  console.log('SKIP official edition navigation list: src/ext-official is not in this checkout');
  check('without src/ext-official an official build stops with a clear message', () => {
    assert.throws(() => configFor('official'), /AEGIS_EDITION=chat/);
  });
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS capacitor_navigation: the community app allows no in-app navigation; capacitor.config.ts names no host');
