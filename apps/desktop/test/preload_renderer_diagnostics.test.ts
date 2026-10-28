import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcRenderer, webFrame } from 'electron';
import { installRendererDiagnosticSampling } from '../src/preload/renderer_diagnostics';
import { DIAGNOSTIC_SAMPLE_REQUEST } from '../src/shared/renderer_diagnostics';

vi.mock('electron', () => ({
  ipcRenderer: Object.assign(new EventEmitter(), { send: vi.fn() }),
  webFrame: { getResourceUsage: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  ipcRenderer.removeAllListeners();
  vi.restoreAllMocks();
  vi.mocked(webFrame.getResourceUsage).mockReset();
  vi.mocked(ipcRenderer.send).mockClear();
});

describe('开发采样 preload', () => {
  it('读取原生进程内存和 V8 KB 指标，异步等待期间不叠加采样', async () => {
    let resolve!: (value: Electron.ProcessMemoryInfo) => void;
    const native = vi.fn(
      () =>
        new Promise<Electron.ProcessMemoryInfo>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('process', {
      ...process,
      memoryUsage: () => ({ heapUsed: 100 }),
      getBlinkMemoryInfo: () => ({ allocated: 2 }),
      getHeapStatistics: () => ({ heapSizeLimit: 4096 }),
      getProcessMemoryInfo: native,
    });
    installRendererDiagnosticSampling();
    ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, true);
    ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 2, true);
    expect(native).toHaveBeenCalledTimes(1);
    resolve({ private: 123, shared: 4 } as Electron.ProcessMemoryInfo);
    await vi.waitFor(() => expect(ipcRenderer.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipcRenderer.send).mock.calls[0]?.[2]).toMatchObject({
      development: {
        processMemory: { privateKB: 123, sharedKB: 4 },
        heap: { heapSizeLimit: 4096 },
      },
    });
  });

  it('原生 API 卡住时有界返回，其余采样继续且不再发起原生请求', async () => {
    vi.useFakeTimers();
    try {
      const native = vi.fn(() => new Promise<Electron.ProcessMemoryInfo>(() => {}));
      vi.stubGlobal('process', {
        ...process,
        memoryUsage: () => ({ heapUsed: 100 }),
        getBlinkMemoryInfo: () => ({ allocated: 2 }),
        getProcessMemoryInfo: native,
      });
      installRendererDiagnosticSampling();
      ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, true);
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.mocked(ipcRenderer.send).mock.calls.at(-1)?.[2]).toMatchObject({
        jsHeapUsedBytes: 100,
        development: { processMemory: null },
      });
      ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 2, true);
      expect(native).toHaveBeenCalledTimes(1);
      expect(ipcRenderer.send).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('普通采样不读取 Chromium 缓存或动画，也不接受非布尔开关', () => {
    const animations = vi.fn(() => []);
    const query = vi.fn(() => []);
    vi.stubGlobal('document', {
      dispatchEvent: vi.fn(),
      getElementById: () => null,
      getElementsByTagName: () => ({ length: 0 }),
      getAnimations: animations,
      querySelectorAll: query,
    });
    installRendererDiagnosticSampling();
    for (const flag of [undefined, false, 'true', 1]) {
      ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, flag);
    }
    expect(webFrame.getResourceUsage).not.toHaveBeenCalled();
    expect(animations).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(ipcRenderer.send).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(ipcRenderer.send).mock.calls) {
      expect(call[2]).not.toHaveProperty('development');
    }
  });

  it('开发采样附带固定页面与组件细节，异常动画 API 不丢失 DOM 统计', () => {
    const ownerDocument = document;
    ownerDocument.body.innerHTML =
      '<div class="weq-export-tool"><div class="weq-exp-card"></div></div>';
    vi.stubGlobal('document', {
      dispatchEvent: ownerDocument.dispatchEvent.bind(ownerDocument),
      getElementById: ownerDocument.getElementById.bind(ownerDocument),
      getElementsByTagName: ownerDocument.getElementsByTagName.bind(ownerDocument),
      querySelectorAll: ownerDocument.querySelectorAll.bind(ownerDocument),
      getAnimations() {
        throw new Error('unavailable');
      },
    });
    installRendererDiagnosticSampling();
    ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, true);
    expect(vi.mocked(ipcRenderer.send).mock.calls.at(-1)?.[2]).toMatchObject({
      development: {
        surfaces: { export: { mounted: 1 } },
        components: { exportCards: { count: 1 } },
        animationDetails: null,
        sampleDurationMs: expect.any(Number),
      },
    });
    ownerDocument.body.replaceChildren();
  });

  it('开发采样读取缓存与动画计数；缓存 API 失败仍保留其它指标', () => {
    vi.stubGlobal('document', {
      dispatchEvent: vi.fn(),
      getElementById: () => null,
      getElementsByTagName: () => ({ length: 3 }),
      getAnimations: () => [{ playState: 'running' }, { playState: 'paused' }],
      visibilityState: 'hidden',
    });
    vi.mocked(webFrame.getResourceUsage).mockImplementation(() => {
      throw new Error('unavailable');
    });
    installRendererDiagnosticSampling();
    ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, true);
    expect(webFrame.getResourceUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipcRenderer.send).mock.calls.at(-1)?.[2]).toMatchObject({
      domNodes: 3,
      development: { caches: null, animations: 2, runningAnimations: 1, documentVisible: false },
    });
    const cache = { count: 1, size: 2048, liveSize: 4096 };
    vi.mocked(webFrame.getResourceUsage).mockReturnValue({
      images: cache,
      scripts: cache,
      cssStyleSheets: cache,
      xslStyleSheets: cache,
      fonts: cache,
      other: cache,
    });
    ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 2, true);
    expect(vi.mocked(ipcRenderer.send).mock.calls.at(-1)?.[2]).toMatchObject({
      development: { caches: { images: cache } },
    });
  });
});
