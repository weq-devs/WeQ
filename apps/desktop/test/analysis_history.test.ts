import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisHistory } from '../src/renderer/src/views/analysis/AnalysisHistory';
import type { AnalysisReportSummary } from '../../../packages/service/src/account/analysis_reports';
const f = vi.hoisted(() => ({
  reports: [] as AnalysisReportSummary[],
  confirm: vi.fn(async () => false),
  remove: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
      analysisReports: {
        list: { useQuery: () => ({ data: f.reports, refetch: f.refetch }) },
        onChange: { useSubscription() {} },
      },
    },
  },
  client: { account: { analysisReports: { remove: { mutate: f.remove } } } },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => ({ confirm: f.confirm }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  f.confirm.mockResolvedValue(false);
});
it('历史报告使用轻量列表并自动窗口化，打开一步完成，删除仍单独确认', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.reports = Array.from({ length: 1000 }, (_, index) => ({
    request: {
      id: `report-${index}`,
      kind: 'buddy',
      name: `对象 ${index}`,
      period: '全部',
      peerUid: 'peer',
      scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    },
    status: 'completed',
    completed: ['report'],
    logs: [],
    revision: 1,
    resultRevision: 1,
    position: 0,
    updatedAt: 1000 + index,
  }));
  const host = document.createElement('div');
  const root = createRoot(host);
  const opened = vi.fn();
  window.addEventListener('weq:open-saved-analysis', opened);
  try {
    await act(async () => root.render(createElement(AnalysisHistory, { enabled: true })));
    expect(host.querySelectorAll('.weq-analysis-choice').length).toBeLessThan(20);
    expect(host.querySelector('.weq-set-btn')).toBeNull();
    expect(host.textContent).not.toContain('加载更多');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看报告 对象 0"]')!.click(),
    );
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toBe('report-0');
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="删除报告 对象 0"]')!;
    await act(async () => remove.click());
    expect(f.remove).not.toHaveBeenCalled();
    f.confirm.mockResolvedValue(true);
    await act(async () => remove.click());
    expect(f.remove).toHaveBeenCalledWith({
      id: 'report-0',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'fixture',
    });
  } finally {
    window.removeEventListener('weq:open-saved-analysis', opened);
    await act(async () => root.unmount());
  }
});
