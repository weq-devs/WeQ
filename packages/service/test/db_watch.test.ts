import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  files: new Map<string, { size: number; mtimeMs: number }>(),
  listener: undefined as ((event: string, filename: string | null) => void) | undefined,
  close: vi.fn(),
  failWatch: false,
}));
vi.mock('node:fs', () => ({
  readdirSync: () => [...fs.files.keys()],
  statSync: (path: string) => ({
    ...fs.files.get(path.split('/').at(-1)!),
    isFile: () => true,
  }),
  watch: (_path: string, _options: unknown, listener: typeof fs.listener) => {
    if (fs.failWatch) throw new Error('watch unavailable');
    fs.listener = listener;
    return { close: fs.close, on: vi.fn() };
  },
}));
import { DbWatchService } from '../src/account/db_watch';

afterEach(() => {
  vi.useRealTimers();
  fs.files.clear();
  fs.listener = undefined;
  fs.close.mockClear();
  fs.failWatch = false;
});

describe('数据库文件变化监听', () => {
  it('慢查询期间不并发，完成后快速补查，不再等下一秒轮询', async () => {
    vi.useFakeTimers();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 1 });
    const service = new DbWatchService();
    let release: () => void = () => {};
    const hook = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    service.mount({ dbPath: '/fixture/nt_msg.db', onDbFileChangeHook: hook });
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 2 });
    fs.listener?.('change', 'nt_msg.db');
    await vi.advanceTimersByTimeAsync(100);
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 3 });
    fs.listener?.('change', 'nt_msg.db');
    await vi.advanceTimersByTimeAsync(100);
    expect(hook).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(hook).toHaveBeenCalledTimes(2);
    service.dispose();
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('文件事件快速触发，重复事件合并；只看相关文件，卸载关闭监听', async () => {
    vi.useFakeTimers();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 1 });
    const service = new DbWatchService();
    const hook = vi.fn();
    const handle = service.mount({ dbPath: '/fixture/nt_msg.db', onDbFileChangeHook: hook });
    fs.files.set('nt_msg.db-wal', { size: 20, mtimeMs: 2 });
    fs.listener?.('rename', 'nt_msg.db-wal');
    fs.listener?.('change', 'nt_msg.db-wal');
    await vi.advanceTimersByTimeAsync(100);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0].total).toBe(30);
    fs.files.set('nt_msg.db-wal', { size: 20, mtimeMs: 3 });
    fs.listener?.('change', 'other.db');
    await vi.advanceTimersByTimeAsync(50);
    expect(hook).toHaveBeenCalledTimes(1);
    fs.listener?.('change', null);
    handle.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(fs.close).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('主文件时间较新时仍能发现固定大小 WAL 原地写入，事件不可用时轮询兜底', async () => {
    vi.useFakeTimers();
    fs.failWatch = true;
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 100 });
    fs.files.set('nt_msg.db-wal', { size: 20, mtimeMs: 1 });
    const service = new DbWatchService();
    const hook = vi.fn();
    service.mount({ dbPath: '/fixture/nt_msg.db', onDbFileChangeHook: hook });
    fs.files.set('nt_msg.db-wal', { size: 20, mtimeMs: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0].delta).toBe(0);
    service.dispose();
  });
});
