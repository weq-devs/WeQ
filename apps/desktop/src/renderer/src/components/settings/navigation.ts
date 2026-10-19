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
  | 'qzone'
  | 'mail'
  | 'storage'
  | 'media'
  | 'database'
  | 'database-status'
  | 'maintenance'
  | 'agentlab'
  | 'intent-sense'
  | 'voice'
  | 'tts'
  | 'ocr'
  | 'model-usage'
  | 'mcp'
  | 'rkey'
  | 'sse'
  | 'daemon'
  | 'credentials'
  | 'diagnostics'
  | 'help'
  | 'logs'
  | 'version'
  | 'updates';

export const SETTINGS_GROUPS: Array<{ id: string; label: string; sections: SectionId[] }> = [
  { id: 'general', label: '常规', sections: ['global', 'startup', 'saving'] },
  { id: 'appearance', label: '个性显示', sections: ['appearance', 'message-display'] },
  { id: 'privacy', label: '隐私与安全', sections: ['applock'] },
  { id: 'account', label: '账号与消息', sections: ['accounts', 'account', 'anti-recall'] },
  { id: 'space-mail', label: '空间与邮箱', sections: ['qzone', 'mail'] },
  {
    id: 'data',
    label: '数据与存储',
    sections: ['storage', 'media', 'database', 'database-status', 'maintenance'],
  },
  {
    id: 'models',
    label: '模型与识别',
    sections: ['agentlab', 'intent-sense', 'voice', 'tts', 'ocr', 'model-usage'],
  },
  { id: 'services', label: '服务与集成', sections: ['mcp', 'sse', 'rkey', 'daemon'] },
  { id: 'advanced', label: '高级与诊断', sections: ['credentials', 'diagnostics'] },
  { id: 'help', label: '帮助与关于', sections: ['help', 'logs', 'version', 'updates'] },
];

export interface SettingsScope {
  label: string;
  detail?: string;
}

export function settingsScopeFor(section: SectionId): SettingsScope | null {
  if (['anti-recall', 'intent-sense', 'model-usage', 'mail'].includes(section))
    return { label: '当前账号' };
  if (section === 'database')
    return {
      label: '账号与全局',
      detail: '容错级别与降级记录仅影响当前账号；损坏提醒为全局设置。',
    };
  return null;
}

/** 旧分区 ID 继续有效，故障弹窗、维护返回与外部入口无需猜测新位置。 */
export function settingsGroupFor(section: SectionId) {
  return SETTINGS_GROUPS.find((group) => group.sections.includes(section)) ?? SETTINGS_GROUPS[0]!;
}
