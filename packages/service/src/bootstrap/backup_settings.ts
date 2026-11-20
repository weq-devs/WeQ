import type { AccountConfig } from '../account/user_config';
import { DEFAULT_APP_SETTINGS, MAX_LOG_RETENTION_DAYS, type AppSettings } from './user_config';
import { isToastDuration } from '../common/toast_settings';
import { isUpdateCheckInterval } from '../common/update_settings';
import { normalizeQzonePagination } from '../common/qzone_pagination';
import { DEFAULT_CONTACT_CARD } from '../common/contact_card';
import { mailPollIntervalMinutes } from '../account/mail/wire';
import { validateWeqAccountPreference } from './backup_accounts';
import { validatePreferencePatch } from '../common/client_preferences';
import type { SharedPreferences } from '../common/shared_preferences';
import {
  normalizedSharedPreferences,
  SHARED_PREFERENCE_DEFINITIONS,
} from '../common/shared_preferences';
import type { AssistantConfig } from '../account/assistant';
import { DEFAULT_ASSISTANT_CONFIG } from '../account/assistant';
import { RETIRED_ASSISTANT_PARAMETERS } from '../account/assistant_config';

export type WeqAppBackupSettings = Omit<
  AppSettings,
  | 'agentLab'
  | 'mcp'
  | 'oneBotByUin'
  | 'externalRkey'
  | 'ssePush'
  | 'voiceTranscribe'
  | 'sharedPreferences'
> & {
  sharedPreferences: Omit<SharedPreferences, 'assistant'>;
  voiceTranscribe: Pick<
    AppSettings['voiceTranscribe'],
    'modelId' | 'autoTranscribe' | 'onlineConcurrency'
  >;
};
type PartialSettings<T> = T extends object ? { [K in keyof T]?: PartialSettings<T[K]> } : T;
export type WeqAppBackupPatch = PartialSettings<WeqAppBackupSettings>;
export interface WeqApiBackupSettings {
  agentLab: AppSettings['agentLab'];
  ttsProviders: AppSettings['voiceTranscribe']['ttsProviders'];
  mcp: AppSettings['mcp'];
  oneBotByUin: AppSettings['oneBotByUin'];
  externalRkey: AppSettings['externalRkey'];
  ssePush: AppSettings['ssePush'];
  sharedAssistant?: AssistantConfig;
}

/** 设置与凭据分区独立；不导出 config.json 中的 TOTP、自动进入或本机缓存根。 */
export function snapshotWeqSettings(settings: AppSettings): WeqAppBackupSettings {
  const {
    agentLab: _agent,
    mcp: _mcp,
    oneBotByUin: _oneBot,
    externalRkey: _rkey,
    ssePush: _sse,
    voiceTranscribe,
    sharedPreferences,
    ...app
  } = settings;
  return structuredClone({
    ...app,
    sharedPreferences: Object.fromEntries(
      Object.entries(
        normalizedSharedPreferences(sharedPreferences, settings.modelResources.intent),
      ).filter(
        ([key]) =>
          SHARED_PREFERENCE_DEFINITIONS[key as keyof SharedPreferences].backup === 'settings',
      ),
    ),
    voiceTranscribe: {
      modelId: voiceTranscribe.modelId,
      autoTranscribe: voiceTranscribe.autoTranscribe,
      onlineConcurrency: voiceTranscribe.onlineConcurrency,
    },
  });
}

/** 备份里的旧 OneBot 形状（两组数组 + 可选单条 port / token）。 */
function isLegacyOneBotBackup(value: Record<string, unknown>): boolean {
  return !('networks' in value);
}

export function snapshotWeqApiSettings(settings: AppSettings): WeqApiBackupSettings {
  return structuredClone({
    agentLab: settings.agentLab,
    ttsProviders: settings.voiceTranscribe.ttsProviders,
    mcp: settings.mcp,
    oneBotByUin: settings.oneBotByUin,
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
    sharedAssistant: normalizedSharedPreferences(
      settings.sharedPreferences,
      settings.modelResources.intent,
    ).assistant,
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
    mailNotifications: _mailNotifications,
    mailShowUnread: _mailShowUnread,
    mailPollIntervalMinutes: _mailPollIntervalMinutes,
    annualReport: _annualReport,
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

export function validateSharedPreferences(value: unknown): asserts value is SharedPreferences {
  const groups = fields(
    value,
    'sharedPreferences',
    [],
    Object.entries(SHARED_PREFERENCE_DEFINITIONS)
      .filter(([, spec]) => spec.backup === 'settings')
      .map(([key]) => key),
  );
  if (groups.client !== undefined) validatePreferencePatch(groups.client);
  if (groups.order !== undefined) validatePreferencePatch({ contactOrder: groups.order });
  for (const [key, file] of [
    ['intent', 'intent.json'],
    ['antiRecall', 'anti-recall.json'],
    ['dress', 'dress.json'],
  ] as const) {
    if (groups[key] === undefined) continue;
    const group = record(groups[key], `sharedPreferences.${key}`);
    if (
      ['conversationOverrides', 'targets', 'notifyTargets'].some((field) =>
        Object.hasOwn(group, field),
      )
    )
      fail(`sharedPreferences.${key}`);
    validateWeqAccountPreference(file, group);
  }
  if (groups.mail !== undefined) {
    const mail = fields(
      groups.mail,
      'sharedPreferences.mail',
      [],
      ['mailNotifications', 'mailShowUnread', 'mailPollIntervalMinutes'],
    );
    for (const key of ['mailNotifications', 'mailShowUnread'])
      if (mail[key] !== undefined && typeof mail[key] !== 'boolean')
        fail(`sharedPreferences.mail.${key}`);
    if (
      mail.mailPollIntervalMinutes !== undefined &&
      mailPollIntervalMinutes(mail.mailPollIntervalMinutes) !== mail.mailPollIntervalMinutes
    )
      fail('sharedPreferences.mail.mailPollIntervalMinutes');
  }
  if (groups.annualReport !== undefined) {
    const report = fields(
      groups.annualReport,
      'sharedPreferences.annualReport',
      [],
      ['mode', 'enabledPageIds', 'order', 'exportPageIds'],
    );
    if (report.mode !== undefined && report.mode !== 'default' && report.mode !== 'custom')
      fail('sharedPreferences.annualReport.mode');
    for (const key of ['enabledPageIds', 'order', 'exportPageIds'])
      if (
        report[key] !== undefined &&
        (!Array.isArray(report[key]) || report[key].some((item) => typeof item !== 'string'))
      )
        fail(`sharedPreferences.annualReport.${key}`);
  }
}

function validateSharedAssistant(value: unknown): void {
  const row = fields(
    value,
    'api.sharedAssistant',
    [],
    [...Object.keys(DEFAULT_ASSISTANT_CONFIG), ...RETIRED_ASSISTANT_PARAMETERS],
  );
  strings(row, 'api.sharedAssistant', [], ['customPrompt', 'mcpServers']);
  if (
    row.permissionMode !== undefined &&
    !['sandbox', 'unrestricted'].includes(String(row.permissionMode))
  )
    fail('api.sharedAssistant.permissionMode');
  if (row.reasoningEffort !== undefined && typeof row.reasoningEffort !== 'string')
    fail('api.sharedAssistant.reasoningEffort');
  if (
    row.sendMode !== undefined &&
    !['interrupt', 'boundary', 'queue'].includes(String(row.sendMode))
  )
    fail('api.sharedAssistant.sendMode');
  if (row.modelSettingsVersion !== undefined && row.modelSettingsVersion !== 2)
    fail('api.sharedAssistant.modelSettingsVersion');
  if (row.model !== undefined) {
    const model = record(row.model, 'api.sharedAssistant.model');
    if (model.useDefault === true) fields(model, 'api.sharedAssistant.model', ['useDefault']);
    else {
      fields(model, 'api.sharedAssistant.model', ['providerId', 'model']);
      strings(model, 'api.sharedAssistant.model', ['providerId', 'model']);
    }
  }
}

export function validateWeqAppSettings(value: unknown): asserts value is WeqAppBackupPatch {
  const input = record(value, 'settings');
  // 默认空数组无法描述元素结构，输入状态单独校验，避免被当作普通对象。
  const {
    typingStatus,
    home,
    contactCard,
    qqShowCacheDays,
    updateCheckIntervalMinutes,
    quitConfirmSuppressed,
    sharedPreferences,
    ...scalarSettings
  } = input;
  // 旧备份允许携带已退役字段，但不再将它写回正式设置。
  if (Object.hasOwn(input, 'quitConfirmSuppressed') && typeof quitConfirmSuppressed !== 'boolean')
    fail('settings.quitConfirmSuppressed');
  if (
    Object.hasOwn(input, 'updateCheckIntervalMinutes') &&
    !isUpdateCheckInterval(updateCheckIntervalMinutes)
  )
    fail('settings.updateCheckIntervalMinutes');
  if (qqShowCacheDays !== undefined) number(qqShowCacheDays, 'settings.qqShowCacheDays', 1, 365);
  shape(scalarSettings, snapshotWeqSettings(DEFAULT_APP_SETTINGS), 'settings');
  if (input.aiImages !== undefined) {
    for (const [feature, mode] of Object.entries(record(input.aiImages, 'settings.aiImages'))) {
      if (
        !['placeholder', 'ocr', 'vision'].includes(String(mode)) ||
        (mode === 'placeholder' && (feature === 'assistant' || feature === 'cloneChat'))
      )
        fail(`settings.aiImages.${feature}`);
    }
  }
  if (sharedPreferences !== undefined) validateSharedPreferences(sharedPreferences);
  if (contactCard !== undefined) {
    const card = fields(
      contactCard,
      'settings.contactCard',
      [],
      ['visible', 'order', 'groupOrder'],
    );
    if (card.visible !== undefined)
      shape(card.visible, DEFAULT_CONTACT_CARD.visible, 'settings.contactCard.visible');
    for (const key of ['order', 'groupOrder'] as const) {
      const list = card[key];
      const known: readonly string[] = DEFAULT_CONTACT_CARD[key];
      if (
        list !== undefined &&
        (!Array.isArray(list) ||
          list.some((item) => typeof item !== 'string' || !known.includes(item)))
      )
        fail(`settings.contactCard.${key}`);
    }
  }
  if (
    input.startupPage !== undefined &&
    !['home', 'messages', 'last'].includes(String(input.startupPage))
  )
    fail('settings.startupPage');
  if (Object.hasOwn(input, 'home')) {
    const page = fields(
      home,
      'settings.home',
      [],
      ['preferQqShow', 'showTags', 'showGreeting', 'showHitokoto', 'blockedWords'],
    );
    for (const key of ['preferQqShow', 'showTags', 'showGreeting', 'showHitokoto'])
      if (page[key] !== undefined && typeof page[key] !== 'boolean') fail(`settings.home.${key}`);
    if (Object.hasOwn(page, 'blockedWords')) {
      if (!Array.isArray(page.blockedWords) || page.blockedWords.length > 1000)
        fail('settings.home.blockedWords');
      for (const word of page.blockedWords) {
        string(word, 'settings.home.blockedWords', true);
        if (word.length > 200) fail('settings.home.blockedWords');
      }
    }
  }
  if (Object.hasOwn(input, 'typingStatus')) {
    const typing = fields(
      typingStatus,
      'settings.typingStatus',
      [],
      ['mode', 'hidden', 'defaultEnabled', 'overrides'],
    );
    if (Object.hasOwn(typing, 'mode') && !['off', 'selected', 'all'].includes(String(typing.mode)))
      fail('settings.typingStatus.mode');
    if (Object.hasOwn(typing, 'hidden')) {
      const path = 'settings.typingStatus.hidden';
      if (!Array.isArray(typing.hidden)) fail(path);
      for (const [index, item] of typing.hidden.entries()) {
        const where = `${path}[${index}]`;
        const row = fields(item, where, ['accountUin', 'accountConfigId', 'uid', 'name']);
        for (const key of ['accountUin', 'accountConfigId', 'uid'])
          string(row[key], `${where}.${key}`, true);
        string(row.name, `${where}.name`);
      }
    }
    // 旧备份的相反语义字段仍可读入，恢复时按新语义归一化。
    if (Object.hasOwn(typing, 'defaultEnabled') && typeof typing.defaultEnabled !== 'boolean')
      fail('settings.typingStatus.defaultEnabled');
    if (Object.hasOwn(typing, 'overrides')) {
      const path = 'settings.typingStatus.overrides';
      if (!Array.isArray(typing.overrides)) fail(path);
      for (const [index, item] of typing.overrides.entries()) {
        const where = `${path}[${index}]`;
        const row = fields(item, where, [
          'accountUin',
          'accountConfigId',
          'uid',
          'name',
          'enabled',
        ]);
        for (const key of ['accountUin', 'accountConfigId', 'uid'])
          string(row[key], `${where}.${key}`, true);
        string(row.name, `${where}.name`);
        if (typeof row.enabled !== 'boolean') fail(`${where}.enabled`);
      }
    }
  }
  if (
    input.exportSaveMode !== undefined &&
    !['before', 'preset'].includes(String(input.exportSaveMode))
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
  if (input.databaseReadConcurrency !== undefined)
    number(input.databaseReadConcurrency, 'settings.databaseReadConcurrency', 1, 8);
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
  if (input.callRecording !== undefined) {
    const recording = record(input.callRecording, 'settings.callRecording');
    if (recording.mode !== undefined && !['self', 'peer', 'mixed'].includes(String(recording.mode)))
      fail('settings.callRecording.mode');
    if (recording.systemAudio !== undefined && typeof recording.systemAudio !== 'boolean')
      fail('settings.callRecording.systemAudio');
    if (recording.dir !== undefined && recording.dir !== null)
      string(recording.dir, 'settings.callRecording.dir');
    if (recording.udpTrace !== undefined && typeof recording.udpTrace !== 'boolean')
      fail('settings.callRecording.udpTrace');
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
  for (const [key, config] of [
    ['ocr', ocr],
    ['voiceTranscribe', voice],
  ] as const) {
    if (config?.onlineConcurrency !== undefined)
      number(config.onlineConcurrency, `settings.${key}.onlineConcurrency`, 1, 32);
  }
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

/**
 * 校验一份 OneBot 配置（单个账号的）。
 *
 * 两种历史格式都收：
 *   - 旧：`{ enabled, port, token }` 或 `{ webSocketServers, httpServers }`；
 *   - 新：`{ networks: { wsServers, wsClients, httpServers, httpClients } }`。
 *
 * 备份是用户资产，不能因为格式升级就拒绝导入。
 */
function assertOneBotConfig(value: unknown, root: string): void {
  const config = record(value, root);
  if (isLegacyOneBotBackup(config)) {
    fields(
      config,
      root,
      [],
      ['enabled', 'port', 'token', 'name', 'webSocketServers', 'httpServers'],
    );
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      fail(`${root}.enabled`);
    }
    if (config.port !== undefined || config.token !== undefined) {
      number(config.port, `${root}.port`, 1024, 65535);
      string(config.token, `${root}.token`);
    }
    for (const key of ['webSocketServers', 'httpServers'] as const) {
      if (config[key] === undefined) continue;
      list(config[key], `${root}.${key}`, (row, where) => {
        // 旧行的 `id` 是必填的；新格式迁移过来的行没有，这里放宽成可选。
        fields(
          row,
          where,
          [],
          ['id', 'name', 'enabled', 'port', 'token', 'accessToken', 'enableCors', 'url'],
        );
        if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
          fail(`${where}.enabled`);
        }
        if (row.enableCors !== undefined && typeof row.enableCors !== 'boolean') {
          fail(`${where}.enableCors`);
        }
        if (row.port !== undefined) number(row.port, `${where}.port`, 1024, 65535);
        strings(row, where, [], ['name', 'token', 'accessToken', 'url']);
      });
    }
    return;
  }

  const networks = record(config.networks, `${root}.networks`);
  for (const key of ['wsServers', 'wsClients', 'httpServers', 'httpClients'] as const) {
    if (networks[key] === undefined) continue;
    // 不能用 `list()`：它要求每行有唯一 `id`，而 kernel 的 DTO 用 `name` 当唯一键。
    if (!Array.isArray(networks[key])) fail(`${root}.networks.${key}`);
    const names = new Set<string>();
    for (const [index, item] of (networks[key] as unknown[]).entries()) {
      const where = `${root}.networks.${key}[${index}]`;
      const row = record(item, where);
      if (typeof row.name !== 'string' || names.has(row.name)) fail(`${where}.name`);
      names.add(row.name);
      // 白名单带上旧字段：新版本导出的备份要能被旧机器导入，反过来也一样。
      fields(
        row,
        where,
        ['name'],
        [
          'enabled',
          'accessToken',
          'token',
          'id',
          'messageFormat',
          'reportSelfMessage',
          'host',
          'port',
          'path',
          'role',
          'url',
          'enableWebSocket',
          'enableCors',
          'reconnectIntervalMs',
          'timeoutMs',
        ],
      );
      strings(
        row,
        where,
        ['name'],
        ['accessToken', 'token', 'id', 'messageFormat', 'host', 'path', 'role', 'url'],
      );
      if (row.port !== undefined) number(row.port, `${where}.port`, 0, 65535);
      if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
        fail(`${where}.enabled`);
      }
      if (row.enableCors !== undefined && typeof row.enableCors !== 'boolean') {
        fail(`${where}.enableCors`);
      }
      if (typeof row.reportSelfMessage !== 'boolean') fail(`${where}.reportSelfMessage`);
    }
  }
  if (config.qzone !== undefined && typeof config.qzone !== 'boolean') fail(`${root}.qzone`);
  if (config.qzoneDomain !== undefined) string(config.qzoneDomain, `${root}.qzoneDomain`);
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

function modelCapabilities(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((cap) => !['chat', 'embedding', 'vision'].includes(cap)))
    fail(path);
}

function validateProviderModel(model: Record<string, unknown>, path: string): void {
  fields(
    model,
    path,
    ['id', 'capabilities'],
    ['label', 'reasoningEfforts', 'metadata', 'overrides'],
  );
  strings(model, path, [], ['label']);
  modelCapabilities(model.capabilities, `${path}.capabilities`);
  if (model.reasoningEfforts !== undefined) {
    if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length > 32)
      fail(`${path}.reasoningEfforts`);
    for (const item of model.reasoningEfforts) {
      string(item, `${path}.reasoningEfforts`, true);
      if (item.length > 64) fail(`${path}.reasoningEfforts`);
    }
  }
  if (model.overrides !== undefined) {
    const where = `${path}.overrides`;
    const row = fields(model.overrides, where, [], ['capabilities', 'reasoning', 'request']);
    if (row.capabilities !== undefined)
      modelCapabilities(row.capabilities, `${where}.capabilities`);
    if (row.reasoning !== undefined && typeof row.reasoning !== 'boolean')
      fail(`${where}.reasoning`);
    if (row.request !== undefined) {
      const request = fields(
        row.request,
        `${where}.request`,
        [],
        ['contextWindowTokens', 'maxOutputTokens', 'temperatureSupported', 'outputTokenParameter'],
      );
      for (const key of ['contextWindowTokens', 'maxOutputTokens']) {
        if (request[key] !== undefined) number(request[key], `${where}.request.${key}`, 1);
      }
      if (
        request.temperatureSupported !== undefined &&
        typeof request.temperatureSupported !== 'boolean'
      )
        fail(`${where}.request.temperatureSupported`);
      if (
        request.outputTokenParameter !== undefined &&
        request.outputTokenParameter !== 'max_tokens' &&
        request.outputTokenParameter !== 'max_completion_tokens'
      )
        fail(`${where}.request.outputTokenParameter`);
    }
  }
  if (model.metadata !== undefined) {
    const where = `${path}.metadata`;
    const metadata = fields(
      model.metadata,
      where,
      ['capabilities', 'reasoning', 'raw', 'source', 'fetchedAt'],
      ['error'],
    );
    strings(metadata, where, ['source'], ['error']);
    number(metadata.fetchedAt, `${where}.fetchedAt`);
    record(metadata.raw, `${where}.raw`);
    const caps = fields(metadata.capabilities, `${where}.capabilities`, [
      'chat',
      'vision',
      'embedding',
    ]);
    if (
      Object.values(caps).some(
        (status) => status !== 'supported' && status !== 'unsupported' && status !== 'unknown',
      )
    )
      fail(`${where}.capabilities`);
    const reasoning = fields(
      metadata.reasoning,
      `${where}.reasoning`,
      ['controls'],
      ['supported', 'mandatory'],
    );
    for (const key of ['supported', 'mandatory']) {
      if (reasoning[key] !== undefined && typeof reasoning[key] !== 'boolean')
        fail(`${where}.reasoning.${key}`);
    }
    const controls = `${where}.reasoning.controls`;
    if (!Array.isArray(reasoning.controls)) fail(controls);
    const primitive = (value: unknown) =>
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value));
    for (const value of reasoning.controls) {
      const control = fields(
        value,
        controls,
        ['source', 'kind'],
        ['values', 'default', 'min', 'max'],
      );
      string(control.source, controls);
      if (
        typeof control.kind !== 'string' ||
        !['effort', 'toggle', 'budget', 'adaptive'].includes(control.kind)
      )
        fail(controls);
      if (
        control.values != null &&
        (!Array.isArray(control.values) || !control.values.every(primitive))
      )
        fail(controls);
      if (control.default != null && !primitive(control.default)) fail(controls);
      for (const key of ['min', 'max']) {
        if (control[key] !== undefined)
          number(control[key], `${controls}.${key}`, -Infinity, Infinity, false);
      }
    }
  }
}

export function validateWeqApiSettings(
  value: unknown,
): asserts value is Partial<WeqApiBackupSettings> {
  const api = fields(
    value,
    'api',
    [],
    [
      'agentLab',
      'ttsProviders',
      'mcp',
      'oneBot',
      'oneBotByUin',
      'externalRkey',
      'ssePush',
      'sharedAssistant',
    ],
  );
  if (api.sharedAssistant !== undefined) validateSharedAssistant(api.sharedAssistant);
  if (api.agentLab !== undefined) {
    const agent = fields(
      api.agentLab,
      'api.agentLab',
      ['providers'],
      [
        'defaultModel',
        'defaultVisionModel',
        'defaultEmbeddingModel',
        'defaultContextWindowTokens',
        'defaultMaxOutputTokens',
      ],
    );
    if (agent.defaultContextWindowTokens !== undefined)
      number(agent.defaultContextWindowTokens, 'api.agentLab.defaultContextWindowTokens', 1);
    if (agent.defaultMaxOutputTokens != null)
      number(agent.defaultMaxOutputTokens, 'api.agentLab.defaultMaxOutputTokens', 1);
    if (agent.defaultVisionModel !== undefined && agent.defaultVisionModel !== null) {
      const ref = fields(agent.defaultVisionModel, 'api.agentLab.defaultVisionModel', [
        'providerId',
        'model',
      ]);
      string(ref.providerId, 'api.agentLab.defaultVisionModel.providerId', true);
      string(ref.model, 'api.agentLab.defaultVisionModel.model', true);
    }
    if (agent.defaultModel !== undefined && agent.defaultModel !== null) {
      const ref = fields(agent.defaultModel, 'api.agentLab.defaultModel', ['providerId', 'model']);
      string(ref.providerId, 'api.agentLab.defaultModel.providerId', true);
      string(ref.model, 'api.agentLab.defaultModel.model', true);
    }
    if (agent.defaultEmbeddingModel !== undefined && agent.defaultEmbeddingModel !== null) {
      const path = 'api.agentLab.defaultEmbeddingModel';
      const ref = fields(agent.defaultEmbeddingModel, path, ['providerId', 'model']);
      string(ref.providerId, `${path}.providerId`, true);
      string(ref.model, `${path}.model`, true);
    }
    list(agent.providers, 'api.agentLab.providers', (row, path) => {
      fields(
        row,
        path,
        ['id', 'name', 'vendor', 'baseUrl', 'apiKey', 'models', 'createdAt', 'updatedAt'],
        ['timeoutMs'],
      );
      strings(row, path, ['name', 'vendor', 'baseUrl', 'apiKey']);
      providerTimes(row, path);
      if (row.timeoutMs !== undefined) number(row.timeoutMs, `${path}.timeoutMs`, 1, 2_147_483_647);
      list(row.models, `${path}.models`, validateProviderModel);
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
  // OneBot 配置进 API 分区。旧备份是全局一份（`api.oneBot`），新的是按账号
  // （`api.oneBotByUin`）；**两种都收** —— 备份是用户资产，不能因为格式升级作废。
  if (api.oneBotByUin !== undefined) {
    const map = record(api.oneBotByUin, 'api.oneBotByUin');
    for (const [uin, config] of Object.entries(map)) {
      if (uin !== 'legacy' && !/^\d{5,20}$/.test(uin)) fail(`api.oneBotByUin.${uin}`);
      assertOneBotConfig(config, `api.oneBotByUin.${uin}`);
    }
  }
  if (api.oneBot !== undefined) assertOneBotConfig(api.oneBot, 'api.oneBot');

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
    ['uid', 'dataDir', 'backupAccountDir', 'displayName', 'avatarUrl', 'guid', 'nativeMediaDir'],
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
  if (
    row.mailPollIntervalMinutes !== undefined &&
    mailPollIntervalMinutes(row.mailPollIntervalMinutes) !== row.mailPollIntervalMinutes
  )
    fail('accounts.mailPollIntervalMinutes');
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
        'callBgUrl',
        'callBgVideoUrl',
        'callBgId',
        'callBgName',
        'callBgCheckedAt',
      ],
    );
    for (const [key, value] of Object.entries(dress)) {
      if (key === 'tags') {
        if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string'))
          fail('accounts.homeDress.tags');
      } else if (key.endsWith('Id')) number(value, `accounts.homeDress.${key}`);
      else if (key.endsWith('At')) number(value, `accounts.homeDress.${key}`);
      else string(value, `accounts.homeDress.${key}`);
    }
  }
  if (row.vip !== undefined) {
    const vip = fields(
      row.vip,
      'accounts.vip',
      [],
      ['tier', 'year', 'level', 'expireAt', 'fetchedAt'],
    );
    if (vip.tier !== 'vip' && vip.tier !== 'svip' && vip.tier !== 'bvip') fail('accounts.vip.tier');
    if (typeof vip.year !== 'boolean') fail('accounts.vip.year');
    number(vip.level, 'accounts.vip.level');
    number(vip.fetchedAt, 'accounts.vip.fetchedAt');
    if (vip.expireAt !== undefined) number(vip.expireAt, 'accounts.vip.expireAt');
  }
  if (row.vipCheckedAt !== undefined) number(row.vipCheckedAt, 'accounts.vipCheckedAt');
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
