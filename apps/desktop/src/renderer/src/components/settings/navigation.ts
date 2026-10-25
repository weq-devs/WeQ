// 这里只包含公开的目录与别名，不读取设置值、账号信息或凭据。
export const SETTINGS_PAGE_LABELS = {
  appearance: '主题与背景',
  home: '主页',
  global: '提醒与窗口',
  startup: '开机启动',
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
  'clone-settings': '好友克隆',
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
  'qq-storage': 'QQ 存储管理',
  remote: 'Web 与 Remote',
  mcp: 'MCP 服务器',
  sse: 'SSE 推送',
  applock: '应用锁',
  privacy: '隐私模式',
  backup: '备份与恢复',
  version: '版本与更新',
  faq: '常见问题',
  logs: '日志',
  feedback: '反馈',
} as const;

export type SettingsPageId = keyof typeof SETTINGS_PAGE_LABELS;
export type SectionId =
  | SettingsPageId
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
  | 'daemon'
  | 'assistant';

export const SETTINGS_GROUPS: Array<{ id: string; label: string; sections: SettingsPageId[] }> = [
  {
    id: 'general',
    label: '常规',
    sections: ['appearance', 'home', 'global', 'startup', 'weq-storage'],
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
      'clone-settings',
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
    sections: ['database-repair', 'database-tolerance', 'database-management', 'qq-storage'],
  },
  { id: 'services', label: 'WeQ 服务', sections: ['remote', 'mcp', 'sse'] },
  { id: 'privacy', label: '隐私', sections: ['applock', 'privacy'] },
  { id: 'backup', label: '设置备份', sections: ['backup'] },
  { id: 'help', label: '关于 WeQ', sections: ['version', 'faq', 'logs', 'feedback'] },
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
      'clone-settings',
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
  id: string;
  section: SettingsPageId;
  label: string;
  aliases?: readonly string[];
  from: readonly SectionId[];
}

const ITEM_REDIRECTS: readonly ItemRedirect[] = [
  ...(
    [
      ['home-tags', '个性标签'],
      ['home-greeting', '问候语'],
      ['home-hitokoto', '一言'],
      ['home-blocked-words', '一言屏蔽词'],
    ] as const
  ).map(([id, label]): ItemRedirect => ({ id, label, section: 'home', from: ['home'] })),
  {
    id: 'default-save',
    section: 'weq-storage',
    label: '默认保存目录',
    aliases: ['保存位置'],
    from: ['saving', 'weq-storage'],
  },
  { id: 'prefer-cdn', section: 'remote', label: '优先使用 CDN', from: ['storage', 'remote'] },
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
    label: '占用分析',
    aliases: ['存储占用'],
    from: ['maintenance', 'qq-storage'],
  },
  {
    id: 'qq-storage-cleanup',
    section: 'qq-storage',
    label: '缓存清理',
    aliases: ['清理缓存'],
    from: ['maintenance', 'qq-storage'],
  },
  {
    id: 'resource-viewer',
    section: 'qq-storage',
    label: '资源查看',
    aliases: ['本地缓存'],
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
  { id: 'builtin-components', section: 'version', label: '内置组件', from: ['daemon', 'version'] },
  {
    id: 'assistant-service',
    section: 'remote',
    label: '启用 WeQ 助手',
    aliases: ['QQ 公众号推送'],
    from: ['assistant', 'remote'],
  },
];

const SECTION_REDIRECTS: Partial<
  Record<SectionId, { section: SettingsPageId; settingId?: string }>
> = {
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
  'intent-models': { section: 'intent-sense' },
  tts: { section: 'agentlab' },
  help: { section: 'faq' },
  updates: { section: 'version' },
  daemon: { section: 'version', settingId: 'builtin-components' },
  assistant: { section: 'remote', settingId: 'assistant-service' },
};

/** 页面和条目共用一个解析器；解析只定位，不打开工具或执行操作。 */
export function resolveSettingsTarget(target: SettingsTarget): ResolvedSettingsTarget {
  const redirect = target.settingId
    ? ITEM_REDIRECTS.find((entry) => entry.id === target.settingId)
    : ITEM_REDIRECTS.find(
        (entry) =>
          entry.from.includes(target.section) &&
          (entry.label === target.item || entry.aliases?.includes(target.item ?? '')),
      );
  if (redirect) return { section: redirect.section, item: redirect.label, settingId: redirect.id };
  const sectionRedirect = SECTION_REDIRECTS[target.section];
  const section = sectionRedirect?.section ?? (target.section as SettingsPageId);
  const settingId = target.settingId ?? (!target.item ? sectionRedirect?.settingId : undefined);
  const defaultItem = ITEM_REDIRECTS.find((entry) => entry.id === settingId);
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
