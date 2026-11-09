import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CalendarTaskLog } from '../src/renderer/src/components/CalendarTaskLog';
const query = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    backgroundTasks: {
      logs: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          query.enabled = options.enabled;
          return {
            data: [{ ts: 0, seq: 1, stage: 'task', level: 'info', text: '已计 256 条消息' }],
            error: null,
          };
        },
      },
    },
  },
}));

it('日志在任务内部展开，收起时不请求日志', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(createElement(CalendarTaskLog, { id: 'fixture', scope: null, updatedAt: 0 })),
    );
    const button = host.querySelector('button')!;
    expect(button.className).toBe('weq-exp-detail-tasklog-head');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(query.enabled).toBe(false);
    expect(host.querySelector('.weq-exp-log')).toBeNull();
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(query.enabled).toBe(true);
    expect(host.textContent).toContain('已计 256 条消息');
    act(() => button.click());
    expect(query.enabled).toBe(false);
    expect(host.querySelector('.weq-exp-log')).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
