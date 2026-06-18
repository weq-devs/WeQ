/**
 * 48902 — msg_unread_info_table unread info blob.
 * Contains the last read message sequence number for a conversation.
 */

import { ProtoField, ScalarType } from '../../core';

const UnreadInfoInner = {
  /** 聊天类型 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  /** 对话 uid */
  peerUid: ProtoField(40021, ScalarType.STRING, { optional: true }),
  /** 最新读到的消息序号 */
  msgSeq: ProtoField(41002, ScalarType.UINT32, { optional: true }),
};

export const UnreadInfo = {
  /** 未读信息内容 */
  info: ProtoField(48902, () => UnreadInfoInner, { optional: true }),
};
