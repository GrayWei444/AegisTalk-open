/**
 * W5 S13 找到的：等金鑰時打的群訊（送不出去、不退回上一代）要在資料庫裡標成失敗（failed），畫面才不會以為送出去了。
 * 以前「存一份」（status: 'sent'，不等它）跟「送不出去 → 標失敗」各自非同步：UPDATE 比 INSERT 先落地 → 那一列沒被改到，
 * 接著 INSERT 寫進 sent（模擬：Dave 等金鑰時打的那則在他的資料庫裡是 sent）。現在送不出去時先等那一份存完才標失敗。
 * 原始碼檢查（useGroupChat 是 React hook，打包要整個 App）：文字與語音兩條路都要先 await 存檔那一份；送的時候丟例外也要標（finally，W5 複審）
 * 開源第 4 步：以前標了 failed 畫面上看不出來（泡泡跟送出去的一樣）。現在資料庫的 failed → 泡泡上「未送出・重送」；
 * markUnsent 同時改畫面；retryUnsent（從 hook 原始碼抽出來跑）用同一個 id 與內容重送，成功才改回 sent；只送給寫這則時就在群裡的人
 * Run: node scripts/review/group_unsent_status_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const src = readFileSync(SRC + '/hooks/useGroupChat.ts', 'utf8');
const body = (name) => {
  const a = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(a >= 0, `${name} not found`);
  return src.slice(a, src.indexOf('\n  );\n', a));
};
for (const [name, kind] of [['sendMessage', 'text'], ['sendVoiceMessage', 'voice']]) {
  const b = body(name);
  assert.match(b, /let saved: Promise<unknown> = Promise\.resolve\(\);/, `${name}: keeps the save promise`);
  assert.match(b, /saved = storage\.saveMessage\(\{/, `${name}: the local copy is the saved promise`);
  const re = new RegExp(`let sent = false;\\s*try \\{\\s*sent = await sendGroupKeyEncrypted\\([^)]*'${kind}'\\);\\s*\\} finally \\{\\s*if \\(!sent\\) \\{\\s*await saved;\\s*markUnsent\\(messageId\\);\\s*\\}\\s*\\}`);
  assert.match(b, re, `${name}: waits for the saved row before marking it unsent — also when the send throws (finally)`);
  console.log(`PASS ${name}: an unsent ${kind} message is marked failed only after its row is saved`);
}

// ── 開源第 4 步：泡泡上看得到「未送出」，可以重送 ──
const { transformSync } = createRequire(root + 'packages/pwa/package.json')('esbuild');

// 資料庫 failed → 畫面上的 sendStatus；markUnsent 也改畫面上的那則
assert.match(src, /\.\.\.\(m\.isOutgoing && m\.status === 'failed' \? \{ sendStatus: 'failed' as const \} : \{\}\)/,
  'a stored outgoing message with status failed is shown as not sent');
const mark = src.slice(src.indexOf('const markUnsent = useCallback('), src.indexOf('}, []);', src.indexOf('const markUnsent = useCallback(')));
assert.match(mark, /storage\.updateMessageStatus\(messageId, 'failed'\)/);
assert.match(mark, /setMessages\(\(prev\) => prev\.map\(\(m\) => \(m\.id === messageId \? \{ \.\.\.m, sendStatus: 'failed' as const \} : m\)\)\)/,
  'markUnsent also marks the bubble on screen (not only the database row)');
console.log('PASS an unsent message is marked on screen as well as in the database (also after a reload)');

// retryUnsent：同一個 id、原本的內容；送出去 → 資料庫 sent、標記拿掉；還是送不出去 → 維持未送出
function retryHarness({ sendResult = true, throws = false, messages }) {
  const calls = { send: [], status: [], state: messages };
  const code = transformSync('globalThis.__retry = ' + body('retryUnsent').slice(body('retryUnsent').indexOf('useCallback(')) + '\n  );',
    { loader: 'ts' }).code;
  const ctx = {
    useCallback: (f) => f, currentGroupId: 'g1', publicKeyBase64: 'ME', messages, console: { error() {} },
    getOtherMemberPublicKeys: () => ['B', 'C', 'D'], userProfile: { displayName: 'Ann' }, t: (k) => k, JSON, Set,
    // D 在這則寫好之後才加入（審查 L8：重送不能讓他收到加入前的訊息）
    currentGroup: { members: [{ publicKey: 'ME', joinedAt: 0 }, { publicKey: 'B', joinedAt: 0 }, { publicKey: 'C', joinedAt: 100 }, { publicKey: 'D', joinedAt: 500 }] },
    sendGroupKeyEncrypted: async (to, plaintext, gid, id, type) => {
      calls.send.push({ to, plaintext: JSON.parse(plaintext), gid, id, type });
      if (throws) throw new Error('boom');
      return sendResult;
    },
    storage: { updateMessageStatus: async (id, s) => { calls.status.push([id, s]); } },
    setMessages: (f) => { calls.state = f(calls.state); },
  };
  ctx.globalThis = ctx;
  runInNewContext(code, ctx);
  return { retry: ctx.__retry, calls };
}
const unsent = { id: 'gmsg-1', senderId: 'me', content: 'hi', type: 'text', timestamp: 111, sendStatus: 'failed', groupIds: ['g1'] };
let h = retryHarness({ messages: [unsent, { id: 'gmsg-2', senderId: 'B', content: 'x', type: 'text', timestamp: 5 }] });
assert.equal(await h.retry('gmsg-1'), true);
assert.equal(h.calls.send.length, 1);
const s0 = h.calls.send[0];
assert.deepEqual([[...s0.to], s0.gid, s0.id, s0.type], [['B', 'C'], 'g1', 'gmsg-1', 'text'],
  'resent under the same id to the members who were already in the group (not to D, who joined later)');
assert.deepEqual([s0.plaintext.id, s0.plaintext.content, s0.plaintext.timestamp, s0.plaintext.groupId], ['gmsg-1', 'hi', 111, 'g1'], 'same content and time');
assert.deepEqual(h.calls.status, [['gmsg-1', 'sent']], 'the database row goes back to sent');
assert.equal(h.calls.state.find((m) => m.id === 'gmsg-1').sendStatus, undefined, 'the not-sent mark is removed');
h = retryHarness({ sendResult: false, messages: [unsent] });
assert.equal(await h.retry('gmsg-1'), false);
assert.deepEqual(h.calls.status, [], 'still no key → stays not sent');
assert.equal(h.calls.state[0].sendStatus, 'failed');
h = retryHarness({ throws: true, messages: [unsent] });
assert.equal(await h.retry('gmsg-1'), false, 'a throwing send is a failure, not a crash');
assert.equal(h.calls.state[0].sendStatus, 'failed');
for (const m of [{ ...unsent, senderId: 'B' }, { ...unsent, sendStatus: undefined }, { ...unsent, type: 'file' }]) {
  h = retryHarness({ messages: [m] });
  assert.equal(await h.retry('gmsg-1'), false);
  assert.equal(h.calls.send.length, 0, 'only my own not-sent text/voice messages are resent');
}
console.log('PASS retry resends the same message (same id, content, time); success clears the mark, failure keeps it');

// 泡泡：我送的、未送出 → 「未送出」＋「重送」
const win = readFileSync(SRC + '/components/GroupChat/GroupChatWindow.tsx', 'utf8');
assert.match(win, /\{isOwn && message\.sendStatus === 'failed' && \(\s*<span[^>]*data-send-status="failed"[^>]*>\s*<span>\{t\('group\.notSent'\)\}<\/span>\s*\{onRetry && \(\s*<button\s*onClick=\{onRetry\}/,
  'my unsent bubble shows "not sent" and a retry button');
assert.match(win, /onRetry=\{msg\.senderId === 'me' && msg\.sendStatus === 'failed' && \(msg\.type === 'text' \|\| msg\.type === 'voice'\)\s*\? \(\) => \{ void retryUnsent\(msg\.id\); \} : undefined\}/,
  'the retry button resends that message');
for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
  const l = readFileSync(`${SRC}/i18n/locales/${lang}.ts`, 'utf8');
  assert.match(l, /notSent: '[^']+',\s*retrySend: '[^']+'/, `${lang}: texts present`);
}
console.log('PASS the group bubble shows "not sent" with a retry button (all languages)');
