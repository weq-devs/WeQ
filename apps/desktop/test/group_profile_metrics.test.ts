import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupProfileMetrics } from '../src/renderer/src/components/GroupProfileMetrics';
import { useViewState } from '../src/renderer/src/state/view';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import type { ContactMetricRows } from '@weq/service';

const mock = vi.hoisted(() => ({
  config: { uin: '10001', configId: 'source-a' },
  rows: {} as ContactMetricRows,
  query: vi.fn(),
  subscribe: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: { contactMetrics: { snapshot: { invalidate: mock.invalidate } } },
    }),
    account: {
      getAccountConfig: { useQuery: () => ({ data: mock.config }) },
      contactMetrics: {
        snapshot: {
          useQuery: (...args: unknown[]) => {
            mock.query(...args);
            return { data: { rows: mock.rows } };
          },
        },
        changed: { useSubscription: mock.subscribe },
      },
    },
  },
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mock.config = { uin: '10001', configId: 'source-a' };
  mock.rows = {};
  vi.clearAllMocks();
  useViewState.setState({ openedUin: '10001' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useViewState.setState({ openedUin: null });
});

function render(groupCode = '20001', active = true) {
  const props = {
    groupCode,
    children: (rows: Array<readonly [string, string]>) =>
      h(
        'dl',
        null,
        rows.map(([label, value]) => h('div', { key: label }, `${label}:${value}`)),
      ),
  };
  act(() => root.render(h(TabActivity, { active }, h(GroupProfileMetrics, props))));
}

it('展示排序缓存中的指标，零值有效，切群不串数据', () => {
  mock.rows = {
    'group:20001': {
      activityScore: { value: 123, state: 'ready', attemptedAt: 1 },
      friendCount: { value: 0, state: 'ready', attemptedAt: 1 },
    },
  };
  render();
  expect(host.textContent).toBe('活跃度:123群内好友数:0');
  // 另一个群没有缓存：不出行（不再写「未知」），也不会串上一个群的值。
  render('20002');
  expect(host.textContent).toBe('');
});

it('缺失或无效值显示未知，更新失败仍保留已有缓存', () => {
  mock.rows = {
    'group:20001': {
      activityScore: { value: Number.NaN, state: 'ready', attemptedAt: 1 },
      friendCount: { value: 3, state: 'failed', attemptedAt: 1, error: '读取失败' },
    },
  };
  render();
  // 无效（NaN）值不出行；同一次快照里的有效值照常显示。
  expect(host.textContent).toBe('群内好友数:3');
});

it('绑定实际账号与数据源，缓存变化仅刷新本地快照', () => {
  render();
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  expect(mock.query).toHaveBeenLastCalledWith(
    binding,
    expect.objectContaining({ enabled: true, keepPreviousData: false }),
  );
  const [input, options] = mock.subscribe.mock.lastCall!;
  expect(input).toEqual(binding);
  options.onData({ base: false });
  expect(mock.invalidate).toHaveBeenCalledWith(binding);
  mock.config = { uin: '99999', configId: 'other-source' };
  render();
  expect(mock.query.mock.lastCall![1].enabled).toBe(false);
  expect(host.textContent).toBe('');
});

it('后台页不查询或订阅，无打开账号时不挂载缓存读取', () => {
  render('20001', false);
  expect(mock.query.mock.lastCall![1].enabled).toBe(false);
  expect(mock.subscribe.mock.lastCall![1].enabled).toBe(false);
  act(() => useViewState.setState({ openedUin: null }));
  vi.clearAllMocks();
  render();
  expect(mock.query).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
});
