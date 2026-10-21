import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SequentialForwardDialog } from '../src/renderer/src/components/SequentialForwardDialog';
import { startSequentialForward } from '../src/renderer/src/components/SequentialForwardTask';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import { DEFAULT_FORWARD_OPTIONS } from '../src/renderer/src/lib/sequentialForward';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery' ? () => ({ data: undefined, isLoading: false }) : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const target = {
  id: 'qa-group',
  kind: 'group' as const,
  conv: '777',
  name: '合成目标群',
  avatarUrl: null,
};
const demo = createTemplateDemoData();
const messages = [
  {
    ...demo.messages[0]!,
    id: 'text',
    body: '甲乙',
    qqElements: [{ type: 'text', data: { textContent: '甲乙' } }],
  },
  {
    ...demo.messages[0]!,
    id: 'media',
    body: '这部分文本不参与计时',
    qqElements: [
      { type: 'text', data: { textContent: '这部分文本不参与计时' } },
      { type: 'pic', data: {} },
    ],
  },
];

it('先展示预估，发送后卸载弹窗仍继续转发，横幅常驻并可打开已发送的目标', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_message: unknown, _target: unknown, _signal: AbortSignal) => {});
  const open = vi.fn();
  const close = vi.fn();
  function App() {
    const [visible, setVisible] = useState(true);
    return createElement(
      'div',
      null,
      visible
        ? createElement(SequentialForwardDialog, {
            messages,
            targets: [target],
            onSend: send,
            onOpenTarget: open,
            onClose: () => {
              close();
              setVisible(false);
            },
          })
        : null,
      createElement(ToastHost),
    );
  }
  try {
    act(() => root.render(createElement(App)));
    act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    const mode = document.querySelector<HTMLSelectElement>('.weq-forward-options select')!;
    act(() => {
      mode.value = 'text';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const labels = [...document.querySelectorAll('label')];
    expect(
      labels.find((label) => label.textContent?.includes('每字'))?.querySelector('input')?.value,
    ).toBe('1000');
    expect(
      labels.find((label) => label.textContent?.includes('非文本'))?.querySelector('input')?.value,
    ).toBe('5000');
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain('7 秒');
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')!.click(),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.weq-sequential-forward')).toBeNull();
    expect(document.querySelector('.weq-forward-banner')).not.toBeNull();
    expect(document.querySelector('.weq-toast button[aria-label="关闭"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[2].aborted).toBe(false);
    expect(document.querySelector('.weq-forward-banner')?.textContent).toContain('转发完成');
    expect(document.querySelector('.weq-toast button[aria-label="关闭"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(document.querySelector('.weq-toast')).not.toBeNull();
    expect(document.querySelector('.weq-toast-footer')).toBeNull();
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-forward-banner-targets button')!.click(),
    );
    expect(open).toHaveBeenCalledWith(target);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('等待期间可以停止，不再发送下一条；失败只列出实际收到成功回执的对话', async () => {
  const send = vi.fn(async () => {});
  const pending = startSequentialForward({
    messages,
    targets: [target],
    options: { ...DEFAULT_FORWARD_OPTIONS, mode: 'text' },
    onSend: send,
    onOpenTarget: vi.fn(),
  });
  pending.controller.abort();
  await pending.done;
  expect(send).not.toHaveBeenCalled();
  const failed = startSequentialForward({
    messages,
    targets: [target],
    options: DEFAULT_FORWARD_OPTIONS,
    onSend: async () => {
      throw new Error('合成失败');
    },
    onOpenTarget: vi.fn(),
  });
  await failed.done;
  expect(useToast.getState().toasts.at(-1)?.tone).toBe('warning');
  expect(useToast.getState().toasts.at(-1)?.detail).toBe('合成失败');
});
