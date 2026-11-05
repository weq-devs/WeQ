import { expect, it, vi } from 'vitest';
import { encode, message } from '@weq/protocol';
import { AccountWriteService, type AccountWriteIdentity } from '../src/account/account_write';

function fixture() {
  let pid = 5;
  const identity: AccountWriteIdentity = {
    uin: '10001',
    selfUid: 'u_self',
    listCategories: async () => [],
    getBuddy: async (uid) =>
      uid === 'u_peer' ? { uid, uin: 10002n, qid: '', categoryId: 0 } : null,
  };
  const sendPacket = vi.fn(async () =>
    Buffer.from(
      encode(message([{ name: 'data', tag: 4, type: 'string' }]), {
        data: '{"ErrorCode":0,"uint32_add_frd_type":1}',
      }),
    ),
  );
  const service = new AccountWriteService(
    { sendPacket, sendOidbPacket: async () => Buffer.alloc(0) },
    identity,
    () => pid,
  );
  return {
    service,
    identity,
    sendPacket,
    switchPid: () => {
      pid = 6;
    },
  };
}

it('线索查询从当前好友记录取得 UIN，不接受任意 UID', async () => {
  const f = fixture();
  await expect(f.service.friendClue('u_stranger')).rejects.toThrow('不是');
  expect(f.sendPacket).not.toHaveBeenCalled();
  expect(await f.service.friendClue('u_peer')).toMatchObject({
    uid: 'u_peer',
    targetUin: '10002',
    direction: 'incoming',
  });
});
it('好友查找期间切运行时，不发送旧目标', async () => {
  const f = fixture();
  const get = f.identity.getBuddy;
  f.identity.getBuddy = async (uid) => {
    const buddy = await get(uid);
    f.switchPid();
    return buddy;
  };
  await expect(f.service.friendClue('u_peer')).rejects.toThrow('切换');
  expect(f.sendPacket).not.toHaveBeenCalled();
});
it('查询期间切运行时，不交付迟到结果', async () => {
  const f = fixture();
  const send = f.sendPacket.getMockImplementation()!;
  f.sendPacket.mockImplementation(async () => {
    const bytes = await send();
    f.switchPid();
    return bytes;
  });
  await expect(f.service.friendClue('u_peer')).rejects.toThrow('切换');
});
