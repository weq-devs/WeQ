/** 设置注册表的恢复分区；前端、服务端和文档共用，不依赖已挂载的控件。 */
export const SETTINGS_RESET_CARDS = [
  ['startup', 'startup-system', '开机启动'],
  ['startup', 'startup-page', '启动时进入'],
  ['startup', 'window', '关闭窗口'],
  ['startup', 'home', '主页'],
  ['appearance', 'theme-mode', '基础模式'],
  ['appearance', 'theme-accent', '主题色'],
  ['appearance', 'theme-background', '界面背景'],
  ['appearance', 'theme-components', '组件风格'],
  ['appearance', 'window-appearance', '窗口外观'],
  ['global', 'toast', '应用内横幅提醒'],
  ['global', 'notification-events', '事件通知'],
  ['global', 'notification-badges', '未读角标'],
  ['global', 'recall-notifications', '撤回提醒'],
  ['privacy', 'privacy-mode', '隐私模式'],
  ['privacy', 'app-lock', '应用锁'],
  ['global', 'web-notifications', '浏览器通知授权'],
  ['chat-messages', 'conversation-preview', '会话预览'],
  ['chat-messages', 'conversation-order', '列表行为'],
  ['chat-messages', 'conversation-markers', '常规视图未读角标'],
  ['chat-messages', 'conversation-scope', '全部会话视图'],
  ['message-display', 'reading', '阅读与定位'],
  ['message-display', 'message-content', '内容显示'],
  ['contact-card', 'contact-card', '联系人名片'],
  ['chat-interaction', 'sending', '发送消息'],
  ['chat-interaction', 'quote-replies', '引用回复'],
  ['chat-interaction', 'emoji-shortcuts', '表情输入'],
  ['chat-interaction', 'typing', '隐藏正在输入状态'],
  ['chat-interaction', 'recall-scope', '防撤回'],
  ['call-recording', 'call-content', '录制内容'],
  ['call-recording', 'call-directory', '保存位置'],
  ['call-recording', 'call-trace', '抓包与排障'],
  ['call-recording', 'call-connection', '连接方式'],
  ['qzone', 'qzone-person', '人物入口'],
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
  ['enhancement-packs', 'enhancement-updates', '增强包自动更新'],
  ['database-management', 'realtime', '监听与读取'],
  ['account', 'attach', 'QQ 在线能力'],
  ['account', 'read-sync', '已读同步'],
  ['accounts', 'auto-enter', '现有配置'],
  ['resource-loading', 'external-chatpic', '外部安卓图片缓存'],
  ['resource-loading', 'cdn', '加载来源'],
  ['resource-loading', 'data-saver', '省流量模式'],
  ['resource-loading', 'qqshow-cache', 'QQ 秀缓存'],
  ['credentials', 'rkey', '外部 rKey 服务器'],
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
export type SettingsResetTarget = { page: SettingsResetPageId; card?: SettingsResetCardId };
export interface SettingsResetItem {
  id: string;
  label: string;
  scope: '全局' | '当前账号' | '此设备';
  current: unknown;
  defaultValue: unknown;
  directory?: boolean;
  stopsService?: boolean;
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
export function resetCards(target: SettingsResetTarget) {
  const currentPage =
    target.page === 'account' && (target.card === 'realtime' || target.card === 'database-read')
      ? 'database-management'
      : target.page;
  const cards = SETTINGS_RESET_CARDS.filter(
    ([page, card]) => page === currentPage && (!target.card || card === target.card),
  );
  if (!cards.length) throw new Error('未知的设置恢复范围');
  return cards;
}
