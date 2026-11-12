// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  cancel: vi.fn(async () => ({ cancelled: true })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qzone: {
        mediaTypes: { query: mocks.query },
        cancel: { mutate: mocks.cancel },
      },
    },
  },
}));
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({ albumMediaUrl: (url: string) => url }));
import {
  QzoneMediaGrid,
  QzonePageContext,
  QzoneReadPauseContext,
} from '../src/renderer/src/views/qzoneShared';

let root: Root;
let host: HTMLDivElement;
const target = { selfUin: '10001', hostUin: '10002', tid: 'fixture', time: 1700000000 };
const videos = [
  {
    videoId: 'live',
    coverUrl: 'https://a.qpic.cn/live.jpg',
    videoUrl: 'https://a.qq.com/live.mp4',
    duration: 22000,
  },
  {
    videoId: 'normal',
    coverUrl: 'https://a.qpic.cn/normal.jpg',
    videoUrl: 'https://a.qq.com/normal.mp4',
    duration: 2000,
  },
];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() {
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    },
  );
  mocks.query.mockReset();
  mocks.cancel.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('空间实况展示', () => {
  it('实况按钮在小图内静音播放，点击照片才打开预览', async () => {
    mocks.query.mockResolvedValue([
      { videoId: 'normal', isLivePhoto: false },
      { videoId: 'live', isLivePhoto: true },
    ]);
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos, target })));
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('.weq-qzn-live-label')).toHaveLength(1);
    const live = host.querySelector<HTMLButtonElement>('.weq-qzn-live-label')!;
    expect(live).not.toBeNull();
    await act(async () => live.click());
    const player = document.querySelector('video')!;
    expect(player.loop).toBe(true);
    expect(player.muted).toBe(true);
    expect(player.controls).toBe(false);
    expect(player.play).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看空间实况照片 1"]')!.click(),
    );
    expect(document.querySelector('.weq-qz-preview-stage video')!.hasAttribute('controls')).toBe(
      true,
    );
    expect(document.querySelector('.weq-qz-preview-toolbar')?.textContent).toContain('实况');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="播放空间视频 2"]')!.click(),
    );
    expect(document.querySelector('video')!.loop).toBe(false);
    expect(document.querySelector('video')!.muted).toBe(false);
  });
  it('类型补全前显示封面而非普通视频播放标记', async () => {
    let resolve!: (value: { videoId: string; isLivePhoto: boolean }[]) => void;
    mocks.query.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos, target })));
    expect(host.querySelectorAll('img')).toHaveLength(2);
    expect(host.querySelector('.weq-qzn-video-play')).toBeNull();
    await act(async () =>
      resolve([
        { videoId: 'live', isLivePhoto: true },
        { videoId: 'normal', isLivePhoto: false },
      ]),
    );
    expect(host.querySelectorAll('.weq-qzn-video-play')).toHaveLength(1);
  });
  it('混排和预览均使用原始媒体位置', async () => {
    mocks.query.mockResolvedValue([{ videoId: 'live', isLivePhoto: true }]);
    await act(async () =>
      root.render(
        h(QzoneMediaGrid, {
          images: ['https://a.qpic.cn/still.jpg'],
          videos: [{ ...videos[0]!, mediaIndex: 0 }],
          target,
        }),
      ),
    );
    expect(
      host
        .querySelector('.weq-qzn-pictures')!
        .firstElementChild?.classList.contains('weq-qzn-video'),
    ).toBe(true);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看空间实况照片 1"]')!.click(),
    );
    expect(document.querySelector('.weq-qz-preview-toolbar')?.textContent).toContain('1 / 2');
  });
  it('播放器持有焦点并截断冒泡时 Esc 仍可关闭最上层预览', async () => {
    mocks.query.mockResolvedValue([{ videoId: 'normal', isLivePhoto: false }]);
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos: [videos[1]!] })));
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzn-video-open')!.click());
    const player = document.querySelector('video')!;
    player.focus();
    player.addEventListener('keydown', (event) => event.stopPropagation());
    await act(async () =>
      player.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('请求失败仍显示 Web 媒体，不标记实况或隐藏正文', async () => {
    mocks.query.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos, target })));
    expect(host.querySelectorAll('button.weq-qzn-video-open')).toHaveLength(2);
    expect(host.querySelector('.weq-qzn-live-label')).toBeNull();
    expect(host.querySelectorAll('button:disabled')).toHaveLength(0);
  });
  it('实况播放拒绝后可原地重试，打开预览时停止小图播放', async () => {
    mocks.query.mockResolvedValue([{ videoId: 'live', isLivePhoto: true }]);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue();
    await act(async () =>
      root.render(h(QzoneMediaGrid, { images: [], videos: [videos[0]!], target })),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="播放实况照片"]')!.click(),
    );
    expect(host.querySelector('video')).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="重试播放实况照片"]')!.click(),
    );
    expect(play).toHaveBeenCalledTimes(2);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看空间实况照片 1"]')!.click(),
    );
    expect(host.querySelector('video')).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  it('协议相对视频地址在小图和预览均规范化为可代理地址', async () => {
    mocks.query.mockResolvedValue([{ videoId: 'live', isLivePhoto: true }]);
    const video = { ...videos[0]!, videoUrl: '//photovideo.photo.qq.com/live.mp4' };
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos: [video], target })));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="播放实况照片"]')!.click(),
    );
    expect(host.querySelector('video')?.getAttribute('src')).toBe(
      'https://photovideo.photo.qq.com/live.mp4',
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看空间实况照片 1"]')!.click(),
    );
    expect(document.querySelector('video')?.getAttribute('src')).toBe(
      'https://photovideo.photo.qq.com/live.mp4',
    );
  });
  it('上层对话框存在时 Esc 不会穿透关闭预览', async () => {
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos: [videos[1]!] })));
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzn-video-open')!.click());
    const top = document.createElement('div');
    top.setAttribute('role', 'dialog');
    top.style.zIndex = '999999';
    document.body.append(top);
    try {
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(document.querySelector('.weq-qz-preview')).not.toBeNull();
    } finally {
      top.remove();
    }
  });
  it('隐藏页面、暂停读取和纯图片网格不额外发原生请求', async () => {
    await act(async () =>
      root.render(
        h(
          QzonePageContext.Provider,
          { value: { active: false, refresh: 0 } },
          h(QzoneMediaGrid, { images: [], videos, target }),
        ),
      ),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        h(
          QzoneReadPauseContext.Provider,
          { value: true },
          h(QzoneMediaGrid, { images: [], videos, target }),
        ),
      ),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    await act(async () =>
      root.render(h(QzoneMediaGrid, { images: ['https://a.qpic.cn/still.jpg'], target })),
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
