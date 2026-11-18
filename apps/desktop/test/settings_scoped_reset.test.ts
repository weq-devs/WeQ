import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_INTENT_SENSE_CONFIG,
  mergeAssistantConfig,
} from '@weq/service';
import type { AppSettings } from '@weq/service';
import { SETTINGS_RESET_CARDS, resetCards } from '../src/shared/settings_reset';
import { settingsResetRouter } from '../src/main/ipc/routers/settings_reset';
import { SETTINGS_FIELDS } from '@weq/service/settings-catalog';
import { preferenceDefaults } from '@weq/service/client-preferences';

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
      replaceSharedPreference: (key: keyof AppSettings['sharedPreferences'], value: object) =>
        Object.assign(state.settings.sharedPreferences, { [key]: value }),
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
            if (name === 'setAiImagePreference') {
              const { feature, mode } = input as { feature: 'assistant'; mode: 'vision' };
              state.settings.aiImages[feature] = mode;
            }
            return { enabled: false };
          },
        },
      ),
  },
}));
vi.mock('../src/main/ipc/routers/remote', () => ({ remoteRouter: { createCaller: () => ({}) } }));
vi.mock('../src/main/ipc/routers/update', () => ({ updateRouter: { createCaller: () => ({}) } }));
vi.mock('../src/main/ipc/routers/client_state', () => ({
  clientStateRouter: {
    createCaller: () => ({
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
  state.intent = structuredClone(DEFAULT_INTENT_SENSE_CONFIG);
});
const caller = () => settingsResetRouter.createCaller({});
describe('分级恢复默认', () => {
  it('助手页面成组恢复联动参数与图片偏好，预览不返回原始提示词和 MCP 配置', async () => {
    const defaults = mergeAssistantConfig({}, {});
    state.settings.sharedPreferences.assistant = {
      sendMode: 'queue',
      customPrompt: 'synthetic-prompt',
      mcpServers: 'synthetic= https://example.invalid/synthetic-mcp-secret',
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
  it('QQ 在线能力卡片恢复右上角标记，不改变独立通知偏好', async () => {
    state.settings.restrictedModeIndicatorEnabled = false;
    state.settings.restrictedModeBannerEnabled = false;
    const preview = await caller().preview({ page: 'account', card: 'attach' });
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        id: 'attach:restrictedModeIndicatorEnabled',
        current: false,
        defaultValue: true,
      }),
    );
    await caller().restore({ page: 'account', card: 'attach', source: null });
    expect(state.calls).toContainEqual(['setRestrictedModeIndicatorEnabled', { enabled: true }]);
    expect(state.calls.some(([name]) => name === 'resetNotificationEvents')).toBe(false);
    expect(state.settings.restrictedModeBannerEnabled).toBe(false);
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
          field.id !== 'onebot-servers:servers',
      ))
        expect(
          preview.items.some((item) => item.id === field.id),
          field.id,
        ).toBe(true);
    }
    expect(state.calls).toEqual([]);
  });
  it('斜杠表情、全部会话范围和 OCR 筛图均从统一字段目录恢复', async () => {
    state.settings.sharedPreferences.client = {
      slashEmojiEnabled: false,
      slashEmojiAutoReplace: true,
      allConversationsIncludeHidden: true,
      allConversationsIncludeDeleted: true,
    };
    state.settings.ocr.prefilterEnabled = false;
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
  it('阅读定位恢复预览包含条件隐藏的上下文配置', async () => {
    state.settings.sharedPreferences.client = {
      autoFetchMissingMessages: true,
      autoFetchMissingContext: true,
      missingMessageContextCount: 80,
    };
    const preview = await caller().preview({ page: 'message-display', card: 'reading' });
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
  it('会话列表恢复默认不改写已移除的已读上报设置', async () => {
    state.settings.reportReadEnabled = false;
    state.settings.manualReadReportEnabled = false;
    const preview = await caller().preview({ page: 'chat-messages' });
    expect(preview.items.some((item) => item.id.startsWith('unread:'))).toBe(false);
    await caller().restore({ page: 'chat-messages', source: null });
    expect(state.calls.some(([method]) => method === 'setReportReadEnabled')).toBe(false);
    expect(state.calls.some(([method]) => method === 'setManualReadReportEnabled')).toBe(false);
    expect(state.settings.reportReadEnabled).toBe(false);
    expect(state.settings.manualReadReportEnabled).toBe(false);
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
  it('通知与红点迁移后，旧功能页恢复不再修改通知偏好', async () => {
    const global = await caller().preview({ page: 'global' });
    expect(global.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'notification-badges:showMessageUnreadBadge',
        'notification-badges:showContactUnreadCount',
        'notification-events:notificationEvents',
        'notification-badges:unread',
      ]),
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
          /^(notification-events|notification-badges|damage-reminder|recall-notifications|web-notifications):/.test(
            item.id,
          ),
        ),
      ).toBe(false);
    }
    const badges = await caller().preview({ page: 'global', card: 'notification-badges' });
    expect(badges.items.some((item) => item.id.includes('reportRead'))).toBe(false);
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
