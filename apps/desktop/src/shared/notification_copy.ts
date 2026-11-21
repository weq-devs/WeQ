import { NOTIFICATION_GROUPS, type NotificationEvent } from '@weq/service/notification-settings';

export function notificationInlineText(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}

export const PRIVATE_MESSAGE_NOTICE = { title: 'WeQ', body: '收到新消息' };
export const PRIVATE_RECALL_NOTICE = { title: 'WeQ', body: '有一条消息被撤回' };
export const MAIL_NOTICE = { title: 'QQ 邮箱收到新邮件', body: '' };

const chatNotices = new Set<NotificationEvent>(
  NOTIFICATION_GROUPS.flatMap(({ id, events }) =>
    id === 'app' || id === 'activity' ? [] : [...events],
  ),
);

export function privateToastCopy(event: NotificationEvent) {
  if (event === 'mail') return MAIL_NOTICE;
  if (event === 'recall') return PRIVATE_RECALL_NOTICE;
  if (event === 'contact') return { title: 'WeQ', body: '有新的好友或群通知' };
  if (event === 'assistantReply') return { title: 'WeQ', body: '收到新回复' };
  return chatNotices.has(event) ? PRIVATE_MESSAGE_NOTICE : undefined;
}

export function mailBannerCopy(subject: string, sender: string) {
  const from = notificationInlineText(sender, 65);
  const title = notificationInlineText(subject, 70);
  if (!title && !from) return undefined;
  return { title: title || '新邮件（无主题）', body: from ? `QQ 邮箱 · 来自 ${from}` : 'QQ 邮箱' };
}

export function groupKeywordCopy(keyword: string, group: string, sender: string, text: string) {
  const title = `群提醒词「${notificationInlineText(keyword, 26)}」 · ${notificationInlineText(group, 36)}`;
  const body = `${notificationInlineText(sender, 24)}：${notificationInlineText(text, 200) || '发来一条消息'}`;
  return { title, body };
}
