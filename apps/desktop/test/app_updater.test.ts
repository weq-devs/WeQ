// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const fixture = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', once: vi.fn() },
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  macVerifiedArchive: false,
  prepareMacUpdate: vi.fn(),
  installMacUpdate: vi.fn(),
  restricted: false,
  cancelDownload: vi.fn(),
  fetchOfficialArchive: vi.fn(),
  verifyOfficialArchive: vi.fn(),
}));
// Keep the real RPC middleware without loading account services for an updater test.
vi.mock('@weq/service', async () => {
  const [{ withHost }, { OperationError }, { logRequest }] = await Promise.all([
    import('../../../packages/service/src/common/host'),
    import('../../../packages/service/src/common/operation_error'),
    import('../../../packages/service/src/common/request_log'),
  ]);
  return { withHost, OperationError, logRequest };
});
vi.mock('../src/main/data_saver', () => ({
  hostDataSaver: async () => fixture.restricted,
  refreshTransferPolicy: async () => undefined,
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
vi.mock('../src/main/update/official_archive', () => ({
  fetchOfficialArchive: fixture.fetchOfficialArchive,
  verifyOfficialArchive: fixture.verifyOfficialArchive,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.app.isPackaged = true;
  fixture.macVerifiedArchive = false;
  fixture.restricted = false;
  fixture.prepareMacUpdate.mockResolvedValue({ version: '1.1.0' });
  fixture.installMacUpdate.mockResolvedValue(undefined);
  fixture.fetchOfficialArchive.mockResolvedValue({ sha256: 'fixture', size: 100 });
  fixture.verifyOfficialArchive.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

it('账号和登录窗口接收同一更新，关闭共享，下载完成可再次提醒', async () => {
  const { updateRouter } = await import('../src/main/ipc/routers/update');
  const { updateBus } = await import('../src/main/update/state');
  const account = updateRouter.createCaller({});
  const login = updateRouter.createCaller({});
  const first = vi.fn();
  const second = vi.fn();
  const active = (await account.onBanner()).subscribe({ next: first });
  const available = { kind: 'available', latest: '1.1.0' } as const;
  const downloaded = { ...available, kind: 'downloaded' } as const;
  updateBus.emit('event', available);
  const picker = (await login.onBanner()).subscribe({ next: second });
  try {
    expect(first).toHaveBeenLastCalledWith(available);
    expect(second).toHaveBeenLastCalledWith(available);
    await login.dismissBanner(available);
    expect(first).toHaveBeenLastCalledWith(null);
    expect(second).toHaveBeenLastCalledWith(null);
    updateBus.emit('event', available);
    expect(second).toHaveBeenLastCalledWith(null);
    updateBus.emit('event', downloaded);
    expect(first).toHaveBeenLastCalledWith(downloaded);
    await login.dismissBanner(available);
    expect(first).toHaveBeenLastCalledWith(downloaded);
    await account.dismissBanner(downloaded);
    expect(second).toHaveBeenLastCalledWith(null);
  } finally {
    picker.unsubscribe();
    active.unsubscribe();
  }
});
async function ready() {
  const {
    default: { autoUpdater },
  } = await import('electron-updater');
  autoUpdater.removeAllListeners();
  const state = await import('../src/main/update/state');
  const updater = await import('../src/main/update/updater');
  const events: unknown[] = [];
  state.setUpdateState({
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    base: 'https://synthetic.invalid',
    ranked: ['https://synthetic.invalid'],
  });
  state.updateBus.on('event', (event) => events.push(event));
  fixture.checkForUpdates.mockImplementation(async () => ({
    updateInfo: { version: state.getUpdateState()?.latest ?? '1.1.0' },
    cancellationToken: { cancel: fixture.cancelDownload },
  }));
  fixture.downloadUpdate.mockImplementation(async () => {
    const version = state.getUpdateState()?.latest ?? '1.1.0';
    const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    const file =
      process.platform === 'linux' && !fixture.macVerifiedArchive
        ? `/synthetic/weQ-${version}-linux-${arch}.AppImage`
        : `/synthetic/weQ-${version}-mac-arm64.zip`;
    autoUpdater.emit('update-downloaded', {
      version,
      downloadedFile: file,
    });
    return [];
  });
  return { updater, autoUpdater, events };
}

it('软件更新订阅先回放缓存可用状态，切换检查渠道后清除', async () => {
  const { updater } = await ready();
  const { updateRouter } = await import('../src/main/ipc/routers/update');
  const stream = await updateRouter.createCaller({}).onEvent();
  const seen: boolean[] = [];
  const subscription = stream.subscribe({
    next: (event) => {
      if (event.kind === 'availability') seen.push(event.available);
    },
  });
  try {
    expect(seen).toEqual([true]);
    updater.setCheckPrerelease(true);
    expect(seen).toEqual([true, false]);
  } finally {
    subscription.unsubscribe();
  }
});

describe.each(['win32', 'linux'])('更新安装动作（%s）', (platform) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  });
  it('下载事件同步任务列表的真实字节进度并保留过程日志', async () => {
    const { updater, autoUpdater } = await ready();
    const { updateTransferPolicy } = await import('@weq/service/transfer-policy');
    const { UNKNOWN_NETWORK } = await import('@weq/service/data-saver');
    const { backgroundTasks } = await import('../src/main/background_tasks');
    updateTransferPolicy('never', UNKNOWN_NETWORK);
    const download = fixture.downloadUpdate.getMockImplementation()!;
    fixture.downloadUpdate.mockImplementationOnce(async () => {
      autoUpdater.emit('download-progress', {
        percent: 40,
        transferred: 4 * 1048576,
        total: 10 * 1048576,
        bytesPerSecond: 1048576,
      });
      const task = backgroundTasks.snapshot().at(-1)!;
      expect(task.progress).toBe(40);
      expect(task.note).toContain('4.0 / 10.0 MiB');
      expect(task.logs?.some((line) => line.text.includes('40%'))).toBe(true);
      return download();
    });
    await updater.startDownload();
    expect(backgroundTasks.snapshot().at(-1)?.progress).toBe(100);
  });
  it.each(['version', 'file'])('Linux 拒绝下载回执与已检查身份不一致：%s', async (field) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { updater, autoUpdater, events } = await ready();
    const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    fixture.downloadUpdate.mockImplementationOnce(async () => {
      autoUpdater.emit('update-downloaded', {
        version: field === 'version' ? '1.2.0' : '1.1.0',
        downloadedFile:
          field === 'file'
            ? '/synthetic/weQ-1.1.0-mac-arm64.zip'
            : `/synthetic/weQ-1.1.0-linux-${arch}.AppImage`,
      });
      return [];
    });
    await expect(updater.startDownload()).rejects.toThrow('不一致');
    expect(fixture.fetchOfficialArchive).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
    expect(() => updater.quitAndInstall()).toThrow('下载');
  });
  it.each([false, true])('Linux 官方核验完成前不提供安装状态，失败拒绝安装：%s', async (fail) => {
    const previous = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const { updater, autoUpdater, events } = await ready();
      const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
      const file = `/synthetic/weQ-1.1.0-linux-${arch}.AppImage`;
      fixture.downloadUpdate.mockImplementationOnce(async () => {
        autoUpdater.emit('update-downloaded', { version: '1.1.0', downloadedFile: file });
        return [file];
      });
      let finish!: () => void;
      fixture.verifyOfficialArchive.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () => (fail ? reject(new Error('官方摘要不匹配')) : resolve());
          }),
      );
      const download = updater.startDownload();
      const outcome = download.catch((error: Error) => error);
      await vi.waitFor(() =>
        expect(fixture.verifyOfficialArchive).toHaveBeenCalledWith(file, {
          sha256: 'fixture',
          size: 100,
        }),
      );
      expect(fixture.fetchOfficialArchive).toHaveBeenCalledWith(
        '1.1.0',
        `weQ-1.1.0-linux-${arch}.AppImage`,
        false,
      );
      expect(events).not.toContainEqual({ kind: 'downloaded', latest: '1.1.0' });
      expect(() => updater.quitAndInstall()).toThrow('下载');
      finish();
      if (fail) {
        expect(await outcome).toMatchObject({ message: '官方摘要不匹配' });
        expect(() => updater.quitAndInstall()).toThrow('下载');
      } else {
        await download;
        updater.quitAndInstall();
        expect(fixture.quitAndInstall).toHaveBeenCalledOnce();
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: previous, configurable: true });
    }
  });
  it('大文件按共享阈值暂停；关闭自动继续后网络恢复仍等待本次继续', async () => {
    const { updater, autoUpdater } = await ready();
    const { updateTransferPolicy } = await import('@weq/service/transfer-policy');
    const { UNKNOWN_NETWORK } = await import('@weq/service/data-saver');
    const { backgroundTasks } = await import('../src/main/background_tasks');
    updateTransferPolicy('always', UNKNOWN_NETWORK, {
      dataSaverLargeMiB: 1,
      dataSaverAutoResume: false,
    });
    const interrupted = Promise.withResolvers<never>();
    fixture.downloadUpdate.mockImplementationOnce(() => {
      queueMicrotask(() =>
        autoUpdater.emit('download-progress', {
          percent: 1,
          transferred: 1,
          total: 2 * 1024 * 1024,
          bytesPerSecond: 1,
        }),
      );
      return interrupted.promise;
    });
    const work = updater.startDownload();
    await vi.waitFor(() => expect(fixture.cancelDownload).toHaveBeenCalled());
    updateTransferPolicy('never', UNKNOWN_NETWORK, { dataSaverAutoResume: false });
    await Promise.resolve();
    expect(fixture.downloadUpdate).toHaveBeenCalledTimes(1);
    const task = backgroundTasks.snapshot().find((task) => task.name === '下载 WeQ 更新');
    expect(task?.status).toBe('paused');
    await backgroundTasks.act(task!.id, 'continue');
    interrupted.reject(new Error('旧下载在继续请求之后确认取消'));
    await work;
    expect(fixture.downloadUpdate).toHaveBeenCalledTimes(2);
  });
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
    expect(mirrors.resolveBestMirror).toHaveBeenCalledWith(undefined, true, true);
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
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
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
    const state = await import('../src/main/update/state');
    state.setUpdateState({ ...state.getUpdateState()!, latest: '1.2.0' });
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

it('设置入口只建一个任务；重启后需核验同一版本才能再次提供安装', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const root = await mkdtemp(join(tmpdir(), 'weq-update-task-'));
  const options = { dataRoot: root, get: () => false, set: () => {} };
  try {
    const { updater } = await ready();
    updater.installUpdateActions(options);
    const { updateRouter } = await import('../src/main/ipc/routers/update');
    let registry = (await import('../src/main/background_tasks')).backgroundTasks;
    const finish = fixture.downloadUpdate.getMockImplementation()!;
    const release = Promise.withResolvers<void>();
    fixture.downloadUpdate.mockImplementationOnce(async () => {
      await release.promise;
      return finish();
    });
    const caller = updateRouter.createCaller({});
    await caller.download();
    await caller.download();
    await vi.waitFor(() => expect(fixture.downloadUpdate).toHaveBeenCalledOnce());
    expect(registry.snapshot()).toHaveLength(1);
    const id = registry.snapshot()[0]!.id;
    expect(registry.snapshot()[0]?.foreground).not.toBe(true);
    expect(registry.snapshot()[0]?.actions).toContainEqual({ id: 'pause', label: '暂停' });
    const liveActions = (await import('../src/main/update/state')).getUpdateActions();
    expect(liveActions.getDownloadTask?.()).toMatchObject({
      id,
      status: 'running',
    });
    expect(fixture.downloadUpdate).toHaveBeenCalledOnce();
    release.resolve();
    await vi.waitFor(() => expect(registry.snapshot()[0]?.status).toBe('completed'));

    vi.resetModules();
    fixture.downloadUpdate.mockClear();
    const restarted = await ready();
    restarted.updater.installUpdateActions(options);
    registry = (await import('../src/main/background_tasks')).backgroundTasks;
    const state = await import('../src/main/update/state');
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]).toMatchObject({
      id,
      status: 'paused',
      foreground: false,
      actions: [{ id: 'continue' }],
    });
    expect(fixture.downloadUpdate).not.toHaveBeenCalled();
    expect(() => restarted.updater.quitAndInstall()).toThrow('下载');

    const check = state.getUpdateState()!;
    state.setUpdateState({ ...check, latest: '1.2.0' });
    await registry.act(id, 'continue');
    await vi.waitFor(() => expect(registry.snapshot()[0]?.status).toBe('failed'));
    expect(fixture.downloadUpdate).not.toHaveBeenCalled();
    expect(registry.snapshot()[0]?.note).toContain('1.2.0');

    state.setUpdateState({ ...check, channel: 'beta' });
    await registry.act(id, 'retry');
    await vi.waitFor(() => expect(registry.snapshot()[0]?.note).toContain('渠道已变更'));
    expect(fixture.downloadUpdate).not.toHaveBeenCalled();

    state.setUpdateState(check);
    await registry.act(id, 'retry');
    await vi.waitFor(() => expect(registry.snapshot()[0]?.status).toBe('completed'));
    expect(fixture.downloadUpdate).toHaveBeenCalledOnce();
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]?.actions).toContainEqual({ id: 'install', label: '重启并安装' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

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
