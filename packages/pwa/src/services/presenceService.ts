/**
 * 好友之間的秘密 presence（W4，docs/GROUP_LOG_WIRING_W4.md；格式與密碼學在 presenceSecret.ts）。
 *
 * 我的秘密（S, e）：
 *   - 沒有就產生一份，封給每個好友（封鎖的不算，presence 信封 share）。
 *   - 新的好友 → 只封給他。好友、封鎖名單每次變動都重新比對（reconcile）；拿過秘密的人裡有誰刪了、封鎖了 → 換新的 S 與 e；
 *     用滿 30 天 → 也換。換的時候分兩步（換主題前先把舊主題清乾淨）：
 *       1. 新的那份先存成 next（還不用）；舊主題上不再發任何東西（上線、更新、遺囑都不發，見 codec.seal）
 *       2. 連著、而且這張 token 還能發舊主題的時候：在舊主題上發一則空的 retained（清掉 broker 存著的最後狀態），
 *          確認了（PUBACK）才換上 next（token 範圍換成新的 tag → 換 token 重連），再封給剩下的好友（最多 150 封）
 *     被刪、被封鎖的人手上只有舊的 S：舊主題上什麼都沒有了，新主題推不出來，跟我要也不給（只回給現在的好友）。
 * 好友的秘密：只收現在是好友、沒被我封鎖的人寄來的（信封簽章由 AppProvider 那一層驗過）；世代只能往上（重放的舊信封不換）。
 *   手上沒有某個好友的 → 跟他要（request；退避 2 分、10 分、1 小時、6 小時）；他的主題被清掉（空的 retained：他換了秘密）、或訂了
 *   10 分鐘他的主題上什麼都沒有（broker 一定存著主人最後的狀態 → 空的 ＝ 我手上的已經過時，他換秘密時我離線、那一封弄丟了）→ 也跟他要。
 *   同一個好友的秘密 10 分鐘最多換一次（除非是我要的、或他的主題剛清掉）：好友不能用一直換秘密逼我一直換 token 重連（審查 W4 #4）。
 *   同一代兩份不同的秘密（同一秒建了兩次）→ 封得比較晚的那份（信封裡簽過名的 iat）勝出。
 *   刪掉、封鎖的好友 → 他的秘密丟掉（不再訂他的主題）。
 * stop() 之後所有還在跑的工作都不再存檔、不再送、不再改範圍（換帳號時舊帳號的秘密不會用新帳號的身分送出去，審查 W4 #3）。
 * 給 mqtt 的範圍（onScope）：我的 tag（token 的發布權）＋每個好友目前那一個確切的主題（最多 150 個）。同群組但不是好友的人
 * 不在這裡：他們的「在線」靠群組主題上的 here 與 P2P 的狀態（memberPresence.ts）。
 * 所有狀態變動排成一列做（start／reconcile／onConnected／onSealed／cleared 不會互相踩到）。
 */
import {
  compareShare, MAX_PRESENCE_TOPICS, nextEpoch, openPresence, parsePresenceBody, parsePresenceTopic, presenceTag, presenceTopic,
  requestBody, rotationReason, sealPresence, secretFromB64, secretToB64, shareBody,
  type PresenceSecret, type PresenceState,
} from './presenceSecret';

/** 存檔的格式（settings 表，一個帳號一筆；presenceStore.ts） */
export interface PersistedPresence {
  v: 1;
  /** 我現在用的秘密；sharedWith ＝ 封給過誰（這份秘密在誰手上） */
  self: { s: string; e: number; since: number; sharedWith: string[] } | null;
  /** 換新的秘密：等舊主題清掉才換上 */
  next: { s: string; e: number; since: number } | null;
  /** 好友的秘密（iat ＝ 那封 share 簽過名的封裝時間：同一代兩份不同的秘密時，晚封的勝出） */
  peers: Record<string, { s: string; e: number; at: number; iat?: number }>;
}

export interface PresenceScope {
  /** 我的 tag（token 的發布權：mist/user/{我}/presence/{tag}）；null ＝ 還沒有 */
  tag: string | null;
  /** 要訂的好友 presence 主題（確切的，最多 150 個） */
  topics: string[];
}

export interface PresenceDeps {
  me: string;
  /** 校正到伺服器的時鐘 */
  now(): number;
  random?(n: number): Uint8Array;
  store: { load(me: string): Promise<unknown>; save(me: string, data: PersistedPresence): Promise<void> };
  /** 封給 to 的身分金鑰（kind presence），經他的收件箱（離線時 mqtt 排隊）；回 false ＝ 沒送出去 */
  sendSealed(to: string, body: Record<string, unknown>): Promise<boolean>;
  /** 現在的好友（標準 base64）；名單一時載到 0 筆時，下面的 isFriend 會再查一次資料庫 */
  friends(): readonly string[];
  /** 確實是好友嗎（等名單載完、查得到資料庫的那一種） */
  isFriend(pk: string): Promise<boolean>;
  /** 我封鎖的人 */
  blocked(): Promise<ReadonlySet<string>>;
  onScope(scope: PresenceScope): void;
  /** 在 topic 上發一則空的 retained（等 PUBACK）；沒連上、這張 token 不能發那個主題 → false */
  clearRetained(topic: string): Promise<boolean>;
  connected(): boolean;
  log?(...a: unknown[]): void;
}

/** mqtt.ts 用的加解密（mqtt 只管主題與時間，秘密在這裡） */
export interface PresenceCodec {
  /** 在我自己的 topic 上發 state；那不是我目前的主題、或正在換秘密（舊主題不再發東西）→ null */
  seal(topic: string, state: PresenceState): Promise<string | null>;
  /** 同步再確認一次：topic 現在還是我能發的主題嗎（封完、真的發之前；換秘密可能剛好在封的那段 await 裡開始） */
  current(topic: string): boolean;
  /** 好友主題上收到的；不是我手上哪個好友目前的主題、解不開 → null */
  open(topic: string, payload: string): Promise<{ owner: string; state: PresenceState } | null>;
  /** 好友的主題上收到空的 retained（他換了秘密）；回 true ＝ 那是他目前的主題（mqtt 才把他的狀態清掉） */
  cleared(topic: string): boolean;
  /** 計數（E2E 與模擬的 PRESENCE 檢查：open-failed ＝ 他目前的主題上有一則用他的秘密拆不開） */
  stats?(): Readonly<Record<string, number>>;
}

export interface PresenceService {
  /** 這個服務是哪個帳號的（收到的 share 要交給同一個帳號的服務） */
  readonly me: string;
  start(): Promise<void>;
  stop(): void;
  isReady(): boolean;
  reconcile(): Promise<void>;
  onConnected(): Promise<void>;
  onSealed(from: string, body: Record<string, unknown>): Promise<'share' | 'request' | 'ignored'>;
  codec: PresenceCodec;
  scope(): PresenceScope;
  /** 我目前的秘密給過 pk 嗎（他看得到我的 presence；W5：群組的定時 here 只發給看不到的人） */
  sharesWith(pk: string): boolean;
  stats(): Readonly<Record<string, number>>;
}

/**
 * 手上沒有某個好友的秘密：跟他要，沒回再要的間隔一次比一次長（剛加好友時，我的 request 可能比他把我加進好友名單還早到、
 * 被他當成陌生人的丟掉）。他的主題被清掉（他換了秘密）：同一個好友最少隔 CLEARED_REQUEST_MS
 */
const REQUEST_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 3_600_000, 6 * 3_600_000];
const CLEARED_REQUEST_MS = 10 * 60_000;
/** 回同一個好友的 request：最少隔這麼久 */
const ANSWER_INTERVAL_MS = 60_000;
/** 同一個好友的秘密最少隔多久才換（除非是我要的、或他的主題剛清掉） */
const SHARE_CHANGE_MIN_MS = 10 * 60_000;
/** 訂了好友目前的主題這麼久還什麼都沒收到（broker 一定存著他最後的狀態）→ 手上的秘密過時了，跟他要 */
const STALE_TOPIC_MS = 10 * 60_000;
/** 記著問過誰、回過誰：最多幾個（好友上限 150） */
const MAX_TRACKED = 512;
/** 存檔還沒載完時收到好友的 presence：最多等這麼久（App 重開、persistent session 上的更新可能比載入早到） */
const OPEN_WAIT_MS = 10_000;
/**
 * 好友的 share 的世代 e 最多比現在（秒）多這麼多（W5 審查 L1）：e ＝ max(舊的 + 1, 現在的秒數)，正常不會跑到未來；
 * 被撥偏時鐘的手機產生的遠在未來的 e 收下來，之後他重裝、換手機產生的新秘密（e ＝ 現在）就永遠「比較舊」被拒
 */
const MAX_FUTURE_EPOCH_S = 86_400;

type Self = { secret: PresenceSecret; since: number; sharedWith: Set<string> };
type Next = { secret: PresenceSecret; since: number };
type Peer = PresenceSecret & { at: number; iat: number };

function parsePersisted(raw: unknown): { self: Self | null; next: Next | null; peers: Map<string, Peer> } {
  const out = { self: null as Self | null, next: null as Next | null, peers: new Map<string, Peer>() };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<PersistedPresence>;
  const okE = (e: unknown): e is number => typeof e === 'number' && Number.isSafeInteger(e) && e >= 1;
  const okT = (t: unknown): t is number => typeof t === 'number' && Number.isSafeInteger(t) && t >= 0;
  if (r.self && typeof r.self === 'object') {
    const s = secretFromB64(r.self.s);
    if (s && okE(r.self.e) && okT(r.self.since) && Array.isArray(r.self.sharedWith)) {
      out.self = { secret: { s, e: r.self.e }, since: r.self.since, sharedWith: new Set(r.self.sharedWith.filter((x) => typeof x === 'string')) };
    }
  }
  if (r.next && typeof r.next === 'object') {
    const s = secretFromB64(r.next.s);
    if (s && okE(r.next.e) && okT(r.next.since)) out.next = { secret: { s, e: r.next.e }, since: r.next.since };
  }
  if (r.peers && typeof r.peers === 'object') {
    for (const [pk, v] of Object.entries(r.peers)) {
      const s = secretFromB64(v?.s);
      if (s && okE(v?.e) && okT(v?.at)) out.peers.set(pk, { s, e: v.e, at: v.at, iat: okT(v?.iat) ? v.iat : 0 });
    }
  }
  return out;
}

function remember<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > MAX_TRACKED) m.delete(m.keys().next().value as K);
}

export function createPresenceService(deps: PresenceDeps): PresenceService {
  const log = (...a: unknown[]) => (deps.log ?? ((...x: unknown[]) => console.error('[presence]', ...x)))(...a);
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  let self: Self | null = null;
  let next: Next | null = null;
  const peers = new Map<string, Peer>();
  /** 好友 → 他目前那一代的 tag（算好的；換秘密時重算） */
  const peerTags = new Map<string, string>();
  let myTag: string | null = null;
  let ready = false;
  let stopped = false;
  let lastScopeKey = '';
  let lastScope: PresenceScope = { tag: null, topics: [] };
  /** 跟誰要過秘密：最後一次的時間與第幾次（收到他的 share 就清掉） */
  const askedAt = new Map<string, { at: number; n: number }>();
  const answeredAt = new Map<string, number>();
  /** 好友的秘密上次換的時間、他的主題剛被清掉、我在他目前的主題上打開過狀態的那個 tag、拿到他這份秘密的時間（都在記憶體） */
  const peerChangedAt = new Map<string, number>();
  const clearedFrom = new Set<string>();
  const peerStateTag = new Map<string, string>();
  const peerSince = new Map<string, number>();
  let startedAt = 0;
  const counters: Record<string, number> = {};
  const count = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };
  let queue: Promise<unknown> = Promise.resolve();
  /**
   * 存檔載完之前，reconcile／onConnected／onSealed 都等著（不然載入前先存了一份只有一個好友、沒有我的秘密的檔，
   * 把原本的蓋掉 → 重新產生、重封給每個人）。stop() 也會放行（放行後 run 看到 stopped 就什麼都不做）
   */
  let markLoaded: () => void = () => {};
  const loaded = new Promise<void>((resolve) => { markLoaded = resolve; });

  /** 排成一列做；某一件失敗不擋後面的 */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(() => (stopped ? (undefined as T) : fn()));
    queue = p.catch((e) => log('task failed:', (e as Error)?.message ?? e));
    return p;
  }

  const afterLoad = <T>(fn: () => Promise<T>): Promise<T> => loaded.then(() => run(fn));

  // 舊的世代遠在未來（之前手機時鐘撥快了很多）：好友會拒收（MAX_FUTURE_EPOCH_S），從那裡一直 +1 下去就永遠收不到 → 從現在重新算（W5 複審）
  const fresh = (): PresenceSecret => {
    const prev = Math.max(self?.secret.e ?? 0, next?.secret.e ?? 0);
    const tooFar = prev > Math.floor(deps.now() / 1000) + MAX_FUTURE_EPOCH_S;
    return { s: random(32), e: nextEpoch(tooFar ? null : prev, deps.now()) };
  };

  async function persist(): Promise<void> {
    if (stopped) return;   // 停掉之後（換帳號、登出、清除帳號）不再寫：清掉的存檔不會被晚到的寫回去
    const data: PersistedPresence = {
      v: 1,
      self: self ? { s: secretToB64(self.secret.s), e: self.secret.e, since: self.since, sharedWith: [...self.sharedWith] } : null,
      next: next ? { s: secretToB64(next.secret.s), e: next.secret.e, since: next.since } : null,
      peers: Object.fromEntries([...peers].map(([pk, p]) => [pk, { s: secretToB64(p.s), e: p.e, at: p.at, iat: p.iat }])),
    };
    await deps.store.save(deps.me, data);
  }

  async function refreshTags(): Promise<void> {
    myTag = self ? await presenceTag(self.secret) : null;
    for (const pk of [...peerTags.keys()]) if (!peers.has(pk)) peerTags.delete(pk);
    for (const [pk, p] of peers) peerTags.set(pk, await presenceTag(p));
  }

  function emitScope(): void {
    if (stopped) return;
    const order = deps.friends().filter((pk) => pk !== deps.me);
    const listed = new Set(order);
    const owners = [...order.filter((pk) => peers.has(pk)), ...[...peers.keys()].filter((pk) => !listed.has(pk))];
    const topics: string[] = [];
    for (const pk of owners) {
      const tag = peerTags.get(pk);
      if (!tag) continue;
      try { topics.push(presenceTopic(pk, tag)); } catch { /* 不是標準寫法的公鑰：不會發生（只收好友的） */ }
      if (topics.length >= MAX_PRESENCE_TOPICS) break;
    }
    const scope: PresenceScope = { tag: myTag, topics };
    const key = `${scope.tag ?? ''}|${topics.join(',')}`;
    lastScope = scope;
    if (key === lastScopeKey) return;
    lastScopeKey = key;
    try { deps.onScope(scope); } catch (e) { log('onScope failed:', (e as Error)?.message ?? e); }
  }

  /** 現在能拿到我的秘密的人：好友（名單一時是空的也不會誤判，見 isFriend）減掉我封鎖的 */
  async function recipients(): Promise<Set<string>> {
    const blocked = await deps.blocked();
    const out = new Set(deps.friends().filter((pk) => pk !== deps.me && !blocked.has(pk)));
    // 拿過秘密、手上有他秘密的人不在名單上：名單可能一時沒載到（chatStore readiness race）→ 再查一次資料庫才算數
    const doubtful = new Set([...(self?.sharedWith ?? []), ...peers.keys()].filter((pk) => !out.has(pk) && !blocked.has(pk)));
    for (const pk of doubtful) if (await deps.isFriend(pk)) out.add(pk);
    return out;
  }

  async function share(to: string): Promise<boolean> {
    if (!self || stopped) return false;
    try {
      const sent = await deps.sendSealed(to, shareBody(self.secret));
      count(sent ? 'share-sent' : 'share-not-sent');
      return sent;
    } catch (e) {
      count('share-failed');
      log('share failed:', (e as Error)?.message ?? e);
      return false;
    }
  }

  /** minInterval 沒給 ＝ 照 REQUEST_BACKOFF_MS（第幾次問） */
  async function ask(pk: string, minInterval?: number): Promise<void> {
    const now = deps.now();
    const last = askedAt.get(pk);
    const wait = minInterval ?? REQUEST_BACKOFF_MS[Math.min(Math.max(0, (last?.n ?? 1) - 1), REQUEST_BACKOFF_MS.length - 1)];
    if (stopped || (last && now - last.at < wait)) return;
    remember(askedAt, pk, { at: now, n: (last?.n ?? 0) + 1 });
    try {
      const sent = await deps.sendSealed(pk, requestBody(peers.get(pk)?.e));
      count(sent ? 'request-sent' : 'request-not-sent');
    } catch (e) {
      log('request failed:', (e as Error)?.message ?? e);
    }
  }

  /**
   * 封給這些人：先記進 sharedWith 並存檔、再送（審查 W4 #9：送到一半當掉、之後刪了他 → 照樣換秘密），沒送出去的再拿掉。
   * 停掉了就不再送
   */
  async function shareAll(pks: readonly string[]): Promise<void> {
    if (!self || pks.length === 0 || stopped) return;
    const mine = self;
    for (const pk of pks) mine.sharedWith.add(pk);
    await persist();
    let failed = false;
    for (const pk of pks) {
      if (stopped || self !== mine) return;
      if (!(await share(pk))) { mine.sharedWith.delete(pk); failed = true; }
    }
    if (failed) await persist();
  }

  /** 舊主題清掉了（PUBACK）才換上 next，再封給現在的好友（清的那段 await 裡名單可能又變了 → 清完再算一次） */
  async function completeRotation(): Promise<void> {
    if (!next) return;
    if (self && myTag) {
      if (!deps.connected()) return;
      const oldTopic = presenceTopic(deps.me, myTag);
      let cleared = false;
      try { cleared = await deps.clearRetained(oldTopic); } catch { cleared = false; }
      if (stopped || !next) return;
      if (!cleared) { count('clear-not-confirmed'); return; }
      count('cleared-old-topic');
    }
    self = { secret: next.secret, since: next.since, sharedWith: new Set() };
    next = null;
    await refreshTags();
    await persist();
    count('rotated');
    emitScope();
    await shareAll([...(await recipients())]);
  }

  async function doReconcile(): Promise<void> {
    const to = await recipients();
    // 刪掉、封鎖的好友：他的秘密不留（不再訂他的主題）
    let dropped = false;
    for (const pk of [...peers.keys()]) if (!to.has(pk)) { peers.delete(pk); dropped = true; }
    if (dropped) { await refreshTags(); await persist(); count('peer-dropped'); }
    const reason = next ? null : rotationReason(self ? { since: self.since, sharedWith: [...self.sharedWith] } : null, to, deps.now());
    if (reason === 'initial') {
      self = { secret: fresh(), since: deps.now(), sharedWith: new Set() };
      await refreshTags();
      await persist();
      count('created');
      emitScope();
    } else if (reason) {
      next = { secret: fresh(), since: deps.now() };
      await persist();
      count(`rotate:${reason}`);
      log('presence secret rotation pending:', reason);
    }
    if (next) await completeRotation();
    if (self && !next) await shareAll([...to].filter((pk) => !self!.sharedWith.has(pk)));
    for (const pk of to) if (!peers.has(pk)) await ask(pk);
    // 訂了他目前的主題 10 分鐘還什麼都沒打開過：broker 一定存著主人最後的狀態 → 我手上的過時了（他換秘密時那一封弄丟了，審查 W4 #1）
    const now = deps.now();
    const subscribed = new Set(lastScope.topics.map((t) => parsePresenceTopic(t)?.owner));
    for (const pk of to) {
      const tag = peerTags.get(pk);
      if (!tag || !subscribed.has(pk) || peerStateTag.get(pk) === tag) continue;
      if (now - Math.max(peerSince.get(pk) ?? 0, startedAt) >= STALE_TOPIC_MS) { count('peer-topic-silent'); await ask(pk); }
    }
    emitScope();
  }

  async function doOnSealed(from: string, body: Record<string, unknown>): Promise<'share' | 'request' | 'ignored'> {
    const parsed = parsePresenceBody(body);
    if (!parsed) { count('malformed'); return 'ignored'; }
    // 只跟現在的好友交換（封鎖的不算）；同群組的成員不是好友 → 不收也不回
    const blocked = await deps.blocked();
    if (from === deps.me || blocked.has(from) || !(await deps.isFriend(from))) { count('not-a-friend'); return 'ignored'; }
    if (parsed.t === 'share') {
      if (parsed.secret.e > Math.floor(deps.now() / 1000) + MAX_FUTURE_EPOCH_S) { count('share-future-epoch'); return 'ignored'; }
      const stored = peers.get(from);
      const verdict = compareShare(stored, { ...parsed.secret, iat: parsed.iat });
      count(`share-${verdict}`);
      if (verdict !== 'new') return 'ignored';
      const now = deps.now();
      // 一直換秘密 ＝ 逼我一直換 token 重連：同一個好友 10 分鐘最多換一次，除非是我跟他要的、或他目前的主題剛被清掉（他剛換秘密）
      const last = peerChangedAt.get(from);
      if (stored && last !== undefined && now - last < SHARE_CHANGE_MIN_MS && !askedAt.has(from) && !clearedFrom.has(from)) {
        count('share-too-often');
        return 'ignored';
      }
      peers.set(from, { ...parsed.secret, at: now, iat: parsed.iat });
      peerTags.set(from, await presenceTag(parsed.secret));
      remember(peerChangedAt, from, now);
      remember(peerSince, from, now);
      askedAt.delete(from);
      clearedFrom.delete(from);
      await persist();
      emitScope();
      // 他還沒有我的（剛加好友：我先封給他的那一封可能被他當陌生人丟了）→ 回封一份，不必等他來要
      if (self && !next && !self.sharedWith.has(from)) await shareAll([from]);
      return 'share';
    }
    // request：只回現在的好友，每個人限速；正在換秘密的時候不回（換好之後本來就會封給他）。have 只記數：他說手上有哪一代
    //   不代表他手上的是對的（同一代的另一份、被清掉的主題），照樣回目前這一份
    if (!self || next) { count('request-unanswered'); return 'ignored'; }
    const now = deps.now();
    if (now - (answeredAt.get(from) ?? -Infinity) < ANSWER_INTERVAL_MS) { count('request-rate-limited'); return 'ignored'; }
    remember(answeredAt, from, now);
    count(parsed.have === self.secret.e ? 'request-have-current' : 'request-have-older');
    await shareAll([from]);
    return 'request';
  }

  const codec: PresenceCodec = {
    async seal(topic, state) {
      if (!codec.current(topic) || !self) return null;
      return JSON.stringify(await sealPresence({ secret: self.secret, topic, state }));
    },
    current(topic) {
      return !stopped && !!self && !next && !!myTag && topic === presenceTopic(deps.me, myTag);
    },
    async open(topic, payload) {
      const parsed = parsePresenceTopic(topic);
      if (stopped || !parsed || parsed.owner === deps.me) return null;
      // 還沒載完（手上還沒有好友的秘密）：等一下再拆，不然這一則就當成「不是他的主題」丟了（下一則要等 4 分鐘）
      if (!ready) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([loaded, new Promise<void>((resolve) => { timer = setTimeout(resolve, OPEN_WAIT_MS); })]);
        clearTimeout(timer);
        if (stopped || !ready) { count('open-before-load'); return null; }
      }
      const peer = peers.get(parsed.owner);
      if (!peer || peerTags.get(parsed.owner) !== parsed.tag) { count('open-unknown-topic'); return null; }
      try {
        const state = await openPresence({ secret: peer, topic, payload });
        remember(peerStateTag, parsed.owner, parsed.tag);
        count('opened');
        return { owner: parsed.owner, state };
      } catch {
        count('open-failed');
        return null;
      }
    },
    cleared(topic) {
      const parsed = parsePresenceTopic(topic);
      // 只有他「目前」的主題被清掉才算（舊主題上的空訊息、別人的主題：不動他現在的狀態，審查 W4 #8）
      if (!ready || stopped || !parsed || !peers.has(parsed.owner) || peerTags.get(parsed.owner) !== parsed.tag) return false;
      count('peer-cleared');
      clearedFrom.add(parsed.owner);
      void run(() => ask(parsed.owner, CLEARED_REQUEST_MS));
      return true;
    },
    stats: () => ({ ...counters }),
  };

  return {
    me: deps.me,
    async start() {
      let loadError: unknown = null;
      try {
        await run(async () => {
          const stored = parsePersisted(await deps.store.load(deps.me));
          self = stored.self;
          next = stored.next;
          for (const [pk, p] of stored.peers) peers.set(pk, p);
          await refreshTags();
          startedAt = deps.now();
          ready = true;
          emitScope();
        });
      } catch (e) {
        loadError = e;
      }
      if (!ready && !stopped) {
        // 載不起來（存檔壞掉、資料庫打不開）：不要把現有的存檔蓋掉 —— 停在這裡，下次啟動再試
        stopped = true;
        markLoaded();
        throw new Error(`presence: could not load the stored state (${(loadError as Error)?.message ?? loadError})`);
      }
      markLoaded();
      await run(doReconcile);
    },
    stop() {
      stopped = true;
      ready = false;
      markLoaded();
    },
    isReady: () => ready && !stopped,
    reconcile: () => afterLoad(doReconcile),
    onConnected: () => afterLoad(doReconcile),
    onSealed: (from, body) => afterLoad(() => doOnSealed(from, body)),
    codec,
    scope: () => lastScope,
    sharesWith: (pk) => !stopped && !!self && !next && self.sharedWith.has(pk),
    stats: () => ({ ...counters }),
  };
}
