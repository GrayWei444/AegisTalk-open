/**
 * Network Monitor — 網路狀態偵測
 *
 * Native (Android/iOS): 使用 @capacitor/network 的 networkStatusChange 事件
 * Web/PWA: 使用 navigator.onLine + online/offline 事件
 *
 * 網路恢復 → 通知 callback 立即重連
 * 網路斷開 → 通知 callback 暫停探測
 */

import { Capacitor } from '@capacitor/core';

type NetworkChangeCallback = (isOnline: boolean) => void;

class NetworkMonitor {
  private listeners: Set<NetworkChangeCallback> = new Set();
  private _isOnline = true;
  private cleanupFns: (() => void)[] = [];
  private started = false;

  /**
   * 啟動網路監控
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (Capacitor.isNativePlatform()) {
      await this._startNative();
    } else {
      this._startWeb();
    }

    console.error(`[NetworkMonitor] Started (platform=${Capacitor.getPlatform()}, online=${this._isOnline})`);
  }

  /**
   * 停止網路監控
   */
  stop(): void {
    this.started = false;
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
    this.listeners.clear();
    console.error('[NetworkMonitor] Stopped');
  }

  /**
   * 監聽網路狀態變化
   */
  onChange(callback: NetworkChangeCallback): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  /**
   * 當前是否在線
   */
  get isOnline(): boolean {
    return this._isOnline;
  }

  /**
   * Native: @capacitor/network
   */
  private async _startNative(): Promise<void> {
    const { Network } = await import('@capacitor/network');

    // 取得初始狀態
    const status = await Network.getStatus();
    this._isOnline = status.connected;

    // 監聽變化
    const handle = await Network.addListener('networkStatusChange', (status) => {
      const newOnline = status.connected;
      if (newOnline !== this._isOnline) {
        this._isOnline = newOnline;
        console.error(`[NetworkMonitor] Network ${newOnline ? 'ONLINE' : 'OFFLINE'} (native, type=${status.connectionType})`);
        this._notify(newOnline);
      }
    });

    this.cleanupFns.push(() => handle.remove());
  }

  /**
   * Web/PWA: online/offline events
   */
  private _startWeb(): void {
    this._isOnline = navigator.onLine;

    const onOnline = () => {
      if (!this._isOnline) {
        this._isOnline = true;
        console.error('[NetworkMonitor] Network ONLINE (web)');
        this._notify(true);
      }
    };

    const onOffline = () => {
      if (this._isOnline) {
        this._isOnline = false;
        console.error('[NetworkMonitor] Network OFFLINE (web)');
        this._notify(false);
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    this.cleanupFns.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  }

  private _notify(isOnline: boolean): void {
    for (const cb of this.listeners) {
      try {
        cb(isOnline);
      } catch (err) {
        console.error('[NetworkMonitor] Listener error:', err);
      }
    }
  }
}

export const networkMonitor = new NetworkMonitor();
