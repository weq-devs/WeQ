import type { AppSettings } from '../../bootstrap/user_config';
import type { IntentSenseConfig } from '../../account/intent_sense';
import { INTENT_TUNING, type IntentTuningKey } from '../intent_context';
import type { PreferenceKey } from '../client_preferences';
import type { SettingsResetCardId } from './reset';

export interface SettingField {
  id: string;
  card: SettingsResetCardId;
  settingId: string;
  label: string;
  source: 'app' | 'client' | 'intent' | 'runtime';
  key: string;
  scope: '全局' | '当前账号' | '此设备';
  directory?: boolean;
  stopsService?: boolean;
  desktopOnly?: boolean;
  remoteUnsupported?: boolean;
}

function field(
  card: SettingsResetCardId,
  key: string,
  settingId: string,
  label: string,
  source: SettingField['source'],
  extra: Partial<
    Pick<SettingField, 'scope' | 'directory' | 'stopsService' | 'desktopOnly' | 'remoteUnsupported'>
  > = {},
): SettingField {
  return { id: `${card}:${key}`, card, key, settingId, label, source, scope: '全局', ...extra };
}

/** 应用设置使用现有 DEFAULT_APP_SETTINGS；这里仅登记字段归属，不复制默认值。 */
export const APP_SETTING_FIELDS = (
  [
    ['home', 'home', 'home-settings', '主页显示与屏蔽词'],
    ['contact-card', 'contactCard', 'contact-card-order', '名片显示与顺序'],
    ['startup-page', 'startupPage', 'startup-page', '启动时进入'],
    ['startup-system', 'showWindowOnAutostart', 'startup-show-window', '自启时显示窗口'],
    ['window', 'windowCloseBehavior', 'window-close-behavior', '关闭窗口时'],
    ['window-appearance', 'windowsStyleControls', 'windows-style-controls', '仿 Windows 窗口按钮'],
    ['app-lock', 'autoLockMinutes', 'auto-lock', '自动锁定分钟'],
    ['unread', 'showMessageUnreadBadge', 'message-unread-badge', '消息红点'],
    ['unread', 'showContactUnreadCount', 'contact-unread-count', '联系人未读数'],
    ['unread', 'showGroupAssistantMessageCount', 'group-assistant-count', '群助手计数'],
    ['reading', 'readFromFirstUnread', 'read-first-unread', '从首条未读开始'],
    ['reading', 'jumpToLatestAfterSend', 'jump-latest-after-send', '发送后跳到最新'],
    ['reading', 'autoFollowLatestMessages', 'auto-follow-latest-messages', '自动跟随新消息'],
    ['reading', 'showScrollToBottomButton', 'scroll-to-bottom-button', '回到底部按钮'],
    ['unread', 'reportReadEnabled', 'read-sync', '自动阅读上报已读位置'],
    ['unread', 'manualReadReportEnabled', 'read-sync', '手动标记上报已读位置'],
    ['message-content', 'showMessageSeq', 'message-seq', '消息序号'],
    ['message-content', 'showMessageDate', 'message-date', '消息日期'],
    ['message-content', 'showMessageTime', 'message-time', '消息时间'],
    ['message-content', 'showAvatarPendant', 'avatar-pendant', '头像挂件'],
    ['message-content', 'showChatQqShow', 'chat-qqshow', 'QQ 秀头像'],
    ['qqshow-cache', 'qqShowCacheMinutes', 'chat-qqshow-days', 'QQ 秀缓存有效期'],
    ['message-content', 'showMsgDecoration', 'message-bubble', '消息装饰'],
    ['message-content', 'showMessageBubble', 'message-bubble', '消息气泡'],
    ['message-content', 'showMessageFont', 'message-font', '消息字体'],
    ['message-content', 'renderTextMarkdown', 'text-markdown', 'Markdown 文本'],
    ['message-content', 'linkPreview', 'link-preview', '链接预览'],
    ['message-content', 'chatImageCacheMiB', 'chat-image-cache', '图片预览内存预算'],
    ['sending', 'sendWithQqFont', 'send-with-qq-font', 'QQ 个性字体发送'],
    ['call-connection', 'callDisableP2P', 'call-p2p', '禁用 P2P'],
    ['qzone-person', 'qzonePersonClickAction', 'qzone-person-click', '人物入口'],
    ['qzone-forward', 'qzoneForwardQuotePrevious', 'qzone-forward', '引用上一人文案'],
    ['qzone-pagination', 'qzonePagination', 'qzone-pagination', '在线翻页限速'],
    [
      'qzone-public-refresh',
      'qzonePublicRefreshCooldownMinutes',
      'qzone-public-refresh',
      '自动刷新冷却期',
    ],
    ['realtime', 'realtimeEnabled', 'realtime-enabled', '数据库监听'],
    ['attach', 'autoAttachQq', 'auto-full-mode', '自动启用 QQ 在线能力'],
    ['attach', 'restrictedModeBannerEnabled', 'restricted-mode-banner', '受限模式横幅提醒'],
    ['db-tolerance', 'suppressDbDamageReminder', 'damage-reminder', '损坏提醒'],
    [
      'attach',
      'restrictedModeIndicatorEnabled',
      'restricted-mode-indicator',
      '受限模式时在窗口右上角显示',
    ],
    ['cdn', 'preferCdn', 'prefer-cdn', '优先 CDN'],
    ['logs', 'logRetentionDays', 'log-retention', '日志保留天数'],
    ['database-read', 'databaseReadConcurrency', 'database-read-concurrency', '数据库读取并发上限'],
    ['web', 'webServiceAutoStart', 'web-autostart', 'Web 服务自动启动'],
  ] as const satisfies readonly (readonly [
    SettingsResetCardId,
    keyof AppSettings,
    string,
    string,
  ])[]
).map(([card, key, id, label]) => ({
  ...field(card, key, id, label, 'app'),
  key,
  desktopOnly: key === 'webServiceAutoStart',
}));

/** 前端即时反馈与宿主恢复都消费同一份共享偏好绑定。 */
export const CLIENT_SETTING_FIELDS = (
  [
    ['theme-mode', 'preference', 'theme-mode', '基础模式'],
    ['theme-accent', 'accent', 'theme-accent', '主题色'],
    ['theme-background', 'background', 'theme-background', '界面背景'],
    ['theme-components', 'componentStyle', 'component-style', '组件风格'],
    ['theme-components', 'density', 'interface-density', '界面密度'],
    ['privacy-mode', 'privacyMode', 'privacy-mode', '隐私模式'],
    ['privacy-mode', 'capturePrivacy', 'privacy-menu-capture', '截图临时隐私模式'],
    ['web-notifications', 'webNotifications', 'web-notifications', '网页通知'],
    [
      'conversation-order',
      'keepConversationPositionOnHover',
      'keep-conversation-position-on-hover',
      '鼠标停留时保持会话位置',
    ],
    [
      'message-notifications',
      'messageNotifications',
      'message-system-notifications',
      '新消息系统通知',
    ],
    ['message-content', 'showGroupMemberName', 'group-message-name', '显示群消息发送者名称'],
    ['message-content', 'showGroupMemberLevel', 'group-message-level', '显示群成员等级'],
    ['message-content', 'showGroupMemberTitle', 'group-message-title', '显示群成员头衔与身份'],
    ['quote-replies', 'autoMentionOnQuote', 'quote-auto-mention', '群聊引用时自动 @ 对方'],
    ['quote-replies', 'backspaceRemovesQuote', 'quote-backspace-remove', '按退格键移除引用'],
    ['emoji-shortcuts', 'slashEmojiEnabled', 'slash-emoji-input', '斜杠表情快捷输入'],
    ['emoji-shortcuts', 'slashEmojiAutoReplace', 'slash-emoji-auto-replace', '无需回车即自动替换'],
    ['message-notifications', 'applicationBadge', 'application-unread-badge', '应用图标未读角标'],
    [
      'reading',
      'autoFetchMissingMessages',
      'auto-fetch-missing-messages',
      '查看时自动拉取缺失的消息',
    ],
    [
      'reading',
      'autoFetchMissingContext',
      'auto-fetch-missing-context',
      '定位到缺失消息时自动拉取上下文',
    ],
    [
      'reading',
      'missingMessageContextCount',
      'missing-message-context-count',
      '自动拉取上下文条数',
    ],
    [
      'conversation-scope',
      'allConversationsIncludeHidden',
      'all-conversations-include-hidden',
      '包含已隐藏会话',
    ],
    [
      'conversation-scope',
      'allConversationsIncludeDeleted',
      'all-conversations-include-deleted',
      '包含已删除会话',
    ],
  ] as const satisfies readonly (readonly [SettingsResetCardId, PreferenceKey, string, string])[]
).map(([card, key, id, label]) => ({
  ...field(card, key, id, label, 'client'),
  key,
  // 已有恢复回执的身份保持不变。
  id: `${card}:${({ componentStyle: 'style', privacyMode: 'enabled', capturePrivacy: 'capture', webNotifications: 'enabled', messageNotifications: 'message-notifications', applicationBadge: 'application-badge' } as Partial<Record<PreferenceKey, string>>)[key] ?? key}`,
}));

const INTENT_GROUPS = {
  'intent-basic': ['enabled', 'analysisMode', 'engine', 'providerRef'],
  'intent-display': ['persistentDisplay', 'hoverDisplay', 'loadingAnimation'],
  'intent-trigger': ['analyzeAfterSelf'],
  'intent-analysis': [
    'analysisContextMessages',
    'backfillMessages',
    'contextGapMinutes',
    'contextSpanMinutes',
  ],
  'intent-model': ['analysisTemperature', 'apiBatchMessages'],
  'intent-cache': ['apiTimeoutSeconds', 'apiCooldownSeconds', 'cacheEntries'],
  'suggestion-basic': ['suggestionsEnabled', 'suggestionMode', 'suggestionProviderRef'],
  'suggestion-trigger': ['suggestAfterSelf'],
  'suggestion-content': ['suggestionContextMessages', 'suggestionCount', 'suggestionTargetChars'],
  'suggestion-generation': ['suggestionTemperature'],
  'suggestion-cache': [
    'suggestionCacheSeconds',
    'suggestionExpiryMinutes',
    'suggestionHistoryLimit',
  ],
  'suggestion-fallback': ['suggestionFallbackEnabled', 'suggestionFallbackTexts'],
  'profile-basic': [
    'profileEnabled',
    'profileMode',
    'profileEngine',
    'profileProviderRef',
    'profileLocalModelId',
  ],
  'profile-range': ['profileMessages', 'profileDecayDays', 'profileGapMinutes'],
  'profile-model': [
    'profileSamples',
    'profileMinSamples',
    'profileModelTopics',
    'profileTemperature',
  ],
  'profile-display': ['profileTrendDays', 'profileTopicLimit'],
  'profile-cache': ['profileApiTimeoutSeconds', 'profileApiCooldownSeconds', 'profileCacheSeconds'],
} as const satisfies Partial<Record<SettingsResetCardId, readonly (keyof IntentSenseConfig)[]>>;
const intentIdentities: Partial<Record<keyof IntentSenseConfig, readonly [string, string]>> = {
  enabled: ['intent-enabled', '启用意图感知'],
  analysisMode: ['intent-mode', '分析模式'],
  engine: ['intent-engine', '分析引擎'],
  providerRef: ['intent-api-model', '分析模型'],
  persistentDisplay: ['intent-persistent-display', '常驻显示'],
  hoverDisplay: ['intent-hover-display', '悬停显示'],
  loadingAnimation: ['intent-loading-animation', '分析等待动画'],
  analyzeAfterSelf: ['intent-after-self', '自己发送后分析'],
  suggestionsEnabled: ['suggestions-enabled', '启用推荐回复'],
  suggestionMode: ['suggestions-mode', '推荐模式'],
  suggestionProviderRef: ['suggestions-model', '推荐模型'],
  suggestAfterSelf: ['suggestions-after-self', '自己发送后推荐'],
  suggestionFallbackEnabled: ['suggestions-fallback-enabled', '启用回退内容'],
  suggestionFallbackTexts: ['suggestions-fallback-texts', '回退内容列表'],
  profileEnabled: ['profile-enabled', '启用互动画像'],
  profileMode: ['profile-mode', '画像模式'],
  profileEngine: ['profile-engine', '画像引擎'],
  profileProviderRef: ['profile-api-model', '画像模型'],
  profileLocalModelId: ['profile-local-model', '画像本地模型'],
};
export const INTENT_SETTING_FIELDS = Object.entries(INTENT_GROUPS).flatMap(([card, keys]) =>
  keys.map((key) => {
    const [id, label] = intentIdentities[key] ?? [
      `intent-tuning-${key}`,
      INTENT_TUNING[key as IntentTuningKey].label,
    ];
    return { ...field(card as SettingsResetCardId, key, id, label, 'intent'), key };
  }),
);

export const RUNTIME_SETTING_FIELDS: readonly SettingField[] = [
  field('startup-system', 'autostart', 'startup-enabled', '开机自动启动', 'runtime', {
    desktopOnly: true,
  }),
  field(
    'enhancement-updates',
    'autoCheck',
    'enhancement-auto-check',
    '自动检查增强包更新',
    'runtime',
  ),
  field(
    'enhancement-updates',
    'autoInstall',
    'enhancement-auto-install',
    '自动安装增强包更新',
    'runtime',
  ),
  field('toast', 'successSeconds', 'toast-success', '成功通知停留时长', 'runtime'),
  field('toast', 'failureSeconds', 'toast-failure', '失败通知停留时长', 'runtime'),
  field('app-lock', 'enabled', 'app-lock', '启用应用锁', 'runtime'),
  field('app-lock', 'method', 'unlock-method', '解锁方式', 'runtime'),
  field('message-content', 'autoTranscribe', 'auto-transcribe-voice', '语音自动转文字', 'runtime'),
  field('typing', 'mode', 'typing-status', '隐藏正在输入状态', 'runtime'),
  field('typing', 'selection', 'typing-status', '隐藏正在输入状态的会话选择', 'runtime', {
    scope: '当前账号',
  }),
  field('call-content', 'mode', 'call-mode', '录制内容', 'runtime'),
  field('call-content', 'systemAudio', 'call-system-audio', '电脑声音', 'runtime', {
    remoteUnsupported: true,
  }),
  field('call-directory', 'dir', 'call-directory', '通话录音目录', 'runtime', { directory: true }),
  field('call-trace', 'udpTrace', 'call-udp-trace', '记录 UDP 流量', 'runtime'),
  field('api-default', 'model', 'llm-default-model', '默认聊天模型', 'runtime'),
  field('api-default', 'vision-model', 'llm-default-vision-model', '默认视觉模型', 'runtime'),
  field('api-default', 'embedding-model', 'llm-default-embedding-model', '默认向量模型', 'runtime'),
  field('voice-online', 'concurrency', 'voice-online-concurrency', '转录并发', 'runtime'),
  field('ocr-online', 'concurrency', 'ocr-online-concurrency', '识别并发', 'runtime'),
  field('ocr-online', 'prefilter', 'ocr-prefilter-enabled', 'OCR 前先筛图', 'runtime'),
  field('auto-enter', 'account', 'auto-enter-account', '默认进入账号', 'runtime'),
  field('data-saver', 'temporary', 'data-saver', '临时省流量设置', 'runtime'),
  field('data-saver', 'preferences', 'data-saver', '省流量模式与行为', 'runtime'),
  field('rkey', 'enabled', 'external-rkey', '外部 RKEY 启用目标', 'runtime'),
  field('mcp', 'enabled', 'mcp-enabled', 'MCP 服务', 'runtime', { stopsService: true }),
  field('onebot', 'enabled', 'onebot-enabled', 'OneBot 服务', 'runtime', { stopsService: true }),
  field('onebot-servers', 'servers', 'onebot-servers', '网络服务器启用状态', 'runtime', {
    stopsService: true,
  }),
  field('sse-targets', 'enabled', 'sse-targets', 'SSE 推送', 'runtime', { stopsService: true }),
  field('sse-tuning', 'tuning', 'sse-tuning', 'SSE 推送调优', 'runtime'),
  field('assistant', 'enabled', 'assistant-service', 'QQ 公众号推送', 'runtime', {
    stopsService: true,
  }),
  field('web', 'enabled', 'web-enabled', '本机浏览器访问', 'runtime', {
    stopsService: true,
    desktopOnly: true,
  }),
  field('remote', 'enabled', 'remote-enabled', 'WeQ Remote', 'runtime', {
    stopsService: true,
    desktopOnly: true,
  }),
  field('update', 'interval', 'update-check-interval', '自动检查更新频率', 'runtime', {
    desktopOnly: true,
  }),
  field('update', 'prerelease', 'update-prerelease', '检查测试版', 'runtime', {
    desktopOnly: true,
  }),
  field('mail', 'unread', 'mail-unread-badge', '邮箱红点', 'runtime'),
  field('mail', 'notifications', 'mail-banner', '新邮件提醒', 'runtime'),
  field('mail', 'poll-interval', 'mail-poll-interval', '邮箱查询间隔', 'runtime'),
  field('recall-scope', 'scope', 'anti-recall', '防撤回启用范围', 'runtime'),
  field('recall-scope', 'targets', 'anti-recall', '防撤回会话选择', 'runtime', {
    scope: '当前账号',
  }),
  field('recall-scope', 'notify', 'anti-recall', '撤回通知', 'runtime'),
  field('recall-scope', 'notify-targets', 'anti-recall', '撤回通知会话选择', 'runtime', {
    scope: '当前账号',
  }),
  field('external-chatpic', 'enabled', 'external-chatpic', '外部安卓图片缓存', 'runtime'),
  field('external-chatpic', 'dir', 'external-chatpic', '外部安卓图片目录', 'runtime', {
    directory: true,
  }),
];

export const SETTINGS_FIELDS: readonly SettingField[] = [
  ...APP_SETTING_FIELDS,
  ...CLIENT_SETTING_FIELDS,
  ...INTENT_SETTING_FIELDS,
  ...RUNTIME_SETTING_FIELDS,
];
