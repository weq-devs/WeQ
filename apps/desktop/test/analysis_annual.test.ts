import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnualReportView } from '../src/renderer/src/views/annual-report/AnnualReportView';
import { AnnualReportStage } from '../src/renderer/src/views/annual-report/AnnualReportStage';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  manifest: {
    year: 2025,
    availableYears: [2025, 0],
    scope: { includeC2c: true, includeGroups: true },
    pages: [
      { id: 'overview', title: '总览' },
      { id: 'end', title: '结尾' },
    ],
  },
  refetch: vi.fn(),
  options: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { annualReport: { getPageData: { query: fixture.query } } } },
  trpc: {
    account: {
      annualReport: {
        getManifest: {
          useQuery: (...args: unknown[]) => {
            fixture.options(...args);
            return {
              data: fixture.manifest,
              isLoading: false,
              isFetching: false,
              error: null,
              refetch: fixture.refetch,
            };
          },
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/views/annual-report/pageRegistry', () => ({
  renderReportPage: (page: { id: string }, _data: unknown, active: boolean) =>
    createElement('p', { 'data-report-page': page.id, 'data-active': active }, page.id),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('隐藏报告不抢全局翻页键，报告内输入框保留原生按键', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    move = vi.fn();
  const render = (active: boolean) =>
    act(() =>
      root.render(
        createElement(
          TabActivity,
          { active },
          createElement(
            AnnualReportStage,
            { index: 0, count: 2, onIndexChange: move },
            createElement('input'),
          ),
        ),
      ),
    );
  try {
    render(false);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(move).not.toHaveBeenCalled();
    render(true);
    act(() =>
      host
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    expect(move).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(move).toHaveBeenCalledWith(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('旧年度入口仍保留年份选择，进入报告前不启动正文统计', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.query.mockResolvedValue({ status: 'ok', data: {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AnnualReportView)));
    expect(host.querySelector('.weq-entry')).not.toBeNull();
    expect(fixture.query).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-entry-cta')!.click());
    expect(fixture.query).toHaveBeenCalledWith({ year: 2025, pageId: 'overview' });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('配置后的年度报告直接读取第一页，原年份、账号身份与翻页边界保持正确', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.query.mockResolvedValue({ status: 'ok', data: {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const scope = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' };
  try {
    await act(async () =>
      root.render(
        createElement(AnnualReportView, {
          configuredYear: 2025,
          scope,
          instanceKey: 'synthetic-result',
        }),
      ),
    );
    expect(host.querySelector('.weq-entry')).toBeNull();
    expect(fixture.options).toHaveBeenCalledWith(
      { year: 2025, ...scope, reportInstance: 'synthetic-result' },
      expect.objectContaining({ staleTime: Infinity }),
    );
    expect(host.querySelector('[data-report-page="overview"]')?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(fixture.query).toHaveBeenCalledWith({ year: 2025, pageId: 'overview', ...scope });
    expect(fixture.query.mock.calls.filter((call) => call[0].pageId === 'overview')).toHaveLength(
      1,
    );
    const next = host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!;
    act(() => next.click());
    expect(host.querySelector('[data-report-page="end"]')?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(next.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
