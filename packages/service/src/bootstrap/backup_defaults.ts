import { DEFAULT_APP_SETTINGS, type UserConfig } from './user_config';

export const WEQ_DEFAULTS_PATHS = [
  'tencentFilesRootOverride',
  'cacheDirOverride',
  'dbRepairCacheDir',
  'defaultExportDir',
  'externalChatpic',
  'callRecording',
] as const;
export type WeqDefaultsPath = (typeof WEQ_DEFAULTS_PATHS)[number];
export const WEQ_DEFAULTS_CONNECTIONS = [
  'systemAutostart',
  'showWindowOnAutostart',
  'webServiceAutoStart',
  'webEnabled',
  'remoteEnabled',
  'remoteMode',
  'tailscaleEnabled',
  'weqAssistant',
] as const;
export type WeqDefaultsConnection = (typeof WEQ_DEFAULTS_CONNECTIONS)[number];
export interface WeqDefaultsChoice {
  clearApi?: boolean;
  resetPaths?: WeqDefaultsPath[];
  resetConnections?: WeqDefaultsConnection[];
}
export const WEQ_DEFAULTS_PATH_LABELS: Record<WeqDefaultsPath, string> = {
  tencentFilesRootOverride: 'QQ 数据根目录',
  cacheDirOverride: '缓存目录',
  dbRepairCacheDir: '修复临时目录',
  defaultExportDir: '默认导出目录',
  externalChatpic: '外部聊天图片目录',
  callRecording: '通话录音目录',
};

export function weqDefaultsPaths(config: UserConfig) {
  return WEQ_DEFAULTS_PATHS.flatMap((id) => {
    const value =
      id === 'externalChatpic' || id === 'callRecording'
        ? config.settings?.[id]?.dir
        : id === 'defaultExportDir'
          ? config.settings?.defaultExportDir
          : config[id];
    return typeof value === 'string' && value.trim()
      ? [{ id, label: WEQ_DEFAULTS_PATH_LABELS[id], value }]
      : [];
  });
}

/** 恢复默认是替换，不使用备份导入的递归合并；身份与数据字段原样保留。 */
export function weqDefaultsConfig(current: UserConfig, choice: WeqDefaultsChoice): UserConfig {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  const previous = current.settings;
  if (!choice.clearApi) {
    for (const id of ['agentLab', 'mcp', 'oneBot', 'externalRkey', 'ssePush'] as const)
      if (previous?.[id] !== undefined)
        Object.assign(settings, { [id]: structuredClone(previous[id]) });
    settings.voiceTranscribe.ttsProviders = structuredClone(
      previous?.voiceTranscribe?.ttsProviders ?? [],
    ) as typeof settings.voiceTranscribe.ttsProviders;
  }
  for (const id of ['showWindowOnAutostart', 'webServiceAutoStart', 'weqAssistant'] as const)
    if (!choice.resetConnections?.includes(id) && previous?.[id] !== undefined)
      Object.assign(settings, { [id]: structuredClone(previous[id]) });
  const result: UserConfig = {
    ...current,
    settings,
    autoEnter: null,
    skipAutoEnterOnce: false,
    exportPresets: {},
  };
  for (const id of WEQ_DEFAULTS_PATHS) {
    const reset = choice.resetPaths?.includes(id);
    if (id === 'externalChatpic' || id === 'callRecording') {
      if (!reset && previous?.[id]?.dir !== undefined) settings[id].dir = previous[id].dir!;
    } else if (id === 'defaultExportDir') {
      if (!reset) settings.defaultExportDir = previous?.defaultExportDir ?? null;
    } else if (reset) result[id] = null;
  }
  return result;
}
