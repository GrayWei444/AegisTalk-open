/**
 * MQTT Health Monitor — 連線健康監控 + 自動重連
 *
 * 取代 mqtt.js 內建重連機制，專門應對 OS 殺 socket 的場景：
 * - Samsung FreecessHandler 凍結 app + 摧毀 TCP sockets
 * - Android Doze 模式暫停網路
 * - iOS 背景暫停
 *
 * 策略：
 * 1. 定期檢查 WebSocket readyState + lastMessageReceivedAt
 * 2. 偵測到死連線 → forceReconnect()（完全銷毀 + 新建）
 * 3. 重連失敗 → 指數退避 (1s → 2s → 4s → ... → 30s max)；連續 5 次後每 ~60s 持續重試（傳輸統一 X1）
 * 4. 重連成功 → 重置退避
 */

import { mqttService, ConnectionState } from './mqtt';

// 設定
const PROBE_INTERVAL_FG = 10_000;  // 前景 10s
const PROBE_INTERVAL_BG = 30_000;  // 背景 30s
const STALE_THRESHOLD = 90_000;    // 90s 無封包 = 疑似死連線（keepalive=30s，broker 會每 30s 回 PINGRESP）
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
const RECONNECT_JITTER = 0.3;      // ±30% jitter
const MAX_CONSECUTIVE_FAILURES = 5; // 連續失敗超過此數 → 改用慢速退避（不再暫停：前景桌機不會觸發 resume）
const RECONNECT_SLOW_DELAY = 60_000;

type MonitorState = 'idle' | 'probing' | 'reconnecting' | 'paused';

class MqttHealthMonitor {
  private state: MonitorState = 'idle';
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private isForeground = true;
  private isNetworkOnline = true;
  // App 主動優雅關閉(gracefulShutdown)後設 true,讓 probe 不再自動重連,
  // 否則背景 probe 會立刻把剛宣告的 offline presence 重連+覆蓋回 online(flap)。
  // resume 時 onVisibilityChange(true) 會清掉。
  private suspended = false;
  /** 每次 _reconnect 加一；退避等待醒來時不是最新的一輪就作廢（對應 AegisPlay f3103670） */
  private reconnectRound = 0;

  /**
   * 啟動健康監控
   */
  start(): void {
    if (this.probeTimer) return; // 已在運行

    console.error('[HealthMonitor] Starting');
    this.state = 'probing';
    this.reconnectAttempt = 0;

    this._scheduleProbe();
  }

  /**
   * 停止健康監控
   */
  stop(): void {
    console.error('[HealthMonitor] Stopping');
    this.state = 'idle';
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * 暫停監控（App 優雅關閉時呼叫）
   *
   * 與 stop() 不同：額外設 suspended=true，使任何殘存/被 onVisibilityChange(false)
   * 重建的 probe timer 都不會觸發重連。resume(onVisibilityChange(true)) 才解除。
   * 避免「gracefulShutdown 宣告 offline → 背景 probe 立刻重連覆蓋回 online」的 flap。
   */
  suspend(): void {
    console.error('[HealthMonitor] Suspending (graceful shutdown)');
    this.suspended = true;
    this.stop();
  }

  /**
   * App 可見性變化通知
   */
  onVisibilityChange(isForeground: boolean): void {
    this.isForeground = isForeground;
    if (isForeground) {
      console.error('[HealthMonitor] App resumed → immediate probe');
      // App 回到前景：解除暫停 + 重置退避 + 立即探測 + 切換到較快的間隔
      this.suspended = false;
      this.reconnectAttempt = 0;
      this.state = 'probing';
      this._scheduleProbe();
      this._probe();
    } else {
      // 背景：切換到較慢的間隔
      this._scheduleProbe();
    }
  }

  /**
   * 網路狀態變化通知
   */
  onNetworkChange(isOnline: boolean): void {
    const wasOffline = !this.isNetworkOnline;
    this.isNetworkOnline = isOnline;

    if (isOnline && wasOffline) {
      console.error('[HealthMonitor] Network restored → immediate reconnect');
      this.reconnectAttempt = 0; // 重置退避
      this._probe();
    } else if (!isOnline) {
      console.error('[HealthMonitor] Network lost → pausing probes');
      this.state = 'paused';
    }
  }

  /**
   * 手動觸發探測（外部呼叫）
   */
  probeNow(): void {
    this._probe();
  }

  /**
   * 設定 probe 定時器（根據前景/背景調整間隔）
   */
  private _scheduleProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
    }
    const interval = this.isForeground ? PROBE_INTERVAL_FG : PROBE_INTERVAL_BG;
    this.probeTimer = setInterval(() => this._probe(), interval);
  }

  /**
   * 核心探測邏輯
   */
  private async _probe(): Promise<void> {
    // App 已優雅關閉(背景)→ 不自動重連,等 resume 解除
    if (this.suspended) return;
    // 網路離線時不探測
    if (!this.isNetworkOnline) return;
    // 正在重連中不重複觸發
    if (this.state === 'reconnecting') return;

    const health = mqttService.getHealthInfo();

    // 沒有 publicKey = 未曾連線，不需要監控
    if (!health.publicKey) return;

    // 未完成認證（無 PIN hash）→ 不嘗試重連（避免無意義的 _fetchMqttToken 循環）
    if (!health.hasPinHash) return;

    // Token 取得失敗（403）→ 不重連，等 cooldown 結束
    if (health.tokenFailed) return;

    // 檢查 1: WebSocket readyState
    if (health.wsReadyState !== null && health.wsReadyState !== WebSocket.OPEN) {
      console.error(`[HealthMonitor] Dead socket detected (ws.readyState=${health.wsReadyState})`);
      await this._reconnect();
      return;
    }

    // 檢查 2: 連線狀態不是 CONNECTED
    if (health.state !== ConnectionState.CONNECTED || !health.clientConnected) {
      console.error(`[HealthMonitor] Not connected (state=${health.state}, client=${health.clientConnected})`);
      await this._reconnect();
      return;
    }

    // 檢查 3: 太久沒收到訊息（zombie 連線）
    // 只有在有 lastMessageReceivedAt 的情況下檢查（初始為 0 = 尚未收到任何訊息）
    if (health.lastMessageReceivedAt > 0) {
      const elapsed = Date.now() - health.lastMessageReceivedAt;
      if (elapsed > STALE_THRESHOLD) {
        console.error(`[HealthMonitor] Stale connection (${Math.round(elapsed / 1000)}s since last message)`);
        await this._reconnect();
        return;
      }
    }
  }

  /**
   * 執行重連（含指數退避 + jitter）
   */
  private async _reconnect(): Promise<void> {
    this.state = 'reconnecting';
    const round = ++this.reconnectRound;

    // 指數退避；連續失敗太多次 → 慢速重試（broker 長時間不可用時省電，但不放棄；傳輸統一 X1）
    const baseDelay = this.reconnectAttempt >= MAX_CONSECUTIVE_FAILURES
      ? RECONNECT_SLOW_DELAY
      : Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_DELAY);
    // 加 jitter 避免雷群效應
    const jitter = baseDelay * RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(baseDelay + jitter));

    if (this.reconnectAttempt > 0) {
      console.error(`[HealthMonitor] Reconnect attempt #${this.reconnectAttempt + 1}, delay=${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      // 等待（最長約 78 秒）中被 stop／suspend（優雅關閉剛宣告離線）、斷網，或回前景已另起一輪 → 這輪作廢。
      //   新的一輪還在跑時狀態也是 reconnecting，所以比對輪次，不然會把進行中的連線拆掉
      //   （對應 AegisPlay 26859e56／f3103670）
      if (this.suspended || this.state !== 'reconnecting' || round !== this.reconnectRound) return;
    }

    // 重連前再次檢查網路
    if (!this.isNetworkOnline) {
      this.state = 'paused';
      return;
    }

    try {
      await mqttService.forceReconnect();

      // 檢查是否真的連上了
      const health = mqttService.getHealthInfo();
      if (health.clientConnected && health.state === ConnectionState.CONNECTED) {
        console.error('[HealthMonitor] Reconnect successful');
        this.reconnectAttempt = 0;
        this.state = 'probing';
        return;
      }
    } catch (err) {
      console.error('[HealthMonitor] Reconnect failed:', err);
    }

    // 重連失敗
    this.reconnectAttempt++;
    this.state = 'probing';
    // 不立即重試，等下一次 probe
  }
}

export const mqttHealthMonitor = new MqttHealthMonitor();
