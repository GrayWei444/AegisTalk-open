/**
 * useMqtt Hook - MQTT 連線 React Hook
 *
 * 提供 MQTT 連線的 React 整合
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  mqttService,
  ConnectionState,
  MessageType,
  type MqttMessage,
} from '@services/mqtt';

interface MqttHookState {
  connectionState: ConnectionState;
  isConnected: boolean;
  error: Error | null;
}

interface UseMqttOptions {
  autoConnect?: boolean;
  isDev?: boolean;
}

/**
 * MQTT 連線 Hook
 */
export function useMqtt(publicKeyBase64: string | null, options: UseMqttOptions = {}) {
  const { autoConnect = false, isDev = false } = options;

  const [state, setState] = useState<MqttHookState>({
    connectionState: ConnectionState.DISCONNECTED,
    isConnected: false,
    error: null,
  });

  const cleanupRef = useRef<(() => void)[]>([]);

  /**
   * 連線
   */
  const connect = useCallback(async () => {
    if (!publicKeyBase64) {
      setState((s) => ({
        ...s,
        error: new Error('No public key provided'),
      }));
      return;
    }

    try {
      setState((s) => ({ ...s, error: null }));
      await mqttService.connect(publicKeyBase64, isDev);
    } catch (error) {
      setState((s) => ({
        ...s,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, [publicKeyBase64, isDev]);

  /**
   * 斷開連線
   */
  const disconnect = useCallback(() => {
    mqttService.disconnect();
  }, []);

  /**
   * 訂閱訊息
   */
  const subscribe = useCallback(
    (type: MessageType | '*', callback: (message: MqttMessage) => void) => {
      const unsub = mqttService.onMessage(type, callback);
      cleanupRef.current.push(unsub);
      return unsub;
    },
    []
  );

  /**
   * 發送訊息給用戶
   */
  const sendToUser = useCallback(
    (recipientPublicKeyBase64: string, type: MessageType, payload: unknown) => {
      mqttService.sendToUser(recipientPublicKeyBase64, type, payload);
    },
    []
  );

  // （WebRTC 的 offer／answer／ICE、打字中：開源第 4 步起 1 對 1 的信令只有封好的 DIRECT_SEALED（services/directSignal），
  //   這裡不再有明文的送法）

  // 群組主題的訂閱沒有個別的 subscribe／unsubscribe（W3）：mqtt 照 token 範圍（AppProvider 設的群組主題表）調整

  // 監聽連線狀態變化
  useEffect(() => {
    const unsub = mqttService.onStateChange((newState) => {
      setState((s) => ({
        ...s,
        connectionState: newState,
        isConnected: newState === ConnectionState.CONNECTED,
      }));
    });

    cleanupRef.current.push(unsub);

    // 設定初始狀態
    setState((s) => ({
      ...s,
      connectionState: mqttService.getState(),
      isConnected: mqttService.getState() === ConnectionState.CONNECTED,
    }));

    // 漂移自癒（2026-08-19 round 6 事故）：state-change 事件可能在 listener 掛上前就發射完
    // （或在 health monitor teardown→fresh connect 的縫隙被漏接）→ React 端 isConnected 卡在
    // false，而 service 其實連著、訊息照收 → 所有掛在 `mqtt.isConnected` guard 後的訂閱 effect
    // 永不重跑 → X3DH_INIT 進 pendingMessages buffer 後永無人 replay（實錄：對方 INIT 到了、
    // 「Buffered (no listener yet)」之後 60 秒毫無下文 → 恢復後永遠沒 session）。
    // 對策同 mqttHealthMonitor 的哲學——事件會說謊，用 probe 對齊實況。
    // setState 帶相同值時 React bail out，不會造成多餘 render。
    const drift = setInterval(() => {
      const actual = mqttService.getState();
      setState((s) => (s.connectionState === actual ? s : {
        ...s,
        connectionState: actual,
        isConnected: actual === ConnectionState.CONNECTED,
      }));
    }, 2_000);

    return () => {
      unsub();
      clearInterval(drift);
    };
  }, []);

  // 自動連線 — only on mount or when publicKey changes, NOT on every disconnect
  // mqtt.js handles reconnection internally via reconnectPeriod
  const hasConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnect && publicKeyBase64 && !hasConnectedRef.current) {
      hasConnectedRef.current = true;
      connect();
    }
  }, [autoConnect, publicKeyBase64, connect]);

  // 清理
  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
  }, []);

  return useMemo(() => ({
    // 狀態
    connectionState: state.connectionState,
    isConnected: state.isConnected,
    error: state.error,

    // 連線控制
    connect,
    disconnect,

    // 訊息
    subscribe,
    sendToUser,
  }), [
    state.connectionState, state.isConnected, state.error,
    connect, disconnect, subscribe, sendToUser,
  ]);
}

export default useMqtt;
