/**
 * The 4-phone simulation decides which edition it runs from the build's edition marker (open-source step 6), not from a
 * broker URL: packages/pwa/vite.config.ts writes dist/aegis-edition.json ({"edition": "chat" | "official"}) and
 * scripts/sim/lib/profiles.mjs profileForBuild reads it. Real profiles.mjs, temporary dist / source folders:
 *   1. marker chat → the community profile (sim chat server, invite registration), whatever else is in the tree
 *   2. marker official → the AegisTalk profile; its default server's broker must be the one the simulator intercepts
 *   3. the requested edition (--edition, .sim-edition) differs from the marker → refused (wrong build), same → fine
 *   4. no marker (群星, AegisTalk before step 5d) → the broker hard-coded in mqtt.ts decides the app, as before
 *   5. a marker with an unknown edition → refused
 *   6. run.mjs and prepare.sh use the marker (no edition guess from the broker URL)
 * Run: node scripts/review/sim_edition_marker_self_test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const { PROFILES, profileForBuild, readEditionMarker } = await import(pathToFileURL(root + 'scripts/sim/lib/profiles.mjs'));
const tmp = mkdtempSync(join(tmpdir(), 'simedition-'));
let n = 0;
/** a build folder (dist) with an optional marker and an app source folder with optional mqtt.ts / official default server */
function tree({ marker, broker, officialMqtt } = {}) {
  const dir = join(tmp, String(++n));
  const dist = join(dir, 'dist');
  const pwa = join(dir, 'pwa');
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(pwa, 'src/services'), { recursive: true });
  if (marker !== undefined) writeFileSync(join(dist, 'aegis-edition.json'), JSON.stringify({ edition: marker }) + '\n');
  writeFileSync(join(pwa, 'src/services/mqtt.ts'), broker ? `const config = { broker: '${broker}' };\n` : 'export const nothing = 1;\n');
  if (officialMqtt) {
    mkdirSync(join(pwa, 'src/ext-official'), { recursive: true });
    writeFileSync(join(pwa, 'src/ext-official/official-server.json'), JSON.stringify({ mqttUrl: officialMqtt }));
  }
  return { distDir: dist, pwaDir: pwa };
}

// 1
{
  const t = tree({ marker: 'chat' });
  assert.equal(readEditionMarker(t.distDir), 'chat');
  const r = profileForBuild(t);
  assert.equal(r.edition, 'chat');
  assert.equal(r.fromMarker, true);
  assert.equal(r.profile.id, 'aegistalk');
  assert.equal(r.profile.edition, 'chat');
  assert.equal(r.profile.registration, 'invite');
  assert.notEqual(r.profile.brokerUrl, PROFILES.aegistalk.brokerUrl, 'the community build talks to the sim chat server, not the official broker');
  // a chat build in the author's tree (official default server present) is still the chat edition
  assert.equal(profileForBuild(tree({ marker: 'chat', officialMqtt: PROFILES.aegistalk.brokerUrl })).edition, 'chat');
  console.log('PASS marker chat → community profile (sim chat server, invite registration), also in a tree that has the official edition');
}
// 2
{
  const r = profileForBuild(tree({ marker: 'official', officialMqtt: PROFILES.aegistalk.brokerUrl }));
  assert.deepEqual([r.edition, r.profile.id, r.profile.brokerUrl, r.profile.edition], ['official', 'aegistalk', PROFILES.aegistalk.brokerUrl, undefined]);
  assert.throws(() => profileForBuild(tree({ marker: 'official', officialMqtt: 'wss://mqtt.other.example/mqtt' })),
    /default server's broker/, 'an official default server the simulator would not intercept is refused');
  console.log('PASS marker official → AegisTalk profile; the official default broker must be the intercepted one');
}
// 3
{
  assert.throws(() => profileForBuild({ ...tree({ marker: 'official', officialMqtt: PROFILES.aegistalk.brokerUrl }), requested: 'chat' }), /--edition chat was asked for/);
  assert.throws(() => profileForBuild({ ...tree({ marker: 'chat' }), requested: 'official' }), /--edition official was asked for/);
  assert.equal(profileForBuild({ ...tree({ marker: 'chat' }), requested: 'chat' }).edition, 'chat');
  console.log('PASS a build of the other edition than --edition asked for is refused');
}
// 4（官方 App 的 broker 在私有的 scripts/sim/lib/profiles-official.mjs；公開的 repo 沒有 → 這段印 SKIP）
if (!PROFILES.aegisplay.brokerUrl) {
  assert.throws(() => profileForBuild(tree({ broker: 'wss://unknown.example/mqtt' })), /unknown app/);
  console.log('SKIP no marker → app told by the broker in mqtt.ts: the official apps\' brokers are in scripts/sim/lib/profiles-official.mjs, not in this checkout');
} else {
  const r = profileForBuild(tree({ broker: PROFILES.aegisplay.brokerUrl }));
  assert.deepEqual([r.profile.id, r.edition, r.fromMarker], ['aegisplay', 'official', false]);
  assert.throws(() => profileForBuild(tree({ broker: 'wss://unknown.example/mqtt' })), /unknown app/);
  console.log('PASS no marker → the app is still told by the broker in mqtt.ts (群星, older AegisTalk builds)');
}
// 5
{
  assert.throws(() => profileForBuild(tree({ marker: 'enterprise' })), /unknown edition/);
  console.log('PASS an unknown edition in the marker is refused');
}
// 6
{
  const run = readFileSync(root + 'scripts/sim/run.mjs', 'utf8');
  assert.match(run, /profileForBuild\(\{ pwaDir: PWA, distDir: DIST, requested \}\)/, 'run.mjs takes the edition from the build in dist');
  assert.ok(!/detectProfile|chatEditionProfile/.test(run), 'run.mjs no longer picks the profile itself');
  const vite = readFileSync(root + 'packages/pwa/vite.config.ts', 'utf8');
  assert.match(vite, /fileName: 'aegis-edition\.json', source: JSON\.stringify\(\{ edition: EDITION \}\)/, 'vite writes the marker the simulator reads');
  const prep = readFileSync(root + 'scripts/sim/prepare.sh', 'utf8');
  assert.match(prep, /the build wrote no aegis-edition\.json/, 'prepare.sh stops when the build has no marker');
  assert.match(prep, /the build is not the \$EDITION edition/, 'and when the marker is another edition');
  console.log('PASS run.mjs, prepare.sh and the vite build agree on dist/aegis-edition.json');
}
