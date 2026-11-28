import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeElement, ElementType } from '@weq/codec';
import { toRenderElements } from '@weq/service';
import { QqImage, QqMarketFace } from '../src/renderer/src/components/QqMedia';
import { useDataSaver } from '../src/renderer/src/lib/dataSaver';

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/renderer/src/components/mediaPreviewStore', () => ({
  openMediaPreview: state.open,
}));
vi.mock('../src/renderer/src/components/mediaPreviewStore.shared', () => ({
  openMediaPreview: state.open,
}));
const roots: ReturnType<typeof createRoot>[] = [];
const initialPolicy = useDataSaver.getState();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  useDataSaver.setState(initialPolicy);
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function renderNode(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}
function render(data: Record<string, unknown>, sendTimeMs = 1000) {
  return renderNode(createElement(QqImage, { data, sendTimeMs }));
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
  await act(async () => image.dispatchEvent(new Event('load')));
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
    await act(async () => image.dispatchEvent(new Event('load')));
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

it('省流量下优先显示 QQ 回读中已有的本地发送图片', async () => {
  useDataSaver.setState({ enabled: true });
  const [element] = toRenderElements([
    decodeElement({
      elementType: ElementType.PIC,
      isSender: true,
      fileName: 'sent.png',
      localPath: '::NTOSFull::/synthetic/nt_data/Pic/sent.png',
      thumbnailUrl: '/qq-thumb.png',
    }),
  ]);
  const host = await render(element!.data as Record<string, unknown>);
  const image = host.querySelector('img')!;
  expect(new URL(image.src).searchParams.get('path')).toBe('/synthetic/nt_data/Pic/sent.png');
  await act(async () => image.dispatchEvent(new Event('error')));
  const fallback = new URL(host.querySelector('img')!.src);
  expect(fallback.searchParams.get('small')).toBe('/qq-thumb.png');
  expect(fallback.searchParams.get('ds')).toBe('1');
  expect(fallback.searchParams.has('intent')).toBe(false);
});

it('加载某张自定义表情后，其他消息用省流量请求重新检查本地缓存', async () => {
  useDataSaver.setState({ enabled: true });
  const md5 = 'ab'.repeat(16);
  const first = await render({ subType: 1, md5, fileToken: 'first' });
  const failed = await render(
    { subType: 1, fileName: `${md5.toUpperCase()}.gif`, fileToken: 'second' },
    2000,
  );
  const pending = await render({ subType: 1, md5, fileToken: 'third' }, 3000);
  const different = await render({ subType: 1, md5: 'cd'.repeat(16), fileToken: 'other' }, 4000);
  await act(async () => {
    first.querySelector('img')!.dispatchEvent(new Event('error'));
    failed.querySelector('img')!.dispatchEvent(new Event('error'));
    different.querySelector('img')!.dispatchEvent(new Event('error'));
  });
  await act(async () => first.querySelector('button')!.click());
  await act(async () => first.querySelector('img')!.dispatchEvent(new Event('load')));
  for (const element of [failed, pending]) {
    const url = new URL(element.querySelector('img')!.src);
    expect(url.searchParams.get('ds')).toBe('1');
    expect(url.searchParams.has('_weq_retry')).toBe(true);
    expect(url.searchParams.has('intent')).toBe(false);
  }
  expect(different.querySelector('img')).toBeNull();
});

it('手动加载的商城表情会刷新另一条消息里的同款表情', async () => {
  useDataSaver.setState({ enabled: true });
  const data = { emojiPackId: 123, marketEmoticonIdHex: 'abc' };
  const first = await renderNode(createElement(QqMarketFace, { data }));
  const second = await renderNode(createElement(QqMarketFace, { data }));
  await act(async () => {
    first.querySelector('img')!.dispatchEvent(new Event('error'));
    second.querySelector('img')!.dispatchEvent(new Event('error'));
  });
  await act(async () => first.querySelector('button')!.click());
  await act(async () => first.querySelector('img')!.dispatchEvent(new Event('load')));
  const url = new URL(second.querySelector('img')!.src);
  expect(url.searchParams.has('_weq_retry')).toBe(true);
  expect(url.searchParams.has('intent')).toBe(false);
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
  await act(async () => image.dispatchEvent(new Event('load')));
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

const offpicToken = '/12345-45678-00112233445566778899AABBCCDDEEFF';

it('闪照气泡画固定封面、不加载任何图片，点开是 0 原图', async () => {
  const host = await render({
    fileName: 'fixture.jpg',
    fileToken: offpicToken,
    isFlash: true,
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

it('使用同一 offpic 格式的普通图片仍经图片代理渲染', async () => {
  const originalUrl = `/offpic_new/43210/${offpicToken}/0?term=2&is_origin=1`;
  const host = await render({
    fileName: 'fixture.png',
    fileToken: offpicToken,
    originalUrl,
    imgWidth: 2112,
    imgHeight: 134,
  });
  expect(host.querySelector('.qq-flash-cover')).toBeNull();
  const source = new URL(host.querySelector('img')!.src);
  expect(source.hostname).toBe('pic');
  expect(source.searchParams.get('orig')).toBe(originalUrl);
});
