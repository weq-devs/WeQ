import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SavedAnalysisBody } from '../src/renderer/src/views/analysis/SavedAnalysisBody';
import type { SavedAnalysisReport } from '../../../packages/service/src/account/analysis_reports';
const f = vi.hoisted(() => ({
  saved: null as SavedAnalysisReport | null,
  versions: [] as Array<{ resultRevision: number }>,
  create: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  f.versions = [];
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
  f.versions = [{ resultRevision: 1 }];
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} }));
  try {
    await act(async () => render());
    expect(host.querySelector('select')).toBeNull();
    f.saved = { ...f.saved, revision: 2, resultRevision: 2 };
    f.versions = [{ resultRevision: 2 }, { resultRevision: 1 }];
    await act(async () => render());
    const select = host.querySelector('select')!;
    expect(select.classList.contains('weq-saved-analysis-version')).toBe(true);
    expect([...select.options].map((option) => option.value)).toEqual(['0', '1']);
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('已保存图表');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新分析"]')!.click(),
    );
    expect(select.value).toBe('0');
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  } finally {
    await act(async () => root.unmount());
  }
});
it('展示保存结果，刷新失败仍传旧结果给图表，关闭面板不取消运行任务', async () => {
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
    position: 100,
    updatedAt: 1,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} })));
    expect(host.textContent).toContain('正在分析');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    f.saved = { ...f.saved, status: 'failed', error: '读取失败' };
    await act(async () => root.render(createElement(SavedAnalysisBody, { request, onClose() {} })));
    expect(host.textContent).toContain('读取失败');
    expect(f.body).toHaveBeenLastCalledWith(expect.objectContaining({ initialData: { count: 7 } }));
    expect(f.resume).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
  expect(f.cancel).not.toHaveBeenCalled();
});
