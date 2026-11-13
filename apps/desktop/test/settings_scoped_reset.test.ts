import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, DEFAULT_INTENT_SENSE_CONFIG } from '@weq/service';
import type { AppSettings } from '@weq/service';
import { SETTINGS_RESET_CARDS, resetCards } from '../src/shared/settings_reset';
import { settingsResetRouter } from '../src/main/ipc/routers/settings_reset';

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  calls: [] as Array<[string, unknown]>,
  fail: '',
  account: false,
  source: 'synthetic-source',
  intent: {} as Record<string, unknown>,
}));
vi.mock('../src/main/context/app_context', () => ({
  getActiveIntentSenseLocalEngine: () => null,
  requireBootstrap: () => ({
    userConfig: {
      getSettings: () => state.settings,
      sharedPreferenceRevision: () => 0,
      getSharedPreference: (key: keyof AppSettings['sharedPreferences']) =>
        state.settings.sharedPreferences[key] ?? {},
      patchSharedPreference: (key: keyof AppSettings['sharedPreferences'], patch: object) =>
        Object.assign(state.settings.sharedPreferences, {
          [key]: { ...state.settings.sharedPreferences[key], ...patch },
        }),
    },
  }),
  closeSalvageConnections: vi.fn(),
  getAppContext: () => ({
    bootstrap: {
      userConfig: {
        getSettings: () => state.settings,
        getAutoEnter: () => null,
        getSharedPreference: (key: keyof AppSettings['sharedPreferences']) =>
          state.settings.sharedPreferences[key] ?? {},
      },
    },
    services: state.account
      ? {
          mail: { status: () => ({ lastSync: null }) },
          accountConfig: {
            getRecord: () => ({
              configId: state.source,
              dataDir: '/synthetic/data',
              uin: 'synthetic',
            }),
          },
          intentSense: {
            getStatus: () => state.intent,
            setConfig: async (patch: Record<string, unknown>) => {
              const next = { ...state.intent, ...patch };
              if (
                Number(next.profileSamples) > Number(next.profileMessages) ||
                Number(next.profileMinSamples) > Number(next.profileSamples)
              )
                throw new Error('画像范围冲突');
              state.calls.push(['intent', patch]);
              Object.assign(state.intent, patch);
              return state.intent;
            },
          },
        }
      : undefined,
  }),
}));
vi.mock('../src/main/ipc/routers/bootstrap', () => ({
  bootstrapRouter: {
    createCaller: () =>
      new Proxy(
        {},
        {
          get: (_target, method) => async (input: unknown) => {
            const name = String(method);
            state.calls.push([name, input]);
            if (name === state.fail) throw new Error('合成写入失败');
            if (name === 'setQzonePagination')
              state.settings.qzonePagination = input as AppSettings['qzonePagination'];
            if (name === 'setCallRecording') Object.assign(state.settings.callRecording, input);
            if (name === 'setSsePushTuning') Object.assign(state.settings.ssePush, input);
            return { enabled: false };
          },
        },
      ),
  },
}));
vi.mock('../src/main/ipc/routers/remote', () => ({ remoteRouter: { createCaller: () => ({}) } }));
vi.mock('../src/main/ipc/routers/update', () => ({ updateRouter: { createCaller: () => ({}) } }));

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_APP_SETTINGS);
  state.calls = [];
  state.fail = '';
  state.account = false;
  state.source = 'synthetic-source';
  state.intent = structuredClone(DEFAULT_INTENT_SENSE_CONFIG);
});
const caller = () => settingsResetRouter.createCaller({});
describe('分级恢复默认', () => {
  it('阅读定位恢复预览包含条件隐藏的上下文配置', async () => {
    state.settings.sharedPreferences.client = {
      autoFetchMissingMessages: true,
      autoFetchMissingContext: true,
      missingMessageContextCount: 80,
    };
    const preview = await caller().preview({ page: 'chat-messages', card: 'reading' });
    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'reading:autoFetchMissingMessages',
          current: true,
          defaultValue: false,
        }),
        expect.objectContaining({
          id: 'reading:autoFetchMissingContext',
          current: true,
          defaultValue: false,
        }),
        expect.objectContaining({ id: 'reading:missingMessageContextCount', current: 80 }),
      ]),
    );
  });
  it('已读上报随未读提醒卡片恢复，不影响阅读定位配置', async () => {
    state.settings.reportReadEnabled = false;
    state.settings.manualReadReportEnabled = false;
    const preview = await caller().preview({ page: 'chat-messages', card: 'unread' });
    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'unread:reportReadEnabled', current: false }),
        expect.objectContaining({ id: 'unread:manualReadReportEnabled', current: false }),
      ]),
    );
    expect(preview.items.every((item) => item.id.startsWith('unread:'))).toBe(true);
    await caller().restore({ page: 'chat-messages', card: 'unread', source: null });
    expect(state.calls).toContainEqual([
      'setReportReadEnabled',
      { enabled: DEFAULT_APP_SETTINGS.reportReadEnabled },
    ]);
    expect(state.calls).toContainEqual([
      'setManualReadReportEnabled',
      { enabled: DEFAULT_APP_SETTINGS.manualReadReportEnabled },
    ]);
    expect(state.calls.some(([method]) => method === 'setReadFromFirstUnread')).toBe(false);
  });
  it('稳定卡片 ID 唯一，跨页面卡片与任意配置键拒绝', async () => {
    expect(resetCards({ page: 'global' }).map(([, id]) => id)).toContain('message-notifications');
    expect(resetCards({ page: 'chat-messages' }).map(([, id]) => id)).not.toContain(
      'message-notifications',
    );
    expect(new Set(SETTINGS_RESET_CARDS.map(([, id]) => id)).size).toBe(
      SETTINGS_RESET_CARDS.length,
    );
    expect(() => resetCards({ page: 'qzone', card: 'home' })).toThrow();
    await expect(caller().preview({ page: 'qzone', card: 'home' })).rejects.toThrow();
    await expect(
      caller().restore({ page: 'qzone', source: null, directories: ['mcp:token'] }),
    ).rejects.toThrow('不属于当前范围');
    expect(state.calls).toEqual([]);
  });
  it('只读预览不写入，卡片恢复不影响同页其他配置或连接凭据', async () => {
    state.settings.qzonePagination = { windowSeconds: 30, maxPages: 12 };
    state.settings.qzonePersonClickAction = 'profile';
    state.settings.mcp.token = 'synthetic-token';
    const preview = await caller().preview({ page: 'qzone', card: 'qzone-pagination' });
    expect(state.calls).toEqual([]);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]!.defaultValue).toEqual(DEFAULT_APP_SETTINGS.qzonePagination);
    await caller().restore({ page: 'qzone', card: 'qzone-pagination', source: null });
    expect(state.settings.qzonePagination).toEqual(DEFAULT_APP_SETTINGS.qzonePagination);
    expect(state.settings.qzonePersonClickAction).toBe('profile');
    expect(state.settings.mcp.token).toBe('synthetic-token');
  });
  it('整页覆盖全部登记配置，自定义目录默认保留，显式选择才还原路径', async () => {
    state.settings.callRecording = {
      mode: 'self',
      systemAudio: true,
      dir: '/synthetic/recordings',
      udpTrace: true,
    };
    const preview = await caller().preview({ page: 'call-recording' });
    expect(preview.items.some((item) => item.directory)).toBe(true);
    await caller().restore({ page: 'call-recording', source: null });
    expect(state.settings.callRecording.dir).toBe('/synthetic/recordings');
    expect(state.settings.callRecording.mode).toBe(DEFAULT_APP_SETTINGS.callRecording.mode);
    await caller().restore({
      page: 'call-recording',
      source: null,
      directories: ['call-directory:dir'],
    });
    expect(state.settings.callRecording.dir).toBe(DEFAULT_APP_SETTINGS.callRecording.dir);
    expect(state.calls.every(([method]) => method.startsWith('setCall'))).toBe(true);
  });
  it('服务启用状态恢复默认，保留端口、目标地址与令牌，调优按现有默认值', async () => {
    state.settings.ssePush = {
      servers: [
        {
          id: 'synthetic',
          name: '合成',
          pushUrl: 'https://example.invalid',
          accessToken: 'synthetic-token',
        },
      ],
      enabledServerId: 'synthetic',
      debounceMs: 9000,
      massThreshold: 99,
    };
    const servers = structuredClone(state.settings.ssePush.servers);
    const preview = await caller().preview({ page: 'sse' });
    expect(preview.items.find((item) => item.id === 'sse-targets:enabled')?.stopsService).toBe(
      true,
    );
    await caller().restore({ page: 'sse', source: null });
    expect(state.calls).toContainEqual(['setSsePushEnabled', { serverId: null }]);
    expect(state.settings.ssePush.servers).toEqual(servers);
    expect(state.settings.ssePush.debounceMs).toBe(DEFAULT_APP_SETTINGS.ssePush.debounceMs);
  });
  it('局部失败不冒称全部成功，继续其余项目，重试仅处理失败项', async () => {
    state.settings.qzonePagination = { windowSeconds: 30, maxPages: 12 };
    state.settings.qzonePersonClickAction = 'profile';
    state.fail = 'setQzonePagination';
    const results = await caller().restore({ page: 'qzone', source: null });
    expect(results).toContainEqual(
      expect.objectContaining({ id: 'qzone-pagination:qzonePagination', ok: false }),
    );
    expect(state.calls.some(([method]) => method === 'setQzonePersonClickAction')).toBe(true);
    state.calls = [];
    state.fail = '';
    await caller().restore({
      page: 'qzone',
      source: null,
      retry: results.filter((item) => !item.ok).map((item) => item.id),
    });
    expect(state.calls.map(([method]) => method)).toEqual(['setQzonePagination']);
  });
  it('画像参数为全局设置，账号切换不改变其恢复目标', async () => {
    state.account = true;
    state.intent.profileEngine = 'heuristic';
    const preview = await caller().preview({ page: 'interaction-profile' });
    expect(preview.items.some((item) => item.id === 'profile-model:profileSamples')).toBe(true);
    expect(preview.items.every((item) => item.scope === '全局')).toBe(true);
    expect(preview.source).toBeNull();
    state.source = 'other-source';
    const result = await caller().restore({ page: 'interaction-profile', source: preview.source });
    expect(result.every((item) => item.ok)).toBe(true);
    expect(state.intent.profileEngine).toBe(DEFAULT_INTENT_SENSE_CONFIG.profileEngine);
  });
  it('数据源配置仍拒绝切号前的恢复目标', async () => {
    state.account = true;
    const preview = await caller().preview({ page: 'media', card: 'native-media' });
    state.source = 'other-source';
    await expect(
      caller().restore({ page: 'media', card: 'native-media', source: preview.source }),
    ).rejects.toThrow('已切换');
    expect(state.calls).toEqual([]);
  });
  it('整页画像参数成组恢复，不因中间状态违反范围约束而失败，保留单会话覆盖', async () => {
    state.account = true;
    const messages = DEFAULT_INTENT_SENSE_CONFIG.profileMessages * 2;
    Object.assign(state.intent, {
      profileMessages: messages,
      profileSamples: messages - 1,
      profileMinSamples: messages - 2,
      conversationOverrides: { synthetic: true },
    });
    const preview = await caller().preview({ page: 'interaction-profile' });
    const result = await caller().restore({ page: 'interaction-profile', source: preview.source });
    expect(result.every((item) => item.ok)).toBe(true);
    expect(state.calls.filter(([kind]) => kind === 'intent')).toHaveLength(1);
    expect(state.intent).toMatchObject({
      profileMessages: DEFAULT_INTENT_SENSE_CONFIG.profileMessages,
      profileSamples: DEFAULT_INTENT_SENSE_CONFIG.profileSamples,
      profileMinSamples: DEFAULT_INTENT_SENSE_CONFIG.profileMinSamples,
      conversationOverrides: { synthetic: true },
    });
  });
});
