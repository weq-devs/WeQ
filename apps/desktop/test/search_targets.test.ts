// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSearchTargetsRouter } from '../src/main/ipc/routers/search_targets';
import type { AccountServices } from '../src/main/context/app_context';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
it('公告重复页停止，精华逐页按准确序号命中，失效不退化成其他目标', async () => {
  const bulletins = vi.fn(async () => Array.from({ length: 100 }, (_, i) => ({ fid: `n-${i}` })));
  const essence = vi.fn(async (_group: string, page: number) => ({
    messages: [{ msgSeq: page + 1 }],
    complete: page > 1,
  }));
  const services = {
    groupInfo: {
      getGroupDetail: async () => ({ groupName: '测试群' }),
      getGroupBulletins: bulletins,
      getEssencePageWithContent: essence,
    },
    webQuery: { getGroupNotice: async () => [] },
  } as unknown as AccountServices;
  const caller = createSearchTargetsRouter(() => services).createCaller({});
  await expect(
    caller.group({ ...binding, kind: 'groupBulletin', groupCode: '10002', id: 'missing' }),
  ).rejects.toThrow('未找到对应内容');
  expect(bulletins).toHaveBeenCalledTimes(2);
  expect(
    await caller.group({ ...binding, kind: 'groupEssence', groupCode: '10002', id: '2' }),
  ).toMatchObject({ kind: 'essence', message: { msgSeq: 2 } });
  expect(essence.mock.calls.map((call) => call[1])).toEqual([0, 1]);
});
it('读取期间切号丢弃迟到结果', async () => {
  let active = true;
  const services = {
    groupInfo: {
      getGroupDetail: async () => {
        active = false;
        return null;
      },
    },
  } as unknown as AccountServices;
  const caller = createSearchTargetsRouter(() => {
    if (!active) throw new Error('账号已切换');
    return services;
  }).createCaller({});
  await expect(
    caller.group({ ...binding, kind: 'groupEssence', groupCode: '10002', id: '2' }),
  ).rejects.toThrow('账号已切换');
});
