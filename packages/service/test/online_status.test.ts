import { expect, it, vi } from 'vitest';
import { OnlineStatusService } from '../src/account/online_status';

it.each([
  { type: 10, subType: 2000, expected: '在线 - 测试状态' },
  { type: 10, subType: 1018, expected: '在线 - 学习中' },
  { type: 50, subType: 2000, expected: '忙碌' },
])('基础状态 $type／扩展状态 $subType 的展示文案不混用', async ({ type, subType, expected }) => {
  const service = new OnlineStatusService({
    misc: {
      getUserOnlineStatus: async () => ({
        uid: 'u_fixture',
        uin: '10001',
        type,
        subType,
        statusName: '',
        customStatus: { faceId: 0, faceType: 1, text: '测试状态' },
      }),
    },
  });
  expect((await service.getOnlineStatus('u_fixture'))?.displayStatus).toBe(expected);
});

it('本人下线覆盖本地旧状态，重新上线恢复扩展状态，不影响他人记录', async () => {
  let online = false;
  const service = new OnlineStatusService(
    {
      misc: {
        getUserOnlineStatus: async (uid) => ({
          uid,
          uin: uid === 'u_self' ? '10001' : '10002',
          type: 10,
          subType: 2000,
          statusName: '在线',
          customStatus: { faceId: 0, faceType: 1, text: '测试状态' },
        }),
      },
    },
    undefined,
    { uid: 'u_self', uin: '10001', isOnline: () => online },
  );
  expect(await service.getOnlineStatus('u_self')).toMatchObject({
    uid: 'u_self',
    uin: '10001',
    type: 0,
    typeName: '离线',
    subType: 0,
    subTypeName: '',
    displayStatus: '离线',
  });
  expect((await service.getOnlineStatus('u_self'))?.customStatus).toBeUndefined();
  expect((await service.getOnlineStatus('u_peer'))?.displayStatus).toBe('在线 - 测试状态');
  online = true;
  expect((await service.getOnlineStatus('u_self'))?.displayStatus).toBe('在线 - 测试状态');
});

it('本人缺少本地状态记录时仍显示已确认的离线，不推测在线账号和他人的状态', async () => {
  let online = false;
  const service = new OnlineStatusService(
    { misc: { getUserOnlineStatus: async () => null } },
    undefined,
    { uid: 'u_self', uin: '10001', isOnline: () => online },
  );
  expect((await service.getOnlineStatus('u_self'))?.type).toBe(0);
  expect(await service.getOnlineStatus('u_peer')).toBeNull();
  online = true;
  expect(await service.getOnlineStatus('u_self')).toBeNull();
});

it('本地状态未刷新时，精确匹配的线上读回立即供所有本人状态入口读取', async () => {
  let local = {
    uid: 'u_self',
    uin: '10001',
    type: 30,
    subType: 0,
    statusName: '',
  };
  // 真实 0x116c_1 主状态为 11；样本用合成 UID、文字和默认表情 ID 0。
  const sendOidbPacket = vi.fn(async () =>
    Buffer.from('0a06755f73656c66100b50d00f720712036e65771801', 'hex'),
  );
  const service = new OnlineStatusService(
    { misc: { getUserOnlineStatus: async (uid) => ({ ...local, uid }) } },
    { nt: { sendOidbPacket, sendPacket: vi.fn() }, resolvePid: () => 1 },
    { uid: 'u_self', uin: '10001', isOnline: () => true },
  );
  const custom = { wording: 'new', faceId: 0, faceType: 1 };
  const desired = { status: 10, extStatus: 2000, custom };
  for (const patch of [{ wording: 'old' }, { faceId: 14 }, { faceType: 2 }]) {
    expect(await service.confirmSelfStatus({ ...desired, custom: { ...custom, ...patch } })).toBe(
      false,
    );
  }
  expect((await service.getOnlineStatus('u_self'))?.type).toBe(30);
  expect(await service.confirmSelfStatus(desired)).toBe(true);
  expect(sendOidbPacket).toHaveBeenLastCalledWith(
    1,
    0x116c,
    1,
    Buffer.from('0a06755f73656c6610011a0020013000', 'hex'),
    false,
    false,
    expect.any(Number),
  );
  expect(await service.getOnlineStatus('u_self')).toMatchObject({
    type: 10,
    subType: 2000,
    displayStatus: '在线 - new',
    customStatus: { text: 'new', faceId: 0, faceType: 1 },
  });
  expect((await service.getOnlineStatus('u_peer'))?.type).toBe(30);
  local = { ...local, type: 10, subType: 1018 };
  expect((await service.getOnlineStatus('u_self'))?.displayStatus).toBe('在线 - 学习中');
  expect(sendOidbPacket).toHaveBeenCalledTimes(4);
});

it('忽略其他账号或已退出的 QQ 进程返回的在线状态，本地更新后不必发包', async () => {
  let pid = 1;
  let type = 10;
  const sendOidbPacket = vi
    .fn()
    .mockResolvedValueOnce(Buffer.from('0a06755f70656572101e', 'hex'))
    .mockImplementationOnce(async () => {
      pid = 2;
      return Buffer.from('0a06755f73656c66101e', 'hex');
    });
  const service = new OnlineStatusService(
    {
      misc: {
        getUserOnlineStatus: async (uid) => ({
          uid,
          uin: '10001',
          type,
          subType: 0,
          statusName: '',
        }),
      },
    },
    { nt: { sendOidbPacket, sendPacket: vi.fn() }, resolvePid: () => pid },
    { uid: 'u_self', uin: '10001', isOnline: () => true },
  );
  expect(await service.confirmSelfStatus({ status: 30 })).toBe(false);
  expect(await service.confirmSelfStatus({ status: 30 })).toBe(false);
  expect((await service.getOnlineStatus('u_self'))?.type).toBe(10);
  type = 30;
  expect(await service.confirmSelfStatus({ status: 30 })).toBe(true);
  expect(sendOidbPacket).toHaveBeenCalledTimes(2);
});
