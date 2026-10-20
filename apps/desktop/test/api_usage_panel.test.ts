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
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAgentLabTokenStats: {
        useQuery: () => ({
          data: {
            totalCalls: state.known + state.unknown,
            knownCalls: state.known,
            totalTokens: state.tokens,
            unknownCalls: state.unknown,
            failedCalls: 1,
            cancelledCalls: 0,
            pendingCalls: 0,
            promptTokens: 0,
            completionTokens: 0,
            promptUnknownCalls: state.promptUnknown,
            completionUnknownCalls: state.completionUnknown,
            byPersona: [],
            byScope: [],
            byModel: [],
            byDay: [],
            byHour: [],
            byFeature: [
              {
                feature: 'intent-analysis',
                calls: state.known + state.unknown,
                tokens: state.tokens,
                unknownCalls: state.unknown,
              },
            ],
          },
        }),
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(h(UsagePanel, { resolveName: () => '', hasPersona: () => false, personaCount: 0 })),
  );
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
  expect(host.querySelector('.weq-usage-split-legend')?.textContent).toContain('输入 0');
  expect(host.querySelector('.weq-usage-split-legend')?.textContent).toContain('输出 未知');
  state.promptUnknown = undefined;
  state.completionUnknown = undefined;
});

it('只有未知用量时不显示累计或平均 0 Token，按功能显示未知次数', () => {
  state.known = 0;
  state.tokens = 0;
  state.unknown = 1;
  const host = fixture();
  const kpis = host.querySelectorAll('.weq-usage-kpi strong');
  expect(kpis[0].textContent).toBe('未知');
  expect(kpis[3].textContent).toBe('未知');
  expect([...host.querySelectorAll('tbody th, tbody td')].map((cell) => cell.textContent)).toEqual([
    '意图分析',
    '1',
    '未知',
    '1',
  ]);
});

it('部分请求有 usage 时平均只使用已知请求，不被未知请求摊薄', () => {
  state.known = 1;
  state.tokens = 12;
  state.unknown = 1;
  const host = fixture();
  expect(host.querySelectorAll('.weq-usage-kpi strong')[3].textContent).toBe('12');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('用量未知 1 次');
});
