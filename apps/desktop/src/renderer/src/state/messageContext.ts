import { createContext } from 'react';

/**
 * Lets a reply quote ask the host (MainView) to scroll the message list to the
 * referenced message. Both seq candidates are passed because the column that
 * matches `40003` differs by conversation kind — group uses origMsgSeq(47402),
 * c2c uses origMsgIndex(47419) — and only the host knows the current kind.
 * Default is a no-op so the renderer also works when mounted outside a provider
 * (e.g. tests).
 */
export interface ReplyJumpTarget {
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
export const ReplyJumpContext = createContext<(target: ReplyJumpTarget) => void | Promise<void>>(
  () => {},
);

/**
 * The conversation kind of the open chat. MultiMsg lookups (合并转发) hit a
 * different DB table for c2c vs group, so the preview bubble needs the host
 * to tell it which side to query. Defaults to 'c2c' for safety in tests.
 */
export const ForwardKindContext = createContext<'c2c' | 'group'>('c2c');

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
  kind: 'c2c' | 'group';
}
export const ForwardCarrierContext = createContext<ForwardCarrier | null>(null);

/**
 * 嵌套合并转发的**内联子记录**表（msgId → 该 multiMsg 的 subMsgs）。
 *
 * 40900 缓存里嵌套那一层是现成的（一条 multiMsg 记录的 `subMsgs` 就是它内部那串
 * 子消息），所以再点进去时**不必重新查库**。转发窗口把当前这一层所有子记录的
 * `subMsgs` 挂进这个表，{@link QqMessageContent} 的 multiMsg 分支就能直接把
 * 内联记录交给预览卡片，省掉一次 IPC 往返。
 *
 * 未提供（主时间线、合成转发预览）时退回按 msgId / resId 现查 —— 行为与以前一致。
 * `unknown[]` 是 `ForwardRecordWire[]`：这里不 import 那个类型，避免与
 * ForwardWindow 形成类型环路，取值点自己收窄。
 */
export const ForwardSubRecordsContext = createContext<Map<string, unknown[]> | null>(null);
