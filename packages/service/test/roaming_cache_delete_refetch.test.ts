import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub } from '@weq/testkit';
import { encode, GetC2cHistory, GetGroupHistory } from '@weq/protocol';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { MsgService } from '../src/account/msg';

vi.mock('../src/common/roaming_request_queue', () => ({
  withRoamingRequest: (operation: () => Promise<unknown>) => operation(),
}));
const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['c2c', 'group'] as const)(
  '%s 隐藏删除产生可重拉缺口，失败保留恢复记录，成功仅恢复实际收到的消息',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-cache-delete-refetch-'));
    roots.push(root);
    const store = new DeletedMsgStore(join(root, 'deleted.json'));
    const msgs = new MsgService({} as never, store);
    const conv = kind === 'group' ? '12345' : 'u_peer';
    const payload = {
      responseHead: {
        fromUin: 10001,
        fromUid: 'u_peer',
        toUin: 10000,
        toUid: 'u_self',
        ...(kind === 'group' ? { grp: { groupUin: Number(conv) } } : {}),
      },
      contentHead: {
        sequence: kind === 'group' ? 2 : 50002,
        ntMsgSeq: kind === 'c2c' ? 2 : undefined,
        newId: 9007199254740993002n,
        msgId: 12,
        timestamp: 1700000000,
      },
      body: { richText: { elems: [{ text: { str: '合成漫游消息' } }] } },
    };
    let failing = true;
    const sendPacket = vi.fn(async () => {
      if (failing) throw Error('合成网络故障');
      return Buffer.from(
        encode(
          kind === 'group' ? GetGroupHistory.respSchema : GetC2cHistory.respSchema,
          kind === 'group'
            ? {
                body: {
                  groupUin: Number(conv),
                  startSequence: 2,
                  endSequence: 2,
                  messages: [payload],
                },
              }
            : { friendUid: conv, messages: [payload] },
        ),
      );
    });
    const history = new GapHistoryService(
      { ...createSqliteStub(), sendPacket },
      { context: { uin: '10000' } } as never,
      () => 42,
      join(root, 'cache.db'),
      store,
    );
    const row: GapFetchedMessage = {
      kind,
      conv,
      msgId: '9007199254740993002',
      msgSeq: '2',
      senderUid: 'u_peer',
      senderUin: '10001',
      sendTime: '1700000000',
      elements: [],
      ntSeqVerified: true,
      sourceFormat: 'native',
      nativeRaw: { elements: [] },
    };
    await history.retainForBatch([row]);
    expect(msgs.deleteCachedSentMessage(row, true)).toBe(true);
    expect(await history.cached(kind, conv, 2, 2)).toEqual([]);
    expect(await history.fetch(kind, conv, 2, 2)).toMatchObject({
      ok: false,
      networkRequested: true,
    });
    expect(msgs.getHiddenDeletedMsgIds(kind, conv)).toEqual([
      'roaming:native:2:9007199254740993002',
    ]);
    failing = false;
    const result = await history.fetch(kind, conv, 2, 2);
    expect(result).toMatchObject({ ok: true, networkRequested: true, fetched: 1 });
    if (result.ok) expect(result.messages.map((message) => message.msgId)).toEqual([row.msgId]);
    expect(sendPacket).toHaveBeenCalledTimes(2);
    expect(msgs.getDeletedMsgIds(kind, conv)).toEqual([]);
    expect(new DeletedMsgStore(join(root, 'deleted.json')).listHiddenIds(kind, conv)).toEqual([]);
    expect(await history.cached(kind, conv, 2, 2)).toHaveLength(1);
  },
);
