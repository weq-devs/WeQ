import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { GroupAlbumFeedPage } from '@weq/service';
import { QqArk } from '../src/renderer/src/components/ark/QqArk';
import { GroupAlbumCardNavigationProvider } from '../src/renderer/src/components/GroupAlbumCardNavigation';
import { GroupAlbumFeedDialog } from '../src/renderer/src/components/GroupAlbumFeedDialog';
import { useViewState } from '../src/renderer/src/state/view';
import { albumMediaUrl } from '../src/renderer/src/lib/resourceUrl';
import { QzoneCardNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';

const rpc = vi.hoisted(() => ({
  configId: 'source-a',
  feed: vi.fn(),
  albums: vi.fn(),
  media: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ isLoading: false, mutateAsync: async () => null })
            : key === 'query' || key === 'mutate'
              ? async () => null
              : proxy(),
    });
  return {
    trpc: {
      // `useQQWriteSession` 写完后会刷缓存；本用例只关心导航，给个空实现即可。
      useUtils: () => ({ invalidate: async () => undefined }),
      account: {
        getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: rpc.configId } }) },
        // `useQQWriteSession` 会顺带探测群相册写入权限。
        getGroupAlbumAccessState: {
          useQuery: () => ({ data: { qqOnline: true }, isLoading: false }),
        },
      },
    },
    client: {
      account: {
        getGroupAlbumFeed: { query: rpc.feed },
        listGroupAlbums: { query: rpc.albums },
        listGroupAlbumMedia: { query: rpc.media },
        getGroupAlbumAccessState: { query: async () => ({ qqOnline: true }) },
        mediaSave: proxy(),
      },
    },
  };
});
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  MediaSourceSave: () => null,
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.setState({ openedUin: '10001' });
  rpc.configId = 'source-a';
  rpc.feed.mockReset().mockResolvedValue(page());
  rpc.albums.mockReset().mockResolvedValue([
    {
      id: 'synthetic_album',
      title: '精确相册',
      photoCount: 0,
      coverUrl: '',
      desc: '',
      createUin: 10001,
      createNickname: '合成',
      createTime: '',
      updateTime: '',
    },
  ]);
  rpc.media.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  target = {
    kind: 'feed' as const,
    groupCode: '123456',
    albumId: 'synthetic_album',
    batchId: '1700000000',
  };
function comment(id: string) {
  return {
    id,
    content: `正文 ${id}`,
    time: 1,
    author: { uin: '10001', name: '合成评论者' },
    replies: [],
    totalReplies: 0,
  };
}
function page(): GroupAlbumFeedPage {
  return {
    ...target,
    albumName: '精确相册',
    author: { uin: '10001', name: '合成作者' },
    time: 1700000000,
    media: [
      {
        id: 'photo-one',
        kind: 'image',
        url: 'https://qungz.photo.store.qq.com/synthetic/one',
        previewUrl: '',
        width: 800,
        height: 600,
      },
      {
        id: 'photo-two',
        kind: 'image',
        url: 'https://qungz.photo.store.qq.com/synthetic/two',
        previewUrl: '',
        width: 800,
        height: 600,
      },
    ],
    comments: [comment('c1')],
    totalComments: 1,
    totalMedia: 2,
    hasMore: false,
    nextCursor: null,
  };
}
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    render: async (node: ReactNode) => {
      await act(async () => root.render(node));
    },
  };
}
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const nativeFeed =
  'mqzone://arouse/groupalbum/feeddetail?groupid=123456&albumid=synthetic_album&batchid=1700000000';
const albumUrl = 'https://h5.qzone.qq.com/groupphoto/inqq/photo/123456/synthetic_album/groupphoto';
const ark = (app: string, meta: unknown) => ({ app, meta });

it('活动对象入口点击后按卡片群号和相册定位，不打开其它相册', async () => {
  const f = fixture();
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.activity.md', {
          activity: { desc: '合成相册卡', jumpUrl: { jumpUrl: albumUrl }, buttonText: '打开' },
        }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(rpc.albums).toHaveBeenCalledWith({ ...binding, groupCode: '123456' });
  expect(rpc.media).toHaveBeenCalledWith({
    ...binding,
    groupCode: '123456',
    albumId: 'synthetic_album',
  });
});
it('旧图文定位卡可用键盘进入精确批次和评论，旧定位串不丢失', async () => {
  const f = fixture();
  const old =
    'https://mobile.qzone.qq.com/photo/group/batch?u=123456&i=synthetic_album&p=1700000000&a=422&v=2&cmd=2&f=synthetic_focus!';
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.tuwen.lua', {
          news: {
            title: '合成定位卡',
            jumpUrl: `https://h5.qzone.qq.com/groupphoto/inqq/detail/${encodeURIComponent(old)}/groupphoto`,
          },
        }),
      }),
    ),
  );
  await act(async () =>
    f.host
      .querySelector<HTMLElement>('[role="link"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
  );
  expect(rpc.feed.mock.calls[0]?.[0]).toEqual({
    ...binding,
    groupCode: '123456',
    albumId: 'synthetic_album',
    batchId: '1700000000',
    legacyFocus: 'synthetic_focus!',
  });
  expect(document.querySelector('[data-comment-id="c1"]')?.textContent).toContain('正文 c1');
  expect(document.querySelector('.group-feed-meta')?.textContent).toContain('1700000000');
});
it('同号切来源立即关闭旧卡片，不把迟到响应放入新来源，也不自动重发', async () => {
  const f = fixture();
  let resolve: ((value: GroupAlbumFeedPage) => void) | undefined;
  rpc.feed.mockImplementationOnce(
    () =>
      new Promise<GroupAlbumFeedPage>((done) => {
        resolve = done;
      }),
  );
  const render = (configId: string) =>
    f.render(
      h(
        GroupAlbumCardNavigationProvider,
        { binding: { ...binding, expectedAccountConfigId: configId } },
        h(QqArk, {
          arkData: ark('com.tencent.feed.lua', {
            feed: { title: '合成动态', jumpUrl: nativeFeed },
          }),
        }),
      ),
    );
  await render('source-a');
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  rpc.configId = 'source-b';
  await render('source-b');
  await act(async () => resolve?.(page()));
  expect(document.querySelector('.group-album-feed')).toBeNull();
  expect(rpc.feed).toHaveBeenCalledTimes(1);
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(rpc.feed.mock.calls[1]?.[0]).toMatchObject({
    expectedAccountConfigId: 'source-b',
    groupCode: '123456',
  });
});
it('评论翻页去重并合并回复，分页输入保留目标和账号来源', async () => {
  const f = fixture();
  rpc.feed
    .mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: 'next', totalComments: 2 })
    .mockResolvedValueOnce({
      ...page(),
      comments: [{ ...comment('c1'), replies: [comment('r1')] }, comment('c2')],
      totalComments: 2,
    });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  await click(
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '加载更多评论',
    )!,
  );
  expect(rpc.feed.mock.calls[1]?.[0]).toEqual({
    ...binding,
    groupCode: target.groupCode,
    albumId: target.albumId,
    batchId: target.batchId,
    cursor: 'next',
  });
  expect(document.querySelectorAll('[data-comment-id="c1"]')).toHaveLength(1);
  expect(document.querySelector('[data-comment-id="r1"]')).not.toBeNull();
  expect(document.querySelector('[data-comment-id="c2"]')).not.toBeNull();
});
it('精确媒体可直接预览；不存在时明确提示，不打开第一张代替', async () => {
  const f = fixture();
  const render = (mediaId: string) =>
    f.render(
      h(GroupAlbumFeedDialog, {
        target: { ...target, mediaId },
        binding,
        groupName: '合成群',
        onClose: () => {},
        onOpenAlbum: () => {},
      }),
    );
  await render('photo-two');
  expect(
    document.querySelector('.qzone-preview') ||
      document.querySelector('[aria-label="群相册动态媒体预览"]'),
  ).not.toBeNull();
  expect(document.querySelector('[aria-label="群相册动态媒体预览"] img')?.getAttribute('src')).toBe(
    albumMediaUrl(page().media[1]!.url),
  );
  await render('missing');
  expect(document.body.textContent).toContain('未找到卡片指定的媒体');
  expect(document.querySelector('[aria-label="群相册动态媒体预览"]')).toBeNull();
});
it('读取错误保持可重试，不误显示空评论；重试后恢复内容', async () => {
  vi.useFakeTimers();
  const f = fixture();
  rpc.feed.mockRejectedValue(Error('synthetic-read-error'));
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(3100));
  expect(document.body.textContent).toContain('synthetic-read-error');
  expect(document.body.textContent).not.toContain('暂无评论');
  rpc.feed.mockResolvedValue(page());
  await click(button('重试读取动态'));
  expect(document.querySelector('[data-comment-id="c1"]')).not.toBeNull();
});

it('重复打开同一张卡只采用最新请求，旧响应不能覆盖新详情', async () => {
  const f = fixture();
  let finish: ((value: GroupAlbumFeedPage) => void) | undefined;
  rpc.feed
    .mockImplementationOnce(
      () =>
        new Promise<GroupAlbumFeedPage>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...page(), albumName: '最新详情' });
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.feed.lua', { feed: { title: '合成动态', jumpUrl: nativeFeed } }),
      }),
    ),
  );
  const link = f.host.querySelector<HTMLElement>('[role="link"]')!;
  await click(link);
  await click(link);
  await act(async () => finish?.({ ...page(), albumName: '旧响应不应显示' }));
  expect(document.querySelector('.group-album-feed header')?.textContent).toContain('最新详情');
  expect(document.body.textContent).not.toContain('旧响应不应显示');
});
it('指定相册未找到时不打开其它相册，重试后仍定位原目标', async () => {
  const f = fixture();
  rpc.albums.mockResolvedValueOnce([
    {
      id: 'other',
      title: '其它相册',
      photoCount: 0,
      coverUrl: '',
      desc: '',
      createUin: 10001,
      createNickname: '',
      createTime: '',
      updateTime: '',
    },
  ]);
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.activity.md', {
          activity: { desc: '合成卡片', jumpUrl: { jumpUrl: albumUrl } },
        }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(document.body.textContent).toContain('指定相册不存在');
  expect(rpc.media).not.toHaveBeenCalled();
  await click(button('重试读取相册列表'));
  expect(rpc.media).toHaveBeenCalledWith({
    ...binding,
    groupCode: target.groupCode,
    albumId: target.albumId,
  });
});
it('媒体暂缺后刷新可重新定位，不因旧失败永久跳过自动预览', async () => {
  const f = fixture();
  rpc.feed.mockResolvedValueOnce({ ...page(), media: page().media.slice(0, 1) });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target: { ...target, mediaId: 'photo-two' },
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  expect(document.body.textContent).toContain('未找到卡片指定的媒体');
  await click(button('刷新动态'));
  expect(document.querySelector('[aria-label="群相册动态媒体预览"] img')?.getAttribute('src')).toBe(
    albumMediaUrl(page().media[1]!.url),
  );
  expect(document.body.textContent).not.toContain('未找到卡片指定的媒体');
});
it('分页失败后可再次点击加载同一页，不因游标未变而无响应', async () => {
  vi.useFakeTimers();
  const f = fixture();
  rpc.feed
    .mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: 'next' })
    .mockRejectedValue(Error('synthetic-page-error'));
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  const more = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '加载更多评论',
    )!;
  await click(more());
  await act(async () => vi.advanceTimersByTimeAsync(3100));
  expect(document.body.textContent).toContain('synthetic-page-error');
  rpc.feed.mockResolvedValue({ ...page(), comments: [comment('c2')] });
  await click(more());
  expect(document.querySelector('[data-comment-id="c2"]')).not.toBeNull();
});
it('检测多页游标循环，保留已经核对的评论，不合并重复位置的响应', async () => {
  const f = fixture();
  rpc.feed
    .mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: 'a' })
    .mockResolvedValueOnce({ ...page(), comments: [comment('c2')], hasMore: true, nextCursor: 'b' })
    .mockResolvedValueOnce({
      ...page(),
      comments: [comment('c3')],
      hasMore: true,
      nextCursor: 'a',
    });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  const more = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '加载更多评论',
    )!;
  await click(more());
  await click(more());
  expect(document.body.textContent).toContain('分页位置重复');
  expect(document.querySelector('[data-comment-id="c1"]')).not.toBeNull();
  expect(document.querySelector('[data-comment-id="c2"]')).not.toBeNull();
  expect(document.querySelector('[data-comment-id="c3"]')).toBeNull();
});
it('离线时暂停而不空转加载，网络恢复后才派发读取', async () => {
  const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false),
    f = fixture();
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  expect(document.body.textContent).toContain('读取已暂停');
  expect(rpc.feed).not.toHaveBeenCalled();
  await act(async () => {
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
  });
  expect(document.querySelector('[data-comment-id="c1"]')).not.toBeNull();
});

it('媒体地址未返回时保留项目并区分不可预览与不存在', async () => {
  const f = fixture();
  rpc.feed.mockResolvedValue({
    ...page(),
    media: [{ ...page().media[0]!, url: '', previewUrl: '' }],
  });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target: { ...target, mediaId: 'photo-one' },
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  expect(document.body.textContent).toContain('媒体地址未返回');
  expect(document.body.textContent).not.toContain('未找到卡片指定的媒体');
  expect(
    document.querySelector<HTMLButtonElement>('[data-album-feed-media="photo-one"]')?.disabled,
  ).toBe(true);
  expect(document.querySelector('[aria-label="群相册动态媒体预览"]')).toBeNull();
});
it('视频只有封面时保留视频标识，预览明确提示而不冒充可播放本体', async () => {
  const f = fixture();
  const cover = 'https://qungz.photo.store.qq.com/synthetic/cover';
  rpc.feed.mockResolvedValue({
    ...page(),
    media: [{ ...page().media[0]!, kind: 'video', url: '', previewUrl: cover }],
  });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  const item = document.querySelector<HTMLButtonElement>('[data-album-feed-media="photo-one"]')!;
  expect(item.querySelector('.lucide-film')).not.toBeNull();
  await click(item);
  expect(document.body.textContent).toContain('视频本体未返回，仅显示封面');
  expect(document.querySelector('[aria-label="群相册动态媒体预览"] video')).toBeNull();
  expect(document.querySelector('[aria-label="群相册动态媒体预览"] img')?.getAttribute('src')).toBe(
    albumMediaUrl(cover),
  );
});
it('大批次媒体本地分批显示，原结果不被截断', async () => {
  const f = fixture();
  rpc.feed.mockResolvedValue({
    ...page(),
    media: Array.from({ length: 150 }, (_, index) => ({
      ...page().media[0]!,
      id: `photo-${index}`,
    })),
    totalMedia: 150,
  });
  await f.render(
    h(GroupAlbumFeedDialog, {
      target,
      binding,
      groupName: '合成群',
      onClose: () => {},
      onOpenAlbum: () => {},
    }),
  );
  expect(document.querySelectorAll('.group-feed-media-item')).toHaveLength(60);
  await click(
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '显示更多媒体',
    )!,
  );
  expect(document.querySelectorAll('.group-feed-media-item')).toHaveLength(120);
  expect(document.body.textContent).toContain('本次返回 150 项媒体');
});

it('相册卡离线尚未读取时不误报相册不存在，恢复网络后定位原目标', async () => {
  const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false),
    f = fixture();
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.activity.md', {
          activity: { desc: '合成相册卡', jumpUrl: { jumpUrl: albumUrl } },
        }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(document.body.textContent).toContain('读取已暂停');
  expect(document.body.textContent).not.toContain('指定相册不存在');
  expect(rpc.albums).not.toHaveBeenCalled();
  await act(async () => {
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
  });
  expect(rpc.media).toHaveBeenCalledWith({
    ...binding,
    groupCode: target.groupCode,
    albumId: target.albumId,
  });
});

it('普通分享卡的明确群相册链接也走内部导航，不局限于三个 app 名', async () => {
  const external = vi.spyOn(window, 'open').mockImplementation(() => null),
    f = fixture();
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.structmsg', { news: { title: '合成分享', jumpUrl: albumUrl } }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(rpc.media).toHaveBeenCalledWith({
    ...binding,
    groupCode: target.groupCode,
    albumId: target.albumId,
  });
  expect(external).not.toHaveBeenCalled();
});
it('已知卡片的目标冲突不被普通链接回退掩盖', async () => {
  const external = vi.spyOn(window, 'open').mockImplementation(() => null),
    f = fixture();
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.feed.lua', {
          feed: {
            title: '合成冲突',
            jumpUrl: albumUrl,
            legacyUrl: nativeFeed.replace('123456', '654321'),
          },
        }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('.weq-ark-container')!);
  expect(rpc.feed).not.toHaveBeenCalled();
  expect(rpc.albums).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
});
it('普通非群相册链接的锚点仍可外部打开，不被群相册专用校验拦截', async () => {
  const external = vi.spyOn(window, 'open').mockImplementation(() => null),
    f = fixture(),
    url = 'https://example.invalid/article#section';
  await f.render(
    h(
      GroupAlbumCardNavigationProvider,
      { binding },
      h(QqArk, {
        arkData: ark('com.tencent.tuwen.lua', { news: { title: '合成文章', jumpUrl: url } }),
      }),
    ),
  );
  await click(f.host.querySelector<HTMLElement>('[role="link"]')!);
  expect(external).toHaveBeenCalledWith(url, '_blank');
  expect(rpc.albums).not.toHaveBeenCalled();
});

it('普通分享卡的已识别群相册坏目标不回退为个人空间或外部链接', async () => {
  const external = vi.spyOn(window, 'open').mockImplementation(() => null),
    personal = vi.fn(),
    f = fixture();
  await f.render(
    h(
      QzoneCardNavigationContext.Provider,
      { value: personal },
      h(
        GroupAlbumCardNavigationProvider,
        { binding },
        h(QqArk, {
          arkData: ark('com.tencent.structmsg', {
            news: {
              title: '合成坏目标',
              jumpUrl: `${albumUrl}?uin=10001&tid=synthetic_post&commentId=unknown`,
            },
          }),
        }),
      ),
    ),
  );
  const card = f.host.querySelector<HTMLElement>('.weq-ark-container')!;
  await click(card);
  expect(card.getAttribute('aria-disabled')).toBe('true');
  expect(personal).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
  expect(rpc.albums).not.toHaveBeenCalled();
});
