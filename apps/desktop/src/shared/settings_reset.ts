/** 稳定恢复身份与可见分区的对应关系；不依赖已挂载的控件。 */
export const SETTINGS_RESET_CARDS = [
  ['startup', 'startup-system', '开机启动'],
  ['startup', 'startup-page', '启动时进入'],
  ['startup', 'home', '主页'],
  ['appearance', 'theme-mode', '基础模式'],
  ['appearance', 'theme-accent', '主题色'],
  ['appearance', 'theme-background', '界面背景'],
  ['appearance', 'theme-components', '组件风格'],
  ['global', 'window', '窗口'],
  ['global', 'toast', '应用内横幅提醒'],
  ['global', 'message-notifications', '消息提醒'],
  ['privacy', 'privacy-mode', '隐私模式'],
  ['privacy', 'app-lock', '应用锁'],
  ['privacy', 'web-notifications', '网页通知'],
  ['chat-messages', 'unread', '未读显示'],
  ['chat-messages', 'reading', '阅读与定位'],
  ['message-display', 'message-time', '时间与序号'],
  ['message-display', 'message-dress', '头像与装扮'],
  ['message-display', 'message-text', '文本与链接'],
  ['message-display', 'message-voice', '语音消息'],
  ['message-display', 'image-cache', '图片与表情'],
  ['contact-card', 'contact-card', '联系人名片'],
  ['chat-interaction', 'sending', '发送消息'],
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
  ['voice', 'voice-online', 'QQ 在线转写'],
  ['ocr', 'ocr-online', 'QQ 在线识别'],
  ['account', 'realtime', '实时监听'],
  ['account', 'attach', '自动进入完整模式'],
  ['accounts', 'auto-enter', '现有配置'],
  ['media', 'native-media', '关联资源目录'],
  ['media', 'external-chatpic', '外部安卓图片缓存'],
  ['database-repair', 'damage-reminder', '损坏提醒'],
  ['database-tolerance', 'db-tolerance', '容错级别'],
  ['resource-loading', 'cdn', '加载来源'],
  ['credentials', 'rkey', '已导入的服务器'],
  ['remote', 'web', '本机浏览器访问'],
  ['remote', 'remote', 'WeQ Remote'],
  ['mcp', 'mcp', '服务开关'],
  ['onebot', 'onebot', '总开关'],
  ['onebot', 'onebot-servers', '网络服务器'],
  ['sse', 'sse-targets', '已配置的推送目标'],
  ['sse', 'sse-tuning', '推送调优'],
  ['assistant', 'assistant', '推送与资源服务'],
  ['version', 'update', '软件更新'],
  ['logs', 'logs', '日志'],
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
export function resetCards(target: SettingsResetTarget) {
  const cards = SETTINGS_RESET_CARDS.filter(
    ([page, card]) => page === target.page && (!target.card || card === target.card),
  );
  if (!cards.length) throw new Error('未知的设置恢复范围');
  return cards;
}
