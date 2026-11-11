import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GetGroupJoinInfo, GetGroupMessagePolicies } from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { GroupProfileReader } from '../src/account/group_profile';
import { GroupInfoService } from '../src/account/group_info';
import {
  ContactHistoryService,
  decodeContactValue,
  encodeContactValue,
} from '../src/account/contact_history';
import {
  CONTACT_HISTORY_CAPTURE,
  installContactHistoryCapture,
} from '../src/account/contact_history_capture';
import { ContactMetricsService } from '../src/account/contact_metrics';
import { createRequire } from 'node:module';
import type { Worker } from 'node:worker_threads';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

const opened: ContactHistoryService[] = [];
const roots: string[] = [];
async function open() {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-history-'));
  roots.push(root);
  const history = new ContactHistoryService(root);
  opened.push(history);
  await history.migration;
  return history;
}
afterEach(async () => {
  for (const history of opened.splice(0)) await history.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('内容去重不丢失 A → B → A 的观察顺序，同值读取只更新最近时间', async () => {
  const h = await open();
  const key = { entity: 'friend:u_test', category: 'profile', source: 'local' as const };
  const a = await h.observe({ ...key, value: { nick: 'A', gender: 1 }, at: 100 });
  expect(await h.observe({ ...key, value: { gender: 1, nick: 'A' }, at: 200 })).toBe(a);
  await h.observe({ ...key, value: { nick: 'B', gender: 1 }, at: 300 });
  const returned = await h.observe({ ...key, value: { nick: 'A', gender: 1 }, at: 400 });
  expect(returned).not.toBe(a);
  expect((await h.list(key.entity)).rows.map((row) => row.first_at)).toEqual([400, 300, 100]);
  expect((await h.version(key.entity, a)).last_at).toBe(200);
  expect((await h.status()).contents).toBe(2);
  expect((await h.diff(key.entity, returned)).previous?.value).toEqual({ nick: 'B', gender: 1 });
});

it('无损保留类型、字段缺失和显式清空，分页与来源分别存储', async () => {
  const h = await open();
  const value = {
    id: 9007199254740993n,
    data: Buffer.from([1, 2]),
    empty: undefined,
    fields: new Map([[1, 'A']]),
    null: null,
  };
  expect(decodeContactValue(encodeContactValue(value))).toEqual(value);
  const key = { entity: 'group:12345', category: 'members', source: 'online' as const };
  const id = await h.observe({ ...key, value });
  expect((await h.latest(key))?.value).toEqual(value);
  await h.observe({ ...key, value: [], scope: 'page-1', completeness: 'page' });
  await h.observe({ ...key, value: [], completeness: 'complete' });
  expect((await h.list(key.entity)).rows).toHaveLength(3);
  await expect(h.version('group:other', id)).rejects.toThrow('不属于');
});

it('名单的小变化复用条目，压缩占用小于重复全量 JSON，并能完整回读', async () => {
  const h = await open();
  const members = Array.from({ length: 600 }, (_, n) => ({
    uid: `u_member_${n}`,
    uin: String(10000 + n),
    nick: `合成成员${n}`,
    card: '合成名片'.repeat(12),
    level: 10,
  }));
  let fullBytes = 0;
  for (let n = 0; n < 15; n++) {
    const snapshot = members.map((member, index) =>
      index === 0 ? { ...member, level: n } : member,
    );
    fullBytes += Buffer.byteLength(JSON.stringify(snapshot));
    const id = await h.observe({
      entity: 'group:12345',
      category: 'members',
      source: 'online',
      completeness: 'complete',
      value: snapshot,
    });
    expect(decodeContactValue((await h.version('group:12345', id)).value)).toEqual(snapshot);
  }
  const status = await h.status();
  expect(status.contents).toBe(600 + 14 + 15);
  await h.flush();
  const settled = await h.status();
  expect(settled.bytes).toBeLessThan(fullBytes / 2);
  await h.dispose();
  const bytes = (await stat(join(h.root, 'history.sqlite'))).size;
  expect(bytes).toBeLessThan(fullBytes / 2);
  console.info(
    'contact-history-space',
    JSON.stringify({
      repeatedJsonBytes: fullBytes,
      peakSampleBytesIncludingWal: status.bytes,
      settledBytesIncludingWal: settled.bytes,
      databaseBytes: bytes,
      allocatedBytes: (await stat(join(h.root, 'history.sqlite'))).blocks * 512,
    }),
  );
});

it('迁移保留时间和字段，校验后删除旧文件，异常原件保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-migrate-'));
  roots.push(root);
  await mkdir(join(root, 'group-members'));
  await mkdir(join(root, 'group-profiles'));
  const rows = {
    'friend:12345': {
      level: { value: 10, state: 'failed', updatedAt: 123, attemptedAt: 456, error: '旧失败' },
    },
  };
  await writeFile(join(root, 'metrics.json'), JSON.stringify({ version: 1, rows }));
  await writeFile(
    join(root, 'group-members', '12345.json'),
    JSON.stringify({ version: 1, updatedAt: 100, members: [] }),
  );
  await writeFile(join(root, 'group-profiles', '12345.json'), '{broken');
  await writeFile(
    join(root, 'group-members', '23456.json'),
    JSON.stringify({ version: 1, updatedAt: 100, members: [null] }),
  );
  const h = new ContactHistoryService(root);
  opened.push(h);
  await h.migration;
  expect(await h.projections()).toEqual(rows);
  expect((await h.list('friend:12345')).rows[0].first_at).toBe(123);
  expect(
    (await h.latest({ entity: 'group:12345', category: 'members', source: 'legacy' }))?.value,
  ).toEqual([]);
  await expect(readFile(join(root, 'metrics.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, 'group-profiles', '12345.json'), 'utf8')).toBe('{broken');
  expect(h.migrationErrors).toHaveLength(2);
  expect(
    JSON.parse(await readFile(join(root, 'group-members', '23456.json'), 'utf8')).members,
  ).toEqual([null]);
  await h.flush();
});

it('共享服务完整保存返回字段，合并身份，离线回退不生成新版本', async () => {
  const h = await open();
  let offline = false;
  const profile = {
    async getProfile() {
      if (offline) throw new Error('offline');
      return { uid: 'u_test', uin: 12345n, nick: 'A', unseen: { value: 42 } };
    },
  };
  const services = { profile };
  const stop = installContactHistoryCapture(services, h, '99999', () => true);
  expect(await profile.getProfile()).toMatchObject({ nick: 'A' });
  // 真实接口需要身份参数，下面使用有参签名的合成入口。
  stop();
  const target = {
    profile: {
      async getProfile(_uid: string) {
        return profile.getProfile();
      },
    },
  };
  const undo = installContactHistoryCapture(target, h, '99999', () => true);
  const first = await target.profile.getProfile('u_test');
  expect((await h.list('friend:12345')).rows).toHaveLength(1);
  offline = true;
  expect(await target.profile.getProfile('u_test')).toEqual(first);
  expect((await h.list('friend:u_test')).rows).toHaveLength(1);
  undo();
});

it('关闭重开保留内容，账号目录彼此隔离', async () => {
  const a = await open(),
    b = await open();
  await a.observe({
    entity: 'friend:12345',
    category: 'profile',
    source: 'local',
    value: { nick: 'A' },
  });
  expect((await b.list('friend:12345')).rows).toHaveLength(0);
  await a.dispose();
  const reopened = new ContactHistoryService(a.root);
  opened.push(reopened);
  expect((await reopened.list('friend:12345')).rows).toHaveLength(1);
});

it('迁移重入保留较新的当前投影，已经迁入的原件重复出现不会新增历史', async () => {
  const h = await open();
  const current = {
    'friend:12345': {
      level: { value: 99, state: 'ready' as const, updatedAt: 300, attemptedAt: 300 },
    },
  };
  await h.saveProjections(current);
  await h.observe({
    entity: 'friend:12345',
    category: 'metric.level',
    source: 'local',
    value: 99,
    at: 300,
  });
  await h.dispose();
  const old = JSON.stringify({
    version: 1,
    rows: {
      'friend:12345': { level: { value: 1, state: 'ready', updatedAt: 100, attemptedAt: 100 } },
    },
  });
  await writeFile(join(h.root, 'metrics.json'), old);
  const next = new ContactHistoryService(h.root);
  opened.push(next);
  expect(await next.projections()).toEqual(current);
  expect((await next.list('friend:12345')).rows.map((row) => row.first_at)).toEqual([300, 100]);
  await next.dispose();
  await writeFile(join(h.root, 'metrics.json'), old);
  const again = new ContactHistoryService(h.root);
  opened.push(again);
  expect((await again.list('friend:12345')).rows).toHaveLength(2);
  await expect(readFile(join(h.root, 'metrics.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('worker 异常退出后重开能从 WAL 读取已提交观察', async () => {
  const h = await open();
  await h.observe({
    entity: 'friend:u_test',
    category: 'profile',
    source: 'local',
    value: { nick: '崩溃前已提交' },
  });
  await (Reflect.get(h, 'worker') as Worker).terminate();
  await expect(h.dispose()).rejects.toThrow('退出');
  const next = new ContactHistoryService(h.root);
  opened.push(next);
  expect(
    (await next.latest({ entity: 'friend:u_test', category: 'profile', source: 'local' }))?.value,
  ).toEqual({ nick: '崩溃前已提交' });
});

it('接入清单的每个只读入口都保存未展示字段，未确认写操作不接入', async () => {
  const h = await open();
  const services: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const spec of CONTACT_HISTORY_CAPTURE)
    for (const method of spec.methods) {
      services[spec.service] ??= {};
      services[spec.service][method] = async () => ({
        unseen: { method, extra: ['完整业务字段'] },
      });
    }
  const stop = installContactHistoryCapture(services, h, '99999', () => true);
  for (const spec of CONTACT_HISTORY_CAPTURE)
    for (const method of spec.methods) {
      await services[spec.service][method](
        ...(spec.self || spec.kind === 'account' ? [] : ['12345']),
      );
      const entity = `${spec.kind}:${spec.self || spec.kind === 'account' ? '99999' : '12345'}`;
      const rows = await h.list(
        entity,
        method === 'fetchOnlineMembers'
          ? 'members'
          : method === 'getProfileByUin' || method === 'getSelfProfile'
            ? 'getProfile'
            : method,
      );
      expect(rows.rows.length, `${spec.service}.${method}`).toBeGreaterThan(0);
      expect((await h.version(entity, rows.rows[0].id)).value).toMatchObject({
        unseen: { method },
      });
    }
  expect(CONTACT_HISTORY_CAPTURE.flatMap((spec) => spec.methods)).not.toContain('friendRemark');
  stop();
});

it('群扩展资料同时保留原始入群资料，TTL 命中不新增观察', async () => {
  const h = await open();
  const reader = new GroupProfileReader({ nt: { sendOidbPacket: vi.fn() }, resolvePid: () => 1 });
  reader.history = h;
  vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue({
    groupId: 12345,
    name: '合成云端群名',
    maxMemberCount: 2000,
    memberCount: 123,
    categoryId: null,
    categoryName: null,
    option: null,
    question: null,
    questionState: 'unavailable',
    extensions: {
      grade: 1,
      activeMemberCount: 100,
      freezeState: 0,
      freezeReason: 0,
      portraitSequence: null,
      portrait: null,
    },
  });
  expect((await reader.read(12345, true)).source).toBe('online');
  const observed = (await h.latest({
    entity: 'group:12345',
    category: 'joinProfile',
    source: 'online',
  }))!;
  expect(observed.value).toMatchObject({ name: '合成云端群名', memberCount: 123 });
  await reader.read(12345, true);
  expect(
    (await h.latest({ entity: 'group:12345', category: 'joinProfile', source: 'online' }))?.last_at,
  ).toBe(observed.last_at);
  reader.dispose();
});

it('读取一个群的消息策略时保留同次回包已解析的其他群资料', async () => {
  const h = await open();
  const service = new GroupInfoService({} as AccountSession, {
    nt: { sendOidbPacket: vi.fn() },
    resolvePid: () => 1,
  });
  service.setContactHistory(h);
  vi.spyOn(GetGroupMessagePolicies, 'invoke').mockResolvedValue([
    { groupId: 12345, policy: null, rawPolicy: 4 },
    { groupId: 23456, policy: null, rawPolicy: 8 },
  ]);
  expect((await service.getMessagePolicy(12345)).rawPolicy).toBe(4);
  expect(
    (await h.latest({ entity: 'group:23456', category: 'messagePolicy', source: 'online' }))?.value,
  ).toMatchObject({ rawPolicy: 8 });
});

it('异步留存固定观察时的数据，迟到历史不会覆盖较新的当前资料，时间分页无遗漏', async () => {
  const h = await open();
  const key = { entity: 'friend:u_test', category: 'profile', source: 'local' as const };
  const value = { nick: '观察时内容', $type: 'bigint', value: '不是整数' };
  await h.capture([{ ...key, value, at: 300 }]);
  value.nick = '返回后已改变';
  expect((await h.latest(key))?.value).toMatchObject({
    nick: '观察时内容',
    $type: 'bigint',
    value: '不是整数',
  });
  await h.observe({ ...key, value: { nick: '较早内容' }, at: 100 });
  expect((await h.latest(key))?.value).toMatchObject({ nick: '观察时内容' });
  const first = await h.list(key.entity, '', undefined, 1);
  expect(first.rows[0].first_at).toBe(300);
  expect((await h.list(key.entity, '', first.nextBefore!, 1)).rows[0].first_at).toBe(100);
});

it('部分回包保留缺省字段和嵌套资料，显式 null 清空，原始观察仍可回看', async () => {
  const h = await open();
  const key = { entity: 'friend:u_test', category: 'profile', source: 'online' as const };
  await h.observe({
    ...key,
    value: { nick: 'A', details: { school: '合成大学', city: '城市' } },
    at: 100,
  });
  const id = await h.observe({ ...key, value: { details: { city: null } }, at: 300 });
  expect((await h.latest(key))?.value).toEqual({
    nick: 'A',
    details: { school: '合成大学', city: null },
  });
  expect((await h.version(key.entity, id)).observedValue).toEqual({ details: { city: null } });
  await h.observe({ ...key, value: { details: { extra: '迟到补充' } }, at: 200 });
  expect((await h.latest(key))?.value).toEqual({
    nick: 'A',
    details: { school: '合成大学', city: null, extra: '迟到补充' },
  });
});

it('空值指标投影可重开读取，大值引用与成功历史共用内容', async () => {
  const h = await open();
  const metrics = new ContactMetricsService(
    join(h.root, 'metrics.json'),
    () => true,
    { interval: 0, concurrency: 1 },
    h,
  );
  await metrics.project('friend:12345', { schools: null });
  await metrics.record('friend:12345', {
    commonGroups: Array.from({ length: 10 }, (_, n) => ({
      groupCode: String(10000 + n),
      name: `合成群${n}`,
    })),
  });
  await metrics.flush();
  const row = (await h.projections())['friend:12345'];
  expect(row.schools?.value).toBeUndefined();
  expect(row.commonGroups?.value).toHaveLength(10);
  await metrics.dispose();
  await h.dispose();
  const reopened = new ContactHistoryService(h.root);
  opened.push(reopened);
  expect((await reopened.projections())['friend:12345'].schools?.value).toBeUndefined();
  expect((await reopened.projections())['friend:12345'].commonGroups?.value).toHaveLength(10);
});

it('旧指标首读不等待后台全量历史迁移', async () => {
  const h = await open();
  const original = h.migration;
  let release!: () => void;
  const paused = new Promise<void>((done) => {
    release = done;
  });
  Reflect.set(h, 'migration', paused);
  await writeFile(
    join(h.root, 'metrics.json'),
    JSON.stringify({
      version: 1,
      rows: {
        'friend:12345': { level: { value: 10, state: 'ready', attemptedAt: 123, updatedAt: 123 } },
      },
    }),
  );
  const metrics = new ContactMetricsService(
    join(h.root, 'metrics.json'),
    () => true,
    { interval: 0, concurrency: 1 },
    h,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      metrics.snapshot(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('指标首读等待了后台迁移')), 500);
      }),
    ]);
    expect(snapshot.rows['friend:12345'].level?.value).toBe(10);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    Reflect.set(h, 'migration', original);
    await metrics.dispose();
  }
});

it('已经取得的观察在账号退出刷盘时全部保存，不等待每次查询单独写盘', async () => {
  const h = await open();
  const calls = Array.from({ length: 80 }, (_, n) =>
    h.capture([
      {
        entity: 'friend:u_test',
        category: 'profile',
        source: 'local',
        value: { nick: String(n) },
        at: n + 1,
      },
    ]),
  );
  await h.dispose();
  await Promise.all(calls);
  const reopened = new ContactHistoryService(h.root);
  opened.push(reopened);
  const a = await reopened.list('friend:u_test', '', undefined, 100);
  expect(a.rows).toHaveLength(80);
});

it('反复读取大名单不新增版本或内容，记录接入前后返回耗时', async () => {
  const h = await open();
  const members = Array.from({ length: 1000 }, (_, n) => ({
    uid: `u_member_${n}`,
    uin: 10000 + n,
    nickname: `合成成员${n}`,
    card: '合成名片',
    level: 10,
  }));
  const services = {
    groupInfo: {
      async fetchOnlineMembers(_group: number) {
        return [...members];
      },
    },
  };
  const baseline: number[] = [],
    captured: number[] = [];
  for (let n = 0; n < 20; n++) {
    const at = performance.now();
    await services.groupInfo.fetchOnlineMembers(12345);
    baseline.push(performance.now() - at);
  }
  const stop = installContactHistoryCapture(services, h, '99999', () => true);
  for (let n = 0; n < 20; n++) {
    const at = performance.now();
    await services.groupInfo.fetchOnlineMembers(12345);
    captured.push(performance.now() - at);
  }
  await h.flush();
  const status = await h.status();
  expect(status.versions).toBe(1);
  expect(status.contents).toBe(1001);
  const p95 = (values: number[]) => values.sort((a, b) => a - b)[18];
  console.info(
    'contact-history-read-return',
    JSON.stringify({
      fixtureMembers: members.length,
      baselineP95Ms: p95(baseline),
      capturedP95Ms: p95(captured),
      versions: status.versions,
      contents: status.contents,
    }),
  );
  stop();
}, 15000);

it('写锁导致保存失败时保留重试数据，解除后刷盘不会让旧观察覆盖新值', async () => {
  const h = await open();
  const lock = new DatabaseSync(join(h.root, 'history.sqlite'));
  lock.exec('BEGIN IMMEDIATE');
  const key = { entity: 'friend:u_test', category: 'profile', source: 'local' as const };
  try {
    await h.capture([{ ...key, value: { nick: '旧观察' }, at: 100 }]);
    expect((await h.list(key.entity)).rows).toHaveLength(0);
    expect((await h.status()).pendingRetries).toBe(1);
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }
  await h.capture([{ ...key, value: { nick: '新观察' }, at: 200 }]);
  await h.flush();
  expect((await h.latest(key))?.value).toEqual({ nick: '新观察' });
  expect((await h.list(key.entity)).rows.map((row) => row.first_at)).toEqual([200, 100]);
});

it('超过两万条旧指标完整迁入，当前投影移除不删除历史，重开不复活旧指标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-many-'));
  roots.push(root);
  const rows = Object.fromEntries(
    Array.from({ length: 20003 }, (_, n) => [
      `friend:${10000 + n}`,
      { level: { value: 1, attemptedAt: 123, updatedAt: 123, state: 'ready' } },
    ]),
  );
  await writeFile(join(root, 'metrics.json'), JSON.stringify({ version: 1, rows }));
  const h = new ContactHistoryService(root);
  opened.push(h);
  expect(Object.keys(await h.projections())).toHaveLength(20003);
  const metrics = new ContactMetricsService(
    join(root, 'metrics.json'),
    () => true,
    { interval: 0, concurrency: 1 },
    h,
  );
  await metrics.removeMetrics(['friend:10000'], ['level']);
  await metrics.flush();
  expect((await h.projections())['friend:10000']).toBeUndefined();
  expect((await h.list('friend:10000')).rows).toHaveLength(1);
  await metrics.dispose();
  await h.dispose();
  const reopened = new ContactHistoryService(root);
  opened.push(reopened);
  expect((await reopened.projections())['friend:10000']).toBeUndefined();
  expect(Object.keys(await reopened.projections())).toHaveLength(20002);
}, 30000);
