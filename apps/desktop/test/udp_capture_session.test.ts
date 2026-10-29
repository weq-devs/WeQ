// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * UDP 抓包会话的归属与幂等语义。
 *
 * 用 `vi.mock` 替换平台与提权链路，只测「会话表 / 串行化 / sessionId 校验」这几
 * 条本模块自己的逻辑 —— 抓包本身由 nt_helper 的集成测试覆盖。
 */

const startCapture = vi.fn(async () => ({
  pid: 42,
  iface: 'auto',
  port: 'auto',
  linktype: 12,
}));
const takeFrames = vi.fn(async () => ({ frames: [], nextCursor: 0, dropped: 0 }));
const stopCapture = vi.fn(async () => ({ frames: 0, dropped: 0, packets: 0 }));

vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({
    native: {
      ntHelper: {
        probeCaptureSupport: () => ({
          available: true,
          backend: 'test',
          elevated: true,
          hint: '',
        }),
        startCapture,
        takeFrames,
        stopCapture,
        listProcessesWithModule: (hint: string) => [
          { pid: 7, ppid: 1, name: 'qq', cmdline: `/opt/QQ/qq --type=ppapi`, modules: [hint] },
        ],
      },
    },
  }),
}));

vi.mock('@weq/service', () => ({
  getLogger: () => ({
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../src/main/capture_elevation', () => ({
  startElevatedCaptureWorker: vi.fn(),
}));

vi.mock('../src/main/capture_protocol', async () => {
  const actual = await vi.importActual<typeof import('../src/main/capture_protocol')>(
    '../src/main/capture_protocol',
  );
  return { ...actual, toCaptureFrameWire: (frame: unknown) => frame };
});

const {
  startUdpCapture,
  stopUdpCapture,
  takeUdpDatagrams,
  listProcessesWithModule,
  probeProcessScan,
  disposeUdpCaptures,
} = await import('../src/main/udp_capture_session');

describe('UDP 抓包会话', () => {
  it('开始后能按 sessionId 取帧，停止后会话失效', async () => {
    disposeUdpCaptures();
    const handle = await startUdpCapture(42);
    expect(handle.pid).toBe(42);
    expect(handle.elevated).toBe(false);
    expect(handle.sessionId).toMatch(/^udp-/);
    expect(startCapture).toHaveBeenCalledWith(42, expect.objectContaining({ transport: 'udp' }));

    await expect(takeUdpDatagrams(42, { sessionId: handle.sessionId })).resolves.toBeDefined();

    await stopUdpCapture(42, handle.sessionId);
    await expect(takeUdpDatagrams(42, { sessionId: handle.sessionId })).rejects.toThrow(
      '没有正在进行的 UDP 抓包会话',
    );
  });

  it('用旧的 sessionId 取帧会被拒绝', async () => {
    disposeUdpCaptures();
    const handle = await startUdpCapture(42);
    await expect(takeUdpDatagrams(42, { sessionId: 'stale' })).rejects.toThrow('已失效');
    await stopUdpCapture(42, handle.sessionId);
  });

  it('停止是幂等的，重复停止返回 null', async () => {
    disposeUdpCaptures();
    const handle = await startUdpCapture(42);
    await expect(stopUdpCapture(42, handle.sessionId)).resolves.toBeDefined();
    await expect(stopUdpCapture(42, handle.sessionId)).resolves.toBeNull();
  });

  it('重复开始同一个 pid 会先停掉旧会话', async () => {
    disposeUdpCaptures();
    const first = await startUdpCapture(42);
    const second = await startUdpCapture(42);
    expect(second.sessionId).not.toBe(first.sessionId);
    // 旧 sessionId 不再有效。
    await expect(takeUdpDatagrams(42, { sessionId: first.sessionId })).rejects.toThrow('已失效');
    await stopUdpCapture(42, second.sessionId);
  });

  it('进程扫描能力可探测，且能按模块 hint 找进程', () => {
    expect(probeProcessScan()).toBe(true);
    const found = listProcessesWithModule('avsdk');
    expect(found).toHaveLength(1);
    expect(found[0]!.modules).toEqual(['avsdk']);
  });
});
