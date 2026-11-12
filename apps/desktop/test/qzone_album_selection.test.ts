import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AlbumGridView, MediaView } from '../src/renderer/src/components/QzoneAlbumDialog';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
afterEach(() => vi.unstubAllGlobals());
const albums = ['甲', '乙'].map((name, index) => ({
  id: index === 0 ? 'a' : 'b',
  name,
  mediaCount: 1,
  coverUrl: '',
  desc: '',
  createTime: 0,
  priv: 0,
}));
function Probe() {
  const [album, setAlbum] = useState<string | null>(null);
  const request = useContentExportRequest();
  return createElement(
    'div',
    null,
    album
      ? createElement(MediaView, {
          active: true,
          albumName: album,
          hostUin: '10002',
          selfUin: '10001',
          topicId: album,
          photos: [
            {
              id: 'same-name',
              name: '同名照片',
              desc: '',
              url: '',
              thumbUrl: '',
              uploadTime: 0,
              isVideo: false,
              picKey: 'same-key',
            },
          ],
          total: 1,
          loading: false,
          loadingMore: false,
          error: null,
          hasMore: false,
          fetchedPages: 1,
          onBack: () => setAlbum(null),
          onLoadMore: async () => false,
        })
      : createElement(AlbumGridView, {
          albums,
          hostUin: '10002',
          onOpen: (item) => setAlbum(item.id),
        }),
    createElement(
      'output',
      { 'data-export': true },
      JSON.stringify(request?.selection.scope ?? null),
    ),
  );
}
it('整本相册与照片共用选择和唯一导出入口，返回列表不丢失跨层级集合', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(ContentSelectionProvider, null, createElement(Probe))),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="选择相册 甲"]')!.click(),
    );
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>('.weq-qzal-album-open')[1]!.click(),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-media-check')!.click());
    expect(host.querySelectorAll('[aria-label="导出所选内容"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('下载选中');
    expect(host.textContent).not.toContain('本相册已选');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="导出所选内容"]')!.click(),
    );
    const scope = JSON.parse(host.querySelector('output')!.textContent!);
    expect(scope.items).toEqual(
      expect.arrayContaining([
        { kind: 'qzone-album', uin: '10002', albumId: 'a', name: '甲' },
        { kind: 'qzone-photo', uin: '10002', albumId: 'b', mediaKey: 'same-key', name: '同名照片' },
      ]),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-back')!.click());
    expect(host.querySelector('[aria-label="选择相册 甲"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  } finally {
    await act(async () => root.unmount());
  }
});
