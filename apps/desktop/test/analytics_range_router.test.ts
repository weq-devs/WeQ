import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  uin: '10001',
  configId: 'synthetic',
  buddy: vi.fn(),
  stats: vi.fn(),
  member: vi.fn(),
  graph: vi.fn(),
  batches: vi.fn(),
  manifest: vi.fn(),
  page: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: fixture.uin } },
    services: {
      accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
      buddyAnalytics: { getBuddyAnalytics: fixture.buddy },
      annualReport: { getManifest: fixture.manifest, getPageData: fixture.page },
      groupInfo: {
        getGroupStatsReport: fixture.stats,
        getGroupMemberAnalytics: fixture.member,
        getGroupConversationGraph: fixture.graph,
        getGroupJoinBatches: fixture.batches,
      },
    },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.uin = '10001';
  fixture.configId = 'synthetic';
});
const range = {
  startTime: 100,
  endTime: 200,
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'synthetic',
};

it('五类分析路由保留同一范围，旧调用仍可省略范围', async () => {
  const api = accountRouter.createCaller({});
  await api.getBuddyAnalytics({ peerUid: 'u_peer', ...range });
  expect(fixture.buddy).toHaveBeenCalledWith('u_peer', expect.objectContaining(range));
  await api.getGroupStatsReport({ groupCode: '777', ...range });
  expect(fixture.stats).toHaveBeenCalledWith(
    777n,
    expect.objectContaining({ startTime: 100, endTime: 200 }),
  );
  await api.getGroupMemberAnalytics({ groupCode: '777', memberUid: 'u_peer', ...range });
  expect(fixture.member).toHaveBeenCalledWith(777n, 'u_peer', 100, 200);
  await api.getGroupConversationGraph({ groupCode: '777', ...range });
  expect(fixture.graph).toHaveBeenCalledWith(
    777n,
    expect.objectContaining({ startTime: 100, endTime: 200 }),
  );
  await api.getGroupJoinBatches({ groupCode: '777', ...range });
  expect(fixture.batches).toHaveBeenCalledWith(777n, expect.objectContaining(range));
  await api.getBuddyAnalytics({ peerUid: 'u_peer' });
  expect(fixture.buddy).toHaveBeenLastCalledWith('u_peer', { peerUid: 'u_peer' });
});

it('反向、负数和不安全边界在读取前拒绝；账号或同号数据源变化也不读取', async () => {
  const api = accountRouter.createCaller({});
  for (const invalid of [
    { startTime: 2, endTime: 1 },
    { startTime: -1 },
    { endTime: 0.5 },
    { startTime: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await expect(api.getBuddyAnalytics({ peerUid: 'u_peer', ...invalid })).rejects.toThrow();
  fixture.uin = '10002';
  await expect(api.getBuddyAnalytics({ peerUid: 'u_peer', ...range })).rejects.toThrow(
    '账号已切换',
  );
  fixture.uin = '10001';
  fixture.configId = 'other-source';
  await expect(api.getGroupStatsReport({ groupCode: '777', ...range })).rejects.toThrow(
    '数据源已切换',
  );
  expect(fixture.buddy).not.toHaveBeenCalled();
  expect(fixture.stats).not.toHaveBeenCalled();
});

it('年度报告的目录、正文、媒体与三种保存入口同样拒绝旧账号或旧数据源', async () => {
  const api = accountRouter.createCaller({});
  await api.annualReport.getManifest({ year: 2025, ...range });
  await api.annualReport.getPageData({ year: 2025, pageId: 'overview', ...range });
  expect(fixture.manifest).toHaveBeenCalledWith(2025);
  expect(fixture.page).toHaveBeenCalledWith(2025, 'overview');
  fixture.configId = 'other-source';
  await expect(api.annualReport.getManifest({ year: 2025, ...range })).rejects.toThrow(
    '数据源已切换',
  );
  await expect(
    api.annualReport.getPageData({ year: 2025, pageId: 'overview', ...range }),
  ).rejects.toThrow('数据源已切换');
  await expect(
    api.annualReport.resolveMediaBase64({ url: 'weq-media://pic?synthetic=1', ...range }),
  ).rejects.toThrow('数据源已切换');
  for (const method of [
    api.annualReport.exportHtml,
    api.annualReport.exportPdf,
    api.annualReport.exportLongImage,
  ])
    await expect(method({ year: 2025, html: '<p>合成报告</p>', ...range })).rejects.toThrow(
      '数据源已切换',
    );
  expect(fixture.manifest).toHaveBeenCalledOnce();
  expect(fixture.page).toHaveBeenCalledOnce();
});
