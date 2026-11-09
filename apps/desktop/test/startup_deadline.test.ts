import { expect, it, vi } from 'vitest';
import { startupDeadline } from '../src/renderer/src/lib/startupDeadline';
import { serializeBackupClient } from '../src/renderer/src/lib/backupClientRestore';

it('等待浏览器恢复锁时也受同一超时约束，不执行尚未获得锁的恢复', async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => true);
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    },
  });
  try {
    const result = startupDeadline((signal) => serializeBackupClient(run, signal));
    const assertion = expect(result).rejects.toThrow('启动检查');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('未返回的启动请求超时退出并取消底层请求', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const result = startupDeadline((value) => {
      signal = value;
      return new Promise(() => {});
    });
    const assertion = expect(result).rejects.toThrow('启动检查');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('正常完成不取消请求并清理计时器', async () => {
  vi.useFakeTimers();
  try {
    await expect(startupDeadline(async () => 'ready')).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
