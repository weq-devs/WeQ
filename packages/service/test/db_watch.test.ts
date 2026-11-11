import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';

const fs = vi.hoisted(() => ({
  files: new Map<string, { size: number; mtimeMs: number }>(),
  listener: undefined as ((event: string, filename: string | null) => void) | undefined,
  close: vi.fn(),
  failWatch: false,
  error: undefined as (() => void) | undefined,
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
    return {
      close: fs.close,
      on: (event: string, listener: () => void) => {
        if (event === 'error') fs.error = listener;
      },
    };
  },
}));
import { DbWatchService } from '../src/account/db_watch';
import { createNtMsgDbHook } from '../src/account/nt_msg_hook';

afterEach(() => {
  vi.useRealTimers();
  fs.files.clear();
  fs.listener = undefined;
  fs.close.mockClear();
  fs.failWatch = false;
  fs.error = undefined;
});

describe('数据库文件变化监听', () => {
  it('卸载真实消息 hook 时取消独立补齐重试，不继续持有旧账号读取', async () => {
    vi.useFakeTimers();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 1 });
    let watermark = 0n;
    const listSeqWatermarks = vi.fn(async () => [
      { targetUid: '123456', chatType: 2, msgSeq: watermark, sendTime: 1n },
    ]);
    const listAfter = vi.fn(async () => []);
    const hook = createNtMsgDbHook(
      {
        msgDbPath: '/fixture/nt_msg.db',
        recentContacts: { listSeqWatermarks },
        groupMsgs: { listAfter },
      } as unknown as AccountSession,
      { onDbChanged: () => {}, onNewMessages: vi.fn() },
    );
    const dispose = vi.spyOn(hook, 'dispose');
    const service = new DbWatchService();
    const handle = service.mount(hook);
    try {
      await vi.advanceTimersByTimeAsync(0);
      watermark = 1n;
      fs.files.set('nt_msg.db', { size: 10, mtimeMs: 2 });
      service.pollNow();
      await vi.advanceTimersByTimeAsync(10);
      expect(listAfter).toHaveBeenCalledOnce();
      const reads = listSeqWatermarks.mock.calls.length;
      handle.unmount();
      handle.unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(listSeqWatermarks).toHaveBeenCalledTimes(reads);
      expect(listAfter).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      service.dispose();
      hook.dispose?.();
    }
  });

  it('文件监听报错只关闭 watcher，轮询回退仍运行原任务，最终卸载才释放', async () => {
    vi.useFakeTimers();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 1 });
    const service = new DbWatchService();
    const dispose = vi.fn();
    const hook = vi.fn();
    const handle = service.mount({
      dbPath: '/fixture/nt_msg.db',
      onDbFileChangeHook: hook,
      dispose,
    });
    try {
      fs.error?.();
      expect(fs.close).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      fs.files.set('nt_msg.db', { size: 10, mtimeMs: 2 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(hook).toHaveBeenCalledOnce();
      handle.unmount();
      expect(dispose).toHaveBeenCalledOnce();
      expect(fs.close).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });

  it('任务独立卸载，整体销毁与旧句柄重复卸载均只释放一次', async () => {
    vi.useFakeTimers();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 1 });
    const service = new DbWatchService();
    const firstDispose = vi.fn(),
      secondDispose = vi.fn(),
      secondRead = vi.fn();
    const first = service.mount({
      dbPath: '/fixture/nt_msg.db',
      onDbFileChangeHook: vi.fn(),
      dispose: firstDispose,
    });
    const second = service.mount({
      dbPath: '/fixture/nt_msg.db',
      onDbFileChangeHook: secondRead,
      dispose: secondDispose,
    });
    first.unmount();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    fs.files.set('nt_msg.db', { size: 10, mtimeMs: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(secondRead).toHaveBeenCalledOnce();
    service.dispose();
    service.dispose();
    first.unmount();
    second.unmount();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(fs.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

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
