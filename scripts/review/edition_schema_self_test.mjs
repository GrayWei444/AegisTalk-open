/**
 * Edition tables in the shared durable DB (open-source step 7): services/database.ts registerEditionSchema.
 * Real database.ts (esbuild), CapacitorSQLite stubbed (native path), a made-up edition table:
 *   1. without a registration (the community edition) the DB opens with the shared schema only; migrations 7-9 run no
 *      statement and the schema version still reaches the latest one
 *   2. a registered edition table is created right after the shared schema, before the indexes and migrations
 *   3. the registered statements of migrations 7-9 run (old devices), the account tables are reported, and a failing
 *      v7 statement stops the start (critical) while a failing v8 statement does not
 * Run: node scripts/review/edition_schema_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'edschema-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@capacitor-community\/sqlite$|^\.\/capacitor$|^\.\/webStoreAtomicSave$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@capacitor-community/sqlite' ? `const log = () => globalThis.__sql;
      const ok = async () => ({});
      export const CapacitorSQLite = {
        closeConnection: ok, closeAllConnections: ok, close: ok, createConnection: ok, open: ok, setEncryptionSecret: ok,
        isSecretStored: async () => ({ result: true }),
        async execute({ statements }) {
          log().push(statements);
          for (const bad of globalThis.__failOn ?? []) if (statements.includes(bad)) throw new Error('no such thing: ' + bad);
          return { changes: { changes: 0 } };
        },
        async run({ statement, values }) { log().push(statement + ' ' + JSON.stringify(values ?? [])); return { changes: { changes: 0 } }; },
        async query() { return { values: [] }; },
      };`
    : a.path === './capacitor' ? 'export const isNativeApp = () => true;'
    : a.path === './webStoreAtomicSave' ? 'export const installAtomicSaveGuard = () => {}; export const saveAtomically = async (f) => f();'
    : 'export const devLog = () => {}; export const devWarn = () => {};' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/database.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'db.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
let fresh = 0;
const load = () => import(pathToFileURL(join(dir, 'db.mjs')).href + `?${++fresh}`);
console.error = () => {};
const latest = Number(/const SCHEMA_VERSION = (\d+);/.exec(require('node:fs').readFileSync(root + 'packages/pwa/src/services/database.ts', 'utf8'))[1]);
const versionWrites = (log) => log.filter((s) => s.includes("'schema_version'")).map((s) => JSON.parse(s.slice(s.indexOf('['))).at(-1));
const PROBE = 'CREATE TABLE IF NOT EXISTS edition_probe (id TEXT PRIMARY KEY)';

// 1
{
  globalThis.__sql = [];
  globalThis.__failOn = [];
  const db = await load();
  await db.initDatabase();
  const log = globalThis.__sql;
  assert.ok(log.some((s) => s.includes('CREATE TABLE IF NOT EXISTS contacts')), 'the shared schema ran');
  assert.ok(!log.some((s) => s.includes('edition_probe')), 'no edition table');
  assert.deepEqual(db.editionAccountTables(), [], 'no edition account tables');
  const v = versionWrites(log);
  assert.ok(v.includes('7') && v.includes('8') && v.includes('9') && v.at(-1) === String(latest), `versions 7-9 recorded, then ${latest}: ${v}`);
  console.log('PASS without a registration (community edition): shared schema only; migrations 7-9 record their version, nothing else');
}
// 2 + 3
{
  globalThis.__sql = [];
  globalThis.__failOn = [];
  const db = await load();
  db.registerEditionSchema({ tables: [PROBE], migrations: { 7: [PROBE], 8: ['DROP TABLE IF EXISTS edition_old_a'], 9: ['DROP TABLE IF EXISTS edition_old_b', 'DROP TABLE IF EXISTS edition_old_c'] }, accountTables: ['edition_probe'] });
  await db.initDatabase();
  const log = globalThis.__sql;
  const schema = log.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS contacts'));
  const table = log.findIndex((s) => s.trim() === PROBE + ';');
  const index = log.findIndex((s, i) => i > schema && s.includes('CREATE INDEX'));   // INDEX_SQL (the schema has its own indexes)
  assert.ok(schema >= 0 && table === schema + 1 && index > table, 'the edition table right after the shared schema, before the indexes');
  for (const s of ['DROP TABLE IF EXISTS edition_old_a;', 'DROP TABLE IF EXISTS edition_old_b;', 'DROP TABLE IF EXISTS edition_old_c;']) {
    assert.ok(log.includes(s), `migration statement ran: ${s}`);
  }
  assert.ok(log.filter((s) => s.trim() === PROBE + ';').length === 2, 'v7 created the table on an old device too');
  assert.deepEqual(db.editionAccountTables(), ['edition_probe']);
  assert.equal(versionWrites(log).at(-1), String(latest));
  console.log('PASS a registered edition table is created after the shared schema; its migrations 7-9 run; account tables reported');
}
{
  globalThis.__sql = [];
  globalThis.__failOn = ['edition_v7_fails'];
  const db = await load();
  db.registerEditionSchema({ tables: [], migrations: { 7: ['CREATE TABLE edition_v7_fails (x)'] }, accountTables: [] });
  await assert.rejects(db.initDatabase(), /Critical migration v7/, 'a failing v7 (core table) stops the start');
  globalThis.__sql = [];
  globalThis.__failOn = ['edition_v8_fails'];
  const db2 = await load();
  db2.registerEditionSchema({ tables: [], migrations: { 8: ['DROP TABLE edition_v8_fails'] }, accountTables: [] });
  await db2.initDatabase();
  assert.ok(!versionWrites(globalThis.__sql).includes('9'), 'a failing v8 stops the later migrations but not the start');
  console.log('PASS a failing edition v7 statement stops the start (critical); a failing v8 one only stops the later migrations');
}
