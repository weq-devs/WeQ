import type { AccountSession } from '@weq/account';
import type { UnreadInfoSnapshot } from '@weq/db';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UnreadInfoService } from '../src/account/unread_info';

const services: UnreadInfoService[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  vi.useRealTimers();
});

const target = { chatType: 2, uid: '70001' };
const snapshot = (extra: Partial<UnreadInfoSnapshot> = {}): UnreadInfoSnapshot => ({
  ...target,
  peer: '2_70001',
  latestSeq: '110',
  msgSeq: 100,
  ...extra,
});
function fixture(statePath?: string) {
  let rows = [snapshot(), snapshot({ uid: '70002', peer: '2_70002', latestSeq: '900' })];
  const all = vi.fn(async () => rows.map((row) => ({ ...row })));
  const markRead = vi.fn(async () => true);
  const sendPacket = vi.fn(async () => Buffer.alloc(0));
  const session = {
    selfUid: 'u_self',
    msgDbPath: '/synthetic/read-watermark.db',
    unreadInfo: { getAllUnreadInfos: all, markRead },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(
    session,
    {
      nt: { sendPacket, hasSsoSession: async () => true },
      enabled: () => true,
      resolvePid: () => 9,
    },
    statePath ? { statePath } : undefined,
  );
  services.push(service);
  return {
    service,
    all,
    markRead,
    sendPacket,
    query: () => service.getUnreadInfos([target]),
    update: (next: UnreadInfoSnapshot[]) => {
      rows = next;
    },
  };
}

it.each(['local', 'database', 'report'] as const)(
  '%s 入口拒绝其他群的更大水位，不清未读、不写库、不重试',
  async (entry) => {
    vi.useFakeTimers();
    const f = fixture();
    await f.query();
    if (entry === 'local') expect(await f.service.markLocalRead(2, target.uid, '900')).toBe(false);
    else if (entry === 'database')
      expect(await f.service.markRead(2, target.uid, '900')).toBe(false);
    else
      expect(await f.service.markReadAndReport(2, target.uid, '900')).toMatchObject({
        changed: false,
        report: { state: 'skipped' },
      });
    expect((await f.query())[0]).toMatchObject({ readSeq: '100', unreadCount: 10 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.markRead).not.toHaveBeenCalled();
    expect(f.sendPacket).not.toHaveBeenCalled();
  },
);

it.each(['-1', '1e2', 'invalid', '184467440737095516160'])(
  '无效水位 %s 不进入本地或数据库写入',
  async (sequence) => {
    const f = fixture();
    await f.query();
    expect(await f.service.markRead(2, target.uid, sequence)).toBe(false);
    expect(f.markRead).not.toHaveBeenCalled();
    expect((await f.query())[0]?.unreadCount).toBe(10);
  },
);

it('目标小表缺行时不借用其他会话水位，也不替用户确认最新消息', async () => {
  const f = fixture();
  expect(await f.service.markRead(2, 'missing', '100')).toBe(false);
  expect(f.markRead).not.toHaveBeenCalled();
  expect(
    (await f.service.getUnreadInfos([{ chatType: 2, uid: 'missing' }]))[0]?.readSeq,
  ).toBeUndefined();
});

it('小表缓存暂时落后时只刷新小表核验，保留请求捕获位置，不顺带读掉新消息', async () => {
  const f = fixture();
  await f.query();
  f.update([snapshot({ latestSeq: '115' })]);
  expect(await f.service.markReadAndReport(2, target.uid, '112')).toMatchObject({
    changed: true,
    report: { state: 'pending', sequence: '112' },
  });
  expect(f.all).toHaveBeenCalledTimes(2);
  expect(f.markRead).toHaveBeenCalledWith(2, target.uid, '112');
  expect((await f.query())[0]).toMatchObject({ readSeq: '112', unreadCount: 3 });
});

it('越界核验读取失败时不写入、不猜测成目标会话的最新位置', async () => {
  const f = fixture();
  await f.query();
  f.all.mockRejectedValueOnce(new Error('busy'));
  expect(await f.service.markRead(2, target.uid, '900')).toBe(false);
  expect(f.markRead).not.toHaveBeenCalled();
  expect((await f.query())[0]).toMatchObject({ readSeq: '100', unreadCount: 10 });
});

it.each([{ uid: 'other' }, { chatType: 1 }, { latestSeq: null }])(
  '小表行身份或水位不匹配时不落地：%j',
  async (extra) => {
    const f = fixture();
    await f.query();
    f.update([snapshot(extra)]);
    f.service.invalidate();
    expect(await f.service.markRead(2, target.uid, '105')).toBe(false);
    expect(f.markRead).not.toHaveBeenCalled();
  },
);

it('正常相同水位仍可补写 QQ，旧水位不降低本地阅读位置', async () => {
  const f = fixture();
  await f.query();
  expect(await f.service.markLocalRead(2, target.uid, '108')).toBe(true);
  expect(await f.service.markRead(2, target.uid, '108')).toBe(true);
  expect(await f.service.markLocalRead(2, target.uid, '105')).toBe(false);
  expect((await f.query())[0]).toMatchObject({ readSeq: '108', unreadCount: 2 });
});

it('启动和拒绝新越界请求都不纠正或重写既有异常记录', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weq-read-watermark-'));
  directories.push(directory);
  const path = join(directory, 'unread.json');
  const original = JSON.stringify({
    '2_70001': { sourceVersion: 2, readSeq: '900', operation: 45 },
  });
  writeFileSync(path, original);
  const f = fixture(path);
  expect((await f.query())[0]?.readSeq).toBe('900');
  expect(await f.service.markRead(2, target.uid, '950')).toBe(false);
  await f.service.dispose();
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(f.markRead).not.toHaveBeenCalled();
});
