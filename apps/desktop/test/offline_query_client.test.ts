import { onlineManager } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient } from '../src/renderer/src/trpc/queryClient';

const clients: ReturnType<typeof createQueryClient>[] = [];

function client(isWeb = false) {
  const cache = createQueryClient(isWeb);
  clients.push(cache);
  cache.mount();
  return cache;
}

afterEach(() => {
  for (const cache of clients.splice(0)) {
    cache.unmount();
    cache.clear();
  }
  onlineManager.setOnline(undefined);
});

it('断网启动仍读取本机环境、账号与会话', async () => {
  onlineManager.setOnline(false);
  const cache = client();
  const read = vi.fn(async () => '本地数据');
  const result = cache.fetchQuery(['bootstrap', 'nativeStatus'], read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(await result).toBe('本地数据');
  expect(cache.getQueryState(['bootstrap', 'nativeStatus'])?.fetchStatus).toBe('idle');
});

it('断网时本机保存仍立即执行', async () => {
  onlineManager.setOnline(false);
  const cache = client();
  const save = vi.fn(async () => '已保存');
  const mutation = cache.getMutationCache().build(cache, { mutationFn: save });
  const result = mutation.execute();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(await result).toBe('已保存');
  expect(mutation.state.isPaused).toBe(false);
});

it('请求期间断网不暂停本机查询重试', async () => {
  onlineManager.setOnline(true);
  const cache = client();
  const read = vi.fn(async () => {
    if (read.mock.calls.length === 1) {
      onlineManager.setOnline(false);
      throw new Error('本地暂忙');
    }
    return '本地数据';
  });
  const result = cache.fetchQuery({
    queryKey: ['account'],
    queryFn: read,
    retry: 1,
    retryDelay: 0,
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(await result).toBe('本地数据');
});

it('Web 断网仍暂停网络查询和提交，重连后继续', async () => {
  onlineManager.setOnline(false);
  const cache = client(true);
  const read = vi.fn(async () => '远端数据');
  const save = vi.fn(async () => '已提交');
  const query = cache.fetchQuery(['remote'], read);
  const mutation = cache.getMutationCache().build(cache, { mutationFn: save });
  const result = mutation.execute();
  await vi.waitFor(() => {
    expect(cache.getQueryState(['remote'])?.fetchStatus).toBe('paused');
    expect(mutation.state.isPaused).toBe(true);
  });
  expect(read).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  onlineManager.setOnline(true);
  expect(await query).toBe('远端数据');
  expect(await result).toBe('已提交');
});
