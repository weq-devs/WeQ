import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QzoneView } from '../src/renderer/src/views/QzoneView';
import { useViewState } from '../src/renderer/src/state/view';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';
import type { QzoneInteraction } from '../src/renderer/src/views/qzone_types';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  refreshWait: null as Promise<void> | null,
  readback: undefined as (() => Promise<boolean>) | undefined,
  autoReadback: false,
  write: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  forward: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  pickImage: vi.fn(async () => ({ path: '/synthetic/image.png', fileName: '合成图片.png' })),
  nativeDetail: vi.fn(async (_input: unknown) => ({
    content: '合成原生正文',
    commentCount: 6,
    likeCount: 9,
    mediaTypes: [],
  })),
  detail: vi.fn(),
  posts: vi.fn(),
  forwards: vi.fn(),
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
    comments: [] as QzoneInteraction['comments'],
    likes: [],
    commentCountInclusive: 2,
    fieldCoverage: { comments: 'observed' },
  })),
  settings: vi.fn(async () => ({ qzoneForwardQuotePrevious: true })),
  related: vi.fn(),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: ({ size }: { size: number }) =>
    h('img', {
      src: `/@fs${resolve('../../resources/fileicon/image.png')}`,
      alt: '',
      width: size,
      height: size,
      style: { width: size, height: size },
    }),
}));
vi.mock('../src/renderer/src/lib/accountFilePicker', () => ({ pickAccountFile: state.pickImage }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      state.readback = options?.readback;
      const configId = state.configId;
      try {
        await action({ expectedAccountUin: '10001', expectedAccountConfigId: configId });
        if (configId !== state.configId) return false;
        if (state.autoReadback) await options?.readback?.();
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
    bootstrap: { getSettings: { query: state.settings } },
    account: {
      qqActions: { qzone: { mutate: state.write }, qzoneForward: { mutate: state.forward } },
      qzone: {
        related: { query: state.related },
        posts: {
          query: state.posts,
        },
        stats: { query: async () => ({ postCount: 1, photoCount: 0 }) },
        people: { query: async () => ({}) },
        summary: { query: state.summary },
        forwards: { query: state.forwards },
        interactions: { query: state.interactions },
        nativeDetail: { query: state.nativeDetail },
        detail: { query: state.detail },
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
  state.readback = undefined;
  state.autoReadback = false;
  state.write.mockReset().mockResolvedValue({ state: 'accepted' });
  state.forward.mockReset().mockResolvedValue({ state: 'accepted' });
  state.forwards.mockReset().mockResolvedValue({
    forwards: [0, 1, 2].map((index) => ({
      key: `forward-${index}`,
      uin: String(10002 + index),
      nickname: `合成转发者${index}`,
      content: `合成转发语${index}`,
      isFriend: true,
    })),
    reportedTotal: 3,
    rawCount: 3,
    hasMore: false,
    nextCursor: null,
    stopReason: 'complete',
  });
  state.pickImage.mockClear();
  state.nativeDetail.mockClear();
  state.detail.mockReset();
  state.posts.mockReset().mockResolvedValue({
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
        forwardNum: 37,
      },
    ],
  });
  state.summary.mockReset().mockImplementation(async () => ({
    likes: { likes: [], reportedTotal: 4, reportedViewCount: 8, coverage: 'complete' },
    commentCount: 2,
  }));
  state.interactions.mockReset().mockResolvedValue({
    comments: [],
    likes: [],
    commentCountInclusive: 2,
    fieldCoverage: { comments: 'observed' },
  });
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  let active = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () =>
    root.render(
      h(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active,
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
  return {
    host,
    button,
    count,
    update: () => act(() => update()),
    setActive: async (value: boolean) => {
      active = value;
      await act(async () => update());
    },
  };
}
it('空间隐藏页不读取，恢复时只更新一轮说说，不重发点赞或评论', async () => {
  const view = await mount();
  expect(state.posts).toHaveBeenCalledTimes(1);
  expect(view.host.querySelector('[aria-label="刷新空间"]')).toBeNull();
  await view.setActive(false);
  expect(state.posts).toHaveBeenCalledTimes(1);
  await view.setActive(true);
  expect(state.posts).toHaveBeenCalledTimes(2);
  expect(state.write).not.toHaveBeenCalled();
});
function enter(host: HTMLElement, content: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, content);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openComments(host: HTMLElement) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.weq-qzn-actions button')].find(
    (button) => button.title === '评论',
  )!;
  await act(async () => button.click());
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
function capture(host: HTMLElement, name = 'feedback') {
  const directory = process.env.WEQ_QZONE_FEEDBACK_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const post = host.querySelector('.weq-qzn-post, .weq-qzn-related-card')!;
  const styles = ['index', 'qzone', 'qq-actions', 'qq-write', 'qzone-actions', 'identity-links']
    .map(
      (name) =>
        `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', `${name}.css`)}">`,
    )
    .join('');
  writeFileSync(
    resolve(directory, `qzone-${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}.qa-post{padding:16px;max-width:700px}</style><body><main class="weq-qzn"><section class="qa-post">${post.outerHTML}</section></main>${document.querySelector('.weq-dialog-layer')?.outerHTML ?? ''}${document.querySelector('.weq-qzn-like-layer')?.outerHTML ?? ''}<script type="module">import {useThemeStore} from '/@fs${resolve('src/renderer/src/state/theme.ts')}';window.qaTheme=useThemeStore;</script></body></html>`,
  );
}
it.each(['短昵称', 'VeryLongNicknameWithoutAnySpaces'.repeat(4)])(
  '作者和原帖使用两列身份区，回复为同一文字行：%s',
  async (nickname) => {
    state.posts.mockResolvedValue({
      total: 1,
      list: [
        {
          tid: 'post-a',
          content: '合成说说',
          time: 1794000000,
          images: [],
          videos: [],
          commentNum: 2,
          isPrivate: false,
          repost: {
            tid: 'original',
            uin: '10002',
            nickname,
            content: '原帖正文',
            images: [],
            videos: [],
            timeLabel: '2026年11月04日',
          },
        },
      ],
    });
    state.interactions.mockResolvedValue({
      comments: [
        {
          id: '1',
          uin: '10002',
          nickname: '评论者',
          content: '一级评论',
          time: 1794000001,
          images: [],
          isReply: false,
        },
        {
          id: '2',
          parentCommentId: '1',
          replyId: '2',
          uin: '10003',
          nickname,
          content: '测试回复正文',
          replyToUin: '10002',
          replyToNickname: '评论者',
          time: 1794000002,
          images: [],
          isReply: true,
        },
      ],
      likes: [],
      commentCountInclusive: 2,
      fieldCoverage: { comments: 'observed' },
    });
    const view = await mount();
    await openComments(view.host);
    for (const header of view.host.querySelectorAll('.weq-qzn-person-header')) {
      expect(header.querySelectorAll('button')).toHaveLength(2);
      expect(header.querySelector('button time')).toBeNull();
    }
    const original = view.host.querySelector('.weq-qzn-repost')!;
    expect(original.querySelector('time')?.textContent).toBe('2026年11月04日');
    const reply = view.host.querySelector('.weq-qzn-comment.is-reply')!;
    expect(reply.querySelector(':scope > .weq-qzn-profile-avatar')).not.toBeNull();
    expect(reply.querySelector('.weq-qzn-comment-line')?.textContent).toBe(
      `${nickname} 回复 评论者：测试回复正文`,
    );
    capture(view.host, nickname === '短昵称' ? 'identity' : 'identity-long');
  },
);
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
  await openComments(view.host);
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

it('操作行只有一处点赞，悬停显示名单但不写入，评论框随展开显示', async () => {
  const view = await mount();
  expect(view.host.querySelector('[aria-label="说说评论"]')).toBeNull();
  expect(view.host.querySelectorAll('[aria-label="点赞说说"]')).toHaveLength(1);
  const hover = view.host.querySelector('.weq-qzn-like-hover')!;
  await act(async () => hover.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(document.querySelector('[aria-label="点赞列表"]')).not.toBeNull();
  capture(view.host, 'hover');
  expect(state.write).not.toHaveBeenCalled();
  await openComments(view.host);
  expect(view.host.querySelector('[aria-label="说说评论"]')).not.toBeNull();
  expect(view.count()).toContain('转发');
});

it('读取时已经点赞，直接呈现已赞样式，点击执行取消点赞', async () => {
  state.summary.mockResolvedValue({
    likes: {
      likes: [{ uin: '10001', nickname: '合成自己' }],
      reportedTotal: 4,
      reportedViewCount: 8,
      coverage: 'complete',
    },
    commentCount: 2,
  });
  const view = await mount();
  expect(view.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
  await act(async () => view.button('取消说说点赞').click());
  expect(state.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'unlike' }));
});

it('转发弹窗上方预填引用并将光标定位开头，下方保留原动态', async () => {
  const view = await mount();
  await act(async () => view.host.querySelector<HTMLButtonElement>('[title="转发"]')!.click());
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="转发语"]')!;
  expect(input.value).toBe('//：合成说说');
  expect(input.selectionStart).toBe(0);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('[aria-label="原动态"]')!.textContent).toContain('合成说说');
  capture(view.host, 'forward');
  expect(document.querySelector('.weq-qzn-forward-dialog')!.textContent).not.toContain(
    '接口尚未接入',
  );
  expect(state.write).not.toHaveBeenCalled();
  expect(state.forward).not.toHaveBeenCalled();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.weq-qzn-forward-dialog .weq-qzn-primary')!.click(),
  );
  expect(state.forward).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      hostUin: '10001',
      tid: 'post-a',
      reason: '//：合成说说',
    }),
  );
  expect(document.querySelector('.weq-qzn-forward-dialog')).toBeNull();
  expect(await state.readback!()).toBe(false);
  state.posts.mockResolvedValueOnce({
    total: 1,
    nickname: '合成空间',
    list: [
      {
        tid: 'new-forward',
        content: '//：合成说说',
        time: Math.floor(Date.now() / 1000),
        images: [],
        videos: [],
        isPrivate: false,
        commentNum: 0,
        repost: {
          tid: 'post-a',
          uin: '10001',
          nickname: '合成空间',
          content: '合成说说',
          images: [],
          videos: [],
        },
      },
    ],
  });
  expect(await state.readback!()).toBe(true);
});

it('转发悬停读取真实名单并校准数量，不沿用旧 Web 计数或发起转发', async () => {
  const view = await mount();
  const button = view.host.querySelector<HTMLButtonElement>('[title="转发"]')!;
  expect(button.textContent).toContain('转发 ?');
  expect(button.textContent).not.toContain('37');
  expect(state.forwards).not.toHaveBeenCalled();
  await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(document.querySelector('[aria-label="转发列表"]')?.textContent).toContain('合成转发语0');
  expect(button.textContent).toContain('转发 3');
  expect(state.forwards).toHaveBeenCalledWith(
    expect.objectContaining({ selfUin: '10001', hostUin: '10001', tid: 'post-a', cursor: null }),
  );
  expect(document.querySelector('[aria-label="转发语"]')).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.forward).not.toHaveBeenCalled();
});

it('通知头像与昵称分开，动作文字和摘要共用同一内容列', async () => {
  state.related.mockResolvedValue({
    feeds: [
      {
        uin: '10002',
        nickname: '通知好友',
        appid: 311,
        time: 1794000000,
        key: 'notice',
        html: '<div class="f-single-head"><div class="f-nick"><a href="https://user.qzone.qq.com/10002">通知好友</a><span class="state">评论了我的说说</span></div></div><div class="f-info">说说内容摘要</div>',
      },
    ],
    hasMore: false,
  });
  const view = await mount();
  const related = [
    ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-navigation button'),
  ].find((button) => button.textContent === '与我相关')!;
  await act(async () => related.click());
  await act(async () => {
    [...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-related-tabs button')]
      .find((button) => button.textContent?.startsWith('评论'))!
      .click();
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(view.host.querySelector('.weq-qzn-related-card > summary')).not.toBeNull(),
    );
  });
  const summary = view.host.querySelector('.weq-qzn-related-card > summary')!;
  expect(summary.querySelector(':scope > .weq-qzn-profile-avatar')).not.toBeNull();
  expect(summary.querySelector('.weq-qzn-related-action-line > button')?.textContent).toBe(
    '通知好友',
  );
  expect(summary.querySelector('.weq-qzn-identity-link')).toBeNull();
  capture(view.host, 'identity-related');
});

it('与我相关自动读取五页即停，向上滚动不续页，向下滚动才开始下一轮', async () => {
  state.related.mockReset().mockImplementation(async ({ offset }: { offset: number }) => ({
    feeds: [
      {
        uin: '10002',
        nickname: '合成好友',
        appid: 311,
        time: offset + 1,
        key: `post-${offset}`,
        html: '合成通知',
      },
    ],
    hasMore: true,
    nextCursor: `offset=${offset + 1}`,
  }));
  const view = await mount();
  vi.useFakeTimers();
  const related = [
    ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-navigation button'),
  ].find((button) => button.textContent === '与我相关')!;
  await act(async () => related.click());
  for (let index = 0; index < 8; index++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  expect(state.related).toHaveBeenCalledTimes(5);
  const scroll = view.host.querySelector('.weq-qzn-scroll')!;
  await act(async () =>
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(state.related).toHaveBeenCalledTimes(5);
  await act(async () =>
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true })),
  );
  for (let index = 0; index < 8; index++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  expect(state.related).toHaveBeenCalledTimes(10);
});

it('定向回复保留根身份与实际目标，切换目标不丢草稿，未确认不清空', async () => {
  state.interactions.mockResolvedValue({
    comments: [
      {
        id: '1',
        uin: '10002',
        nickname: '评论者',
        content: '一级评论',
        time: 1,
        images: [],
        isReply: false,
      },
      {
        id: '1_r_2_10003',
        parentCommentId: '1',
        replyId: '2',
        uin: '10003',
        nickname: '回复者',
        content: '二级回复',
        time: 2,
        images: [],
        isReply: true,
      },
    ],
    likes: [],
    commentCountInclusive: 2,
    fieldCoverage: { comments: 'observed' },
  });
  const view = await mount();
  await openComments(view.host);
  const replies = [
    ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-comment-meta button'),
  ];
  expect(replies).toHaveLength(2);
  enter(view.host, '保留草稿');
  await act(async () => view.button('选择图片').click());
  await act(async () => replies[0]!.click());
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!.placeholder).toBe(
    '回复 评论者',
  );
  const firstInput = view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!;
  expect(firstInput.closest('.weq-qzn-comment')?.textContent).toContain('一级评论');
  expect(firstInput.closest('.is-reply')).toBeNull();
  expect(firstInput.value).toBe('保留草稿');
  await act(async () => replies[1]!.click());
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!.placeholder).toBe(
    '回复 回复者',
  );
  const replyInput = view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!;
  expect(replyInput.closest('.is-reply')?.textContent).toContain('二级回复');
  expect(replyInput.value).toBe('保留草稿');
  expect(view.host.querySelectorAll('.weq-qzn-comment-composer')).toHaveLength(1);
  expect(view.button('发送说说回复').disabled).toBe(false);
  expect(view.host.querySelector<HTMLImageElement>('.weq-qq-action-image img')?.alt).toBe(
    '合成图片.png',
  );
  expect(state.write).not.toHaveBeenCalled();
  const cancel = [
    ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-comment-composer button'),
  ].find((button) => button.textContent === '取消')!;
  await act(async () => cancel.click());
  const restored = view.host.querySelector<HTMLInputElement>('[aria-label="说说评论"]')!;
  expect(restored.closest('.weq-qzn-comment')).toBeNull();
  expect(restored.value).toBe('保留草稿');
  expect(view.host.querySelector<HTMLImageElement>('.weq-qq-action-image img')?.alt).toBe(
    '合成图片.png',
  );
  await act(async () => view.button('移除评论图片').click());
  await act(async () => replies[1]!.click());
  capture(view.host, 'comments');
  state.write.mockResolvedValueOnce({ state: 'unconfirmed' });
  await act(async () => view.button('发送说说回复').click());
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!.value).toBe(
    '保留草稿',
  );
  expect(view.button('发送说说回复').disabled).toBe(false);
  expect(state.write).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'reply',
      content: '保留草稿',
      hostUin: '10001',
      tid: 'post-a',
      replyTarget: { rootId: '1', rootUin: '10002', uin: '10003', nickname: '回复者' },
    }),
  );
  const recent = {
    id: '1_r_3_10001',
    parentCommentId: '1',
    replyId: '3',
    uin: '10001',
    nickname: '自己',
    content: '保留草稿',
    time: Math.floor(Date.now() / 1000),
    isReply: true,
    images: [],
  };
  state.interactions.mockResolvedValueOnce({
    comments: [{ ...recent, replyToUin: '10002' }],
    likes: [],
    commentCountInclusive: 1,
    fieldCoverage: { comments: 'observed' },
  });
  expect(await state.readback!()).toBe(false);
  state.interactions.mockResolvedValueOnce({
    comments: [{ ...recent, replyToUin: '10003' }],
    likes: [],
    commentCountInclusive: 1,
    fieldCoverage: { comments: 'observed' },
  });
  await act(async () => expect(await state.readback!()).toBe(true));
});

it.each([false, true])(
  '定向回复确认后立即回显、退出输入且不误增根计数，后续补图=%s',
  async (withReplyImage) => {
    const image = 'https://qpic.cn/synthetic-comment.png';
    const root = {
      id: '1',
      uin: '10002',
      nickname: '评论者',
      content: '一级评论',
      time: 1,
      images: [image],
      isReply: false,
    };
    const target = {
      id: '1_r_2_10003',
      parentCommentId: '1',
      replyId: '2',
      uin: '10003',
      nickname: '回复者',
      content: '二级回复',
      replyToUin: '10002',
      replyToNickname: '评论者',
      time: 2,
      images: [],
      isReply: true,
    };
    const own = {
      id: '1_r_3_10001',
      parentCommentId: '1',
      replyId: '3',
      uin: '10001',
      nickname: '自己',
      content: '即时回显正文',
      replyToUin: '10003',
      replyToNickname: '回复者',
      time: Math.floor(Date.now() / 1000),
      images: [],
      isReply: true,
    };
    const initial = {
      comments: [root, target],
      likes: [],
      commentCountInclusive: 2,
      fieldCoverage: { comments: 'observed' },
    };
    state.interactions.mockImplementation(async (input: unknown) =>
      (input as { structuredOnly?: boolean }).structuredOnly
        ? { ...initial, comments: [{ ...root, images: [] }, target, own], commentCountInclusive: 3 }
        : withReplyImage && state.write.mock.calls.length
          ? {
              ...initial,
              comments: [root, target, { ...own, images: [image] }],
              commentCountInclusive: 3,
            }
          : initial,
    );
    state.autoReadback = true;
    const view = await mount();
    await openComments(view.host);
    const buttons = [
      ...view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-comment-meta button'),
    ];
    await act(async () => buttons[1]!.click());
    const input = view.host.querySelector<HTMLInputElement>('[aria-label="说说回复"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '即时回显正文',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => view.button('发送说说回复').click());
    expect(view.host.querySelectorAll('.weq-qzn-comment')).toHaveLength(3);
    expect(view.host.querySelectorAll('.weq-qzn-reply-message')).toHaveLength(2);
    expect(view.host.textContent).toContain('自己 回复 回复者：即时回显正文');
    expect(view.host.querySelector('[aria-label="说说回复"]')).toBeNull();
    expect(view.host.querySelector('[aria-label="说说评论"]')).not.toBeNull();
    expect(view.count()).toContain('评论 2');
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.interactions).toHaveBeenCalledWith(
      expect.objectContaining({ structuredOnly: true }),
    );
    expect(view.host.querySelectorAll('.weq-qzn-pictures img')).toHaveLength(
      withReplyImage ? 2 : 1,
    );
    expect(view.host.textContent).toContain('评论及回复共 3 条');
    if (!withReplyImage) capture(view.host, 'reply-readback');
  },
);

it('移除原生详情对照按钮和重复正文，正常浏览不新增详情读取', async () => {
  const view = await mount();
  expect(state.nativeDetail).not.toHaveBeenCalled();
  expect(state.detail).not.toHaveBeenCalled();
  expect(view.button('读取原生详情')).toBeNull();
  expect(view.host.textContent).toContain('合成说说');
  expect(view.host.textContent).not.toContain('合成原生正文');
  expect(view.count()).toContain('评论 2');
  capture(view.host, 'standard-post');
});
it('截断正文在原帖内按需补充，并带准确时间定位且保留未知完整性提示', async () => {
  state.posts.mockResolvedValue({
    total: 1,
    nickname: '合成空间',
    list: [
      {
        tid: 'post-a',
        content: '片段',
        contentTruncated: true,
        time: 7,
        images: [],
        videos: [],
        isPrivate: false,
        commentNum: 2,
      },
    ],
  });
  state.detail.mockResolvedValue({
    content: '原生补充的正文',
    contentSource: 'native',
    contentHasMore: null,
    repost: null,
    repostHasMore: null,
  });
  const view = await mount();
  expect(state.detail).toHaveBeenCalledWith(
    expect.objectContaining({ tid: 'post-a', hostUin: '10001', time: 7 }),
  );
  expect(view.host.textContent).toContain('原生补充的正文');
  expect(view.host.textContent).toContain('完整性尚未确认');
  expect(view.button('读取原生详情')).toBeNull();
});

it('转发结果未确认时保留文案和弹窗，不自动重复提交', async () => {
  const view = await mount();
  state.forward.mockResolvedValueOnce({ state: 'unconfirmed' });
  await act(async () => view.host.querySelector<HTMLButtonElement>('[title="转发"]')!.click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.weq-qzn-forward-dialog .weq-qzn-primary')!.click(),
  );
  expect(state.forward).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="转发语"]')!.value).toBe(
    '//：合成说说',
  );
  expect(document.querySelector('.weq-qzn-forward-dialog')!.textContent).toContain('未确认');
});
