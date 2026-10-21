import { datalineName, isDatalineSelfUid } from '@weq/codec';
import type { Conversation, User } from '../im-template/template/types';

type DirectionMessage = {
  senderUid: string;
  senderUin: string;
  elements: readonly unknown[];
};

/** 优先使用发送者真实身份；合并转发元素的 isSender 不能覆盖消息本身的方向。 */
export function isMineMessage(
  message: DirectionMessage,
  conversation: Conversation,
  user: User,
): boolean {
  // 数据线各设备同号，必须先按设备伪 UID 区分方向。
  if (isDatalineSelfUid(message.senderUid)) return true;
  if (datalineName(message.senderUid)) return false;
  if (message.senderUin && message.senderUin !== '0') {
    return message.senderUin === user.identityValue;
  }
  if (message.senderUid && user.uid) return message.senderUid === user.uid;
  if (conversation.type !== 'direct') return false;
  return message.elements.some((element) => {
    if (!element || typeof element !== 'object' || !('data' in element)) return false;
    const data = element.data;
    return (
      data !== null && typeof data === 'object' && 'isSender' in data && data.isSender === true
    );
  });
}
