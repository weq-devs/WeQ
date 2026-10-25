export type SectionId =
  | 'global'
  | 'startup'
  | 'saving'
  | 'appearance'
  | 'message-display'
  | 'applock'
  | 'accounts'
  | 'account'
  | 'anti-recall'
  | 'call-recording'
  | 'qzone'
  | 'mail'
  | 'storage'
  | 'backup'
  | 'media'
  | 'database'
  | 'database-status'
  | 'maintenance'
  | 'agentlab'
  | 'intent-sense'
  | 'intent-models'
  | 'local-models'
  | 'reply-suggestions'
  | 'clone-settings'
  | 'interaction-profile'
  | 'voice'
  | 'tts'
  | 'ocr'
  | 'model-usage'
  | 'mcp'
  | 'remote'
  | 'rkey'
  | 'sse'
  | 'daemon'
  | 'credentials'
  | 'diagnostics'
  | 'help'
  | 'faq'
  | 'feedback'
  | 'logs'
  | 'version'
  | 'updates';

export const SETTINGS_GROUPS: Array<{ id: string; label: string; sections: SectionId[] }> = [
  { id: 'general', label: '常规', sections: ['global', 'startup', 'saving'] },
  { id: 'appearance', label: '个性显示', sections: ['appearance', 'message-display'] },
  { id: 'privacy', label: '隐私与安全', sections: ['applock'] },
  {
    id: 'account',
    label: '账号与消息',
    sections: ['accounts', 'account', 'anti-recall', 'call-recording'],
  },
  { id: 'space-mail', label: '空间与邮箱', sections: ['qzone', 'mail'] },
  {
    id: 'storage',
    label: '存储与媒体',
    sections: ['storage', 'media'],
  },
  { id: 'backup', label: '备份与恢复', sections: ['backup'] },
  {
    id: 'data',
    label: '数据维护',
    sections: ['database', 'database-status', 'maintenance'],
  },
  {
    id: 'models',
    label: '模型与识别',
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
  { id: 'services', label: '服务与集成', sections: ['remote', 'mcp', 'sse', 'rkey', 'daemon'] },
  { id: 'advanced', label: '高级与诊断', sections: ['credentials', 'diagnostics'] },
  { id: 'help', label: '帮助与关于', sections: ['version', 'faq', 'logs', 'feedback'] },
];

export interface SettingsScope {
  label: string;
  detail?: string;
}

export function settingsScopeFor(section: SectionId): SettingsScope | null {
  // 通话录音存在全局 AppSettings 里（不随账号切换），所以**不**打「当前账号」标。
  if (
    [
      'anti-recall',
      'intent-sense',
      'reply-suggestions',
      'clone-settings',
      'interaction-profile',
      'model-usage',
      'mail',
    ].includes(section)
  )
    return { label: '当前账号' };
  if (section === 'database')
    return {
      label: '账号与全局',
      detail: '容错级别与降级记录仅影响当前账号；损坏提醒为全局设置。',
    };
  return null;
}

/** 旧分区 ID 继续有效，故障弹窗、维护返回与外部入口无需猜测新位置。 */
export function settingsSectionFor(section: SectionId): SectionId {
  if (section === 'local-models') return 'voice';
  if (section === 'intent-models') return 'intent-sense';
  if (section === 'tts') return 'agentlab';
  if (section === 'help') return 'faq';
  if (section === 'updates') return 'version';
  return section;
}

export function settingsGroupFor(section: SectionId) {
  return (
    SETTINGS_GROUPS.find((group) => group.sections.includes(settingsSectionFor(section))) ??
    SETTINGS_GROUPS[0]!
  );
}
