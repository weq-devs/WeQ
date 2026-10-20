import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QzoneView } from '../src/renderer/src/views/QzoneView';
import { useViewState } from '../src/renderer/src/state/view';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  refreshWait: null as Promise<void> | null,
  write: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  summary: vi.fn(async (_input: unknown) => ({
    likes: {
      likes: [] as { uin: string; nickname: string }[],
      reportedTotal: 4,
      reportedViewCount: 8,
      coverage: 'complete',
    },
    commentCount: 2,
  })),
  interactions: vi.fn(async (_input: unknown) => ({
    comments: [],
    likes: [],
    commentCountInclusive: 2,
    fieldCoverage: { comments: 'observed' },
  })),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
    ) => {
      const configId = state.configId;
      try {
        await action({ expectedAccountUin: '10001', expectedAccountConfigId: configId });
        if (configId !== state.configId) return false;
        await refresh?.();
        await state.refreshWait;
        return true;
      } catch {
        return false;
      }
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.configId } }) },
    },
  },
  client: {
    account: {
      qqActions: { qzone: { mutate: state.write } },
      qzone: {
        posts: {
          query: async () => ({
            total: 1,
            nickname: '合成空间',
            list: [
              {
                tid: 'post-a',
                content: '合成说说',
                time: 1,
                images: [],
                videos: [],
                isPrivate: false,
                commentNum: 2,
              },
            ],
          }),
        },
        stats: { query: async () => ({ postCount: 1, photoCount: 0 }) },
        people: { query: async () => ({}) },
        summary: { query: state.summary },
        interactions: { query: state.interactions },
        cancel: { mutate: async () => {} },
      },
    },
  },
}));
let close: (() => void) | undefined;
beforeEach(() => {
  useViewState.setState({ openedUin: '10001' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  state.configId = 'source-a';
  state.refreshWait = null;
  state.write.mockReset().mockResolvedValue({ state: 'accepted' });
  state.summary.mockReset().mockImplementation(async () => ({
    likes: { likes: [], reportedTotal: 4, reportedViewCount: 8, coverage: 'complete' },
    commentCount: 2,
  }));
  state.interactions.mockClear();
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () =>
    root.render(
      h(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
        spaceRequest: { accountUin: '10001', uin: '10001', revision: 'fixture' },
      }),
    );
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () => update());
  await act(async () => {
    await vi.waitFor(() => expect(state.summary).toHaveBeenCalled());
  });
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const count = () => host.querySelector('.weq-qzn-actions')!.textContent;
  return { host, button, count, update: () => act(() => update()) };
}
function enter(host: HTMLElement, content: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, content);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function capture(host: HTMLElement) {
  const directory = process.env.WEQ_QZONE_FEEDBACK_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const post = host.querySelector('.weq-qzn-post')!;
  const styles = ['index', 'qzone', 'qq-actions', 'qq-write']
    .map(
      (name) =>
        `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', `${name}.css`)}">`,
    )
    .join('');
  writeFileSync(
    resolve(directory, 'qzone-feedback.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}.qa-post{padding:16px;max-width:700px}</style><body><main class="weq-qzn"><section class="qa-post">${post.outerHTML}</section></main></body></html>`,
  );
}
it('点赞立即高亮并更新数量，受理后即使远端仍为原值也重新校准', async () => {
  const view = await mount();
  const pending = deferred<QQWriteOutcome>();
  state.write.mockReturnValueOnce(pending.promise);
  act(() => view.button('点赞说说').click());
  expect(view.button('取消说说点赞').disabled).toBe(true);
  expect(view.count()).toContain('赞 5');
  await act(async () => pending.resolve({ state: 'accepted' }));
  await act(async () => {
    await vi.waitFor(() => expect(state.summary).toHaveBeenCalledTimes(2));
  });
  expect(view.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
  expect(view.count()).toContain('赞 4');
});
it.each(['rejected', 'unconfirmed', 'unchanged'] as const)(
  '%s 恢复点击前高亮和数量',
  async (outcome) => {
    const view = await mount();
    const pending = deferred<QQWriteOutcome>();
    state.write.mockReturnValueOnce(pending.promise);
    act(() => view.button('点赞说说').click());
    expect(view.count()).toContain('赞 5');
    await act(async () => {
      if (outcome === 'rejected') pending.reject(new Error('合成网络失败'));
      else pending.resolve({ state: outcome });
    });
    expect(view.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
    expect(view.count()).toContain('赞 4');
  },
);
it('写入受理但校准失败保留即时结果，提供只读重试而不重发写入', async () => {
  const view = await mount();
  state.summary.mockRejectedValueOnce(new Error('合成读取失败'));
  await act(async () => view.button('点赞说说').click());
  expect(view.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
  expect(view.count()).toContain('赞 5');
  expect(view.host.querySelector('[role="status"]')?.textContent).toContain('暂未校准');
  capture(view.host);
  await act(async () => view.button('重试互动数据校准').click());
  expect(state.write).toHaveBeenCalledOnce();
  expect(view.count()).toContain('赞 4');
});
it('评论未确认保留草稿，受理后不关闭互动区并刷新评论，校准前保留新草稿', async () => {
  const view = await mount();
  const commentButton = [
    ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-actions button'),
  ].find((button) => button.title === '评论')!;
  await act(async () => commentButton.click());
  const interaction = view.host.querySelector('.weq-qzn-interaction');
  enter(view.host, '原评论草稿');
  state.write.mockResolvedValueOnce({ state: 'unconfirmed' });
  await act(async () => view.button('发送说说评论').click());
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!.value).toBe(
    '原评论草稿',
  );
  const pending = deferred<QQWriteOutcome>();
  const summary = deferred<Awaited<ReturnType<typeof state.summary>>>();
  state.write.mockReturnValueOnce(pending.promise);
  state.summary.mockReturnValueOnce(summary.promise);
  const reads = state.interactions.mock.calls.length;
  act(() => view.button('发送说说评论').click());
  expect(view.host.querySelector('[aria-label="正在发送评论"]')).not.toBeNull();
  expect(view.button('发送说说评论').disabled).toBe(true);
  act(() => view.button('发送说说评论').click());
  expect(state.write).toHaveBeenCalledTimes(2);
  enter(view.host, '下一条草稿');
  await act(async () => pending.resolve({ state: 'accepted' }));
  expect(view.count()).toContain('评论 3');
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!.value).toBe(
    '下一条草稿',
  );
  expect(view.host.querySelector('.weq-qzn-interaction')).toBe(interaction);
  expect(state.interactions.mock.calls.length).toBeGreaterThan(reads);
  await act(async () =>
    summary.resolve({
      likes: { likes: [], reportedTotal: 4, reportedViewCount: 8, coverage: 'complete' },
      commentCount: 6,
    }),
  );
  expect(view.count()).toContain('评论 6');
});
it('连续操作期间校准失败，数量以当前即时状态为基准，失败恢复上一笔结果', async () => {
  const view = await mount();
  state.summary.mockRejectedValue(new Error('合成读取失败'));
  await act(async () => view.button('点赞说说').click());
  expect(view.count()).toContain('赞 5');
  const pending = deferred<QQWriteOutcome>();
  state.write.mockReturnValueOnce(pending.promise);
  act(() => view.button('取消说说点赞').click());
  expect(view.count()).toContain('赞 4');
  await act(async () => pending.reject(new Error('合成取消失败')));
  expect(view.count()).toContain('赞 5');
  expect(view.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
});
it('写入期间旧摘要迟到不会盖掉即时状态，完成后使用新摘要校准', async () => {
  const old = deferred<Awaited<ReturnType<typeof state.summary>>>();
  state.summary.mockReturnValueOnce(old.promise);
  const view = await mount();
  const pending = deferred<QQWriteOutcome>();
  state.write.mockReturnValueOnce(pending.promise);
  act(() => view.button('点赞说说').click());
  await act(async () =>
    old.resolve({
      likes: { likes: [], reportedTotal: 4, reportedViewCount: 8, coverage: 'complete' },
      commentCount: 2,
    }),
  );
  expect(view.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
  expect(view.count()).not.toContain('赞 4');
  state.summary.mockResolvedValueOnce({
    likes: {
      likes: [{ uin: '10001', nickname: '合成自己' }],
      reportedTotal: 5,
      reportedViewCount: 8,
      coverage: 'complete',
    },
    commentCount: 2,
  });
  await act(async () => pending.resolve({ state: 'accepted' }));
  expect(view.count()).toContain('赞 5');
  expect(view.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
});
it('同号切源清除旧乐观结果，迟到写入不更新新来源', async () => {
  const view = await mount();
  const pending = deferred<QQWriteOutcome>();
  state.write.mockReturnValueOnce(pending.promise);
  act(() => view.button('点赞说说').click());
  expect(view.count()).toContain('赞 5');
  state.configId = 'source-b';
  await act(async () => view.update());
  expect(view.count()).toContain('赞 4');
  expect(view.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
  await act(async () => pending.resolve({ state: 'accepted' }));
  expect(view.count()).toContain('赞 4');
  expect(view.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
});
it('公共会话尚在刷新其他缓存时收到校准，结束后仍应用远端同值结果', async () => {
  const view = await mount();
  const wait = deferred<void>();
  state.refreshWait = wait.promise;
  await act(async () => view.button('点赞说说').click());
  expect(view.button('取消说说点赞').getAttribute('aria-busy')).toBe('true');
  expect(state.summary).toHaveBeenCalledTimes(2);
  await act(async () => wait.resolve());
  expect(view.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
});
it('发送途中重新编辑为相同文字也视为下一份草稿，不被回执清空', async () => {
  const view = await mount();
  enter(view.host, '相同文字');
  const pending = deferred<QQWriteOutcome>();
  state.write.mockReturnValueOnce(pending.promise);
  act(() => view.button('发送说说评论').click());
  enter(view.host, '下一条');
  enter(view.host, '相同文字');
  await act(async () => pending.resolve({ state: 'accepted' }));
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!.value).toBe(
    '相同文字',
  );
});
