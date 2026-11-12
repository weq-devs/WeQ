import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientStateSnapshot } from '@weq/service/client-preferences';

const rpc = vi.hoisted(() => ({
  snapshot: vi.fn(),
  seed: vi.fn(),
  patch: vi.fn(),
  accountPatch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    clientState: {
      snapshot: { query: rpc.snapshot },
      seed: { mutate: rpc.seed },
      patch: { mutate: rpc.patch },
      accountPatch: { mutate: rpc.accountPatch },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function page(storage: Storage, target: string) {
  vi.resetModules();
  vi.stubEnv('VITE_WEQ_TARGET', target);
  vi.stubGlobal('localStorage', storage);
  return import('../src/renderer/src/lib/clientPreferences');
}
function server() {
  const state: ClientStateSnapshot = { epoch: 'fixture', revision: 0, values: {}, records: {} };
  const response = () => ({ ...structuredClone(state), serverId: 'a'.repeat(24) });
  rpc.snapshot.mockImplementation(async () => response());
  rpc.seed.mockImplementation(async (values) => {
    state.values = { ...values, ...state.values };
    state.revision++;
    return response();
  });
  rpc.patch.mockImplementation(async (values) => {
    state.values = { ...state.values, ...values };
    state.revision++;
    return response();
  });
  return response;
}
describe('独立客户端的偏好同步', () => {
  it('全部会话包含隐藏与删除独立跨端同步，切号不回灌旧值', async () => {
    const response = server();
    const desktop = await page(new Storage(), 'desktop');
    await desktop.initializePreferences();
    expect(desktop.preferenceValue('allConversationsIncludeHidden')).toBe(false);
    expect(desktop.preferenceValue('allConversationsIncludeDeleted')).toBe(false);
    await desktop.changePreference('allConversationsIncludeHidden', true);
    const mobile = await page(new Storage(), 'web');
    await mobile.initializePreferences();
    expect(mobile.preferenceValue('allConversationsIncludeHidden')).toBe(true);
    expect(mobile.preferenceValue('allConversationsIncludeDeleted')).toBe(false);
    mobile.bindAccountState({
      expectedAccountUin: '20002',
      expectedAccountConfigId: 'other-account',
    });
    expect(mobile.preferenceValue('allConversationsIncludeHidden')).toBe(true);
    await mobile.changePreference('allConversationsIncludeDeleted', true);
    desktop.acceptPreferences(response());
    expect(desktop.preferenceValue('allConversationsIncludeHidden')).toBe(true);
    expect(desktop.preferenceValue('allConversationsIncludeDeleted')).toBe(true);
  });
  it('异步加载客户端期间切换数据源，旧操作不能写入新账号', async () => {
    server();
    const module = await page(new Storage(), 'web');
    module.bindAccountState({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
    const pending = module.patchAccountRecords('pins', { '123': true });
    module.bindAccountState({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-b' });
    await expect(pending).rejects.toThrow('已切换');
    expect(rpc.accountPatch).not.toHaveBeenCalled();
  });
  it('Remote 和桌面双向修改同一背景，不存在设备覆盖入口', async () => {
    const response = server();
    const desktopStorage = new Storage();
    desktopStorage.setItem('weq.theme-background', 'paper');
    const desktop = await page(desktopStorage, 'desktop');
    await desktop.initializePreferences();
    const mobileStorage = new Storage();
    const mobile = await page(mobileStorage, 'web');
    await mobile.initializePreferences();
    await mobile.changePreference('background', 'grid');
    vi.stubGlobal('localStorage', desktopStorage);
    desktop.acceptPreferences(response());
    expect(desktop.preferenceValue('background')).toBe('grid');
    await desktop.changePreference('background', 'dots');
    vi.stubGlobal('localStorage', mobileStorage);
    mobile.acceptPreferences(response());
    expect(mobile.preferenceValue('background')).toBe('dots');
    await mobile.changePreference('background', 'telegram');
    vi.stubGlobal('localStorage', desktopStorage);
    desktop.acceptPreferences(response());
    expect(desktop.preferenceValue('background')).toBe('telegram');
    expect('setPreferenceMode' in desktop).toBe(false);
  });
  it('手机旧差异和旧覆盖均不再生效，深浅模式与隐私开关采用桌面共享初值', async () => {
    server();
    const desktopStorage = new Storage();
    desktopStorage.setItem('weq.theme-background', 'paper');
    desktopStorage.setItem('weq.theme-preference', 'dark');
    desktopStorage.setItem('weq.privacy-mode', '1');
    const desktop = await page(desktopStorage, 'desktop');
    await desktop.initializePreferences();
    const mobileStorage = new Storage();
    mobileStorage.setItem('weq.theme-background', 'grid');
    mobileStorage.setItem('weq.theme-preference', 'light');
    mobileStorage.setItem('weq.privacy-mode', '0');
    mobileStorage.setItem(`weq.sync.v1:${'a'.repeat(24)}:overrides`, '{"background":"dots"}');
    const mobile = await page(mobileStorage, 'web');
    await mobile.initializePreferences();
    expect(mobile.preferenceValue('background')).toBe('paper');
    expect(mobile.preferenceValue('preference')).toBe('dark');
    expect(mobile.preferenceValue('privacyMode')).toBe(true);
    await mobile.initializePreferences();
    expect(rpc.seed).toHaveBeenCalledTimes(1);
  });
  it('保存失败不丢即时预览，也不在重连读取时偷偷重放；显式重试才保存', async () => {
    server();
    const module = await page(new Storage(), 'web');
    await module.initializePreferences();
    rpc.patch.mockRejectedValueOnce(new Error('offline'));
    await module.changePreference('background', 'grid');
    expect(module.preferenceValue('background')).toBe('grid');
    expect(module.useClientPreferences.getState().error).toContain('未保存');
    await module.initializePreferences();
    expect(rpc.patch).toHaveBeenCalledTimes(1);
    module.retryPreferences();
    await vi.waitFor(() => expect(rpc.patch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(module.useClientPreferences.getState().error).toBe(''));
  });
  it('恢复备份的新世代可替换旧高修订，旧快照不能覆盖当前新修订', async () => {
    server();
    const module = await page(new Storage(), 'web');
    module.acceptPreferences({
      epoch: 'old',
      revision: 100,
      values: { background: 'grid' },
      records: {},
    });
    module.acceptPreferences({
      epoch: 'restored',
      revision: 0,
      values: { background: 'paper' },
      records: {},
    });
    expect(module.preferenceValue('background')).toBe('paper');
    module.acceptPreferences({
      epoch: 'restored',
      revision: 4,
      values: { background: 'dots' },
      records: {},
    });
    module.acceptPreferences({
      epoch: 'restored',
      revision: 2,
      values: { background: 'grid' },
      records: {},
    });
    expect(module.preferenceValue('background')).toBe('dots');
  });
  it('同源辅助窗口接收共享缓存变更，迟到旧缓存不能回退已确认值', async () => {
    server();
    const storage = new Storage();
    const module = await page(storage, 'web');
    await module.initializePreferences();
    const key = `weq.sync.v1:${'a'.repeat(24)}:shared`;
    storage.setItem(
      key,
      JSON.stringify({ epoch: 'fixture', revision: 11, values: { background: 'dots' } }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(module.preferenceValue('background')).toBe('dots');
    storage.setItem(
      key,
      JSON.stringify({ epoch: 'fixture', revision: 5, values: { background: 'grid' } }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(module.preferenceValue('background')).toBe('dots');
    expect(JSON.parse(storage.getItem(key)!).revision).toBe(11);
  });
  it('已观察到的新提交会拒绝 AI 和防撤回的迟到响应，更换宿主后重新计数', async () => {
    server();
    const module = await page(new Storage(), 'web');
    await module.initializePreferences();
    module.acceptPreferences({
      epoch: 'fixture',
      revision: 12,
      settingsRevision: 10,
      values: {},
      records: {},
    });
    expect(module.acceptSettingsReply({ settingsRevision: 9 })).toBe(false);
    expect(module.acceptSettingsReply({ settingsRevision: 11 })).toBe(true);
    expect(module.acceptSettingsReply({ settingsRevision: 10 })).toBe(false);
    module.acceptPreferences({
      epoch: 'other-host',
      revision: 1,
      settingsRevision: 1,
      values: {},
      records: {},
    });
    expect(module.acceptSettingsReply({ settingsRevision: 1 })).toBe(true);
  });
});
