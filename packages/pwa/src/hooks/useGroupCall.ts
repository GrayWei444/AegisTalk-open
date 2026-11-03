/**
 * useGroupCall Hook - 群組通話 Hook (Phase 10)
 *
 * 提供多人群組語音/視訊通話功能的 React Hook
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  groupCallService,
  GroupCallState,
  type GroupCallInfo,
  type Participant,
} from '../services/groupCallService';
import { useCrypto } from './useCrypto';
import { useGroupStore } from '../stores/groupStore';

// ============================================
// 類型定義
// ============================================

interface UseGroupCallReturn {
  /** 當前通話狀態 */
  callState: GroupCallState;
  /** 當前通話資訊 */
  callInfo: GroupCallInfo | null;
  /** 通話參與者 */
  participants: Participant[];
  /** 本地媒體串流 */
  localStream: MediaStream | null;
  /** 是否靜音 */
  isMuted: boolean;
  /** 是否開啟視訊 */
  isVideoEnabled: boolean;
  /** 通話時長（秒） */
  duration: number;
  /** 是否有來電 */
  hasIncomingCall: boolean;
  /** 來電資訊 */
  incomingCall: IncomingCallInfo | null;

  /** 發起群組通話 */
  startCall: (groupId: string, withVideo?: boolean) => Promise<void>;
  /** 加入群組通話 */
  joinCall: (groupId?: string, withVideo?: boolean) => Promise<void>;
  /** 離開通話 */
  leaveCall: () => void;
  /** 結束通話（所有人） */
  endCall: () => void;
  /** 切換靜音 */
  toggleMute: () => void;
  /** 切換視訊 */
  toggleVideo: () => void;
  /** 接受來電 */
  acceptIncomingCall: (withVideo?: boolean) => Promise<void>;
  /** 拒絕來電 */
  rejectIncomingCall: () => void;
}

interface IncomingCallInfo {
  groupId: string;
  groupName: string;
  initiatorId: string;
  isVideoCall: boolean;
}

// ============================================
// Hook 實作
// ============================================

export function useGroupCall(): UseGroupCallReturn {
  const { publicKeyBase64 } = useCrypto();
  const getGroupById = useGroupStore((state) => state.getGroupById);

  // 狀態
  const [callState, setCallState] = useState<GroupCallState>(GroupCallState.IDLE);
  const [callInfo, setCallInfo] = useState<GroupCallInfo | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [duration, setDuration] = useState(0);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);

  // 服務初始化狀態
  const isInitialized = useRef(false);

  // 初始化服務
  useEffect(() => {
    if (publicKeyBase64 && !isInitialized.current) {
      groupCallService.initialize(publicKeyBase64);
      isInitialized.current = true;

      // 訂閱狀態變化
      const unsubState = groupCallService.onStateChange((state, info) => {
        setCallState(state);
        setCallInfo(info || null);
        setDuration(info?.duration || 0);
        setLocalStream(groupCallService.getLocalStream());

        // 更新參與者列表
        if (info) {
          setParticipants(Array.from(info.participants.values()));
        } else {
          setParticipants([]);
        }
      });

      // 訂閱參與者變化
      const unsubParticipant = groupCallService.onParticipantChange((_peerId, _participant) => {
        const currentInfo = groupCallService.getCurrentCall();
        if (currentInfo) {
          setParticipants(Array.from(currentInfo.participants.values()));
        }
      });

      // 訂閱來電
      const unsubIncoming = groupCallService.onIncomingCall((groupId, groupName, initiatorId, isVideoCall) => {
        setIncomingCall({
          groupId,
          groupName,
          initiatorId,
          isVideoCall,
        });
      });

      return () => {
        unsubState();
        unsubParticipant();
        unsubIncoming();
        groupCallService.shutdown();
        isInitialized.current = false;
      };
    }
  }, [publicKeyBase64]);

  // 發起群組通話
  const startCall = useCallback(async (groupId: string, withVideo: boolean = false) => {
    const group = getGroupById(groupId);
    if (!group) {
      throw new Error('群組不存在');
    }

    const memberKeys = group.members
      .map((m) => m.publicKey)
      .filter((pk) => pk !== publicKeyBase64);

    await groupCallService.startGroupCall(
      groupId,
      group.name,
      memberKeys,
      withVideo
    );
  }, [publicKeyBase64, getGroupById]);

  // 加入群組通話
  const joinCall = useCallback(async (groupId?: string, withVideo: boolean = false) => {
    const targetGroupId = groupId || incomingCall?.groupId;
    if (!targetGroupId) {
      throw new Error('請指定群組 ID');
    }

    await groupCallService.joinGroupCall(targetGroupId, withVideo);
    setIncomingCall(null);
  }, [incomingCall]);

  // 離開通話
  const leaveCall = useCallback(() => {
    groupCallService.leaveCall();
  }, []);

  // 結束通話（所有人）
  const endCall = useCallback(() => {
    groupCallService.endCall();
  }, []);

  // 切換靜音
  const toggleMute = useCallback(() => {
    groupCallService.toggleMute();
    const info = groupCallService.getCurrentCall();
    if (info) {
      setCallInfo({ ...info });
    }
  }, []);

  // 切換視訊
  const toggleVideo = useCallback(() => {
    groupCallService.toggleVideo();
    const info = groupCallService.getCurrentCall();
    if (info) {
      setCallInfo({ ...info });
    }
  }, []);

  // 接受來電
  const acceptIncomingCall = useCallback(async (withVideo: boolean = false) => {
    if (!incomingCall) {
      throw new Error('沒有來電');
    }
    await joinCall(incomingCall.groupId, withVideo || incomingCall.isVideoCall);
  }, [incomingCall, joinCall]);

  // 拒絕來電
  const rejectIncomingCall = useCallback(() => {
    setIncomingCall(null);
  }, []);

  return {
    callState,
    callInfo,
    participants,
    localStream,
    isMuted: callInfo?.localMuted ?? false,
    isVideoEnabled: callInfo?.localVideoEnabled ?? false,
    duration,
    hasIncomingCall: incomingCall !== null,
    incomingCall,

    startCall,
    joinCall,
    leaveCall,
    endCall,
    toggleMute,
    toggleVideo,
    acceptIncomingCall,
    rejectIncomingCall,
  };
}

export default useGroupCall;
