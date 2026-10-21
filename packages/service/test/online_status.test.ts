import { expect, it } from 'vitest';
import { OnlineStatusService } from '../src/account/online_status';

it.each([
  { type: 10, subType: 2000, expected: '测试状态' },
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
