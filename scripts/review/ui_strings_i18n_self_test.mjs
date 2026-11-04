/**
 * No hard-coded Chinese, Japanese or Korean text in the screens of the community edition (1.0.1): everything a user
 * reads goes through t() (src/i18n/locales, src/i18n/tr.ts) or s() (src/i18n/communityStrings.ts), so the app shows
 * one language. Before 1.0.1 the add-friend scan tab, the forward / PDF / download screens, the call screen, the
 * voice-message bubble and others showed Chinese in every language.
 *
 *   node scripts/review/ui_strings_i18n_self_test.mjs
 *
 * Files: what the community edition reaches — esbuild from src/main.tsx, the group-invite worker and the service worker
 * with @ext → src/ext/chat (as chat_edition_boundary does). A CJK letter (Han, kana, Hangul; not punctuation) fails in
 *   - a reached .tsx: JSX text, a JSX attribute (placeholder, title, aria-label, alt, …), and any other string or
 *     template literal (a label kept in a variable or returned by a helper is rendered all the same) — comments,
 *     console.* / devLog / devWarn / devError / diagLog arguments, imports and types excepted;
 *   - a reached .ts: an argument of alert / confirm / prompt (window.* too).
 * Not scanned: the translation tables (src/i18n/locales, communityStrings.ts) and the language picker's own names
 * (LANGUAGE_LABELS in src/i18n/types.ts, a .ts table — those stay in their own language on purpose).
 * Legitimately fixed texts inside the scanned code go into ALLOW (file → exact text). An entry that matches nothing
 * fails, so the list only shrinks.
 * Also (1.0.1): before the user has picked a language, the community edition starts in the device's language
 * (src/i18n/tr.ts deviceLanguage; the first screen, the server choice, comes before any language setting), the official
 * edition in Traditional Chinese as before.
 * Needs `npm ci` in packages/pwa (esbuild, typescript).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const pwa = path.join(root, 'packages/pwa');
const require = createRequire(path.join(pwa, 'package.json'));
const esbuild = require('esbuild');
const ts = require('typescript');

/** fixed texts allowed in the scanned code: 'src/…' path relative to packages/pwa → exact literal text */
const ALLOW = [
  // (none: the language names are in src/i18n/types.ts LANGUAGE_LABELS, the brand "AegisTalk" is Latin)
];

const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/;
const QUIET = /^(console\.\w+|devLog|devWarn|devError|devInfo|diagLog)$/;
const DIALOG = /^(window\.)?(alert|confirm|prompt)$/;
const SKIP = /^src\/i18n\/(locales\/|communityStrings\.ts$)/;

// ── what the community edition reaches ──
const SRC = path.join(pwa, 'src');
const ALIAS = {
  '@/': 'src/', '@components/': 'src/components/', '@config/': 'src/config/', '@hooks/': 'src/hooks/',
  '@services/': 'src/services/', '@stores/': 'src/stores/', '@types/': 'src/types/', '@utils/': 'src/utils/',
  '@plugins/': 'src/plugins/', '@wasm/': 'src/wasm/',
};
function resolveFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return base;
}
async function reachedFiles() {
  const extDir = path.join(SRC, 'ext/chat');
  const plugin = { name: 'chat-edition', setup(b) {
    b.onResolve({ filter: /^@ext(\/[\w]+)?$/ }, (a) => ({ path: resolveFile(path.join(extDir, a.path === '@ext' ? 'index' : a.path.slice(5))) }));
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === 'entry-point' || a.path.startsWith('.') || a.path.startsWith('/')) return null;
      for (const [k, v] of Object.entries(ALIAS)) if (a.path.startsWith(k)) return { path: resolveFile(path.join(pwa, v, a.path.slice(k.length))) };
      return { path: a.path, external: true };
    });
    b.onResolve({ filter: /wasm\/pkg\/|\.css$/ }, (a) => ({ path: a.path, external: true }));
  } };
  const res = await esbuild.build({
    entryPoints: ['main.tsx', 'services/groupInviteWorker.ts', 'sw-custom.ts'].map((e) => path.join(SRC, e)),
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', splitting: true, jsx: 'automatic',
    outdir: path.join(os.tmpdir(), 'ui-strings-i18n'), logLevel: 'silent', plugins: [plugin],
    loader: { '.json': 'json', '.png': 'empty', '.svg': 'empty', '.webp': 'empty', '.wav': 'empty', '.mp3': 'empty' },
    define: { 'import.meta.env': '{}', __BUILD_HASH__: '"ui-strings"' },
  });
  return Object.keys(res.metafile.inputs).map((p) => path.relative(pwa, path.resolve(process.cwd(), p)))
    .filter((p) => p.startsWith('src/') && /\.tsx?$/.test(p) && !SKIP.test(p)).sort();
}

// ── the scan ──
function calleeOf(node) {
  return ts.isCallExpression(node) ? node.expression.getText() : '';
}
/** the literal sits in an argument of console.* / devLog… (not shown), an import, or a type */
function quiet(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && QUIET.test(calleeOf(n))) return true;
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isLiteralTypeNode(n) || ts.isTypeNode(n)) return true;
  }
  return false;
}
function inDialog(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isCallExpression(n) && DIALOG.test(calleeOf(n))) return true;
  return false;
}
function kindOf(node) {
  if (ts.isJsxText(node)) return 'JSX text';
  let expr = false;
  for (let n = node.parent; n && !ts.isBlock(n) && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isJsxAttribute(n)) return `${n.name.getText()}=`;
    if (ts.isJsxExpression(n)) expr = true;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) break;
  }
  return expr ? 'JSX expression' : 'string';
}
/** findings of one source text: [{ line, kind, text }] */
function scanSource(file, text) {
  const tsx = file.endsWith('.tsx');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const add = (node, value) => {
    const t = value.replace(/\s+/g, ' ').trim();
    if (!CJK.test(t)) return;
    if (tsx ? quiet(node) : !inDialog(node)) return;
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind: tsx ? kindOf(node) : 'dialog', text: t });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) { if (tsx) add(node, node.text); }
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const failures = [];

// control: the scanner sees what it must and skips what it should (otherwise a PASS below would mean nothing)
const probe = scanSource('probe.tsx', [
  "export function P({ ok }: { ok: boolean }) {",
  "  console.log('記錄'); devWarn('警告');   // 註解：不算",
  "  const label = ok ? '好' : 'no';",
  "  alert(`檔案 ${label}`);",
  "  return <div title=\"標題\" aria-label={ok ? '關閉' : 'x'}>中文<span>{'文字'}</span>{label}English</div>;",
  "}",
].join('\n'));
const probeKinds = probe.map((f) => `${f.kind}:${f.text}`).sort();
const wantKinds = ['JSX expression:文字', 'JSX text:中文', 'aria-label=:關閉', 'string:好', 'string:檔案', 'title=:標題'].sort();
if (JSON.stringify(probeKinds) !== JSON.stringify(wantKinds)) failures.push(`control: the scanner found ${JSON.stringify(probeKinds)}, expected ${JSON.stringify(wantKinds)}`);
const probeTs = scanSource('probe.ts', "export const a = '標籤'; export function f() { window.alert('提醒'); confirm(`確定 ${a}`); console.error('錯誤'); }");
if (JSON.stringify(probeTs.map((f) => f.text)) !== JSON.stringify(['提醒', '確定'])) failures.push(`control: in a .ts only dialog arguments count, found ${JSON.stringify(probeTs)}`);

// first run: the device's language in the community edition (src/i18n/tr.ts + store.ts)
{
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-strings-tr-')), 'tr.mjs');
  await esbuild.build({ entryPoints: [path.join(SRC, 'i18n/tr.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  const { deviceLanguage, translate } = await import(pathToFileURL(out).href);
  const cases = [[['en-US'], 'en'], [['fr-FR', 'ja-JP'], 'ja'], [['ko'], 'ko'], [['zh-TW'], 'zh-TW'], [['zh-Hant-HK'], 'zh-TW'],
    [['zh-CN'], 'zh-CN'], [['zh-Hans-CN'], 'zh-CN'], [['zh-SG'], 'zh-CN'], [['fr-FR', 'de'], null], [[], null], [[''], null]];
  for (const [tags, want] of cases) {
    if (deviceLanguage(tags) !== want) failures.push(`deviceLanguage(${JSON.stringify(tags)}) = ${deviceLanguage(tags)}, expected ${want}`);
  }
  if (translate('en', 'addFriend.qrExpired') === 'addFriend.qrExpired' || translate('ko', 'nope.missing') !== 'nope.missing') failures.push('tr.translate: lookup / fallback broken');
  const store = fs.readFileSync(path.join(SRC, 'i18n/store.ts'), 'utf8');
  const def = store.slice(store.indexOf('function defaultLanguage()'), store.indexOf('function loadLanguage()'));
  if (!/__AEGIS_EDITION__ === 'chat'/.test(def) || !/if \(!chat \|\| typeof navigator === 'undefined'\) return 'zh-TW';/.test(def)
    || !/deviceLanguage\(navigator\.languages/.test(def)) failures.push('store.ts: defaultLanguage must use the device language in the chat edition only (official: zh-TW)');
  if (!/return defaultLanguage\(\);\n\}/.test(store)) failures.push('store.ts: loadLanguage must fall back to defaultLanguage() when nothing is saved');
}

const files = await reachedFiles();
const tsxFiles = files.filter((f) => f.endsWith('.tsx'));
for (const must of ['src/components/Verification/AddFriendModal.tsx', 'src/components/ChatRoom/ChatInput.tsx', 'src/ext/chat/ChatAuthScreen.tsx']) {
  if (!files.includes(must)) failures.push(`control: ${must} is not among the reached files (the reach computation is broken)`);
}

const used = new Set();
let found = 0;
for (const file of files) {
  for (const f of scanSource(file, fs.readFileSync(path.join(pwa, file), 'utf8'))) {
    const allowed = ALLOW.findIndex((a) => a.file === file && a.text === f.text);
    if (allowed >= 0) { used.add(allowed); continue; }
    found++;
    failures.push(`${file}:${f.line}  ${f.kind}  ${JSON.stringify(f.text)}`);
  }
}
ALLOW.forEach((a, i) => { if (!used.has(i)) failures.push(`stale ALLOW entry (matches nothing, remove it): ${a.file} ${JSON.stringify(a.text)}`); });

console.log(`scanned ${files.length} community-edition files (${tsxFiles.length} .tsx); ${ALLOW.length} allowed fixed text(s)`);
if (failures.length) {
  console.log(`hard-coded CJK text outside t() (${found}); use a key in src/i18n/locales (or communityStrings.ts), or add a legitimately fixed text to ALLOW:`);
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS no hard-coded Chinese / Japanese / Korean text in the community edition\'s screens (JSX text, attributes, literals in .tsx; alert / confirm / prompt in .ts)');
console.log('PASS first run: the community edition starts in the device\'s language (en / ja / ko / zh-TW / zh-CN, else zh-TW); the official edition in zh-TW');
