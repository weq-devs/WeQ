import type { AccountSession } from '@weq/account';
import { UidMap, type C2cMsg } from '@weq/db';
import { expect, it, vi } from 'vitest';
import { OfficialAccountService } from '../src/account/official_account';

const peerUid = 'u_official';
const arkData = '{"prompt":"合成公众号摘要"}';
const message: C2cMsg = {
  msgId: 10n,
  msgSeq: 20n,
  targetUid: peerUid,
  targetUin: 10001n,
  senderUid: peerUid,
  senderUin: 10001n,
  sendTime: 30n,
  elements: [{ kind: 'ark', arkData }],
};

function fixture(uidMap: UidMap) {
  const latest = vi.fn().mockResolvedValue([message]);
  const calendar = vi.fn().mockResolvedValue([message]);
  const profile = vi.fn().mockResolvedValue({ nick: '本地公众号', uin: 10002n });
  const session = {
    uidMap,
    recentContacts: {
      getRecentContact: vi.fn().mockResolvedValue([
        { chatType: 1, targetUid: 'u_friend' },
        { chatType: 103, targetUid: peerUid, targetDisplayName: '目录名称', targetUin: 10001n },
      ]),
    },
    c2cMsgs: { listLatest: latest, calendarMessage: calendar },
    profileInfo: { getProfile: profile },
  } as unknown as AccountSession;
  return { service: new OfficialAccountService(session), latest, calendar, profile };
}

it.each([0n, 42n, 9007199254740993n])(
  '公众号摘要和详情使用已知 sortNo=%s，摘要及 ARK 内容保持完整',
  async (sortNo) => {
    const f = fixture(UidMap.from([{ uid: peerUid, sortNo, uin: 10001n }]));
    expect(await f.service.listAccounts()).toEqual([
      {
        peerUid,
        displayName: '本地公众号',
        targetUin: '10002',
        avatarUrl: null,
        sendTime: 30n,
        prompt: '合成公众号摘要',
      },
    ]);
    expect(f.latest).toHaveBeenLastCalledWith({ sortNo }, 1);
    expect(f.profile).toHaveBeenCalledOnce();
    const feed = await f.service.listArkFeed(peerUid, 5);
    expect(f.latest).toHaveBeenLastCalledWith({ sortNo }, 5);
    expect(feed[0]?.arkPrompt).toBe('合成公众号摘要');
    expect(feed[0]?.elements).toEqual([{ type: 'ark', data: { arkData } }]);
    await f.service.listArkFeed(peerUid, 5, '9007199254740993');
    expect(f.calendar).toHaveBeenLastCalledWith({ sortNo }, 9007199254740993n);
  },
);

it('账号打开后新出现的公众号按现有映射补查，后续请求复用常驻映射', async () => {
  const lookup = vi.fn().mockResolvedValue({ uid: peerUid, sortNo: 99n, uin: 10001n });
  const f = fixture(UidMap.from([], lookup));
  await f.service.listAccounts();
  await f.service.listArkFeed(peerUid);
  expect(lookup).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledWith(peerUid);
  expect(f.latest.mock.calls.map(([partition]) => partition)).toEqual([
    { sortNo: 99n },
    { sortNo: 99n },
  ]);
});

it.each(['missing', 'failed'])('公众号映射 %s 时保留 UID 回退与目录资料兜底', async (kind) => {
  const lookup =
    kind === 'missing'
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('合成映射错误'));
  const f = fixture(UidMap.from([], lookup));
  f.profile.mockRejectedValue(new Error('合成资料缺失'));
  const summaries = await f.service.listAccounts();
  expect(f.latest).toHaveBeenLastCalledWith({ uid: peerUid }, 1);
  expect(summaries[0]).toMatchObject({
    displayName: '目录名称',
    targetUin: '10001',
    prompt: '合成公众号摘要',
  });
  await f.service.listArkFeed(peerUid, 5, '10');
  expect(f.calendar).toHaveBeenLastCalledWith({ uid: peerUid }, 10n);
});

it('映射补查被取消后不再启动未索引消息读取', async () => {
  const error = new DOMException('合成取消', 'AbortError');
  const f = fixture(UidMap.from([], vi.fn().mockRejectedValue(error)));
  await expect(f.service.listArkFeed(peerUid)).rejects.toBe(error);
  expect(f.latest).not.toHaveBeenCalled();
  expect(f.calendar).not.toHaveBeenCalled();
});
