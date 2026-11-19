import { DEFAULT_APP_SETTINGS, type UserConfig } from './user_config';
import { normalizeDressConfig } from '../account/dress_config';
import { mergeAssistantConfig } from '../account/assistant';
import {
  globalSettingsDefaults,
  WEQ_DEFAULTS_PATHS,
  WEQ_DEFAULTS_PATH_LABELS,
  type WeqDefaultsChoice,
} from '../common/settings_catalog/global';
export {
  WEQ_DEFAULTS_PATHS,
  WEQ_DEFAULTS_PATH_LABELS,
  WEQ_DEFAULTS_CONNECTIONS,
  type WeqDefaultsPath,
  type WeqDefaultsConnection,
  type WeqDefaultsChoice,
} from '../common/settings_catalog/global';

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
  const settings = globalSettingsDefaults(current.settings, DEFAULT_APP_SETTINGS, choice);
  const previous = current.settings;
  settings.sharedPreferences.assistant = mergeAssistantConfig(
    {},
    {
      mcpServers: choice.clearApi ? undefined : previous?.sharedPreferences?.assistant?.mcpServers,
    },
  );
  settings.sharedPreferences.dress = normalizeDressConfig({
    ...previous?.sharedPreferences?.dress,
    localAppearanceVersion: 1,
    activeBubble: 0,
    activeFont: 0,
    activeWidget: 0,
    scope: 'mine',
    background: 'none',
    backgroundFile: '',
    widgetId: '',
    backgroundOpacity: 1,
  });
  if (!choice.clearApi) {
    settings.voiceTranscribe.ttsProviders = structuredClone(
      previous?.voiceTranscribe?.ttsProviders ?? [],
    ) as typeof settings.voiceTranscribe.ttsProviders;
  }
  const settingsRevision = Math.max(Date.now(), (current.settingsRevision ?? 0) + 1);
  const result: UserConfig = {
    ...current,
    settings,
    settingsRevision,
    performanceRecordingResetRevision: settingsRevision,
    globalClientPreferencesMigrated: true,
    desktopPreferencesSeeded: true,
    sharedPreferencesMigration: current.sharedPreferencesMigration ?? {
      version: 1,
      configId: null,
    },
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
