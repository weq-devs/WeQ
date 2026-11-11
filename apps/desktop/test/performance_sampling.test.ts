import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_REQUEST, MONITOR_RESPONSE } from '../src/shared/performance_monitor';
const electron = vi.hoisted(() => ({ on: vi.fn(), send: vi.fn(), resources: vi.fn(() => ({})) }));
vi.mock('electron', () => ({
  ipcRenderer: { on: electron.on, send: electron.send },
  webFrame: { getResourceUsage: electron.resources },
}));
import { installPerformanceSampling } from '../src/preload/performance_monitor';
import { collectBatchedDevelopmentDetails } from '../src/preload/development_diagnostics';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function documentFixture() {
  return {
    dispatchEvent: vi.fn(),
    getElementById: () => ({ getAttribute: () => '{"retainedImages":2}' }),
    querySelectorAll: vi.fn(() => []),
    styleSheets: [],
    getAnimations: vi.fn(() => []),
    visibilityState: 'visible',
  };
}
describe('正式性能采样', () => {
  it('轻量采样只读堆和已有缓存，不扫描 DOM 或动画，不读取完整资源缓存', async () => {
    const document = documentFixture();
    vi.stubGlobal('document', document);
    Object.assign(process, {
      getHeapStatistics: vi.fn(() => ({ usedHeapSize: 12, totalHeapSize: 24 })),
    });
    installPerformanceSampling();
    const handler = electron.on.mock.calls.find(([channel]) => channel === MONITOR_REQUEST)![1];
    await handler({}, 1, false);
    expect(document.querySelectorAll).not.toHaveBeenCalled();
    expect(document.getAnimations).not.toHaveBeenCalled();
    expect(electron.resources).not.toHaveBeenCalled();
    expect(electron.send).toHaveBeenCalledWith(
      MONITOR_RESPONSE,
      1,
      expect.objectContaining({ jsHeapUsedBytes: 12 * 1024, resources: { retainedImages: 2 } }),
    );
    Reflect.deleteProperty(process, 'getHeapStatistics');
  });
  it('完整分类分批让出执行权；空动画和媒体为零，统计不持有节点', async () => {
    const document = documentFixture(),
      yields = vi.spyOn(globalThis, 'setTimeout');
    const sample = await collectBatchedDevelopmentDetails(document);
    expect(yields.mock.calls.length).toBeGreaterThan(10);
    expect(sample.value.media.images).toBe(0);
    expect(sample.value.animations).toBe(0);
    expect(sample.value.styles.rules).toBe(0);
    expect(sample.syncMs).toBeGreaterThanOrEqual(0);
    expect(sample.waitMs).toBeGreaterThan(0);
  });
});
