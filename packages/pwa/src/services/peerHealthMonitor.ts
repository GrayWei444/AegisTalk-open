/**
 * Peer Health Monitor — P2P (WebRTC DataChannel) 健康監控 + 自動重連
 *
 * 跟 mqttHealthMonitor 是「分層」關係,不是各判各的:
 *   - mqttHealthMonitor = 第一層,維持「信令管道 MQTT」活著(死 socket → forceReconnect)。
 *   - peerHealthMonitor = 第二層,**只在 MQTT 確定連線的前提上**才檢查 P2P。
 *
 * 為什麼必須 gate 在 MQTT 上:P2P 重連的 offer / answer / ICE 全靠 MQTT 載;MQTT 沒連上時
 * 不但信令送不出去,連 presence(「對方 online」)都是 stale 不可信的。所以 MQTT 沒好之前
 * 這層完全不動手,交給 mqttHealthMonitor 先把 MQTT 救回來。
 *
 * 治的病:WebRTC 連線可能卡在 connecting / checking(trickle-ICE race),而 webrtc.ts 的
 * state handler 不會自己重連、presence 重連又只在「離線→上線那一刻」觸發一次 → 持續 online
 * 時 P2P 默默死掉就再也沒人救(AegisTrans 實測卡死後 22 分鐘不自救)。本 monitor 定時偵測
 * 「presence 認為 online、但 DataChannel 沒 open 超過寬限期」→ 重連。
 *
 * 來源:回灌自 AegisTrans `peerHealthMonitor.ts`(commit ff6e381,雙瀏覽器 e2e + 實機驗過)。
 * 對應 LEARNINGS_FROM_AEGISTRANS.md §7 真因 B。AegisTalk 端寬限期放寬(見 STUCK_GRACE_MS)。
 *
 * log 一律用 console.error(Vite production build 會剝掉 console.log/warn,只留 error)。
 */

import { mqttService } from './mqtt';
import { diagLog } from '../utils/diagLog';

const PROBE_INTERVAL_FG = 10_000;  // 前景 10s(對齊 mqttHealthMonitor)
const PROBE_INTERVAL_BG = 30_000;  // 背景 30s
// DataChannel 沒 open 超過此時間才算「卡住」要重連。正常握手 <1s 就 open。AegisTrans 桌面用 15s,
// AegisTalk 出貨是 mobile(Capacitor):手機 WebRTC cold-start / ICE 在弱網下偶爾較慢,放寬到 20s
// 避免把「只是慢、其實正在交握」的連線誤殺重連(過度重連會耗電,見 LEARNINGS §6「不要學的部分」)。
const STUCK_GRACE_MS = 20_000;

export interface PeerHealthDeps {
  /** 目前 presence 認為 online 的 known peers(在線好友)。 */
  getOnlineKnownPeers: () => string[];
  /** 該 peer 的 DataChannel 是否真的 open。 */
  isPeerHealthy: (pk: string) => boolean;
  /** 卡住 → 重連(內含 initiator tiebreak,避免兩台同時重連造成 glare 風暴)。 */
  reconnectPeer: (pk: string) => void;
  /** 殭屍判定（LEARNINGS §13）：readyState='open' 但 >35s 無任何 inbound = 傳輸已死。 */
  isPeerZombie?: (pk: string) => boolean;
}

class PeerHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isForeground = true;
  private deps: PeerHealthDeps | null = null;
  // 每個 peer「第一次被觀察到不健康」的時間戳,用來算寬限期。
  private stuckSince = new Map<string, number>();

  start(deps: PeerHealthDeps): void {
    this.deps = deps;
    if (this.timer) return; // 已在運行
    console.error('[PeerHealth] Starting');
    this.stuckSince.clear();
    this._schedule();
  }

  stop(): void {
    console.error('[PeerHealth] Stopping');
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stuckSince.clear();
    this.deps = null;
  }

  onVisibilityChange(isForeground: boolean): void {
    this.isForeground = isForeground;
    this._schedule();
    if (isForeground) this._probe();
  }

  onNetworkChange(isOnline: boolean): void {
    // 網路恢復 → 立即檢查(MQTT 可能也剛回來,gate 沒過就會自己 return)
    if (isOnline) this._probe();
  }

  /** 外部立即觸發 — 例:MQTT 剛(重)連上,P2P 很可能也跟著死了,馬上補一次檢查。 */
  probeNow(): void { this._probe(); }

  private _schedule(): void {
    if (this.timer) clearInterval(this.timer);
    if (!this.deps) return;
    const interval = this.isForeground ? PROBE_INTERVAL_FG : PROBE_INTERVAL_BG;
    this.timer = setInterval(() => this._probe(), interval);
  }

  private _probe(): void {
    const deps = this.deps;
    if (!deps) return;

    // ① MQTT gate — P2P 健康不能自己獨立判斷,必須先確定 MQTT 真的連著。
    //    沒連 → 信令送不出去 + presence stale → 這拍什麼都不做,等 mqttHealthMonitor 救 MQTT。
    if (!mqttService.isConnected()) { diagLog('[DIAG:PeerHealth] probe skip — MQTT not connected'); return; }

    // ② MQTT 確定連著,才評估 P2P。
    const online = deps.getOnlineKnownPeers();
    const onlineSet = new Set(online);
    // watchdog 可見性：每拍印出「presence online 的好友數 / 其中 DataChannel 沒 open 的(不健康)」
    //   → 讀 log 就能分辨「watchdog 根本沒看到該 peer(presence 沒列入)」vs「看到了但還在寬限/重連」。
    const _unhealthy = online.filter((pk) => !deps.isPeerHealthy(pk));
    diagLog(`[DIAG:PeerHealth] probe online=${online.length} unhealthy=${_unhealthy.length}${_unhealthy.length ? ' [' + _unhealthy.map((p) => p.slice(0, 8)).join(',') + ']' : ''}`);

    // 已離線的 peer → 清掉它的卡住計時(下次上線重新算)
    for (const pk of [...this.stuckSince.keys()]) {
      if (!onlineSet.has(pk)) this.stuckSince.delete(pk);
    }

    const now = Date.now();
    for (const pk of online) {
      if (deps.isPeerHealthy(pk)) {
        this.stuckSince.delete(pk);
        continue;
      }
      // ⚠️ 殭屍免寬限（LEARNINGS §13）：寬限是給「還在握手、可能自己開起來」的通道；
      //   殭屍已經用 35s 無 inbound 證明傳輸死了，再等 20s（BG 下實測要跨兩拍 probe = 最多 +60s）
      //   只是讓使用者多盯一段死聊天（full-suite 3.8 實證：偵測 48s、重連卻拖到 100s+ 才發生）。
      //   立刻重連。不會風暴：重建成功 → inbound 恢復 → 不再是殭屍 → 觸發條件自己消失。
      if (deps.isPeerZombie?.(pk)) {
        console.error(`[PeerHealth] ZOMBIE peer (open but transport dead) → reconnect NOW (no grace): ${pk.slice(0, 8)}`);
        deps.reconnectPeer(pk);
        this.stuckSince.delete(pk);
        continue;
      }
      const since = this.stuckSince.get(pk);
      if (since === undefined) {
        this.stuckSince.set(pk, now); // 第一次觀察到不健康 → 開始計寬限
        continue;
      }
      if (now - since >= STUCK_GRACE_MS) {
        console.error(`[PeerHealth] Stuck peer (no open DataChannel ${Math.round((now - since) / 1000)}s) → reconnect: ${pk.slice(0, 8)}`);
        deps.reconnectPeer(pk);
        this.stuckSince.delete(pk); // 重置:下一拍給新連線重新算寬限,避免狂重連
      }
    }
  }
}

export const peerHealthMonitor = new PeerHealthMonitor();
