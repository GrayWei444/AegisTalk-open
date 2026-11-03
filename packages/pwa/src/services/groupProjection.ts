/**
 * 套上的鏈 → 畫面用的 Group 與資料庫投影（groups／group_members）。純函式。
 * 名冊、角色、名稱、頭像、類型、守護設定、建群的人（genesis 的 actor）全部只來自驗過的鏈；暱稱是本機快取
 * （好友名稱或對方群訊帶的 senderName），不影響任何權限。
 */
import type { Group, GroupKeyState, GroupMember } from '../types';
import type { ChainView } from './groupState';
import type { GroupProjectionRow } from './groupLogStore';

/** 成員加入那筆 commit 的時間（commit 的 ts 是作者自己說的，只拿來顯示與排序） */
function joinedAtOf(view: ChainView, addedAtV: number): number {
  return view.chain[addedAtV - 1]?.c.ts ?? view.state.createdAt;
}

export function projectionRow(view: ChainView, nicknameOf: (pk: string) => string | undefined): GroupProjectionRow {
  const { state } = view;
  return {
    name: state.info.name,
    avatar: state.info.avatar || null,
    createdAt: state.createdAt,
    createdBy: state.createdBy,
    groupType: state.info.groupType,
    guardianSettings: state.info.guardianSettings ? JSON.stringify(state.info.guardianSettings) : null,
    members: state.members.map((m) => ({
      pubkey: m.pk, role: m.role, joinedAt: joinedAtOf(view, m.addedAtV), nickname: nicknameOf(m.pk) ?? null,
    })),
  };
}

export function projectGroup(view: ChainView, p: {
  me: string;
  nicknameOf: (pk: string) => string | undefined;
  keyState: GroupKeyState;
  /** head 交叉比對有成員跟我對不上（groupEngineGossip） */
  logConflict?: boolean;
  /** 我送的邀請重送用完還沒回條的成員 */
  unackedInvites?: string[];
}): Group {
  const { state } = view;
  const members: GroupMember[] = state.members.map((m) => ({
    publicKey: m.pk,
    nickname: p.nicknameOf(m.pk),
    role: m.role,
    joinedAt: joinedAtOf(view, m.addedAtV),
    isOnline: m.pk === p.me,
  }));
  const memberSet = new Set(state.members.map((m) => m.pk));
  return {
    id: state.gid,
    name: state.info.name,
    avatar: state.info.avatar || undefined,
    members,
    createdAt: state.createdAt,
    createdBy: state.createdBy,
    updatedAt: Date.now(),
    unreadCount: 0,
    groupType: state.info.groupType,
    guardianSettings: state.info.guardianSettings ?? undefined,
    // 曾被踢或離開、現在不在名冊上的人（鏈上的 former）：offer 證明、seed sync 用
    departed: state.former.filter((pk) => !memberSet.has(pk)),
    keyState: p.keyState,
    ...(p.logConflict ? { logConflict: true } : {}),
    ...(p.unackedInvites?.length ? { unackedInvites: p.unackedInvites } : {}),
  };
}
