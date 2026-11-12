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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('空间实况展示', () => {
  it('可见后精确标记实况，预览保留播放控制并静音循环', async () => {
    mocks.query.mockResolvedValue([
      { videoId: 'normal', isLivePhoto: false },
      { videoId: 'live', isLivePhoto: true },
    ]);
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos, target })));
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('.weq-qzn-live-label')).toHaveLength(1);
    const live = host.querySelector<HTMLButtonElement>('[aria-label="播放空间实况照片 1"]')!;
    expect(live).not.toBeNull();
    await act(async () => live.click());
    const player = document.querySelector('video')!;
    expect(player.loop).toBe(true);
    expect(player.muted).toBe(true);
    expect(player.controls).toBe(true);
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
  it('请求失败仍显示 Web 媒体，不标记实况或隐藏正文', async () => {
    mocks.query.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(h(QzoneMediaGrid, { images: [], videos, target })));
    expect(host.querySelectorAll('button.weq-qzn-video')).toHaveLength(2);
    expect(host.querySelector('.weq-qzn-live-label')).toBeNull();
    expect(host.querySelectorAll('button:disabled')).toHaveLength(0);
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
