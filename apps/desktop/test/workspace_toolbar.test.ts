import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

describe('全局工具条范围', () => {
  it('仅保留全局工具并加入消息补全，不混入数据库或缓存维护', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const analysis = vi.fn();
    try {
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: analysis })));
      act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        '导出',
        '任务',
        '消息补全',
        '分析与报告',
        'WeQ 助手',
      ]);
      act(() => buttons[3]!.click());
      expect(analysis).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
