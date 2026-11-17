import { expect, it } from 'vitest';
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
