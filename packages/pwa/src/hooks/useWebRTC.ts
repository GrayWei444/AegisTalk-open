/**
 * useWebRTC Hook - WebRTC P2P 連線 React Hook
 *
 * 提供 WebRTC 連線的 React 整合
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  webrtcService,
  PeerConnectionState,
  DataChannelState,
} from '@services/webrtc';
import { useChatStore, findFriendSettled } from '../stores/chatStore';
import { useGroupStore } from '../stores/groupStore';
import { isBlacklisted } from '../services/localBlacklist';
import { createOfferProof, verifyOfferProof } from '../services/offerProof';
import { getAllGroupKeys, getGroupKey } from '../services/groupKey';
import { getGroupEngine } from '../services/groupEngineHost';

interface PeerState {
  publicKeyBase64: string;
  connectionState: PeerConnectionState;
  dataChannelState: DataChannelState;
}

interface UseWebRTCOptions {
  onMessage?: (peerPublicKey: string, data: ArrayBuffer | string) => void;
  onPeerConnected?: (peerPublicKey: string) => void;
  onPeerDisconnected?: (peerPublicKey: string) => void;
}

/**
 * WebRTC P2P 連線 Hook
 */
export function useWebRTC(
  localPublicKeyBase64: string | null,
  options: UseWebRTCOptions = {}
) {
  const { onMessage, onPeerConnected, onPeerDisconnected } = options;

  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [isInitialized, setIsInitialized] = useState(false);

  const cleanupRef = useRef<(() => void)[]>([]);

  /**
   * 初始化 WebRTC 服務
   */
  useEffect(() => {
    if (!localPublicKeyBase64) return;

    webrtcService.initialize(localPublicKeyBase64);
    // 誰能對我發 offer：好友、或同一個群組的成員（群訊逐人 P2P 送，成員不一定是好友）。稽核 M5，對應 AegisPlay B39
    // 冷啟動時好友清單還沒載入 → 不在清單裡就先等清單載完再判斷（findFriendSettled，部署前審查 HIGH）
    // 不認得的人的 offer 先收著 15 秒等名冊（狀態鏈補抓，webrtc.ts heldOffers）
    const isGroupMember = (pk: string) =>
      useGroupStore.getState().groups.some((g) => g.members.some((m) => m.publicKey === pk));
    webrtcService.setInboundPolicy({
      // 我封鎖的人（好友或同群成員）不能對我開直連：看得到我的 IP、能往 DataChannel 灌資料（部署前審查 LOW）。
      //   查不到封鎖名單就當沒封鎖
      isBlocked: (pk) => isBlacklisted(pk).catch(() => false),
      isKnown: async (pk) => {
        if (useChatStore.getState().getFriendByPublicKey(pk) || isGroupMember(pk)) return true;
        return !!(await findFriendSettled(pk)) || isGroupMember(pk);
      },
    });
    // offer 附群組金鑰證明：名冊事件過期而對方名冊上少了我時，他憑這個認得我（反之亦然，services/offerProof）。
    //   證明裡沒有群組 id、金鑰 id（W3：只有那一代的主題 id）：收到時用群組引擎的主題表把 tid 對回本機的群組與那一代
    const me = localPublicKeyBase64;
    const keysForTopic = async (tid: string) => {
      const hit = getGroupEngine()?.topics().find((x) => x.tid === tid);
      const key = hit ? await getGroupKey(hit.gid, hit.kid) : null;
      return key ? [key] : [];
    };
    webrtcService.setOfferProofs({
      create: (remote) => createOfferProof(me, remote, useGroupStore.getState().groups, getAllGroupKeys),
      verify: (remote, proof) => verifyOfferProof(remote, me, proof,
        (groupId) => useGroupStore.getState().getGroupById(groupId), keysForTopic),
    });
    setIsInitialized(true);

    // 監聽連線狀態變化
    const unsubState = webrtcService.onStateChange((peerPublicKey, state) => {
      setPeers((prev) => {
        const newPeers = new Map(prev);
        const existing = newPeers.get(peerPublicKey);

        if (state === PeerConnectionState.CLOSED) {
          newPeers.delete(peerPublicKey);
        } else {
          newPeers.set(peerPublicKey, {
            publicKeyBase64: peerPublicKey,
            connectionState: state,
            dataChannelState: existing?.dataChannelState ?? DataChannelState.CONNECTING,
          });
        }

        return newPeers;
      });

      // 觸發斷線回調（連線回調改由 DataChannel OPEN 觸發，確保可發送）
      if (
        state === PeerConnectionState.DISCONNECTED ||
        state === PeerConnectionState.CLOSED ||
        state === PeerConnectionState.FAILED
      ) {
        onPeerDisconnected?.(peerPublicKey);
      }
    });

    // 監聽資料通道狀態變化
    const unsubChannel = webrtcService.onDataChannelStateChange(
      (peerPublicKey, state) => {
        setPeers((prev) => {
          const newPeers = new Map(prev);
          const existing = newPeers.get(peerPublicKey);
          if (existing) {
            newPeers.set(peerPublicKey, {
              ...existing,
              dataChannelState: state,
            });
          }
          return newPeers;
        });

        // DataChannel 開啟才算「可發送」→ 觸發 onPeerConnected（用於 flush queue）
        if (state === DataChannelState.OPEN) {
          onPeerConnected?.(peerPublicKey);
        }
      }
    );

    // 監聽訊息
    const unsubMessage = webrtcService.onMessage((peerPublicKey, data) => {
      onMessage?.(peerPublicKey, data);
    });

    cleanupRef.current = [unsubState, unsubChannel, unsubMessage];

    return () => {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      webrtcService.shutdown();
      setIsInitialized(false);
    };
  }, [localPublicKeyBase64, onMessage, onPeerConnected, onPeerDisconnected]);

  /**
   * 連線到指定 Peer
   */
  const connect = useCallback(async (remotePublicKeyBase64: string) => {
    if (!isInitialized) {
      throw new Error('WebRTC not initialized');
    }
    await webrtcService.connect(remotePublicKeyBase64);
  }, [isInitialized]);

  /**
   * 斷開與指定 Peer 的連線
   */
  const disconnect = useCallback((remotePublicKeyBase64: string) => {
    webrtcService.disconnect(remotePublicKeyBase64);
  }, []);

  /**
   * 發送資料到指定 Peer
   */
  const send = useCallback(
    (remotePublicKeyBase64: string, data: ArrayBuffer | string): boolean => {
      return webrtcService.send(remotePublicKeyBase64, data);
    },
    []
  );

  /**
   * 廣播資料到所有已連線的 Peers
   */
  const broadcast = useCallback((data: ArrayBuffer | string) => {
    webrtcService.broadcast(data);
  }, []);

  /**
   * 取得已連線的 Peers
   */
  const connectedPeers = Array.from(peers.values()).filter(
    (peer) => peer.connectionState === PeerConnectionState.CONNECTED
  );

  /**
   * 檢查是否與指定 Peer 連線
   */
  const isConnectedTo = useCallback(
    (remotePublicKeyBase64: string): boolean => {
      const peer = peers.get(remotePublicKeyBase64);
      return peer?.connectionState === PeerConnectionState.CONNECTED;
    },
    [peers]
  );

  /**
   * 取得指定 Peer 的狀態
   */
  const getPeerState = useCallback(
    (remotePublicKeyBase64: string): PeerState | null => {
      return peers.get(remotePublicKeyBase64) ?? null;
    },
    [peers]
  );

  return {
    // 狀態
    isInitialized,
    peers: Array.from(peers.values()),
    connectedPeers,

    // 連線控制
    connect,
    disconnect,

    // 資料傳輸
    send,
    broadcast,

    // 查詢
    isConnectedTo,
    getPeerState,
  };
}

export default useWebRTC;
