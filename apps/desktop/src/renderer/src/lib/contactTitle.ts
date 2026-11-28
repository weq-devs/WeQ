import { classifyChatType, datalineName, isGroupTempChatType } from '@weq/codec';

interface ContactTitleFields {
  chatType: string | number;
  targetUid: string;
  targetUin?: string;
  senderUid?: string;
  senderRemark?: string;
  targetGroupNick?: string;
  targetDisplayName?: string;
  targetRemark?: string;
  senderDisplayName?: string;
  senderNick?: string;
}

export function contactTitle(
  contact: ContactTitleFields,
  profile?: { remark?: string | null; nick?: string | null },
): string {
  const kind = classifyChatType(contact.chatType);
  // 小Q：recent_contact 里 40094 是空的，targetUid 是内部 sessionId（10000），
  // 不能当名字显示。固定叫「小Q」。
  if (kind === 'aiAssistant') return '小Q';
  if (kind === 'dataline')
    return datalineName(contact.targetUid) || contact.targetDisplayName || '我的设备';
  if (kind === 'direct' && profile)
    return (
      profile.remark ||
      (isGroupTempChatType(contact.chatType) ? contact.targetGroupNick : '') ||
      profile.nick ||
      (contact.targetUin && contact.targetUin !== '0' ? contact.targetUin : contact.targetUid)
    );
  // 群会话的 senderRemark 属于最后发言人，不能用作群名。
  const remark = kind === 'direct' ? contact.senderRemark || contact.targetGroupNick : '';
  return (
    remark ||
    contact.targetDisplayName ||
    contact.targetRemark ||
    contact.senderDisplayName ||
    contact.senderNick ||
    datalineName(contact.targetUid) ||
    contact.targetUid
  );
}

export function contactSenderName(
  contact: ContactTitleFields,
  profiles: Pick<ReadonlyMap<string, string>, 'get'>,
  members?: Pick<ReadonlyMap<string, string>, 'get'>,
): string {
  const uid = contact.senderUid ?? '';
  const resolved =
    classifyChatType(contact.chatType) === 'group' ? members?.get(uid) || profiles.get(uid) : '';
  return resolved || contact.senderDisplayName || contact.senderNick || '';
}
