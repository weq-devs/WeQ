// 这里只包含公开的目录与别名，不读取设置值、账号信息或凭据。
import { AI_SETTING_ITEMS } from './aiSettingsCatalog';
export const SETTINGS_PAGE_LABELS = {
  appearance: '主题与背景',
  home: '主页',
  global: '提醒与窗口',
  startup: '启动',
  'weq-storage': 'WeQ 存储管理',
  'chat-messages': '聊天消息',
  'call-recording': '通话录音',
  qzone: 'QQ 空间',
  mail: 'QQ 邮箱',
  agentlab: 'API 配置',
  'model-usage': 'API 用量',
  'intent-sense': '意图感知',
  'interaction-profile': '互动画像',
  'reply-suggestions': '推荐回复',
  voice: '语音识别',
  ocr: '图片识别',
  account: '监听与读取',
  credentials: '凭据管理',
  accounts: 'WeQ 账号管理',
  'qq-accounts': 'QQ 账号管理',
  diagnostics: '诊断工具',
  'database-repair': '损坏与修复',
  'database-tolerance': '数据库宽容',
  'database-management': '数据库管理',
  'qq-storage': '资源目录管理',
  'resource-loading': '资源加载',
  remote: 'Web 与 Remote',
  mcp: 'MCP 服务器',
  sse: 'SSE 推送',
  assistant: 'QQ 公众号推送',
  privacy: '隐私',
  backup: '配置备份与恢复',
  version: '版本与更新',
  faq: '常见问题',
  logs: '日志',
  feedback: '反馈',
} as const;

export type SettingsPageId = keyof typeof SETTINGS_PAGE_LABELS;
export type SectionId =
  | SettingsPageId
  | 'applock'
  | 'saving'
  | 'storage'
  | 'message-display'
  | 'anti-recall'
  | 'media'
  | 'rkey'
  | 'database'
  | 'database-status'
  | 'maintenance'
  | 'local-models'
  | 'intent-models'
  | 'tts'
  | 'help'
  | 'updates'
  | 'daemon';

export const SETTINGS_GROUPS: Array<{ id: string; label: string; sections: SettingsPageId[] }> = [
  {
    id: 'general',
    label: '常规',
    sections: ['startup', 'home', 'appearance', 'global', 'weq-storage', 'privacy'],
  },
  {
    id: 'basic',
    label: '基础功能',
    sections: ['chat-messages', 'call-recording', 'qzone', 'mail'],
  },
  {
    id: 'models',
    label: 'AI 功能',
    sections: [
      'agentlab',
      'model-usage',
      'intent-sense',
      'interaction-profile',
      'reply-suggestions',
      'voice',
      'ocr',
    ],
  },
  {
    id: 'account',
    label: '凭据与账号',
    sections: ['account', 'credentials', 'accounts', 'qq-accounts', 'diagnostics'],
  },
  {
    id: 'data',
    label: '数据库与资源',
    sections: [
      'database-repair',
      'database-tolerance',
      'database-management',
      'qq-storage',
      'resource-loading',
    ],
  },
  { id: 'services', label: 'WeQ 服务', sections: ['remote', 'mcp', 'sse', 'assistant'] },
  { id: 'help', label: '关于 WeQ', sections: ['version', 'backup', 'faq', 'logs', 'feedback'] },
];

export interface SettingsScope {
  label: string;
  detail?: string;
}

export function settingsScopeFor(section: SectionId): SettingsScope | null {
  if (
    [
      'anti-recall',
      'intent-sense',
      'reply-suggestions',
      'interaction-profile',
      'model-usage',
      'mail',
      'database-tolerance',
    ].includes(section)
  )
    return { label: '当前账号' };
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
  ...AI_SETTING_ITEMS.map(
    (item): ItemRedirect => ({
      ...item,
      from: [...new Set<SectionId>([item.section, 'intent-sense'])],
      aliasesFrom: [item.section],
    }),
  ),
  { id: 'llm-providers', section: 'agentlab', label: '已保存的 provider', from: ['agentlab'] },
  { id: 'llm-default-model', section: 'agentlab', label: '默认模型', from: ['agentlab'] },
  { id: 'tts-providers', section: 'agentlab', label: 'TTS 语音合成', from: ['agentlab', 'tts'] },
  ...(
    [
      ['home-tags', '个性标签'],
      ['home-greeting', '问候语'],
      ['home-hitokoto', '一言'],
      ['home-blocked-words', '一言屏蔽词'],
    ] as const
  ).map(([id, label]): ItemRedirect => ({ id, label, section: 'home', from: ['home'] })),
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
    aliases: ['WeQ 存储管理'],
    from: ['storage', 'weq-storage'],
  },
  { id: 'qzone-pagination', section: 'qzone', label: '在线翻页限速', from: ['qzone'] },
  { id: 'qzone-person-click', section: 'qzone', label: '点击他人昵称或头像时', from: ['qzone'] },
  {
    id: 'mail-unread-badge',
    section: 'mail',
    label: '在邮箱图标上显示红点',
    aliases: ['显示未读邮件数'],
    from: ['mail'],
  },
  {
    id: 'mail-banner',
    section: 'mail',
    label: '收到新邮件时横幅提醒',
    aliases: ['新邮件提醒'],
    from: ['mail'],
  },
  {
    id: 'startup-page',
    section: 'startup',
    label: '启动时进入',
    aliases: ['上次退出时所在页面'],
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
    id: 'auto-full-mode',
    section: 'account',
    label: '自动启用完整功能',
    aliases: ['自动读取 QQ 内存（完整功能）'],
    from: ['account'],
  },
  {
    id: 'long-term-authorization',
    section: 'account',
    label: '长期授权',
    aliases: ['权限助手', '免重复提权', '管理员授权'],
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
      ['message-unread-badge', '在消息图标上显示红点', '显示消息汇总红点'],
      ['contact-unread-count', '在联系人界面显示未读消息数'],
      ['group-assistant-count', '群助手显示总消息数'],
      ['read-first-unread', '从第一条新消息开始阅读'],
      ['auto-follow-latest-messages', '自动跟随最新消息'],
      ['jump-latest-after-send', '发送消息后定位到最新消息'],
      ['scroll-to-bottom-button', '向下滚动时显示定位到底部按钮', '快速到底部'],
      ['send-with-qq-font', '使用 QQ 账号设置的个性字体发送消息'],
      ['custom-message-display', '自定义消息显示'],
      ['message-seq', '显示消息序号（seq）'],
      ['message-time', '显示发送时间（精确到秒）'],
      ['avatar-pendant', '聊天头像挂件'],
      [
        'message-bubble',
        '消息气泡',
        '消息装扮（气泡/字体/挂件）',
        '消息装扮',
        'message-decoration',
      ],
      ['message-font', '消息字体', '聊天字体'],
      ['text-markdown', '纯文本消息渲染 Markdown'],
      ['link-preview', '链接预览卡片'],
      ['link-screenshot', '无封面时网页截图'],
    ] as const
  ).map(
    ([id, label, ...aliases]): ItemRedirect => ({
      id,
      label,
      aliases,
      section: 'chat-messages',
      from: ['message-display', 'chat-messages'],
    }),
  ),
  {
    id: 'intent-model-resources',
    section: 'intent-sense',
    label: '意图模型资源（全局）',
    aliases: ['意图模型资源', '使用下载镜像', 'hf-mirror.com 镜像'],
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
    id: 'default-save',
    section: 'weq-storage',
    label: '默认保存目录',
    aliases: ['保存位置'],
    from: ['saving', 'weq-storage'],
  },
  {
    id: 'prefer-cdn',
    section: 'resource-loading',
    label: '优先使用 CDN',
    from: ['storage', 'remote', 'resource-loading'],
  },
  {
    id: 'typing-status',
    section: 'chat-messages',
    label: '向对方展示输入状态',
    aliases: ['默认发送正在输入状态', '发送正在输入状态'],
    from: ['global', 'chat-messages'],
  },
  {
    id: 'read-sync',
    section: 'chat-messages',
    label: '同步已读状态到 QQ',
    aliases: ['手动标记时上报已读位置', '手动标记已读'],
    from: ['account', 'chat-messages'],
  },
  {
    id: 'restricted-mode-banner',
    section: 'account',
    label: '进入受限模式时横幅提醒',
    from: ['account'],
  },
  {
    id: 'anti-recall',
    section: 'chat-messages',
    label: '防撤回',
    from: ['anti-recall', 'chat-messages'],
  },
  {
    id: 'linked-resources',
    section: 'accounts',
    label: '关联资源目录',
    aliases: ['关联本机媒体目录'],
    from: ['media', 'accounts'],
  },
  {
    id: 'external-chatpic',
    section: 'accounts',
    label: '外部安卓图片缓存',
    aliases: ['允许使用外部安卓图片缓存'],
    from: ['media', 'accounts'],
  },
  {
    id: 'external-rkey',
    section: 'credentials',
    label: '外部 rKey',
    aliases: ['外部 RKEY'],
    from: ['rkey', 'credentials'],
  },
  {
    id: 'damage-reminder',
    section: 'database-repair',
    label: '损坏提醒',
    aliases: ['数据库异常时弹窗提醒'],
    from: ['database', 'database-repair'],
  },
  {
    id: 'tolerance-records',
    section: 'database-tolerance',
    label: '容错记录',
    aliases: ['降级账本', '已放弃的表（隔离中）'],
    from: ['database-status', 'database-tolerance'],
  },
  {
    id: 'database-repair',
    section: 'database-repair',
    label: '数据库修复',
    from: ['maintenance', 'database-repair'],
  },
  {
    id: 'database-manager',
    section: 'database-management',
    label: '数据库管理',
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
    id: 'assistant-service',
    section: 'assistant',
    label: '启用 QQ 公众号推送',
    aliases: ['启用 WeQ 助手', 'QQ 公众号推送'],
    from: ['assistant', 'remote'],
  },
];

const SECTION_REDIRECTS: Partial<
  Record<SectionId, { section: SettingsPageId; settingId?: string }>
> = {
  applock: { section: 'privacy', settingId: 'app-lock' },
  saving: { section: 'weq-storage', settingId: 'default-save' },
  storage: { section: 'weq-storage' },
  'message-display': { section: 'chat-messages' },
  'anti-recall': { section: 'chat-messages', settingId: 'anti-recall' },
  media: { section: 'accounts', settingId: 'linked-resources' },
  rkey: { section: 'credentials', settingId: 'external-rkey' },
  database: { section: 'database-tolerance' },
  'database-status': { section: 'database-tolerance', settingId: 'tolerance-records' },
  maintenance: { section: 'database-management' },
  'local-models': { section: 'voice' },
  'intent-models': { section: 'intent-sense', settingId: 'intent-model-resources' },
  tts: { section: 'agentlab', settingId: 'tts-providers' },
  help: { section: 'faq' },
  updates: { section: 'version' },
  daemon: { section: 'version', settingId: 'builtin-components' },
};

/** 页面和条目共用一个解析器；解析只定位，不打开工具或执行操作。 */
export function resolveSettingsTarget(target: SettingsTarget): ResolvedSettingsTarget {
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
