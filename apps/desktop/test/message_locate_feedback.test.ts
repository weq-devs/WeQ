import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageLocateFeedback } from '../src/renderer/src/hooks/useMessageLocateFeedback';
import { useToast } from '../src/renderer/src/components/Toast.shared';

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
    return feedback.locating ? h('span', { role: 'status' }, '正在加载目标消息') : null;
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

it('读取期间在会话内显示加载状态，读取及定位完成才收起', async () => {
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
  expect(useToast.getState().toasts).toEqual([]);
  await act(async () => query.resolve());
  expect(f.host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => {
    positioning.resolve();
    await task;
  });
  expect(f.host.querySelector('[role="status"]')).toBeNull();
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
  expect(f.host.querySelector('[role="status"]')).toBeNull();
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
  await act(async () => {
    first.resolve();
    await a;
  });
  expect(positioned).not.toHaveBeenCalled();
  expect(f.host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => {
    second.resolve();
    await b;
  });
  expect(f.host.querySelector('[role="status"]')).toBeNull();
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
  expect(f.host.querySelector('[role="status"]')).toBeNull();
  await act(async () => {
    query.resolve();
    await task;
  });
  expect(positioned).not.toHaveBeenCalled();
});

it('已加载消息的立即定位可以取消旧加载，不显示多余提示', async () => {
  const f = mount();
  expect(f.host.querySelector('[role="status"]')).toBeNull();
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
  expect(f.host.querySelector('[role="status"]')).toBeNull();
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
  expect(f.host.querySelector('[role="status"]')).toBeNull();
  await act(async () => {
    query.resolve();
    await task;
  });
  expect(positioned).not.toHaveBeenCalled();
});
