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
  it('普通采样不读取 Chromium 缓存或动画，也不接受非布尔开关', () => {
    const animations = vi.fn(() => []);
    vi.stubGlobal('document', {
      dispatchEvent: vi.fn(),
      getElementById: () => null,
      getElementsByTagName: () => ({ length: 0 }),
      getAnimations: animations,
    });
    installRendererDiagnosticSampling();
    for (const flag of [undefined, false, 'true', 1]) {
      ipcRenderer.emit(DIAGNOSTIC_SAMPLE_REQUEST, {}, 1, flag);
    }
    expect(webFrame.getResourceUsage).not.toHaveBeenCalled();
    expect(animations).not.toHaveBeenCalled();
    expect(ipcRenderer.send).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(ipcRenderer.send).mock.calls) {
      expect(call[2]).not.toHaveProperty('development');
    }
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
