import { isDatalineUid } from '@weq/codec';
import type { Conversation, User } from '../im-template/template/types';

/** 设备伪 UID 和本人 QQ 号都不能拿来补全好友资料。 */
export function contactProfileIdentity(contact?: User): { uid: string; uin: string } {
  if (!contact || contact.identityLabel === '设备' || isDatalineUid(contact.id))
    return { uid: '', uin: '' };
  return {
    uid: contact.uid || (contact.id.startsWith('u_') ? contact.id : ''),
    uin: ['QQ', 'UIN'].includes(contact.identityLabel) ? contact.identityValue : '',
  };
}

export function sendTargetOf(conversation: Conversation): {
  peerType: 'c2c' | 'group';
  targetId: string;
  tempGroupCode?: string;
} | null {
  if (conversation.type === 'group')
    return { peerType: 'group', targetId: conversation.group.identityValue };
  if (conversation.type !== 'direct') return null;
  const other = conversation.otherUser;
  if (isDatalineUid(conversation.id)) return { peerType: 'c2c', targetId: conversation.id };
  const tempGroupCode = conversation.tempSourceGroupCode;
  return {
    peerType: 'c2c',
    // 临时会话只认 UID；普通私聊优先给 QQ 号，允许陌生人发第一句。
    targetId: tempGroupCode || !/^\d+$/.test(other.identityValue) ? other.id : other.identityValue,
    ...(tempGroupCode ? { tempGroupCode } : {}),
  };
}
