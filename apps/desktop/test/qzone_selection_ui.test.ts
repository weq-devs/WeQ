import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { QzoneView, QzoneWorkspace } from '../src/renderer/src/views/QzoneView';
import { QzoneProfileContext } from '../src/renderer/src/lib/qzoneNavigation';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import {
  useContentExportRequest,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection.shared';
import { QzoneScopePicker } from '../src/renderer/src/views/export/QzoneScopePicker';
import type { QzoneFeed } from '../src/renderer/src/views/qzone_types';

const fixture = vi.hoisted(() => ({
  accountConfig: vi.fn(),
  feeds: vi.fn(
    async (_input: {
      cursor?: string;
    }): Promise<{
      feeds: QzoneFeed[];
      hasMore: boolean;
      nextCursor?: string;
    }> => ({
      feeds: [
        {
          uin: 10002,
          nickname: '合成好友',
          appid: 311,
          key: 'abcdef123456',
          time: 1,
          html: '<div class="f-info">fixture-feed</div>',
        },
      ],
      hasMore: false,
    }),
  ),
  related: vi.fn(async ({ offset }: { offset: number }) => ({
    feeds: [{ uin: 10002, appid: 0, key: `interaction-${offset}`, time: offset + 1, html: '' }],
    hasMore: true,
    nextCursor: `offset=${offset + 1}`,
  })),
  posts: vi.fn(async (_input: unknown) => ({
    total: 3,
    nickname: '合成空间',
    list: ['a', 'b', 'c'].map((tid) => ({
      tid,
      content: `fixture-${tid}`,
      time: 1,
      images: [],
      videos: [],
      isPrivate: false,
      commentNum: 0,
    })),
  })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: { getSettings: { useQuery: () => ({ data: undefined }) } },
    useUtils: () => ({}),
    account: {
      getAccountConfig: { useQuery: () => ({ data: fixture.accountConfig() }) },
      getGroupAlbumAccessState: { useQuery: () => ({ data: { qqOnline: false } }) },
      qqActions: { qzoneHome: { useInfiniteQuery: () => ({}) } },
    },
  },
  client: {
    account: {
      qzone: {
        related: { query: fixture.related },
        feeds: { query: fixture.feeds },
        posts: { query: fixture.posts },
        blogs: { query: async () => ({ items: [], nextOffset: null }) },
        shares: { query: async () => ({ items: [], next: null }) },
        detail: {
          query: async () => ({
            post: {
              tid: 'linked',
              content: 'fixture-linked',
              time: 1,
              images: [],
              videos: [],
              isPrivate: false,
              commentNum: 0,
            },
          }),
        },
        stats: { query: async () => ({ postCount: 3, photoCount: 0 }) },
        people: { query: async () => ({}) },
        cancel: { mutate: async () => {} },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: () => createElement('span', null, '头像'),
}));
vi.mock('../src/renderer/src/views/QzonePublicView', () => ({
  QzonePublicPane: () => createElement('div', null, '合成公共空间'),
}));
afterEach(() => {
  fixture.accountConfig.mockReset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { cacheTime: Infinity } } });
  const render = (node: Parameters<typeof root.render>[0]) =>
    act(() => root.render(createElement(QueryClientProvider, { client }, node)));
  render(element);
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
async function openPosts(host: HTMLElement) {
  await act(async () => {
    Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="空间内容"] button'))
      .find((button) => button.textContent === '说说')!
      .click();
  });
}
async function waitForQueryRender(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    check();
  });
}
it('好友动态不显示常驻多选按钮，修饰键选择后仍可操作并退出多选', async () => {
  const f = mount(
    createElement(
      ContentSelectionProvider,
      null,
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
      }),
    ),
  );
  try {
    await act(async () => {});
    const item = f.host.querySelector<HTMLElement>('.weq-reference-item');
    expect(item?.textContent).toContain('fixture-feed');
    expect(f.host.querySelector('[aria-label="多选"]')).toBeNull();
    expect(f.host.querySelector('.weq-reference-toolbar')).toBeNull();
    act(() => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(item?.classList.contains('is-selected')).toBe(true);
    expect(f.host.querySelector('[aria-label="导出所选内容"]')).not.toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
    expect(f.host.querySelector('.weq-reference-toolbar')).toBeNull();
    expect(item?.classList.contains('is-selected')).toBe(false);
  } finally {
    f.close();
  }
});

it('与我相关自动读取五页后，点击加载更多才从当前游标继续', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    },
  );
  const f = mount(
    createElement(
      ContentSelectionProvider,
      null,
      createElement(QzoneView, { selfUin: '10001', nickname: '合成自己' }),
    ),
  );
  try {
    const related = [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === '与我相关',
    );
    await act(async () => related!.click());
    for (let page = 1; page < 5; page++) {
      await act(async () => vi.advanceTimersByTimeAsync(350));
    }
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(fixture.related.mock.calls.map(([input]) => input.offset)).toEqual([0, 1, 2, 3, 4]);
    const more = [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === '加载更多互动',
    );
    expect(more?.disabled).toBe(false);
    await act(async () => more!.click());
    expect(fixture.related).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 5 }));
    expect(fixture.related).toHaveBeenCalledTimes(6);
  } finally {
    f.close();
    vi.useRealTimers();
  }
});

it('好友动态续页保留重叠卡片与配图，切换栏目后不重读已完成的页', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              isIntersecting: target.classList.contains('weq-qzn-page-sentinel'),
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const first: QzoneFeed = {
    uin: 10002,
    nickname: '合成好友',
    appid: 311,
    key: 'abcdef123456',
    time: 2,
    html: '<div class="f-single-content"><div class="f-info">第一页</div><img src="https://a1.qpic.cn/one.jpg" /></div>',
  };
  fixture.feeds
    .mockResolvedValueOnce({ feeds: [first], hasMore: true, nextCursor: 'second' })
    .mockResolvedValueOnce({
      feeds: [
        { ...first, html: first.html.replace('one.jpg', 'overlap.jpg') },
        { ...first, key: 'abcdef123457', time: 1, html: '<div class="f-info">第二页</div>' },
      ],
      hasMore: false,
    });
  const f = mount(createElement(QzoneView, { selfUin: '10001', nickname: '合成自己' }));
  const select = (name: string) =>
    [...f.host.querySelectorAll<HTMLButtonElement>('[aria-label="空间栏目"] button')]
      .find((button) => button.textContent === name)!
      .click();
  try {
    await act(async () => {});
    const picture = f.host.querySelector<HTMLImageElement>('.weq-qzn-picture img')!;
    expect(picture?.src).toContain('one.jpg');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixture.feeds.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, 'second']);
    expect(f.host.textContent).toContain('第二页');
    expect(f.host.querySelector('.weq-qzn-picture img')).toBe(picture);
    expect(picture.src).toContain('one.jpg');
    await act(async () => select('空友爱看'));
    await act(async () => select('好友动态'));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixture.feeds).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('.weq-qzn-picture img')).toBe(picture);
    fixture.feeds.mockResolvedValueOnce({ feeds: [first], hasMore: true, nextCursor: 'second' });
    await act(async () => select('好友动态'));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixture.feeds.mock.calls.map(([input]) => input.cursor)).toEqual([
      undefined,
      'second',
      undefined,
    ]);
    expect(f.host.textContent).toContain('第二页');
  } finally {
    f.close();
    vi.useRealTimers();
  }
});

it('空间预热不读内容，停稳才读；再次滑动暂停读取但不清空已显示内容', async () => {
  const page = (readEnabled: boolean) =>
    createElement(QzoneWorkspace, {
      active: true,
      readEnabled,
      selfUin: '10001',
      nickname: '合成自己',
      spaceRequest: { accountUin: '10001', uin: '10002', revision: 'settled-entry' },
    });
  const f = mount(page(false));
  try {
    await act(async () => {});
    expect(fixture.posts).not.toHaveBeenCalled();
    f.render(page(true));
    await openPosts(f.host);
    expect(fixture.posts).toHaveBeenCalled();
    const content = f.host.querySelector('[data-qzone-tid="a"]');
    expect(content).not.toBeNull();
    const calls = fixture.posts.mock.calls.length;
    f.render(page(false));
    await act(async () => {});
    expect(f.host.querySelector('[data-qzone-tid="a"]')).toBe(content);
    expect(fixture.posts).toHaveBeenCalledTimes(calls);
    f.render(page(true));
    await act(async () => {});
    expect(fixture.posts).toHaveBeenCalledTimes(calls);
  } finally {
    f.close();
  }
});
it('空间停稳前显示栏目和骨架，但不读取动态或说说', async () => {
  const f = mount(
    createElement(QzoneWorkspace, {
      active: true,
      readEnabled: false,
      selfUin: '10001',
      nickname: '合成自己',
    }),
  );
  try {
    await act(async () => {});
    expect(f.host.querySelector('[data-qzone-loading-preview]')).not.toBeNull();
    expect(f.host.textContent).toContain('好友动态');
    expect(f.host.querySelectorAll('.weq-mobile-qzone-skeleton > div')).toHaveLength(3);
    expect(fixture.posts).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it('空间标签、主人和作者随名称偏好与补全更新，说说仍用昵称打开名片', async () => {
  const profile = vi.fn();
  const view = (remark: string, namePriority?: 'remark' | 'nickname') =>
    createElement(
      QzoneProfileContext.Provider,
      { value: profile },
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
        namePriority,
        localProfiles: new Map([['fixture-friend', { uin: '10002', isFriend: true, remark }]]),
        spaceRequest: { accountUin: '10001', uin: '10002', revision: 'profile-entry' },
      }),
    );
  const f = mount(view(''));
  const tab = () => f.host.querySelector('.weq-qzn-space-title')?.textContent?.trim();
  const owner = () => f.host.querySelector('.weq-qzn-owner-profile .weq-qzn-name')?.textContent;
  const author = () =>
    f.host.querySelector('[data-qzone-tid="a"] .weq-qzn-post-head .weq-qzn-name')?.textContent;
  try {
    await act(async () => {});
    expect(tab()).toBe('10002 的空间');
    expect(owner()).toBe('10002');
    f.render(view('好友备注', 'nickname'));
    expect(tab()).toBe('好友备注 的空间');
    expect(owner()).toBe('好友备注');
    await openPosts(f.host);
    expect(tab()).toBe('合成空间 的空间');
    expect(owner()).toBe('合成空间');
    expect(author()).toBe('合成空间');
    f.render(view('  好友备注  '));
    expect(tab()).toBe('好友备注 的空间');
    expect(owner()).toBe('好友备注');
    expect(author()).toBe('好友备注');
    const buttons = f.host.querySelectorAll<HTMLButtonElement>(
      '[data-qzone-tid="a"] .weq-qzn-post-head button',
    );
    act(() => buttons[0]!.click());
    expect(profile).toHaveBeenCalledWith('10002', '合成空间', { x: 0, y: 0 });
    profile.mockClear();
    act(() => buttons[1]!.click());
    expect(profile).toHaveBeenCalledWith('10002', '合成空间', { x: 0, y: 0 });
    f.render(view('好友备注', 'nickname'));
    expect(tab()).toBe('合成空间 的空间');
    expect(owner()).toBe('合成空间');
    expect(author()).toBe('合成空间');
  } finally {
    f.close();
  }
});
it('空友爱看标签在页面卸载重建后仍能从快照恢复', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const page = () =>
    createElement(
      PageSnapshots,
      { scope: 'qzone-public-tab' },
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
        spaceRequest: { accountUin: '10001', uin: '10001', revision: 'public-tab' },
      }),
    );
  const first = mount(page());
  try {
    await act(async () => {});
    act(() => {
      Array.from(first.host.querySelectorAll<HTMLButtonElement>('[aria-label="空间栏目"] button'))
        .find((button) => button.textContent === '空友爱看')!
        .click();
    });
    expect(first.host.textContent).toContain('合成公共空间');
  } finally {
    first.close();
  }
  const restored = mount(page());
  try {
    await act(async () => {});
    expect(restored.host.querySelector('[aria-current="page"]')?.textContent).toBe('空友爱看');
    expect(restored.host.textContent).toContain('合成公共空间');
  } finally {
    restored.close();
  }
});

it('说说卸载后返回复用已读缓存，不重读头页', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const page = (show: boolean) =>
    createElement(
      PageSnapshots,
      { scope: 'posts-revisit' },
      show
        ? createElement(QzoneView, {
            selfUin: '10001',
            nickname: '合成自己',
            active: true,
            spaceRequest: {
              accountUin: '10001',
              uin: '10001',
              revision: 'posts-revisit',
              catalog: { section: 'posts', source: 'fixture' },
            },
          })
        : null,
    );
  const { host, render, close } = mount(page(true));
  try {
    await openPosts(host);
    expect(host.textContent).toContain('fixture-a');
    render(page(false));
    render(page(true));
    await openPosts(host);
    expect(host.textContent).toContain('fixture-a');
    expect(fixture.posts).toHaveBeenCalledTimes(1);
  } finally {
    close();
  }
});
it('空间正文不显示重复按钮，修饰键多选仍可通过顶部导出交出离散 tid', async () => {
  function Probe() {
    return createElement(
      'output',
      null,
      JSON.stringify({
        selection: useCurrentContentSelection(),
        request: useContentExportRequest(),
      }),
    );
  }
  const f = mount(
    createElement(
      ContentSelectionProvider,
      null,
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        active: true,
        spaceRequest: {
          accountUin: '10001',
          uin: '10001',
          revision: 'fixture-1',
          catalog: { section: 'posts' },
        },
      }),
      createElement(Probe),
    ),
  );
  try {
    await act(async () => {});
    await openPosts(f.host);
    expect(f.host.querySelector('[aria-label="多选说说"]')).toBeNull();
    expect(f.host.querySelector('[aria-label="导出说说范围"]')).toBeNull();
    expect(f.host.querySelectorAll('[aria-label="导出说说"]')).toHaveLength(1);
    act(() => {
      f.host
        .querySelector<HTMLElement>('[data-qzone-tid="a"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    act(() => {
      f.host.querySelector<HTMLElement>('[data-qzone-tid="c"]')!.click();
    });
    expect(f.host.querySelectorAll('.weq-qzn-post.is-selected')).toHaveLength(2);
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="导出说说"]')!.click());
    const state = JSON.parse(f.host.querySelector('output')!.textContent!);
    expect(state.selection).toEqual({
      owner: { kind: 'qzone-posts', container: '10001' },
      scope: { type: 'items', ids: ['a', 'c'] },
    });
    expect(state.request.selection).toEqual(state.selection);
    act(() => f.host.querySelector<HTMLElement>('[data-qzone-tid="b"]')!.click());
    expect(
      JSON.parse(f.host.querySelector('output')!.textContent!).request.selection.scope.ids,
    ).toEqual(['a', 'c']);
    expect(f.host.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  } finally {
    f.close();
  }
});
it('说说标签只读取指定说说，离开后回来仍是同一条', async () => {
  vi.stubGlobal('localStorage', new Storage());
  fixture.accountConfig.mockReturnValue({ uin: '10001', configId: 'live' });
  const page = (show: boolean) =>
    createElement(
      PageSnapshots,
      { scope: 'qzone-linked-post' },
      show
        ? createElement(QzoneView, {
            selfUin: '10001',
            nickname: '合成自己',
            active: true,
            spaceRequest: {
              accountUin: '10001',
              uin: '10002',
              nickname: '合成空间',
              revision: 'fixture-linked',
              target: { kind: 'post', uin: '10002', tid: 'linked' },
            },
          })
        : null,
    );
  const f = mount(page(true));
  try {
    expect(f.host.querySelector('[aria-current="page"]')?.textContent).toBe('合成空间 的说说');
    await waitForQueryRender(() =>
      expect(f.host.querySelector('[data-qzone-tid="linked"]')?.textContent ?? '').toContain(
        'fixture-linked',
      ),
    );
    expect(f.host.querySelectorAll('[data-qzone-tid]')).toHaveLength(1);
    expect(fixture.posts).not.toHaveBeenCalled();
    f.render(page(false));
    f.render(page(true));
    await waitForQueryRender(() =>
      expect(f.host.querySelector('[data-qzone-tid="linked"]')).not.toBeNull(),
    );
    expect(fixture.posts).not.toHaveBeenCalled();
    act(() =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="关闭 合成空间 的说说"]')!.click(),
    );
    expect(f.host.querySelector('[aria-current="page"]')?.textContent).toBe('好友动态');
    expect(f.host.querySelector('.weq-qzn-linked-post')).toBeNull();
  } finally {
    f.close();
  }
});
it('单条说说的作者头像和昵称按设置打开空间或名片', async () => {
  fixture.accountConfig.mockReturnValue({ uin: '10001', configId: 'live' });
  const profile = vi.fn();
  const page = (personClickAction: 'space' | 'profile') =>
    createElement(
      QzoneProfileContext.Provider,
      { value: profile },
      createElement(QzoneView, {
        selfUin: '10001',
        nickname: '合成自己',
        personClickAction,
        spaceRequest: {
          accountUin: '10001',
          uin: '10002',
          nickname: '合成作者',
          revision: 'linked-author',
          target: { kind: 'post', uin: '10002', tid: 'linked' },
        },
      }),
    );
  const f = mount(page('profile'));
  const authorButtons = () =>
    f.host.querySelectorAll<HTMLButtonElement>(
      '[data-qzone-tid="linked"] .weq-qzn-post-head button',
    );
  try {
    await waitForQueryRender(() => expect(authorButtons()).toHaveLength(2));
    act(() => authorButtons()[0]!.click());
    act(() => authorButtons()[1]!.click());
    expect(profile.mock.calls.map(([uin, name]) => [uin, name])).toEqual([
      ['10002', '合成作者'],
      ['10002', '合成作者'],
    ]);
    f.render(page('space'));
    await act(async () => authorButtons()[0]!.click());
    expect(f.host.querySelector('[aria-label="空间栏目"] [aria-current="page"]')?.textContent).toBe(
      '合成作者 的空间',
    );
    expect(profile).toHaveBeenCalledTimes(2);
  } finally {
    f.close();
  }
});
it('空间范围只在精确模式按需读取，保留未载入 tid，不让新页自动扩选', async () => {
  const change = vi.fn();
  const f = mount(
    createElement(QzoneScopePicker, {
      selfUin: '10001',
      hostUin: '10002',
      selected: ['a', 'later'],
      onChange: change,
    }),
  );
  try {
    await act(async () => {});
    expect(fixture.posts).toHaveBeenCalledWith(
      expect.objectContaining({ hostUin: '10002', offset: 0, requestId: expect.any(String) }),
    );
    expect(f.host.textContent).toContain('当前列表之外已选 1 条');
    expect(change).not.toHaveBeenCalled();
    act(() => f.host.querySelectorAll<HTMLElement>('.weq-qzone-scope-row')[2]!.click());
    expect(change).toHaveBeenCalledWith(['a', 'later', 'c']);
  } finally {
    f.close();
  }
  fixture.posts.mockClear();
  const all = mount(
    createElement(QzoneScopePicker, {
      selfUin: '10001',
      hostUin: '10002',
      selected: undefined,
      onChange: change,
    }),
  );
  try {
    await act(async () => {});
    expect(fixture.posts).not.toHaveBeenCalled();
  } finally {
    all.close();
  }
});
