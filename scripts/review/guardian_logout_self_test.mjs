/**
 * 帳號離開這台時清掉版本留在原生端的資料：真的 services/guardianBackground.ts（esbuild），加上三個呼叫端的接線檢查。
 *   W5：原生的守護背景服務（MQTT 連線、30 天 refresh token）整個拿掉了 —— 它不處理收件箱上的任何訊息，
 *       只讓 broker 把每則收件箱訊息多排一份。伺服器端的守護憑證也拿掉了。
 *   現在：登出（exitChat）、被踢（wipeLocalKeys）、換機三條路都 await clearGuardianNativeData()；它跑版本註冊的清除
 *         （官方版：原生守護資料，見 guardian_logout_official_self_test.mjs），失敗不擋登出；社群版沒有註冊 → 什麼都不做。
 * 官方版的那一半（原生守護外掛的清除、官方版的註冊與 manifest）在 guardian_logout_official_self_test.mjs
 * （scripts/review/official-only.json）。
 * Run: node scripts/review/guardian_logout_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'guardlogout-'));
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/guardianBackground.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'g.mjs'), logLevel: 'silent' });
console.error = () => {};
const { clearGuardianNativeData, setNativeAccountDataCleaner } = await import(pathToFileURL(join(dir, 'g.mjs')));

let clears = 0;
let fail = false;
await clearGuardianNativeData();     // 沒有版本註冊（社群版）：什麼都不做、不丟例外
setNativeAccountDataCleaner(async () => { clears++; if (fail) throw new Error('boom'); });
await clearGuardianNativeData();
assert.equal(clears, 1, 'the registered cleanup runs');
fail = true;
await clearGuardianNativeData();     // 不丟例外、不擋登出
assert.equal(clears, 2);
fail = false;
setNativeAccountDataCleaner(null);
await clearGuardianNativeData();
assert.equal(clears, 2, 'unregistered: nothing is called');
console.log('PASS clearGuardianNativeData runs the edition\'s native cleanup, never blocks logout, and does nothing without one');

const src = (p) => readFileSync(root + p, 'utf8');
const app = src('packages/pwa/src/App.tsx');
const exitChat = app.slice(app.indexOf('const exitChat = useCallback'), app.indexOf('window.location.reload();', app.indexOf('const exitChat = useCallback')));
assert.match(exitChat, /await clearGuardianNativeData\(\);/, 'logout (exitChat) clears it before reloading');
const wipe = src('packages/pwa/src/services/deviceClaim.ts');
assert.match(wipe.slice(wipe.indexOf('export async function wipeLocalKeys')), /await clearGuardianNativeData\(\);/, 'kicked device (wipeLocalKeys) clears it');
const settings = src('packages/pwa/src/pages/SettingsPage.tsx');
const transfer = settings.slice(settings.indexOf("if (mode === 'transfer') {"), settings.indexOf('window.location.reload();', settings.indexOf("if (mode === 'transfer') {")));
assert.match(transfer, /await clearGuardianNativeData\(\);/, 'device transfer (old phone) clears it');
console.log('PASS logout, kick and device transfer all clear the native account data');

// 守護外掛只在官方版（開源第 5d 步：android/app/src/official），共用與社群版的原始碼都沒有
for (const set of ['main', 'chat']) {
  const java = root + `packages/pwa/android/app/src/${set}/java/com/aegisrd/talk`;
  const found = existsSync(java) ? readdirSync(java).filter((f) => /^Guardian/.test(f)) : [];
  assert.deepEqual(found, [], `no guardian plugin in the ${set} sources`);
}
assert.ok(!/^import\b/m.test(src('packages/pwa/src/services/guardianBackground.ts')), 'the shared cleanup hook imports no plugin (or anything else)');
assert.ok(!existsSync(root + 'packages/pwa/src/plugins/guardianService.ts'), 'the guardian plugin bridge is not in the shared plugins');

// 原生的背景服務整個拿掉了
for (const set of ['main', 'official', 'chat']) {
  const talk = `packages/pwa/android/app/src/${set}/kotlin/com/aegisrd/talk/`;
  for (const f of ['GuardianMqttService.kt', 'GuardianInbox.kt', 'BootReceiver.kt']) {
    assert.ok(!existsSync(root + talk + f), `${f} is gone (${set})`);
  }
}
assert.ok(!/GuardianMqttService|BootReceiver/.test(src('packages/pwa/android/app/src/main/AndroidManifest.xml')),
  'the main manifest declares neither the guardian service nor the boot receiver');
assert.ok(!existsSync(root + 'packages/pwa/src/services/guardianCredential.ts'), 'no client asks for a guardian credential');
console.log('PASS no guardian plugin or native guardian MQTT service in the shared or community sources');
