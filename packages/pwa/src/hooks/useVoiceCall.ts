import { devWarn } from '../utils/devLog';

/**
 * useVoiceCall - 語音/視訊通話 Hook
 *
 * 提供語音和視訊通話功能的 React Hook
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  voiceCallService,
  CallState,
  type CallInfo,
} from '../services/voiceCall';

interface UseVoiceCallReturn {
  // 狀態
  callState: CallState;
  callInfo: CallInfo | null;
  isInCall: boolean;
  isRinging: boolean;
  isMuted: boolean;
  duration: number;
  // 視訊狀態
  isVideoCall: boolean;
  isVideoEnabled: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;

  // 動作
  startCall: (peerId: string, peerName?: string, withVideo?: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;

  // 音訊元素 ref
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
}

/**
 * 語音/視訊通話 Hook
 */
export function useVoiceCall(): UseVoiceCallReturn {
  const [callState, setCallState] = useState<CallState>(CallState.IDLE);
  const [callInfo, setCallInfo] = useState<CallInfo | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // 遠端音訊元素 ref
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // 監聽狀態變化
  useEffect(() => {
    const unsubscribe = voiceCallService.onStateChange((state, info) => {
      setCallState(state);
      setCallInfo(info || null);
      setIsMuted(info?.isMuted || false);
      setDuration(info?.duration || 0);
      setIsVideoCall(info?.isVideoCall || false);
      setIsVideoEnabled(info?.isVideoEnabled || false);

      // 更新串流
      const remote = voiceCallService.getRemoteStream();
      const local = voiceCallService.getLocalStream();
      setRemoteStream(remote);
      setLocalStream(local);

      // 更新遠端音訊（非視訊通話時使用）
      if (remoteAudioRef.current && remote && !info?.isVideoCall) {
        remoteAudioRef.current.srcObject = remote;
        remoteAudioRef.current.play().catch((err) => {
          devWarn('[useVoiceCall] Failed to play remote audio:', err);
        });
      }
    });

    return () => unsubscribe();
  }, []);

  // 發起通話
  const startCall = useCallback(async (peerId: string, peerName?: string, withVideo: boolean = false) => {
    await voiceCallService.startCall(peerId, peerName, withVideo);
  }, []);

  // 接聽
  const acceptCall = useCallback(async () => {
    await voiceCallService.acceptCall();
  }, []);

  // 拒絕
  const rejectCall = useCallback(() => {
    voiceCallService.rejectCall();
  }, []);

  // 結束
  const endCall = useCallback(() => {
    voiceCallService.endCall();
  }, []);

  // 切換靜音
  const toggleMute = useCallback(() => {
    const muted = voiceCallService.toggleMute();
    setIsMuted(muted);
  }, []);

  // 切換視訊
  const toggleVideo = useCallback(() => {
    const enabled = voiceCallService.toggleVideo();
    setIsVideoEnabled(enabled);
  }, []);

  // 計算狀態
  const isInCall = callState === CallState.CONNECTED;
  const isRinging =
    callState === CallState.INCOMING || callState === CallState.REQUESTING;

  return {
    callState,
    callInfo,
    isInCall,
    isRinging,
    isMuted,
    duration,
    isVideoCall,
    isVideoEnabled,
    localStream,
    remoteStream,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleVideo,
    remoteAudioRef,
  };
}

export default useVoiceCall;
