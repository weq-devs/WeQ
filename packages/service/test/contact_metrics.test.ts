import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactMetricsService } from '../src/account/contact_metrics';

const roots: string[] = [];
const services: ContactMetricsService[] = [];
async function setup(online = () => true, interval = 0, concurrency = 2) {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-test-'));
  roots.push(root);
  const path = join(root, 'metrics.json');
  const service = new ContactMetricsService(path, online, { interval, concurrency });
  services.push(service);
  return { service, path };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('好友和群聊分支同时运行，各自进度不等待另一分支', async () => {
  const { service } = await setup();
  let release!: () => void;
  const group = vi.fn(async () => {});
  service.start([
    {
      key: 'friend:123',
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    },
    { key: 'group:456', run: group },
  ]);
  await vi.waitFor(() => expect(group).toHaveBeenCalledTimes(1));
  expect(service.progress.lanes?.groups.done).toBe(1);
  expect(service.progress.lanes?.friends.done).toBe(0);
  release();
  await vi.waitFor(() => expect(service.progress.status).toBe('completed'));
  expect(service.progress.done).toBe(2);
});

it('区分真实零、未知和失败；失败保留旧值，持久化后按旧值加载', async () => {
  const { service, path } = await setup();
  await service.query(
    'friend:123',
    ['commonFriends'],
    async () => 0,
    (value) => ({ commonFriends: value }),
  );
  await expect(
    service.query(
      'friend:123',
      ['commonFriends'],
      async () => {
        throw new Error('暂不可用');
      },
      () => ({}),
    ),
  ).rejects.toThrow('暂不可用');
  const rows = (await service.snapshot()).rows;
  expect(rows['friend:123']?.commonFriends).toMatchObject({
    value: 0,
    state: 'failed',
    error: '暂不可用',
  });
  expect(rows['friend:123']?.commonGroups).toBeUndefined();
  await service.flush();
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  const reopened = new ContactMetricsService(path, () => true);
  services.push(reopened);
  expect((await reopened.snapshot()).rows['friend:123']?.commonFriends).toMatchObject({
    value: 0,
    state: 'failed',
  });
});

it('同目标去重，后来的成功观察不被早发出的慢查询覆盖', async () => {
  const { service } = await setup();
  let release!: (value: number) => void;
  const work = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const first = service.query('friend:123', ['level'], work, (level) => ({ level }));
  const second = service.query('friend:123', ['level'], work, (level) => ({ level }));
  await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
  await service.record('friend:123', { level: 99 });
  release(1);
  await Promise.all([first, second]);
  expect((await service.snapshot()).rows['friend:123']?.level?.value).toBe(99);
});

it('按账号文件隔离，坏格式不能进入有效指标', async () => {
  const a = await setup(),
    b = await setup();
  await a.service.record('friend:u_test', { likeCount: 42 });
  expect((await b.service.snapshot()).rows).toEqual({});
  await a.service.flush();
  await writeFile(
    b.path,
    JSON.stringify({
      version: 1,
      rows: {
        'friend:123': {
          commonGroups: { attemptedAt: 1, value: [{ name: '缺少群号' }] },
          level: { attemptedAt: 1, value: -1 },
        },
      },
    }),
  );
  const reopened = new ContactMetricsService(b.path, () => true);
  services.push(reopened);
  expect((await reopened.snapshot()).rows['friend:123']).toEqual({});
});

it('在线共同群只记录返回列表，不接受本地计数替代', async () => {
  const { service } = await setup();
  await service.record('friend:123', { commonGroups: 10 });
  expect((await service.snapshot()).rows['friend:123']?.commonGroups).toBeUndefined();
  await service.query(
    'friend:123',
    ['commonGroups'],
    async () => [{ groupCode: '12345', name: '合成群' }],
    (commonGroups) => ({ commonGroups }),
  );
  expect((await service.snapshot()).rows['friend:123']?.commonGroups?.value).toEqual([
    { groupCode: '12345', name: '合成群' },
  ]);
});

it('无关数据库变化重新读到同值，不重置其他群的缓存时间', async () => {
  const { service } = await setup();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 8 * 86400000);
  await service.record('group:12345', { friendCount: 2 });
  clock.mockRestore();
  await service.recordIfChanged('group:12345', { friendCount: 2 });
  expect((await service.row('group:12345')).friendCount?.updatedAt).toBe(now - 8 * 86400000);
  await service.recordIfChanged('group:12345', { friendCount: 3 });
  expect((await service.row('group:12345')).friendCount?.updatedAt).toBeGreaterThanOrEqual(now);
});

it('调度并发不超过二、启动间隔生效，普通查询优先于排队重建', async () => {
  const { service } = await setup(() => true, 15, 2);
  const starts: number[] = [],
    order: string[] = [];
  let concurrent = 0,
    max = 0;
  const run = (name: string) => async () => {
    starts.push(Date.now());
    order.push(name);
    concurrent++;
    max = Math.max(max, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 35));
    concurrent--;
    return name;
  };
  await Promise.all([
    service.schedule('bulk1', run('bulk1'), 1),
    service.schedule('bulk2', run('bulk2'), 1),
    service.schedule('user', run('user'), 0),
  ]);
  expect(order[0]).toBe('user');
  expect(max).toBeLessThanOrEqual(2);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(12);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(12);
});

it('离线暂停、继续、部分失败只重试失败项', async () => {
  let online = false;
  const { service } = await setup(() => online);
  const good = vi.fn(async () => {}),
    bad = vi.fn().mockRejectedValueOnce(new Error('失败')).mockResolvedValue(undefined);
  service.start([
    { key: 'friend:good', run: good },
    { key: 'friend:bad', run: bad },
  ]);
  await vi.waitFor(() => expect(service.progress.status).toBe('paused'));
  expect(good).not.toHaveBeenCalled();
  online = true;
  service.resume();
  await vi.waitFor(() => expect(service.progress.status).toBe('failed'));
  service.resume();
  await vi.waitFor(() => expect(service.progress.status).toBe('completed'));
  expect(good).toHaveBeenCalledTimes(1);
  expect(bad).toHaveBeenCalledTimes(2);
});

it('取消不再启动剩余工作，关闭后排队与在途响应均不能更新缓存', async () => {
  const { service } = await setup();
  let release!: () => void;
  const later = vi.fn(async () => {});
  service.start([
    {
      key: 'first',
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    },
    { key: 'second', run: later },
  ]);
  await vi.waitFor(() => expect(release).toBeDefined());
  service.cancel();
  release();
  await vi.waitFor(() => expect(service.progress.status).toBe('cancelled'));
  expect(later).not.toHaveBeenCalled();
  let resolveQuery!: (value: number) => void;
  const query = service.query(
    'friend:123',
    ['level'],
    () =>
      new Promise<number>((resolve) => {
        resolveQuery = resolve;
      }),
    (level) => ({ level }),
  );
  await vi.waitFor(() => expect(resolveQuery).toBeDefined());
  const rejected = expect(query).rejects.toThrow('账号已关闭');
  await service.dispose();
  resolveQuery(100);
  await rejected;
  expect((await service.snapshot()).rows['friend:123']).toBeUndefined();
});
