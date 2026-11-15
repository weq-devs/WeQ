// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: fixture.fork }));
vi.mock('@weq/service', () => ({ localOcrBlocker: () => null }));
vi.mock('../src/main/worker_path', () => ({
  resolveChildWorkerPath: () => '/synthetic/ocrWorker.mjs',
}));
vi.mock('../src/main/enhancements/engine_environment', () => ({
  enhancementEngineAvailable: () => true,
  enhancementEngineEnvironment: () => ({}),
  withEnhancementEngine: (_kind: string, run: () => unknown) => run(),
}));
import { runOcrEngine } from '../src/main/ocr/engine';
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it.each(['cancel', 'timeout', 'success'] as const)(
  'OCR %s 后关闭本轮 worker 和定时器',
  async (finish) => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
      kill: vi.fn(),
    });
    fixture.fork.mockReturnValue(worker);
    const controller = new AbortController();
    const work = runOcrEngine({
      image: { width: 1, height: 1, data: new Uint8Array(3) },
      paths: { det: '/synthetic/det' },
      signal: controller.signal,
    });
    if (finish === 'cancel') controller.abort();
    if (finish === 'timeout') await vi.advanceTimersByTimeAsync(60_001);
    if (finish === 'success') worker.emit('message', { type: 'final', lines: [] });
    expect((await work).ok).toBe(finish === 'success');
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(worker.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
