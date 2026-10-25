import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  macAdhoc: false,
  prepareMacUpdate: vi.fn(),
  installMacUpdate: vi.fn(),
}));
vi.mock('electron', () => ({ app: fixture.app }));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: {
      autoUpdater: Object.assign(new EventEmitter(), {
        quitAndInstall: fixture.quitAndInstall,
        setFeedURL: fixture.setFeedURL,
        checkForUpdates: fixture.checkForUpdates,
        downloadUpdate: fixture.downloadUpdate,
      }),
    },
  };
});
vi.mock('../src/main/update/mirrors', () => ({ FILE_MIRRORS: [], resolveBestMirror: vi.fn() }));
vi.mock('../src/main/weq_assistant/update_tweet', () => ({ announceUpdateAvailableSafe: vi.fn() }));
vi.mock('../src/main/update/mac', () => ({
  usesMacAdhocUpdater: async () => fixture.macAdhoc,
  prepareMacUpdate: fixture.prepareMacUpdate,
  installMacUpdate: fixture.installMacUpdate,
  finishMacUpdate: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.app.isPackaged = true;
  fixture.macAdhoc = false;
  fixture.prepareMacUpdate.mockResolvedValue({ version: '1.1.0' });
  fixture.installMacUpdate.mockResolvedValue(undefined);
});
async function ready() {
  const {
    default: { autoUpdater },
  } = await import('electron-updater');
  autoUpdater.removeAllListeners();
  const state = await import('../src/main/update/state');
  const updater = await import('../src/main/update/updater');
  const events: unknown[] = [];
  state.updateBus.on('event', (event) => events.push(event));
  state.setUpdateState({
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    base: 'https://synthetic.invalid',
    ranked: ['https://synthetic.invalid'],
  });
  fixture.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.1.0' } });
  fixture.downloadUpdate.mockImplementation(async () => {
    autoUpdater.emit('update-downloaded', {
      version: '1.1.0',
      downloadedFile: '/synthetic/weQ-1.1.0-mac-arm64.zip',
    });
    return [];
  });
  return { updater, autoUpdater, events };
}

describe('更新安装动作', () => {
  it('ad-hoc Mac 不交给绑定旧 cdhash 的 Squirrel，官方校验完成后才允许安装', async () => {
    fixture.macAdhoc = true;
    const { updater, events } = await ready();
    let finish: ((plan: { version: string }) => void) | undefined;
    fixture.prepareMacUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const download = updater.startDownload();
    await vi.waitFor(() =>
      expect(fixture.prepareMacUpdate).toHaveBeenCalledWith(
        '/synthetic/weQ-1.1.0-mac-arm64.zip',
        '1.1.0',
      ),
    );
    expect(events).not.toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
    expect(() => updater.quitAndInstall()).toThrow('下载');
    finish?.({ version: '1.1.0' });
    await download;
    expect(events).toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
    updater.quitAndInstall();
    expect(fixture.installMacUpdate).toHaveBeenCalledWith({ version: '1.1.0' });
    expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  });
  it('官方校验拒绝时不发布可安装状态，也不回退到 Squirrel', async () => {
    fixture.macAdhoc = true;
    const { updater, events } = await ready();
    fixture.prepareMacUpdate.mockRejectedValueOnce(new Error('官方 SHA-256 不匹配'));
    await expect(updater.startDownload()).rejects.toThrow('官方 SHA-256 不匹配');
    expect(events).not.toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
    expect(events).toContainEqual({ kind: 'error', message: '官方 SHA-256 不匹配' });
    expect(() => updater.quitAndInstall()).toThrow('下载');
  });
  it('已下载后再次检查到更新版本，仍可重新下载并安装新计划', async () => {
    fixture.macAdhoc = true;
    const { updater, autoUpdater } = await ready();
    await updater.startDownload();
    fixture.downloadUpdate.mockImplementationOnce(async () => {
      autoUpdater.emit('update-downloaded', {
        version: '1.2.0',
        downloadedFile: '/synthetic/weQ-1.2.0-mac-arm64.zip',
      });
      return [];
    });
    fixture.prepareMacUpdate.mockResolvedValueOnce({ version: '1.2.0' });
    await updater.startDownload();
    updater.quitAndInstall();
    expect(fixture.prepareMacUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.installMacUpdate).toHaveBeenCalledWith({ version: '1.2.0' });
  });
  it('Mac 安装助手准备失败时保留应用并解除在途，允许重试', async () => {
    fixture.macAdhoc = true;
    const { updater, events } = await ready();
    await updater.startDownload();
    fixture.installMacUpdate.mockRejectedValueOnce(new Error('助手启动失败'));
    updater.quitAndInstall();
    await vi.waitFor(() =>
      expect(events).toContainEqual({ kind: 'error', message: '助手启动失败' }),
    );
    updater.quitAndInstall();
    expect(fixture.installMacUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  });
  it('未完成下载时明确拒绝安装，而非无声调用安装器', async () => {
    const { updater } = await ready();
    expect(() => updater.quitAndInstall()).toThrow('下载');
    expect(fixture.quitAndInstall).not.toHaveBeenCalled();
  });
  it('完成下载后只启动一次安装，异步失败反馈到界面且允许重试', async () => {
    const { updater, autoUpdater, events } = await ready();
    await updater.startDownload();
    updater.quitAndInstall();
    updater.quitAndInstall();
    expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
    expect(fixture.quitAndInstall).toHaveBeenCalledWith(true, true);
    autoUpdater.emit('error', new Error('合成系统安装失败'));
    expect(events).toContainEqual({ kind: 'error', message: '合成系统安装失败' });
    updater.quitAndInstall();
    expect(fixture.quitAndInstall).toHaveBeenCalledTimes(2);
  });
  it('同步拒绝与开发模式不会锁住后续操作', async () => {
    const { updater } = await ready();
    await updater.startDownload();
    fixture.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('合成同步失败');
    });
    expect(() => updater.quitAndInstall()).toThrow('合成同步失败');
    updater.quitAndInstall();
    expect(fixture.quitAndInstall).toHaveBeenCalledTimes(2);
    fixture.app.isPackaged = false;
    expect(() => updater.quitAndInstall()).toThrow('开发模式');
  });
});
