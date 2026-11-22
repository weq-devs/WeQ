import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { QzoneBlogs, qzoneBlogTime, useQzoneBlogIndex } from '../src/renderer/src/views/QzoneBlogs';
import { QzoneMore, useQzoneShareIndex } from '../src/renderer/src/views/QzoneMore';
import { QzonePageContext } from '../src/renderer/src/views/qzoneShared.shared';

const rpc = vi.hoisted(() => ({
  list: vi.fn(),
  visitors: vi.fn(),
  configId: 'live',
  detail: vi.fn(),
  comments: vi.fn(),
  cancel: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: rpc.configId } }) },
    },
  },
  client: {
    account: {
      qzone: {
        blogs: { query: rpc.list },
        visitors: { query: rpc.visitors },
        blog: { query: rpc.detail },
        blogComments: { query: rpc.comments },
        cancel: { mutate: rpc.cancel },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QzoneProfileAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/components/QzoneProfileAvatar')>()),
  QzonePersonHeader: ({ nickname }: { nickname: string }) => h('span', null, nickname),
}));

it('日志列表有独立的秒级时间，短编号不当作时间戳', () => {
  expect(qzoneBlogTime({ id: '1600000007', publishedAt: '2020-09-13 20:27' })).toBe(1600000007);
  expect(qzoneBlogTime({ id: '7', publishedAt: '2020-09-13 20:27' })).toBe('2020-09-13 20:27');
});

function BlogFixture({ active }: { active: boolean }) {
  const index = useQzoneBlogIndex({ selfUin: '10001', hostUin: '10002', active, refresh: 0 });
  return h(QzoneBlogs, { index, nickname: '空间主人', onSpace: () => {} });
}

it('日志在 StrictMode 和暂停后可读，摘要断行，正文和评论按需展开', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const sentinels = new Map<Element, () => void>();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private target?: Element;
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.target = target;
        sentinels.set(target, () => {
          this.callback(
            [{ target, isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        });
      }
      disconnect() {
        if (this.target) sentinels.delete(this.target);
      }
    },
  );
  const blog = (id: string, title: string) => ({
    id,
    title,
    summary: '摘要第一行<br/>摘要第二行 &amp; 补充',
    publishedAt: '2021-08-03 15:06',
    images: [],
    commentCount: 1,
  });
  let settleCancelledRequest!: (page: { items: ReturnType<typeof blog>[] }) => void;
  rpc.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settleCancelledRequest = resolve;
      }),
  );
  rpc.list.mockResolvedValueOnce({ items: [blog('7', '首篇日志')], nextOffset: 1 });
  rpc.list.mockResolvedValueOnce({
    items: [blog('7', '首篇日志'), blog('8', '下一篇日志')],
    nextOffset: 3,
  });
  rpc.list.mockResolvedValueOnce({
    items: [blog('10', '最后一篇日志')],
    nextOffset: null,
  });
  rpc.detail.mockResolvedValue({
    html: '<p>日志全文</p><script>window.unwanted=true</script><img src="https://qpic.cn/test" onerror="window.unwanted=true"><a href="javascript:alert(1)">不安全链接</a>',
  });
  rpc.comments.mockResolvedValue({
    items: [{ id: '1', uin: '10003', nickname: '评论者', text: '日志评论内容', time: 1600000000 }],
    nextOffset: null,
  });
  const cache = new QueryClient({ logger: { log() {}, warn() {}, error() {} } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const reachEnd = (parent: ParentNode) =>
    act(async () => {
      const sentinel = parent.querySelector('.weq-qzn-page-sentinel');
      expect(sentinel && sentinels.has(sentinel)).toBe(true);
      sentinels.get(sentinel!)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  function button(label: string, parent: ParentNode = host) {
    const control = [...parent.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(label),
    );
    expect(control).toBeDefined();
    return control!;
  }
  const wait = async (label: string) => {
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(host.textContent).toContain(label);
    });
  };
  const render = async (active: boolean) =>
    await act(async () =>
      root.render(
        h(
          StrictMode,
          null,
          h(
            QueryClientProvider,
            { client: cache },
            h(
              QzonePageContext.Provider,
              { value: { active, refresh: 0 } },
              h(BlogFixture, { active }),
            ),
          ),
        ),
      ),
    );
  try {
    await render(true);
    await vi.waitFor(() => expect(rpc.list).toHaveBeenCalledOnce());
    const requestId = rpc.list.mock.calls[0]?.[0].requestId;
    await render(false);
    expect(rpc.cancel).toHaveBeenCalledWith({ requestId });
    await render(true);
    await act(async () => settleCancelledRequest({ items: [blog('9', '取消的日志结果')] }));
    await wait('首篇日志');
    expect(host.textContent).not.toContain('取消的日志结果');
    const summary = host.querySelector('article .weq-qzn-content');
    expect(summary?.querySelector('br')).not.toBeNull();
    expect(summary?.textContent).toBe('摘要第一行摘要第二行 & 补充');
    expect(rpc.detail).not.toHaveBeenCalled();
    expect(rpc.comments).not.toHaveBeenCalled();
    await reachEnd(host);
    await wait('下一篇日志');
    expect(host.querySelectorAll('article')).toHaveLength(2);
    expect(rpc.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 1, expectedAccountConfigId: 'live' }),
    );
    await reachEnd(host);
    await wait('最后一篇日志');
    expect(rpc.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 3 }));
    const first = host.querySelector('article')!;
    await act(async () => button('查看全文', first).click());
    await wait('日志全文');
    expect(first.querySelector('script, [onerror], a[href]')).toBeNull();
    await act(async () => button('评论', first).click());
    await wait('日志评论内容');
    expect(rpc.comments).toHaveBeenCalledWith(
      expect.objectContaining({ blogId: '7', hostUin: '10002', offset: 0 }),
    );
    await act(async () => button('收起全文', first).click());
    expect(first.textContent).toContain('摘要');
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('重进访客页时保留同一账号的结果，刷新失败与切换来源分别处理', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const scope = {
    selfUin: '10001',
    hostUin: '10002',
    nickname: '空间主人',
    onSpace() {},
  };
  function Visitors() {
    const shareIndex = useQzoneShareIndex(scope, 0, { active: false });
    return h(QzoneMore, { ...scope, pane: 'visitors', shareIndex });
  }
  const client = new QueryClient({ logger: { log() {}, warn() {}, error() {} } });
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (refresh: number | null) =>
    act(async () => {
      root.render(
        h(
          QueryClientProvider,
          { client },
          refresh === null
            ? null
            : h(QzonePageContext.Provider, { value: { active: true, refresh } }, h(Visitors)),
        ),
      );
    });
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  rpc.visitors.mockResolvedValueOnce({
    status: 'ok',
    items: [{ id: 'visitor', uin: '10003', nickname: '已读访客', time: 1600000000 }],
    next: null,
  });
  let failRefresh!: (reason: Error) => void;
  try {
    await render(0);
    await flush();
    expect(host.textContent).toContain('已读访客');

    await render(null);
    await render(1);
    expect(host.textContent).toContain('已读访客');
    expect(rpc.visitors).toHaveBeenCalledTimes(1);

    rpc.visitors.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRefresh = reject;
        }),
    );
    await render(2);
    expect(rpc.visitors).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('已读访客');
    expect(host.querySelector('[role="status"]')).toBeNull();

    await act(async () => failRefresh(new Error('访客读取失败')));
    await flush();
    expect(host.textContent).toContain('已读访客');
    expect(host.textContent).toContain('访客读取失败');

    rpc.configId = 'other-source';
    rpc.visitors.mockResolvedValueOnce({ status: 'ok', items: [], next: null });
    await render(2);
    await flush();
    expect(host.textContent).not.toContain('已读访客');
    expect(rpc.visitors).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedAccountConfigId: 'other-source',
      }),
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    rpc.configId = 'live';
    vi.unstubAllGlobals();
  }
});
