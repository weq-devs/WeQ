// @vitest-environment node
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  draftTimes: vi.fn(),
  targets: vi.fn(),
  configId: 'source-a',
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
    recentContacts: {
      getRecentContact: fixture.list,
      countRecentContact: fixture.count,
      listDraftTimes: fixture.draftTimes,
      getByTargetUids: fixture.targets,
    },
  };
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({ account: { context: { uin: '10001' } }, services }),
  };
});

it('定向摘要查询只读取指定目标，不查询最新前缀或完整目录，并拒绝切源的迟到结果', async () => {
  fixture.configId = 'source-a';
  fixture.list.mockClear();
  fixture.count.mockClear();
  fixture.targets.mockResolvedValue([]);
  const api = accountRouter.createCaller({});
  const input = {
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    targetUids: ['u_1000'],
  };
  expect(await api.listRecentContactTargets(input)).toEqual([]);
  expect(fixture.targets).toHaveBeenCalledWith(['u_1000']);
  expect(fixture.list).not.toHaveBeenCalled();
  expect(fixture.count).not.toHaveBeenCalled();
  fixture.targets.mockImplementationOnce(async () => {
    fixture.configId = 'source-b';
    return [];
  });
  await expect(api.listRecentContactTargets(input)).rejects.toThrow('数据源已切换');
});

it('主列表全量模式透传无上限查询，超过 500 个会话不截断且不生成下一页', async () => {
  fixture.configId = 'source-a';
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    chatType: 1,
    msgSeq: 1n,
    targetUid: `u_fixture${index}`,
    senderUid: '',
    targetUin: 0n,
    sendTime: 1n,
    topTime: 0n,
    pinned: false,
    preview: null,
    tempSourceGroupCode: 0n,
  }));
  fixture.list.mockResolvedValue(rows);
  fixture.count.mockResolvedValue(rows.length);
  const result = await accountRouter.createCaller({}).listRecentContacts({ limit: -1 });
  expect(fixture.list).toHaveBeenCalledWith(-1, 0, { excludeChatTypes: [103, 118] });
  expect(result.items).toHaveLength(rows.length);
  expect(result.nextCursor).toBeUndefined();
  expect(result.total).toBe(rows.length);
});

it('最近会话与草稿时间拒绝同号切源的迟到结果', async () => {
  fixture.configId = 'source-a';
  fixture.count.mockResolvedValue(1);
  fixture.list.mockImplementationOnce(async () => {
    fixture.configId = 'source-b';
    return [];
  });
  const api = accountRouter.createCaller({});
  await expect(
    api.listRecentContacts({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' }),
  ).rejects.toThrow('数据源已切换');
  fixture.configId = 'source-a';
  fixture.draftTimes.mockImplementationOnce(async () => {
    fixture.configId = 'source-b';
    return new Map();
  });
  await expect(
    api.listConversationDraftTimes({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    }),
  ).rejects.toThrow('数据源已切换');
});
