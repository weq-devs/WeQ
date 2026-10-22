import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.app.isPackaged = true;
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
    autoUpdater.emit('update-downloaded', { version: '1.1.0' });
    return [];
  });
  return { updater, autoUpdater, events };
}

describe('更新安装动作', () => {
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
