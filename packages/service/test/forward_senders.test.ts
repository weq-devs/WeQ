import type { AccountSession } from '@weq/account';
import type { MsgCacheRecord } from '@weq/codec';
import { UidMap, type UserProfile } from '@weq/db';
import { encode, LONG_MSG_RESULT, RECV_LONG_MSG_RESP } from '@weqbot/protocol';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { ForwardMsgService } from '../src/account/forward';

function fixture(records: MsgCacheRecord[] = []) {
  const profilesByUids = vi.fn(async (_uids: string[]) => [
    { uid: 'u_friend', uin: 10002n, nick: '本地昵称', remark: '本地备注' },
    { uid: 'u_nick', uin: 10003n, nick: '只有昵称', remark: '' },
  ]);
  const getProfileByUin = vi.fn<
    (uin: bigint) => Promise<Pick<UserProfile, 'uid' | 'uin' | 'nick' | 'remark'> | null>
  >(async () => null);
  const sendPacket = vi.fn();
  const session = {
    selfUid: 'u_self',
    uidMap: UidMap.from([{ sortNo: 1n, uid: 'u_friend', uin: 10002n }]),
    forwardMsgs: {
      listC2cForward: async () => records,
      listGroupForward: async () => records,
    },
    profileInfo: { profilesByUids, getProfileByUin },
  } as unknown as AccountSession;
  return {
    service: new ForwardMsgService(session, { sendPacket }, () => 1),
    profilesByUids,
    getProfileByUin,
    sendPacket,
  };
}

it.each(['c2c', 'group'] as const)('%s 缓存及嵌套记录批量补全本地备注和昵称', async (kind) => {
  const records = [
    { msgId: 1n, senderUid: 'u_friend', senderUin: 10002, sendNick: '10002' },
    {
      msgId: 2n,
      senderUin: 10002,
      sendNick: '转发中的旧名',
      subMsgs: [{ msgId: 3n, senderUid: 'u_nick', senderUin: 10003 }],
    },
    { msgId: 4n, senderUin: 10004, sendNick: '陌生人快照' },
  ] as MsgCacheRecord[];
  const f = fixture(records);
  const result =
    kind === 'group' ? await f.service.getGroupForward(1n) : await f.service.getC2cForward(1n);
  expect(result[0]).toMatchObject({ sendNick: '本地备注' });
  expect(result[1]).toMatchObject({
    senderUid: 'u_friend',
    sendNick: '本地备注',
    subMsgs: [{ sendNick: '只有昵称' }],
  });
  expect(result[2]).toMatchObject({ sendNick: '陌生人快照' });
  expect(f.profilesByUids).toHaveBeenCalledOnce();
  expect(new Set(f.profilesByUids.mock.calls[0]![0])).toEqual(new Set(['u_friend', 'u_nick']));
  expect(f.getProfileByUin).toHaveBeenCalledOnce();
  expect(f.getProfileByUin).toHaveBeenCalledWith(10004n);
  expect(f.sendPacket).not.toHaveBeenCalled();
});

it.each([undefined, '10004'])(
  '仅有 QQ 号时复用本地资料查询，同人多条只查一次（UID=%s）',
  async (uid) => {
    const f = fixture([
      { msgId: 1n, senderUid: uid, senderUin: 10004 },
      { msgId: 2n, senderUid: uid, senderUin: 10004 },
    ] as MsgCacheRecord[]);
    f.getProfileByUin.mockResolvedValue({
      uid: 'u_other',
      uin: 10004n,
      nick: '目录外好友',
      remark: '',
    });
    expect(await f.service.getC2cForward(1n)).toMatchObject([
      { senderUid: 'u_other', sendNick: '目录外好友' },
      { senderUid: 'u_other', sendNick: '目录外好友' },
    ]);
    expect(f.getProfileByUin).toHaveBeenCalledOnce();
    expect(f.getProfileByUin).toHaveBeenCalledWith(10004n);
  },
);

it('在线私聊转发保留引用所需的发送方序号和昵称，优先使用本地名称', async () => {
  const f = fixture();
  const payload = encode(LONG_MSG_RESULT, {
    action: [
      {
        actionCommand: 'MultiMsg',
        actionData: {
          msgBody: [
            {
              responseHead: { fromUin: 10002, fromUid: 'u_friend' },
              contentHead: { msgType: 1, sequence: 7, ntMsgSeq: 90, timestamp: 1700000000 },
              body: { richText: { elems: [{ text: { str: '合成正文' } }] } },
            },
            {
              responseHead: { fromUin: 10004, forward: { friendName: '包内昵称' } },
              contentHead: { msgType: 1, sequence: 8, ntMsgSeq: 91, timestamp: 1700000001 },
              body: { richText: { elems: [{ text: { str: '合成正文' } }] } },
            },
          ],
        },
      },
    ],
  });
  f.sendPacket.mockResolvedValue(
    Buffer.from(
      encode(RECV_LONG_MSG_RESP, {
        result: { resId: 'fixture', payload: gzipSync(payload) },
      }),
    ),
  );
  const viewed = await f.service.fetchRemote('fixture');
  expect(viewed).toMatchObject([
    {
      senderUid: 'u_friend',
      senderUin: '10002',
      sendNick: '本地备注',
      msgSeq: '90',
      clientSeq: '7',
    },
    { senderUin: '10004', sendNick: '包内昵称', msgSeq: '91', clientSeq: '8' },
  ]);
  expect(await f.service.fetchForExport('fixture')).toEqual(viewed);
  expect(f.sendPacket).toHaveBeenCalledOnce();
  await expect(f.service.fetchRemote('other-card')).rejects.toThrow('资源与请求不一致');
});

it('资料查询失败仍返回原记录，不让缺少昵称阻断聊天记录加载', async () => {
  const records = [{ msgId: 1n, senderUid: 'u_friend', sendNick: '记录原名' }] as MsgCacheRecord[];
  const f = fixture(records);
  f.profilesByUids.mockRejectedValue(new Error('资料暂不可读'));
  f.getProfileByUin.mockRejectedValue(new Error('资料暂不可读'));
  expect(await f.service.getGroupForward(1n)).toMatchObject([{ sendNick: '记录原名' }]);
});

it('UID 已有昵称但资料缺少 QQ 号时仍补全名称，空名称保留记录快照', async () => {
  const f = fixture([
    { msgId: 1n, senderUid: 'u_friend', senderUin: 10002 },
    { msgId: 2n, senderUid: 'u_nick', senderUin: 10003, sendNick: '原始昵称' },
  ] as MsgCacheRecord[]);
  f.profilesByUids.mockResolvedValue([
    { uid: 'u_friend', uin: 0n, nick: '本地昵称', remark: '' },
    { uid: 'u_nick', uin: 10003n, nick: '', remark: ' ' },
  ]);
  expect(await f.service.getC2cForward(1n)).toMatchObject([
    { sendNick: '本地昵称' },
    { sendNick: '原始昵称' },
  ]);
});

it('明确 UID 与 QQ 号冲突时不套用另一人的昵称', async () => {
  const f = fixture([
    { msgId: 1n, senderUid: 'u_friend', senderUin: 10003, sendNick: '记录原名' },
  ] as MsgCacheRecord[]);
  expect(await f.service.getC2cForward(1n)).toMatchObject([{ sendNick: '记录原名' }]);
});
