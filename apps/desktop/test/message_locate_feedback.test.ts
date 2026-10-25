import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageLocateFeedback } from '../src/renderer/src/hooks/useMessageLocateFeedback';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useToast.setState({ toasts: [], leaving: [] });
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let feedback!: ReturnType<typeof useMessageLocateFeedback>;
  function Harness({ scope }: { scope: string }) {
    feedback = useMessageLocateFeedback(scope);
    return h(ToastHost);
  }
  const render = (scope: string) => act(() => root.render(h(Harness, { scope })));
  render('account:group-a');
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    run: (work: (isCurrent: () => boolean) => Promise<void>) => feedback.run(work),
    cancel: () => feedback.cancel(),
    render,
  };
}

it('读取期间持续显示加载横幅，读取及定位完成才收起', async () => {
  const f = mount();
  const query = deferred(),
    positioning = deferred();
  let task!: Promise<void>;
  act(() => {
    task = f.run(async () => {
      await query.promise;
      await positioning.promise;
    });
  });
  expect(f.host.textContent).toContain('正在加载目标消息');
  expect(f.host.querySelector('[aria-label="加载中"]')).not.toBeNull();
  expect(useToast.getState().toasts[0]).toMatchObject({
    loading: true,
    dismissible: false,
    ttl: 0,
  });
  await act(async () => query.resolve());
  expect(useToast.getState().toasts).toHaveLength(1);
  await act(async () => {
    positioning.resolve();
    await task;
  });
  expect(useToast.getState().toasts).toHaveLength(0);
});

it('读取失败时清除加载状态，不吞掉错误', async () => {
  const f = mount();
  const query = deferred();
  let task!: Promise<void>;
  act(() => {
    task = f.run(() => query.promise);
  });
  const result = expect(task).rejects.toThrow('synthetic failure');
  await act(async () => {
    query.reject(new Error('synthetic failure'));
    await result;
  });
  expect(useToast.getState().toasts).toHaveLength(0);
});

it('连续定位只保留最新提示，旧任务完成不能清除新提示或继续定位', async () => {
  const f = mount();
  const first = deferred(),
    second = deferred();
  const positioned = vi.fn();
  let a!: Promise<void>, b!: Promise<void>;
  act(() => {
    a = f.run(async (current) => {
      await first.promise;
      if (current()) positioned();
    });
  });
  act(() => {
    b = f.run(() => second.promise);
  });
  const id = useToast.getState().toasts[0]!.id;
  await act(async () => {
    first.resolve();
    await a;
  });
  expect(positioned).not.toHaveBeenCalled();
  expect(useToast.getState().toasts.map((toast) => toast.id)).toEqual([id]);
  await act(async () => {
    second.resolve();
    await b;
  });
  expect(useToast.getState().toasts).toHaveLength(0);
});

it('切换会话立即清除提示，迟到结果不能继续定位', async () => {
  const f = mount();
  const query = deferred();
  const positioned = vi.fn();
  let task!: Promise<void>;
  act(() => {
    task = f.run(async (current) => {
      await query.promise;
      if (current()) positioned();
    });
  });
  f.render('account:group-b');
  expect(useToast.getState().toasts).toHaveLength(0);
  await act(async () => {
    query.resolve();
    await task;
  });
  expect(positioned).not.toHaveBeenCalled();
});

it('已加载消息的立即定位可以取消旧加载，不显示多余提示', async () => {
  const f = mount();
  expect(useToast.getState().toasts).toHaveLength(0);
  const query = deferred();
  const positioned = vi.fn();
  let task!: Promise<void>;
  act(() => {
    task = f.run(async (current) => {
      await query.promise;
      if (current()) positioned();
    });
  });
  act(() => f.cancel());
  expect(useToast.getState().toasts).toHaveLength(0);
  await act(async () => {
    query.resolve();
    await task;
  });
  expect(positioned).not.toHaveBeenCalled();
});

it('退出消息页后清除提示，未完成请求不再触发定位', async () => {
  const f = mount();
  const query = deferred();
  const positioned = vi.fn();
  let task!: Promise<void>;
  act(() => {
    task = f.run(async (current) => {
      await query.promise;
      if (current()) positioned();
    });
  });
  cleanups.pop()!();
  expect(useToast.getState().toasts).toHaveLength(0);
  await act(async () => {
    query.resolve();
    await task;
  });
  expect(positioned).not.toHaveBeenCalled();
});
