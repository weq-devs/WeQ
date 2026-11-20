import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { useViewState } from '../src/renderer/src/state/view';
import { AnalysisReportPage } from '../src/renderer/src/views/analysis/AnalysisReportPage';
import { SavedAnalysisBody } from '../src/renderer/src/views/analysis/SavedAnalysisBody';
import type { SavedAnalysisReport } from '../../../packages/service/src/account/analysis_reports';
import { chooseFormOption, formOptions, formSelectSelector } from './support/form-controls';
const f = vi.hoisted(() => ({
  saved: null as SavedAnalysisReport | null,
  versions: [] as Array<{
    resultRevision: number;
    request: SavedAnalysisReport['request'];
    updatedAt: number;
  }>,
  create: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  background: vi.fn(async () => undefined),
  pauseForeground: vi.fn(async () => undefined),
  position: vi.fn(async () => undefined),
  body: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      analysisReports: {
        get: { useQuery: () => ({ data: f.saved, refetch: f.refetch }) },
        versions: { useQuery: () => ({ data: f.versions, refetch: f.refetch }) },
        version: { useQuery: () => ({ data: null }) },
        onChange: { useSubscription() {} },
      },
    },
  },
  client: {
    account: {
      analysisReports: {
        create: { mutate: f.create },
        cancel: { mutate: f.cancel },
        resume: { mutate: f.resume },
        background: { mutate: f.background },
        pauseForeground: { mutate: f.pauseForeground },
        position: { mutate: f.position },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/BuddyAnalyticsDialog', () => ({
  BuddyAnalyticsDialog: (props: unknown) => {
    f.body(props);
    return createElement('div', { className: 'group-album-body' }, '已保存图表');
  },
}));
vi.mock('../src/renderer/src/components/GroupAnalyticsDialog', () => ({
  GroupAnalyticsDialog: () => null,
}));
vi.mock('../src/renderer/src/components/MemberAnalyticsDialog', () => ({
  MemberAnalyticsDialog: () => null,
}));
vi.mock('../src/renderer/src/views/annual-report/AnnualReportView', () => ({
  AnnualReportView: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  f.versions = [];
});
it.each(['close', 'background', 'reopen'] as const)(
  '前台报告可关页暂停、交给后台或只读打开（%s）',
  async (action) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const account = useViewState.getState().openedUin;
    const originalConfirm = useDialog.getState().confirm;
    const confirm = vi.fn(async () => true);
    useDialog.setState({ confirm });
    const request = {
      id: 'foreground-report',
      kind: 'buddy' as const,
      name: '合成对象',
      peerUid: 'peer',
      period: '全部',
      scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
      ...(action === 'reopen' ? { existing: true as const } : {}),
    };
    useViewState.setState({ openedUin: request.scope.expectedAccountUin });
    f.saved = {
      request,
      status: 'running',
      taskHidden: true,
      results: {},
      pending: {},
      completed: [],
      logs: [{ ts: 1, text: '正在计算消息统计' }],
      revision: 1,
      resultRevision: 0,
      position: 0,
      updatedAt: 1,
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    try {
      await act(async () => root.render(createElement(AnalysisReportPage, { request, onClose })));
      const modal = document.querySelector('[aria-modal="true"]')!;
      expect(modal.textContent).toContain('正在计算消息统计');
      const target =
        action === 'background'
          ? [...modal.querySelectorAll('button')].find(
              (button) => button.textContent?.trim() === '后台进行',
            )!
          : modal.querySelector<HTMLButtonElement>('[aria-label="关闭分析报告"]')!;
      await act(async () => target.click());
      expect(onClose).toHaveBeenCalledOnce();
      expect(f.pauseForeground).toHaveBeenCalledTimes(action === 'close' ? 1 : 0);
      expect(f.background).toHaveBeenCalledTimes(action === 'background' ? 1 : 0);
      expect(f.create).toHaveBeenCalledTimes(action === 'reopen' ? 0 : 1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: account });
      useDialog.setState({ confirm: originalConfirm });
    }
  },
);
it('报告完成时在遮罩内显示结果，底层工作区切换不关闭或重建报告', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const account = useViewState.getState().openedUin;
  const request = {
    id: 'report-completion',
    kind: 'buddy' as const,
    name: '合成好友',
    peerUid: 'peer',
    period: '全部',
    scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  };
  useViewState.setState({ openedUin: request.scope.expectedAccountUin });
  f.saved = {
    request,
    status: 'running',
    results: {},
    pending: {},
    completed: [],
    logs: [],
    revision: 1,
    resultRevision: 0,
    position: 0,
    updatedAt: 1,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const render = (navigationKey: string) =>
    root.render(
      createElement(
        WorkspacePages,
        { navigationKey },
        createElement(WorkspaceContent, null, '分析配置'),
        createElement(AnalysisReportPage, { request, onClose }),
      ),
    );
  try {
    await act(async () => render('messages'));
    expect(document.querySelector('[role="status"]')?.textContent).toBe('正在分析');
    f.saved = {
      ...f.saved,
      status: 'completed',
      results: { report: { count: 7 } },
      completed: ['report'],
      resultRevision: 1,
      updatedAt: 2,
    };
    await act(async () => render('messages:peer'));
    const dialog = document.querySelector('[aria-modal="true"]');
    expect(dialog?.querySelector('[role="status"]')?.textContent).toBe('分析完成');
    expect(dialog?.textContent).toContain('已保存图表');
    expect(onClose).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useViewState.setState({ openedUin: account });
  }
});
it('只有一个结果时隐藏版本控件，多版本不重复最新项，加载历史仍保留已显示结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const request = {
    id: 'versions',
    kind: 'buddy' as const,
    name: '对象',
    peerUid: 'peer',
    period: '全部',
    scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  };
  f.saved = {
    request,
    status: 'completed',
    results: { report: { count: 7 } },
    pending: {},
    completed: ['report'],
    logs: [],
    revision: 1,
    resultRevision: 1,
    position: 0,
    updatedAt: 1,
  };
  f.versions = [{ resultRevision: 1, request, updatedAt: 1 }];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} }));
  try {
    await act(async () => render());
    expect(host.querySelector(formSelectSelector)).toBeNull();
    f.saved = { ...f.saved, revision: 2, resultRevision: 2 };
    f.versions = [
      { resultRevision: 2, request, updatedAt: 2 },
      { resultRevision: 1, request, updatedAt: 1 },
    ];
    await act(async () => render());
    const select = host.querySelector<HTMLButtonElement>(formSelectSelector)!;
    expect(formOptions(select).map((option) => option.value)).toEqual(['0', '1']);
    await act(async () => {
      chooseFormOption(select, '1');
    });
    expect(host.textContent).toContain('已保存图表');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新分析"]')!.click(),
    );
    expect(select.dataset.value).toBe('0');
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it('展示保存结果，刷新失败仍传旧结果与原范围给图表', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const request = {
    id: 'report-a',
    kind: 'buddy' as const,
    name: '测试对象',
    peerUid: 'peer',
    period: '全部',
    scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  };
  f.saved = {
    request,
    status: 'running',
    results: { report: { count: 7 } },
    pending: {},
    completed: [],
    logs: [],
    revision: 2,
    resultRevision: 1,
    resultRequest: request,
    position: 100,
    updatedAt: 1,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} })));
    expect(host.textContent).toContain('正在分析');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    f.saved = {
      ...f.saved,
      status: 'failed',
      error: '读取失败',
      request: {
        ...request,
        scope: { ...request.scope, startTime: 1793462400, endTime: 1793548799 },
      },
    };
    await act(async () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} })));
    expect(host.textContent).toContain('读取失败');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ scope: request.scope }));
    expect(host.textContent).toContain('结果范围：全部本地历史');
    expect(host.textContent).toContain('本次分析范围：2026-11-01 至 2026-11-01');
    expect(f.resume).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
  expect(f.cancel).not.toHaveBeenCalled();
});
