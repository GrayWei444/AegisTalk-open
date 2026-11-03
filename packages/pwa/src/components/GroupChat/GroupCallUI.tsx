/**
 * GroupCallUI - 群組通話介面
 *
 * Phase 10: 多人群組語音/視訊通話 UI
 */

import { useEffect, useRef, useState } from 'react';
import { useGroupCall } from '../../hooks/useGroupCall';
import { GroupCallState } from '../../services/groupCallService';
import { useChatStore } from '../../stores/chatStore';
import { UserAvatar } from '../common';
import { PhoneIcon, PhoneOffIcon, VideoIcon, CameraIcon, MicIcon, MicOffIcon, HourglassIcon, XIcon } from '../common/icons';
import { useLanguage } from '../../i18n/context';

interface GroupCallUIProps {
  groupId: string;
  groupName: string;
  isOpen: boolean;
  onClose: () => void;
}

export function GroupCallUI({ groupId, groupName, isOpen, onClose }: GroupCallUIProps) {
  const {
    callState,
    callInfo,
    participants,
    localStream,
    isMuted,
    isVideoEnabled,
    duration,
    hasIncomingCall,
    incomingCall,
    startCall,
    joinCall,
    leaveCall,
    // endCall is available for host to end call for all participants
    endCall: _endCall,
    toggleMute,
    toggleVideo,
    acceptIncomingCall,
    rejectIncomingCall,
  } = useGroupCall();

  const friends = useChatStore((state) => state.friends);
  const { t } = useLanguage();

  // 本地視訊 ref
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // 遠端視訊 refs
  const [remoteVideoRefs, setRemoteVideoRefs] = useState<Map<string, HTMLVideoElement | null>>(new Map());

  // 格式化時間
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // 取得參與者名稱
  const getParticipantName = (peerId: string): string => {
    const friend = friends.find((f) => f.publicKey === peerId);
    return friend?.name || peerId.slice(0, 8) + '...';
  };

  // 設定本地視訊
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // 設定遠端視訊
  useEffect(() => {
    participants.forEach((participant) => {
      const ref = remoteVideoRefs.get(participant.peerId);
      if (ref && participant.remoteStream) {
        ref.srcObject = participant.remoteStream;
      }
    });
  }, [participants, remoteVideoRefs]);

  // 處理發起通話
  const handleStartCall = async (withVideo: boolean) => {
    try {
      await startCall(groupId, withVideo);
    } catch (error) {
      console.error('[GroupCallUI] Failed to start call:', error);
      alert(error instanceof Error ? error.message : t('group.callFailed'));
    }
  };

  // 處理加入通話 - 用於未來加入進行中的通話功能
  const _handleJoinCall = async (withVideo: boolean) => {
    try {
      await joinCall(groupId, withVideo);
    } catch (error) {
      console.error('[GroupCallUI] Failed to join call:', error);
      alert(error instanceof Error ? error.message : t('group.joinCallFailed'));
    }
  };
  // Suppress unused warning - will be used when implementing "join ongoing call" feature
  void _handleJoinCall;

  if (!isOpen) return null;

  // 來電畫面
  if (hasIncomingCall && incomingCall?.groupId === groupId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
        <div className="w-full max-w-sm rounded-2xl bg-surface-primary p-6 text-center">
          <div className="mb-4 flex justify-center"><PhoneIcon size={56} className="text-green-500" /></div>
          <h2 className="mb-2 text-xl font-bold text-white">{t('group.groupCallInvite')}</h2>
          <p className="mb-6 text-gray-400">{incomingCall.groupName}</p>
          <p className="mb-6 text-sm text-gray-500">
            {incomingCall.isVideoCall ? t('group.videoCall') : t('group.voiceCall')}
          </p>

          <div className="flex justify-center gap-4">
            <button
              onClick={rejectIncomingCall}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-2xl text-white hover:bg-red-700"
            >
              <XIcon size={24} />
            </button>
            <button
              onClick={() => acceptIncomingCall(false)}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-green-600 text-2xl text-white hover:bg-green-700"
            >
              <PhoneIcon size={24} />
            </button>
            {incomingCall.isVideoCall && (
              <button
                onClick={() => acceptIncomingCall(true)}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-2xl text-white hover:bg-blue-700"
              >
                <VideoIcon size={24} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 閒置狀態 - 發起通話選項
  if (callState === GroupCallState.IDLE) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
        <div className="w-full max-w-sm rounded-2xl bg-surface-primary p-6 text-center">
          <h2 className="mb-2 text-xl font-bold text-white">{t('group.groupCall')}</h2>
          <p className="mb-6 text-gray-400">{groupName}</p>

          <div className="mb-6 flex justify-center gap-4">
            <button
              onClick={() => handleStartCall(false)}
              className="flex flex-col items-center gap-2 rounded-xl bg-green-600 px-6 py-4 text-white hover:bg-green-700"
            >
              <PhoneIcon size={30} />
              <span className="text-sm">{t('group.voiceCall')}</span>
            </button>
            <button
              onClick={() => handleStartCall(true)}
              className="flex flex-col items-center gap-2 rounded-xl bg-blue-600 px-6 py-4 text-white hover:bg-blue-700"
            >
              <VideoIcon size={30} />
              <span className="text-sm">{t('group.videoCall')}</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  // 通話中畫面
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-primary">
      {/* 頂部資訊列 */}
      <div className="flex items-center justify-between bg-black/50 px-4 py-3">
        <div>
          <h2 className="font-bold text-white">{groupName}</h2>
          <p className="text-sm text-gray-400">
            {callInfo?.isVideoCall ? t('group.videoCall') : t('group.voiceCall')} • {t('group.nMembers', { count: participants.length + 1 })}
          </p>
        </div>
        <div className="text-xl text-white">{formatDuration(duration)}</div>
      </div>

      {/* 視訊網格 */}
      <div className="flex-1 overflow-auto p-4">
        <div
          className="grid h-full gap-4"
          style={{
            gridTemplateColumns: `repeat(${Math.min(participants.length + 1, 2)}, 1fr)`,
            gridTemplateRows: `repeat(${Math.ceil((participants.length + 1) / 2)}, 1fr)`,
          }}
        >
          {/* 本地視訊 */}
          <div className="relative overflow-hidden rounded-xl bg-surface-tertiary">
            {callInfo?.isVideoCall && isVideoEnabled ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <div className="text-center">
                  <div className="mb-2 flex justify-center">
                    <UserAvatar size="xl" />
                  </div>
                  <p className="text-white">{t('common.me')}</p>
                </div>
              </div>
            )}
            <div className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-1 text-xs text-white">
              {t('common.me')} {isMuted && <MicOffIcon size={12} className="inline-block align-[-1px]" />}
            </div>
          </div>

          {/* 遠端參與者視訊 */}
          {participants.map((participant) => (
            <div
              key={participant.peerId}
              className="relative overflow-hidden rounded-xl bg-surface-tertiary"
            >
              {callInfo?.isVideoCall && participant.isVideoEnabled && participant.remoteStream ? (
                <video
                  ref={(el) => {
                    if (el) {
                      setRemoteVideoRefs((prev) => new Map(prev).set(participant.peerId, el));
                    }
                  }}
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <div className="text-center">
                    <div className="mb-2 flex justify-center">
                      <UserAvatar name={getParticipantName(participant.peerId)} size="xl" />
                    </div>
                    <p className="text-white">{getParticipantName(participant.peerId)}</p>
                    {!participant.isConnected && (
                      <p className="mt-1 text-xs text-yellow-500">{t('group.connecting')}</p>
                    )}
                  </div>
                </div>
              )}
              <div className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-1 text-xs text-white">
                {getParticipantName(participant.peerId)}
                {participant.isMuted && <MicOffIcon size={12} className="ml-1 inline-block align-[-1px]" />}
                {!participant.isConnected && <HourglassIcon size={12} className="ml-1 inline-block align-[-1px]" />}
              </div>

              {/* 語音串流播放（即使沒有視訊也要播放音訊） */}
              {participant.remoteStream && (
                <audio
                  ref={(el) => {
                    if (el && participant.remoteStream) {
                      el.srcObject = participant.remoteStream;
                    }
                  }}
                  autoPlay
                  className="hidden"
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 底部控制列 */}
      <div className="flex items-center justify-center gap-6 bg-black/50 py-6">
        {/* 靜音按鈕 */}
        <button
          onClick={toggleMute}
          className={`flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
            isMuted ? 'bg-red-600 text-white' : 'bg-gray-700 text-white hover:bg-gray-600'
          }`}
        >
          {isMuted ? <MicOffIcon size={22} /> : <MicIcon size={22} />}
        </button>

        {/* 視訊按鈕 */}
        {callInfo?.isVideoCall && (
          <button
            onClick={toggleVideo}
            className={`flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
              !isVideoEnabled ? 'bg-red-600 text-white' : 'bg-gray-700 text-white hover:bg-gray-600'
            }`}
          >
            {isVideoEnabled ? <VideoIcon size={22} /> : <CameraIcon size={22} />}
          </button>
        )}

        {/* 掛斷按鈕 */}
        <button
          onClick={leaveCall}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-2xl text-white hover:bg-red-700"
        >
          <PhoneOffIcon size={22} />
        </button>
      </div>
    </div>
  );
}

export default GroupCallUI;
