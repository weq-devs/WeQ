import { createContext } from 'react';
import type { ForwardCacheKind } from '@weq/db';
import type { UnreadMessageIdentity } from '../lib/unreadNavigation';

/**
 * Lets a reply quote ask the host (MainView) to scroll the message list to the
 * referenced message. Both seq candidates are passed because the column that
 * matches `40003` differs by conversation kind — group uses origMsgSeq(47402),
 * c2c uses origMsgIndex(47419) — and only the host knows the current kind.
 * Default is a no-op so the renderer also works when mounted outside a provider
 * (e.g. tests).
 */
export interface ReplyJumpTarget {
  /** 普通未读跳转按区间定位，不要求已读水位后的推算序号真实存在。 */
  mode?: 'firstUnread';
  /** 重要提醒可能与灰条同序号，保留原消息的身份。 */
  importantMessage?: UnreadMessageIdentity;
  /** 读取成功但未找到目标时通知浮动提醒，加载失败仍可重试。 */
  onMissing?: () => void;
  /** 已知原消息时优先精确匹配，兼容序号为空或同序号的漫游记录。 */
  msgId?: string;
  /** origMsgSeq (tag 47402) — the 40003 anchor for GROUP messages. */
  seq?: number | string;
  /** origMsgIndex (tag 47419) — the 40003 anchor for C2C messages. */
  index?: number | string;
  clientSeq?: number | string;
  senderUin?: number | string;
  sendTime?: number | string;
}
export type ReplyJump = (
  target: ReplyJumpTarget,
) => boolean | void | Promise<void> | Promise<boolean>;
const replyJumpContext = createContext<ReplyJump>(() => {});

/**
 * 承载消息所在的表。合并转发详情和附件都要用它定位 40900。
 */
export const ForwardKindContext = createContext<ForwardCacheKind>('c2c');

/**
 * Group code (群号) of the open chat, or '' for c2c. Video / file OIDB
 * completion needs the group id to resolve a group download URL; the host
 * provides it via this context so we don't thread it through every render
 * layer. Empty string ⇒ private (c2c).
 */
export const ConvContext = createContext<string>('');

/**
 * Set inside a 合并转发 window: the CARRYING message's id + kind.
 *
 * Forwarded sub-messages are 40900 snapshots of rows in someone else's
 * conversation — they were never written to our own msg tables, so a media
 * download can't re-read them by their own msgId. It has to go through the
 * carrier's 40900 cache instead, which is what this identifies. Empty msgId ⇒
 * a normal timeline message (look it up directly).
 */
export interface ForwardCarrier {
  msgId: string;
  kind: ForwardCacheKind;
  resId?: string;
}
export const ForwardCarrierContext = createContext<ForwardCarrier | null>(null);

export { replyJumpContext as ReplyJumpContext };

export type FileTransferTipScope = {
  kind: 'c2c' | 'group';
  conv: string;
  expectedAccountUin: string;
  expectedAccountConfigId: string;
};
const fileTransferTipScopeContext = createContext<FileTransferTipScope | null>(null);
export { fileTransferTipScopeContext as FileTransferTipScopeContext };
