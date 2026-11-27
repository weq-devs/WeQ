import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_INTENT_SENSE_CONFIG,
  mergeAssistantConfig,
} from '@weq/service';
import type { AppSettings } from '@weq/service';
import { SETTINGS_RESET_CARDS, resetCards } from '../src/shared/settings_reset';
import { settingsResetRouter } from '../src/main/ipc/routers/settings_reset';
import { sharedSettingsRouter } from '../src/main/ipc/routers/shared_settings';
import { SETTINGS_FIELDS } from '@weq/service/settings-catalog';
import { preferenceDefaults } from '@weq/service/client-preferences';
import { DEFAULT_MONITOR_SETTINGS, type MonitorSettings } from '@weq/service/performance';

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  calls: [] as Array<[string, unknown]>,
  fail: '',
  account: false,
  source: 'synthetic-source',
  monitor: {} as MonitorSettings,
  intent: {} as Record<string, unknown>,
  proxyEnabled: false,
  notifications: {} as Record<string, unknown>,
  nativeDebug: false,
  remote: { enabled: false, tailscaleEnabled: false },
  autostart: { enabled: false, registered: false, requiresApproval: false },
  logTargets: [] as string[],
}));
vi.mock('../src/main/log_retention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/log_retention')>()),
  planDefaultLogRetention: () =>
    state.logTargets.length
      ? {
          targets: new Set(state.logTargets),
          identities: new Map(state.logTargets.map((path) => [path, path])),
          preview: { expiredFiles: state.logTargets.length, capacityFiles: 0, bytes: 0 },
        }
      : null,
}));
vi.mock('../src/main/qq_sync/runtime', () => ({
  isQqSyncProxyEnabled: () => state.proxyEnabled,
}));
vi.mock('@weq/service/performance', async (importOriginal) => {
  const real = await importOriginal<typeof import('@weq/service/performance')>();
  return {
    ...real,
    getPerformanceMonitor: () => ({
      ready: Promise.resolve(),
      settings: state.monitor,
      resetRecordingMode: async () => {
        state.calls.push(['resetRecordingMode', null]);
        state.monitor.mode = real.DEFAULT_MONITOR_SETTINGS.mode;
      },
    }),
  };
});
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
      replaceSharedPreference: (key: keyof AppSettings['sharedPreferences'], value: object) =>
        Object.assign(state.settings.sharedPreferences, { [key]: value }),
    },
  }),
  closeSalvageConnections: vi.fn(),
  getAppContext: () => ({
    bootstrap: {
      enhancements: { updates: { ready: async () => {} }, packs: { isPreparing: () => false } },
      userConfig: {
        getSettings: () => state.settings,
        setSettings: (patch: { modelResources: Partial<AppSettings['modelResources']> }) =>
          Object.assign(state.settings.modelResources, patch.modelResources),
        getAutoEnter: () => null,
        getSharedPreference: (key: keyof AppSettings['sharedPreferences']) =>
          state.settings.sharedPreferences[key] ?? {},
      },
    },
    account: state.account ? { context: { uin: 'synthetic' } } : undefined,
    platform: {
      native: {
        ntHelper: {
          isDebugLogEnabled: () => state.nativeDebug,
          setDebugLog: (enabled: boolean) => {
            state.nativeDebug = enabled;
          },
        },
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
            if (name === 'getSettings')
              return {
                ...state.settings,
              };
            if (name === 'getAutostartStatus') return state.autostart;
            state.calls.push([name, input]);
            if (name === state.fail) throw new Error('合成写入失败');
            if (name === 'setQzonePagination')
              state.settings.qzonePagination = input as AppSettings['qzonePagination'];
            if (name === 'setQzoneNamePriority')
              state.settings.qzoneNamePriority = (
                input as { priority: AppSettings['qzoneNamePriority'] }
              ).priority;
            if (name === 'setCallRecording') Object.assign(state.settings.callRecording, input);
            if (name === 'setSsePushTuning') Object.assign(state.settings.ssePush, input);
            if (name === 'setQqCapabilityMode') {
              state.proxyEnabled = false;
              state.settings.qqCapabilityMode = (
                input as { mode: AppSettings['qqCapabilityMode'] }
              ).mode;
              return { status: 'saved' };
            }
            if (name === 'setAutostart') {
              state.autostart = { enabled: false, registered: false, requiresApproval: false };
              return state.autostart;
            }
            if (name === 'saveOneBotConfig') {
              state.settings.oneBotByUin.synthetic = (
                input as { config: AppSettings['oneBotByUin'][string] }
              ).config;
              return { daemonCheck: null };
            }
            if (name === 'setAiImagePreference') {
              const { feature, mode } = input as {
                feature: keyof AppSettings['aiImages'];
                mode: AppSettings['aiImages']['assistant'];
              };
              state.settings.aiImages[feature] = mode;
            }
            return { enabled: false };
          },
        },
      ),
  },
}));
vi.mock('../src/main/ipc/routers/remote', () => ({
  remoteRouter: {
    createCaller: () => ({
      webStatus: async () => ({ enabled: false }),
      status: async () => ({
        enabled: false,
        configuredEnabled: state.remote.enabled,
        tailscaleEnabled: state.remote.tailscaleEnabled,
      }),
      setEnabled: async ({ enabled }: { enabled: boolean }) => {
        state.remote.enabled = enabled;
      },
      setTailscaleEnabled: async ({ enabled }: { enabled: boolean }) => {
        state.remote.tailscaleEnabled = enabled;
      },
    }),
  },
}));
vi.mock('../src/main/ipc/routers/update', () => ({ updateRouter: { createCaller: () => ({}) } }));
vi.mock('../src/main/ipc/routers/client_state', () => ({
  clientStateRouter: {
    createCaller: () => ({
      accountSnapshot: async () => ({ records: { notifications: state.notifications } }),
      accountPatch: async ({ values }: { values: Record<string, null> }) => {
        for (const key of Object.keys(values)) delete state.notifications[key];
      },
      patch: async (patch: object) => {
        state.calls.push(['clientPreferences', patch]);
        state.settings.sharedPreferences.client ??= {};
        Object.assign(state.settings.sharedPreferences.client, patch);
      },
    }),
  },
}));

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_APP_SETTINGS);
  state.calls = [];
  state.fail = '';
  state.account = false;
  state.source = 'synthetic-source';
  state.monitor = { ...DEFAULT_MONITOR_SETTINGS };
  state.intent = structuredClone(DEFAULT_INTENT_SENSE_CONFIG);
  state.proxyEnabled = false;
  state.notifications = {};
  state.nativeDebug = false;
  state.remote = { enabled: false, tailscaleEnabled: false };
  state.autostart = { enabled: false, registered: false, requiresApproval: false };
  state.logTargets = [];
});
const rawCaller = () => settingsResetRouter.createCaller({});
const caller = () => {
  const api = rawCaller();
  return {
    preview: api.preview,
    restore: async ({
      page,
      card,
      revision,
      ...selection
    }: Omit<Parameters<typeof api.restore>[0], 'revision'> & { revision?: string }) => {
      const target = { page, ...(card ? { card } : {}) };
      return api.restore({
        ...target,
        ...selection,
        revision: revision ?? (await api.preview(target)).revision,
      });
    },
  };
};
describe('分级恢复默认', () => {
  it('应用日志的时长和容量一起恢复，只接受最新的删除确认', async () => {
    const api = rawCaller();
    const target = { page: 'logs' } as const;
    state.settings.logRetentionDays = 0;
    state.settings.logCapacityMiB = 0;
    state.logTargets = ['synthetic-one'];
    const preview = await api.preview(target);
    expect(preview.logPrune).toMatchObject({ expiredFiles: 1, capacityFiles: 0 });
    const input = { ...target, source: preview.source, revision: preview.revision };
    await expect(api.restore(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    state.logTargets = ['synthetic-two'];
    await expect(
      api.restore({ ...input, pruneConfirmation: preview.logPrune?.confirmation }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.calls).toEqual([]);
    const reread = await api.preview(target);
    const confirmation = reread.logPrune?.confirmation;
    expect(
      await api.restore({ ...input, revision: reread.revision, pruneConfirmation: confirmation }),
    ).toEqual([
      { id: 'logs:logRetentionDays', ok: true },
      { id: 'logs:logCapacityMiB', ok: true },
    ]);
    expect(state.calls).toEqual([
      [
        'setLogRetentionDays',
        {
          days: DEFAULT_APP_SETTINGS.logRetentionDays,
          capacityMiB: DEFAULT_APP_SETTINGS.logCapacityMiB,
          confirmPrune: true,
          pruneConfirmation: confirmation,
        },
      ],
    ]);
  });
  it('预览后切至完整模式时须重读档位再恢复', async () => {
    const api = rawCaller();
    const target = { page: 'account', card: 'attach' } as const;
    const preview = await api.preview(target);
    state.proxyEnabled = true;
    state.settings.qqCapabilityMode = 'complete';
    await expect(
      api.restore({ ...target, source: preview.source, revision: preview.revision }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.proxyEnabled).toBe(true);
    const reread = await api.preview(target);
    expect(reread.items).toContainEqual(
      expect.objectContaining({ id: 'attach:qqCapabilityMode', current: 'complete' }),
    );
    expect(
      await api.restore({ ...target, source: reread.source, revision: reread.revision }),
    ).toEqual([{ id: 'attach:qqCapabilityMode', ok: true }]);
    expect(state.proxyEnabled).toBe(false);
  });
  it('开机自启正在等待系统批准时可以取消已登记的登录项', async () => {
    const api = rawCaller();
    const target = { page: 'startup', card: 'startup-system' } as const;
    state.autostart = { enabled: false, registered: true, requiresApproval: true };
    const preview = await api.preview(target);
    expect(preview.items).toContainEqual(
      expect.objectContaining({ id: 'startup-system:autostart', current: 'requiresApproval' }),
    );
    expect(
      await api.restore({ ...target, source: preview.source, revision: preview.revision }),
    ).toEqual([{ id: 'startup-system:autostart', ok: true }]);
    expect(state.autostart.registered).toBe(false);
  });
  it('防撤回默认保护全部会话，恢复时替换已保存的范围', async () => {
    const recall = sharedSettingsRouter.createCaller({}).antiRecall;
    expect(await recall.getStatus()).toMatchObject({ enabled: false, mode: 'all' });
    expect(await recall.setScope({ scope: 'off' })).toMatchObject({ enabled: false, mode: 'all' });
    expect(await recall.setMethod({ method: 'weq' })).toMatchObject({ enabled: true, mode: 'all' });
    await recall.setMode({ mode: 'selected' });
    const target = { page: 'anti-recall', card: 'recall-scope' } as const;
    const preview = await caller().preview(target);
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        id: 'recall-scope:scope',
        current: 'selected',
        defaultValue: 'all',
      }),
    );
    expect(await caller().restore({ ...target, source: preview.source })).toContainEqual({
      id: 'recall-scope:scope',
      ok: true,
    });
    expect(await recall.getStatus()).toMatchObject({ enabled: false, mode: 'all' });
  });
  it('各 AI 页恢复本功能的图片与模型偏好，日志页复位档位和原生调试开关', async () => {
    Object.assign(state.settings.aiImages, {
      intent: 'ocr',
      suggestions: 'vision',
      profile: 'ocr',
    });
    state.settings.modelResources.intent = 'laya-multilingual';
    for (const [page, feature, previous] of [
      ['intent-sense', 'intent', 'ocr'],
      ['reply-suggestions', 'suggestions', 'vision'],
      ['interaction-profile', 'profile', 'ocr'],
    ] as const) {
      expect(state.settings.aiImages[feature]).toBe(previous);
      await caller().restore({ page, source: null });
      expect(state.settings.aiImages[feature]).toBe(DEFAULT_APP_SETTINGS.aiImages[feature]);
    }
    expect(state.settings.modelResources.intent).toBe(DEFAULT_APP_SETTINGS.modelResources.intent);
    state.monitor.mode = 'off';
    state.nativeDebug = true;
    await caller().restore({ page: 'logs', source: null });
    expect(state.nativeDebug).toBe(false);
    expect(state.monitor.mode).toBe(DEFAULT_MONITOR_SETTINGS.mode);
    expect(state.calls).toContainEqual(['resetRecordingMode', null]);
  });
  it('助手页面恢复通用选项并保留外部 MCP 连接', async () => {
    const mcpServers = 'synthetic= https://example.invalid/synthetic-mcp-secret';
    const defaults = mergeAssistantConfig({}, { mcpServers });
    state.settings.sharedPreferences.assistant = {
      sendMode: 'queue',
      customPrompt: 'synthetic-prompt',
      localLightweight: true,
      mcpServers,
      model: { providerId: 'synthetic', model: 'synthetic-model' },
    };
    state.settings.aiImages.assistant = 'ocr';
    const input = { page: 'weq-assistant' } as const;
    const preview = await caller().preview(input);
    expect(JSON.stringify(preview)).not.toMatch(/synthetic-prompt|synthetic-mcp-secret/);
    expect(await caller().restore({ ...input, source: preview.source })).toEqual([
      { id: 'assistant-config:config', ok: true },
      { id: 'assistant-images:mode', ok: true },
    ]);
    expect(state.settings.sharedPreferences.assistant).toEqual(defaults);
    expect(state.settings.aiImages.assistant).toBe(DEFAULT_APP_SETTINGS.aiImages.assistant);
  });
  it('QQ 能力档位在宿主内共用，切换账号后仍恢复同一份设定', async () => {
    state.account = true;
    state.settings.qqCapabilityMode = 'complete';
    const target = { page: 'account', card: 'attach' } as const;
    const api = rawCaller();
    const preview = await api.preview(target);
    state.source = 'other-source';
    expect(
      await api.restore({ ...target, source: preview.source, revision: preview.revision }),
    ).toEqual([{ id: 'attach:qqCapabilityMode', ok: true }]);
    expect(state.settings.qqCapabilityMode).toBe('local');
  });
  it('通知页清除当前账号的事件提醒范围，保留会话免打扰', async () => {
    state.account = true;
    state.notifications = {
      specialCare: { mode: 'nonMuted', targets: [] },
      mentionMe: { mode: 'selected', targets: ['group:synthetic'] },
      'override:redPacket:group:synthetic': false,
      'mute:assistant:synthetic': true,
    };
    const input = { page: 'global', card: 'notification-scopes' } as const;
    const preview = await caller().preview(input);
    expect(JSON.stringify(preview)).not.toContain('group:synthetic');
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        id: 'notification-scopes:specialCare',
        defaultValue: { mode: 'all', count: 0, overrides: 0 },
      }),
    );
    await caller().restore({ ...input, source: preview.source });
    expect(state.notifications).toEqual({ 'mute:assistant:synthetic': true });
  });
  it('OneBot 页面停用连接并保留端点与令牌，预览不带连接详情', async () => {
    state.account = true;
    const network = {
      name: 'synthetic',
      enabled: true,
      port: 19093,
      accessToken: 'synthetic-token',
      messageFormat: 'array',
      reportSelfMessage: false,
    } as const;
    state.settings.oneBotByUin.synthetic = {
      networks: { wsServers: [network], wsClients: [], httpServers: [], httpClients: [] },
    };
    const input = { page: 'onebot' } as const;
    const preview = await caller().preview(input);
    expect(preview.items).toMatchObject([{ current: 1, defaultValue: 0 }]);
    await caller().restore({ ...input, source: preview.source });
    expect(state.settings.oneBotByUin.synthetic.networks.wsServers).toEqual([
      { ...network, enabled: false },
    ]);
  });
  it('Remote 已保存开关可恢复，即使网络服务未启动', async () => {
    state.remote = { enabled: true, tailscaleEnabled: true };
    await caller().restore({ page: 'remote', source: null });
    expect(state.remote).toEqual({ enabled: false, tailscaleEnabled: false });
  });
  it('只在状态提醒页恢复统一提示和在线通知方式', async () => {
    state.settings.qqStatusIndicatorEnabled = false;
    state.settings.notificationEvents.runtime = { banner: false, system: true };
    const input = { page: 'qq-status-reminders', card: 'qq-status-reminders' } as const;
    const account = await caller().preview({ page: 'account', card: 'attach' });
    expect(account.items.some((item) => item.id.includes('Indicator'))).toBe(false);
    const preview = await caller().preview(input);
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        id: 'qq-status-reminders:qqStatusIndicatorEnabled',
        current: false,
        defaultValue: true,
      }),
    );
    await caller().restore({ ...input, source: null });
    expect(state.calls).toEqual([
      ['setQqStatusIndicatorEnabled', { enabled: true }],
      [
        'setNotificationEvents',
        { events: ['runtime'], channels: DEFAULT_APP_SETTINGS.notificationEvents.runtime },
      ],
    ]);
  });
  it('所有登记的全局恢复字段均有真实适配器，不依赖设置控件是否挂载', async () => {
    const api = settingsResetRouter.createCaller({ authorize: () => {} });
    for (const page of new Set(SETTINGS_RESET_CARDS.map(([page]) => page))) {
      const preview = await api.preview({ page });
      const cards = new Set(resetCards({ page }).map(([, card]) => card));
      for (const field of SETTINGS_FIELDS.filter(
        (field) =>
          cards.has(field.card) &&
          field.scope === '全局' &&
          !field.desktopOnly &&
          field.id !== 'onebot:config',
      ))
        expect(
          preview.items.some((item) => item.id === field.id),
          field.id,
        ).toBe(true);
    }
    expect(state.calls).toEqual([]);
  });
  it('斜杠表情、全部会话范围和 OCR 偏好均从统一字段目录恢复', async () => {
    state.settings.sharedPreferences.client = {
      slashEmojiEnabled: false,
      slashEmojiAutoReplace: true,
      allConversationsIncludeHidden: true,
      allConversationsIncludeDeleted: true,
    };
    state.settings.ocr.prefilterEnabled = true;
    state.settings.ocr.autoDownloadOriginal = true;
    for (const page of ['chat-interaction', 'chat-messages', 'recognition'] as const)
      await caller().restore({ page, source: null });
    for (const key of [
      'slashEmojiEnabled',
      'slashEmojiAutoReplace',
      'allConversationsIncludeHidden',
      'allConversationsIncludeDeleted',
    ] as const)
      expect(state.calls).toContainEqual(['clientPreferences', { [key]: preferenceDefaults[key] }]);
    expect(state.calls).toContainEqual([
      'setOcrPrefilterEnabled',
      { enabled: DEFAULT_APP_SETTINGS.ocr.prefilterEnabled },
    ]);
    expect(state.calls).toContainEqual(['setOcrAutoDownloadOriginal', { enabled: false }]);
  });
  it('窗口外观和关闭行为随各自页面恢复，不再互相影响', async () => {
    state.settings.windowsStyleControls = true;
    state.settings.windowCloseBehavior = 'quit';
    const appearance = await caller().preview({ page: 'appearance' });
    const startup = await caller().preview({ page: 'startup' });
    const notifications = await caller().preview({ page: 'global' });
    expect(appearance.items.map((item) => item.id)).toContain(
      'window-appearance:windowsStyleControls',
    );
    expect(appearance.items.map((item) => item.id)).not.toContain('window:windowCloseBehavior');
    expect(startup.items.map((item) => item.id)).toContain('window:windowCloseBehavior');
    expect(startup.items.map((item) => item.id)).not.toContain(
      'window-appearance:windowsStyleControls',
    );
    expect(notifications.items.some((item) => item.id.startsWith('window'))).toBe(false);
    state.calls = [];
    await caller().restore({ page: 'appearance', card: 'window-appearance', source: null });
    expect(state.calls).toEqual([
      ['setWindowsStyleControls', { enabled: DEFAULT_APP_SETTINGS.windowsStyleControls }],
    ]);
    state.calls = [];
    await caller().restore({ page: 'startup', card: 'window', source: null });
    expect(state.calls).toEqual([
      ['setWindowCloseBehavior', { behavior: DEFAULT_APP_SETTINGS.windowCloseBehavior }],
    ]);
  });
  it.each([
    [
      'message-display',
      'message-content',
      { showGroupMemberName: false, showGroupMemberLevel: false, showGroupMemberTitle: false },
    ],
    [
      'chat-interaction',
      'quote-replies',
      { autoMentionOnQuote: true, backspaceRemovesQuote: false },
    ],
  ] as const)('%s 恢复包含新增设置且不改其他偏好', async (page, card, patch) => {
    state.settings.sharedPreferences.client = { ...patch, mailListWidth: 400 };
    const preview = await caller().preview({ page, card });
    const changed = preview.items.filter(
      (item) => JSON.stringify(item.current) !== JSON.stringify(item.defaultValue),
    );
    expect(changed.map((item) => item.id)).toEqual(
      Object.keys(patch).map((key) => `${card}:${key}`),
    );
    expect(changed.every((item) => item.scope === '全局')).toBe(true);
    expect(state.calls).toEqual([]);
    await caller().restore({ page, card, source: null });
    expect(state.calls).toHaveLength(Object.keys(patch).length);
    for (const item of changed) {
      expect(state.calls).toContainEqual([
        'clientPreferences',
        { [item.id.split(':')[1]!]: item.defaultValue },
      ]);
    }
    expect(state.settings.sharedPreferences.client.mailListWidth).toBe(400);
  });
  it('API 默认模型与容量缺省值独立恢复，不改服务商', async () => {
    state.settings.agentLab.defaultModel = { providerId: 'p', model: 'chat' };
    state.settings.agentLab.defaultVisionModel = { providerId: 'p', model: 'vision' };
    state.settings.agentLab.defaultEmbeddingModel = { providerId: 'p', model: 'embedding' };
    state.settings.agentLab.defaultContextWindowTokens = 240_000;
    state.settings.agentLab.defaultMaxOutputTokens = null;
    const preview = await caller().preview({ page: 'agentlab', card: 'api-default' });
    expect(preview.items.map((item) => item.label)).toEqual([
      '默认聊天模型',
      '默认视觉模型',
      '默认向量模型',
      '默认上下文窗口',
      '默认最大输出',
    ]);
    await caller().restore({ page: 'agentlab', card: 'api-default', source: null });
    expect(state.calls).toEqual([
      ['setAgentLabDefaultModel', { ref: null }],
      ['setDefaultVisionModel', { ref: null }],
      ['setDefaultEmbeddingModel', { ref: null }],
      [
        'setAgentLabModelTokenDefaults',
        { defaultContextWindowTokens: DEFAULT_APP_SETTINGS.agentLab.defaultContextWindowTokens },
      ],
      [
        'setAgentLabModelTokenDefaults',
        { defaultMaxOutputTokens: DEFAULT_APP_SETTINGS.agentLab.defaultMaxOutputTokens },
      ],
    ]);
  });
  it('历史消息补全的恢复预览包含条件隐藏的配置，打开会话的恢复不包含它们', async () => {
    state.settings.sharedPreferences.client = {
      autoFetchMissingMessages: true,
      autoFetchMissingContext: true,
      missingMessageContextCount: 80,
    };
    const preview = await caller().preview({ page: 'message-display', card: 'missing-messages' });
    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'missing-messages:autoFetchMissingMessages',
          current: true,
          defaultValue: false,
        }),
        expect.objectContaining({
          id: 'missing-messages:autoFetchMissingContext',
          current: true,
          defaultValue: false,
        }),
        expect.objectContaining({ id: 'missing-messages:missingMessageContextCount', current: 80 }),
      ]),
    );
    const opening = await caller().preview({ page: 'message-display', card: 'reading' });
    expect(opening.items.map(({ id }) => id)).not.toContain(
      'missing-messages:missingMessageContextCount',
    );
  });
  it('会话列表恢复默认不改写消息阅读设置', async () => {
    const preview = await caller().preview({ page: 'chat-messages' });
    expect(preview.items.some((item) => item.id.startsWith('unread:'))).toBe(false);
    await caller().restore({ page: 'chat-messages', source: null });
    expect(state.calls.some(([method]) => method === 'setReadFromFirstUnread')).toBe(false);
  });
  it('稳定卡片 ID 唯一，跨页面卡片与任意配置键拒绝', async () => {
    expect(resetCards({ page: 'global' }).map(([, id]) => id)).toContain('notification-events');
    expect(resetCards({ page: 'chat-messages' }).map(([, id]) => id)).not.toContain(
      'notification-events',
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
  it('应用图标、导航、菜单和联系人角标按新归属恢复默认', async () => {
    state.settings.sharedPreferences.client = {
      showContactNavigationBadge: false,
      showContactRequestBadge: false,
    };
    const global = await caller().preview({ page: 'global' });
    expect(global.items.map((item) => item.id)).toContain('notification-events:notificationEvents');
    expect(global.items.map((item) => item.id)).toContain('application-badge:application-badge');
    expect(global.items.some((item) => /^(navigation|menu|contact)-badges:/.test(item.id))).toBe(
      false,
    );
    expect(global.items.some((item) => item.id.startsWith('damage-reminder:'))).toBe(false);
    for (const page of [
      'mail',
      'account',
      'database-management',
      'chat-messages',
      'chat-interaction',
      'privacy',
    ] as const) {
      const old = await caller().preview({ page });
      expect(
        old.items.some((item) =>
          /^(notification-events|application-badge|navigation-badges|menu-badges|contact-badges|damage-reminder|recall-notifications|web-notifications):/.test(
            item.id,
          ),
        ),
      ).toBe(false);
    }
    const navigation = await caller().preview({ page: 'main-navigation' });
    expect(navigation.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'navigation-badges:showMessageUnreadBadge',
        'navigation-badges:showContactNavigationBadge',
        'navigation-badges:unread',
        'menu-badges:showSoftwareUpdateBadge',
      ]),
    );
    expect(navigation.items.every((item) => /^(navigation|menu)-badges:/.test(item.id))).toBe(true);
    const menu = await caller().preview({ page: 'main-navigation', card: 'menu-badges' });
    expect(menu.items).toEqual(
      navigation.items.filter((item) => item.id.startsWith('menu-badges:')),
    );
    const contacts = await caller().preview({ page: 'contacts' });
    expect(contacts.items.map((item) => item.id)).toEqual([
      'contact-badges:showContactUnreadCount',
      'contact-badges:showContactRequestBadge',
    ]);
    await caller().restore({ page: 'main-navigation', source: null });
    expect(state.settings.sharedPreferences.client).toMatchObject({
      showContactNavigationBadge: true,
      showContactRequestBadge: false,
    });
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
  it('空间人物设置可恢复备注优先，不修改翻页设置', async () => {
    state.settings.qzoneNamePriority = 'nickname';
    state.settings.qzonePagination = { windowSeconds: 30, maxPages: 12 };
    const target = { page: 'qzone', card: 'qzone-person' } as const;
    const preview = await caller().preview(target);
    expect(preview.items).toContainEqual(
      expect.objectContaining({ id: 'qzone-person:qzoneNamePriority', defaultValue: 'remark' }),
    );
    await caller().restore({ ...target, source: null });
    expect(state.settings.qzoneNamePriority).toBe('remark');
    expect(state.settings.qzonePagination).toEqual({ windowSeconds: 30, maxPages: 12 });
  });
  it('聊天图片预览和省流量模式各自恢复默认', async () => {
    state.settings.sharedPreferences.client = {
      autoDownloadPreviewOriginal: true,
      dataSaverMode: 'always',
    };
    const api = caller();
    const page = 'resource-loading';
    const preview = await api.preview({ page, card: 'chat-image-preview' });
    expect(preview.items).toMatchObject([{ current: true, defaultValue: false }]);
    await api.restore({ page, source: null });
    expect(state.settings.sharedPreferences.client.autoDownloadPreviewOriginal).toBe(false);
    expect(state.settings.sharedPreferences.client.dataSaverMode).toBe('always');
    state.settings.sharedPreferences.client.autoDownloadPreviewOriginal = true;
    await api.restore({ page: 'data-saver', source: null });
    expect(state.settings.sharedPreferences.client.dataSaverMode).toBe('auto');
    expect(state.settings.sharedPreferences.client.autoDownloadPreviewOriginal).toBe(true);
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
  it('已移除的账号级容错不再提供恢复字段', async () => {
    state.account = true;
    const preview = await caller().preview({ page: 'database-management' });
    expect(preview.items.some((item) => item.id.startsWith('db-tolerance:'))).toBe(false);
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
