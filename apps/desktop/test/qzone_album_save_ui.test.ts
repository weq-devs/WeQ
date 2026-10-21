import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { AlbumGridView, MediaView } from '../src/renderer/src/components/QzoneAlbumDialog';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const state = vi.hoisted(() => ({
  web: false,
  current: true,
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'after',
    }),
  ),
  media: vi.fn(async (_input: unknown): Promise<string | null> => 'media-task'),
  albums: vi.fn(async (_input: unknown): Promise<string | null> => 'album-task'),
  toast: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    settings: { isLoading: false },
    policy: { mode: 'preset', directory: '/saved' },
    prepareSave: state.prepare,
    isCurrent: () => state.current,
  }),
}));
vi.mock('../src/renderer/src/hooks/useQzoneRequests', () => ({
  useQzoneRequests: () => ({ run: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => state.error,
  Modal: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      startQzoneAlbumMediaExport: { mutate: state.media },
      startQzoneAlbumsExport: { mutate: state.albums },
    },
  },
}));
const photos = ['first', 'second'].map((key) => ({
  id: 'placeholder',
  name: `${key}.jpg`,
  desc: '',
  url: `https://synthetic.invalid/${key}.jpg`,
  thumbUrl: '',
  uploadTime: 1,
  isVideo: key === 'second',
  picKey: key,
  width: 10,
  height: 10,
}));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.web = false;
  state.current = true;
  state.prepare.mockReset().mockResolvedValue({ mode: 'after' });
  state.media.mockReset().mockResolvedValue('media-task');
  state.albums.mockClear();
  state.toast.mockClear();
  state.error.mockClear();
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
async function mount(kind: 'media' | 'albums' = 'media') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const element =
    kind === 'media'
      ? h(MediaView, {
          photos,
          total: 2,
          loading: false,
          loadingMore: false,
          error: null,
          hasMore: false,
          fetchedPages: 1,
          albumName: '合成相册',
          selfUin: '10001',
          hostUin: '20002',
          topicId: 'album-a',
          onBack: vi.fn(),
          onLoadMore: async () => false,
        })
      : h(AlbumGridView, {
          albums: [
            {
              id: 'album-a',
              name: '合成相册',
              mediaCount: 2,
              coverUrl: '',
              desc: '',
              createTime: 0,
              priv: 0,
            },
          ],
          hostUin: '20002',
          onOpen: vi.fn(),
        });
  await act(async () => root.render(element));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
async function select(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-media-check')!.click());
}
function capture(host: HTMLElement, name: string) {
  const layout = process.env.WEQ_QZONE_SAVE_LAYOUT;
  if (!layout) return;
  mkdirSync(layout, { recursive: true });
  const styles = ['index.css', 'qzone-album-save.css', 'export-save-actions.css']
    .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`)
    .join('');
  writeFileSync(
    resolve(layout, name),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}main{width:100%;max-width:1080px;margin:auto;padding:12px}</style><body><main>${host.innerHTML}</main></body></html>`,
  );
}
it('选中单行只传对应媒体，不因占位 id 相同而扩大选择，排队后保留选择', async () => {
  const host = await mount();
  await select(host);
  capture(host, 'qzone-media-desktop.html');
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-download')!.click());
  expect(state.media).toHaveBeenCalledWith(
    expect.objectContaining({
      hostUin: '20002',
      topicId: 'album-a',
      savePolicy: { mode: 'preset', directory: '/saved' },
      expectedAccountConfigId: 'source-a',
      items: [
        {
          id: 'placeholder',
          name: 'first.jpg',
          url: photos[0]!.url,
          isVideo: false,
          picKey: 'first',
        },
      ],
    }),
  );
  expect(host.textContent).toContain('已选 1 项');
  expect(state.prepare).not.toHaveBeenCalled();
});
it('本次另存取消保留媒体选择，回执不冒称下载完成', async () => {
  const host = await mount();
  await select(host);
  state.media.mockResolvedValueOnce(null);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === '另存到…')!
      .click(),
  );
  expect(state.media.mock.calls[0]![0]).toMatchObject({ savePolicy: { mode: 'before' } });
  expect(host.textContent).toContain('已选 1 项');
  expect(state.toast).not.toHaveBeenCalled();
});
it('Web 空间媒体使用服务器目录策略，保留由任务列表下载到浏览器的语义', async () => {
  state.web = true;
  const host = await mount();
  await select(host);
  capture(host, 'qzone-media-web.html');
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-download')!.click());
  expect(state.prepare).toHaveBeenCalledWith(undefined, { kind: 'bundle', name: '合成相册' });
  expect(host.textContent).toContain('保存选中到服务器');
});
it('Web 位置准备期间切换来源，不创建旧媒体任务', async () => {
  state.web = true;
  const host = await mount();
  await select(host);
  state.prepare.mockImplementationOnce(async () => {
    state.current = false;
    return { mode: 'after' };
  });
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-download')!.click());
  expect(state.media).not.toHaveBeenCalled();
});
it.each([false, true])(
  '整本相册沿用公共保存并固定所选 id，取消位置不清空选择或建任务，Web=%s',
  async (web) => {
    state.web = web;
    const host = await mount('albums');
    await select(host);
    capture(host, web ? 'qzone-albums-web.html' : 'qzone-albums-desktop.html');
    state.prepare.mockResolvedValueOnce(null);
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-download')!.click());
    expect(state.albums).not.toHaveBeenCalled();
    expect(host.textContent).toContain('已选 1 个相册');
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-qzal-download')!.click());
    expect(state.albums).toHaveBeenCalledWith(
      expect.objectContaining({
        albums: [{ id: 'album-a', title: '合成相册' }],
        savePolicy: { mode: 'after' },
      }),
    );
  },
);
