import { expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, MAX_LOG_RETENTION_DAYS } from '../src/bootstrap/user_config';
import {
  snapshotWeqSettings,
  snapshotWeqApiSettings,
  snapshotWeqAccount,
  validateWeqAppSettings,
  validateWeqApiSettings,
  validateWeqAccountSettings,
} from '../src/bootstrap/backup_settings';

function settings() {
  const value = structuredClone(DEFAULT_APP_SETTINGS);
  value.agentLab.providers = [
    {
      id: 'synthetic-provider',
      name: '合成服务',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-api-secret',
      models: [{ id: 'synthetic-model', capabilities: ['chat', 'vision'] }],
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  value.voiceTranscribe.ttsProviders = [
    {
      id: 'synthetic-tts',
      name: '合成语音',
      vendor: 'cosyvoice',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: 'synthetic-tts-secret',
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  value.externalRkey = {
    servers: [
      {
        id: 'synthetic-rkey',
        name: '合成 RKEY',
        baseUrl: 'https://synthetic.invalid',
        accessToken: 'synthetic-rkey-secret',
        privateRkey: 'synthetic-private-ticket',
        groupRkey: 'synthetic-group-ticket',
        expiredTime: 1000,
      },
    ],
    enabledServerId: 'synthetic-rkey',
  };
  value.mcp.token = 'synthetic-mcp-secret';
  return value;
}

it('应用设置与 API 分区独立，快照不改原值或夹带运行票据', () => {
  const source = settings();
  const original = structuredClone(source);
  const app = snapshotWeqSettings(source);
  const api = snapshotWeqApiSettings(source);
  expect(() => validateWeqAppSettings(app)).not.toThrow();
  expect(() => validateWeqApiSettings(api)).not.toThrow();
  expect(JSON.stringify(app)).not.toContain('secret');
  expect(JSON.stringify(api)).toContain('synthetic-api-secret');
  expect(JSON.stringify(api)).toContain('synthetic-mcp-secret');
  expect(JSON.stringify(api)).not.toContain('ticket');
  expect(source).toEqual(original);
  app.linkPreview.enabled = false;
  api.agentLab.providers[0]!.apiKey = 'changed';
  expect(source).toEqual(original);
});

it('允许部分设置恢复，并校验嵌套类型与现有分页规则', () => {
  expect(() =>
    validateWeqAppSettings({
      renderTextMarkdown: false,
      appLock: { method: 'system' },
      toastDurations: { failureSeconds: -1 },
      qzonePagination: { windowSeconds: 20 },
    }),
  ).not.toThrow();
  for (const value of [
    null,
    [],
    'broken',
    { realtimeEnabled: 'false' },
    { appLock: [] },
    { toastDurations: { successSeconds: 0 } },
    { qzonePagination: { maxPages: 0 } },
    { weqAssistant: { port: 65536 } },
    { autoLockMinutes: -1 },
    { logRetentionDays: MAX_LOG_RETENTION_DAYS + 1 },
    { exportSaveMode: 'arbitrary' },
    { windowCloseBehavior: 'hide' },
    { appLock: { method: 'password' } },
  ]) {
    expect(() => validateWeqAppSettings(value)).toThrow('字段无效');
  }
});

it('设置分区不能注入 API、根目录或锁密钥，资源重复引用必须一致', () => {
  for (const value of [
    { agentLab: { providers: [] } },
    { cacheDirOverride: '/synthetic' },
    { totpSecret: 'synthetic-private-secret' },
    { voiceTranscribe: { ttsProviders: [] } },
    { modelResources: { voice: 'a' }, voiceTranscribe: { modelId: 'b' } },
    { modelResources: { ocr: 'a' }, ocr: { modelId: 'b' } },
  ]) {
    expect(() => validateWeqAppSettings(value)).toThrow('字段无效');
  }
});

it('提供方保留同名不同 ID，拒绝重复标识和无效模型字段', () => {
  const api = snapshotWeqApiSettings(settings());
  api.agentLab.providers.push({ ...api.agentLab.providers[0]!, id: 'synthetic-other' });
  expect(() => validateWeqApiSettings(api)).not.toThrow();
  api.agentLab.providers[1]!.id = api.agentLab.providers[0]!.id;
  expect(() => validateWeqApiSettings(api)).toThrow('重复标识');
  for (const models of [
    [{ id: 'model', capabilities: ['audio'] }],
    [{ id: 123, capabilities: [] }],
    [{ id: 'model', capabilities: 'chat' }],
  ]) {
    const value = snapshotWeqApiSettings(settings());
    expect(() =>
      validateWeqApiSettings({
        ...value,
        agentLab: { providers: [{ ...value.agentLab.providers[0], models }] },
      }),
    ).toThrow('字段无效');
  }
});

it('拒绝无效端口、类型、启用引用、未知凭据字段及运行票据', () => {
  for (const value of [
    { mcp: { enabled: true, port: 0, token: '' } },
    { mcp: { enabled: 'true', port: 1000, token: '' } },
    { externalRkey: { servers: [], enabledServerId: 'missing' } },
    { ssePush: { servers: [], enabledServerId: null, debounceMs: 1, massThreshold: 100 } },
    { apiKey: 'synthetic' },
    {
      ttsProviders: [
        {
          id: 'a',
          name: 'a',
          vendor: 'unknown',
          baseUrl: 'http://synthetic',
          apiKey: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
  ]) {
    expect(() => validateWeqApiSettings(value)).toThrow('字段无效');
  }
  const api = snapshotWeqApiSettings(settings());
  expect(() =>
    validateWeqApiSettings({
      externalRkey: {
        ...api.externalRkey,
        servers: [{ ...api.externalRkey.servers[0], privateRkey: 'synthetic-ticket' }],
      },
    }),
  ).toThrow('字段无效');
});

it('账号快照保留解密与偏好配置，但不复用别处在线身份', () => {
  const value = {
    configId: '10001',
    uin: '10001',
    dbKey: 'synthetic-db-key',
    algos: { 'nt_msg.db': { pageHmacAlgorithm: 'HMAC_SHA1', kdfHmacAlgorithm: 'HMAC_SHA1' } },
    lastLoginAt: 1,
    mailNotifications: true,
    groupKeyword: { '12345': { keywords: [{ keyword: '合成词', memberUids: ['u_synthetic'] }] } },
    qqOnline: true,
    qqPid: 1234,
    session: { a2: 'synthetic-runtime', fetchedAt: 1 },
    rkeys: [],
    clientKey: { clientKey: 'synthetic-client-key', keyIndex: '0', ttlSeconds: 30, fetchedAt: 1 },
    loginPskey: { 'synthetic.invalid': 'synthetic-ticket' },
  };
  const saved = snapshotWeqAccount(value);
  expect(() => validateWeqAccountSettings(saved, '10001')).not.toThrow();
  expect(saved.dbKey).toBe(value.dbKey);
  expect(saved.groupKeyword).toEqual(value.groupKeyword);
  for (const key of ['qqOnline', 'qqPid', 'session', 'rkeys', 'clientKey', 'loginPskey'])
    expect(Object.hasOwn(saved, key)).toBe(false);
  expect(value.qqOnline).toBe(true);
});

it('账号字段和身份需匹配，不接受数据库路径注入或损坏偏好', () => {
  const base = { configId: '10001', uin: '10001', dbKey: '', algos: {}, lastLoginAt: 1 };
  for (const patch of [
    { uin: '10002' },
    { dbKey: 123 },
    { dataDir: {} },
    { lastLoginAt: 'now' },
    { algos: { '../nt_msg.db': {} } },
    { algos: { 'nt_msg.db': { pageHmacAlgorithm: [] } } },
    { annualReport: 'invalid' },
    { homeDress: { tags: 'invalid' } },
    { groupKeyword: { 'not-group': { keywords: [] } } },
    { mailShowUnread: 'yes' },
  ]) {
    expect(() => validateWeqAccountSettings({ ...base, ...patch }, '10001')).toThrow('字段无效');
  }
});
