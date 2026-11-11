// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', once: vi.fn() },
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  macVerifiedArchive: false,
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
  usesMacVerifiedArchiveUpdater: () => fixture.macVerifiedArchive,
  prepareMacUpdate: fixture.prepareMacUpdate,
  installMacUpdate: fixture.installMacUpdate,
  finishMacUpdate: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.app.isPackaged = true;
  fixture.macVerifiedArchive = false;
  fixture.prepareMacUpdate.mockResolvedValue({ version: '1.1.0' });
  fixture.installMacUpdate.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
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
  it('持久配置控制启动和周期检查，保存 -1 后仍可手动检查', async () => {
    vi.useFakeTimers();
    const { updater } = await ready();
    const { getUpdateActions } = await import('../src/main/update/state');
    const mirrors = await import('../src/main/update/mirrors');
    vi.mocked(mirrors.resolveBestMirror).mockResolvedValue({
      version: '1.0.0',
      base: 'https://synthetic.invalid',
      ranked: [],
    });
    let minutes = -1;
    updater.installUpdateActions({
      get: () => false,
      set: () => {},
      getInterval: () => minutes,
      setInterval: (value) => {
        minutes = value;
      },
    });
    updater.startAutomaticUpdateChecks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mirrors.resolveBestMirror).not.toHaveBeenCalled();
    getUpdateActions().setInterval(1);
    expect(minutes).toBe(1);
    expect(getUpdateActions().getInterval()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mirrors.resolveBestMirror).toHaveBeenCalledOnce();
    getUpdateActions().setInterval(-1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mirrors.resolveBestMirror).toHaveBeenCalledOnce();
    await getUpdateActions().check(true);
    expect(mirrors.resolveBestMirror).toHaveBeenCalledTimes(2);
  });
  it('开发版不自动检查', async () => {
    vi.useFakeTimers();
    const { updater } = await ready();
    fixture.app.isPackaged = false;
    updater.startAutomaticUpdateChecks();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('自动检查失败发布结束事件且下一周期重试', async () => {
    vi.useFakeTimers();
    const { updater, events } = await ready();
    const { getUpdateActions } = await import('../src/main/update/state');
    const mirrors = await import('../src/main/update/mirrors');
    vi.mocked(mirrors.resolveBestMirror).mockRejectedValue(new Error('离线'));
    updater.installUpdateActions();
    getUpdateActions().setInterval(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContainEqual({ kind: 'check-failed' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mirrors.resolveBestMirror).toHaveBeenCalledTimes(2);
    getUpdateActions().setInterval(-1);
  });
  it('测试版选择传入真实检查与下载，切换后旧结果失效且不允许降级', async () => {
    const { updater, autoUpdater } = await ready();
    const state = await import('../src/main/update/state');
    const mirrors = await import('../src/main/update/mirrors');
    let enabled = false;
    updater.installUpdateActions({
      get: () => enabled,
      set: (value) => {
        enabled = value;
      },
    });
    updater.setCheckPrerelease(true);
    expect(enabled).toBe(true);
    expect(state.getUpdateState()).toBeNull();
    vi.mocked(mirrors.resolveBestMirror).mockResolvedValue({
      version: '1.1.0-beta.2',
      base: 'https://synthetic.invalid',
      ranked: ['https://synthetic.invalid'],
      channel: 'beta',
    });
    expect(await updater.checkForUpdate(true)).toMatchObject({
      includePrerelease: true,
      hasUpdate: true,
    });
    expect(mirrors.resolveBestMirror).toHaveBeenCalledWith(undefined, true);
    await updater.startDownload();
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.channel).toBe('beta');
    expect(autoUpdater.allowDowngrade).toBe(false);
    updater.setCheckPrerelease(false);
    expect(() => updater.quitAndInstall()).toThrow('下载');
  });

  it('切换开关后拒绝旧的在途检查结果', async () => {
    const { updater } = await ready();
    const state = await import('../src/main/update/state');
    const mirrors = await import('../src/main/update/mirrors');
    let complete:
      | ((value: { version: string; base: string; ranked: string[] }) => void)
      | undefined;
    vi.mocked(mirrors.resolveBestMirror).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const checking = updater.checkForUpdate(true);
    updater.setCheckPrerelease(true);
    complete?.({ version: '1.1.0', base: 'https://synthetic.invalid', ranked: [] });
    await expect(checking).rejects.toThrow('选项已改变');
    expect(state.getUpdateState()).toBeNull();
  });
  it('Mac 统一使用官方校验安装链，校验完成后才允许安装', async () => {
    fixture.macVerifiedArchive = true;
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
        false,
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
    fixture.macVerifiedArchive = true;
    const { updater, events } = await ready();
    fixture.prepareMacUpdate.mockRejectedValueOnce(new Error('官方 SHA-256 不匹配'));
    await expect(updater.startDownload()).rejects.toThrow('官方 SHA-256 不匹配');
    expect(events).not.toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
    expect(events).toContainEqual({ kind: 'error', message: '官方 SHA-256 不匹配' });
    expect(() => updater.quitAndInstall()).toThrow('下载');
  });
  it('已下载后再次检查到更新版本，仍可重新下载并安装新计划', async () => {
    fixture.macVerifiedArchive = true;
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
    fixture.macVerifiedArchive = true;
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

describe('AUR 托管的副本', () => {
  it('拒绝应用内下载，直接给出包管理器指引', async () => {
    const { updater, events } = await ready();
    const previous = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.WEQ_PACKAGE_MANAGED = '1';
    try {
      // 拒绝发生在 try 之外：不广播 error 事件（界面在点按钮时就能拿到原因），
      // 也不该在全部镜像上失败一遍。
      await expect(updater.startDownload()).rejects.toThrow('paru -Syu');
      expect(fixture.downloadUpdate).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
      expect(() => updater.quitAndInstall()).toThrow('paru -Syu');
      expect(fixture.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      delete process.env.WEQ_PACKAGE_MANAGED;
      Object.defineProperty(process, 'platform', { value: previous, configurable: true });
    }
  });

  it('检查结果带上托管标记，界面据此切换按钮', async () => {
    const previous = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const { updater } = await ready();
      const state = await import('../src/main/update/state');
      const mirrors = await import('../src/main/update/mirrors');
      vi.mocked(mirrors.resolveBestMirror).mockResolvedValue({
        version: '1.1.0',
        base: 'https://synthetic.invalid',
        ranked: ['https://synthetic.invalid'],
      });
      process.env.WEQ_PACKAGE_MANAGED = '1';
      expect((await updater.checkForUpdate(true)).managed).toBe(true);
      delete process.env.WEQ_PACKAGE_MANAGED;
      expect((await updater.checkForUpdate(true)).managed).toBe(false);
      expect(state.getUpdateState()?.managed).toBe(false);
    } finally {
      delete process.env.WEQ_PACKAGE_MANAGED;
      Object.defineProperty(process, 'platform', { value: previous, configurable: true });
    }
  });
});
