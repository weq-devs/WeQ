import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AlbumGridView, MediaView } from '../src/renderer/src/components/QzoneAlbumDialog';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import { ReferenceExportTool } from '../src/renderer/src/views/export/ReferenceExportTool';

const save = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'task'),
  prepare: vi.fn(async (_intent?: unknown, _output?: unknown) => ({
    mode: 'before' as const,
    directory: '/srv/qzone-export',
  })),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy(),
    });
  return {
    trpc: proxy(),
    client: {
      account: {
        startAlbumReferenceExport: { mutate: save.start },
        qzone: { cancel: { mutate: async () => {} } },
        qzonePublic: { cancel: { mutate: async () => {} } },
      },
      bootstrap: proxy(),
    },
  };
});
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    isCurrent: () => true,
    prepareSave: save.prepare,
    serverLocation: null,
    chooseServerLocation: vi.fn(),
  }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => save.toast }));
afterEach(() => {
  vi.unstubAllGlobals();
  save.prepare.mockResolvedValue({ mode: 'before', directory: '/srv/qzone-export' });
  vi.clearAllMocks();
});
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

it('共享导出入口按 bundle 输出计划取保存位置，Web 交给服务器目录后进任务列表', async () => {
  // 保存入口从相册对话框收进共享导出工具后，Web 与桌面共用同一条链路：
  // 先把「选中的相册内容」报给保存策略（Web 端据此弹服务器目录），
  // 拿到的目录写进任务，完成后进任务列表而不是浏览器下载。
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(ReferenceExportTool, {
          initial: [
            { kind: 'qzone-album', uin: '10002', albumId: 'a', name: '甲' },
            { kind: 'qzone-photo', uin: '10002', albumId: 'a', mediaKey: 'k1', name: '甲照片' },
          ],
          onClose,
        }),
      ),
    );
    expect(host.textContent).toContain('已选 2 项内容');
    const start = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('开始导出'),
    )!;
    await act(async () => start.click());
    expect(save.prepare).toHaveBeenCalledWith(undefined, {
      kind: 'bundle',
      name: '选中的相册内容',
    });
    expect(save.start).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { kind: 'qzone-album', uin: '10002', albumId: 'a', name: '甲' },
          { kind: 'qzone-photo', uin: '10002', albumId: 'a', mediaKey: 'k1', name: '甲照片' },
        ],
        savePolicy: { mode: 'before', directory: '/srv/qzone-export' },
      }),
    );
    expect(save.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '相册导出已加入任务列表' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
