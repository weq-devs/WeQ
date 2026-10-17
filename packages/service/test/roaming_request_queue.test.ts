import { describe, expect, it, vi } from 'vitest';

describe('shared native roaming request queue', () => {
  it('serializes in-flight reads and spaces actual dispatches rather than admission attempts', async () => {
    vi.resetModules();
    const { withRoamingRequest } = await import('../src/common/roaming_request_queue');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: number[] = [];
    let inFlight = 0,
      maximum = 0;
    const first = withRoamingRequest(async () => {
      starts.push(Date.now());
      maximum = Math.max(maximum, ++inFlight);
      await pending;
      inFlight--;
    });
    const second = withRoamingRequest(async () => {
      starts.push(Date.now());
      maximum = Math.max(maximum, ++inFlight);
      inFlight--;
    });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(490);
  });
  it('never dispatches an aborted queued request and still releases its FIFO slot', async () => {
    vi.resetModules();
    const { withRoamingRequest } = await import('../src/common/roaming_request_queue');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRoamingRequest(() => pending);
    const controller = new AbortController(),
      send = vi.fn();
    const cancelled = withRoamingRequest(send, { signal: controller.signal }).catch(
      (error) => error,
    );
    const next = vi.fn(async () => true);
    const last = withRoamingRequest(next);
    controller.abort();
    release();
    await first;
    expect((await cancelled).name).toBe('AbortError');
    expect(send).not.toHaveBeenCalled();
    expect(await last).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
});
