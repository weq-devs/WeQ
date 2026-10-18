import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';
import { createNtMsgDbHook } from '../src/account/nt_msg_hook';
import type { DbChange } from '../src/account/db_watch';

const DB_CHANGE = {
  dbPath: 'nt_msg.db',
  prevTotal: 0,
  total: 1,
  delta: 1,
  files: [],
  at: 1,
} satisfies DbChange;

function message(seq: number): GroupMsg {
  return {
    msgSeq: BigInt(seq),
    msgId: BigInt(seq),
    sendTime: BigInt(seq),
    targetGroupCode: '123456',
    senderUid: 'u_sender',
    senderUin: 10001n,
    elements: [],
  } as unknown as GroupMsg;
}

function fixture(kind: 'group' | 'c2c', total: number) {
  const rows = Array.from({ length: total }, (_, index) => message(index + 1));
  let watermark = 0n;
  let failAfterFirstPage = false;
  const listAfter = vi.fn(async (_target: unknown, after: bigint, limit: number) => {
    if (failAfterFirstPage && after >= 500n) {
      failAfterFirstPage = false;
      throw new Error('database temporarily locked');
    }
    return rows.filter((row) => row.msgSeq > after).slice(0, limit);
  });
  const listBySeqsInPartition = vi.fn(async (_target: unknown, seqs: bigint[]) =>
    rows.filter((row) => seqs.includes(row.msgSeq)),
  );
  const session = {
    msgDbPath: 'nt_msg.db',
    recentContacts: {
      listSeqWatermarks: async () => [
        {
          targetUid: kind === 'group' ? '123456' : 'u_peer',
          chatType: kind === 'group' ? 2 : 1,
          msgSeq: watermark,
          sendTime: BigInt(total),
        },
      ],
    },
    groupMsgs: { listAfter, listBySeqsInPartition },
    c2cMsgs: { listAfter, listBySeqsInPartition },
    uidMap: { sortNoByUid: () => 17n },
  } as unknown as AccountSession;
  const onNewMessages = vi.fn();
  const hook = createNtMsgDbHook(session, {
    onDbChanged: () => {},
    onNewMessages,
  });
  return {
    hook,
    listAfter,
    listBySeqsInPartition,
    onNewMessages,
    setWatermark: (seq: bigint) => {
      watermark = seq;
    },
    failSecondPageOnce: () => {
      failAfterFirstPage = true;
    },
    rows,
  };
}

describe('nt_msg watcher batch catch-up', () => {
  it.each(['group', 'c2c'] as const)(
    'drains >500 %s messages without losing a page',
    async (kind) => {
      const f = fixture(kind, 1201);
      await f.hook.onDbFileChangeHook(DB_CHANGE); // Startup establishes the baseline.
      f.setWatermark(1201n);
      await f.hook.onDbFileChangeHook(DB_CHANGE);

      expect(f.listAfter.mock.calls.map((args) => args[1])).toEqual([0n, 500n, 1000n]);
      expect(f.onNewMessages).toHaveBeenCalledTimes(1);
      const event = f.onNewMessages.mock.calls[0]![0];
      const emitted = kind === 'group' ? event.group : event.c2c;
      expect(emitted.map((m: C2cMsg | GroupMsg) => m.msgSeq)).toEqual(f.rows.map((m) => m.msgSeq));

      await f.hook.onDbFileChangeHook(DB_CHANGE);
      expect(f.onNewMessages).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['group', 'c2c'] as const)(
    'keeps messages sharing the %s batch-boundary seq',
    async (kind) => {
      const f = fixture(kind, 1001);
      // The second of two messages with seq=500 falls immediately after page one.
      f.rows[500]!.msgSeq = 500n;
      await f.hook.onDbFileChangeHook(DB_CHANGE);
      f.setWatermark(1001n);
      await f.hook.onDbFileChangeHook(DB_CHANGE);

      expect(f.onNewMessages).toHaveBeenCalledTimes(1);
      const change = f.onNewMessages.mock.calls[0]![0];
      const emitted = kind === 'group' ? change.group : change.c2c;
      expect(emitted.map((m: C2cMsg | GroupMsg) => m.msgId)).toEqual(f.rows.map((m) => m.msgId));
    },
  );

  it('retries the complete delta after a later page fails', async () => {
    const f = fixture('group', 1100);
    await f.hook.onDbFileChangeHook(DB_CHANGE);
    f.setWatermark(1100n);
    f.failSecondPageOnce();
    await f.hook.onDbFileChangeHook(DB_CHANGE);

    expect(f.onNewMessages).not.toHaveBeenCalled();
    await f.hook.onDbFileChangeHook(DB_CHANGE);
    expect(f.onNewMessages).toHaveBeenCalledTimes(1);
    expect(f.onNewMessages.mock.calls[0]![0].group).toHaveLength(1100);
  });
});
