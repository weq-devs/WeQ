import type { AccountConfig } from '../account/user_config';
import { DEFAULT_APP_SETTINGS, MAX_LOG_RETENTION_DAYS, type AppSettings } from './user_config';
import { isToastDuration } from '../common/toast_settings';
import { normalizeQzonePagination } from '../common/qzone_pagination';

export type WeqAppBackupSettings = Omit<
  AppSettings,
  'agentLab' | 'mcp' | 'externalRkey' | 'ssePush' | 'voiceTranscribe'
> & {
  voiceTranscribe: Pick<AppSettings['voiceTranscribe'], 'modelId'>;
};
type PartialSettings<T> = T extends object ? { [K in keyof T]?: PartialSettings<T[K]> } : T;
export type WeqAppBackupPatch = PartialSettings<WeqAppBackupSettings>;
export interface WeqApiBackupSettings {
  agentLab: AppSettings['agentLab'];
  ttsProviders: AppSettings['voiceTranscribe']['ttsProviders'];
  mcp: AppSettings['mcp'];
  externalRkey: AppSettings['externalRkey'];
  ssePush: AppSettings['ssePush'];
}

/** 设置与凭据分区独立；不导出 config.json 中的 TOTP、自动进入或本机缓存根。 */
export function snapshotWeqSettings(settings: AppSettings): WeqAppBackupSettings {
  const {
    agentLab: _agent,
    mcp: _mcp,
    externalRkey: _rkey,
    ssePush: _sse,
    voiceTranscribe,
    ...app
  } = settings;
  return structuredClone({ ...app, voiceTranscribe: { modelId: voiceTranscribe.modelId } });
}

export function snapshotWeqApiSettings(settings: AppSettings): WeqApiBackupSettings {
  return structuredClone({
    agentLab: settings.agentLab,
    ttsProviders: settings.voiceTranscribe.ttsProviders,
    mcp: settings.mcp,
    externalRkey: {
      ...settings.externalRkey,
      servers: settings.externalRkey.servers.map(({ id, name, baseUrl, accessToken }) => ({
        id,
        name,
        baseUrl,
        accessToken,
      })),
    },
    ssePush: settings.ssePush,
  });
}

/** 只迁移可重新打开原数据源的配置，不把别处的在线票据与进程身份带到本机。 */
export function snapshotWeqAccount(config: AccountConfig): AccountConfig {
  const {
    qqOnline: _online,
    qqPid: _pid,
    session: _session,
    a1Payload: _a1,
    rkeys: _rkeys,
    rkeyUpdatedAt: _rkeyAt,
    clientKey: _clientKey,
    loginPskey: _pskey,
    ...saved
  } = config;
  return structuredClone(saved);
}

function fail(path: string): never {
  throw new Error(`备份配置字段无效：${path}`);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const row = record(value, path);
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail(path);
  return row;
}
function string(value: unknown, path: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && !value.trim())) fail(path);
}
function number(
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  integer = true,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  )
    fail(path);
}
function strings(
  row: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  for (const key of required) string(row[key], `${path}.${key}`);
  for (const key of optional) if (row[key] !== undefined) string(row[key], `${path}.${key}`);
}

function shape(value: unknown, template: unknown, path: string): void {
  if (template === null) {
    if (value !== null) string(value, path);
    return;
  }
  if (typeof template === 'string') {
    string(value, path);
    return;
  }
  if (typeof template === 'number') {
    number(value, path, -1);
    return;
  }
  if (typeof template === 'boolean') {
    if (typeof value !== 'boolean') fail(path);
    return;
  }
  const expected = record(template, path);
  const input = record(value, path);
  for (const [key, item] of Object.entries(input)) {
    if (!Object.hasOwn(expected, key)) fail(`${path}.${key}`);
    shape(item, expected[key], `${path}.${key}`);
  }
}

export function validateWeqAppSettings(value: unknown): asserts value is WeqAppBackupPatch {
  const input = record(value, 'settings');
  shape(input, snapshotWeqSettings(DEFAULT_APP_SETTINGS), 'settings');
  if (
    input.exportSaveMode !== undefined &&
    !['before', 'after', 'preset'].includes(String(input.exportSaveMode))
  )
    fail('settings.exportSaveMode');
  if (
    input.windowCloseBehavior !== undefined &&
    !['ask', 'tray', 'quit'].includes(String(input.windowCloseBehavior))
  )
    fail('settings.windowCloseBehavior');
  if (input.autoLockMinutes !== undefined)
    number(input.autoLockMinutes, 'settings.autoLockMinutes', 0, 120);
  if (input.logRetentionDays !== undefined)
    number(input.logRetentionDays, 'settings.logRetentionDays', 0, MAX_LOG_RETENTION_DAYS);
  if (input.appLock !== undefined) {
    const lock = record(input.appLock, 'settings.appLock');
    if (lock.method !== undefined && lock.method !== 'totp' && lock.method !== 'system')
      fail('settings.appLock.method');
  }
  if (input.weqAssistant !== undefined) {
    const assistant = record(input.weqAssistant, 'settings.weqAssistant');
    if (assistant.port !== undefined)
      number(assistant.port, 'settings.weqAssistant.port', 1, 65535);
  }
  if (input.toastDurations !== undefined)
    for (const [key, seconds] of Object.entries(
      record(input.toastDurations, 'settings.toastDurations'),
    )) {
      if (!isToastDuration(seconds)) fail(`settings.toastDurations.${key}`);
    }
  if (input.qzonePagination !== undefined) {
    const pagination = record(input.qzonePagination, 'settings.qzonePagination');
    const normalized = normalizeQzonePagination({
      windowSeconds:
        typeof pagination.windowSeconds === 'number' ? pagination.windowSeconds : undefined,
      maxPages: typeof pagination.maxPages === 'number' ? pagination.maxPages : undefined,
    });
    for (const [key, item] of Object.entries(pagination))
      if (item !== normalized[key as keyof typeof normalized])
        fail(`settings.qzonePagination.${key}`);
  }
  const resources =
    input.modelResources === undefined
      ? undefined
      : record(input.modelResources, 'settings.modelResources');
  const voice =
    input.voiceTranscribe === undefined
      ? undefined
      : record(input.voiceTranscribe, 'settings.voiceTranscribe');
  const ocr = input.ocr === undefined ? undefined : record(input.ocr, 'settings.ocr');
  if (
    resources &&
    voice &&
    resources.voice !== undefined &&
    voice.modelId !== undefined &&
    resources.voice !== voice.modelId
  )
    fail('settings.voiceTranscribe.modelId');
  if (resources && ocr)
    for (const [legacy, shared] of [
      ['modelId', 'ocr'],
      ['filterModelId', 'filter'],
    ] as const) {
      if (
        resources[shared] !== undefined &&
        ocr[legacy] !== undefined &&
        resources[shared] !== ocr[legacy]
      )
        fail(`settings.ocr.${legacy}`);
    }
}

function list(
  value: unknown,
  path: string,
  validate: (row: Record<string, unknown>, path: string) => void,
): Set<string> {
  if (!Array.isArray(value)) fail(path);
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const where = `${path}[${index}]`;
    const row = record(item, where);
    string(row.id, `${where}.id`, true);
    if (ids.has(row.id)) fail(`${path}（重复标识）`);
    ids.add(row.id);
    validate(row, where);
  }
  return ids;
}

function providerTimes(row: Record<string, unknown>, path: string) {
  number(row.createdAt, `${path}.createdAt`);
  number(row.updatedAt, `${path}.updatedAt`);
}

export function validateWeqApiSettings(
  value: unknown,
): asserts value is Partial<WeqApiBackupSettings> {
  const api = fields(
    value,
    'api',
    [],
    ['agentLab', 'ttsProviders', 'mcp', 'externalRkey', 'ssePush'],
  );
  if (api.agentLab !== undefined) {
    const agent = fields(api.agentLab, 'api.agentLab', ['providers']);
    list(agent.providers, 'api.agentLab.providers', (row, path) => {
      fields(row, path, [
        'id',
        'name',
        'vendor',
        'baseUrl',
        'apiKey',
        'models',
        'createdAt',
        'updatedAt',
      ]);
      strings(row, path, ['name', 'vendor', 'baseUrl', 'apiKey']);
      providerTimes(row, path);
      list(row.models, `${path}.models`, (model, where) => {
        fields(model, where, ['id', 'capabilities'], ['label']);
        strings(model, where, [], ['label']);
        if (
          !Array.isArray(model.capabilities) ||
          model.capabilities.some(
            (capability) => !['chat', 'embedding', 'vision'].includes(capability),
          )
        )
          fail(`${where}.capabilities`);
      });
    });
  }
  if (api.ttsProviders !== undefined)
    list(api.ttsProviders, 'api.ttsProviders', (row, path) => {
      fields(
        row,
        path,
        ['id', 'name', 'vendor', 'baseUrl', 'apiKey', 'createdAt', 'updatedAt'],
        ['appId', 'resourceId', 'model', 'cloneModel', 'voice', 'format', 'speed'],
      );
      strings(
        row,
        path,
        ['name', 'baseUrl', 'apiKey'],
        ['appId', 'resourceId', 'model', 'cloneModel', 'voice', 'format'],
      );
      string(row.vendor, `${path}.vendor`);
      if (
        ![
          'openai-compatible',
          'gsv2p',
          'minimax',
          'mimo',
          'doubao',
          'gpt-sovits',
          'cosyvoice',
        ].includes(row.vendor)
      )
        fail(`${path}.vendor`);
      if (row.speed !== undefined)
        number(
          row.speed,
          `${path}.speed`,
          -Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          false,
        );
      providerTimes(row, path);
    });
  if (api.mcp !== undefined) {
    const mcp = fields(api.mcp, 'api.mcp', ['enabled', 'port', 'token']);
    if (typeof mcp.enabled !== 'boolean') fail('api.mcp.enabled');
    number(mcp.port, 'api.mcp.port', 1, 65535);
    string(mcp.token, 'api.mcp.token');
  }
  for (const kind of ['externalRkey', 'ssePush'] as const) {
    if (api[kind] === undefined) continue;
    const source = fields(api[kind], `api.${kind}`, [
      'servers',
      'enabledServerId',
      ...(kind === 'ssePush' ? ['debounceMs', 'massThreshold'] : []),
    ]);
    const ids = list(source.servers, `api.${kind}.servers`, (row, path) => {
      const url = kind === 'ssePush' ? 'pushUrl' : 'baseUrl';
      fields(row, path, ['id', 'name', url, 'accessToken']);
      strings(row, path, ['name', url, 'accessToken']);
    });
    if (
      source.enabledServerId !== null &&
      (typeof source.enabledServerId !== 'string' || !ids.has(source.enabledServerId))
    )
      fail(`api.${kind}.enabledServerId`);
    if (kind === 'ssePush') {
      number(source.debounceMs, 'api.ssePush.debounceMs', 100, 60000);
      number(source.massThreshold, 'api.ssePush.massThreshold', 1, 10000);
    }
  }
}

export function validateWeqAccountSettings(
  value: unknown,
  configId: string,
): asserts value is AccountConfig {
  const row = record(value, 'accounts');
  if (row.configId !== configId) fail('accounts.configId');
  string(row.uin, 'accounts.uin', true);
  if (
    !/^\d{1,20}$/.test(row.uin) ||
    (configId !== row.uin && !new RegExp(`^${row.uin}_[0-9a-f]{8}$`).test(configId))
  )
    fail('accounts.uin');
  strings(
    row,
    'accounts',
    ['dbKey'],
    ['uid', 'dataDir', 'displayName', 'avatarUrl', 'guid', 'nativeMediaDir'],
  );
  number(row.lastLoginAt, 'accounts.lastLoginAt');
  for (const [name, value] of Object.entries(record(row.algos, 'accounts.algos'))) {
    if (!/^[A-Za-z0-9_.-]+\.db$/.test(name)) fail('accounts.algos');
    const algo = fields(value, 'accounts.algos', ['pageHmacAlgorithm', 'kdfHmacAlgorithm']);
    strings(algo, 'accounts.algos', ['pageHmacAlgorithm', 'kdfHmacAlgorithm']);
  }
  for (const key of [
    'static',
    'mobile',
    'mailNotifications',
    'mailShowUnread',
    'nativeMediaEnabled',
  ])
    if (row[key] !== undefined && typeof row[key] !== 'boolean') fail(`accounts.${key}`);
  if (row.annualReport !== undefined) {
    const report = fields(row.annualReport, 'accounts.annualReport', [
      'mode',
      'enabledPageIds',
      'order',
      'exportPageIds',
    ]);
    if (report.mode !== 'default' && report.mode !== 'custom') fail('accounts.annualReport.mode');
    for (const key of ['enabledPageIds', 'order', 'exportPageIds']) {
      if (!Array.isArray(report[key]) || report[key].some((item) => typeof item !== 'string'))
        fail(`accounts.annualReport.${key}`);
    }
  }
  if (row.homeDress !== undefined) {
    const dress = fields(
      row.homeDress,
      'accounts.homeDress',
      [],
      [
        'widgetUrl',
        'cardUrl',
        'cardVideoUrl',
        'screenUrl',
        'tags',
        'bubbleId',
        'bubbleName',
        'bubblePreviewUrl',
        'fontId',
        'fontName',
        'fontPreviewUrl',
        'chatBgUrl',
        'widgetId',
        'widgetName',
        'widgetPreviewUrl',
      ],
    );
    for (const [key, value] of Object.entries(dress)) {
      if (key === 'tags') {
        if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string'))
          fail('accounts.homeDress.tags');
      } else if (key.endsWith('Id')) number(value, `accounts.homeDress.${key}`);
      else string(value, `accounts.homeDress.${key}`);
    }
  }
  if (row.groupKeyword !== undefined)
    for (const [group, value] of Object.entries(
      record(row.groupKeyword, 'accounts.groupKeyword'),
    )) {
      if (!/^\d+$/.test(group)) fail('accounts.groupKeyword');
      const rule = fields(value, 'accounts.groupKeyword', ['keywords'], ['memberUids']);
      const members = (value: unknown) => {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
          fail('accounts.groupKeyword.memberUids');
      };
      if (rule.memberUids !== undefined) members(rule.memberUids);
      if (!Array.isArray(rule.keywords)) fail('accounts.groupKeyword.keywords');
      for (const keyword of rule.keywords) {
        if (typeof keyword === 'string') continue;
        const entry = fields(keyword, 'accounts.groupKeyword.keyword', ['keyword', 'memberUids']);
        string(entry.keyword, 'accounts.groupKeyword.keyword', true);
        members(entry.memberUids);
      }
    }
}
