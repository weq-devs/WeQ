import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnualReportView } from '../src/renderer/src/views/annual-report/AnnualReportView';
import { AnnualReportStage } from '../src/renderer/src/views/annual-report/AnnualReportStage';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { SparkPage } from '../src/renderer/src/views/annual-report/pages/SparkPage';

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
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('阅读布局的绿墙横向滚动不切年份，演示模式仍保留原年份手势', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  const page = {
    id: 'spark',
    title: '火花',
    description: '',
    order: 1,
    version: '1',
    apiVersion: 1,
    category: '私聊',
    enabledByDefault: true,
  };
  const data = {
    year: 0,
    wallYears: [2024, 2025],
    wallYear: 2025,
    wallWindow: null,
    wallDays: [],
    topDay: null,
    sentTotal: 1,
    activeDays: 1,
    longestSelfRun: 1,
    spark: null,
  };
  const render = (layout: string) =>
    act(() =>
      root.render(
        createElement(
          'div',
          { 'data-layout': layout },
          createElement(SparkPage, { page, data, active: true }),
        ),
      ),
    );
  try {
    render('reading');
    act(() =>
      host
        .querySelector('.weq-sp-wall-cal')!
        .dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -100 })),
    );
    expect(host.querySelector<HTMLButtonElement>('[aria-label="下一年"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="上一年"]')?.disabled).toBe(false);
    expect(host.querySelector('.weq-sp-wall-title')?.textContent).toContain('2025');
    render('presentation');
    act(() =>
      host
        .querySelector('.weq-sp-wall-cal')!
        .dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -100 })),
    );
    expect(host.querySelector<HTMLButtonElement>('[aria-label="下一年"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="上一年"]')?.disabled).toBe(true);
    expect(host.querySelector('.weq-sp-wall-title')?.textContent).toContain('2024');
  } finally {
    act(() => root.unmount());
  }
});

it('按实际内容区切换阅读布局，滚轮和键盘留给正文滚动；扩宽后恢复演示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 375, 500));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    move = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(AnnualReportStage, { index: 0, count: 2, onIndexChange: move }, '正文'),
      ),
    );
    const stage = host.querySelector<HTMLElement>('.weq-report-stage-host')!;
    expect(stage.dataset.layout).toBe('reading');
    expect(host.querySelector<HTMLElement>('.weq-report-stage')!.style.transform).toBe('');
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 150 });
    act(() => stage.dispatchEvent(wheel));
    const key = new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true });
    act(() => window.dispatchEvent(key));
    expect(wheel.defaultPrevented).toBe(false);
    expect(key.defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
    rect.mockReturnValue(new DOMRect(0, 0, 1000, 700));
    act(resize);
    expect(stage.dataset.layout).toBe('presentation');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' })));
    expect(move).toHaveBeenCalledWith(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
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
