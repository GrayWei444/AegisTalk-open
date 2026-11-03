/**
 * 畫面上的「在線」小綠點（W4）：好友看驗過的秘密 presence（mqttService.isFriendOnline：解得開、夠新、TTL 內有更新）；
 * 同群組但不是好友的人看他最近的 here 與 P2P 通道（memberPresence.ts）—— 他的 presence 我本來就看不到。
 * presence／here 變了就重算，另外每 5 秒重算一次（P2P 通道開關、TTL 到期沒有事件）。enabled ＝ false（畫面沒開）：
 * 不訂、不重算，回空的（審查 W4 #14）。
 */
import { useEffect, useMemo, useState } from 'react';
import { mqttService } from '../services/mqtt';
import { memberPresence, peerOnline } from '../services/memberPresence';
import { webrtcService } from '../services/webrtc';

const RECHECK_MS = 5_000;

const NONE: ReadonlySet<string> = new Set();

export function usePeerOnline(publicKeys: readonly string[], enabled = true): ReadonlySet<string> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const bump = () => setTick((n) => n + 1);
    const offPresence = mqttService.onPresenceChange(bump);
    const offMembers = memberPresence.onChange(bump);
    const timer = setInterval(bump, RECHECK_MS);
    return () => { offPresence(); offMembers(); clearInterval(timer); };
  }, [enabled]);
  const key = publicKeys.join(',');
  return useMemo(() => {
    if (!enabled) return NONE;
    const deps = {
      friendOnline: (pk: string) => mqttService.isFriendOnline(pk),
      recentlySeen: (pk: string) => memberPresence.recentlySeen(pk),
      channelOpen: (pk: string) => webrtcService.isDataChannelOpen(pk),
    };
    return new Set(key ? key.split(',').filter((pk) => peerOnline(pk, deps)) : []);
    // tick：presence／here／通道狀態變了要重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, enabled]);
}
