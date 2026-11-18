import type { AccountSession } from '@weq/account';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalUnreadStore } from '../src/account/local_unread';
import { UnreadInfoService } from '../src/account/unread_info';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('清除落盘的本地水位和手动标记，重开后直接采用 QQ 小表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-unread-reset-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'unread.json');
  const row = { chatType: 1, uid: 'u_peer', peer: '1_u_peer', msgSeq: 90, latestSeq: '100' };
  const store = new LocalUnreadStore(path);
  store.markRead(1, 'u_peer', '100');
  store.setManualRead({ ...row, uid: 'u_other', peer: '1_u_other' }, true);
  await store.flush();
  expect(store.resolve(row).unreadCount).toBe(0);
  store.clear();
  await store.flush();
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  expect(new LocalUnreadStore(path).resolve(row).unreadCount).toBe(10);
});

it('清除立即发布重新投影的未读数，不写 QQ 数据库或上报服务器，旧撤销失效', async () => {
  const row = { chatType: 1, uid: 'u_peer', peer: '1_u_peer', msgSeq: 90, latestSeq: '100' };
  const database = {
    getAllUnreadInfos: vi.fn(async () => [{ ...row }]),
    setReadState: vi.fn(),
    markRead: vi.fn(),
  };
  const sendPacket = vi.fn();
  const service = new UnreadInfoService(
    { selfUid: 'u_self', unreadInfo: database } as unknown as AccountSession,
    {
      nt: { sendPacket, hasSsoSession: () => false },
      enabled: () => false,
      resolvePid: () => null,
    },
    { statePath: '', readOnly: true },
  );
  cleanups.push(() => service.dispose());
  const changed = vi.fn();
  service.onCountsChanged(changed);
  const read = await service.setReadState([row], false);
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(0);
  changed.mockClear();
  await service.clearLocalReadRecords();
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(10);
  expect(changed).toHaveBeenCalledWith([{ chatType: 1, uid: 'u_peer' }]);
  await expect(service.undoReadState(read.undoToken)).rejects.toThrow('失效');
  expect(database.markRead).not.toHaveBeenCalled();
  expect(database.setReadState).not.toHaveBeenCalled();
  expect(sendPacket).not.toHaveBeenCalled();
});

it('清除前开始、清除后才读完的小表请求不会重新写回旧阅读位置', async () => {
  const row = { chatType: 1, uid: 'u_peer', peer: '1_u_peer', msgSeq: 90, latestSeq: '100' };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database = {
    getAllUnreadInfos: vi.fn(async () => {
      await waiting;
      return [{ ...row }];
    }),
    markRead: vi.fn(),
  };
  const service = new UnreadInfoService(
    { unreadInfo: database } as unknown as AccountSession,
    undefined,
    { statePath: '', readOnly: true },
  );
  cleanups.push(() => service.dispose());
  const reading = service.markLocalRead(1, 'u_peer', '100');
  await service.clearLocalReadRecords();
  release();
  expect(await reading).toBe(false);
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(10);
  expect(database.markRead).not.toHaveBeenCalled();
});
