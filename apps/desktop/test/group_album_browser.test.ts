import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GroupAlbumDialog,
  type GroupAlbumWire,
} from '../src/renderer/src/components/GroupAlbumDialog';
import { useViewState } from '../src/renderer/src/state/view';
import { albumMediaUrl } from '../src/renderer/src/lib/resourceUrl';
import { makeSolidPng } from '@weq/protocol';
import { QzoneMediaPreview } from '../src/renderer/src/components/QzoneMediaPreview';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  web: false,
  albums: vi.fn(async (_input: unknown): Promise<GroupAlbumWire[]> => []),
  media: vi.fn(async (_input: unknown): Promise<unknown[]> => []),
  access: vi.fn(async () => ({ qqOnline: true })),
  save: vi.fn(async (_input: unknown) => 'media-task'),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
  get IS_ELECTRON() {
    return !state.web;
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    settings: { isLoading: false },
    policy: { mode: 'after' },
    prepareSave: async () => ({ mode: 'after' }),
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.configId } }) },
    },
  },
  client: {
    account: {
      listGroupAlbums: { query: state.albums },
      listGroupAlbumMedia: { query: state.media },
      getGroupAlbumAccessState: { query: state.access },
      mediaSave: { save: { mutate: state.save } },
    },
  },
}));
function album(id: string, title = id): GroupAlbumWire {
  return {
    id,
    title,
    photoCount: 2,
    coverUrl: '',
    desc: '',
    createUin: 10001,
    createNickname: '合成创建者',
    createTime: '',
    updateTime: '',
  };
}
function picture(id: string, kind: 'image' | 'video' = 'image') {
  return {
    type: kind === 'video' ? 2 : 1,
    kind,
    image:
      kind === 'image'
        ? { name: `${id}.jpg`, sloc: id, lloc: id, isGif: false, hasRaw: true }
        : null,
    video: kind === 'video' ? { id, cover: { lloc: `cover-${id}` } } : null,
    uploader: '10001',
    batchId: '1',
    uploadTime: '1',
    previewUrl: `https://example.invalid/${id}.jpg`,
    originalUrl: `https://example.invalid/${id}.${kind === 'video' ? 'mp4' : 'jpg'}`,
    fileName: `${id}.${kind === 'video' ? 'mp4' : 'jpg'}`,
  };
}
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  state.configId = 'source-a';
  state.web = false;
  state.albums.mockReset().mockResolvedValue([album('a', '合成相册甲'), album('b', '合成相册乙')]);
  state.media.mockReset().mockResolvedValue([picture('photo-a'), picture('video-b', 'video')]);
  state.access.mockReset().mockResolvedValue({ qqOnline: true });
  state.save.mockClear();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});
async function mount(
  options: { initialAlbums?: GroupAlbumWire[]; initialAlbumId?: string; groupCode?: string } = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () =>
    root.render(
      h(GroupAlbumDialog, {
        groupCode: options.groupCode || '12345',
        groupName: '合成群',
        onClose: vi.fn(),
        initialAlbums: options.initialAlbums,
        initialAlbumId: options.initialAlbumId,
      }),
    );
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () => update());
  return { host, update: () => act(() => update()) };
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function enter(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openFirst() {
  await act(async () => document.querySelector<HTMLButtonElement>('.group-album-card')!.click());
}
function capture(name: string) {
  const directory = process.env.WEQ_GROUP_ALBUM_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const [index, image] of [...clone.querySelectorAll('img')].entries()) {
    image.src = `data:image/png;base64,${Buffer.from(makeSolidPng(index % 2 ? 240 : 360, index % 2 ? 360 : 240, index % 2 ? [36, 116, 89] : [185, 91, 74])).toString('base64')}`;
  }
  const styles = [
    'index',
    'group-media',
    'workspace-surfaces',
    'page-chrome',
    'group-album-browser',
    'qq-actions',
    'qq-write',
    'qzone-preview',
    'export-save-actions',
    'media-save',
    'conversation-actions',
  ]
    .map(
      (name) =>
        `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', `${name}.css`)}">`,
    )
    .join('');
  writeFileSync(
    resolve(directory, `group-album-${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;height:100%;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}</style>${clone.outerHTML}</html>`,
  );
}
it('返回相册后迟到媒体请求不得重新打开已离开的相册', async () => {
  let finish!: (items: unknown[]) => void;
  state.media.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await act(async () => document.querySelector<HTMLButtonElement>('.group-album-card')!.click());
  act(() => document.querySelector<HTMLButtonElement>('.group-album-back')!.click());
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(2);
  await act(async () => finish([picture('late')]));
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(2);
  expect(document.querySelector('.group-album-media-view')).toBeNull();
});
it('相册搜索、返回位置及焦点保留，不改变原清单', async () => {
  const view = await mount();
  enter('搜索群相册', '相册甲');
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(1);
  const body = document.querySelector<HTMLElement>('.group-album-body')!;
  body.scrollTop = 120;
  await openFirst();
  await act(async () => button('返回相册列表').click());
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(body.scrollTop).toBe(120);
  expect(document.activeElement?.getAttribute('data-album-id')).toBe('a');
  expect(document.querySelector<HTMLInputElement>('[aria-label="搜索群相册"]')!.value).toBe(
    '相册甲',
  );
  expect(state.albums).toHaveBeenCalledOnce();
  expect(view.host.textContent).not.toContain('正在查询');
});
it('图片视频筛选和文件名搜索只筛本次结果，网格不挂载逐项管理表单', async () => {
  await mount();
  await openFirst();
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(2);
  expect(document.querySelector('[aria-label="媒体评论"]')).toBeNull();
  expect(document.querySelector('[aria-label="上传到群相册"]')).toBeNull();
  act(() => button('只看视频').click());
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(1);
  expect(button('预览 video-b.mp4')).not.toBeNull();
  enter('搜索相册媒体', 'VIDEO-B');
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(1);
  enter('搜索相册媒体', '不存在');
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(0);
  expect(state.media).toHaveBeenCalledOnce();
  act(() => button('上传图片').click());
  expect(document.querySelector('[aria-label="上传到群相册"]')).not.toBeNull();
});
it('大相册分批展示但连续预览可导航到当前批次外，不冒充网络分页', async () => {
  state.media.mockResolvedValueOnce(
    Array.from({ length: 241 }, (_, index) => picture(`photo-${index}`)),
  );
  await mount();
  await openFirst();
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(120);
  await act(async () => button('预览 photo-119.jpg').click());
  await act(async () => button('下一项媒体').click());
  expect(document.querySelector('.group-album-preview-meta strong')?.textContent).toBe(
    'photo-120.jpg',
  );
  act(() => button('关闭预览').click());
  const more = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '显示更多',
  )!;
  act(() => more.click());
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(240);
  expect(state.media).toHaveBeenCalledOnce();
});
it('连续预览只挂载当前媒体操作和公共保存，视频传本体而不是封面', async () => {
  await mount();
  await openFirst();
  await act(async () => button('预览 photo-a.jpg').click());
  expect(document.querySelector('[role="dialog"][aria-label="群相册媒体预览"]')).not.toBeNull();
  expect(button('上一项媒体').disabled).toBe(true);
  expect(document.querySelectorAll('[aria-label="媒体评论"]')).toHaveLength(1);
  await act(async () => button('保存图片').click());
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: { url: albumMediaUrl('https://example.invalid/photo-a.jpg'), name: 'photo-a.jpg' },
    savePolicy: { mode: 'after' },
  });
  await act(async () => button('下一项媒体').click());
  expect(document.querySelector('.weq-qz-preview-stage video')?.getAttribute('src')).toBe(
    albumMediaUrl('https://example.invalid/video-b.mp4'),
  );
  expect(button('下一项媒体').disabled).toBe(true);
  await act(async () => button('保存视频').click());
  expect(state.save.mock.calls[1]![0]).toMatchObject({
    source: { url: albumMediaUrl('https://example.invalid/video-b.mp4'), name: 'video-b.mp4' },
  });
});
it('评论输入方向键不切换媒体，保存菜单 Escape 不关闭底层预览', async () => {
  await mount();
  await openFirst();
  await act(async () => button('预览 photo-a.jpg').click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="媒体评论"]')!;
  act(() => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  expect(document.querySelector('.group-album-preview-meta strong')?.textContent).toBe(
    'photo-a.jpg',
  );
  act(() => button('保存图片的本次保存选项').click());
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu).not.toBeNull();
  act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[aria-label="群相册媒体预览"]')).not.toBeNull();
});
it('只有视频封面时按图片预览和保存，不把 jpg 传给 video', async () => {
  const cover = picture('cover-only', 'video');
  cover.originalUrl = '';
  state.media.mockResolvedValueOnce([cover]);
  await mount();
  await openFirst();
  await act(async () => button('预览 cover-only.mp4').click());
  expect(document.querySelector('.weq-qz-preview-stage video')).toBeNull();
  expect(document.querySelector('.group-album-preview-meta')?.textContent).toContain('仅显示封面');
  await act(async () => button('保存视频封面').click());
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: { url: albumMediaUrl(cover.previewUrl) },
  });
});
it('刷新失败保留原网格，重试恢复，不以失败伪装空相册', async () => {
  await mount();
  await openFirst();
  state.media.mockRejectedValueOnce(new Error('合成读取失败'));
  await act(async () => button('刷新相册媒体').click());
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(2);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('合成读取失败');
  await act(async () => button('刷新相册媒体').click());
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it('刷新返回新顺序时，已打开的预览保持原来的对象及顺序', async () => {
  await mount();
  await openFirst();
  let finish!: (items: unknown[]) => void;
  state.media.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => button('刷新相册媒体').click());
  await act(async () => button('预览 photo-a.jpg').click());
  await act(async () => finish([picture('video-b', 'video'), picture('photo-a')]));
  expect(document.querySelector('.group-album-preview-meta strong')?.textContent).toBe(
    'photo-a.jpg',
  );
  await act(async () => button('下一项媒体').click());
  expect(document.querySelector('.group-album-preview-meta strong')?.textContent).toBe(
    'video-b.mp4',
  );
});
it('同号切源销毁旧预览和草稿', async () => {
  const view = await mount();
  await openFirst();
  await act(async () => button('预览 photo-a.jpg').click());
  state.configId = 'source-b';
  await act(async () => view.update());
  expect(document.querySelector('[aria-label="群相册媒体预览"]')).toBeNull();
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(2);
});
it('搜索入口预选相册复用已有列表，离线失败可返回或重试', async () => {
  state.access.mockResolvedValueOnce({ qqOnline: false });
  await mount({ initialAlbums: [album('a')], initialAlbumId: 'a' });
  expect(state.albums).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('需要先登录');
  await act(async () => button('刷新相册媒体').click());
  expect(document.querySelectorAll('.group-album-media-card')).toHaveLength(2);
});
it('相册排序稳定且不改写后端清单', async () => {
  const source = [
    { ...album('z', '乙'), photoCount: 5 },
    { ...album('a', '甲'), photoCount: 1 },
  ];
  state.albums.mockResolvedValueOnce(source);
  await mount();
  const sort = document.querySelector<HTMLSelectElement>('[aria-label="相册排序"]')!;
  act(() => {
    sort.value = 'name';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-album-id]')].map(
      (item) => item.dataset.albumId,
    ),
  ).toEqual(['a', 'z']);
  act(() => {
    sort.value = 'count';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-album-id]')].map(
      (item) => item.dataset.albumId,
    ),
  ).toEqual(['z', 'a']);
  expect(source.map((item) => item.id)).toEqual(['z', 'a']);
});
it('原图失败保留预览图并可重试，保存仍定位原图', async () => {
  const item = picture('raw-photo');
  item.previewUrl = 'https://example.invalid/thumb.jpg';
  state.media.mockResolvedValueOnce([item]);
  await mount();
  await openFirst();
  await act(async () => button('预览 raw-photo.jpg').click());
  const image = document.querySelector<HTMLImageElement>('.weq-qz-preview-stage img')!;
  expect(image.src).toBe(albumMediaUrl(item.originalUrl));
  act(() => image.dispatchEvent(new Event('error')));
  expect(image.src).toBe(albumMediaUrl(item.previewUrl));
  expect(button('重试读取原图')).not.toBeNull();
  await act(async () => button('重试读取原图').click());
  expect(image.src).toBe(albumMediaUrl(item.originalUrl));
  await act(async () => button('保存图片').click());
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: { url: albumMediaUrl(item.originalUrl) },
  });
});
it('读取中同号切源丢弃旧媒体，列表错误重试不清除已有相册', async () => {
  const view = await mount();
  state.albums.mockRejectedValueOnce(new Error('合成列表失败'));
  await act(async () => button('刷新相册列表').click());
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(2);
  let finish!: (items: unknown[]) => void;
  state.media.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await openFirst();
  state.configId = 'source-b';
  await act(async () => view.update());
  await act(async () => finish([picture('old-source')]));
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(2);
  expect(button('预览 old-source.jpg')).toBeNull();
});
it('相册、媒体、上传及预览控件合成布局', async () => {
  const title = '这是一册用于检查中文长名称与描述显示的合成群相册';
  state.albums.mockResolvedValueOnce(
    Array.from({ length: 6 }, (_, index) => ({
      ...album(String(index), index ? `合成相册 ${index}` : title),
      coverUrl: `https://example.invalid/cover-${index}.jpg`,
      desc: '合成相册描述',
    })),
  );
  state.media.mockResolvedValueOnce(
    Array.from({ length: 6 }, (_, index) =>
      picture(`合成照片与视频-${index}`, index === 4 ? 'video' : 'image'),
    ),
  );
  await mount();
  capture('list');
  await openFirst();
  capture('media');
  act(() => button('上传图片').click());
  capture('upload');
  await act(async () => button('预览 合成照片与视频-0.jpg').click());
  capture('preview');
});
it('原空间预览不传操作区时保持原布局、方向键与关闭行为', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    close = vi.fn();
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      h(QzoneMediaPreview, {
        items: [
          { key: 'a', kind: 'image', src: 'https://example.invalid/a.jpg' },
          { key: 'b', kind: 'image', src: 'https://example.invalid/b.jpg' },
        ],
        initialIndex: 0,
        onClose: close,
      }),
    ),
  );
  const preview = document.querySelector<HTMLElement>('[aria-label="空间媒体预览"]')!;
  expect(preview.classList.contains('has-actions')).toBe(false);
  expect(preview.querySelector('footer')).toBeNull();
  act(() =>
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(preview.querySelector('img')?.src).toBe('https://example.invalid/b.jpg');
  act(() => preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(close).toHaveBeenCalledOnce();
});
it('Web 群相册预览明确区分服务器保存和浏览器下载', async () => {
  state.web = true;
  await mount();
  await openFirst();
  await act(async () => button('预览 photo-a.jpg').click());
  expect(button('保存图片')?.textContent).toContain('保存到服务器');
  expect(button('保存图片到浏览器')).not.toBeNull();
  capture('preview-web');
  await act(async () => button('保存图片').click());
  expect(state.save).toHaveBeenCalledOnce();
});
it('返回大相册列表时保留已展开批次，打开项仍可恢复焦点', async () => {
  state.albums.mockResolvedValueOnce(
    Array.from({ length: 241 }, (_, index) => album(String(index))),
  );
  await mount();
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(120);
  act(() => document.querySelector<HTMLButtonElement>('.group-album-more')!.click());
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(240);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-album-id="150"]')!.click(),
  );
  await act(async () => button('返回相册列表').click());
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.querySelectorAll('.group-album-card')).toHaveLength(240);
  expect(document.activeElement?.getAttribute('data-album-id')).toBe('150');
});
