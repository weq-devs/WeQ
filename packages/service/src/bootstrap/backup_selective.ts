import {
  WEQ_BACKUP_SECTIONS,
  type WeqBackupSection,
  type WeqSelectiveBackup,
} from '../common/backup_sections';
import { preferenceDefaults } from '../common/client_preferences';
import type { AccountConfig } from '../account/user_config';
import { APP_SETTINGS_RESET_POLICY } from '../common/settings_catalog/global';
import { isWeqBackupConfigId } from './backup_bundle';
import {
  snapshotWeqApiSettings,
  snapshotWeqSettings,
  validateWeqAccountSettings,
  validateWeqAppSettings,
} from './backup_settings';
import { DEFAULT_APP_SETTINGS, type AppSettings, type UserConfig } from './user_config';

const APPEARANCE_FIELDS = ['contactCard', 'home'] as const;
const APPEARANCE_PREFERENCES = [
  'preference',
  'accent',
  'background',
  'componentStyle',
  'density',
  'specialNumberFont',
] as const;
const DEVICE_FIELDS = [
  'windowsStyleControls',
  'windowCloseBehavior',
  'startupPage',
  'showWindowOnAutostart',
  'autoAttachQq',
  'realtimeEnabled',
  'databaseReadConcurrency',
  'chatImageCacheMiB',
  'chatMessagePrewarmMiB',
  'autoLockMinutes',
  'appLock',
  'callDisableP2P',
  'logRetentionDays',
] as const;
const DEVICE_PATHS = ['defaultExportDir', 'exportSaveMode'] as const;
export const BACKUP_HOST_PATHS = [
  'tencentFilesRootOverride',
  'cacheDirOverride',
  'dbRepairCacheDir',
] as const;
const SERVICE_FIELDS = ['webServiceAutoStart', 'weqAssistant'] as const;
const ACCOUNT_FIELDS = ['groupKeyword', 'qqClientSync'] as const;
const DATABASE_FIELDS = [
  'dbKey',
  'algos',
  'uid',
  'lastLoginAt',
  'static',
  'mobile',
  'displayName',
] as const;
const SOURCE_PATHS = ['dataDir', 'backupAccountDir', 'nativeMediaDir'] as const;

export function backupPick<T extends object, K extends keyof T>(source: T, keys: readonly K[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  ) as Pick<T, K>;
}
const omit = <T extends object>(source: T, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));

export function validateSelectiveSelection(selection: WeqSelectiveBackup) {
  const { sections } = selection;
  if (
    !sections.length ||
    new Set(sections).size !== sections.length ||
    sections.some((section) => !WEQ_BACKUP_SECTIONS.includes(section))
  )
    throw new Error('请选择要备份的内容');
  for (const [needed, ids] of [
    [sections.includes('account'), selection.accountConfigIds],
    [sections.includes('database'), selection.databaseConfigIds],
    [sections.includes('drafts'), selection.draftConfigIds],
    [sections.includes('assistant') || sections.includes('clones'), selection.cloneConfigIds],
  ] as const)
    if (
      needed &&
      (!ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !isWeqBackupConfigId(id)))
    )
      throw new Error('请选择有效的账号与数据来源');
}

export function snapshotSelectiveSettings(settings: AppSettings, selection: WeqSelectiveBackup) {
  const { sections } = selection;
  const app = snapshotWeqSettings(settings);
  const api = snapshotWeqApiSettings(settings);
  const shared = app.sharedPreferences;
  const client = shared.client ?? {};
  const out: Record<string, unknown> = {};
  const outShared: Record<string, unknown> = {};
  const outApi: Record<string, unknown> = {};
  const assistant: Record<string, unknown> = {};
  if (sections.includes('appearance')) {
    Object.assign(out, backupPick(app, APPEARANCE_FIELDS));
    Object.assign(outShared, { dress: shared.dress });
    Object.assign(outShared, {
      client: {
        ...backupPick(preferenceDefaults, APPEARANCE_PREFERENCES),
        ...backupPick(client, APPEARANCE_PREFERENCES),
        ...backupPick(settings.sharedPreferences.client ?? {}, APPEARANCE_PREFERENCES),
      },
    });
  }
  if (sections.includes('preferences')) {
    const handled = [
      ...APPEARANCE_FIELDS,
      ...DEVICE_FIELDS,
      ...DEVICE_PATHS,
      ...SERVICE_FIELDS,
      'typingStatus',
      'callRecording',
      'externalChatpic',
      'qqClientSyncEnabled',
      'qqLiveMessagesEnabled',
    ];
    Object.assign(
      out,
      Object.fromEntries(
        Object.entries(app).filter(
          ([key]) =>
            APP_SETTINGS_RESET_POLICY[key as keyof typeof APP_SETTINGS_RESET_POLICY] ===
              'preference' && !handled.includes(key),
        ),
      ),
    );
    Object.assign(out, {
      typingStatus: { mode: app.typingStatus.mode },
      callRecording: backupPick(app.callRecording, ['mode', 'systemAudio']),
      externalChatpic: { enabled: app.externalChatpic.enabled },
    });
    Object.assign(
      outShared,
      backupPick(shared, ['intent', 'antiRecall', 'mail', 'annualReport', 'order']),
    );
    outShared.client = { ...(outShared.client as object), ...omit(client, APPEARANCE_PREFERENCES) };
    Object.assign(
      assistant,
      backupPick(api.sharedAssistant ?? {}, [
        'model',
        'reasoningEffort',
        'localLightweight',
        'sendMode',
        'customPrompt',
        'modelSettingsVersion',
      ]),
    );
  }
  if (sections.includes('paths'))
    Object.assign(out, backupPick(app, DEVICE_PATHS), {
      externalChatpic: { ...(out.externalChatpic as object), dir: app.externalChatpic.dir },
      callRecording: { ...(out.callRecording as object), dir: app.callRecording.dir },
    });
  if (sections.includes('device')) {
    Object.assign(out, backupPick(app, DEVICE_FIELDS), {
      callRecording: { ...(out.callRecording as object), udpTrace: app.callRecording.udpTrace },
    });
    Object.assign(assistant, backupPick(api.sharedAssistant ?? {}, ['permissionMode']));
  }
  if (sections.includes('models')) {
    const provider = <T extends { apiKey: string; baseUrl: string }>(row: T) =>
      selection.includeApiKeys
        ? row
        : { ...row, apiKey: '', baseUrl: withoutUrlCredentials(row.baseUrl) };
    outApi.agentLab = { ...api.agentLab, providers: api.agentLab.providers.map(provider) };
    outApi.ttsProviders = api.ttsProviders.map(provider);
  }
  if (sections.includes('services')) {
    Object.assign(out, backupPick(app, SERVICE_FIELDS));
    Object.assign(outApi, backupPick(api, ['mcp', 'oneBotByUin', 'externalRkey', 'ssePush']));
    const includeTokens = selection.includeServiceTokens;
    if (includeTokens)
      Object.assign(assistant, backupPick(api.sharedAssistant ?? {}, ['mcpServers']));
    else {
      outApi.mcp = { ...api.mcp, token: '' };
      outApi.oneBotByUin = withoutServiceCredentials(api.oneBotByUin);
      outApi.externalRkey = withoutServiceCredentials(api.externalRkey);
      outApi.ssePush = withoutServiceCredentials(api.ssePush);
      const servers = backupExternalMcpAddresses(api.sharedAssistant?.mcpServers);
      if (servers) assistant.mcpServers = servers;
    }
  }
  if (Object.keys(assistant).length) outApi.sharedAssistant = assistant;
  if (Object.keys(outShared).length) out.sharedPreferences = outShared;
  return {
    app: out,
    api: outApi,
    background: sections.includes('appearance') ? shared.dress?.backgroundFile : undefined,
  };
}

export function selectiveSettingFields(sections: WeqBackupSection[]) {
  const template = snapshotSelectiveSettings(DEFAULT_APP_SETTINGS, {
    sections,
    accountConfigIds: [],
    databaseConfigIds: [],
    draftConfigIds: [],
    cloneConfigIds: [],
    includeApiKeys: true,
    includeServiceTokens: true,
  });
  if (sections.includes('preferences')) {
    // 旧选择性备份仍可恢复；导出只写合并后的窗口提示字段。
    Object.assign(template.app, {
      restrictedModeIndicatorEnabled: true,
      qqProxyIndicatorEnabled: true,
    });
  }
  const strictGroups = new Set([
    'sharedPreferences',
    'sharedPreferences.client',
    'callRecording',
    'externalChatpic',
    'typingStatus',
    'sharedAssistant',
  ]);
  return (value: Record<string, unknown>, part: 'app' | 'api') => {
    const visit = (
      incoming: Record<string, unknown>,
      known: Record<string, unknown>,
      path = '',
    ) => {
      for (const [key, child] of Object.entries(incoming)) {
        const name = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(known, key)) throw new Error(`备份内容与所选范围不一致：${name}`);
        if (strictGroups.has(name) && child && typeof child === 'object')
          visit(child as Record<string, unknown>, known[key] as Record<string, unknown>, name);
      }
    };
    visit(value, template[part]);
  };
}

function withoutUrlCredentials(value: string) {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function backupExternalMcpAddresses(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return;
  const endpoint = (text: unknown) =>
    typeof text === 'string' && /^https?:\/\//i.test(text.trim())
      ? withoutUrlCredentials(text.trim())
      : '';
  const servers: [string, { url: string }][] = [];
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      const rows = parsed?.mcpServers ?? parsed;
      for (const [name, entry] of Object.entries(rows ?? {})) {
        const url = endpoint((entry as { url?: unknown } | null)?.url);
        if (url) servers.push([name, { url }]);
      }
    } catch {
      return;
    }
  } else {
    for (const line of value.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const eq = line.indexOf('=');
      const named = eq > 0 ? endpoint(line.slice(eq + 1)) : '';
      const url = named || endpoint(line);
      if (url) servers.push([named ? line.slice(0, eq).trim() : url, { url }]);
    }
  }
  if (servers.length) return JSON.stringify({ mcpServers: Object.fromEntries(servers) });
}

function withoutServiceCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutServiceCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/^(token|accessToken|apiKey|secret|password)$/i.test(key)) return [key, ''];
      if (typeof item === 'string' && /url$/i.test(key)) return [key, withoutUrlCredentials(item)];
      return [key, withoutServiceCredentials(item)];
    }),
  );
}

export function snapshotSelectiveAccount(account: AccountConfig, selection: WeqSelectiveBackup) {
  const id = account.configId;
  const { sections } = selection;
  const preferences = sections.includes('account') && selection.accountConfigIds.includes(id);
  const database = sections.includes('database') && selection.databaseConfigIds.includes(id);
  return {
    ...(database ? backupPick(account, DATABASE_FIELDS) : {}),
    ...(database && sections.includes('paths') ? backupPick(account, SOURCE_PATHS) : {}),
    ...(preferences ? backupPick(account, ACCOUNT_FIELDS) : {}),
    configId: id,
    uin: account.uin,
  };
}

export function validateSelectiveAccount(value: unknown, scope: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('备份账号配置无效');
  const account = value as Partial<AccountConfig> & {
    typing?: AppSettings['typingStatus']['hidden'];
  };
  const keys = [
    'configId',
    'uin',
    'typing',
    ...DATABASE_FIELDS,
    ...ACCOUNT_FIELDS,
    ...SOURCE_PATHS,
  ];
  if (
    Object.keys(account).some((key) => !keys.includes(key)) ||
    Object.hasOwn(account, 'dbKey') !== Object.hasOwn(account, 'algos')
  )
    throw new Error('备份账号字段无效');
  const { typing, ...row } = account;
  validateWeqAccountSettings({ dbKey: '', algos: {}, lastLoginAt: 0, ...row }, scope);
  if (typing !== undefined) {
    validateWeqAppSettings({ typingStatus: { hidden: typing } });
    if (typing.some((item) => item.accountConfigId !== scope || item.accountUin !== row.uin))
      throw new Error('输入状态名单与备份账号来源不匹配');
  }
  return account;
}

export function snapshotBackupPaths(config: UserConfig) {
  return Object.fromEntries(BACKUP_HOST_PATHS.map((key) => [key, config[key] ?? null]));
}
