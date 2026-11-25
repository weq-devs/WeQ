import type { SettingsPageId } from './navigation';

/** 设置注册表的恢复分区；前端、服务端和文档共用，不依赖已挂载的控件。 */
export const SETTINGS_RESET_CARDS = [
  ['startup', 'startup-system', '开机启动'],
  ['startup', 'startup-page', '启动时进入'],
  ['startup', 'window', '关闭窗口'],
  ['home', 'home', '主页'],
  ['appearance', 'window-appearance', '窗口外观'],
  ['appearance', 'theme-mode', '主题模式'],
  ['appearance', 'theme-accent', '主题色'],
  ['appearance', 'theme-background', '界面背景'],
  ['appearance', 'theme-components', '组件风格'],
  ['appearance', 'theme-font', '字体'],
  ['global', 'toast', '应用内横幅提醒'],
  ['global', 'notification-events', '事件通知'],
  ['global', 'notification-scopes', '事件提醒会话'],
  ['global', 'application-badge', '系统应用图标'],
  ['main-navigation', 'navigation-badges', '导航角标'],
  ['main-navigation', 'menu-badges', '菜单'],
  ['contacts', 'contact-badges', '未读显示'],
  ['global', 'recall-notifications', '撤回提醒'],
  ['privacy', 'privacy-mode', '隐私模式'],
  ['privacy', 'app-lock', '应用锁'],
  ['global', 'web-notifications', '浏览器通知授权'],
  ['chat-messages', 'conversation-preview', '会话预览'],
  ['chat-messages', 'conversation-order', '列表行为'],
  ['chat-messages', 'conversation-markers', '常规视图未读角标'],
  ['chat-messages', 'conversation-scope', '全部会话视图'],
  ['message-display', 'reading', '打开会话'],
  ['message-display', 'unread-jumps', '未读与重要消息'],
  ['message-display', 'message-browsing', '浏览消息'],
  ['message-display', 'missing-messages', '历史消息补全'],
  ['message-content', 'message-content', '消息样式与预览'],
  ['contact-card', 'contact-card', '联系人名片'],
  ['chat-interaction', 'message-send-font', '消息字体'],
  ['chat-interaction', 'quote-replies', '引用回复'],
  ['chat-interaction', 'emoji-shortcuts', '表情输入'],
  ['chat-interaction', 'typing', '隐藏正在输入状态'],
  ['anti-recall', 'recall-scope', '防撤回'],
  ['call-recording', 'call-content', '录制内容'],
  ['call-recording', 'call-directory', '保存位置'],
  ['diagnostics', 'call-trace', '通话抓包'],
  ['call-recording', 'call-connection', '连接方式'],
  ['qzone', 'qzone-person', '人物'],
  ['qzone', 'qzone-forward', '转发'],
  ['qzone', 'qzone-pagination', '在线翻页限速'],
  ['qzone', 'qzone-public-refresh', '空友爱看'],
  ['mail', 'mail', '邮箱提醒'],
  ['agentlab', 'api-default', 'LLM'],
  ['weq-assistant', 'assistant-config', '助手生成与执行'],
  ['weq-assistant', 'assistant-images', '图片处理'],
  ['intent-sense', 'intent-basic', '功能与模型'],
  ['intent-sense', 'intent-display', '显示方式'],
  ['intent-sense', 'intent-trigger', '触发方式'],
  ['intent-sense', 'intent-analysis', '分析范围'],
  ['intent-sense', 'intent-model', '模型参数'],
  ['intent-sense', 'intent-cache', '请求与缓存'],
  ['reply-suggestions', 'suggestion-basic', '功能与模型'],
  ['reply-suggestions', 'suggestion-trigger', '触发方式'],
  ['reply-suggestions', 'suggestion-content', '回复内容'],
  ['reply-suggestions', 'suggestion-generation', '生成参数'],
  ['reply-suggestions', 'suggestion-cache', '缓存与历史'],
  ['reply-suggestions', 'suggestion-fallback', '回退内容'],
  ['interaction-profile', 'profile-basic', '功能与模型'],
  ['interaction-profile', 'profile-range', '统计范围'],
  ['interaction-profile', 'profile-model', '模型推断'],
  ['interaction-profile', 'profile-display', '结果展示'],
  ['interaction-profile', 'profile-cache', '请求与缓存'],
  ['recognition', 'voice-online', '语音转写'],
  ['recognition', 'ocr-online', '图片文字识别'],
  ['enhancement-packs', 'enhancement-updates', '增强包更新设置'],
  ['database-management', 'realtime', '监听与读取'],
  ['account', 'attach', 'QQ 在线能力'],
  ['account', 'qq-client-sync', '代理连接'],
  ['account', 'qq-status-reminders', '状态提醒'],
  ['accounts', 'auto-enter', '现有配置'],
  ['resource-loading', 'external-chatpic', '外部安卓图片缓存'],
  ['resource-loading', 'cdn', '加载来源'],
  ['resource-loading', 'chat-image-preview', '聊天图片'],
  ['resource-loading', 'qqshow-cache', 'QQ 秀缓存'],
  ['resource-loading', 'chat-memory', '聊天内存预算'],
  ['resource-loading', 'rkey', '外部 rKey 服务器'],
  ['data-saver', 'data-saver', '启用方式与行为'],
  ['remote', 'web', '本机浏览器访问'],
  ['remote', 'remote', 'WeQ Remote'],
  ['mcp', 'mcp', '服务开关'],
  ['onebot', 'onebot', '网络配置'],
  ['sse', 'sse-targets', '已配置的推送目标'],
  ['sse', 'sse-tuning', '推送调优'],
  ['assistant', 'assistant', '推送与资源服务'],
  ['version', 'update', '软件更新'],
  ['logs', 'logs', '应用日志'],
  ['logs', 'performance-recording', '性能记录'],
  ['database-management', 'database-read', '读取性能'],
] as const;
export type SettingsResetCardId = (typeof SETTINGS_RESET_CARDS)[number][1];
export type SettingsResetPageId = (typeof SETTINGS_RESET_CARDS)[number][0];
export type SettingsResetTarget = {
  page: SettingsResetPageId | 'credentials' | 'qq-proxy' | 'qq-status-reminders';
  card?: SettingsResetCardId;
};
export interface SettingsResetItem {
  id: string;
  label: string;
  scope: '全局' | '当前账号' | '此设备';
  current: unknown;
  defaultValue: unknown;
  directory?: boolean;
  stopsService?: boolean;
}

export function settingsResetScopeLabel(scope: SettingsResetItem['scope']): string {
  return scope === '此设备' ? '运行 WeQ 的电脑' : scope;
}

export interface SettingsResetResult {
  id: string;
  ok: boolean;
  error?: string;
}
export interface SettingsResetSelection {
  directories?: readonly string[];
  retry?: readonly string[];
}

/** 预览与执行共用选择规则；重试只选择明确列出的失败项。 */
export function planSettingsReset<
  T extends Pick<SettingsResetItem, 'id' | 'current' | 'defaultValue' | 'directory'>,
>(items: readonly T[], selection: SettingsResetSelection = {}): T[] {
  const allowed = new Set(items.map((item) => item.id));
  if ([...(selection.directories ?? []), ...(selection.retry ?? [])].some((id) => !allowed.has(id)))
    throw new Error('恢复项目不属于当前范围');
  return items.filter(
    (item) =>
      (!selection.retry || selection.retry.includes(item.id)) &&
      (!item.directory || selection.directories?.includes(item.id)) &&
      (selection.retry || JSON.stringify(item.current) !== JSON.stringify(item.defaultValue)),
  );
}
const previousResetPages: Partial<Record<SettingsResetCardId, SettingsPageId>> = {
  home: 'startup',
  'message-content': 'message-display',
  'recall-scope': 'chat-interaction',
  'call-trace': 'call-recording',
  rkey: 'credentials',
  'data-saver': 'resource-loading',
  realtime: 'account',
  'database-read': 'account',
};

export function resetCards(target: SettingsResetTarget) {
  // 旧的页面恢复入口仍仅恢复当时页面上的设置。
  const previousCard =
    target.page === 'qq-proxy'
      ? 'qq-client-sync'
      : target.page === 'qq-status-reminders'
        ? 'qq-status-reminders'
        : undefined;
  const card = target.card ?? previousCard;
  const currentPage =
    previousCard && card === previousCard
      ? 'account'
      : card && previousResetPages[card] === target.page
        ? SETTINGS_RESET_CARDS.find(([, id]) => id === card)?.[0]
        : target.page;
  const cards = SETTINGS_RESET_CARDS.filter(
    ([page, id]) => page === currentPage && (!card || id === card),
  );
  if (!cards.length) throw new Error('未知的设置恢复范围');
  return cards;
}
