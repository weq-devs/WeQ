import { expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { decodeElement, ElementType, type MsgCacheRecord } from '@weq/codec';
import type { GroupMsg } from '@weq/db';
import { MsgService } from '../src/account/msg';
import type { AntiRecallService } from '../src/account/anti_recall';
import { UidMap } from '@weq/db';

it('新私聊先补查分区再读首屏，未索引目标只跳过预取，不影响用户正常读取', async () => {
  const listLatest = vi.fn(async () => []);
  const map = UidMap.from([], async (uid) =>
    uid === 'u_new' ? { uid, sortNo: 17n, uin: 20002n } : undefined,
  );
  const service = new MsgService({
    uidMap: map,
    c2cMsgs: { listLatest },
  } as unknown as AccountSession);
  await service.getC2cLatest('u_new', 50, { skipUnindexed: true });
  expect(listLatest).toHaveBeenCalledWith({ sortNo: 17n }, 50);
  listLatest.mockClear();
  await expect(service.getC2cLatest('u_missing', 50, { skipUnindexed: true })).rejects.toThrow(
    '跳过',
  );
  expect(listLatest).not.toHaveBeenCalled();
  await service.getC2cLatest('u_missing', 50);
  expect(listLatest).toHaveBeenCalledWith({ uid: 'u_missing' }, 50);
});

it('正文可跳过慢引用缓存，但撤回与删除状态仍在首屏；默认读取继续等待完整引用', async () => {
  let release!: (value: Map<bigint, MsgCacheRecord[]>) => void;
  const cache = vi.fn(
    () =>
      new Promise<Map<bigint, MsgCacheRecord[]>>((done) => {
        release = done;
      }),
  );
  const row = {
    msgId: 1n,
    msgType: 1n,
    subType: 1n,
    elements: [decodeElement({ elementType: ElementType.REPLY } as never)],
  } as unknown as GroupMsg;
  const session = {
    groupMsgs: { listLatest: async () => [row] },
    forwardMsgs: { listForMessages: cache },
  } as unknown as AccountSession;
  const recall = vi.fn(
    async () => new Map([['1', { revokeUid: 'u_peer', senderUid: 'u_peer', recallTs: 1 }]]),
  );
  const service = new MsgService(session, undefined, {
    getRecallMap: recall,
  } as unknown as AntiRecallService);
  const page = await service.getGroupLatest('777', 25, { deferReplyMedia: true });
  expect(cache).not.toHaveBeenCalled();
  expect(page[0]).toMatchObject({ deletedKind: 'qq', recall: { sameSender: true } });
  expect(recall).toHaveBeenCalledWith('group', '777', [1n]);
  let completed = false;
  const full = service.getGroupLatest('777', 25).then((value) => {
    completed = true;
    return value;
  });
  await vi.waitFor(() => expect(cache).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  release(new Map());
  expect(await full).toHaveLength(1);
});

it('引用后补复用原解析，只返回有媒体的条目，坏条目不影响其余引用', async () => {
  const pic = { elementType: ElementType.PIC, elementId: 8n };
  const session = {
    forwardMsgs: {
      listForMessages: async () =>
        new Map([
          [1n, [{ elements: [pic] }]],
          [2n, [{ elements: [{ elementType: ElementType.TEXT, textContent: '纯文本' }] }]],
          [3n, []],
          [4n, [{ elements: [null, pic] }]],
        ]),
    },
  } as unknown as AccountSession;
  const result = await new MsgService(session).getReplyMedia('group', [1n, 2n, 3n, 4n]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    msgId: '1',
    elements: [{ type: 'pic', data: { elementId: 8n } }],
  });
});
