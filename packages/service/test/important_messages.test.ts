import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportantMessageStore } from '../src/account/important_messages';
import type { UnreadInfoSnapshot } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { UnreadInfoService } from '../src/account/unread_info';
import * as atomic from '../src/common/atomic_write';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const snapshot = (uid = '70001'): UnreadInfoSnapshot => ({
  chatType: 2,
  uid,
  peer: `2_${uid}`,
  latestSeq: '110',
  msgSeq: 90,
  highlights: [
    { kind: 'atMe', rawKind: 1000, msgSeq: 101, senderUid: 'u_peer', sendTime: 10, text: '' },
    { kind: 'atMe', rawKind: 1000, msgSeq: 102, senderUid: 'u_peer', sendTime: 11, text: '第二条' },
    { kind: 'replyMe', rawKind: 1002, msgSeq: 102, senderUid: 'u_peer', sendTime: 11, text: '' },
  ],
});

it('同类多条与同消息多原因独立保留，重复观察去重，已读不会移除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-important-'));
  dirs.push(dir);
  const path = join(dir, 'important.json');
  const store = new ImportantMessageStore(path);
  store.observe(snapshot());
  store.observe(snapshot());
  store.observe({ ...snapshot(), highlights: undefined, msgSeq: 110 });
  await store.flush();
  const restored = new ImportantMessageStore(path);
  const page = restored.list({ chatType: 2, uid: '70001', readSeq: '110', limit: 50 });
  expect(page.items.map((row) => row.msgSeq)).toEqual(['102', '101']);
  expect(page.items[0]?.reasons.map((reason) => reason.kind)).toEqual(['atMe', 'replyMe']);
  expect(page.items.every((row) => !row.unread)).toBe(true);
  expect(
    restored
      .list({ chatType: 2, uid: '70001', unreadOnly: true, readSeq: '101', limit: 50 })
      .items.map((row) => row.msgSeq),
  ).toEqual(['102']);
});

it('按会话、类型与序号游标分页，未知类别保留，损坏快照不覆盖记录', () => {
  const store = new ImportantMessageStore();
  store.observe(snapshot());
  store.observe(snapshot('70002'));
  store.observe({ ...snapshot('u_private'), chatType: 1, peer: '1_u_private' });
  store.observe({ ...snapshot(), readError: true, highlights: [] });
  const input = { chatType: 2, uid: '70001', limit: 1 };
  const first = store.list(input);
  expect(first.nextBefore).toBe('102');
  expect(store.list({ ...input, before: first.nextBefore! }).items[0]?.msgSeq).toBe('101');
  expect(store.list({ ...input, kind: 'replyMe' }).items).toHaveLength(1);
  expect(store.list({ ...input, uid: 'missing' }).items).toEqual([]);
  expect(store.list({ ...input, chatType: 1, uid: 'u_private' }).items).toEqual([]);
  expect(store.list({ ...input, unreadOnly: true }).items).toEqual([]);
  store.observe({
    ...snapshot(),
    highlights: [{ ...snapshot().highlights![0]!, kind: 'unknown', rawKind: 9999 }],
  });
  expect(store.list({ ...input, kind: 'unknown' }).items[0]?.reasons).toContainEqual(
    expect.objectContaining({ rawKind: 9999 }),
  );
});

it('损坏的持久文件保留原件，不把读失败当作空索引覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-important-'));
  dirs.push(dir);
  const path = join(dir, 'important.json');
  writeFileSync(path, '{broken');
  const store = new ImportantMessageStore(path);
  store.observe(snapshot());
  expect(() => store.list({ chatType: 2, uid: '70001', limit: 50 })).toThrow();
  await expect(store.flush()).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe('{broken');
});

it('多选分类按并集过滤后分页，空选择不退化为全部，多个命中不重复条目', () => {
  const store = new ImportantMessageStore();
  store.observe(snapshot());
  store.observe({
    ...snapshot(),
    highlights: [{ ...snapshot().highlights![0]!, msgSeq: 103, kind: 'unknown', rawKind: 9999 }],
  });
  const input = { chatType: 2, uid: '70001', limit: 1, kinds: ['atMe', 'replyMe'] as const };
  const page = store.list(input);
  expect(page.items.map((row) => row.msgSeq)).toEqual(['102']);
  expect(page.nextBefore).toBe('102');
  expect(store.list({ ...input, before: page.nextBefore! }).items.map((row) => row.msgSeq)).toEqual(
    ['101'],
  );
  expect(store.list({ ...input, kinds: [] }).items).toEqual([]);
});

it('清除 QQ 提醒前持久保存；重启和更换同账号数据源后各自恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-important-'));
  dirs.push(dir);
  let current = snapshot();
  const markRead = vi.fn(async () => {
    expect(
      new ImportantMessageStore(`${join(dir, 'a', 'unread.json')}.important.json`).list({
        chatType: 2,
        uid: '70001',
        limit: 50,
      }).items,
    ).toHaveLength(2);
    current = { ...current, msgSeq: 110, highlights: undefined };
    return true;
  });
  const session = {
    selfUid: 'u_self',
    msgDbPath: '/synthetic/important.db',
    unreadInfo: { getAllUnreadInfos: async () => [current], markRead },
  } as unknown as AccountSession;
  const create = (source: string) =>
    new UnreadInfoService(session, undefined, { statePath: join(dir, source, 'unread.json') });
  const service = create('a');
  try {
    await service.markRead(2, '70001', '110');
  } finally {
    await service.dispose();
  }
  expect(markRead).toHaveBeenCalledOnce();
  const restored = create('a'),
    other = create('b');
  try {
    expect(
      (await restored.listImportantMessages({ chatType: 2, uid: '70001', limit: 50 })).items,
    ).toHaveLength(2);
    expect(
      (await other.listImportantMessages({ chatType: 2, uid: '70001', limit: 50 })).items,
    ).toHaveLength(0);
  } finally {
    await restored.dispose();
    await other.dispose();
  }
});

it('持久写入失败时不清除 QQ 原提醒，恢复后可以重试保存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-important-'));
  dirs.push(dir);
  const write = vi
    .spyOn(atomic, 'writeFileAtomic')
    .mockRejectedValue(new Error('fixture disk full'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const markRead = vi.fn(async () => true);
  const session = {
    selfUid: 'u_self',
    msgDbPath: '/synthetic/important-failure.db',
    unreadInfo: { getAllUnreadInfos: async () => [snapshot()], markRead },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(session, undefined, {
    statePath: join(dir, 'unread.json'),
  });
  try {
    await expect(service.markRead(2, '70001', '110')).rejects.toThrow('fixture disk full');
    expect(markRead).not.toHaveBeenCalled();
    write.mockRestore();
    await service.markRead(2, '70001', '110');
    expect(markRead).toHaveBeenCalledOnce();
  } finally {
    write.mockRestore();
    log.mockRestore();
    await service.dispose();
  }
});
