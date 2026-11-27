import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QzoneView } from '../src/renderer/src/views/QzoneView';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { closeMediaPreview } from '../src/renderer/src/components/mediaPreviewStore.shared';
import { useViewState } from '../src/renderer/src/state/view';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';
import type { QzoneInteraction, QzonePublication } from '../src/renderer/src/views/qzone_types';

const state = vi.hoisted(() => ({
  web: false,
  configId: 'source-a',
  getConfig: vi.fn(),
  stageImage: vi.fn(),
  discardImage: vi.fn(),
  refreshWait: null as Promise<void> | null,
  readback: undefined as (() => Promise<boolean>) | undefined,
  autoReadback: false,
  writeOptions: null as { feedback?: string } | null,
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
  mediaTypes: vi.fn(),
  homeMetadata: vi.fn(),
  spaceProfile: vi.fn(() => ({})),
  albumPage: vi.fn(),
  albumMedia: vi.fn(),
  guestbook: vi.fn(),
  blogs: vi.fn(),
  blog: vi.fn(),
  blogComments: vi.fn(),
  shares: vi.fn(),
  shareComments: vi.fn(),
  albumDetail: vi.fn(),
  videos: vi.fn(),
  homePages: [] as { feeds: Record<string, unknown>[] }[],
  offscreenTid: '',
  archiveState: vi.fn(),
  share: vi.fn(),
  posts: vi.fn(),
  forwards: vi.fn(),
  likes: vi.fn(),
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
  uploadImage: vi.fn(async (_input: unknown) => ({ richval: 'synthetic-richval' })),
  publish: vi.fn<(input: unknown) => Promise<QzonePublication>>(),
  removePost: vi.fn<(input: unknown) => Promise<QQWriteOutcome>>(),
  postVisibility: vi.fn(),
  updatePostVisibility: vi.fn(),
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
vi.mock('../src/renderer/src/lib/target.shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/target.shared')>()),
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/lib/accountFilePicker', () => ({
  pickAccountFile: state.pickImage,
  stageAccountFile: state.stageImage,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { feedback?: string; readback?: () => Promise<boolean> },
    ) => {
      state.writeOptions = options ?? null;
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
    bootstrap: { getSettings: { useQuery: () => ({ data: {} }) } },
    useUtils: () => ({}),
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.configId } }) },
      qqActions: {
        qzoneHome: { useInfiniteQuery: () => ({ data: { pages: state.homePages } }) },
        qzoneSpaceProfile: { useQuery: state.spaceProfile },
        qzoneTextPostVisibility: { useQuery: state.postVisibility },
      },
    },
  },
  client: {
    bootstrap: { getSettings: { query: state.settings } },
    account: {
      getAccountConfig: { query: state.getConfig },
      getGroupAlbumAccessState: { query: async () => ({ qqOnline: true, attachEnabled: true }) },
      qzoneAlbumMedia: { query: state.albumMedia },
      pickedFileDiscard: { mutate: state.discardImage },
      qqActions: {
        qzone: { mutate: state.write },
        qzoneForward: { mutate: state.forward },
        removeQzonePost: { mutate: state.removePost },
        updateQzoneTextPostVisibility: { mutate: state.updatePostVisibility },
        qzoneOrdinaryShare: { mutate: state.share },
      },
      qzone: {
        uploadImage: { mutate: state.uploadImage },
        publish: { mutate: state.publish },
        related: { query: state.related },
        posts: {
          query: state.posts,
        },
        homeMetadata: { query: state.homeMetadata },
        albumPage: { query: state.albumPage },
        guestbook: { query: state.guestbook },
        people: { query: async () => ({}) },
        summary: { query: state.summary },
        likes: { query: state.likes },
        forwards: { query: state.forwards },
        interactions: { query: state.interactions },
        nativeDetail: { query: state.nativeDetail },
        detail: { query: state.detail },
        mediaTypes: { query: state.mediaTypes },
        blogs: { query: state.blogs },
        blog: { query: state.blog },
        blogComments: { query: state.blogComments },
        shares: { query: state.shares },
        shareComments: { query: state.shareComments },
        albumDetail: { query: state.albumDetail },
        videos: { query: state.videos },
        archiveState: { query: state.archiveState },
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
      constructor(
        private callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
      ) {}
      observe(element: Element) {
        this.callback([
          {
            target: element,
            isIntersecting:
              element.closest('[data-qzone-tid]')?.getAttribute('data-qzone-tid') !==
              state.offscreenTid,
          },
        ]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  state.configId = 'source-a';
  state.web = false;
  state.getConfig.mockReset().mockResolvedValue({ uin: '10001', configId: state.configId });
  state.stageImage.mockReset().mockResolvedValue({ uploadId: 'staged-image' });
  state.discardImage.mockReset().mockResolvedValue(undefined);
  state.refreshWait = null;
  state.readback = undefined;
  state.autoReadback = false;
  state.writeOptions = null;
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
  state.uploadImage.mockClear();
  const tid = '112700000200000001000000';
  state.publish.mockReset().mockResolvedValue({
    tid,
    time: 2,
    post: {
      tid,
      time: 2,
      content: '服务端读回的新说说',
      images: [],
      videos: [],
      isPrivate: false,
      commentNum: 0,
    },
  });
  state.removePost.mockReset().mockResolvedValue({ state: 'confirmed' });
  state.postVisibility.mockReset().mockReturnValue({ data: { visibility: 64 } });
  state.updatePostVisibility.mockReset().mockResolvedValue({ state: 'confirmed', visibility: 4 });
  state.nativeDetail.mockClear();
  state.detail.mockReset();
  state.mediaTypes.mockReset().mockResolvedValue([]);
  state.blogs.mockReset().mockResolvedValue({ items: [], total: 0, nextOffset: null });
  state.blog.mockReset().mockResolvedValue({ html: '<p>共享日志全文</p>' });
  state.blogComments.mockReset().mockResolvedValue({
    items: [{ id: '90', uin: '10002', nickname: '评论者', text: '共享日志评论', time: 1600000000 }],
    nextOffset: null,
  });
  state.shares.mockReset().mockResolvedValue({ items: [], next: null });
  state.shareComments.mockReset();
  state.albumDetail.mockReset();
  state.videos.mockReset().mockResolvedValue({ items: [], next: null });
  state.homePages = [];
  state.homeMetadata.mockReset().mockResolvedValue({ postCount: 1, photoCount: 0 });
  state.spaceProfile.mockReset().mockReturnValue({});
  state.albumPage.mockReset().mockResolvedValue({ albums: [], nextOffset: null, total: 0 });
  state.albumMedia.mockReset().mockResolvedValue({ photos: [], totalInAlbum: 0 });
  state.guestbook.mockReset().mockResolvedValue({ items: [], next: null });
  state.offscreenTid = '';
  state.archiveState
    .mockReset()
    .mockResolvedValue({ capabilitiesObserved: true, showUpvote: false });
  state.share
    .mockReset()
    .mockResolvedValue({ ark: '{}', requires_confirmation: true, notice: '分享提醒' });
  state.likes.mockReset().mockResolvedValue({ likes: [], coverage: 'observed', selfLiked: null });
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
  act(() => closeMediaPreview(document));
  useDialog.getState().close();
  close?.();
  close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(strict = false, pane = '说说', { timelineOnly = false } = {}) {
  let active = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient(
    timelineOnly ? undefined : { defaultOptions: { queries: { cacheTime: 0 } } },
  );
  const update = () => {
    const view = h(QzoneView, {
      selfUin: '10001',
      nickname: '合成自己',
      active,
      spaceRequest: {
        accountUin: '10001',
        uin: '10001',
        revision: 'fixture',
        catalog: { section: 'posts' },
      },
    });
    root.render(
      h(QueryClientProvider, { client: queryClient }, strict ? h(StrictMode, null, view) : view),
    );
  };
  close = () => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  };
  await act(async () => update());
  const openPane = async (label: string) =>
    act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="空间内容"] button'))
        .find((button) => button.textContent === label)!
        .click();
    });
  if (pane !== '主页') await openPane(pane);
  if (!timelineOnly)
    await act(async () => vi.waitFor(() => expect(state.summary).toHaveBeenCalled()));
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const count = () => host.querySelector('.weq-qzn-actions')!.textContent;
  return {
    host,
    button,
    count,
    update: () => act(() => update()),
    openPane,
    setActive: async (value: boolean) => {
      active = value;
      await act(async () => update());
    },
  };
}
it('空间隐藏时不读取，短时返回保留说说，冷却到期只刷新一轮且不重发互动', async () => {
  const view = await mount();
  const post = view.host.querySelector('[data-qzone-tid="post-a"]');
  expect(post).not.toBeNull();
  expect(state.posts).toHaveBeenCalledTimes(1);
  expect(view.host.querySelector('[aria-label="刷新空间"]')).toBeNull();
  vi.useFakeTimers({ toFake: ['Date'] });
  await view.setActive(false);
  vi.setSystemTime(Date.now() + 5 * 60_000 - 1);
  expect(state.posts).toHaveBeenCalledTimes(1);
  await view.setActive(true);
  expect(state.posts).toHaveBeenCalledTimes(1);
  expect(view.host.querySelector('[data-qzone-tid="post-a"]')).toBe(post);

  await view.setActive(false);
  vi.setSystemTime(Date.now() + 5 * 60_000);
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
async function openComposer(strict: boolean, startFromHome = false) {
  const view = await mount(strict);
  if (startFromHome) await view.openPane('主页');
  const compose = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '写说说',
  )!;
  await act(async () => compose.click());
  const dialog = document.querySelector<HTMLElement>('.weq-qzn-composer')!;
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('.weq-qzn-primary')!;
  return { dialog, input, submit, host: view.host };
}
function chooseImage(input: HTMLInputElement) {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=';
  const file = new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], '合成.png', {
    type: 'image/png',
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return base64;
}
function trackImageRead() {
  const completed = deferred<void>();
  const read = FileReader.prototype.readAsDataURL;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (
    this: FileReader,
    file,
  ) {
    this.addEventListener('loadend', () => completed.resolve(), { once: true });
    read.call(this, file);
  });
  return completed.promise;
}
it.each([false, true])('选图完成后恢复发表并可提交，严格模式=%s', async (strict) => {
  const { dialog, input, submit, host } = await openComposer(strict, true);
  const visibility = dialog.querySelector('[role="radiogroup"][aria-label="说说可见范围"]')!;
  const friends = [...visibility.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (item) => item.textContent === '好友可见',
  )!;
  await act(async () => friends.click());
  const content = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      content,
      '合成图文说说',
    );
    content.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let base64 = '';
  const reads = vi.spyOn(FileReader.prototype, 'readAsDataURL');
  act(() => {
    base64 = chooseImage(input);
  });
  expect(dialog.querySelector<HTMLImageElement>('.weq-qzn-draft-images img')?.src).toMatch(
    /^blob:/,
  );
  expect(reads).not.toHaveBeenCalled();
  reads.mockRestore();
  expect(submit.textContent).toBe('发表');
  expect(submit.disabled).toBe(false);
  expect(input.disabled).toBe(false);
  expect(state.uploadImage).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
  const completed = trackImageRead();
  await act(async () => {
    submit.click();
    await completed;
  });
  expect(state.uploadImage).toHaveBeenCalledOnce();
  expect(state.uploadImage).toHaveBeenCalledWith({ selfUin: '10001', base64 });
  expect(state.publish).toHaveBeenCalledOnce();
  expect(state.publish).toHaveBeenCalledWith({
    selfUin: '10001',
    content: '合成图文说说',
    richvals: ['synthetic-richval'],
    visibility: 4,
  });
  expect(document.querySelector('.weq-qzn-composer')).toBeNull();
  expect(host.querySelector('[aria-label="空间内容"] [aria-current="page"]')?.textContent).toBe(
    '说说',
  );
  const visible = host.querySelector(
    '.weq-qzn-owner-space:not([hidden]) .weq-qzn-scroll:not([hidden])',
  );
  expect(visible?.textContent).toContain('服务端读回的新说说');
  expect(visible?.textContent).toContain('合成说说');
});

it.each([false, true])('Web 发图按电脑能力选择上传格式，支持暂存=%s', async (staged) => {
  state.web = true;
  if (staged) {
    state.getConfig.mockResolvedValue({
      uin: '10001',
      configId: 'source-a',
      qzoneStagedImageUpload: true,
    });
  }
  const { dialog, input, submit } = await openComposer(false);
  const content = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
  let base64 = '';
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      content,
      '合成图文说说',
    );
    content.dispatchEvent(new Event('input', { bubbles: true }));
    base64 = chooseImage(input);
  });
  const completed = staged ? Promise.resolve() : trackImageRead();
  await act(async () => {
    submit.click();
    await completed;
  });
  if (staged) {
    expect(state.stageImage).toHaveBeenCalledOnce();
    expect(state.uploadImage).toHaveBeenCalledWith({
      selfUin: '10001',
      uploadId: 'staged-image',
      expectedAccountConfigId: 'source-a',
    });
  } else {
    expect(state.stageImage).not.toHaveBeenCalled();
    expect(state.uploadImage).toHaveBeenCalledWith({ selfUin: '10001', base64 });
  }
  expect(state.uploadImage).toHaveBeenCalledOnce();
  expect(state.publish).toHaveBeenCalledOnce();
});
it('发表时读取图片失败保留预览并允许重试', async () => {
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (
    this: FileReader,
  ) {
    this.dispatchEvent(new ProgressEvent('error'));
    this.dispatchEvent(new ProgressEvent('loadend'));
  });
  const { dialog, input, submit } = await openComposer(true);
  const content = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      content,
      '合成',
    );
    content.dispatchEvent(new Event('input', { bubbles: true }));
    chooseImage(input);
  });
  await act(async () => submit.click());
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('图片读取失败');
  expect(dialog.querySelector('.weq-qzn-draft-images img')).not.toBeNull();
  expect(submit.disabled).toBe(false);
  expect(state.publish).not.toHaveBeenCalled();
  read.mockRestore();
  const completed = trackImageRead();
  await act(async () => {
    submit.click();
    await completed;
  });
  expect(state.publish).toHaveBeenCalledOnce();
});

function capture(
  host: HTMLElement,
  name = 'feedback',
  selector = '.weq-qzn-post, .weq-qzn-related-card',
) {
  const directory = process.env.WEQ_QZONE_FEEDBACK_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const post = host.querySelector(selector)!;
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
    expect(original.querySelector('time')?.textContent).toBe('2026-11-04');
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
  expect(state.writeOptions?.feedback).toBe('failure-only');
  expect(view.button('取消说说点赞').disabled).toBe(true);
  expect(view.button('取消说说点赞').getAttribute('aria-busy')).toBe('true');
  capture(view.host, 'like-pending');
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
  expect(state.writeOptions?.feedback).toBe('failure-only');
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
  capture(view.host, 'comment-pending');
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
  capture(view.host, 'comment-success');
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

it.each([true, false])('本人标记为 %s 时，名单缺少本人仍正确展示及确认', async (selfLiked) => {
  const likes = {
    likes: [{ uin: '10002', nickname: '合成好友' }],
    reportedTotal: 47,
    reportedViewCount: 8,
    coverage: 'observed',
    selfLiked,
  };
  state.summary.mockResolvedValue({ likes, commentCount: 2 });
  state.likes.mockResolvedValue({ ...likes, selfLiked: !selfLiked });
  const view = await mount();
  const label = selfLiked ? '取消说说点赞' : '点赞说说';
  expect(view.button(label).getAttribute('aria-pressed')).toBe(String(selfLiked));
  await act(async () => view.button(label).click());
  expect(state.write).toHaveBeenCalledWith(
    expect.objectContaining({ action: selfLiked ? 'unlike' : 'like' }),
  );
  expect(await state.readback!()).toBe(true);
  expect(state.likes).toHaveBeenCalledWith(
    expect.objectContaining({ selfUin: '10001', hostUin: '10001', tid: 'post-a' }),
  );
  expect(state.write).toHaveBeenCalledOnce();
});

it('缺少本人标记的部分名单不能确认取消点赞', async () => {
  state.summary.mockResolvedValue({
    likes: {
      likes: [{ uin: '10001', nickname: '合成自己' }],
      reportedTotal: 47,
      reportedViewCount: 8,
      coverage: 'observed',
    },
    commentCount: 2,
  });
  const view = await mount();
  await act(async () => view.button('取消说说点赞').click());
  expect(await state.readback!()).toBe(false);
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
  expect(state.writeOptions?.feedback).toBe('failure-only');
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

it('可见动态自动读取转发数量，悬停复用名单而不发起转发', async () => {
  const view = await mount();
  const button = view.host.querySelector<HTMLButtonElement>('[title="转发"]')!;
  expect(button.textContent).toContain('转发 3');
  expect(button.textContent).not.toContain('37');
  expect(state.forwards).toHaveBeenCalledOnce();
  await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(document.querySelector('[aria-label="转发列表"]')?.textContent).toContain('合成转发语0');
  expect(button.textContent).toContain('转发 3');
  expect(state.forwards).toHaveBeenCalledOnce();
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

it('与我相关自动读取五页即停，点击加载更多互动才开始下一轮', async () => {
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
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(state.related).toHaveBeenCalledTimes(5);
  const loadMore = [...scroll.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '加载更多互动',
  );
  expect(loadMore).toBeDefined();
  await act(async () => loadMore!.click());
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

it('主页先显示已读统计并在后台刷新，首次读取时保留统计位置', async () => {
  const first = Promise.withResolvers<{ postCount: number; greeting?: string }>();
  const refresh = Promise.withResolvers<{ postCount: number; greeting?: string }>();
  state.homeMetadata.mockReturnValueOnce(first.promise).mockReturnValueOnce(refresh.promise);
  const view = await mount(false, '主页', { timelineOnly: true });
  const stats = () => view.host.querySelector('[aria-label="空间统计"]')!;
  const values = () =>
    [...stats().querySelectorAll('[data-privacy-sensitive]')].map((node) => node.textContent);
  expect(stats().getAttribute('aria-busy')).toBe('true');
  const placeholders = values();
  expect(placeholders[0]).toBe('—');
  capture(view.host, 'home-stats-loading', '.weq-qzn-home-overview');
  await act(async () => first.resolve({ postCount: 725, greeting: '合成寄语\n第二行' }));
  await act(async () => vi.waitFor(() => expect(values()).toContain('725')));
  expect(values()).toHaveLength(placeholders.length);
  capture(view.host, 'home-stats-ready', '.weq-qzn-home-overview');

  await view.openPane('说说');
  await view.openPane('主页');
  await act(async () => vi.waitFor(() => expect(state.homeMetadata).toHaveBeenCalledTimes(2)));
  expect(values()).toContain('725');
  expect(stats().getAttribute('aria-busy')).toBe('false');
  await act(async () => refresh.resolve({ postCount: 726 }));
  await act(async () => vi.waitFor(() => expect(values()).toContain('726')));
});

it('主页内容统计可直接打开对应栏目，照片复用相册入口', async () => {
  state.spaceProfile.mockReturnValue({
    data: {
      name: '合成空间',
      description: '守望着天空与大海，和你的回忆。\n这一行较长，窄屏也应该完整显示。',
      personal: {},
    },
  });
  const view = await mount(false, '主页', { timelineOnly: true });
  capture(view.host, 'home-stat-navigation', '.weq-qzn-home-overview');
  for (const [label, destination] of [
    ['说说', '说说'],
    ['日志', '日志'],
    ['照片', '相册'],
    ['相册', '相册'],
    ['留言', '留言板'],
  ] as const) {
    const stat = [
      ...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="空间统计"] button'),
    ].find((button) => button.textContent?.startsWith(label));
    expect(stat).toBeDefined();
    await act(async () => stat!.click());
    const current = view.host.querySelector('[aria-label="空间内容"] [aria-current="page"]');
    expect(current?.textContent).toBe(destination);
    expect(document.activeElement).toBe(current);
    if (destination === '相册')
      await act(async () => vi.waitFor(() => expect(state.albumPage).toHaveBeenCalled()));
    if (destination === '留言板')
      await act(async () => vi.waitFor(() => expect(state.guestbook).toHaveBeenCalled()));
    await view.openPane('主页');
  }
});

it('主页按可见性补全并复用说说，保留原位互动，并与说说页共用分享入口', async () => {
  const tid = '112700000100000001000000';
  state.offscreenTid = '112700000200000001000000';
  state.homePages = [
    {
      feeds: [tid, state.offscreenTid].map((feedId, index) => ({
        cell_common: { app_id: 311, time: index + 1, union_id: { feed_id: feedId } },
        cell_user_info: { user: { uin: '10001', nick: '合成自己' } },
        cell_summary: { summary: [{ type: 0, content: index ? '屏外说说' : '主页预览' }] },
        cell_comment: { num: 2 },
      })),
    },
  ];
  const post = {
    tid,
    content: '补全后的说说',
    time: 1,
    images: [],
    videos: [],
    isPrivate: false,
    commentNum: 2,
  };
  state.archiveState.mockResolvedValue({
    capabilitiesObserved: true,
    showUpvote: true,
    upvote: { count: 0, users: [] },
  });
  state.detail.mockResolvedValue({ post, contentHasMore: false });
  state.posts.mockResolvedValue({ total: 1, list: [post] });
  const view = await mount(false, '主页', { timelineOnly: true });
  await act(async () => vi.waitFor(() => expect(view.host.textContent).toContain(post.content)));
  expect(state.detail).toHaveBeenCalledTimes(1);
  expect(state.detail).toHaveBeenCalledWith(expect.objectContaining({ hostUin: '10001', tid }));
  expect(view.host.textContent).not.toContain('查看详情');
  expect(view.host.textContent).toContain('屏外说说');
  expect(view.button('推').textContent).toContain('0');
  await openComments(view.host);
  expect(view.host.querySelector('[aria-label="说说评论"]')).not.toBeNull();

  for (const pane of ['主页', '说说']) {
    if (pane === '说说') await view.openPane(pane);
    await act(async () => view.button('更多操作').click());
    const menu = document.querySelector('[role="menu"]')!;
    const share = [...menu.querySelectorAll('button')].find(
      (item) => item.textContent === '分享卡片',
    )!;
    await act(async () => share.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('分享提醒');
    expect(dialog.textContent).toContain('确认并转发');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="关闭分享卡片"]')!.click(),
    );
  }
  expect(state.share).toHaveBeenCalledTimes(2);
  expect(state.share).toHaveBeenLastCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    hostUin: '10001',
    tid,
  });
  expect(state.write).not.toHaveBeenCalled();
  await view.openPane('主页');
  const home = view.host.querySelector('.weq-qzn-home')!;
  expect(home.textContent).toContain(post.content);
  expect(state.detail).toHaveBeenCalledTimes(1);
});

it('主页累计翻页后只挂载附近内容，后续卡片仍在可滚动的范围内', async () => {
  state.detail.mockImplementation(async ({ tid }) => ({
    post: {
      tid,
      content: `主页样本 ${Number(tid.slice(-14))}`,
      time: 1600000000,
      images: [],
      videos: [],
      commentNum: 0,
    },
  }));
  state.homePages = Array.from({ length: 20 }, (_, page) => ({
    feeds: Array.from({ length: 12 }, (_, slot) => {
      const index = page * 12 + slot;
      return {
        cell_common: {
          app_id: 311,
          time: 1600000000 - index,
          union_id: { feed_id: `1127000001${String(index).padStart(14, '0')}` },
        },
        cell_user_info: { user: { uin: '10001' } },
        cell_summary: { summary: [{ type: 0, content: `主页样本 ${index}` }] },
      };
    }),
  }));
  const { host } = await mount(false, '主页', { timelineOnly: true });
  const home = host.querySelector('.weq-qzn-home')!;
  expect(home.textContent).toContain('主页样本 0');
  expect(home.textContent).not.toContain('主页样本 239');
  expect(home.querySelectorAll('article').length).toBeLessThan(30);
  const list = home.querySelector<HTMLElement>('.weq-qzn-feed-rows')!;
  expect(Number.parseFloat(list.style.height)).toBeGreaterThan(20_000);
});
it('主页取日志并集，按编号合并而不按时间，切换栏目复用详情和评论', async () => {
  const blogId = '1600000007';
  const newId = '1600000097';
  state.blogs.mockResolvedValue({
    items: [
      { id: newId, title: '仅列表日志', publishedAt: '', summary: '', images: [], commentCount: 0 },
      {
        id: blogId,
        title: '共享日志',
        publishedAt: '',
        summary: '共享摘要',
        images: [],
        commentCount: 1,
      },
    ],
    nextOffset: null,
    total: 2,
  });
  state.homePages = [
    {
      feeds: [
        {
          cell_common: {
            app_id: 2,
            cell_id: blogId,
            time: '1600000008',
            union_id: { feed_id: 'opaque-a' },
          },
          cell_user_info: { user: { uin: '10001' } },
        },
        {
          cell_common: {
            app_id: 2,
            cell_id: '1600000008',
            time: '1600000008',
            title: '仅主页日志',
            union_id: { feed_id: 'opaque-b' },
          },
          cell_user_info: { user: { uin: '10001' } },
        },
      ],
    },
  ];
  const view = await mount(false, '主页', { timelineOnly: true });
  const titles = () => [...view.host.querySelectorAll('article h3')].map((h) => h.textContent);
  await act(async () =>
    vi.waitFor(() => expect(titles()).toEqual(['仅列表日志', '共享日志', '仅主页日志'])),
  );
  const openBlog = async () => {
    const card = [...view.host.querySelectorAll('article')].find(
      (item) => item.querySelector('h3')?.textContent === '共享日志',
    )!;
    for (const label of ['查看全文', '评论']) {
      await act(async () =>
        [...card.querySelectorAll('button')]
          .find((button) => button.textContent?.includes(label))!
          .click(),
      );
    }
    await act(async () =>
      vi.waitFor(() => {
        expect(card.textContent).toContain('共享日志全文');
        expect(card.textContent).toContain('共享日志评论');
      }),
    );
  };
  await openBlog();
  await view.openPane('日志');
  expect(titles()).toEqual(['仅列表日志', '共享日志']);
  await openBlog();
  expect(state.blogs).toHaveBeenCalledTimes(1);
  expect(state.blog).toHaveBeenCalledOnce();
  expect(state.blog).toHaveBeenCalledWith(expect.objectContaining({ hostUin: '10001', blogId }));
  expect(state.blogComments).toHaveBeenCalledOnce();
});

it('主页补全历史分享，保留不同发布，并与分享页共用评论分页', async () => {
  const shareId = '1600000007';
  const homeTime = 1600000008;
  const listed = (id: string, title: string, publishedTime: number) => ({
    id,
    category: 4,
    title,
    memo: '分享附言',
    publishedAt: '',
    publishedTime,
    originalUrl: 'https://example.com/same-link',
    previewUrl: 'https://qpic.cn/cover.jpg',
  });
  const feed = (id: string, uin: string, title = '') => ({
    cell_common: {
      app_id: 202,
      cell_id: id,
      time: homeTime,
      title,
      union_id: { feed_id: '1600000009' },
    },
    cell_user_info: { user: { uin } },
    cell_origin: { cell_common: { cell_id: '1600000009' } },
  });
  state.shares.mockResolvedValue({
    items: [
      listed('1600000009', '仅列表分享', homeTime + 1),
      listed(shareId, '补齐分享标题', homeTime - 1),
    ],
    next: null,
  });
  state.homePages = [{ feeds: [feed(shareId, '10001'), feed(shareId, '10002', '另一人的分享')] }];
  const comment = (id: string, text: string) => ({
    id,
    text,
    uin: '10002',
    nickname: '评论者',
    publishedAt: '',
    replies: [],
  });
  state.shareComments.mockResolvedValueOnce({
    items: [comment('1', '第一页评论')],
    total: 4,
    next: 2,
  });
  state.shareComments.mockResolvedValueOnce({
    items: [comment('2', '第二页评论')],
    total: 4,
    next: null,
  });
  const view = await mount(false, '主页', { timelineOnly: true });
  const cards = () => [...view.host.querySelectorAll('.weq-qzn-scroll:not([hidden]) article')];
  const target = () => cards().find((card) => card.textContent?.includes('补齐分享标题'))!;
  await act(async () => vi.waitFor(() => expect(target()?.textContent).toContain('分享附言')));
  expect(cards()).toHaveLength(3);
  expect(cards()[0]?.textContent).toContain('仅列表分享');
  expect(cards()[2]?.textContent).toContain('另一人的分享');
  expect(
    target().querySelector<HTMLButtonElement>('[title="https://example.com/same-link"]'),
  ).not.toBeNull();
  expect(state.shareComments).not.toHaveBeenCalled();
  const showComments = () =>
    act(async () => target().querySelector<HTMLButtonElement>('button[title="评论"]')!.click());
  await showComments();
  await act(async () => vi.waitFor(() => expect(target().textContent).toContain('第二页评论')));
  expect(state.shareComments).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ hostUin: '10001', shareId, page: 1 }),
  );
  expect(state.shareComments).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ hostUin: '10001', shareId, page: 2 }),
  );
  await view.openPane('分享');
  await act(async () => vi.waitFor(() => expect(target()).toBeDefined()));
  await showComments();
  expect(target().textContent).toContain('第二页评论');
  expect(state.shares).toHaveBeenCalledOnce();
  expect(state.shareComments).toHaveBeenCalledTimes(2);
});

const activeMediaPreview = () =>
  document.querySelector<HTMLElement>('.weq-unified-preview:not([hidden])')!;

async function openLoadedTile(button: HTMLButtonElement) {
  const image = button.querySelector('img')!;
  await act(async () => image.dispatchEvent(new Event('load')));
  await act(async () => button.click());
}

it('主页按当前照片的精确键打开相册预览，关闭返回同一张', async () => {
  const tid = '112700000100000001000000';
  const photos = ['https://a.qpic.cn/first.jpg', 'https://a.qpic.cn/second.jpg'];
  const secondFull = 'https://b.qpic.cn/original-second.jpg';
  const detail = deferred<unknown>();
  state.homePages = [
    {
      feeds: [
        {
          cell_common: { app_id: 311, time: 1600000000, union_id: { feed_id: tid } },
          cell_user_info: { user: { uin: '10001' } },
          cell_media: {
            album_id: 'photo-album',
            media_items: photos.map((url, index) => ({
              image: {
                default_url: { url },
                ...(index === 1 ? { photo_url: [{ url: { url: secondFull, width: 1200 } }] } : {}),
                lloc: `photo-key-${index}`,
              },
            })),
          },
        },
      ],
    },
  ];
  state.detail.mockReturnValue(detail.promise);
  state.albumDetail.mockResolvedValue({
    picKey: 'photo-key-1',
    imageUrl: 'https://a.qpic.cn/exact.jpg',
  });
  const view = await mount(false, '主页', { timelineOnly: true });
  const first = view.host.querySelector<HTMLButtonElement>('.weq-qzn-pictures button')!;
  await openLoadedTile(first);
  await act(async () =>
    activeMediaPreview().querySelector<HTMLButtonElement>('[aria-label="下一项媒体"]')!.click(),
  );
  const source = activeMediaPreview();
  const post = {
    tid,
    content: '有相册定位的说说',
    time: 1600000000,
    images: [photos[0], secondFull],
    videos: [],
    commentNum: 0,
  };
  await act(async () => detail.resolve({ post }));
  await act(async () => vi.waitFor(() => expect(view.host.textContent).toContain(post.content)));
  expect(source.querySelector('.weq-preview-count')?.textContent).toContain('2 / 2');
  expect(state.albumDetail).not.toHaveBeenCalled();
  await act(async () =>
    [...source.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('在相册中查看'))!
      .click(),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(state.albumDetail).toHaveBeenCalledWith(
        expect.objectContaining({
          hostUin: '10001',
          topicId: 'photo-album',
          picKey: 'photo-key-1',
        }),
      ),
    ),
  );
  expect(activeMediaPreview().getAttribute('aria-label')).toBe('相册照片');
  await act(async () =>
    activeMediaPreview().querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click(),
  );
  expect(activeMediaPreview()).toBe(source);
  expect(source.querySelector('.weq-preview-count')?.textContent).toContain('2 / 2');
  expect(
    view.host.querySelector('[aria-label="空间内容"] [aria-current="page"]')?.textContent,
  ).toBe('主页');

  state.posts.mockResolvedValue({ list: [post], total: 1 });
  await view.openPane('说说');
  await act(async () =>
    vi.waitFor(() =>
      expect(view.host.querySelectorAll('.weq-qzn-pictures button')).toHaveLength(2),
    ),
  );
  await openLoadedTile(
    view.host.querySelectorAll<HTMLButtonElement>('.weq-qzn-pictures button')[1]!,
  );
  await act(async () =>
    [...activeMediaPreview().querySelectorAll('button')]
      .find((button) => button.textContent?.includes('在相册中查看'))!
      .click(),
  );
  expect(state.albumDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ hostUin: '10001', topicId: 'photo-album', picKey: 'photo-key-1' }),
  );
});

it('实况和普通视频都按媒体编号定位相册，切换到静态照片仍可打开', async () => {
  const tid = '112700000100000001000000';
  const time = 1600000000;
  const videos = ['live', 'video'].map((videoId) => ({
    videoId,
    coverUrl: `https://a.qpic.cn/${videoId}.jpg`,
    videoUrl: `https://a.qpic.cn/${videoId}.mp4`,
    duration: 1234,
  }));
  state.homePages = [
    {
      feeds: [
        {
          cell_common: { app_id: 311, time, union_id: { feed_id: tid } },
          cell_user_info: { user: { uin: '10001' } },
          cell_media: {
            album_id: 'motion-album',
            media_items: videos.map((video) => ({
              video: {
                id: video.videoId,
                url: video.videoUrl,
                cover: { default_url: { url: video.coverUrl } },
              },
              image: { lloc: `key-${video.videoId}` },
            })),
          },
        },
      ],
    },
  ];
  state.mediaTypes.mockResolvedValue(
    videos.map(({ videoId }) => ({ videoId, isLivePhoto: videoId === 'live' })),
  );
  state.detail.mockResolvedValue({ post: { tid, time, content: '', images: [], videos } });
  state.albumDetail.mockImplementation(async ({ picKey }) => ({
    picKey,
    videoUrl: 'https://a.qpic.cn/from-album.mp4',
  }));
  state.videos.mockResolvedValue({
    items: videos.map((video) => ({
      ...video,
      id: video.videoId,
      title: video.videoId,
      description: '',
      uploadedAt: null,
      sourcePostId: video.videoId === 'live' ? tid : null,
    })),
    next: null,
  });
  const view = await mount(false, '主页', { timelineOnly: true });
  const click = (button: HTMLButtonElement) => act(async () => button.click());
  const closePreview = () =>
    click(activeMediaPreview().querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!);
  const openInAlbum = () =>
    click(
      [...activeMediaPreview().querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '在相册中查看',
      )!,
    );
  const liveTile = () => view.host.querySelector<HTMLButtonElement>('.weq-qzn-video-open')!;
  await act(async () => vi.waitFor(() => expect(liveTile()).not.toBeNull()));
  await openLoadedTile(liveTile());
  await click(
    [...activeMediaPreview().querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '实况',
    )!,
  );
  await openInAlbum();
  expect(state.albumDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ topicId: 'motion-album', picKey: 'key-live' }),
  );
  await closePreview();
  expect(activeMediaPreview().querySelector('video')).toBeNull();
  await closePreview();

  await view.openPane('视频');
  const tiles = () => view.host.querySelectorAll<HTMLButtonElement>('.weq-qzal-album-open');
  await act(async () => vi.waitFor(() => expect(tiles()).toHaveLength(2)));
  await openLoadedTile(tiles()[1]!);
  await openInAlbum();
  expect(state.albumDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ topicId: 'motion-album', picKey: 'key-video' }),
  );
});

it('主页的相册对话框用后续页的标题，并从原预览直接跳转到相册', async () => {
  const tid = '112700000100000001000000';
  const image = 'https://a.qpic.cn/photo.jpg';
  const topicId = 'photo-album';
  const name = '旅行照片';
  state.homePages = [
    {
      feeds: [
        {
          cell_common: { app_id: 311, time: 1600000000, union_id: { feed_id: tid } },
          cell_user_info: { user: { uin: '10001' } },
          cell_media: {
            album_id: topicId,
            media_items: [{ image: { default_url: { url: image } } }],
          },
        },
      ],
    },
  ];
  state.detail.mockResolvedValue({
    post: { tid, content: '相册照片', time: 1600000000, images: [image], videos: [] },
  });
  state.albumPage.mockImplementation(async ({ offset }) => ({
    albums: [offset === 0 ? { id: 'other-album', name: '其他相册' } : { id: topicId, name }],
    nextOffset: offset === 0 ? 1 : null,
    total: 2,
    warning: null,
  }));
  state.albumMedia.mockResolvedValue({
    photos: [{ id: '123', name: '海边', url: image, uploadTime: 1600000000 }],
    totalInAlbum: 1,
  });

  const view = await mount(false, '主页', { timelineOnly: true });
  const currentPane = () =>
    view.host.querySelector('[aria-label="空间内容"] [aria-current="page"]')?.textContent;
  const albumDialog = () =>
    document.querySelector<HTMLElement>('[role="dialog"]:has(.weq-qzone-album-head)')!;
  await openLoadedTile(view.host.querySelector<HTMLButtonElement>('.weq-qzn-pictures button')!);
  const source = activeMediaPreview();
  const openAlbum = [...source.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '打开相册',
  )!;
  await act(async () => openAlbum.click());
  await act(async () =>
    vi.waitFor(() => {
      const dialog = albumDialog();
      expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
        name,
      );
      expect(dialog.textContent).toContain('海边');
    }),
  );
  expect(albumDialog().querySelector('[data-weq-multi-group], [aria-pressed]')).toBeNull();
  await act(async () =>
    albumDialog().querySelector<HTMLButtonElement>('button[title="关闭"]')!.click(),
  );
  expect(activeMediaPreview()).toBe(source);
  expect(currentPane()).toBe('主页');

  await act(async () => openAlbum.click());
  await act(async () => vi.waitFor(() => expect(albumDialog().textContent).toContain(name)));
  await act(async () =>
    [...albumDialog().querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '跳转到相册')!
      .click(),
  );
  expect(albumDialog()).toBeNull();
  expect(activeMediaPreview()).toBeNull();
  expect(currentPane()).toBe('相册');
  await act(async () =>
    vi.waitFor(() => {
      const album = view.host.querySelector('.weq-qzone-album-embedded')!;
      expect(album.textContent).toContain(name);
      expect(album.textContent).toContain('海边');
      expect(album.querySelector('button[aria-label="选择"]')).not.toBeNull();
    }),
  );
  expect(state.albumMedia).toHaveBeenLastCalledWith(
    expect.objectContaining({ hostUin: '10001', topicId }),
  );
});

it('视频预览只链接同一作者的说说，关闭原文后返回正在浏览的视频', async () => {
  const tid = '112700000100000001000000';
  const video = {
    description: '',
    uploadedAt: null,
    videoUrl: '',
    coverUrl: 'https://a.qpic.cn/video.jpg',
  };
  state.videos.mockResolvedValue({
    items: [
      { ...video, id: 'foreign', title: '不相关视频', sourcePostId: '122700000100000001000000' },
      { ...video, id: 'matched', title: '有关联的视频', sourcePostId: tid },
    ],
    next: null,
  });
  state.detail.mockResolvedValue({
    post: {
      tid,
      content: '视频对应的原说说',
      time: 1600000000,
      images: [],
      videos: [],
      commentNum: 0,
    },
  });
  const view = await mount(false, '视频', { timelineOnly: true });
  const first = () => view.host.querySelector<HTMLButtonElement>('.weq-qzal-album-open')!;
  await act(async () => vi.waitFor(() => expect(first()).not.toBeNull()));
  await openLoadedTile(first());
  const source = activeMediaPreview();
  const sourceAction = () =>
    [...source.querySelectorAll('button')].find((item) => item.textContent?.includes('查看原说说'));
  expect(sourceAction()).toBeUndefined();
  await act(async () =>
    source.querySelector<HTMLButtonElement>('[aria-label="下一项媒体"]')!.click(),
  );
  expect(state.detail).not.toHaveBeenCalled();
  await act(async () => sourceAction()!.click());
  const originalPost = () => document.querySelector<HTMLElement>('.weq-qzn-linked-post')!;
  await act(async () =>
    vi.waitFor(() => expect(originalPost()?.textContent).toContain('视频对应的原说说')),
  );
  expect(state.detail).toHaveBeenCalledWith(expect.objectContaining({ hostUin: '10001', tid }));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="返回视频"]')!.click(),
  );
  expect(activeMediaPreview()).toBe(source);
  expect(source.getAttribute('aria-label')).toBe('有关联的视频');
  expect(state.videos).toHaveBeenCalledOnce();
});

it('切换纯文本说说范围须先确认，取消保留原选项，确认后自动提交', async () => {
  const tid = '112700000100000001000000';
  const post = {
    tid,
    content: '合成说说',
    time: 1,
    images: [],
    videos: [],
    commentNum: 0,
    isPrivate: true,
  };
  state.posts.mockResolvedValue({ total: 1, list: [post] });
  state.detail.mockResolvedValue({ post, contentHasMore: false });
  state.homePages = [
    {
      feeds: [
        {
          cell_common: { app_id: 311, time: 1, union_id: { feed_id: tid } },
          cell_user_info: { user: { uin: '10001' } },
          cell_summary: { summary: [{ type: 0, content: post.content }] },
        },
      ],
    },
  ];
  const view = await mount();
  await act(async () => view.button('更多操作').click());
  const edit = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
    (item) => item.textContent === '修改可见范围',
  )!;
  await act(async () => edit.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.hasAttribute('aria-modal')).toBe(false);
  const scope = dialog.querySelector<HTMLElement>(
    '[role="radiogroup"][aria-label="说说可见范围"]',
  )!;
  expect(scope.querySelector('[aria-checked="true"]')?.textContent).toBe('仅自己可见');
  const friends = [...scope.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (item) => item.textContent === '好友可见',
  )!;
  await act(async () => friends.click());
  expect(useDialog.getState().current?.message).toContain('好友可见');
  expect(state.updatePostVisibility).not.toHaveBeenCalled();
  await act(async () => useDialog.getState().current!.confirm!.resolve(false));
  expect(state.updatePostVisibility).not.toHaveBeenCalled();
  expect(scope.querySelector('[aria-checked="true"]')?.textContent).toBe('仅自己可见');
  await act(async () => friends.click());
  await act(async () => useDialog.getState().current!.confirm!.resolve(true));
  expect(state.updatePostVisibility).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    tid,
    expected: 64,
    visibility: 4,
  });
  expect(scope.querySelector('[aria-checked="true"]')?.textContent).toBe('好友可见');
  expect(dialog.querySelector('button[type="submit"]')).toBeNull();
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('[aria-label="关闭修改可见范围"]')!.click(),
  );
  expect(dialog.isConnected).toBe(false);
  expect(view.host.textContent).toContain('好友可见');
  expect(view.host.textContent).not.toContain('仅自己可见');
  await view.openPane('主页');
  const home = view.host.querySelector('.weq-qzn-home')!;
  expect(home.textContent).toContain('好友可见');
  expect(home.textContent).not.toContain('仅自己可见');
});

it.each([true, false])('删除仅在单条读回确认后从两个栏目移除，确认=%s', async (confirmed) => {
  const tid = '112700000100000001000000';
  const post = { tid, content: '待删说说', time: 1, images: [], videos: [], commentNum: 0 };
  const feeds = [
    {
      cell_common: { app_id: 311, time: 1, union_id: { feed_id: tid } },
      cell_user_info: { user: { uin: '10001' } },
      cell_summary: { summary: [{ type: 0, content: post.content }] },
    },
  ];
  state.detail.mockResolvedValue({ post, contentHasMore: false });
  state.posts.mockResolvedValue({ total: 1, list: [post] });
  state.homePages = [{ feeds }];
  state.removePost.mockResolvedValue({ state: confirmed ? 'confirmed' : 'unconfirmed' });
  const view = await mount(false, '主页');
  await act(async () => view.button('更多操作').click());
  const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
    (item) => item.textContent === '删除说说',
  )!;
  await act(async () => remove.click());
  await act(async () => useDialog.getState().current!.confirm!.resolve(true));
  expect(state.removePost).toHaveBeenCalledOnce();
  expect(view.host.textContent?.includes(post.content)).toBe(!confirmed);
  await view.openPane('说说');
  expect(view.host.textContent?.includes(post.content)).toBe(!confirmed);
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
