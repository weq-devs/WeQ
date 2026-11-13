import {
  CONTACT_CARD_FIELDS,
  CONTACT_GROUP_FIELDS,
  normalizeContactCard,
} from '@weq/service/contact-card';
import type { SettingsResetItem } from '../../../shared/settings_reset';
import { CONTACT_CARD_SECTIONS, contactCardFieldGroup } from './contactCardSections';

const labels: Record<string, string> = {
  off: '关闭',
  all: '全部会话',
  selected: '按会话选择',
  api: 'API 模型',
  local: '本地模型',
  heuristic: '本地统计',
  auto: '自动',
  manual: '手动',
  mixed: '双方混合',
  self: '仅本端',
  peer: '仅对方',
  home: '主页',
  messages: '消息',
  last: '上次页面',
  space: '空间',
  profile: '名片',
  totp: '验证器',
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
  tray: '最小化到托盘',
  quit: '退出',
  ask: '每次询问',
  comfortable: '舒适',
  compact: '紧凑',
  plain: '纯净',
  paper: '纸感',
  grid: '细网格',
  dots: '微点阵',
  wash: '淡洗染',
  telegram: '电报墙',
  qqnt: 'QQ NT',
  classic: '经典',
  minimal: '简约',
  retro: '复古',
};
const selections = new Set([
  'typing:selection',
  'recall-scope:targets',
  'recall-scope:notify-targets',
]);

/** 只显示产品用语，不把未知配置序列化后交给用户阅读。 */
export function formatResetValue(value: unknown, id = ''): string {
  if (selections.has(id) && Array.isArray(value))
    return value.length ? `已选择 ${value.length} 个会话` : '未选择会话';
  if (value === undefined) return '当前状态未知';
  if (id === 'damage-reminder:suppressDbDamageReminder' && typeof value === 'boolean')
    return value ? '不再提醒' : '显示提醒';
  if (value === true) return '开启';
  if (value === false) return '关闭';
  if (value === '' || value === null) {
    if (id === 'theme-accent:accent') return '预设主题色';
    if (id === 'api-default:model') return '未设置默认聊天模型';
    if (id === 'api-default:vision-model') return '未设置默认视觉模型';
    if (id === 'api-default:embedding-model') return '未设置默认向量模型';
    if (id.endsWith('ProviderRef') || id.endsWith(':providerRef')) return '使用默认聊天模型';
    if (id === 'auto-enter:account') return '不自动进入账号';
    if (id === 'rkey:enabled' || id === 'sse-targets:enabled') return '未启用';
    return '默认／未设置';
  }
  if (Array.isArray(value))
    return value.length
      ? value
          .map((entry) => (typeof entry === 'string' ? entry : formatResetValue(entry)))
          .join('、')
      : '空列表';
  if (typeof value === 'object') {
    const data = value as Record<string, unknown>;
    if ('windowSeconds' in data && 'maxPages' in data)
      return `${data.windowSeconds} 秒内最多 ${data.maxPages} 页`;
    if ('debounceMs' in data)
      return `合并等待 ${data.debounceMs} 毫秒，批量推送阈值 ${data.massThreshold} 条`;
    if ('showTags' in data)
      return `标签：${formatResetValue(data.showTags)}；问候语：${formatResetValue(data.showGreeting)}；一言：${formatResetValue(data.showHitokoto)}；屏蔽词：${formatResetValue(data.blockedWords)}`;
    if ('enabled' in data && 'screenshot' in data)
      return `链接预览：${formatResetValue(data.enabled)}；网页截图：${formatResetValue(data.screenshot)}`;
    if (data.useDefault) return '使用默认聊天模型';
    if (typeof data.model === 'string') return data.model || '使用默认聊天模型';
    if (typeof data.name === 'string') return data.name;
    if (typeof data.uin === 'string') return `QQ ${data.uin}`;
    return '自定义配置';
  }
  if (typeof value === 'number') {
    if (id === 'app-lock:autoLockMinutes' && value === 0) return '不自动锁定';
    if (id === 'update:interval' && value === -1) return '不自动检查';
    if (id.startsWith('toast:') && value === -1) return '不自动关闭';
    if (id === 'suggestion-cache:suggestionExpiryMinutes') {
      if (value === -1) return '永不过期';
      if (value === 0) return '立即过期';
    }
    const key = id.split(':').at(-1) ?? '';
    if (/Seconds$/.test(key) || id === 'toast:successSeconds' || id === 'toast:failureSeconds')
      return `${value} 秒`;
    if (/Minutes$/.test(key) || id === 'update:interval' || id === 'mail:poll-interval')
      return `${value} 分钟`;
    if (/Days$/.test(key)) return `${value} 天`;
    if (/MiB$/.test(key)) return `${value} MiB`;
  }
  if (typeof value === 'string' && (id === 'rkey:enabled' || id === 'sse-targets:enabled'))
    return '已启用一个目标';
  return typeof value === 'string' ? (labels[value] ?? value) : String(value);
}

export interface ResetPreviewLine {
  label: string;
  text: string;
}
export function describeSettingsReset(item: SettingsResetItem): ResetPreviewLine[] {
  if (item.id === 'data-saver:preferences') {
    const current = item.current as Record<string, unknown>;
    const next = item.defaultValue as Record<string, unknown>;
    const names = {
      dataSaverMode: '省流量模式',
      dataSaverImageLoading: '聊天图片自动加载',
      dataSaverAvatars: '自动加载未缓存的头像',
      dataSaverEmoji: '自动下载表情图片',
      dataSaverDress: '自动下载个性装扮',
      dataSaverVideoCovers: '自动加载视频封面',
      dataSaverPrefetch: '预加载屏幕外媒体',
      dataSaverLinkPreviews: '自动获取链接预览',
      dataSaverPauseBatch: '暂停联网批量任务',
      dataSaverPauseLarge: '暂停大文件下载',
      dataSaverLargeMiB: '大文件暂停阈值',
      dataSaverAutoResume: '限制解除后自动继续任务',
    };
    const modeNames: Record<string, string> = {
      auto: '跟随系统',
      always: '开启',
      never: '关闭',
      none: '不自动加载',
      thumbnail: '仅小图',
      original: '原图',
    };
    const format = (key: string, value: unknown) =>
      typeof value === 'string'
        ? (modeNames[value] ?? value)
        : formatResetValue(value, `data-saver:${key}`);
    const lines = Object.entries(names)
      .filter(([key]) => current[key] !== next[key])
      .map(([key, label]) => ({
        label,
        text: `${format(key, current[key])} → ${format(key, next[key])}`,
      }));
    return lines.length ? lines : [{ label: '已是默认', text: '省流量模式与行为均为默认设置' }];
  }
  if (item.id === 'contact-card:contactCard') {
    const current = normalizeContactCard(item.current);
    const next = normalizeContactCard(item.defaultValue);
    const lines: ResetPreviewLine[] = [];
    const fields = [...CONTACT_CARD_FIELDS, ...CONTACT_GROUP_FIELDS];
    for (const [enabled, label] of [
      [true, '将显示'],
      [false, '将隐藏'],
    ] as const) {
      const changed = fields.filter(
        ([key]) => current.visible[key] !== next.visible[key] && next.visible[key] === enabled,
      );
      if (changed.length) lines.push({ label, text: changed.map(([, name]) => name).join('、') });
    }
    const fieldLabels = new Map<string, string>(fields.map(([key, label]) => [key, label]));
    for (const section of CONTACT_CARD_SECTIONS) {
      const before = current.order.filter((key) => contactCardFieldGroup(key) === section.key);
      const after = next.order.filter((key) => contactCardFieldGroup(key) === section.key);
      if (before.some((key, index) => key !== after[index]))
        lines.push({
          label: `${section.title}顺序`,
          text: after.map((key) => fieldLabels.get(key)).join(' → '),
        });
    }
    if (current.groupOrder.some((key, index) => key !== next.groupOrder[index]))
      lines.push({
        label: '群内资料顺序',
        text: next.groupOrder.map((key) => fieldLabels.get(key)).join(' → '),
      });
    return lines.length ? lines : [{ label: '已是默认', text: '字段显示与排列顺序均为默认设置' }];
  }
  const after = formatResetValue(item.defaultValue, item.id);
  return JSON.stringify(item.current) === JSON.stringify(item.defaultValue)
    ? [{ label: '已是默认', text: after }]
    : [
        { label: '当前', text: formatResetValue(item.current, item.id) },
        { label: '恢复后', text: after },
      ];
}
