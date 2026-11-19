// 这里只包含公开的目录与别名，不读取设置值、账号信息或凭据。
import { AI_SETTING_ITEMS } from './ai';
import { CONTACT_CARD_FIELDS, CONTACT_GROUP_FIELDS } from '../contact_card';
import { NOTIFICATION_EVENTS, NOTIFICATION_LABELS } from '../notification_settings';
import {
  AGGREGATE_BADGE_SETTINGS,
  CONTACT_UNREAD_COUNT_LABEL,
  ENTRY_BADGE_SETTINGS,
} from '../client_preferences';
export const SETTINGS_PAGE_LABELS = {
  'contact-card': '联系人名片',
  appearance: '外观与布局',
  global: '通知与提醒',
  startup: '启动与退出',
  'weq-storage': 'WeQ 存储管理',
  'chat-messages': '会话列表',
  'message-display': '消息阅读',
  'chat-interaction': '互动与防撤回',
  'call-recording': '通话与录音',
  qzone: 'QQ 空间',
  mail: 'QQ 邮箱',
  agentlab: 'API 配置',
  'model-usage': 'API 用量',
  'intent-sense': '意图感知',
  'interaction-profile': '互动画像',
  'weq-assistant': 'WeQ 助手',
  'reply-suggestions': '推荐回复',
  'enhancement-packs': '增强包',
  recognition: '识别与转写',
  account: '在线能力与授权',
  credentials: '凭据管理',
  accounts: 'WeQ 账号管理',
  diagnostics: 'QQ 高级工具',
  'database-management': 'QQ 数据库管理',
  'qq-storage': 'QQ 资源管理',
  'resource-loading': '资源加载',
  remote: 'Web 与 Remote',
  mcp: 'MCP 服务器',
  onebot: 'OneBot / cc-connect',
  sse: 'SSE 推送',
  assistant: 'QQ 公众号推送',
  privacy: '隐私',
  backup: '配置备份与恢复',
  version: '版本与更新',
  faq: '常见问题',
  logs: '日志与性能',
  feedback: '反馈',
} as const;

export type SettingsPageId = keyof typeof SETTINGS_PAGE_LABELS;
export type SectionId =
  | SettingsPageId
  | 'performance-monitor'
  | 'anti-recall'
  | 'home'
  | 'applock'
  | 'saving'
  | 'storage'
  | 'rkey'
  | 'media'
  | 'qq-accounts'
  | 'database'
  | 'database-status'
  | 'database-repair'
  | 'database-tolerance'
  | 'maintenance'
  | 'local-models'
  | 'intent-models'
  | 'voice'
  | 'ocr'
  | 'tts'
  | 'help'
  | 'updates'
  | 'daemon';

export const SETTINGS_GROUPS: Array<{ id: string; label: string; sections: SettingsPageId[] }> = [
  {
    id: 'general',
    label: '常规',
    sections: ['startup', 'account', 'appearance', 'global', 'privacy'],
  },
  {
    id: 'basic',
    label: '基础功能',
    sections: [
      'chat-messages',
      'message-display',
      'chat-interaction',
      'contact-card',
      'call-recording',
      'qzone',
      'mail',
    ],
  },
  {
    id: 'models',
    label: '增强功能',
    sections: [
      'enhancement-packs',
      'recognition',
      'agentlab',
      'model-usage',
      'reply-suggestions',
      'intent-sense',
      'interaction-profile',
      'weq-assistant',
    ],
  },
  {
    id: 'data',
    label: '凭据与数据',
    sections: [
      'credentials',
      'resource-loading',
      'qq-storage',
      'database-management',
      'diagnostics',
    ],
  },
  {
    id: 'services',
    label: 'WeQ 服务',
    sections: ['remote', 'mcp', 'onebot', 'sse', 'assistant'],
  },
  {
    id: 'help',
    label: '关于 WeQ',
    sections: ['version', 'weq-storage', 'accounts', 'backup', 'logs', 'faq', 'feedback'],
  },
];

export interface SettingsScope {
  label: string;
  detail?: string;
}

export function settingsScopeFor(section: SectionId): SettingsScope | null {
  if (section === 'model-usage') return { label: '当前账号' };
  // 混合作用域的页面在具体分区标注，不用页头把全局项误标为当前账号。
  return null;
}

export interface SettingsTarget {
  section: SectionId;
  item?: string;
  settingId?: string;
}
export interface ResolvedSettingsTarget extends SettingsTarget {
  section: SettingsPageId;
}

/** 旧聊天设置条目按稳定身份归位，页面导航与搜索使用同一份目录。 */
function chatMessagePageFor(settingId: string): SettingsPageId {
  if (
    [
      'typing-status',
      'send-with-qq-font',
      'quote-auto-mention',
      'quote-backspace-remove',
      'slash-emoji-input',
      'slash-emoji-auto-replace',
    ].includes(settingId)
  )
    return 'chat-interaction';
  if (
    [
      'custom-message-display',
      'message-seq',
      'message-date',
      'message-time',
      'group-message-name',
      'group-message-level',
      'group-message-title',
      'avatar-pendant',
      'message-bubble',
      'message-font',
      'chat-qqshow',
      'chat-qqshow-days',
      'text-markdown',
      'link-preview',
      'link-preview-auto-fetch',
      'link-screenshot',
      'auto-transcribe-voice',
      'chat-image-cache',
      'read-first-unread',
      'auto-fetch-missing-messages',
      'auto-fetch-missing-context',
      'missing-message-context-count',
      'auto-follow-latest-messages',
      'jump-latest-after-send',
      'scroll-to-bottom-button',
    ].includes(settingId)
  )
    return 'message-display';
  return 'chat-messages';
}

interface ItemRedirect {
  readonly id: string;
  readonly section: SettingsPageId;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly from: readonly SectionId[];
  readonly aliasesFrom?: readonly SectionId[];
  readonly desktopOnly?: boolean;
}

export const SETTINGS_ITEM_TARGETS: readonly ItemRedirect[] = [
  { id: 'notification-events', section: 'global', label: '事件通知', from: ['global'] },
  ...NOTIFICATION_EVENTS.filter(
    (event) => !['directMessage', 'mail', 'recall', 'runtime', 'databaseDamage'].includes(event),
  ).map(
    (event): ItemRedirect => ({
      id: `notification-${event}`,
      section: 'global',
      label: NOTIFICATION_LABELS[event],
      from: ['global'],
    }),
  ),
  ...(
    [
      ...ENTRY_BADGE_SETTINGS.map(([, id, label]) => [id, label] as const),
      ...AGGREGATE_BADGE_SETTINGS.filter(([, key]) => key !== 'showGroupAssistantMessageCount').map(
        ([, , id, label]) => [id, label] as const,
      ),
    ] as const
  ).map(
    ([id, label]): ItemRedirect => ({
      id,
      section: 'global',
      label,
      from: ['global', 'mail', 'chat-messages', 'agentlab', 'version'],
    }),
  ),
  {
    id: 'show-conversation-preview',
    section: 'chat-messages',
    label: '显示会话预览',
    aliases: ['消息摘要', '草稿预览'],
    from: ['chat-messages'],
  },
  {
    id: 'important-message-markers',
    section: 'chat-messages',
    label: '重要消息标记',
    aliases: ['@我', '@全体成员', '回复我', '特别关心', '群提醒词', '新文件', '红包', '群公告'],
    from: ['chat-messages'],
  },
  ...(
    [
      ['toast-success', 'global', '成功通知停留时长'],
      ['toast-failure', 'global', '失败通知停留时长'],
      ['toast-message', 'global', '消息通知停留时长'],
      ['startup-show-window', 'startup', '自启时显示窗口'],
      ['call-mode', 'call-recording', '录音来源'],
      ['call-system-audio', 'call-recording', '同时录电脑声音'],
      ['call-directory', 'call-recording', '保存位置'],
      ['call-udp-trace', 'call-recording', '记录 UDP 流量'],
      ['theme-mode', 'appearance', '基础模式'],
      ['theme-accent', 'appearance', '主题色'],
      ['theme-background', 'appearance', '界面背景'],
      ['auto-enter-account', 'accounts', '现有配置'],
      ['backup-export', 'backup', '导出备份'],
      ['backup-import', 'backup', '导入备份'],
      ['ocr-online', 'recognition', 'QQ 在线 OCR'],
      ['mcp-enabled', 'mcp', '启用 MCP 服务器'],
      ['mcp-port', 'mcp', 'MCP 端口'],
      ['sse-tuning', 'sse', '推送调优'],
      ['database-key', 'credentials', '数据库密钥'],
      ['session-key', 'credentials', '会话密钥'],
      ['download-rkey', 'credentials', '下载 rKey'],
      ['client-key', 'credentials', 'ClientKey'],
      ['protocol-reverse', 'diagnostics', 'Protobuf / JCE 逆向'],
      ['contact-card-order', 'contact-card', '名片显示与顺序'],
      ['onebot-enabled', 'onebot', '总开关'],
      ['onebot-servers', 'onebot', '网络服务器'],
      ['contact-card-all', 'contact-card', '全部字段'],
      ['contact-card-group-fields', 'contact-card', '群内资料'],
      ['enhancement-updates', 'enhancement-packs', '增强包自动更新'],
      ['enhancement-management', 'enhancement-packs', '增强包管理'],
      ['signer-status', 'credentials', '签名器（wrapper.node）'],
    ] as const
  ).map(
    ([id, section, label]): ItemRedirect => ({
      id,
      section,
      label,
      from: section === 'recognition' ? [section, 'ocr'] : [section],
    }),
  ),
  ...(
    [
      ['enhancement-auto-check', '自动检查增强包更新', ['增强包更新检查']],
      ['enhancement-auto-install', '自动安装增强包更新', ['增强包自动安装']],
      ['enhancement-text', '本地文字识别', ['识别模型', '筛图模型', '图片识别模型', 'OCR 模型']],
      ['enhancement-voice', '本地语音转写', ['本地语音模型', 'SenseVoice', 'ASR']],
      ['enhancement-intent', '本地意图与画像', ['Laya 模型下载', '画像模型下载']],
      ['enhancement-dress', '装扮离线索引', ['气泡索引', '字体索引', '挂件索引']],
    ] as const
  ).map(
    ([id, label, aliases]): ItemRedirect => ({
      id,
      label,
      aliases,
      section: 'enhancement-packs',
      from: ['enhancement-packs', 'voice', 'ocr', 'local-models', 'intent-models'],
    }),
  ),
  ...(
    [
      ['ocr-online-concurrency', '识别并发'],
      ['voice-online-concurrency', '转录并发'],
    ] as const
  ).map(
    ([id, label]): ItemRedirect => ({
      id,
      label,
      section: 'recognition',
      from: ['recognition', 'voice', 'ocr'],
    }),
  ),
  ...[...CONTACT_CARD_FIELDS, ...CONTACT_GROUP_FIELDS].map(
    ([key, label]): ItemRedirect => ({
      id: `contact-card-${key}`,
      section: 'contact-card',
      label,
      from: ['contact-card'],
    }),
  ),
  {
    id: 'performance-monitor',
    section: 'logs',
    label: '性能监视',
    aliases: ['性能记录', 'CPU', '内存历史'],
    from: ['diagnostics', 'performance-monitor', 'logs'],
  },
  { id: 'log-retention', section: 'logs', label: '日志保留时长', from: ['logs'] },
  {
    id: 'realtime-enabled',
    section: 'database-management',
    label: '启用数据库监听',
    aliases: ['自动刷新消息'],
    from: ['account', 'database-management'],
  },
  {
    id: 'database-read-concurrency',
    section: 'database-management',
    label: '数据库读取并发上限',
    aliases: ['连接池', '并行读取', '查询排队', '读取性能'],
    from: ['logs', 'database-management', 'account'],
  },
  {
    id: 'database-listening',
    section: 'database-management',
    label: '监听与读取',
    aliases: ['接入与监听', '实时监听'],
    from: ['account', 'database-management'],
  },
  { id: 'log-folder', section: 'logs', label: '日志文件夹', from: ['logs'], desktopOnly: true },
  {
    id: 'native-debug-log',
    section: 'logs',
    label: '原生调试日志',
    aliases: ['底层调试', '调试模式'],
    from: ['logs'],
  },
  { id: 'component-style', section: 'appearance', label: '组件风格', from: ['appearance'] },
  { id: 'interface-density', section: 'appearance', label: '界面密度', from: ['appearance'] },
  {
    id: 'windows-style-controls',
    section: 'appearance',
    label: '使用仿 Windows 窗口按钮',
    aliases: ['窗口按钮', '红绿灯', '原生窗口'],
    from: ['global', 'appearance'],
    desktopOnly: true,
  },
  {
    id: 'window-close-behavior',
    section: 'startup',
    label: '关闭窗口时',
    aliases: ['关闭按钮行为', '关闭按钮', '最小化到托盘', '退出时停止'],
    from: ['global', 'startup'],
    desktopOnly: true,
  },
  ...AI_SETTING_ITEMS.map(
    (item): ItemRedirect => ({
      ...item,
      from: [...new Set<SectionId>([item.section, 'intent-sense'])],
      aliasesFrom: [item.section],
    }),
  ),
  ...(
    [
      ['model-settings', '助手模型设置'],
      ['default-model', '助手默认聊天模型'],
      ['default-effort', '助手默认思考强度'],
      ['permission', '运行模式'],
      ['customPrompt', '额外提示词'],
      ['mcpServers', '外部 MCP 服务器'],
      ['send-mode', '运行中默认发送方式'],
    ] as const
  ).map(
    ([id, label]): ItemRedirect => ({
      id: `weq-assistant-${id}`,
      label,
      section: 'weq-assistant',
      from: ['weq-assistant'],
    }),
  ),
  {
    id: 'ai-images-assistant',
    label: '图片处理偏好',
    section: 'weq-assistant',
    from: ['weq-assistant'],
  },
  {
    id: 'ocr-prefilter-enabled',
    section: 'recognition',
    label: 'OCR 前先筛图',
    aliases: ['筛图开关', '自动 OCR 筛图'],
    from: ['ocr', 'recognition'],
  },
  {
    id: 'llm-providers',
    section: 'agentlab',
    label: '已保存的服务商',
    aliases: ['已保存的 provider'],
    from: ['agentlab'],
  },
  { id: 'llm-default-model', section: 'agentlab', label: '默认聊天模型', from: ['agentlab'] },
  {
    id: 'llm-default-context-window',
    section: 'agentlab',
    label: '默认上下文窗口',
    aliases: ['上下文预算', '上下文长度'],
    from: ['agentlab'],
  },
  {
    id: 'llm-default-max-output',
    section: 'agentlab',
    label: '默认最大输出',
    aliases: ['输出上限', '最大输出 Token'],
    from: ['agentlab'],
  },
  {
    id: 'llm-default-vision-model',
    section: 'agentlab',
    label: '默认视觉模型',
    aliases: ['图片分析模型'],
    from: ['agentlab'],
  },
  {
    id: 'llm-default-embedding-model',
    section: 'agentlab',
    label: '默认向量模型',
    aliases: ['嵌入模型', 'Embedding 模型'],
    from: ['agentlab'],
  },
  {
    id: 'ai-images-intent',
    section: 'intent-sense',
    label: '图片处理偏好',
    aliases: ['意图感知图片', '意图 OCR'],
    from: ['intent-sense'],
  },
  {
    id: 'ai-images-suggestions',
    section: 'reply-suggestions',
    label: '图片处理偏好',
    aliases: ['推荐回复图片', '推荐回复 OCR'],
    from: ['reply-suggestions'],
  },
  {
    id: 'ai-images-profile',
    section: 'interaction-profile',
    label: '图片处理偏好',
    aliases: ['互动画像图片', '画像 OCR'],
    from: ['interaction-profile'],
  },
  { id: 'tts-providers', section: 'agentlab', label: 'TTS 语音合成', from: ['agentlab', 'tts'] },
  {
    id: 'home-settings',
    section: 'startup',
    label: '主页',
    aliases: ['主页显示'],
    from: ['home', 'startup'],
  },
  ...(
    [
      ['home-tags', '个性标签'],
      ['home-prefer-qqshow', '优先展示 QQ 秀'],
      ['home-greeting', '问候语'],
      ['home-hitokoto', '一言'],
      ['home-blocked-words', '一言屏蔽词'],
    ] as const
  ).map(
    ([id, label]): ItemRedirect => ({ id, label, section: 'startup', from: ['home', 'startup'] }),
  ),
  {
    id: 'qqnt-capture',
    section: 'diagnostics',
    label: 'QQNT 抓包',
    aliases: ['ntqq 抓包'],
    from: ['diagnostics'],
  },
  {
    id: 'weq-space-cleanup',
    section: 'weq-storage',
    label: '空间清理',
    aliases: ['WeQ 存储管理', '桌面运行数据', '桌面缓存'],
    from: ['storage', 'weq-storage', 'backup'],
  },
  {
    id: 'weq-config-management',
    section: 'backup',
    label: '恢复全局默认设置',
    aliases: [
      '恢复默认设置',
      '全局恢复默认设置',
      '重置与清除配置',
      '配置与运行数据管理',
      '账号与应用配置',
      '全局配置',
      '清除账号与应用配置',
      '重置全局配置',
    ],
    from: ['startup', 'storage', 'weq-storage', 'backup'],
  },
  { id: 'qzone-pagination', section: 'qzone', label: '在线翻页限速', from: ['qzone'] },
  {
    id: 'qzone-public-refresh',
    section: 'qzone',
    label: '空友爱看自动刷新冷却期',
    from: ['qzone'],
  },
  {
    id: 'qzone-person-click',
    section: 'qzone',
    label: '点击他人昵称或头像时',
    aliases: ['人物入口'],
    from: ['qzone'],
  },
  {
    id: 'qzone-forward',
    section: 'qzone',
    label: '转发时引用上一人文案',
    aliases: ['转发', '引用转发文案'],
    from: ['qzone'],
  },
  ...(
    [
      ['call-p2p', 'call-recording', '禁用 P2P 直连', '连接方式', '通话中转'],
      ['qzone-blocked', 'qzone', '不让 ta 看我的空间', '空间黑名单'],
      ['qzone-hidden', 'qzone', '不看 ta 的空间', '屏蔽好友空间'],
      ['totp-authenticator', 'privacy', 'WeQ 验证器', '绑定验证器', 'TOTP'],
      ['mcp-connection', 'mcp', '连接信息', 'MCP 客户端配置', '复制客户端配置', 'MCP 令牌'],
      ['mcp-install', 'mcp', '安装到本机 AI 客户端', '安装 MCP', 'MCP 自动配置'],
      ['sse-targets', 'sse', '已配置的推送目标', '推送地址', 'SSE access_token', '添加推送目标'],
      ['assistant-resource', 'assistant', '资源服务', '公众号资源地址'],
      ['assistant-port', 'assistant', 'QQ 公众号推送端口', '公众号端口'],
      ['chat-image-cache', 'message-display', '图片预览内存预算', '图片与表情', '内存缓存'],
    ] as const
  ).map(
    ([id, section, label, ...aliases]): ItemRedirect => ({
      id,
      section,
      label,
      aliases,
      from: id === 'chat-image-cache' ? ['chat-messages', section] : [section],
    }),
  ),
  ...(
    [
      ['web-enabled', '允许本机浏览器访问', '启用 Web 服务'],
      ['web-autostart', '启动 WeQ 时自动允许本机浏览器访问', '启动 WeQ 时自动开启 Web 服务'],
      ['remote-enabled', '允许远程连接', 'WeQ Remote', '远程访问'],
      ['remote-lan', '局域网 IP', '局域网地址'],
      ['remote-tailscale', 'Tailscale IP', 'Tailscale', '跨网络连接', '内网穿透'],
      ['remote-pairing', '配对手机', '设备配对', '手机配对', '配对二维码'],
      ['remote-devices', '已配对设备', '设备授权', '撤销设备授权'],
    ] as const
  ).map(
    ([id, label, ...aliases]): ItemRedirect => ({
      id,
      section: 'remote',
      label,
      aliases,
      from: ['remote'],
      desktopOnly: true,
    }),
  ),
  {
    id: 'mail-poll-interval',
    section: 'mail',
    label: '邮件查询间隔',
    aliases: ['邮件查询间隔（分钟）', '邮箱同步频率', '邮件轮询', '自动收信'],
    from: ['mail'],
  },
  {
    id: 'mail-unread-badge',
    section: 'global',
    label: '邮箱导航未读角标',
    aliases: ['显示未读邮件数', '在邮箱图标上显示红点', '邮箱红点'],
    from: ['mail', 'global'],
  },
  {
    id: 'mail-banner',
    section: 'global',
    label: '新邮件',
    aliases: ['新邮件提醒', '收到新邮件时横幅提醒', '邮件通知设置'],
    from: ['mail', 'global'],
  },
  {
    id: 'startup-page',
    section: 'startup',
    label: '启动时进入',
    aliases: ['上次退出时所在页面', '启动后打开'],
    from: ['startup'],
  },
  {
    id: 'startup-enabled',
    section: 'startup',
    label: '开机自动启动',
    aliases: ['开机自动启动 WeQ'],
    from: ['startup'],
  },
  {
    id: 'full-features',
    section: 'account',
    label: 'QQ 在线能力',
    aliases: ['功能差异', '在线能力受限', '在线能力', '漫游消息', '发送消息'],
    from: ['account'],
  },
  {
    id: 'full-feature-routes',
    section: 'account',
    label: '启用方式',
    aliases: ['原版 QQ', '读取路线', 'QQ 在线能力启用'],
    from: ['account'],
  },
  {
    id: 'auto-full-mode',
    section: 'account',
    label: '自动启用 QQ 在线能力',
    aliases: ['自动读取 QQ 内存'],
    from: ['account'],
  },
  {
    id: 'restricted-mode-indicator',
    section: 'account',
    label: '在线能力受限时在窗口右上角显示',
    aliases: ['在线能力受限标记', '标题栏在线能力受限', '受限状态显示'],
    from: ['account'],
  },
  {
    id: 'read-sync',
    section: 'account',
    label: '向 QQ 服务器上报已读位置',
    aliases: ['已读同步', '已读上报', '同步 QQ 未读'],
    from: ['account', 'chat-messages'],
  },
  {
    id: 'qq-debug-copy',
    section: 'account',
    label: 'QQ 调试副本',
    aliases: ['SIP', '不关闭 SIP', '副本更新', '调试读取'],
    from: ['account'],
    desktopOnly: true,
  },
  {
    id: 'long-term-authorization',
    section: 'account',
    label: '长期授权',
    aliases: ['权限助手', '本机权限助手', '免重复提权', '管理员授权'],
    from: ['account'],
    desktopOnly: true,
  },
  {
    id: 'app-lock',
    section: 'privacy',
    label: '启用应用锁',
    aliases: ['应用锁'],
    from: ['applock', 'privacy'],
  },
  {
    id: 'unlock-method',
    section: 'privacy',
    label: '解锁方式',
    from: ['applock', 'privacy'],
  },
  {
    id: 'auto-lock',
    section: 'privacy',
    label: '空闲自动锁定',
    aliases: ['无操作自动上锁'],
    from: ['applock', 'privacy'],
  },
  ...(
    [
      ['message-system-notifications', '普通私聊消息', '新消息系统通知', '消息弹窗提醒'],
      ['application-unread-badge', '应用图标未读角标', 'Dock 任务栏 Badge'],
    ] as const
  ).map(
    ([id, label, ...aliases]): ItemRedirect => ({
      id,
      label,
      aliases,
      section: 'global',
      from: ['global', 'message-display', 'chat-messages', 'chat-interaction'],
    }),
  ),
  ...(
    [
      ['message-unread-badge', '消息导航未读角标', '消息图标红点', '显示消息汇总红点'],
      [
        'contact-unread-count',
        CONTACT_UNREAD_COUNT_LABEL,
        '好友与群聊',
        '联系人列表未读消息数',
        '在联系人界面显示未读消息数',
      ],
      ['group-assistant-count', '群助手', '群助手未读汇总角标', '群助手显示总消息数'],
      ['all-conversations-include-hidden', '包含已隐藏会话', '全部会话隐藏范围'],
      ['all-conversations-include-deleted', '包含已删除会话', '全部会话删除范围'],
      ['read-first-unread', '从第一条新消息开始阅读'],
      ['auto-fetch-missing-messages', '查看时自动拉取缺失的消息', '自动补全消息', '漫游消息'],
      ['auto-fetch-missing-context', '定位到缺失消息时自动拉取上下文'],
      ['missing-message-context-count', '自动拉取上下文条数'],
      ['keep-conversation-position-on-hover', '鼠标停留时保持会话位置', '会话排序', '悬停排序'],
      [
        'close-conversation-outside-view',
        '切换视图时关闭不在新视图中的会话',
        '切换会话视图',
        '保留当前会话',
      ],
      ['auto-follow-latest-messages', '自动跟随最新消息'],
      ['jump-latest-after-send', '发送消息后定位到最新消息'],
      ['scroll-to-bottom-button', '向下滚动时显示定位到底部按钮', '快速到底部'],
      ['send-with-qq-font', '使用 QQ 账号设置的个性字体发送消息'],
      ['quote-auto-mention', '群聊引用时自动 @ 对方', '引用自动提及'],
      ['slash-emoji-input', '斜杠表情快捷输入', '系统表情快捷搜索'],
      ['slash-emoji-auto-replace', '无需回车即自动替换', '表情自动替换'],
      ['quote-backspace-remove', '按退格键移除引用', '退格取消引用', 'Backspace'],
      ['auto-transcribe-voice', '语音消息自动转文字', '语音自动识别'],
      ['custom-message-display', '内容显示', '自定义消息显示'],
      ['message-seq', '显示消息序号（seq）'],
      ['message-date', '显示发送日期'],
      ['message-time', '显示发送时间', '显示发送时间（精确到秒）'],
      [
        'group-message-name',
        '昵称或备注',
        '显示群消息发送者名称',
        '显示群成员昵称',
        '群消息发送者',
      ],
      ['group-message-level', '显示群成员等级'],
      ['group-message-title', '显示群成员头衔与身份', '群主', '管理员'],
      ['avatar-pendant', '聊天头像挂件'],
      ['chat-qqshow', '优先使用 QQ 秀替换头像', '聊天 QQ 秀替换头像', 'QQ 秀'],
      [
        'message-bubble',
        '消息气泡',
        '消息装扮（气泡/字体/挂件）',
        '消息装扮',
        'message-decoration',
      ],
      ['message-font', '消息字体', '聊天字体'],
      ['text-markdown', '文本消息自动渲染为 Markdown', '纯文本消息自动渲染为 Markdown'],
      ['link-preview', '链接预览卡片'],
      ['link-preview-auto-fetch', '自动联网补全链接预览'],
      ['link-screenshot', '无封面时网页截图'],
    ] as const
  ).map(
    ([id, label, ...aliases]): ItemRedirect => ({
      id,
      label,
      aliases,
      section:
        id === 'message-unread-badge' ||
        id === 'contact-unread-count' ||
        id === 'group-assistant-count'
          ? 'global'
          : chatMessagePageFor(id),
      from: ['message-display', 'chat-messages', 'chat-interaction', 'global'],
    }),
  ),
  {
    id: 'chat-qqshow-days',
    section: 'resource-loading',
    label: 'QQ 秀缓存有效期',
    from: ['message-display', 'chat-messages', 'resource-loading'],
  },
  {
    id: 'intent-model-resources',
    section: 'intent-sense',
    label: '意图模型资源',
    aliases: ['意图模型资源（全局）', '使用下载镜像', 'hf-mirror.com 镜像'],
    from: ['intent-models', 'intent-sense'],
  },
  ...(
    [
      ['intent-persistent-display', '常驻显示'],
      ['intent-hover-display', '悬停显示'],
    ] as const
  ).map(
    ([id, label]): ItemRedirect => ({
      id,
      label,
      section: 'intent-sense',
      from: ['intent-sense', 'reply-suggestions'],
    }),
  ),
  {
    id: 'prefer-cdn',
    section: 'resource-loading',
    label: '优先直连 QQ 加载图片',
    aliases: ['优先使用 CDN'],
    from: ['storage', 'remote', 'resource-loading'],
  },
  {
    id: 'data-saver',
    section: 'resource-loading',
    label: '省流量模式',
    aliases: ['低数据模式', '计费网络', '节省流量'],
    from: ['resource-loading'],
  },
  {
    id: 'typing-status',
    section: 'chat-interaction',
    label: '隐藏正在输入状态',
    aliases: ['向对方展示输入状态', '默认发送正在输入状态', '发送正在输入状态', '输入状态'],
    from: ['global', 'chat-messages', 'chat-interaction'],
  },
  {
    id: 'restricted-mode-banner',
    section: 'global',
    label: '功能受限或运行异常',
    aliases: ['在线能力受限时通知', '在线能力受限时横幅提醒'],
    from: ['account', 'global'],
  },
  {
    id: 'anti-recall',
    section: 'chat-interaction',
    label: '防撤回',
    from: ['anti-recall', 'chat-messages', 'chat-interaction'],
  },
  {
    id: 'external-chatpic',
    section: 'resource-loading',
    label: '外部安卓图片缓存',
    aliases: ['允许使用外部安卓图片缓存'],
    from: ['media', 'accounts', 'resource-loading'],
  },
  {
    id: 'qq-accounts',
    section: 'diagnostics',
    label: '登录记录与设备标识',
    aliases: ['QQ 登录记录管理', 'QQ 账号管理', '设备 GUID', '登录记录'],
    from: ['qq-accounts', 'diagnostics'],
    desktopOnly: true,
  },
  {
    id: 'external-rkey',
    section: 'credentials',
    label: '外部 rKey 服务器',
    aliases: ['外部 rKey', '外部 RKEY', '已导入的服务器', 'HTTP 服务器地址', 'rKey access_token'],
    from: ['rkey', 'credentials'],
  },
  {
    id: 'damage-reminder',
    section: 'global',
    label: '数据库异常提醒',
    aliases: ['数据库异常时弹窗提醒', '损坏提醒', 'notification-databaseDamage'],
    from: ['database', 'database-repair', 'database-management', 'global'],
  },
  {
    id: 'notification-badges',
    section: 'global',
    label: '未读角标',
    aliases: ['红点与未读标记'],
    from: ['global', 'chat-messages'],
  },
  {
    id: 'recall-notifications',
    section: 'global',
    label: '撤回提醒',
    aliases: ['撤回时通知我', '通知会话', '撤回提醒设置'],
    from: ['anti-recall', 'chat-interaction', 'global'],
  },
  {
    id: 'web-notifications',
    section: 'global',
    label: '浏览器通知授权',
    aliases: ['网页通知', '撤回、群关键词与邮件提醒'],
    from: ['privacy', 'global'],
  },
  {
    id: 'database-repair',
    section: 'database-management',
    label: '数据库检查与修复',
    aliases: ['数据库修复', '损坏与修复', '数据库容错'],
    from: [
      'maintenance',
      'database-repair',
      'database-management',
      'database',
      'database-tolerance',
      'database-status',
    ],
  },
  {
    id: 'database-manager',
    section: 'database-management',
    label: '数据库浏览',
    aliases: ['数据库管理'],
    from: ['maintenance', 'database-management'],
  },
  {
    id: 'database-export',
    section: 'database-management',
    label: '导出明文数据库',
    from: ['maintenance', 'database-management'],
  },
  {
    id: 'qq-storage-analysis',
    section: 'qq-storage',
    label: '占用概览',
    aliases: ['占用分析', '存储占用'],
    from: ['maintenance', 'qq-storage'],
  },
  {
    id: 'qq-storage-cleanup',
    section: 'qq-storage',
    label: '资源清理',
    aliases: ['缓存清理', '清理缓存'],
    from: ['maintenance', 'qq-storage'],
  },
  {
    id: 'resource-viewer',
    section: 'qq-storage',
    label: '资源浏览',
    aliases: ['资源查看', '本地缓存'],
    from: ['maintenance', 'qq-storage'],
  },
  {
    id: 'key-scan',
    section: 'credentials',
    label: '密钥扫描',
    from: ['maintenance', 'credentials'],
  },
  {
    id: 'other-device-key',
    section: 'credentials',
    label: '其他设备密钥',
    aliases: ['其它设备密钥'],
    from: ['maintenance', 'credentials'],
  },
  { id: 'privacy-mode', section: 'privacy', label: '隐私模式', from: ['applock', 'privacy'] },
  {
    id: 'privacy-menu-capture',
    section: 'privacy',
    label: '在菜单中截图瞬间临时启用隐私模式',
    from: ['applock', 'privacy'],
    desktopOnly: true,
  },
  { id: 'builtin-components', section: 'version', label: '内置组件', from: ['daemon', 'version'] },
  {
    id: 'update-check-interval',
    section: 'version',
    label: '自动检查更新频率',
    aliases: ['更新间隔', '更新分钟', '永不检查更新'],
    from: ['version'],
    desktopOnly: true,
  },
  {
    id: 'update-prerelease',
    section: 'version',
    label: '检查测试版',
    aliases: ['测试版更新', 'Beta 更新'],
    from: ['version'],
    desktopOnly: true,
  },
  {
    id: 'assistant-service',
    section: 'assistant',
    label: '启用 QQ 公众号推送',
    aliases: ['启用 WeQ 助手', 'QQ 公众号推送', '推送与资源服务'],
    from: ['assistant', 'remote'],
  },
];

const SECTION_REDIRECTS: Partial<
  Record<SectionId, { section: SettingsPageId; settingId?: string }>
> = {
  applock: { section: 'privacy', settingId: 'app-lock' },
  'performance-monitor': { section: 'logs', settingId: 'performance-monitor' },
  home: { section: 'startup', settingId: 'home-settings' },
  saving: { section: 'global' },
  storage: { section: 'weq-storage' },
  'anti-recall': { section: 'chat-interaction', settingId: 'anti-recall' },
  media: { section: 'resource-loading' },
  'qq-accounts': { section: 'diagnostics', settingId: 'qq-accounts' },
  rkey: { section: 'credentials', settingId: 'external-rkey' },
  database: { section: 'database-management', settingId: 'database-repair' },
  'database-tolerance': { section: 'database-management', settingId: 'database-repair' },
  'database-repair': { section: 'database-management', settingId: 'database-repair' },
  'database-status': { section: 'database-management', settingId: 'database-repair' },
  maintenance: { section: 'database-management' },
  'local-models': { section: 'enhancement-packs' },
  'intent-models': { section: 'enhancement-packs', settingId: 'enhancement-intent' },
  voice: { section: 'recognition' },
  ocr: { section: 'recognition' },
  tts: { section: 'agentlab', settingId: 'tts-providers' },
  help: { section: 'faq' },
  updates: { section: 'version' },
  daemon: { section: 'version', settingId: 'builtin-components' },
};

/** 页面和条目共用一个解析器；解析只定位，不打开工具或执行操作。 */
export function resolveSettingsTarget(target: SettingsTarget): ResolvedSettingsTarget {
  // 已移除的资源关联入口只回到资源加载页，不留下失效定位或操作入口。
  if (
    target.settingId === 'linked-resources' ||
    (['media', 'accounts'].includes(target.section) &&
      ['关联资源目录', '关联本机媒体目录'].includes(target.item ?? ''))
  )
    return { section: 'resource-loading' };
  const targetId = target.settingId === 'message-decoration' ? 'message-bubble' : target.settingId;
  const redirect = targetId
    ? SETTINGS_ITEM_TARGETS.find((entry) => entry.id === targetId)
    : SETTINGS_ITEM_TARGETS.find(
        (entry) =>
          entry.from.includes(target.section) &&
          (entry.label === target.item ||
            ((entry.aliasesFrom ?? entry.from).includes(target.section) &&
              entry.aliases?.includes(target.item ?? ''))),
      );
  if (redirect) return { section: redirect.section, item: redirect.label, settingId: redirect.id };
  const sectionRedirect = SECTION_REDIRECTS[target.section];
  const section = sectionRedirect?.section ?? (target.section as SettingsPageId);
  const settingId = target.settingId ?? (!target.item ? sectionRedirect?.settingId : undefined);
  const defaultItem = SETTINGS_ITEM_TARGETS.find((entry) => entry.id === settingId);
  return {
    section,
    ...(target.item || defaultItem ? { item: target.item ?? defaultItem?.label } : {}),
    ...(settingId ? { settingId } : {}),
  };
}

export function settingsSectionFor(section: SectionId): SettingsPageId {
  return resolveSettingsTarget({ section }).section;
}

export function settingsGroupFor(section: SectionId) {
  return (
    SETTINGS_GROUPS.find((group) => group.sections.includes(settingsSectionFor(section))) ??
    SETTINGS_GROUPS[0]!
  );
}
