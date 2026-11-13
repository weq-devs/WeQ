import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UsagePanel } from '../src/renderer/src/views/agentlab/UsagePanel';

const state = vi.hoisted(() => ({
  known: 0,
  tokens: 0,
  unknown: 1,
  promptUnknown: undefined as number | undefined,
  completionUnknown: undefined as number | undefined,
  error: false,
  empty: false,
  feature: 'intent-analysis',
  featureCount: 1,
  queryInput: undefined as unknown,
  queryOptions: undefined as { enabled: boolean } | undefined,
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAgentLabTokenStats: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          state.queryInput = input;
          state.queryOptions = options;
          return {
            isLoading: false,
            isError: state.error,
            isFetching: false,
            refetch: state.refetch,
            error: state.error ? { message: '读取失败' } : null,
            data: state.error
              ? undefined
              : {
                  period: '7d',
                  range: { since: 1794000000000, until: 1794500000000 },
                  ledgers: [
                    {
                      source: 'account',
                      retainedCalls: 5000,
                      limit: 5000,
                      atCapacity: true,
                      firstRecordAt: 1794000000000,
                      lastRecordAt: 1794500000000,
                    },
                  ],
                  accountCalls: state.known + state.unknown,
                  globalCalls: 0,
                  totalCalls: state.empty ? 0 : state.known + state.unknown,
                  knownCalls: state.known,
                  totalTokens: state.tokens,
                  unknownCalls: state.unknown,
                  failedCalls: 1,
                  cancelledCalls: 0,
                  pendingCalls: 0,
                  interruptedCalls: 0,
                  promptTokens: 0,
                  completionTokens: 0,
                  promptUnknownCalls: state.promptUnknown ?? state.unknown,
                  completionUnknownCalls: state.completionUnknown ?? state.unknown,
                  byPersona: [],
                  byScope: [],
                  byModel: [],
                  byDay: [],
                  byHour: [],
                  byFeature: Array.from({ length: state.featureCount }, (_, index) => ({
                    feature: index === 0 ? state.feature : `fixture-${index}`,
                    calls: state.known + state.unknown,
                    tokens: state.tokens,
                    unknownCalls: state.unknown,
                  })),
                },
          };
        },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.error = false;
  state.empty = false;
  state.feature = 'intent-analysis';
  state.featureCount = 1;
  state.refetch.mockClear();
});
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(UsagePanel)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

it('真实零输入与未知输出分别显示，不把缺失输出显示成 0', () => {
  state.known = 1;
  state.tokens = 0;
  state.unknown = 0;
  state.promptUnknown = 0;
  state.completionUnknown = 1;
  const host = fixture();
  expect(host.querySelector('.weq-usage-io')?.textContent).toContain('输入0');
  expect(host.querySelector('.weq-usage-io')?.textContent).toContain('输出未知');
  state.promptUnknown = undefined;
  state.completionUnknown = undefined;
});

it('只有未知用量时不显示累计或平均 0 Token，按功能显示未知次数', () => {
  state.known = 0;
  state.tokens = 0;
  state.unknown = 1;
  const host = fixture();
  const kpis = host.querySelectorAll('.weq-usage-summary dd');
  expect(kpis[0].textContent).toBe('未知');
  expect(host.textContent).not.toContain('克隆体数量');
  expect([...host.querySelectorAll('tbody th, tbody td')].map((cell) => cell.textContent)).toEqual([
    '意图感知',
    '1',
    '未知',
    '1',
  ]);
});

it('部分请求有 usage 时展示已知量与覆盖次数，记录保留范围可见', () => {
  state.known = 1;
  state.tokens = 12;
  state.unknown = 1;
  const host = fixture();
  expect(host.querySelectorAll('.weq-usage-summary dd')[0].textContent).toBe('12');
  expect(host.textContent).toContain('1 / 2');
  expect(host.textContent).toContain('5000');
  expect(host.textContent).toContain('已达保留上限');
});

it('查询失败独立显示错误与重试，不显示首次使用空状态', () => {
  state.error = true;
  const host = fixture();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('读取失败');
  expect(host.textContent).not.toContain('所选时段暂无 API 请求');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="重试读取用量"]')!.click());
  expect(state.refetch).toHaveBeenCalledOnce();
});

it('能力检测显示中文名称，切换范围提交真实查询参数', () => {
  state.feature = 'capability-test';
  const host = fixture();
  expect(host.querySelector('tbody th')?.textContent).toBe('模型能力检测');
  act(() => host.querySelector<HTMLInputElement>('input[value="24h"]')!.click());
  expect(state.queryInput).toEqual({ period: '24h' });
});

it('空记录保留时间选择，不显示常驻刷新或引导用户构建克隆', () => {
  state.empty = true;
  const host = fixture();
  expect(host.textContent).toContain('所选时段暂无 API 请求');
  expect(host.textContent).not.toContain('构建克隆或');
  expect(host.querySelectorAll('input[type="radio"]').length).toBe(4);
  expect(host.querySelector('[aria-label="刷新用量"]')).toBeNull();
  expect(host.querySelector('[aria-label="重试读取用量"]')).toBeNull();
});

it('本地账本在离线时仍可读取，不依赖网络在线标记', () => {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  fixture();
  expect(state.queryOptions?.enabled).toBe(true);
});

it('大量细分功能分页展示，不在轮询时一次渲染全部记录', () => {
  state.featureCount = 65;
  const host = fixture();
  expect(host.querySelectorAll('tbody tr')).toHaveLength(50);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="功能用量下一页"]')!.click());
  expect(host.querySelectorAll('tbody tr')).toHaveLength(15);
  expect(host.textContent).toContain('51–65 / 65');
});
