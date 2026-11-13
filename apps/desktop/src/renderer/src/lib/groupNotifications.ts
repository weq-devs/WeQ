/** Official recent-contact metadata, independent of WeQ's local mute preferences. */
export type GroupNotificationMode = 'notify' | 'muted' | 'assistant' | 'blocked' | 'unknown';

export const GROUP_NOTIFICATION_SECTIONS: { mode: GroupNotificationMode; label: string }[] = [
  { mode: 'notify', label: '接收消息并提醒' },
  { mode: 'muted', label: '接收消息但不提醒' },
  { mode: 'assistant', label: '收进群助手且不提醒' },
  { mode: 'blocked', label: '屏蔽群消息' },
  { mode: 'unknown', label: '提醒设置未读取' },
];

export function groupNotificationMode(level: number | undefined): GroupNotificationMode {
  switch (level) {
    case 1:
      return 'notify';
    case 4:
      return 'muted';
    case 2:
      return 'assistant';
    case 3:
      return 'blocked';
    // 0 and absent rows do not prove that a group blocks messages.
    default:
      return 'unknown';
  }
}
import type { ConversationPreference } from '../im-template/template/types';

export function mutedFromNotifyLevel(level: number | undefined): boolean {
  return level !== undefined && level !== 0 && level !== 1;
}

/** 群目录先于最近会话到达时，也按同一通知状态显示免打扰。 */
export function groupDirectoryPreference(
  notifyLevel: number | undefined,
  previous?: ConversationPreference,
  pinned?: boolean,
): ConversationPreference {
  const preference = { pinned: false, muted: false, blocked: false, ...previous };
  return {
    ...preference,
    muted: notifyLevel === undefined ? preference.muted : mutedFromNotifyLevel(notifyLevel),
    pinned: pinned ?? preference.pinned,
  };
}
