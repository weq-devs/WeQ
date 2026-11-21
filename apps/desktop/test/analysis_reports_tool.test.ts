import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisReportsTool } from '../src/renderer/src/views/analysis/AnalysisReportsTool';
import type { AnalysisReportSummary } from '../../../packages/service/src/account/analysis_reports';
import { chooseFormOption } from './support/form-controls';
const f = vi.hoisted(() => ({
  reports: [] as AnalysisReportSummary[],
  listError: null as Error | null,
  subscribe:
    vi.fn<
      (
        binding: { expectedAccountUin: string; expectedAccountConfigId: string },
        callbacks: { enabled: boolean; onStarted(): void; onData(): void },
      ) => void
    >(),
  confirm: vi.fn(async () => false),
  remove: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
  get: vi.fn(
    async ({ id }: { id: string }): Promise<AnalysisReportSummary | undefined> =>
      f.reports.find((report) => report.request.id === id),
  ),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
      analysisReports: {
        list: { useQuery: () => ({ data: f.reports, error: f.listError, refetch: f.refetch }) },
        onChange: { useSubscription: f.subscribe },
      },
    },
  },
  client: { account: { analysisReports: { remove: { mutate: f.remove }, get: { query: f.get } } } },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => ({ confirm: f.confirm }),
}));
vi.mock('../src/renderer/src/components/Dialog.shared', () => ({
  useDialog: () => ({ confirm: f.confirm }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  f.confirm.mockResolvedValue(false);
  f.listError = null;
});
it('报告订阅重连后补读，列表读取失败可手动重试', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(() => root.render(createElement(AnalysisReportsTool, { onOpenReport() {} })));
  try {
    render();
    const [binding, callbacks] = f.subscribe.mock.lastCall!;
    expect(binding).toEqual({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' });
    expect(callbacks.enabled).toBe(true);
    act(() => callbacks.onStarted());
    expect(f.refetch).toHaveBeenCalledOnce();

    f.listError = new Error('暂时无法读取报告');
    render();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(f.listError.message);
    act(() => alert?.parentElement?.querySelector('button')?.click());
    expect(f.refetch).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
it('报告列表自动窗口化，打开一步完成，删除仍单独确认', async () => {
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
  try {
    await act(async () =>
      root.render(createElement(AnalysisReportsTool, { onOpenReport: opened })),
    );
    expect(host.querySelectorAll('[aria-label^="查看报告 "]').length).toBeLessThan(20);
    expect(host.querySelector('.weq-set-btn')).toBeNull();
    expect(host.textContent).not.toContain('加载更多');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看报告 对象 0"]')!.click(),
    );
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-0' }));
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
    await act(async () => root.unmount());
  }
});
it('按类型、群归属和执行状态查找，失败记录仍显示可读旧成果及其范围', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const scope = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
  const base = {
    status: 'completed' as const,
    completed: ['report'],
    logs: [],
    revision: 1,
    resultRevision: 1,
    position: 0,
    updatedAt: 1,
  };
  const original = {
    id: 'member',
    kind: 'member' as const,
    name: '同名对象',
    groupCode: '20001',
    groupName: '课程群',
    memberUid: 'u_member',
    scope,
    period: '旧文案',
  };
  f.reports = [
    {
      ...base,
      request: {
        id: 'buddy',
        kind: 'buddy',
        name: '同名对象',
        peerUid: 'u_buddy',
        scope,
        period: '旧文案',
      },
    },
    {
      ...base,
      status: 'failed',
      revision: 2,
      request: { ...original, scope: { ...scope, startTime: 1793462400, endTime: 1793548799 } },
      resultRequest: original,
    },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AnalysisReportsTool, { onOpenReport() {} })));
    const type = host.querySelector<HTMLButtonElement>('[aria-label="筛选报告类型"]')!;
    await act(async () => {
      chooseFormOption(type, 'member');
    });
    expect(host.querySelectorAll('[aria-label^="查看报告 "]')).toHaveLength(1);
    expect(host.textContent).toContain('课程群（20001）');
    expect(host.textContent).toContain('结果范围：全部本地历史');
    expect(host.textContent).toContain('本次范围：2026-11-01 至 2026-11-01');
    expect(host.textContent).toContain('已保存 · 版本 1 · 分析失败');
    const status = host.querySelector<HTMLButtonElement>('[aria-label="筛选报告状态"]')!;
    await act(async () => {
      chooseFormOption(status, 'completed');
    });
    expect(host.textContent).toContain('没有匹配的分析报告');
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索分析报告"]')!;
    await act(async () => {
      chooseFormOption(status, 'all');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        '不存在',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[aria-label^="查看报告 "]')).toHaveLength(0);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        '20001',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[aria-label^="查看报告 "]')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
