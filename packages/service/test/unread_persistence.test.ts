import { afterEach, expect, it, vi } from 'vitest';
import { LocalUnreadStore, waitForUnreadWrites } from '../src/account/local_unread';
import { writeFileAtomic } from '../src/common/atomic_write';

vi.mock('../src/common/atomic_write', () => ({ writeFileAtomic: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('同一状态文件只有一个写者，旧版本完成不提前确认新版本，正常收尾等待发布', async () => {
  const writes: Array<{ data: string; finish(): void }> = [];
  let active = 0,
    peak = 0;
  vi.mocked(writeFileAtomic).mockImplementation(async (_path, data) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((finish) => writes.push({ data: String(data), finish }));
    active--;
  });
  const store = new LocalUnreadStore('/synthetic-unread-fixture/state.json');
  store.recordLive(1, 'u_fixture', '10');
  const first = store.flush();
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  store.recordLive(1, 'u_fixture', '11');
  const second = store.flush();
  let saved = false;
  void second.then(() => {
    saved = true;
  });
  writes[0]!.finish();
  await first;
  await Promise.resolve();
  expect(saved).toBe(false);
  expect(writes).toHaveLength(2);
  const closing = waitForUnreadWrites();
  expect(JSON.parse(writes[1]!.data)['1_u_fixture'].pending).toEqual(['10', '11']);
  writes[1]!.finish();
  await second;
  await closing;
  expect(saved).toBe(true);
  expect(peak).toBe(1);
});

it('写失败不清除未保存版本，下一次 flush 可重试，突发修改合并到一个快照', async () => {
  const write = vi
    .mocked(writeFileAtomic)
    .mockRejectedValueOnce(new Error('磁盘不可写'))
    .mockResolvedValue(undefined);
  const store = new LocalUnreadStore('/synthetic-unread-fixture/state.json');
  store.recordLive(1, 'u_fixture', '10');
  await expect(store.flush()).rejects.toThrow('磁盘不可写');
  store.recordLive(1, 'u_fixture', '11');
  const tasks = [store.flush()];
  store.recordLive(1, 'u_fixture', '12');
  tasks.push(store.flush());
  await Promise.all(tasks);
  expect(write).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(write.mock.calls[1]![1]))['1_u_fixture'].pending).toEqual([
    '10',
    '11',
    '12',
  ]);
  await store.flush();
  expect(write).toHaveBeenCalledTimes(2);
});
