import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, ipcMain, ipcRenderer, webContents, webFrame } from 'electron';
import { createDesktopCollector } from '../src/main/performance_monitor';
import { installPerformanceSampling } from '../src/preload/performance_monitor';
import { MONITOR_REQUEST, MONITOR_RESPONSE } from '../src/shared/performance_monitor';
import type { MonitorCollector } from '@weq/service/performance';

vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), { getAppMetrics: vi.fn(() => []) }),
  ipcMain: new EventEmitter(),
  ipcRenderer: Object.assign(new EventEmitter(), { send: vi.fn() }),
  webFrame: { getResourceUsage: vi.fn(() => ({})) },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));
vi.mock('@weq/service/performance-node', () => ({
  createNodeCollector: () => ({
    capabilities: [],
    activate: vi.fn(),
    dispose: vi.fn(),
    collect: async () => ({ processes: [], waitMs: 0 }),
  }),
}));

let collector: MonitorCollector | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(app.getAppMetrics).mockReturnValue([]);
  vi.mocked(webContents.getAllWebContents).mockReturnValue([]);
});
afterEach(() => {
  collector?.dispose();
  collector = undefined;
  ipcRenderer.removeAllListeners();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(ipcRenderer.send).mockClear();
  vi.mocked(webFrame.getResourceUsage).mockClear();
});

function mainFixture() {
  const contents = {
    id: 1,
    pid: 100,
    mainFrame: {},
    send: vi.fn(),
    getOSProcessId() {
      return this.pid;
    },
    isDestroyed: () => false,
    isCrashed: () => false,
  };
  vi.mocked(webContents.getAllWebContents).mockReturnValue([
    contents as unknown as Electron.WebContents,
  ]);
  vi.mocked(app.getAppMetrics).mockReturnValue([
    {
      pid: 100,
      creationTime: 123,
      type: 'Tab',
      cpu: { cumulativeCPUUsage: 0 },
      memory: { workingSetSize: 1024, privateBytes: 16 },
    } as Electron.ProcessMetric,
  ]);
  const event = vi.fn();
  collector = createDesktopCollector(
    () => 1,
    () => ({}),
    event,
  );
  collector.activate('full');
  return { contents, event, collector };
}
function preloadFixture() {
  const document = {
    dispatchEvent: vi.fn(),
    getElementById: () => null,
    querySelectorAll: vi.fn(() => []),
    styleSheets: [],
    getAnimations: vi.fn(() => []),
    visibilityState: 'visible',
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('process', {
    ...process,
    getHeapStatistics: () => ({ usedHeapSize: 12, totalHeapSize: 24 }),
    getProcessMemoryInfo: vi.fn(async () => ({ private: 123, shared: 4 })),
  });
  installPerformanceSampling();
  return document;
}

describe('旧诊断退役后的正式采样契约', () => {
  it('主进程只接受主窗口、主 frame、当前 PID 与序号的一次回应，并保留数值白名单', async () => {
    const f = mainFixture();
    const pending = f.collector.collect(true);
    await Promise.resolve();
    expect(f.contents.send).toHaveBeenCalledWith(MONITOR_REQUEST, 1, true);
    const reply = (sender: unknown, seq: number, frame: unknown = f.contents.mainFrame) =>
      ipcMain.emit(MONITOR_RESPONSE, { sender, senderFrame: frame }, seq, {
        jsHeapUsedBytes: 900,
        token: 'secret',
        resources: { retainedImages: 2, token: 'secret' },
        development: { caches: { images: { count: 2, size: 1024, url: 'secret' } } },
      });
    reply({ ...f.contents, id: 2 }, 1);
    reply(f.contents, 99);
    reply(f.contents, 1, {});
    f.contents.pid++;
    reply(f.contents, 1);
    f.contents.pid--;
    expect(vi.getTimerCount()).toBe(1);
    reply(f.contents, 1);
    reply(f.contents, 1);
    const sample = await pending;
    expect(sample.processes[0]).toMatchObject({
      pid: 100,
      metrics: { residentBytes: 1024 * 1024, heapBytes: 900 },
      details: {
        resources: { retainedImages: 2 },
        renderer: { caches: { images: { count: 2, sizeBytes: 1024 } } },
      },
    });
    expect(JSON.stringify(sample)).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('过期回应不再被接收，超时报告缺测，停用不触发崩溃事件，释放后无自建监听', async () => {
    const f = mainFixture();
    const pending = f.collector.collect(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).unavailable).toContain('renderer');
    ipcMain.emit(
      MONITOR_RESPONSE,
      { sender: f.contents, senderFrame: f.contents.mainFrame },
      1,
      {},
    );
    app.emit('render-process-gone', {}, f.contents, { reason: 'crashed', exitCode: 5 });
    expect(f.event).toHaveBeenCalledOnce();
    f.collector.activate('off');
    app.emit('render-process-gone', {}, f.contents, { reason: 'crashed', exitCode: 5 });
    expect(f.event).toHaveBeenCalledOnce();
    f.collector.dispose();
    collector = undefined;
    expect(ipcMain.listenerCount(MONITOR_RESPONSE)).toBe(0);
    expect(app.listenerCount('render-process-gone')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preload 完整采样异步等待期间不叠加，原生 KB 和缓存失败仍保留其他指标', async () => {
    preloadFixture();
    const native = vi.fn(() => new Promise<Electron.ProcessMemoryInfo>(() => {}));
    vi.stubGlobal('process', { ...process, getProcessMemoryInfo: native });
    vi.mocked(webFrame.getResourceUsage).mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    ipcRenderer.emit(MONITOR_REQUEST, {}, 1, true);
    ipcRenderer.emit(MONITOR_REQUEST, {}, 2, true);
    expect(native).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipcRenderer.send).mock.calls[0]?.[2]).toMatchObject({
      jsHeapUsedBytes: 12 * 1024,
      development: { processMemory: null, caches: null },
    });
    ipcRenderer.emit(MONITOR_REQUEST, {}, 3, true);
    await vi.runAllTimersAsync();
    expect(native).toHaveBeenCalledOnce();
    expect(ipcRenderer.send).toHaveBeenCalledTimes(2);
  });

  it('preload 不把字符串开关当作完整采样，非法序号不采样，异常后可以继续', async () => {
    const document = preloadFixture();
    for (const sequence of [NaN, Infinity, '1'])
      ipcRenderer.emit(MONITOR_REQUEST, {}, sequence, true);
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    for (const flag of [undefined, false, 'true', 1])
      ipcRenderer.emit(MONITOR_REQUEST, {}, 1, flag);
    expect(document.querySelectorAll).not.toHaveBeenCalled();
    expect(webFrame.getResourceUsage).not.toHaveBeenCalled();
    expect(ipcRenderer.send).toHaveBeenCalledTimes(4);
    vi.spyOn(process, 'getHeapStatistics').mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    ipcRenderer.emit(MONITOR_REQUEST, {}, 2, false);
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(MONITOR_RESPONSE, 2, null);
    ipcRenderer.emit(MONITOR_REQUEST, {}, 3, false);
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(
      MONITOR_RESPONSE,
      3,
      expect.objectContaining({ jsHeapUsedBytes: 12 * 1024 }),
    );
  });
});
