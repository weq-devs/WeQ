import type { AppSettings } from '../../bootstrap/user_config';
import type { IntentSenseConfig } from '../../account/intent_sense';
import { INTENT_TUNING, type IntentTuningKey } from '../intent_context';
import {
  AGGREGATE_BADGE_SETTINGS,
  CONTACT_NAVIGATION_BADGE_SETTING,
  CONTACT_REQUEST_BADGE_SETTING,
  CONTACT_UNREAD_COUNT_LABEL,
  MENU_BADGE_SETTINGS,
  type PreferenceKey,
} from '../client_preferences';
import type { SettingsResetCardId } from './reset';
import { NOTIFICATION_LABELS, SCOPED_NOTIFICATION_EVENTS } from '../notification_settings';

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
    ['notification-events', 'notificationEvents', 'notification-events', '事件通知'],
    ['home', 'home', 'home-settings', '主页显示与屏蔽词'],
    ['contact-card', 'contactCard', 'contact-card-order', '名片显示与顺序'],
    ['startup-page', 'startupPage', 'startup-page', '启动时进入'],
    ['startup-system', 'showWindowOnAutostart', 'startup-show-window', '自启时显示窗口'],
    ['window', 'windowCloseBehavior', 'window-close-behavior', '关闭窗口时'],
    ['window-appearance', 'windowsStyleControls', 'windows-style-controls', '仿 Windows 窗口按钮'],
    ['app-lock', 'autoLockMinutes', 'auto-lock', '自动锁定分钟'],
    ['navigation-badges', 'showMessageUnreadBadge', 'message-unread-badge', '消息导航未读角标'],
    [
      'contact-badges',
      'showContactUnreadCount',
      'contact-unread-count',
      CONTACT_UNREAD_COUNT_LABEL,
    ],
    ['reading', 'readFromFirstUnread', 'read-first-unread', '打开会话时继续上次阅读'],
    ['reading', 'preserveUnreadUntilRead', 'preserve-unread-until-read', '按阅读进度更新未读数'],
    ['conversation-markers', 'showGroupAssistantMessageCount', 'group-assistant-count', '群助手'],
    [
      'message-browsing',
      'autoFollowLatestMessages',
      'auto-follow-latest-messages',
      '在底部时跟随新消息',
    ],
    ['message-browsing', 'jumpToLatestAfterSend', 'jump-latest-after-send', '发送后回到最新消息'],
    [
      'message-browsing',
      'showScrollToBottomButton',
      'scroll-to-bottom-button',
      '向下浏览时显示「回到最新」按钮',
    ],
    ['message-content', 'showMessageSeq', 'message-seq', '消息序号'],
    ['message-content', 'showMessageDate', 'message-date', '消息日期'],
    ['message-content', 'showMessageTime', 'message-time', '消息时间'],
    ['message-content', 'showAvatarPendant', 'avatar-pendant', '头像挂件'],
    ['message-content', 'showChatQqShow', 'chat-qqshow', 'QQ 秀头像'],
    ['qqshow-cache', 'qqShowCacheMinutes', 'chat-qqshow-days', 'QQ 秀缓存有效期'],
    ['message-content', 'showMsgDecoration', 'message-bubble', '消息装饰'],
    ['message-content', 'showMessageBubble', 'message-bubble', '消息气泡'],
    ['message-content', 'showMessageFont', 'message-font', '消息字体'],
    ['message-send-font', 'defaultMessageFont', 'default-message-font', '默认使用的字体'],
    ['message-content', 'renderTextMarkdown', 'text-markdown', 'Markdown 文本'],
    ['message-content', 'linkPreview', 'link-preview', '链接预览'],
    ['chat-memory', 'chatImageCacheMiB', 'chat-image-cache', '图片预览内存预算'],
    ['chat-memory', 'chatMessagePrewarmMiB', 'chat-message-prewarm', '完整消息预热内存预算'],
    ['call-connection', 'callDisableP2P', 'call-p2p', '禁用 P2P'],
    ['qzone-person', 'qzonePersonClickAction', 'qzone-person-click', '人物入口'],
    ['qzone-person', 'qzoneNamePriority', 'qzone-name-priority', '人物名称显示'],
    ['qzone-forward', 'qzoneForwardQuotePrevious', 'qzone-forward', '引用上一人文案'],
    ['qzone-pagination', 'qzonePagination', 'qzone-pagination', '在线翻页限速'],
    [
      'qzone-public-refresh',
      'qzonePublicRefreshCooldownMinutes',
      'qzone-public-refresh',
      '自动刷新冷却期',
    ],
    ['realtime', 'realtimeEnabled', 'realtime-enabled', '数据库监听'],
    ['attach', 'autoAttachQq', 'auto-full-mode', '启用 QQ 在线能力'],
    [
      'qq-status-reminders',
      'qqStatusIndicatorEnabled',
      'qq-status-indicator',
      '显示 QQ 功能状态提示',
    ],
    ['cdn', 'preferCdn', 'prefer-cdn', '优先 CDN'],
    ['cdn', 'preferRemoteCdn', 'prefer-remote-cdn', 'Remote 缺少资源时优先直取'],
    ['logs', 'logRetentionDays', 'log-retention', '应用日志保存时长'],
    ['logs', 'logCapacityMiB', 'log-capacity', '应用日志容量上限'],
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
    ['theme-mode', 'preference', 'theme-mode', '主题模式'],
    ['theme-accent', 'accent', 'theme-accent', '主题色'],
    ['theme-background', 'background', 'theme-background', '界面背景'],
    ['theme-components', 'componentStyle', 'component-style', '组件风格'],
    ['theme-components', 'density', 'interface-density', '界面密度'],
    ['theme-font', 'specialNumberFont', 'special-number-font', '数字字体'],
    ['privacy-mode', 'privacyMode', 'privacy-mode', '隐私模式'],
    ['privacy-mode', 'capturePrivacy', 'privacy-menu-capture', '截图临时隐私模式'],
    ['web-notifications', 'webNotifications', 'web-notifications', '网页通知'],
    [
      'chat-image-preview',
      'autoDownloadPreviewOriginal',
      'auto-download-preview-original',
      '预览时自动获取原图',
    ],
    [
      'conversation-order',
      'keepConversationPositionOnHover',
      'keep-conversation-position-on-hover',
      '鼠标停留时保持会话位置',
    ],
    [
      'conversation-order',
      'closeConversationOutsideView',
      'close-conversation-outside-view',
      '切换视图时关闭不在新视图中的会话',
    ],
    ['unread-jumps', 'showUnreadDivider', 'unread-divider', '显示未读分界线'],
    [
      'unread-jumps',
      'mergeChatJumpButtons',
      'merge-chat-jump-buttons',
      '合并首条未读和重要消息入口',
    ],
    ['unread-jumps', 'firstUnreadJumpMode', 'first-unread-jump-mode', '首条未读入口'],
    ['unread-jumps', 'importantJumpMode', 'important-jump-mode', '重要消息入口'],
    ['reading', 'readingPositionJumpMode', 'show-reading-position-button', '继续上次阅读按钮'],
    ['unread-jumps', 'combinedChatJumpMode', 'combined-chat-jump-mode', '合并入口'],
    ['quote-replies', 'swipeToQuote', 'swipe-to-quote', '左滑引用消息'],
    ['message-content', 'groupConsecutiveMessages', 'group-consecutive-messages', '合并连续发言'],
    ['message-content', 'showGroupMemberName', 'group-message-name', '显示群消息发送者名称'],
    ['message-content', 'showGroupMemberLevel', 'group-message-level', '显示群成员等级'],
    ['message-content', 'showGroupMemberTitle', 'group-message-title', '显示群成员头衔与身份'],
    ['quote-replies', 'autoMentionOnQuote', 'quote-auto-mention', '群聊引用时自动 @ 对方'],
    ['quote-replies', 'backspaceRemovesQuote', 'quote-backspace-remove', '按退格键移除引用'],
    ['emoji-shortcuts', 'slashEmojiEnabled', 'slash-emoji-input', '斜杠表情快捷输入'],
    ['emoji-shortcuts', 'slashEmojiAutoReplace', 'slash-emoji-auto-replace', '无需回车即自动替换'],
    ['application-badge', 'applicationBadge', 'application-unread-badge', '应用图标未读角标'],
    ['navigation-badges', ...CONTACT_NAVIGATION_BADGE_SETTING],
    ['contact-badges', ...CONTACT_REQUEST_BADGE_SETTING],
    ...MENU_BADGE_SETTINGS.map(([key, id, label]) => ['menu-badges', key, id, label] as const),
    [
      'conversation-markers',
      'showInteractionBadge',
      'conversation-interaction-badge',
      '会话互动红点',
    ],
    ...AGGREGATE_BADGE_SETTINGS.filter(([, key]) => key !== 'showGroupAssistantMessageCount').map(
      ([, key, id, label]) => ['conversation-markers', key, id, label] as const,
    ),
    [
      'conversation-preview',
      'showConversationPreview',
      'show-conversation-preview',
      '显示会话预览',
    ],
    [
      'conversation-preview',
      'showImportantMessageMarkers',
      'important-message-markers',
      '重要消息标记',
    ],
    [
      'missing-messages',
      'autoFetchMissingMessages',
      'auto-fetch-missing-messages',
      '看到缺口时自动补全',
    ],
    [
      'missing-messages',
      'autoFetchMissingContext',
      'auto-fetch-missing-context',
      '跳转到缺失消息时补全附近记录',
    ],
    [
      'missing-messages',
      'missingMessageContextCount',
      'missing-message-context-count',
      '补全附近消息的条数',
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
    'suggestionApiTimeoutSeconds',
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
  loadingAnimation: ['intent-loading-animation', '自动分析时显示胶囊动画'],
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
    'autoUpdatePacks',
    'enhancement-management',
    '各增强包的自动更新',
    'runtime',
  ),
  field('toast', 'successSeconds', 'toast-success', '成功通知停留时长', 'runtime'),
  field('toast', 'failureSeconds', 'toast-failure', '失败通知停留时长', 'runtime'),
  field('toast', 'messageSeconds', 'toast-message', '消息通知停留时长', 'runtime'),
  field(
    'qq-status-reminders',
    'runtime',
    'qq-online-notification',
    '在线能力受限时通知',
    'runtime',
  ),
  field('qq-client-sync', 'proxy', 'qq-proxy-connection', 'QQ 代理', 'runtime', {
    scope: '此设备',
    stopsService: true,
  }),
  field('qq-client-sync', 'enabled', 'qq-client-sync', '自动同步本人消息与已读', 'runtime', {
    scope: '当前账号',
  }),
  field('qq-client-sync', 'live', 'qq-live-messages', '通过 QQ 代理加速实时更新', 'runtime', {
    scope: '当前账号',
  }),
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
  field('api-default', 'context-window', 'llm-default-context-window', '默认上下文窗口', 'runtime'),
  field('api-default', 'max-output', 'llm-default-max-output', '默认最大输出', 'runtime'),
  field('assistant-config', 'config', 'weq-assistant-default-model', '助手生成与执行', 'runtime'),
  field('assistant-images', 'mode', 'ai-images-assistant', '图片处理偏好', 'runtime'),
  field('intent-basic', 'imageMode', 'ai-images-intent', '图片处理偏好', 'runtime'),
  field('intent-basic', 'localResource', 'intent-model-resources', '本地意图模型资源', 'runtime'),
  field('suggestion-basic', 'imageMode', 'ai-images-suggestions', '图片处理偏好', 'runtime'),
  field('profile-basic', 'imageMode', 'ai-images-profile', '图片处理偏好', 'runtime'),
  field('performance-recording', 'mode', 'performance-monitor', '性能记录档位', 'runtime'),
  field('logs', 'nativeDebug', 'native-debug-log', '原生调试日志', 'runtime', { scope: '此设备' }),
  field('voice-online', 'concurrency', 'voice-online-concurrency', '转录并发', 'runtime'),
  field('ocr-online', 'concurrency', 'ocr-online-concurrency', '识别并发', 'runtime'),
  field('ocr-online', 'prefilter', 'ocr-prefilter-enabled', 'OCR 前先筛图', 'runtime'),
  field(
    'ocr-online',
    'autoDownloadOriginal',
    'ocr-auto-download-original',
    'OCR 时自动获取原图',
    'runtime',
  ),
  field('auto-enter', 'account', 'auto-enter-account', '默认进入账号', 'runtime'),
  field('data-saver', 'temporary', 'data-saver', '临时省流量设置', 'runtime'),
  field('data-saver', 'preferences', 'data-saver', '省流量模式与行为', 'runtime'),
  field('rkey', 'enabled', 'external-rkey', '外部 RKEY 启用目标', 'runtime'),
  field('mcp', 'enabled', 'mcp-enabled', 'MCP 服务', 'runtime', { stopsService: true }),
  // OneBot 配置按账号存，重置的是当前账号那一份（见 settings_reset）。
  field('onebot', 'config', 'onebot-config', 'OneBot 网络连接', 'runtime', {
    scope: '当前账号',
    stopsService: true,
  }),
  field('sse-targets', 'enabled', 'sse-targets', 'SSE 推送', 'runtime', { stopsService: true }),
  field('sse-tuning', 'tuning', 'sse-tuning', 'SSE 推送调优', 'runtime'),
  field('assistant', 'enabled', 'assistant-service', '公众号本地推送', 'runtime', {
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
  field('remote', 'tailscale', 'remote-tailscale', 'Tailscale 网络连接', 'runtime', {
    stopsService: true,
    desktopOnly: true,
  }),
  field('update', 'interval', 'update-check-interval', '自动检查更新频率', 'runtime', {
    desktopOnly: true,
  }),
  field('update', 'prerelease', 'update-prerelease', '检查测试版', 'runtime', {
    desktopOnly: true,
  }),
  field('navigation-badges', 'unread', 'mail-unread-badge', '邮箱导航未读角标', 'runtime'),
  field('mail', 'unread', 'mail-unread-badge', '邮箱导航未读角标', 'runtime'),
  field('mail', 'poll-interval', 'mail-poll-interval', '邮箱查询间隔', 'runtime'),
  ...SCOPED_NOTIFICATION_EVENTS.map((event) =>
    field(
      'notification-scopes',
      event,
      `notification-${event}`,
      `${NOTIFICATION_LABELS[event]}提醒会话`,
      'runtime',
      {
        scope: '当前账号',
      },
    ),
  ),
  field('recall-scope', 'method', 'anti-recall', '防撤回方式', 'runtime'),
  field('recall-scope', 'scope', 'anti-recall', '防撤回保护范围', 'runtime'),
  field('recall-scope', 'targets', 'anti-recall', '防撤回会话选择', 'runtime', {
    scope: '当前账号',
  }),
  field(
    'recall-notifications',
    'notify-targets',
    'recall-notifications',
    '撤回通知会话选择',
    'runtime',
    { scope: '当前账号' },
  ),
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
