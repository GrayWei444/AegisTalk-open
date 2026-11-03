import { devLog } from '../utils/devLog';

/**
 * Unified Database Service — 統一 SQLite 資料庫
 *
 * 透過 @capacitor-community/sqlite 實現跨平台 SQLite：
 * - Android/iOS：原生 SQLite（.db 檔案）
 * - Web (PWA)：sql.js + IndexedDB（plugin 自動處理）
 *
 * 所有持久化資料都走這個 service，不再直接使用 localStorage 或 IndexedDB。
 */

import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { isNativeApp } from './capacitor';
import { installAtomicSaveGuard, saveAtomically } from './webStoreAtomicSave';

// 資料庫名稱
const DB_NAME = 'aegistalk';
/**
 * web 上 jeep-sqlite 存這顆 DB 用的 IndexedDB key（jeepSqliteStore/databases）。檢查「DB 在不在 store」只認這一個：
 * 以前 includes('aegistalk') 也比對到官方版另一顆 DB 的 key（開 App 時 jeep 會替它寫一個 null），
 * 這顆 DB 的 key 不見了還說在（2026-10-15 多人模擬 Dave 重開後空資料庫）
 */
const JEEP_DB_KEY = `${DB_NAME}SQLite.db`;

// 連線狀態
let initialized = false;
let initPromise: Promise<void> | null = null;
let isWeb = false;

/**
 * 版本自己加在這顆 DB 的表（開源第 7 步）：官方版在 src/ext-official 載入時註冊（main.tsx 的 '@ext' import，早於任何
 * initDatabase），社群版沒有。tables 每次開 DB 都跑（CREATE TABLE IF NOT EXISTS …，新安裝）；migrations 是 MIGRATIONS 裡標成
 * edition 的那幾個版本的陳述句（舊裝置）；accountTables 是帳號離開這台時要清空的表（serverAccount.wipeLocalAccount）。
 */
export interface EditionSchema {
  tables: readonly string[];
  migrations: Readonly<Record<number, readonly string[]>>;
  accountTables: readonly string[];
}
let editionSchema: EditionSchema = { tables: [], migrations: {}, accountTables: [] };
let editionSchemaApplied = false;

export function registerEditionSchema(schema: EditionSchema): void {
  if (editionSchemaApplied) console.error('[DB] edition schema registered after the schema was applied; it takes effect on the next start');
  editionSchema = { tables: [...schema.tables], migrations: { ...schema.migrations }, accountTables: [...schema.accountTables] };
}

/** 版本自己的、屬於帳號的表（社群版：沒有） */
export function editionAccountTables(): readonly string[] {
  return editionSchema.accountTables;
}

// ============================================
// Schema 版本遷移系統
// ============================================

/**
 * 目前 schema 版本。每次新增/修改表格時遞增此值，
 * 並在 MIGRATIONS 陣列中加入對應的遷移 SQL。
 */
const SCHEMA_VERSION = 13;

/**
 * 群組狀態鏈（log 模型，docs/GROUP_LOG_WIRING_W1.md）：套上的鏈、log 位置、自己還沒上鏈的 commit、每一代的金鑰。
 * group_keys 改成 (group_id, key_id) 當主鍵：kid 是各群自己的（創群的人自選 genesis kid），以前 key_id 全域唯一 →
 * 別的群的建群者挑一樣的 kid 就能把我另一個群的金鑰換掉。SCHEMA_SQL 與 v12 遷移共用這幾句。
 */
const GROUP_LOG_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS group_keys (
    group_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    key_base64 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'chain',
    epoch_v INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, key_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_group_keys_group_id ON group_keys(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_group_keys_active ON group_keys(group_id, is_active)`,
  `CREATE TABLE IF NOT EXISTS group_commits (
    gid TEXT NOT NULL,
    v INTEGER NOT NULL,
    id TEXT NOT NULL,
    prev TEXT NOT NULL,
    body TEXT NOT NULL,
    sig TEXT NOT NULL,
    PRIMARY KEY (gid, v)
  )`,
  `CREATE TABLE IF NOT EXISTS group_log_state (
    gid TEXT PRIMARY KEY,
    me TEXT NOT NULL,
    head_v INTEGER NOT NULL,
    head_id TEXT NOT NULL,
    processed_seq INTEGER NOT NULL,
    head_seq INTEGER NOT NULL,
    first_seq INTEGER NOT NULL,
    base_v INTEGER NOT NULL,
    join_v INTEGER,
    join_id TEXT,
    status TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    waiting TEXT,
    rekey_seen_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_pending_commits (
    gid TEXT NOT NULL,
    id TEXT NOT NULL,
    op TEXT NOT NULL,
    signed TEXT,
    blob TEXT,
    args TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (gid, id)
  )`,
];

/**
 * 增量遷移紀錄：從 version N → N+1 的 SQL
 * 每個 entry 的 version 代表「遷移到此版本」所需的 SQL。
 * 初始 schema (version 1) 由 SCHEMA_SQL 處理，不需要 migration entry。
 *
 * 範例：未來新增 payment_records 表
 * { version: 2, sql: 'CREATE TABLE IF NOT EXISTS payment_records (...)' }
 */
interface Migration {
  version: number;
  sql: string;
  description: string;
  /** Individual ALTER TABLE statements — each runs in its own try-catch (tolerates "duplicate column") */
  individualStatements?: string[];
  /**
   * 核心表遷移（如 CREATE group_keys）。失敗時 re-throw 走 init error 路徑，
   * 不允許以半套 schema 靜默啟動（否則該功能會無聲損壞）。非核心遷移（ALTER ADD COLUMN）維持原 break。
   */
  critical?: boolean;
  /** 陳述句由版本註冊（EditionSchema.migrations[version]）；沒註冊 → 空的遷移，只記版本號 */
  edition?: boolean;
}

const MIGRATIONS: Migration[] = [
  // version 1: 初始 schema，由 SCHEMA_SQL 建立，不需要 migration entry
  {
    version: 2,
    sql: [
      // user_blacklist: 新增 note、block_count 欄位
      'ALTER TABLE user_blacklist ADD COLUMN note TEXT DEFAULT \'\'',
      'ALTER TABLE user_blacklist ADD COLUMN block_count INTEGER DEFAULT 1',
      // user_whitelist: 新增 note 欄位
      'ALTER TABLE user_whitelist ADD COLUMN note TEXT DEFAULT \'\'',
      // local_user_blacklist: 新增 pubkey、notes、nickname 欄位
      'ALTER TABLE local_user_blacklist ADD COLUMN pubkey TEXT DEFAULT \'\'',
      'ALTER TABLE local_user_blacklist ADD COLUMN notes TEXT',
      'ALTER TABLE local_user_blacklist ADD COLUMN nickname TEXT',
      // guardian_alerts: 新增 protected_pubkey、protected_nickname、status、handled_at
      'ALTER TABLE guardian_alerts ADD COLUMN protected_pubkey TEXT DEFAULT \'\'',
      'ALTER TABLE guardian_alerts ADD COLUMN protected_nickname TEXT DEFAULT \'\'',
      'ALTER TABLE guardian_alerts ADD COLUMN status TEXT DEFAULT \'pending\'',
      'ALTER TABLE guardian_alerts ADD COLUMN handled_at INTEGER',
      // checkin_records: 新增 requested_at、responded_at、response_type
      'ALTER TABLE checkin_records ADD COLUMN requested_at INTEGER',
      'ALTER TABLE checkin_records ADD COLUMN responded_at INTEGER',
      'ALTER TABLE checkin_records ADD COLUMN response_type TEXT',
      // download_history: 新增 status、data_url、source_id、started_at、completed_at
      'ALTER TABLE download_history ADD COLUMN status TEXT DEFAULT \'completed\'',
      'ALTER TABLE download_history ADD COLUMN data_url TEXT',
      'ALTER TABLE download_history ADD COLUMN source_id TEXT',
      'ALTER TABLE download_history ADD COLUMN started_at INTEGER',
      'ALTER TABLE download_history ADD COLUMN completed_at INTEGER',
    ].join(';\n') + ';',
    description: 'Phase 3: Additional columns for localStorage migration',
  },
  {
    version: 3,
    sql: '',  // Handled individually below (ALTER TABLE may fail with "duplicate column")
    description: 'Phase 19: Guardian group group_type + guardian_settings',
    individualStatements: [
      'ALTER TABLE groups ADD COLUMN group_type TEXT',
      'ALTER TABLE groups ADD COLUMN guardian_settings TEXT',
    ],
  },
  {
    version: 4,
    sql: '',
    description: 'Fix ConversationId collision: use full pubkey instead of slice(0,16)',
    individualStatements: [
      // 更新 messages 的 conversation_id（使用 conversations.peer_pubkey 計算新 id）
      `UPDATE messages SET conversation_id = 'conv-' || (
        SELECT c.peer_pubkey FROM conversations c WHERE c.id = messages.conversation_id
      ) WHERE conversation_id LIKE 'conv-%' AND LENGTH(conversation_id) < 60`,
      // 更新 conversations 的 id
      `UPDATE conversations SET id = 'conv-' || peer_pubkey WHERE id LIKE 'conv-%' AND LENGTH(id) < 60`,
    ],
  },
  {
    version: 5,
    sql: '',
    description: 'ADR-016: Group Key table for shared group encryption',
    critical: true,
    individualStatements: [
      `CREATE TABLE IF NOT EXISTS group_keys (
        group_id TEXT NOT NULL,
        key_id TEXT NOT NULL PRIMARY KEY,
        key_base64 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_group_keys_group_id ON group_keys(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_keys_active ON group_keys(group_id, is_active)`,
    ],
  },
  {
    version: 6,
    sql: '',
    description: 'contacts: 存對方 X3DH prekey bundle，供帳號恢復後重建 session（免重加好友）',
    individualStatements: [
      'ALTER TABLE contacts ADD COLUMN signed_pre_key TEXT',
      'ALTER TABLE contacts ADD COLUMN signature TEXT',
    ],
  },
  // version 7–9：版本自己的表（官方版：好友代管的資料表；把可重建的快取搬出 durable DB）。陳述句由版本在開 DB 前註冊
  //   （registerEditionSchema，官方版 src/ext-official）；社群版沒有 → 只記下版本號。v7 是核心表：失敗擋啟動（跟以前一樣）
  { version: 7, sql: '', description: 'edition tables (v7)', critical: true, edition: true },
  { version: 8, sql: '', description: 'edition migration (v8)', critical: false, edition: true },
  { version: 9, sql: '', description: 'edition migration (v9)', critical: false, edition: true },
  {
    version: 10,
    sql: '',
    // 金鑰的來歷（對應群星 83463479，審查 M1，見 groupKey.handleKeyDistribution）：'rotation'＝授權的輪換、
    //   'shared'＝建群／成員分享的、'history'＝只為解舊訊息存著（從沒當過加密用的那把）。既有的金鑰當成 'shared'
    //   （跟以前的行為一樣）。新安裝的 SCHEMA_SQL 直接帶這欄，這條撞 duplicate column 照舊略過
    description: 'group_keys.origin：成員分享的金鑰不能壓過授權的輪換',
    critical: true,
    individualStatements: [
      `ALTER TABLE group_keys ADD COLUMN origin TEXT NOT NULL DEFAULT 'shared'`,
    ],
  },
  {
    version: 11,
    sql: '',
    // 群組訊息的密文在 outbox 只存一份（對應群星 0a544b74，審查 M3）：每個收件人的待送／等回條只留 payload_ref，
    //   密文在 group_outbox_payloads（每則 messageId 一筆），最後一筆參照刪掉時一起刪（storage.releaseGroupOutboxPayload）
    description: 'group_outbox_payloads + pending_messages.payload_ref：群組密文不再每個收件人各存一份',
    critical: true,
    individualStatements: [
      `CREATE TABLE IF NOT EXISTS group_outbox_payloads (
        message_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `ALTER TABLE pending_messages ADD COLUMN payload_ref TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_pending_payload_ref ON pending_messages(payload_ref)`,
    ],
  },
  {
    version: 12,
    sql: '',
    // 群組狀態改成「只由伺服器 log 上套用的簽章鏈決定」（docs/GROUP_LOG_WIRING_W1.md）。還沒有使用者：舊群組沒有鏈、
    //   沒有任何依據 → 整個清掉（名冊、群組列、舊的離開名單、舊金鑰表），不做相容。訊息表的 group_ids 留著（只是看不到了）
    description: 'group log model: group_commits / group_log_state / group_pending_commits, group_keys keyed by (gid, kid); old groups dropped',
    critical: true,
    individualStatements: [
      `DROP TABLE IF EXISTS group_keys`,
      ...GROUP_LOG_TABLES_SQL,
      `DELETE FROM group_members`,
      `DELETE FROM groups`,
      `DELETE FROM settings WHERE key LIKE 'group_departed:%'`,
    ],
  },
  {
    version: 13,
    sql: '',
    // 好友的推播訂閱（開源第 5b 步）：以前經 broker 明文的 PUSH_SUBSCRIPTION_UPDATE 收到、存在 contacts.push_subscription，
    //   寄件人拿去打沒有驗證的 relay。第 4 步起推播只走 chat 伺服器（帳戶簽章），這些舊訂閱（別人的推播網址與金鑰）不該留在手機上
    description: 'clear the friends\' push subscriptions stored before step 4 (contacts.push_subscription)',
    critical: false,
    individualStatements: [
      `UPDATE contacts SET push_subscription = NULL WHERE push_subscription IS NOT NULL`,
    ],
  },
];

/** 所有 CREATE TABLE 語句 */
const SCHEMA_SQL = `
-- 聯絡人
CREATE TABLE IF NOT EXISTS contacts (
  pubkey TEXT PRIMARY KEY,
  nickname TEXT,
  avatar TEXT,
  added_at INTEGER NOT NULL,
  trust_level TEXT DEFAULT 'unverified',
  push_subscription TEXT,
  bypass_fraud_detection INTEGER DEFAULT 0,
  signed_pre_key TEXT,
  signature TEXT
);

-- 對話
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  peer_pubkey TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 訊息
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  content TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER DEFAULT 0,
  expires_at INTEGER,
  read_at INTEGER,
  is_outgoing INTEGER DEFAULT 0,
  status TEXT DEFAULT 'sent',
  group_ids TEXT,
  metadata TEXT,
  risk_result TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Double Ratchet 狀態
CREATE TABLE IF NOT EXISTS ratchet_states (
  peer_pubkey TEXT PRIMARY KEY,
  state_blob TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 待發送訊息佇列
CREATE TABLE IF NOT EXISTS pending_messages (
  id TEXT PRIMARY KEY,
  recipient_pubkey TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  message_type TEXT NOT NULL,
  original_content TEXT,
  created_at INTEGER NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry_at INTEGER,
  payload_ref TEXT
);

-- 群組訊息密文（outbox 用，每則 messageId 一份；pending_messages.payload_ref 參照，見 v11 遷移）
-- payload_ref 的索引在 v11 遷移建（INDEX_SQL 比遷移早跑，舊資料庫那時還沒有這欄）
CREATE TABLE IF NOT EXISTS group_outbox_payloads (
  message_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 群組
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  group_type TEXT,
  guardian_settings TEXT
);

-- 群組成員
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, pubkey),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- 群組訊息
CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  sender_name TEXT,
  content TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER DEFAULT 0,
  expires_at INTEGER,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- 群組狀態鏈與每一代的金鑰（log 模型，見 GROUP_LOG_TABLES_SQL；舊資料庫由 v12 遷移換成這個樣子）
${GROUP_LOG_TABLES_SQL.join(';\n')};

-- 版本自己的表（EditionSchema.tables）在這份 schema 之後建；官方版可重建的規則快取不在這顆 DB

-- schema 版本（schema_version）與版本自己的同步狀態
CREATE TABLE IF NOT EXISTS sync_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 通用 key-value 設定（取代 localStorage）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 使用者域名黑名單
CREATE TABLE IF NOT EXISTS user_blacklist (
  domain TEXT PRIMARY KEY,
  reason TEXT,
  source TEXT DEFAULT 'manual',
  added_at INTEGER NOT NULL
);

-- 使用者域名白名單
CREATE TABLE IF NOT EXISTS user_whitelist (
  domain TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

-- 本地使用者黑名單（pubkey 封鎖）
CREATE TABLE IF NOT EXISTS local_user_blacklist (
  pubkey_hash TEXT PRIMARY KEY,
  reason TEXT,
  complaint_type TEXT,
  reported INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 守護人警報
CREATE TABLE IF NOT EXISTS guardian_alerts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER DEFAULT 0
);

-- 報平安記錄
CREATE TABLE IF NOT EXISTS checkin_records (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  member_pubkey TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- 下載歷史
CREATE TABLE IF NOT EXISTS download_history (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT,
  size INTEGER,
  mime_type TEXT,
  created_at INTEGER NOT NULL
);
`;

/** 索引語句 */
const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_peer ON conversations(peer_pubkey);
CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_messages(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_pubkey ON group_members(pubkey);
CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_created ON group_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_checkin_group ON checkin_records(group_id);
CREATE INDEX IF NOT EXISTS idx_checkin_member ON checkin_records(member_pubkey);
CREATE INDEX IF NOT EXISTS idx_guardian_alerts_group ON guardian_alerts(group_id);
`;

// ============================================
// 初始化
// ============================================

/**
 * 初始化統一資料庫
 * 必須在 App 啟動時呼叫一次
 */
export async function initDatabase(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = _doInit();
  try {
    await initPromise;
  } finally {
    // Always clear initPromise so a retry is possible after transient failure
    initPromise = null;
  }
}

/** Promise 超時包裝：防止底層 promise 永不 resolve（如 jeep-sqlite 的 open()） */
function _withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function _doInit(): Promise<void> {
  const t0 = Date.now();
  isWeb = !isNativeApp();
  devLog(`[DIAG] DB init starting (platform=${isWeb ? 'web' : 'native'})...`);
  devLog(`[DB] Initializing database (platform=${isWeb ? 'web' : 'native'})...`);

  // Web 平台需要先初始化 web store（jeep-sqlite）
  if (isWeb) {
    // 存檔改成一次換掉（jeep 是先刪再寫，中間關 App 就沒了；見 webStoreAtomicSave）：在任何存檔之前裝好
    installAtomicSaveGuard();
    // 等待 jeep-sqlite custom element 完全就緒
    devLog('[DB] Waiting for jeep-sqlite custom element...');
    await customElements.whenDefined('jeep-sqlite');
    const jeepEl = document.querySelector('jeep-sqlite') as HTMLElement & {
      isStoreOpen?: () => Promise<boolean>;
      wasmPath?: string;
    };

    // 設定 wasmPath：sql-wasm.wasm 在根目錄（public/sql-wasm.wasm → dist/sql-wasm.wasm）
    // jeep-sqlite 預設 wasmPath="/assets"，但我們的 WASM 在根目錄
    if (jeepEl) {
      jeepEl.wasmPath = '';
    }

    if (jeepEl && jeepEl.isStoreOpen) {
      // 等待 IndexedDB store 開啟（jeep-sqlite 的 connectedCallback 是 async）
      let storeOpened = false;
      for (let i = 0; i < 30; i++) {
        const open = await jeepEl.isStoreOpen();
        if (open) { storeOpened = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!storeOpened) {
        console.error('[DB] jeep-sqlite store failed to open after 3s');
        throw new Error('jeep-sqlite store failed to open after 3s');
      }
      devLog('[DB] jeep-sqlite store opened');
    }
    await CapacitorSQLite.initWebStore();
    devLog('[DB] Web store initialized');

    // ★ 真因修：jeep-sqlite open() 若 getDBFromStore 回 null（store 還沒把該 DB 從 IndexedDB 載好）
    //   會「建空 DB 並 setInitialDBToStore 寫回」→ 永久覆寫掉 IndexedDB 既有資料（jeep-sqlite.entry
    //   .js:5562-5571）。所以 returning user 必須先「確認 DB 真的在 store 裡」(getDatabaseList) 再 open，
    //   否則第一次 open 就把資料毀了（reopen/re-import 都救不回，因為已被覆寫成空）。
    let isReturningUser = false;
    try {
      isReturningUser = typeof localStorage !== 'undefined'
        && (!!localStorage.getItem('mist_keys') || !!localStorage.getItem('mist_pin_hash'));
    } catch { /* */ }
    if (isReturningUser) {
      let found = await _pollDbInStore(15000);
      console.error(`[DIAG:DB] returning user DB-in-store confirmed=${found}（確認後才 open，避免空覆寫）`);
      // jeep 的 getDatabaseList() 走它自己的 localForage 實例（store=jeepSqliteStore/databases）。
      // 若它在 15s 內仍回 [] → 不可貿然 open（會建空 DB 並 setInitialDBToStore 覆寫掉既有 blob，永久毀資料）。
      // 先繞過 jeep 直接讀原始 IndexedDB：
      //   blob 存在（有內容）= 資料確實還在，只是 jeep localForage 暫時讀不到（reload 時序/實例問題）。
      //     → 重新 initWebStore + 延長輪詢一次；仍讀不到就 throw（fail-safe），絕不讓 open() 空覆寫。
      //   blob 不存在 = 真的全新使用者或從未持久化 → 放行 open() 建新 DB（安全）。
      if (!found) {
        const blobExists = await _rawIdbHasBlob();
        if (blobExists) {
          console.error('[DIAG:DB] raw IndexedDB 有 blob 但 jeep 讀不到 → 重置 web store 並延長輪詢（拒絕空覆寫）');
          try { await CapacitorSQLite.initWebStore(); } catch (e) { console.error('[DIAG:DB] initWebStore retry err:', (e as Error)?.message); }
          found = await _pollDbInStore(15000);
          console.error(`[DIAG:DB] 延長輪詢後 confirmed=${found}`);
          if (!found) {
            // 資料確定還在，但 jeep 始終載不進 store。此時 open() 必定空覆寫 → 寧可中止初始化，
            // 讓上層走重試/重載，也不可毀掉使用者資料。
            throw new Error('[DB] DB blob exists in IndexedDB but jeep store stays blind — abort open() to prevent empty-overwrite data loss');
          }
        } else {
          console.error('[DIAG:DB] raw IndexedDB 無 blob → 視為全新使用者，放行 open() 建新 DB');
        }
      }
    }
  }

  // 清理可能殘留的舊連線（Android Activity 重建、WebView 重載時 native plugin 保留連線但 JS 狀態已重置）
  // v20.12 Bug 3 fix: 加 closeAllConnections 強制全清，避免 createConnection 10s timeout
  devLog('[DIAG] DB cleanup stale connections (v20.12 aggressive)...');
  try {
    await _withTimeout(
      CapacitorSQLite.close({ database: DB_NAME }),
      2000,
      'close() timed out',
    );
  } catch { /* ignore */ }
  try {
    await _withTimeout(
      CapacitorSQLite.closeConnection({ database: DB_NAME }),
      2000,
      'closeConnection() timed out',
    );
  } catch { /* ignore */ }
  // 終極清理：close all connections (避免 connection pool 滿)
  try {
    // closeAllConnections may not exist in older versions
    const closeAll = (CapacitorSQLite as { closeAllConnections?: () => Promise<unknown> }).closeAllConnections;
    if (typeof closeAll === 'function') {
      await _withTimeout(closeAll.call(CapacitorSQLite), 2000, 'closeAllConnections timed out');
      devLog('[DIAG] DB closeAllConnections succeeded');
    }
  } catch { /* ignore */ }

  // SQLCipher encryption disabled — capacitor.config.ts has androidIsEncryption: false
  // (App-level encryption: private key is already PIN-argon2-encrypted, DB-level encryption is redundant)
  // 修 APK 卡 login bug: code 設 encrypted:true 但 native plugin 拒絕 → 無限重試
  const useEncryption = false;
  if (useEncryption) {
    try {
      const { result } = await CapacitorSQLite.isSecretStored();
      if (!result) {
        // First launch: generate random passphrase and store it in native secure storage
        const passBytes = crypto.getRandomValues(new Uint8Array(32));
        const passphrase = Array.from(passBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        await CapacitorSQLite.setEncryptionSecret({ passphrase });
        devLog('[DB] Encryption secret generated and stored');
      } else {
        devLog('[DB] Encryption secret already stored');
      }
    } catch (err) {
      console.error('[DB] Failed to set encryption secret, falling back to no-encryption:', err);
    }
  }

  // 建立連線（加 timeout 防止首次啟動時 native plugin 未就緒）
  // v20.12 Bug 3: 第一次 timeout 後再次清理 + retry，避免用戶看到 spinner 不動
  devLog('[DIAG] DB createConnection...');
  devLog('[DB] Creating connection...');
  const tryCreateConnection = async () => {
    await _withTimeout(
      CapacitorSQLite.createConnection({
        database: DB_NAME,
        version: SCHEMA_VERSION,
        encrypted: useEncryption,
        mode: useEncryption ? 'secret' : 'no-encryption',
      }),
      8000,
      'CapacitorSQLite.createConnection() timed out after 8s',
    );
  };
  try {
    await tryCreateConnection();
    devLog('[DIAG] DB createConnection OK (first try)');
  } catch (err) {
    console.error('[DIAG] DB createConnection first try failed, force clean + retry:', (err as Error)?.message);
    // 再嘗試清乾淨
    try { await _withTimeout(CapacitorSQLite.close({ database: DB_NAME }), 1500, 'close'); } catch { /* */ }
    try { await _withTimeout(CapacitorSQLite.closeConnection({ database: DB_NAME }), 1500, 'closeConn'); } catch { /* */ }
    try {
      const closeAll = (CapacitorSQLite as { closeAllConnections?: () => Promise<unknown> }).closeAllConnections;
      if (typeof closeAll === 'function') {
        await _withTimeout(closeAll.call(CapacitorSQLite), 1500, 'closeAll');
      }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 200));
    await tryCreateConnection();
    devLog('[DIAG] DB createConnection OK (retry)');
  }

  // 開啟資料庫（加 timeout 防止 jeep-sqlite 內部 promise 永不 resolve）
  devLog('[DIAG] DB open...');
  devLog('[DB] Opening database...');
  await _withTimeout(
    CapacitorSQLite.open({ database: DB_NAME }),
    10000,
    'CapacitorSQLite.open() timed out after 10s'
  );
  devLog('[DIAG] DB open OK');

  // 建立基礎 schema（CREATE TABLE IF NOT EXISTS 確保冪等）
  devLog('[DIAG] DB schema...');
  devLog('[DB] Executing schema SQL...');
  await CapacitorSQLite.execute({
    database: DB_NAME,
    statements: SCHEMA_SQL,
    transaction: false,
  });
  // 版本自己的表（官方版在載入時註冊；社群版沒有）
  if (editionSchema.tables.length > 0) {
    await CapacitorSQLite.execute({
      database: DB_NAME,
      statements: editionSchema.tables.map((s) => s.trim().replace(/;$/, '') + ';').join('\n'),
      transaction: false,
    });
  }
  editionSchemaApplied = true;
  devLog('[DIAG] DB schema OK');

  // 建立索引
  await CapacitorSQLite.execute({
    database: DB_NAME,
    statements: INDEX_SQL,
    transaction: false,
  });

  // 執行增量遷移
  devLog('[DIAG] DB migrations...');
  await _runMigrations();
  devLog('[DIAG] DB migrations OK');

  // 註：登出重登後「好友消失」的真因不在這裡，而在 open() 前的 store-load race（見上方 initWebStore
  //   後的 getDatabaseList 確認）。jeep open() 讀不到 blob 會建空並覆寫 IndexedDB，故必須在 open 前
  //   確認 DB 在 store。此處不再做 reopen/saveToStore 補救（已被上游確認阻擋）。

  initialized = true;
  devLog(`[DIAG] DB initialized OK in ${Date.now() - t0}ms`);
  devLog(`[DB] Database initialized in ${Date.now() - t0}ms`);

  // Diagnostic: dump key table counts
  try {
    const tables = ['contacts', 'messages', 'groups', 'settings', 'ratchet_states'];
    for (const t of tables) {
      validateTableName(t);
      const r = await CapacitorSQLite.query({ database: DB_NAME, statement: `SELECT COUNT(*) as cnt FROM ${t}`, values: [] });
      devLog(`[DIAG] Table ${t}: ${r.values?.[0]?.cnt ?? 'N/A'} rows`);
    }
  } catch (e) {
    devLog('[DIAG] Table count query failed:', e);
  }

  // 清理舊的 IndexedDB 資料庫（一次性，不阻塞）
  _cleanupOldDatabases();
}

/**
 * 清理舊的 IndexedDB 資料庫
 * 遷移到統一 SQLite 後，舊資料庫不再需要
 */
function _cleanupOldDatabases(): void {
  if (typeof indexedDB === 'undefined') return;
  const OLD_DBS = ['mist_storage', 'aegis-talk-rules'];
  for (const name of OLD_DBS) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // 忽略
    }
  }
}

/**
 * 輪詢 jeep 的 getDatabaseList()，確認本 DB 是否已被 jeep 的 localForage 實例載入 store。
 * 回 true = 在 store 內（open 安全，不會空覆寫）。read-only，不改任何狀態。
 */
async function _pollDbInStore(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    try {
      const list = await CapacitorSQLite.getDatabaseList();
      const arr: string[] = (list?.values as string[]) ?? [];
      if (arr.some((d) => d === JEEP_DB_KEY)) return true;
      if (i % 5 === 0) console.error(`[DIAG:DB] returning user — 等 DB 進 store (list=${JSON.stringify(arr)})`);
    } catch (e) { if (i % 5 === 0) console.error('[DIAG:DB] getDatabaseList err:', (e as Error)?.message); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * 繞過 jeep 的 localForage 實例，直接讀原始 IndexedDB，判斷 jeep getDatabaseList()=[] 時 DB blob
 * 到底「在不在、有沒有內容」。回 true = 原始 IndexedDB 內有非空 blob（資料確實還在，只是 jeep 暫時讀不到，
 * 絕不可讓 open() 空覆寫）。回 false = 真的沒有 blob（全新使用者或從未持久化 → open 建新 DB 安全）。
 * read-only，不改任何狀態、不建 object store。console.error 以存活 prod build。
 */
async function _rawIdbHasBlob(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') { console.error('[DIAG:DB:RAW] no indexedDB'); return false; }
  // 1) 列出此 origin 所有 IndexedDB（Chromium 支援 databases()，純診斷）
  try {
    const dbs = (indexedDB as { databases?: () => Promise<Array<{ name?: string; version?: number }>> }).databases;
    if (typeof dbs === 'function') {
      const list = await dbs.call(indexedDB);
      console.error(`[DIAG:DB:RAW] indexedDB.databases()=${JSON.stringify(list.map((d) => `${d.name}@v${d.version}`))}`);
    } else {
      console.error('[DIAG:DB:RAW] indexedDB.databases() unsupported');
    }
  } catch (e) { console.error('[DIAG:DB:RAW] databases() err:', (e as Error)?.message); }
  // 2) 直接開 jeepSqliteStore，讀 databases object store 的 keys + aegistalk blob 大小（不建 store）
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (hasBlob: boolean) => { if (!settled) { settled = true; resolve(hasBlob); } };
    try {
      const req = indexedDB.open('jeepSqliteStore');
      req.onerror = () => { console.error('[DIAG:DB:RAW] open jeepSqliteStore err'); done(false); };
      req.onsuccess = () => {
        try {
          const idb = req.result;
          const stores = Array.from(idb.objectStoreNames);
          console.error(`[DIAG:DB:RAW] jeepSqliteStore objectStores=${JSON.stringify(stores)}`);
          if (!stores.includes('databases')) { idb.close(); done(false); return; }
          const tx = idb.transaction('databases', 'readonly');
          const os = tx.objectStore('databases');
          const keysReq = os.getAllKeys();
          keysReq.onsuccess = () => {
            const keys = (keysReq.result as IDBValidKey[]).map(String);
            console.error(`[DIAG:DB:RAW] databases store keys=${JSON.stringify(keys)}`);
            const dbKey = keys.find((k) => k === JEEP_DB_KEY);
            if (!dbKey) { idb.close(); done(false); return; }
            const valReq = os.get(dbKey);
            valReq.onsuccess = () => {
              const v = valReq.result;
              let sz = 'null';
              let hasBlob = false;
              if (v instanceof Uint8Array) { sz = `Uint8Array(${v.byteLength})`; hasBlob = v.byteLength > 0; }
              else if (v instanceof ArrayBuffer) { sz = `ArrayBuffer(${v.byteLength})`; hasBlob = v.byteLength > 0; }
              else if (typeof v === 'string') { sz = `string(${v.length})`; hasBlob = v.length > 0; }
              else if (v != null) { sz = typeof v; hasBlob = true; }
              console.error(`[DIAG:DB:RAW] blob '${dbKey}' value=${sz} → hasBlob=${hasBlob}`);
              idb.close(); done(hasBlob);
            };
            valReq.onerror = () => { console.error('[DIAG:DB:RAW] get blob err'); idb.close(); done(false); };
          };
          keysReq.onerror = () => { console.error('[DIAG:DB:RAW] getAllKeys err'); idb.close(); done(false); };
        } catch (e) { console.error('[DIAG:DB:RAW] inner err:', (e as Error)?.message); done(false); }
      };
      req.onupgradeneeded = () => { console.error('[DIAG:DB:RAW] jeepSqliteStore did NOT exist (onupgradeneeded fired)'); };
    } catch (e) { console.error('[DIAG:DB:RAW] open err:', (e as Error)?.message); done(false); }
    setTimeout(() => done(false), 3000);
  });
}

/**
 * 輕量版：只查 jeepSqliteStore.databases 是否含 DB_NAME 這個 key（不讀 25MB 值、不記 log）。
 * jeep 的 setItem 是 transactional，key 出現 ⟺ 一份完整 blob 已落地，可作為 flush「真的寫進
 * IndexedDB」的訊號。flush 前輪詢用這個（讀 25MB 值會很慢，且每次都讀沒必要）。
 */
async function _rawIdbHasKey(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = indexedDB.open('jeepSqliteStore');
      req.onerror = () => done(false);
      // store 不存在時別建空 DB（abort upgrade）：沒 blob → false
      req.onupgradeneeded = (ev) => { try { (ev.target as IDBOpenDBRequest).transaction?.abort(); } catch { /* */ } done(false); };
      req.onsuccess = () => {
        try {
          const idb = req.result;
          if (!Array.from(idb.objectStoreNames).includes('databases')) { idb.close(); done(false); return; }
          const kr = idb.transaction('databases', 'readonly').objectStore('databases').getAllKeys();
          kr.onsuccess = () => {
            const has = (kr.result as IDBValidKey[]).map(String).some((k) => k === JEEP_DB_KEY);
            idb.close(); done(has);
          };
          kr.onerror = () => { idb.close(); done(false); };
        } catch { done(false); }
      };
    } catch { done(false); }
    setTimeout(() => done(false), 2000);
  });
}

/**
 * 增量遷移系統
 *
 * 1. 讀取 sync_metadata 中的 'schema_version' 取得目前版本
 * 2. 依序執行 version > currentVersion 的 migration SQL
 * 3. 更新 schema_version 到最新
 *
 * 確保冪等：每個 migration 只執行一次
 */
async function _runMigrations(): Promise<void> {
  // 讀取目前版本
  const versionResult = await CapacitorSQLite.query({
    database: DB_NAME,
    statement: "SELECT value FROM sync_metadata WHERE key = 'schema_version'",
    values: [],
  });

  // iOS 同樣有 ios_columns metadata 列，需剝除（否則 values[0].value=undefined → parseInt=NaN →
  // currentVersion 永遠讀成 1 → 每次 iOS 啟動重跑所有 migration）。
  const versionRows = stripIosColumnsRow(versionResult.values ?? []) as Array<{ value?: unknown }>;
  let currentVersion = 1; // 預設為 1（初始 schema）
  if (versionRows.length > 0) {
    const stored = parseInt(String(versionRows[0].value), 10);
    if (!isNaN(stored)) {
      currentVersion = stored;
    }
  }

  // 找出需要執行的遷移
  const pendingMigrations = MIGRATIONS
    .filter(m => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pendingMigrations.length === 0) {
    devLog(`[DB] Schema up to date (v${currentVersion})`);
    // 確保版本號已記錄
    await CapacitorSQLite.run({
      database: DB_NAME,
      statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('schema_version', ?)",
      values: [String(SCHEMA_VERSION)],
      transaction: false,
    });
    return;
  }

  devLog(`[DB] Running ${pendingMigrations.length} migration(s): v${currentVersion} → v${SCHEMA_VERSION}`);

  // 依序執行遷移
  for (const migration of pendingMigrations) {
    try {
      devLog(`[DB] Migrating to v${migration.version}: ${migration.description}`);

      // Individual statements: each runs separately, tolerating "duplicate column" errors
      const statements = migration.edition ? (editionSchema.migrations[migration.version] ?? []) : migration.individualStatements;
      if (statements && statements.length > 0) {
        for (const stmt of statements) {
          try {
            await CapacitorSQLite.execute({
              database: DB_NAME,
              statements: stmt + ';',
              transaction: false,
            });
          } catch (stmtErr) {
            const stmtMsg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
            if (stmtMsg.includes('duplicate column')) {
              devLog(`[DB] Column already exists, skipping: ${stmt}`);
            } else {
              throw stmtErr; // Re-throw non-duplicate errors
            }
          }
        }
      } else if (migration.sql && !migration.edition) {
        await CapacitorSQLite.execute({
          database: DB_NAME,
          statements: migration.sql,
          transaction: true,
        });
      }

      // 更新版本號
      await CapacitorSQLite.run({
        database: DB_NAME,
        statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('schema_version', ?)",
        values: [String(migration.version)],
        transaction: false,
      });
      devLog(`[DB] Migration v${migration.version} completed`);
    } catch (error) {
      // 遷移失敗：先記錄錯誤。核心表遷移 re-throw 阻擋啟動，非核心則停止後續遷移繼續啟動。
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[DB] Migration v${migration.version} FAILED: ${msg}`);
      await CapacitorSQLite.run({
        database: DB_NAME,
        statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)",
        values: [`migration_error_v${migration.version}`, `${Date.now()}:${msg}`],
        transaction: false,
      });
      if (migration.critical) {
        // 核心表（group_keys、版本的核心表）失敗：不可以半套 schema 靜默啟動 → 走 init error 路徑
        throw new Error(`Critical migration v${migration.version} failed: ${msg}`);
      }
      break; // 非核心：停止後續遷移，仍允許啟動
    }
  }
}

// ============================================
// 核心 CRUD 操作
// ============================================

// ──────────────────────────────────────────────────────────────────────────
// Web 持久化序列化（jeep-sqlite only）
//
// jeep-sqlite 的 saveToStore 會把「整個 in-memory DB blob」export 後，用
// localForage 做 removeItem(dbName) → setItem(dbName, blob)（非原子）寫回
// IndexedDB。（2026-10-15 起 removeItem 那一步被 webStoreAtomicSave 吞掉，setItem 一次換掉：
// 中途關 App 留下的是上一份完整快照；底下的排隊與封印照舊，防的是快照的新舊順序與 reload 前最後一份。）AegisTalk 的 blob ~25MB（VPS 59 萬條域名規則）。若多個
// saveToStore 並行：
//   (a) removeItem/setItem 窗口交錯 → 一個 save 的 removeItem 砍掉另一個剛
//       setItem 的紀錄；
//   (b) export + 寫入耗時長、完成順序可能亂掉 → 舊快照（不含剛加的好友）的
//       setItem 後到 → 覆蓋掉新快照 → 重新登入查無好友（Test 3 Bob 不見）。
// 解法：所有 saveToStore 串成單一序列（永不重疊），並 coalesce 連續請求
// （每次 save 都 export「當下」in-memory 狀態，故 burst 中只需跑最後一次即可，
// 仍保證「每個寫入後都有一次在它之後才開始的 save」）。原生平台直接 no-op。
let _saveTail: Promise<void> = Promise.resolve();
let _lastSaveError: string | null = null;
// 登出 reload 前由 flushToStore 封印：封印後所有「外部」saveToStore（incoming message /
// ratchet / presence / blob 鏡像等 run() 觸發）變 no-op。jeep 的 saveToStore 是非原子
// removeItem→setItem，封印前 flush 已確認 blob key 落地；若不封印，flush 回傳後到 reload
// 真正提交之間，任何一個 run() 都可能再開一個 removeItem 窗口 → reload 在 setItem 前打斷
// → blob 永久遺失（Test 3 重登好友消失的真因）。封印只發生在「即將 reload」時，in-memory
// DB 本就要丟棄，擋掉這些寫入無副作用。reload 後模組重載自動歸零。
let _storeSealed = false;

// ── web 持久化去抖（2026-07-15）──
//   真因：jeep-sqlite 的 saveToStore 把「整顆 DB」export 進 IndexedDB。以前 vpsSync 誤把 store
//   封印掉（silent no-op），意外讓「同步後的每則寫入」不落地也不花錢 → 掩蓋了「per-write 整顆
//   export」本來就過重的事實。修好封印後（174cb0e）真的每寫必存 → 背景寫入 ~9 次/秒 × 整顆 export
//   → 主線程被 saveToStore 佔滿 → **WebRTC 重連（sessionReset 後）握手被餓死、msg 進 outbox 收不到**
//   （E2E test 3 實證：seal 修好後連掛 3 run，縮小 blob 仍掛 → 不是單次成本、是頻率）。
//   對策：非強制寫入去抖 —— 一連串寫入合併成「一次」saveToStore（安靜 DEBOUNCE_MS 後才存，
//   持續寫入最遲 MAX_DEBOUNCE_MS 也存一次）。force（flushToStore / 登出 / pagehide）維持「立即且可 await」。
//   ⚠️ 語意變化：非 force 的 `await run()` 不再保證「已落地」，只保證「已排程」。要保證落地的路徑
//   （登出、換頁前）一律走 flushToStore(force)。durable blob 已縮到只剩使用者資料，去抖窗口內
//   異常關閉最多丟 ~2s 寫入（可接受；原生 App 真檔不受影響）。
const DEBOUNCE_MS = 500;
const MAX_DEBOUNCE_MS = 2000;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _dirtySince = 0;

/** 實際把 DB export 進 store（串進 _saveTail 序列，永不重疊） */
function _doSaveToStore(): Promise<void> {
  const next = _saveTail.then(async () => {
    try {
      // jeep 的存檔是先刪再寫：保證它刪不掉舊快照，新的那份一次寫進去（見 webStoreAtomicSave）
      await saveAtomically(JEEP_DB_KEY, () => CapacitorSQLite.saveToStore({ database: DB_NAME }));
      _lastSaveError = null;
    } catch (e) {
      // 落地失敗顯式記真因（console.error 存活 prod build）——曾被空 catch 吞掉導致重登查無好友
      _lastSaveError = (e as Error)?.message ?? String(e);
      console.error(`[DIAG:DB] saveToStore FAILED: ${_lastSaveError}`);
      throw e;
    }
  });
  _saveTail = next.catch(() => {});
  return next;
}

function _persistToStore(force = false): Promise<void> {
  if (!isWeb) return Promise.resolve();
  if (_storeSealed && !force) return Promise.resolve();
  if (force) {
    // 立即落地（且可 await）：取消在途去抖，直接存。
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    _dirtySince = 0;
    return _doSaveToStore();
  }
  // 去抖：把一串寫入合併成一次 save。fire-and-forget（不 await 真正落地）。
  const now = Date.now();
  if (_dirtySince === 0) _dirtySince = now;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  // 安靜 DEBOUNCE_MS 就存；但已髒超過 MAX_DEBOUNCE_MS 則不再拖（持續寫入也定期落地）
  const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DEBOUNCE_MS - (now - _dirtySince)));
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    _dirtySince = 0;
    void _doSaveToStore();
  }, delay);
  return Promise.resolve();
}

// Web 端 SQLite 操作序列化（jeep-sqlite = sql.js 單連線）
//
// sql.js 單連線：同時 step 兩個 statement → 「stepping, database is locked (5)」崩潰。
// 帳號恢復時，awaited 寫入（addContact/createGroup）會與「fire-and-forget 的備份 flush」
// 及「AppProvider 對 publicKey/storageReady 變動觸發的 reactive loadFromStorage」並發撞同一
// 連線 → locked → 恢復流程崩掉、那次就送不出訊息（Test 35c flaky 真因）。
// 解法：web 端所有 leaf 操作（run/query/execute/executeSet）串成單一鏈，永不重疊。
// 原生平台（@capacitor-community/sqlite）自有檔案鎖，直接跑、不排隊。
//
// ⚠️ 只包「leaf」CapacitorSQLite.* 呼叫，不包 queryOne（它委派給 query）等高層函式，
//    避免「持鏈中又等鏈」的自我 deadlock。
let _opTail: Promise<unknown> = Promise.resolve();
let _opSeq = 0;
let _opDepth = 0;
function _serializeOp<T>(op: () => Promise<T>): Promise<T> {
  if (!isWeb) return op();
  // 取證插樁（test5 UI 查詢 30s+ 才輪到）：排隊 >2s 或執行 >800ms 就報 — 讓佔隊列的 op 現形
  const id = ++_opSeq;
  const enq = Date.now();
  _opDepth++;
  const timed = async () => {
    const wait = Date.now() - enq;
    const t0 = Date.now();
    try {
      return await op();
    } finally {
      _opDepth--;
      const run = Date.now() - t0;
      if (wait > 2000 || run > 800) {
        console.error(`[DIAG:DBQ] op#${id} wait=${wait}ms run=${run}ms depth=${_opDepth}`);
      }
    }
  };
  const next = _opTail.then(timed, timed); // 不論前一個成敗都接著跑
  _opTail = next.then(() => {}, () => {}); // tail 吞錯避免單次失敗污染整條鏈；錯誤仍 propagate 給本次 caller
  return next;
}

/**
 * 執行批量 SQL（不回傳資料）
 * 適合 CREATE TABLE / INSERT 批量操作
 */
export async function execute(statements: string, transaction = true): Promise<number> {
  await initDatabase();
  const result = await _serializeOp(() => CapacitorSQLite.execute({
    database: DB_NAME,
    statements,
    transaction,
  }));
  await _persistToStore();
  return result.changes?.changes ?? 0;
}

/**
 * 執行單一 SQL 語句（帶參數）
 * 適合 INSERT / UPDATE / DELETE
 */
export async function run(statement: string, values: unknown[] = []): Promise<number> {
  await initDatabase();
  const result = await _serializeOp(() => CapacitorSQLite.run({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
    transaction: false,
  }));
  await _persistToStore();
  return result.changes?.changes ?? 0;
}

/**
 * 查詢 SQL（帶參數，回傳列陣列）
 */
export async function query<T = Record<string, unknown>>(
  statement: string,
  values: unknown[] = [],
): Promise<T[]> {
  await initDatabase();
  const result = await _serializeOp(() => CapacitorSQLite.query({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
  }));
  // @capacitor-community/sqlite 在 iOS 上把欄位名 metadata 當 values[0] 回傳（`{ios_columns:[...]}`），
  // 真資料從 values[1] 起。web/electron/Android 無此列。不剝掉 → iOS 上 rows[0] 讀到的是 metadata
  // （欄位全 undefined）→ 每個 SELECT 錯位（group key / 訊息 / 裝置全壞）。
  return stripIosColumnsRow(result.values ?? []) as T[];
}

/** 剝除 iOS @capacitor-community/sqlite query 回傳的 `{ios_columns:[...]}` metadata 列。 */
export function stripIosColumnsRow(rows: unknown[]): unknown[] {
  if (
    rows.length > 0 &&
    rows[0] != null &&
    typeof rows[0] === 'object' &&
    'ios_columns' in (rows[0] as Record<string, unknown>)
  ) {
    return rows.slice(1);
  }
  return rows;
}

/**
 * 查詢單一列
 */
export async function queryOne<T = Record<string, unknown>>(
  statement: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(statement, values);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 交易（批量操作）
 */
export async function transaction(fn: () => Promise<void>): Promise<void> {
  await initDatabase();
  await CapacitorSQLite.beginTransaction({ database: DB_NAME });
  try {
    await fn();
    await CapacitorSQLite.commitTransaction({ database: DB_NAME });
    await _persistToStore();
  } catch (error) {
    await CapacitorSQLite.rollbackTransaction({ database: DB_NAME });
    throw error;
  }
}

/**
 * 批量執行（使用 executeSet）— 適合大量 INSERT
 *
 * saveToStoreOnWeb=false：跳過 per-batch saveToStore（整個 DB blob 寫回 IDB，
 * 通常 500ms+，會卡 main thread 影響 React render）。
 * VPS sync 那種大批 INSERT 跑完應該 caller 端最後手動 flushToStore() 一次。
 */
export async function runBatch(
  sets: Array<{ statement: string; values: (string | number | null)[] }>,
  saveToStoreOnWeb: boolean = true,
): Promise<number> {
  await initDatabase();
  const result = await _serializeOp(() => CapacitorSQLite.executeSet({
    database: DB_NAME,
    set: sets,
    transaction: true,
  }));
  if (saveToStoreOnWeb) {
    await _persistToStore();
  }
  return result.changes?.changes ?? 0;
}

/**
 * 手動把 in-memory SQLite 寫回 IndexedDB（web only）
 * 配 runBatch(sets, false) 用 — 大批寫完才 flush 一次
 */
export async function flushToStore(options?: { seal?: boolean }): Promise<void> {
  if (!isWeb) return;
  await initDatabase();
  // ⚠️ seal 是「單向門」：封印後本 session 所有後續 run() 的 persist 都變 no-op —— 只給
  //   「登出→reload」用（封印→最終落地→reload）。**任何「只是想一次性落地」的呼叫端絕不可 seal**：
  //   2026-07-15 事故 —— vpsSync 同步完借用本函式（當時無參數、永遠封印）→ 同步完成後整個
  //   session 的寫入（訊息/卡片/ratchet）全部無聲不落地 → reload 即消失（G6 E2E 4 輪插樁抓到：
  //   forcedSave 直打 CapacitorSQLite 有效、經 _persistToStore 無效 → 鎖定 _storeSealed）。
  const seal = options?.seal === true;
  // 登出 / 換頁前的關鍵落地點。jeep saveDBToStore 是非原子的
  // removeItem(dbName) → setItem(dbName, ~25MB blob)，且 web 端 saveToStore() 的
  // await 不保證 setItem 真的收尾 → 若 window.location.reload() 在 setItem 前打斷，
  // blob 會被前一步 removeItem 砍掉後永久遺失（Test 3 重登查無好友、raw IDB keys=[]）。
  //
  // 對策：先「封印」store（之後任何外部 run() 的 save 變 no-op，不再開新的 removeItem→setItem
  // 窗口），再 drain 在途 save，做「一次」force save，然後純讀輪詢 IndexedDB 的 key 確認 blob
  // 落地後才回 caller（caller 接著才 reload）。封印是真因修：先前 flush 已確認 key，但回傳後到
  // reload 提交之間，遲到的 run()（incoming message / ratchet / presence / blob 鏡像）會再開
  // 一個 removeItem 窗口 → reload 在 setItem 前打斷 → blob 遺失（raw IDB keys=[]、重登查無好友）。
  // 封印後唯一還能寫 store 的就是底下這個 force save，落地確認後即不再有任何 save → reload 安全。
  // key 出現 ⟺ 一份完整 blob 已在 store；只有第一次 force save 真的整個沒落地才再存一次。
  if (seal) _storeSealed = true;
  await _saveTail.catch(() => {});
  for (let attempt = 1; attempt <= 2; attempt++) {
    let saved = true;
    try {
      await _persistToStore(true);
    } catch (e) {
      saved = false;
      console.error(`[DIAG:DB] flush attempt ${attempt} save threw: ${(e as Error)?.message ?? e}`);
    }
    // 存檔丟了例外（例如空間不夠）→ 再試一次。存檔是一次換掉的（webStoreAtomicSave），舊快照的 key 一直在，
    //   不能拿「key 在」當成這次存好了（程式碼審查 LOW）
    if (!saved) continue;
    // 等 setItem 收尾再確認（純讀 key，不開新 save 窗口）；常見情況首輪即 true。
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await _rawIdbHasKey()) return;
    }
    console.error(`[DIAG:DB] flush attempt ${attempt}: blob key still absent (lastSaveError=${_lastSaveError})`);
  }
  console.error(`[DIAG:DB] flush FAILED to persist blob — data may be lost on reload`);
}

/**
 * 執行單一 SQL 但不自動 saveToStore（用於 transaction 內部）
 * 避免 59 萬筆 INSERT 每筆都 saveToStore
 */
export async function runNoSave(statement: string, values: unknown[] = []): Promise<number> {
  await initDatabase();
  const result = await _serializeOp(() => CapacitorSQLite.run({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
    transaction: false,
  }));
  return result.changes?.changes ?? 0;
}

/** 版本自己的 DB（官方版的規則 DB，src/ext-official）沿用的底層工具：web 上同一條操作鏈與逾時 */
export { _serializeOp as serializeDbOp, _withTimeout as withDbTimeout };

/** Validate table name to prevent SQL injection (only allows [a-z0-9_]) */
export function validateTableName(table: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

/**
 * 取得指定表格的 row count
 */
export async function getCount(table: string): Promise<number> {
  validateTableName(table);
  const row = await queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
  return row?.cnt ?? 0;
}

/**
 * 清空指定表格
 */
export async function clearTable(table: string): Promise<void> {
  validateTableName(table);
  await run(`DELETE FROM ${table}`);
}

// ============================================
// Settings 通用 Key-Value 操作
// ============================================

/**
 * 取得設定值
 */
export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

/**
 * 設定值
 */
export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    [key, value, Date.now()],
  );
}

/**
 * 刪除設定
 */
export async function deleteSetting(key: string): Promise<void> {
  await run('DELETE FROM settings WHERE key = ?', [key]);
}

/**
 * 從 localStorage 遷移到 SQLite settings
 * 每個 key 只遷移一次：若 SQLite 已有則跳過
 */
export async function migrateFromLocalStorage(
  localStorageKey: string,
  sqliteKey?: string,
): Promise<void> {
  const targetKey = sqliteKey ?? localStorageKey;
  const existing = await getSetting(targetKey);
  if (existing !== null) return; // 已遷移

  try {
    const old = localStorage.getItem(localStorageKey);
    if (old !== null) {
      await setSetting(targetKey, old);
      localStorage.removeItem(localStorageKey);
    }
  } catch {
    // localStorage 存取失敗（隱私模式等），忽略
  }
}

// ============================================
// 關閉
// ============================================

/**
 * 關閉資料庫連線
 */
export async function closeDatabase(): Promise<void> {
  if (!initialized) return;

  await _persistToStore();
  await CapacitorSQLite.close({ database: DB_NAME });
  await CapacitorSQLite.closeConnection({ database: DB_NAME });
  initialized = false;
}

/**
 * Web 平台：手動保存到 IndexedDB store
 * 原生平台不需要（自動持久化）
 */
export async function saveIfWeb(): Promise<void> {
  if (initialized) {
    await _persistToStore();
  }
}
