/** Official recent-contact metadata, independent of WeQ's local mute preferences. */
export type GroupNotificationMode = 'notify' | 'muted' | 'assistant' | 'unknown';

export const GROUP_NOTIFICATION_SECTIONS: { mode: GroupNotificationMode; label: string }[] = [
  { mode: 'notify', label: '接收消息并提醒' },
  { mode: 'muted', label: '接收消息但不提醒' },
  { mode: 'assistant', label: '收进群助手且不提醒' },
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
    // 0 and absent rows do not prove that a group blocks messages.
    default:
      return 'unknown';
  }
}
