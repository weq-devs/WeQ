// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ analytics: vi.fn(), external: vi.fn() }));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { exportAnalyticsCard: { mutate: f.analytics } },
    help: { openExternal: { mutate: f.external } },
  },
}));
import {
  canExportAnalyticsCard,
  exportAnalyticsCard,
} from '../src/renderer/src/components/analyticsShot';
import { openExternalLink } from '../src/renderer/src/lib/openExternalLink';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { open: vi.fn() });
});
it('Web 分析长图走共享业务接口，不要求 Electron preload', async () => {
  f.analytics.mockResolvedValue({ saved: false, taskId: 'task' });
  expect(canExportAnalyticsCard()).toBe(true);
  const payload = {
    kind: 'buddy' as const,
    title: 'fixture',
    label: '分析',
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'fixture',
    data: { total: 3 },
  };
  expect(await exportAnalyticsCard(payload)).toEqual({ saved: false, taskId: 'task' });
  expect(f.analytics).toHaveBeenCalledWith(payload);
});
it('无账号身份不提交报告；服务端不可用明确返回错误', async () => {
  expect(
    await exportAnalyticsCard({ kind: 'buddy', title: 'fixture', label: '分析' }),
  ).toMatchObject({ saved: false, error: '账号尚未就绪' });
  expect(f.analytics).not.toHaveBeenCalled();
  f.analytics.mockRejectedValue(new Error('渲染引擎不可用'));
  expect(
    await exportAnalyticsCard({
      kind: 'buddy',
      title: 'fixture',
      label: '分析',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'fixture',
    }),
  ).toMatchObject({ saved: false, error: '渲染引擎不可用' });
});
it('浏览器外链立即在客户端打开，不调用远端电脑外链接口', async () => {
  const opened = openExternalLink('https://example.com/path');
  expect(window.open).toHaveBeenCalledWith(
    'https://example.com/path',
    '_blank',
    'noopener,noreferrer',
  );
  expect(await opened).toEqual({ ok: true });
  expect(f.external).not.toHaveBeenCalled();
});
it.each(['javascript:alert(1)', 'file:///private/file', 'https://secret@example.com'])(
  '拒绝将 %s 交给客户端打开',
  async (url) => {
    expect((await openExternalLink(url)).ok).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  },
);
