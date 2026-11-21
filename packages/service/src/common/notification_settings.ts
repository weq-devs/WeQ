export const NOTIFICATION_GROUPS = [
  {
    id: 'ordinary',
    label: '普通消息',
    events: ['directMessage', 'groupMessage', 'assistantReply'],
  },
  {
    id: 'important',
    label: '重点消息',
    events: ['specialCare', 'mentionMe', 'mentionAll', 'replyMe', 'redPacket', 'keyword'],
  },
  { id: 'activity', label: '其他通知', events: ['recall', 'contact', 'mail'] },
  {
    id: 'app',
    label: '应用与任务',
    events: [
      'progress',
      'taskComplete',
      'taskFailure',
      'update',
      'officialAnnouncement',
      'connection',
      'runtime',
      'databaseDamage',
      'request',
      'dataSaver',
      'success',
      'failure',
    ],
  },
] as const;
export type NotificationEvent = (typeof NOTIFICATION_GROUPS)[number]['events'][number];
export type NotificationChannel = 'banner' | 'system';
export type NotificationEvents = Record<NotificationEvent, Record<NotificationChannel, boolean>>;
export type NotificationEventOverrides = Partial<
  Record<NotificationEvent, Partial<Record<NotificationChannel, boolean>>>
>;
export function supportsNotificationChannel(
  event: NotificationEvent,
  channel: NotificationChannel,
) {
  return event !== 'officialAnnouncement' || channel === 'banner';
}
export function mergeNotificationEventOverrides(
  before: unknown,
  patch: unknown,
): NotificationEventOverrides {
  const result: NotificationEventOverrides = {};
  for (const raw of [before, patch]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const event of NOTIFICATION_EVENTS) {
      const channels: unknown = Reflect.get(raw, event);
      if (!channels || typeof channels !== 'object' || Array.isArray(channels)) continue;
      for (const channel of ['banner', 'system'] as const) {
        if (!supportsNotificationChannel(event, channel)) continue;
        const value: unknown = Reflect.get(channels, channel);
        if (typeof value === 'boolean') result[event] = { ...result[event], [channel]: value };
      }
    }
  }
  return result;
}
export const NOTIFICATION_LABELS: Record<NotificationEvent, string> = {
  directMessage: '普通私聊消息',
  groupMessage: '普通群聊消息',
  assistantReply: '收到助手或克隆体的新回复',
  specialCare: '特别关心',
  mentionMe: '@自己',
  mentionAll: '@全体成员',
  replyMe: '群友回复',
  redPacket: '红包消息',
  keyword: '群关键词',
  recall: '撤回提醒',
  contact: '联系人与群通知',
  mail: '新邮件',
  progress: '任务或操作进行中',
  taskComplete: '后台任务完成',
  taskFailure: '后台任务失败或部分失败',
  update: '发现新版本或增强包更新',
  officialAnnouncement: '重要官方公告',
  connection: '连接中断或恢复',
  runtime: '功能受限或运行异常',
  databaseDamage: '数据库异常提醒',
  request: '有请求等待处理',
  dataSaver: '省流量模式自动开启或关闭',
  success: '操作成功与普通提示',
  failure: '操作失败或结果未确认',
};
export const NOTIFICATION_EVENTS = NOTIFICATION_GROUPS.flatMap((group) => [...group.events]);
const BANNER_DISABLED_DEFAULTS = new Set<NotificationEvent>([
  'directMessage',
  'groupMessage',
  'assistantReply',
  'redPacket',
]);
const SYSTEM_DEFAULTS = new Set<NotificationEvent>([
  'directMessage',
  'groupMessage',
  'assistantReply',
  'specialCare',
  'mentionMe',
  'mentionAll',
  'replyMe',
  'keyword',
  'contact',
  'mail',
  'taskFailure',
  'request',
]);
export const DEFAULT_NOTIFICATION_EVENTS = Object.fromEntries(
  NOTIFICATION_EVENTS.map((event) => [
    event,
    { banner: !BANNER_DISABLED_DEFAULTS.has(event), system: SYSTEM_DEFAULTS.has(event) },
  ]),
) as NotificationEvents;

export interface LegacyNotificationSettings {
  messageNotifications?: boolean;
  mailNotifications?: boolean;
  recallNotifications?: boolean;
  restrictedModeBannerEnabled?: boolean;
  suppressDbDamageReminder?: boolean;
}
/** 仅继承确实存在的旧值；没有旧配置的新项使用清单默认值。 */
export function normalizeNotificationEvents(
  raw: unknown,
  legacy: LegacyNotificationSettings = {},
): NotificationEvents {
  const result = structuredClone(DEFAULT_NOTIFICATION_EVENTS);
  if (typeof legacy.messageNotifications === 'boolean') {
    result.directMessage.system = legacy.messageNotifications;
    result.groupMessage.system = legacy.messageNotifications;
  }
  if (typeof legacy.mailNotifications === 'boolean')
    result.mail = { banner: legacy.mailNotifications, system: legacy.mailNotifications };
  if (typeof legacy.recallNotifications === 'boolean')
    result.recall.system = legacy.recallNotifications;
  if (typeof legacy.restrictedModeBannerEnabled === 'boolean')
    result.runtime.banner = legacy.restrictedModeBannerEnabled;
  if (typeof legacy.suppressDbDamageReminder === 'boolean')
    result.databaseDamage.banner = !legacy.suppressDbDamageReminder;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const event of NOTIFICATION_EVENTS) {
    const value: unknown = Reflect.get(raw, event);
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const channel of ['banner', 'system'] as const) {
      if (!supportsNotificationChannel(event, channel)) continue;
      const enabled: unknown = Reflect.get(value, channel);
      if (typeof enabled === 'boolean') result[event][channel] = enabled;
    }
  }
  return result;
}
export function notificationGroupState(
  events: readonly NotificationEvent[],
  channel: NotificationChannel,
  values: NotificationEvents,
) {
  const supported = events.filter((event) => supportsNotificationChannel(event, channel));
  const count = supported.filter((event) => values[event][channel]).length;
  return {
    checked: supported.length > 0 && count === supported.length,
    mixed: count > 0 && count < supported.length,
  };
}
export const SCOPED_NOTIFICATION_EVENTS = [
  'specialCare',
  'mentionMe',
  'mentionAll',
  'replyMe',
  'redPacket',
  'keyword',
] as const;
export type ScopedNotificationEvent = (typeof SCOPED_NOTIFICATION_EVENTS)[number];
export function isScopedNotificationEvent(
  event: NotificationEvent,
): event is ScopedNotificationEvent {
  return SCOPED_NOTIFICATION_EVENTS.some((candidate) => candidate === event);
}
export const NOTIFICATION_SCOPE_OPTIONS = [
  { value: 'all', label: '全部适用会话' },
  { value: 'nonGroupAssistant', label: '非群助手会话' },
  { value: 'nonMuted', label: '非免打扰会话' },
  { value: 'selected', label: '指定会话' },
] as const;
export type NotificationScopeMode = (typeof NOTIFICATION_SCOPE_OPTIONS)[number]['value'];
export interface NotificationScope {
  mode: NotificationScopeMode;
  targets: string[];
}
export function isNotificationScopeMode(value: unknown): value is NotificationScopeMode {
  return NOTIFICATION_SCOPE_OPTIONS.some((option) => option.value === value);
}
export function normalizeNotificationScope(
  raw: unknown,
  event?: ScopedNotificationEvent,
): NotificationScope {
  if (raw === undefined) return { mode: event === 'specialCare' ? 'nonMuted' : 'all', targets: [] };
  if (!raw || typeof raw !== 'object') return { mode: 'selected', targets: [] };
  const mode: unknown = Reflect.get(raw, 'mode');
  const targets: unknown = Reflect.get(raw, 'targets');
  return {
    mode: isNotificationScopeMode(mode) ? mode : 'selected',
    targets: Array.isArray(targets)
      ? [
          ...new Set(
            targets.filter(
              (value): value is string =>
                typeof value === 'string' && /^(c2c|group|dataline):.+/.test(value),
            ),
          ),
        ]
      : [],
  };
}

export function mutedFromNotifyLevel(level: number | undefined): boolean {
  return level !== undefined && level !== 0 && level !== 1;
}

export function notificationScopeIncludes(
  scope: NotificationScope,
  conversation: { key: string; muted: boolean; groupAssistant: boolean },
): boolean {
  switch (scope.mode) {
    case 'all':
      return true;
    case 'nonGroupAssistant':
      return !conversation.groupAssistant;
    case 'nonMuted':
      return !conversation.muted;
    case 'selected':
      return scope.targets.includes(conversation.key);
  }
}
