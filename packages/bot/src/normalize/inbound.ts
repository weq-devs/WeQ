/**
 * 入站归一化：OneBot 上报事件 → 内部 NormalizedMessage。
 *
 * 扩展轴①：目前把 text/at/face 归一成文本，image/record/reply 先给占位。未来「让 bot 看图/听语音/
 * 认引用」只需在 segToText 里把对应分支从占位换成真实处理（vision / 转录 / 拉引用上下文），不动上层。
 */
import type { IncomingEvent, OneBotSegment } from '../adapter/types';
import { faceIdToText } from './qq_faces';

export interface NormalizedMessage {
  chatType: 'private' | 'group';
  /** 会话对端 id：私聊=对方 QQ；群=群号。回消息时作为 SendTarget.peerId。 */
  peerId: string;
  /** 发送者 QQ 号。 */
  senderId: string;
  /** 发送者展示名（群名片优先，其次昵称）。 */
  senderName: string;
  /** 归一化后的文本（喂给克隆体的输入）。 */
  text: string;
  /** 是否 @ 了 bot 自己（群聊意愿闸「被点名必回」用）。 */
  mentionsSelf: boolean;
  messageId?: string;
}

/** 把 OneBot 的 message 字段规整成段数组（兼容 array 上报；string 上报退化为单个 text 段）。 */
function toSegments(message: OneBotSegment[] | string | undefined, rawMessage?: string): OneBotSegment[] {
  if (Array.isArray(message)) return message;
  const text = typeof message === 'string' ? message : (rawMessage ?? '');
  return text ? [{ type: 'text', data: { text } }] : [];
}

/** 单个段 → 文本片段（并回报是否 @ 了自己）。扩展点集中在这里。 */
function segToText(seg: OneBotSegment, selfId: string): { text: string; mentionsSelf: boolean } {
  switch (seg.type) {
    case 'text':
      return { text: String(seg.data.text ?? ''), mentionsSelf: false };
    case 'at': {
      const qq = String(seg.data.qq ?? '');
      if (qq === selfId || qq === 'all') return { text: '', mentionsSelf: qq === selfId };
      // TODO(扩展): 查群名片替换成 @昵称，现阶段保留 @QQ。
      return { text: `@${qq} `, mentionsSelf: false };
    }
    case 'face': {
      // 系统表情 → faceText（如 /惊讶），让克隆体理解对方发了什么表情。
      const ft = faceIdToText(String(seg.data.id ?? ''));
      return { text: ft ?? '', mentionsSelf: false };
    }
    // TODO(扩展 M5): image → vision 解读；record → 转录；reply → 引用上下文。
    case 'image':
      return { text: '[图片]', mentionsSelf: false };
    case 'record':
      return { text: '[语音]', mentionsSelf: false };
    default:
      return { text: '', mentionsSelf: false };
  }
}

/**
 * 归一化一条上报事件。非 message 类型（meta_event/notice/request）返回 null（M1 不处理，M5 扩展）。
 */
export function normalizeInbound(event: IncomingEvent, selfId: string): NormalizedMessage | null {
  if (event.post_type !== 'message') return null;
  const chatType = event.message_type;
  if (chatType !== 'private' && chatType !== 'group') return null;

  const senderId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!senderId) return null;
  const peerId = chatType === 'group' ? String(event.group_id ?? '') : senderId;
  if (!peerId) return null;
  const senderName = event.sender?.card || event.sender?.nickname || senderId;

  let mentionsSelf = false;
  const parts: string[] = [];
  for (const seg of toSegments(event.message, event.raw_message)) {
    const { text, mentionsSelf: m } = segToText(seg, selfId);
    if (m) mentionsSelf = true;
    if (text) parts.push(text);
  }

  return {
    chatType,
    peerId,
    senderId,
    senderName,
    text: parts.join('').trim(),
    mentionsSelf,
    messageId: event.message_id != null ? String(event.message_id) : undefined,
  };
}
