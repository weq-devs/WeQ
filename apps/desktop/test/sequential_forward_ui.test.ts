import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SequentialForwardDialog } from '../src/renderer/src/components/SequentialForwardDialog';
import { startSequentialForward } from '../src/renderer/src/components/SequentialForwardTask';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import { DEFAULT_FORWARD_OPTIONS } from '../src/renderer/src/lib/sequentialForward';
import { MergeForwardTargets } from '../src/renderer/src/components/mergeForward/MergeForwardTargets';
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

it('多个目标并行发送且群内保序，一个目标失败不会阻塞其他目标', async () => {
  const second = { ...target, id: 'second', conv: '888', name: '第二目标群' };
  let release: (() => void) | undefined;
  const events: string[] = [];
  const task = startSequentialForward({
    messages,
    targets: [target, second],
    options: DEFAULT_FORWARD_OPTIONS,
    onSend: async (message, destination) => {
      events.push(`${destination.id}:${message.id}`);
      if (destination.id === target.id && message.id === 'text')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (destination.id === second.id && message.id === 'text') throw new Error('第二群拒绝');
    },
    onOpenTarget: vi.fn(),
  });
  try {
    await vi.waitFor(() => expect(events).toContain('second:media'));
    expect(events).toContain('second:text');
    expect(events).not.toContain('qa-group:media');
    expect(useToast.getState().toasts).toHaveLength(2);
  } finally {
    release?.();
    await task.done;
  }
  expect(events).toEqual(['qa-group:text', 'second:text', 'second:media', 'qa-group:media']);
  expect(useToast.getState().toasts.map((toast) => toast.tone)).toEqual(['success', 'warning']);
});

it('不可等价发送的整条消息在发送前确认并可预览，取消不会发出任何消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_message: unknown) => {});
  const ignored = {
    ...messages[0]!,
    id: 'poke',
    body: '甲戳了戳乙',
    qqElements: [
      {
        type: 'grayTipPoke',
        data: { tipJson: JSON.stringify({ items: [{ type: 'nor', txt: '甲戳了戳乙' }] }) },
      },
    ],
  };
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: [messages[0]!, ignored],
          targets: [target],
          onSend: send,
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')!.click(),
    );
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('.weq-forward-ignored')?.textContent).toContain('甲戳了戳乙');
    expect(document.querySelector('.weq-forward-ignored')?.textContent).toContain('grayTipPoke');
    expect(
      document.querySelector('.weq-forward-ignored .weq-private-preview-scroll'),
    ).not.toBeNull();
    expect(document.querySelector('.weq-forward-ignored .weq-preview-system-row')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="返回转发设置"]')!.click());
    expect(send).not.toHaveBeenCalled();
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')!.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-forward-confirm-ignore]')!.click(),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toEqual(messages[0]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('未选目标就显示时分秒预估，多个并行目标不增加预估，默认不限间隔且失败继续', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: [
            { ...messages[0]!, createdAt: '2026-10-21T01:00:00Z' },
            { ...messages[0]!, id: 'later', createdAt: '2026-10-21T02:01:01Z' },
          ],
          targets: [target, { ...target, id: 'second', conv: '888', name: '第二群' }],
          onSend: vi.fn(),
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain('预计用时 0 秒');
    const mode = document.querySelector<HTMLSelectElement>('.weq-forward-options select')!;
    act(() => {
      mode.value = 'original';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain(
      '1 小时 1 分 1 秒',
    );
    const labels = [...document.querySelectorAll('label')];
    expect(
      labels.find((label) => label.textContent?.includes('最大间隔'))?.querySelector('input')
        ?.value,
    ).toBe('-1');
    expect(
      labels.find((label) => label.textContent?.includes('失败后'))?.querySelector('select')?.value,
    ).toBe('skip');
    expect(document.querySelector('.weq-forward-options')?.textContent).not.toContain('毫秒');
    act(() =>
      document.querySelectorAll<HTMLButtonElement>('.weq-mf-target').forEach((button) => {
        button.click();
      }),
    );
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain(
      '1 小时 1 分 1 秒',
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('全部消息均需跳过时仍可预览，但不能创建发送队列', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: [{ ...messages[0]!, qqElements: [{ type: 'call', data: {} }] }],
          targets: [target],
          onSend: send,
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    expect(
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')?.disabled,
    ).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('.weq-forward-ignored-summary')!.click());
    expect(document.querySelector('.weq-private-preview-scroll')).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[data-forward-confirm-ignore]')?.disabled,
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(useToast.getState().toasts).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('只停止一个目标，不跳转也不停止其他群；所有队列结束清理计时器', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const second = { ...target, id: 'second', conv: '888', name: '第二群' };
  const send = vi.fn(async (_message: unknown, _target: unknown, _signal: AbortSignal) => {});
  const open = vi.fn();
  let task: ReturnType<typeof startSequentialForward> | undefined;
  try {
    await act(async () => {
      root.render(createElement(ToastHost));
      task = startSequentialForward({
        messages,
        targets: [target, second],
        options: { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 1000 },
        onSend: send,
        onOpenTarget: open,
      });
    });
    act(() =>
      document.querySelector<HTMLButtonElement>('[data-forward-target="qa-group"] button')!.click(),
    );
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await task!.done;
    });
    expect(send.mock.calls.map(([, destination]) => (destination as typeof target).id)).toEqual([
      'qa-group',
      'second',
      'second',
    ]);
    expect(task!.controller.signal.aborted).toBe(false);
    expect(document.querySelector('[data-forward-target="qa-group"]')?.textContent).toContain(
      '转发已停止',
    );
    expect(document.querySelector('[data-forward-target="second"]')?.textContent).toContain(
      '转发完成',
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    task?.controller.abort();
    await task?.done;
    act(() => root.unmount());
    host.remove();
  }
});

it('转发目标的群助手独立入口保留内外已选群', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const inside = { ...target, id: 'inside', name: '助手内群', groupAssistant: true };
  function View() {
    const [selected, onChange] = useState(new Set<string>());
    return createElement(
      'div',
      null,
      createElement(MergeForwardTargets, { targets: [target, inside], selected, onChange }),
      createElement('output', null, [...selected].join(',')),
    );
  }
  try {
    act(() => root.render(createElement(View)));
    expect(host.querySelectorAll('.weq-mf-target.checked')).toHaveLength(0);
    act(() =>
      host.querySelector<HTMLButtonElement>('.weq-mf-target:not(.weq-mf-assistant-entry)')!.click(),
    );
    act(() => host.querySelector<HTMLButtonElement>('.weq-mf-assistant-entry')!.click());
    act(() => host.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    expect(host.querySelector('output')!.textContent).toBe('qa-group,inside');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回全部会话"]')!.click());
    expect(host.querySelector('output')!.textContent).toBe('qa-group,inside');
    expect(host.querySelector('.weq-mf-target.checked')?.textContent).toContain('合成目标群');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('单条转发隐藏间隔与抖动，保留失败策略和重试设置', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: messages.slice(0, 1),
          targets: [target],
          onSend: vi.fn(),
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector('.weq-forward-options')?.textContent).not.toMatch(/间隔|抖动/);
    expect(document.querySelector('.weq-forward-options')?.textContent).toContain('最大尝试次数');
    expect(document.querySelector('.weq-forward-options')?.textContent).toContain('失败后');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('先展示预估，卸载配置窗仍转发，等待与完成时均可点击横幅跳转', async () => {
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
    ).toBe('1');
    expect(
      labels.find((label) => label.textContent?.includes('非文本'))?.querySelector('input')?.value,
    ).toBe('5');
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain('7 秒');
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')!.click(),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.weq-sequential-forward')).toBeNull();
    expect(document.querySelector('.weq-forward-banner')).not.toBeNull();
    expect(document.querySelector('.weq-forward-time')?.textContent).toContain(
      '已进行 0 秒 / 预计用时 7 秒',
    );
    expect(document.querySelector('.weq-forward-count')?.textContent).toContain('0 / 2 条');
    act(() => document.querySelector<HTMLButtonElement>('.weq-toast-open')!.click());
    expect(open).toHaveBeenCalledWith(target);
    expect(document.querySelector('.weq-toast button[aria-label="关闭"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.weq-forward-time')?.textContent).toContain('已进行 2 秒');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[2].aborted).toBe(false);
    expect(document.querySelector('.weq-forward-banner')?.textContent).toContain('转发完成');
    expect(document.querySelector('.weq-forward-time')?.textContent).toContain('已进行 7 秒');
    expect(document.querySelector('.weq-forward-count')?.textContent).toContain('2 / 2 条');
    expect(document.querySelector('.weq-toast button[aria-label="关闭"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(document.querySelector('.weq-toast')).not.toBeNull();
    expect(document.querySelector('.weq-toast-footer')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('.weq-toast-open')!.click());
    expect(open).toHaveBeenCalledWith(target);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('等待期间可以停止，不再发送下一条；失败保留原因且不冒称成功', async () => {
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
  expect(useToast.getState().toasts.at(-1)?.detail).toContain('合成失败');
});
