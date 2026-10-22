import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { runMessageLoadTask } from '../src/renderer/src/components/MessageLoadTask';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

afterEach(() => {
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.unstubAllGlobals();
});

it.each(['停止按钮', '外部取消'] as const)(
  '%s 不等待在途查询返回，迟到结果不能覆盖停止状态',
  async (source) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const outer = new AbortController();
    let release!: () => void;
    let signal!: AbortSignal;
    const settled = vi.fn();
    let task!: Promise<unknown>;
    try {
      act(() => {
        root.render(createElement(ToastHost));
        task = runMessageLoadTask(
          '加载范围消息',
          async (_report, current) => {
            signal = current;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return '迟到结果';
          },
          outer.signal,
        ).catch(settled);
      });
      await act(async () => {
        if (source === '停止按钮')
          host.querySelector<HTMLButtonElement>('[aria-label="停止消息加载"]')!.click();
        else outer.abort();
      });
      expect(signal.aborted).toBe(true);
      expect(settled).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith(signal.reason);
      expect(host.textContent).toContain('已停止 · 已加载 0 条消息');
      expect(host.querySelector('[aria-label="停止消息加载"]')).toBeNull();
      await act(async () => release());
      await task;
      expect(host.textContent).toContain('已停止 · 已加载 0 条消息');
      expect(host.textContent).not.toContain('加载范围消息完成');
    } finally {
      await act(async () => release());
      await task;
      act(() => root.unmount());
      host.remove();
    }
  },
);
