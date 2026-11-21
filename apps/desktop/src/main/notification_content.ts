import type { GroupKeywordHit, RecallNotifyEvent } from '@weq/service';
import { groupKeywordCopy, notificationInlineText } from '../shared/notification_copy';
import type { AccountServices } from './context/app_context';

type LocalDirectory = Pick<AccountServices, 'groupInfo' | 'profile' | 'accountConfig'>;

async function groupName(directory: LocalDirectory, group: string) {
  const detail = await directory.groupInfo.getGroupDetail(BigInt(group)).catch(() => undefined);
  return detail?.groupName.trim() || `群聊 ${group}`;
}

async function memberName(directory: LocalDirectory, group: string, uid: string) {
  if (!uid) return '';
  if (uid === directory.accountConfig.getRecord()?.uid) return '你';
  const member = await directory.groupInfo.getMemberInfo(BigInt(group), uid).catch(() => undefined);
  return member?.card?.trim() || member?.nick?.trim() || '';
}

export async function groupKeywordContent(directory: LocalDirectory, hit: GroupKeywordHit) {
  const [group, sender] = await Promise.all([
    groupName(directory, hit.groupCode),
    memberName(directory, hit.groupCode, hit.senderUid),
  ]);
  return groupKeywordCopy(
    hit.keyword,
    group,
    sender || (hit.senderUin > 0n ? String(hit.senderUin) : '群成员'),
    hit.text,
  );
}

export async function recallContent(directory: LocalDirectory, event: RecallNotifyEvent) {
  const self = directory.accountConfig.getRecord()?.uid;
  if (event.kind === 'c2c') {
    const profile = await directory.profile.getProfile(event.conv).catch(() => undefined);
    const name = notificationInlineText(profile?.remark || profile?.nick || '', 32) || '私聊';
    const who = event.senderUid === self ? '你' : '对方';
    return { title: `${name} · 消息撤回`, body: `${who}撤回了一条消息` };
  }
  if (event.kind === 'dataline') return { title: '设备消息已撤回', body: '' };

  const bySender = !event.revokeUid || event.revokeUid === event.senderUid;
  const [group, senderName, operatorName] = await Promise.all([
    groupName(directory, event.conv),
    memberName(directory, event.conv, event.senderUid),
    bySender ? '' : memberName(directory, event.conv, event.revokeUid),
  ]);
  const sender = notificationInlineText(senderName, 24);
  const operator = notificationInlineText(operatorName, 24);
  const body = bySender
    ? `${sender || '一位群成员'}撤回了一条消息`
    : `${operator || '管理员'}撤回了${sender ? `${sender}的` : ''}一条消息`;
  return { title: `${notificationInlineText(group, 32)} · 消息撤回`, body };
}
