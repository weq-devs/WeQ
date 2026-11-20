import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QqImage } from '../src/renderer/src/components/QqMedia';

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/renderer/src/components/mediaPreviewStore', () => ({
  openMediaPreview: state.open,
}));
vi.mock('../src/renderer/src/components/mediaPreviewStore.shared', () => ({
  openMediaPreview: state.open,
}));
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(data: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(QqImage, { data, sendTimeMs: 1000 })));
  return host;
}
it('时间线请求缩略图，灯箱区分本地原图、缩略图和主动下载', async () => {
  const host = await render({
    fileName: 'fixture.png',
    fileToken: 'fixture',
    imgWidth: 2000,
    imgHeight: 1000,
  });
  const image = host.querySelector('img')!;
  expect(new URL(image.src).searchParams.get('v')).toBe('thumb');
  expect(image.loading).toBe('lazy');
  expect(image.decoding).toBe('async');
  await act(async () => image.click());
  const item = state.open.mock.calls[0]![0].items[0];
  expect(new URL(item.src).searchParams.get('preview')).toBe('1');
  const local = new URL(item.originalImage.cachedSrc);
  expect(local.searchParams.get('v')).toBe('original');
  expect(local.searchParams.get('localOnly')).toBe('1');
  const original = new URL(item.originalImage.src);
  expect(original.searchParams.get('v')).toBe('original');
  expect(original.searchParams.has('localOnly')).toBe(false);
  expect(original.searchParams.get('token')).toBe('fixture');
});
it.each(['fixture.gif', 'fixture.png'])(
  '图片表情保留原始来源并可点击预览：%s',
  async (fileName) => {
    const host = await render({
      fileName,
      subType: 1,
      fileToken: 'fixture',
      imgWidth: 240,
      imgHeight: 240,
    });
    const image = host.querySelector('img')!;
    expect(new URL(image.src).searchParams.get('recv')).toBe('1');
    expect(new URL(image.src).searchParams.has('v')).toBe(false);
    await act(async () => image.click());
    expect(state.open).toHaveBeenCalledTimes(1);
    const item = state.open.mock.calls[0]![0].items[0];
    const original = new URL(item.src);
    expect(original.searchParams.get('recv')).toBe('1');
    expect(original.searchParams.has('v')).toBe(false);
    expect(original.searchParams.get('intent')).toBe('interactive');
    expect(item.ocr).toBeNull();
  },
);
it('本地图片预览直接加载，加载失败再回退到 QQ 缩略图', async () => {
  const host = await render({ localPath: '/synthetic/image.png', localPreviewUrl: 'blob:fixture' });
  const image = host.querySelector('img')!;
  expect(image.src).toBe('blob:fixture');
  expect(image.loading).toBe('eager');
  expect(host.querySelector('[aria-label="正在加载图片"]')).toBeNull();
  await act(async () => image.dispatchEvent(new Event('error')));
  const localFile = host.querySelector('img')!;
  expect(new URL(localFile.src).searchParams.get('path')).toBe('/synthetic/image.png');
  await act(async () => localFile.dispatchEvent(new Event('error')));
  expect(new URL(host.querySelector('img')!.src).searchParams.get('v')).toBe('thumb');
});

it('已回读的图片点开仍显示本地原图，保存时请求 QQ 原图', async () => {
  const host = await render({
    fileName: 'sent.png',
    fileToken: 'uploaded',
    localPreviewUrl: 'blob:sent-photo',
    thumbnailUrl: '/qq-thumb.png',
  });
  const image = host.querySelector('img')!;
  expect(image.src).toBe('blob:sent-photo');
  await act(async () => image.click());
  const item = state.open.mock.calls[0]![0].items[0];
  expect(item.src).toBe('blob:sent-photo');
  expect(new URL(item.saveSource.url).searchParams.get('v')).toBe('original');
});

it('缩略图损坏时回退原图，不直接显示缺图', async () => {
  const host = await render({ fileName: 'fixture.png', fileToken: 'fixture' });
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  const image = host.querySelector('img')!;
  expect(new URL(image.src).searchParams.has('v')).toBe(false);
  expect(host.textContent).not.toContain('未找到');
});

/**
 * 闪照：`fileToken` 是老式 offpic 路径（以 `/` 开头），三档 URL 与 contentHash
 * 全空，本地也没有原图。气泡画**固定封面**（灰阶马赛克 + 闪电），一张图都不加载；
 * 点开才现取 0 档原图。
 */
it('闪照气泡画固定封面、不加载任何图片，点开是 0 原图', async () => {
  const host = await render({
    fileName: '91CFB712BCDAB31C397F4CB5F226B718.jpg',
    fileToken: '/1707889225-1108524972-91CFB712BCDAB31C397F4CB5F226B718',
    imgWidth: 1440,
    imgHeight: 1920,
    fileSize: 153909,
  });
  const cover = host.querySelector('.qq-flash-cover')!;
  expect(cover).not.toBeNull();
  // 封面不是图片：连 198 预览都不拉，气泡里没有任何 <img>。
  expect(host.querySelector('img')).toBeNull();
  expect(host.innerHTML).not.toContain('flashpic');
  // 尺寸跟着元素里的宽高走（1440×1920 等比缩进 200×400 的框）。
  const style = (cover as HTMLElement).style;
  expect(style.width).toBe('200px');
  expect(style.height).toBe('267px');

  await act(async () => (cover as HTMLElement).click());
  expect(state.open).toHaveBeenCalledTimes(1);
  expect(state.open.mock.calls[0]![0].items[0].src).toContain('flashpic');
  expect(state.open.mock.calls[0]![0].items[0].src).toContain('spec=0');
  // 闪照不该再带一串回退源——点开就是要原图。
  expect(state.open.mock.calls[0]![0].items[0].fallbackSources).toBeUndefined();
});

it('元素带 isFlash 但拿不到 offpic token 时，封面点不开也不加载图', async () => {
  const host = await render({
    fileName: 'fixture.jpg',
    isFlash: true,
    imgWidth: 640,
    imgHeight: 480,
  });
  const cover = host.querySelector('.qq-flash-cover')!;
  expect(cover).not.toBeNull();
  expect(host.querySelector('img')).toBeNull();
  await act(async () => (cover as HTMLElement).click());
  expect(state.open).not.toHaveBeenCalled();
});

it('普通图片不会被打上闪照封面', async () => {
  const host = await render({
    fileName: 'fixture.png',
    fileToken: 'EhSFggR8RGn2BgoNWCKJxibUo0KvhBj2sgIg',
    imgWidth: 2000,
    imgHeight: 1000,
  });
  expect(host.querySelector('.qq-flash-cover')).toBeNull();
  expect(host.querySelector('img')).not.toBeNull();
});
