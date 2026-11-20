// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { sysEmojiRouter } from '../src/main/ipc/routers/sys_emoji';

const services = vi.hoisted(() => ({
  sysEmojiDownload: { ensureAll: vi.fn() },
  sysEmoji: { invalidate: vi.fn() },
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => ({ services }) }));

it('两处补全请求共用同一批，并能读到实际处理数和失败结果', async () => {
  const result = { downloaded: 2, skipped: 3, failed: 1, unavailable: 0 };
  const finish = Promise.withResolvers<typeof result>();
  const entered = Promise.withResolvers<(done: number, total: number) => void>();
  services.sysEmojiDownload.ensureAll.mockImplementation((report) => {
    entered.resolve(report);
    return finish.promise;
  });
  const caller = sysEmojiRouter.createCaller({});
  const first = caller.downloadAll();
  const second = caller.downloadAll();
  try {
    const report = await entered.promise;
    expect(await caller.downloadProgress()).toEqual({ phase: 'preparing' });
    report(4, 6);
    expect(await caller.downloadProgress()).toEqual({ phase: 'running', done: 4, total: 6 });
  } finally {
    finish.resolve(result);
    expect(await Promise.all([first, second])).toEqual([result, result]);
  }
  expect(services.sysEmojiDownload.ensureAll).toHaveBeenCalledOnce();
  expect(services.sysEmoji.invalidate).toHaveBeenCalledOnce();
  expect(await caller.downloadProgress()).toEqual({ phase: 'finished', result });
});
