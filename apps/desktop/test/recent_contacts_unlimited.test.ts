import { expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({ list: vi.fn(), count: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      recentContacts: {
        getRecentContact: fixture.list,
        countRecentContact: fixture.count,
      },
    },
  }),
}));

it('主列表全量模式透传无上限查询，超过 500 个会话不截断且不生成下一页', async () => {
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
