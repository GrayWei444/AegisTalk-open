
/**
 * GlobalVoiceCallUI - 全域語音通話 UI
 *
 * 無論用戶在哪個畫面，都能顯示來電提示和通話中的 UI
 * Phase 6: 整合語音風險分析 UI
 */

import { useVoiceCall } from '../../hooks/useVoiceCall';
import { useChatStore } from '../../stores/chatStore';
import { CallState } from '../../services/voiceCall';
import { IncomingCallModal } from './IncomingCallModal';
import { ActiveCallUI } from './ActiveCallUI';
import { ext } from '@ext';
import { useLanguage } from '../../i18n';

export function GlobalVoiceCallUI() {
  const { t } = useLanguage();
  const {
    callState,
    callInfo,
    isMuted,
    duration,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleVideo,
    remoteAudioRef,
    // 視訊相關
    isVideoCall,
    isVideoEnabled,
    localStream,
    remoteStream,
  } = useVoiceCall();

  // 從 chatStore 取得好友資料（用於顯示頭像）
  const getFriendByPublicKey = useChatStore((state) => state.getFriendByPublicKey);

  // 取得通話對方的資訊
  const getPeerInfo = () => {
    if (!callInfo?.peerId) return { name: t('common.unknown'), avatar: undefined };

    const friend = getFriendByPublicKey(callInfo.peerId);
    if (friend) {
      return {
        name: friend.name,
        avatar: friend.avatar,
      };
    }

    return {
      name: callInfo.peerName || t('friendList.defaultFriendPrefix', { key: callInfo.peerId.slice(0, 8) }),
      avatar: undefined,
    };
  };

  const peerInfo = getPeerInfo();

  // Phase 6: 語音風險分析（官方版的防詐功能；社群版沒有 → 不分析、不顯示）
  const { useCallRisk } = ext.ui;
  const risk = useCallRisk({ callState, peerId: callInfo?.peerId, duration, peerName: peerInfo.name });

  // 根據通話狀態顯示不同 UI
  if (callState === CallState.IDLE) {
    return null; // 沒有通話，不顯示任何東西
  }

  // 來電中 - 顯示來電提示
  if (callState === CallState.INCOMING) {
    return (
      <IncomingCallModal
        callerName={peerInfo.name}
        callerAvatar={peerInfo.avatar}
        onAccept={acceptCall}
        onReject={rejectCall}
        isVideoCall={callInfo?.isVideoCall ?? false}
      />
    );
  }

  // 撥號中、連線中、通話中、結束 - 顯示通話 UI
  if (
    callState === CallState.REQUESTING ||
    callState === CallState.CONNECTING ||
    callState === CallState.CONNECTED ||
    callState === CallState.ENDED
  ) {
    return (
      <>
        <ActiveCallUI
          peerName={peerInfo.name}
          peerAvatar={peerInfo.avatar}
          callState={callState}
          duration={duration}
          isMuted={isMuted}
          onMuteToggle={toggleMute}
          onEndCall={endCall}
          isAnalyzing={risk.isAnalyzing}
          sliceCount={risk.sliceCount}
          // 視訊相關
          isVideoCall={isVideoCall}
          isVideoEnabled={isVideoEnabled}
          onVideoToggle={toggleVideo}
          localStream={localStream}
          remoteStream={remoteStream}
        />

        {/* Phase 6: 通話中風險警示、Phase 7: 即時語音轉錄 */}
        {callState === CallState.CONNECTED && risk.shield}
        {callState === CallState.CONNECTED && risk.transcript}

        {/* 隱藏的音訊元素用於播放遠端音訊 */}
        <audio ref={remoteAudioRef} autoPlay playsInline />

        {/* Phase 6: 通話結束後風險摘要 - 只在 ENDED 狀態時顯示 */}
        {callState === CallState.ENDED && risk.summary}
      </>
    );
  }

  // 沒有通話但有風險摘要要顯示
  if (risk.summary) {
    return <>{risk.summary}</>;
  }

  return null;
}

export default GlobalVoiceCallUI;
