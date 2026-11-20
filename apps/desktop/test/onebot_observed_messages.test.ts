// @vitest-environment node
import type { AccountSession } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';
import type { DbWatchTask } from '@weq/service';
import { expect, it, vi } from 'vitest';
import {
  projectObservedMessage,
  watchObservedMessages,
} from '../src/main/bot_runtime/observed_messages';

const now = Math.floor(Date.now() / 1000);
const row: GroupMsg = {
  msgId: 1234567890123456789n,
  msgSeq: 2n,
  targetGroupCode: '55001',
  senderUid: 'u_sender',
  senderUin: 0n,
  sendTime: BigInt(now),
  elements: [
    { kind: 'text', textContent: '正文' },
    { kind: 'at', textContent: '@群友', atTargetUid: 'u_mention' },
    { kind: 'at', textContent: '@未知' },
    { kind: 'face', faceId: 1 },
  ],
};
const uins: Record<string, bigint | undefined> = {
  u_sender: 20003n,
  u_mention: 20004n,
  u_peer: 20005n,
};
const uidMap = (uid: string) => uins[uid];
const nickname = async () => '群友';

it('保留群消息原始 ID、@ 对象与正文，过期或已撤回的行不再投递', async () => {
  expect(await projectObservedMessage(row, uidMap, nickname, now)).toMatchObject({
    messageId: '1234567890123456789',
    scene: 'group',
    peer: { id: '55001' },
    sender: { id: '20003', name: '群友' },
    elements: [
      { kind: 'text', textContent: '正文' },
      { kind: 'at', atTargetUin: '20004' },
      { kind: 'text', textContent: '@未知' },
      { kind: 'face', faceId: 1 },
    ],
  });
  expect(await projectObservedMessage(row, uidMap, nickname, now + 121)).toBeUndefined();
  expect(
    await projectObservedMessage({ ...row, msgType: 1n, subType: 1n }, uidMap, nickname, now),
  ).toBeUndefined();
});

it('私聊将客户端序号与数据库分页序号分别交给 daemon', async () => {
  const { targetGroupCode: _, ...common } = row;
  const privateMessage: C2cMsg = {
    ...common,
    msgSeq: 500n,
    clientSeq: 31n,
    targetUid: 'u_peer',
    targetUin: 0n,
    msgRandom: 99n,
  };
  expect(await projectObservedMessage(privateMessage, uidMap, nickname, now)).toMatchObject({
    scene: 'private',
    peer: { id: '20005', uid: 'u_peer' },
    seq: 31,
    clientSequence: 31,
    ntMsgSeq: 500,
    random: 99,
  });
});

it('数据库水位只投递新消息，切换账号后拒绝尚未完成的旧读取', async () => {
  const dbPath = '/fixture/nt_msg.db';
  const file = { dbPath, prevTotal: 0, total: 1, delta: 1, files: [], at: Date.now() };
  let watermark = 1n;
  let current = true;
  let task: DbWatchTask | undefined;
  const ready = Promise.withResolvers<string>();
  const nameStarted = Promise.withResolvers<void>();
  const getNickname = vi.fn(async () => '群友');
  const deliver = vi.fn(async () => true);
  const handle = watchObservedMessages(
    {
      mount(hook) {
        task = hook;
        return { unmount: () => hook.dispose?.() };
      },
    },
    {
      msgDbPath: dbPath,
      recentContacts: {
        listSeqWatermarks: async () => [
          { chatType: 2, targetUid: '55001', msgSeq: watermark, sendTime: row.sendTime },
        ],
      },
      groupMsgs: {
        listAfter: async () => [{ ...row, msgSeq: watermark, msgId: row.msgId + watermark }],
      },
      uidMap: { uinByUid: uidMap },
    } as unknown as AccountSession,
    () => current,
    getNickname,
    deliver,
  );
  try {
    await task!.onDbFileChangeHook(file);
    expect(deliver).not.toHaveBeenCalled();
    watermark = 2n;
    await task!.onDbFileChangeHook(file);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 }));

    getNickname.mockImplementationOnce(() => {
      nameStarted.resolve();
      return ready.promise;
    });
    watermark = 3n;
    const pending = task!.onDbFileChangeHook(file);
    await nameStarted.promise;
    current = false;
    ready.resolve('旧账号');
    await pending;
    expect(deliver).toHaveBeenCalledOnce();
  } finally {
    handle.unmount();
  }
});
