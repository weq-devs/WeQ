import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserConfigService, DEFAULT_INTENT_SENSE_CONFIG } from '@weq/service';
import { sharedSettingsRouter } from '../src/main/ipc/routers/shared_settings';
import { clientStateRouter, globalClientState } from '../src/main/ipc/routers/client_state';
import { assertAccountBinding } from '../src/main/ipc/account_binding';
import { dataSaverSession } from '@weq/service/transfer-policy';
import { settingsResetRouter } from '../src/main/ipc/routers/settings_reset';

const state = vi.hoisted(() => ({
  root: '',
  config: null as UserConfigService | null,
  record: null as { uin: string; configId: string } | null,
}));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({
    userConfig: state.config,
    agentLabConfig: {
      resolveEndpoint: () => {
        throw new Error('未配置提供方');
      },
    },
  }),
  requirePlatform: () => ({ appDataRoot: () => state.root }),
  getActiveIntentSenseLocalEngine: () => null,
  emitDressChanged: vi.fn(),
  getAppContext: () => ({
    bootstrap: { userConfig: state.config },
    services: state.record ? { accountConfig: { getRecord: () => state.record } } : null,
    account: state.record ? { context: { uin: state.record.uin } } : null,
  }),
}));

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-shared-settings-'));
  state.config = new UserConfigService({ appDataRoot: () => state.root });
  state.record = null;
});
afterEach(() => {
  dataSaverSession.clearTemporary();
  rmSync(state.root, { recursive: true, force: true });
});

describe('宿主全局设置接口', () => {
  it('基础偏好已是默认时，恢复默认仍清除临时覆盖', async () => {
    await clientStateRouter.createCaller({}).patch({ dataSaverMode: 'auto' });
    dataSaverSession.setTemporary({ enabled: true, duration: 'exit' });
    const reset = settingsResetRouter.createCaller({});
    const preview = await reset.preview({ page: 'resource-loading', card: 'data-saver' });
    expect(preview.items.find((item) => item.id === 'data-saver:temporary')).toMatchObject({
      current: '临时开启',
      defaultValue: '无临时设置',
    });
    const result = await reset.restore({
      page: 'resource-loading',
      card: 'data-saver',
      source: null,
    });
    expect(result.find((item) => item.id === 'data-saver:temporary')?.ok).toBe(true);
    expect(dataSaverSession.status().temporary).toBeNull();
  });
  it('省流量临时设置跨端共用且不持久化，基础设置同值保存也清除覆盖', async () => {
    const caller = sharedSettingsRouter.createCaller({});
    const client = clientStateRouter.createCaller({});
    await client.patch({ dataSaverMode: 'always' });
    const status = await caller.dataSaver.temporary({
      clientId: 'desktop',
      value: { enabled: false, duration: 'exit' },
    });
    expect(status).toMatchObject({
      mode: 'always',
      enabled: false,
      temporary: { enabled: false, duration: 'exit' },
    });
    expect(
      (
        await caller.dataSaver.status({
          clientId: 'phone',
          windowId: 'd0a47d22-ff36-4294-b5be-98cff6e28a01',
          pendingTasks: 0,
        })
      ).temporary,
    ).toEqual(status.temporary);
    expect(state.config!.getSharedPreference('client')).toEqual({ dataSaverMode: 'always' });
    await client.patch({ dataSaverMode: 'always' });
    expect(dataSaverSession.status()).toMatchObject({
      temporary: null,
      enabled: true,
      reason: 'settings',
    });
    await expect(
      caller.dataSaver.temporary({
        clientId: 'phone',
        value: { enabled: true, duration: 'minutes', minutes: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      caller.dataSaver.temporary({
        clientId: 'phone',
        value: { enabled: false, duration: 'tasks' },
      }),
    ).rejects.toThrow('未完成任务');
  });
  it('没有账号也能读取和保存三项 AI、邮箱及助手偏好', async () => {
    const caller = sharedSettingsRouter.createCaller({});
    expect(await caller.intent.getStatus()).toMatchObject({ enabled: false, apiConfigured: false });
    await caller.intent.setConfig({
      loadingAnimation: false,
      suggestionFallbackTexts: [],
      profileMode: 'manual',
    });
    await caller.mail.patch({ showUnread: false, notifications: true, pollIntervalMinutes: 9 });
    await caller.assistant.setConfig({ customPrompt: '合成提示词', reasoningEffort: 'high' });
    expect(await caller.intent.getStatus()).toMatchObject({
      loadingAnimation: false,
      suggestionFallbackTexts: [],
      profileMode: 'manual',
    });
    expect(await caller.mail.get()).toMatchObject({
      showUnread: false,
      notifications: true,
      pollIntervalMinutes: 9,
    });
    expect(await caller.assistant.getConfig()).toMatchObject({
      customPrompt: '合成提示词',
      reasoningEffort: 'high',
    });
    await caller.intent.setConfig({
      engine: 'local',
      providerRef: { providerId: 'fixture', model: 'analysis' },
    });
    expect(await caller.intent.getStatus()).toMatchObject({
      profileEngine: DEFAULT_INTENT_SENSE_CONFIG.profileEngine,
      suggestionProviderRef: DEFAULT_INTENT_SENSE_CONFIG.suggestionProviderRef,
    });
    await expect(
      caller.intent.setConfig({
        profileMinSamples: DEFAULT_INTENT_SENSE_CONFIG.profileSamples + 1,
      }),
    ).rejects.toThrow('最少样本');
  });

  it('全局偏好只写 config.json，旧 global.json 不再作为显示或通知来源', async () => {
    const legacy = join(state.root, 'client-state', 'global.json');
    mkdirSync(join(state.root, 'client-state'), { recursive: true });
    const bytes = JSON.stringify({
      epoch: 'old',
      revision: 1,
      values: { applicationBadge: true },
      records: {},
      drafts: {},
    });
    writeFileSync(legacy, bytes);
    const caller = clientStateRouter.createCaller({});
    const before = await caller.snapshot();
    await caller.patch({ applicationBadge: false, privacyMode: true });
    const after = await caller.snapshot();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.values).toMatchObject({ applicationBadge: false, privacyMode: true });
    expect(globalClientState().snapshot().values.applicationBadge).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe(bytes);
    expect(state.config!.getSharedPreference('client')).toMatchObject({
      applicationBadge: false,
      privacyMode: true,
    });
  });

  it('不同端的排序字段分别合并，旧账号种子不覆盖共享值', async () => {
    const caller = clientStateRouter.createCaller({});
    await Promise.all([
      caller.patch({
        contactOrder: { friends: { grouping: 'qq', sort: 'remark', descending: false } },
      }),
      caller.patch({ contactOrder: { refreshRange: 'none' } }),
    ]);
    state.record = { uin: '10001', configId: '10001_a' };
    await caller.accountPatch({
      expectedAccountUin: '10001',
      expectedAccountConfigId: '10001_a',
      namespace: 'order',
      values: { refreshRange: 'all' },
      seed: true,
    });
    expect((await caller.snapshot()).values.contactOrder).toEqual({
      friends: { grouping: 'qq', sort: 'remark', descending: false },
      refreshRange: 'none',
    });
  });

  it('同号不同数据源的旧规则请求也拒绝，不能写到新数据源', () => {
    state.record = { uin: '10001', configId: '10001_b' };
    expect(() =>
      assertAccountBinding({ expectedAccountUin: '10001', expectedAccountConfigId: '10001_a' }),
    ).toThrow('已切换');
    expect(() =>
      assertAccountBinding({ expectedAccountUin: '10001', expectedAccountConfigId: '10001_b' }),
    ).not.toThrow();
  });

  it('旧界面备份恢复收据幂等，重复回执不会覆盖后续修改', async () => {
    const caller = clientStateRouter.createCaller({});
    const receiptId = 'c0d95cb3-ccfe-43e3-bb70-4814cb535d10';
    await caller.restoreLegacyPreferences({ receiptId, values: { privacyMode: true } });
    await caller.patch({ privacyMode: false });
    await caller.restoreLegacyPreferences({ receiptId, values: { privacyMode: true } });
    expect((await caller.snapshot()).values.privacyMode).toBe(false);
  });
});
