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
  if (kind === 'direct' && profile)
    return (
      profile.remark ||
      (isGroupTempChatType(contact.chatType) ? contact.targetGroupNick : '') ||
      profile.nick ||
      (contact.targetUin && contact.targetUin !== '0' ? contact.targetUin : contact.targetUid)
    );
  // 群会话的 senderRemark 属于最后发言人，不能用作群名；数据线保留设备名。
  const remark =
    kind === 'direct' || kind === 'dataline' ? contact.senderRemark || contact.targetGroupNick : '';
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
  profiles: ReadonlyMap<string, string>,
  members?: ReadonlyMap<string, string>,
): string {
  const uid = contact.senderUid ?? '';
  const resolved =
    classifyChatType(contact.chatType) === 'group' ? members?.get(uid) || profiles.get(uid) : '';
  return resolved || contact.senderDisplayName || contact.senderNick || '';
}
