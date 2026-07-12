/**
 * 48902 — msg_unread_info_table unread info blob.
 *
 * Contains the last-read message sequence number for a conversation, plus an
 * optional "notify highlight" extension (50005 → 50060) that QQ NT populates
 * when the conversation has unread messages of special interest:
 * 特别关心 / @我 / @全体 / 回复我 / 新文件 …
 *
 * Only the 特别关心 (special-care) shape is modelled so far — it's the one
 * we've decoded end-to-end. Its nested layout (verified against a real blob):
 *
 *   50005 {                       // conversation extension
 *     50001 peerUid, 50002 chatType
 *     50060 {                     // notify-highlight aggregate (absent when none)
 *       50000 kind                // 1000 = @我, 1006 = 特别关心
 *       50040 {                   // one entry per highlighted message
 *         50020 msgSeq            // seq of the highlighted message
 *         50022 senderUid         // who sent it
 *         50023 sendTime          // unix seconds
 *         50024 text              // preview text (often empty)
 *       }
 *     }
 *   }
 *
 * One 50060 group appears per active category; the kind code (50000)
 * distinguishes them. Remaining categories (@全体 / 回复我 / 新文件) will slot
 * in as their codes are captured, so `highlight` is modelled as `repeat`.
 */

import { ProtoField, ScalarType } from '../../core';

/** 50040 — one highlighted message inside a notify-highlight group. */
const NotifyHighlightItem = {
  /** 50020 — seq of the highlighted message. */
  msgSeq: ProtoField(50020, ScalarType.UINT32, { optional: true }),
  /** 50022 — sender uid. */
  senderUid: ProtoField(50022, ScalarType.STRING, { optional: true }),
  /** 50023 — send time (unix seconds). */
  sendTime: ProtoField(50023, ScalarType.UINT32, { optional: true }),
  /** 50024 — preview text (frequently empty). */
  text: ProtoField(50024, ScalarType.STRING, { optional: true }),
};

/** 50060 — notify-highlight aggregate; present only when the conversation has
 *  a highlighted unread (e.g. 特别关心). */
const NotifyHighlight = {
  /** 50000 — highlight kind. 1000 = @我, 1006 = 特别关心. */
  kind: ProtoField(50000, ScalarType.UINT32, { optional: true }),
  /** 50040 — highlighted messages (one per message). */
  items: ProtoField(50040, () => NotifyHighlightItem, { optional: true, repeat: true }),
};

/** 50005 — conversation extension carrying the notify-highlight aggregate. */
const UnreadExt = {
  /** 50001 — peer uid (repeat of 40021). */
  peerUid: ProtoField(50001, ScalarType.STRING, { optional: true }),
  /** 50002 — chat type (repeat of 40010). */
  chatType: ProtoField(50002, ScalarType.UINT32, { optional: true }),
  /** 50060 — notify-highlight aggregate. Modelled repeat in case categories
   *  (特别关心 / @我 …) surface as sibling groups. */
  highlight: ProtoField(50060, () => NotifyHighlight, { optional: true, repeat: true }),
};

const UnreadInfoInner = {
  /** 聊天类型 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  /** 对话 uid */
  peerUid: ProtoField(40021, ScalarType.STRING, { optional: true }),
  /** 最新读到的消息序号 */
  msgSeq: ProtoField(41002, ScalarType.UINT32, { optional: true }),
  /** 会话扩展（特别关心等提醒高亮）。 */
  ext: ProtoField(50005, () => UnreadExt, { optional: true }),
};

export const UnreadInfo = {
  /** 未读信息内容 */
  info: ProtoField(48902, () => UnreadInfoInner, { optional: true }),
};
