import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QqImage } from '../src/renderer/src/components/QqMedia';

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/renderer/src/components/ImageLightbox', () => ({ openLightbox: state.open }));
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
it('时间线请求缩略图，打开灯箱仍请求原图', async () => {
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
  const original = new URL(state.open.mock.calls[0]![0]);
  expect(original.searchParams.has('v')).toBe(false);
  expect(original.searchParams.get('token')).toBe('fixture');
});
it('动画表情不切换成静态缩略图，也不打开原图灯箱', async () => {
  const host = await render({ fileName: 'fixture.gif', subType: 1 });
  const image = host.querySelector('img')!;
  expect(new URL(image.src).searchParams.get('recv')).toBe('1');
  expect(new URL(image.src).searchParams.has('v')).toBe(false);
  await act(async () => image.click());
  expect(state.open).not.toHaveBeenCalled();
});
it('编辑器本地预览仍优先使用本地资源', async () => {
  const host = await render({ localPath: '/synthetic/image.png', localPreviewUrl: 'blob:fixture' });
  expect(host.querySelector('img')!.src).toBe('blob:fixture');
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
 * 全空，本地也没有原图。气泡走 198 预览并打码，点开给 0 原图。
 */
it('闪照用 offpic 的 198 预览打码显示，点开是 0 原图', async () => {
  const host = await render({
    fileName: '91CFB712BCDAB31C397F4CB5F226B718.jpg',
    fileToken: '/1707889225-1108524972-91CFB712BCDAB31C397F4CB5F226B718',
    imgWidth: 1440,
    imgHeight: 1920,
    fileSize: 153909,
  });
  const image = host.querySelector('img')!;
  // 渲染进程不直连 offpic（会被 CORS 挡），统一走主进程代理。
  expect(image.src).toContain('flashpic');
  expect(image.src).toContain('spec=198');
  expect(image.src).not.toContain('c2cpicdw.qpic.cn');
  // 打码只作用于气泡里的缩略图，不是灯箱。
  expect(image.className).toContain('qq-media-flash');
  expect(host.querySelector('.qq-media-wrap-flash')).not.toBeNull();

  await act(async () => image.click());
  expect(state.open).toHaveBeenCalledTimes(1);
  expect(state.open.mock.calls[0]![0]).toContain('flashpic');
  expect(state.open.mock.calls[0]![0]).toContain('spec=0');
  // 闪照不该再带一串回退源——点开就是要原图。
  expect(state.open.mock.calls[0]![5]).toBeUndefined();
});

it('普通图片不会被打上闪照样式', async () => {
  const host = await render({
    fileName: 'fixture.png',
    fileToken: 'EhSFggR8RGn2BgoNWCKJxibUo0KvhBj2sgIg',
    imgWidth: 2000,
    imgHeight: 1000,
  });
  expect(host.querySelector('img')!.className).not.toContain('qq-media-flash');
  expect(host.querySelector('.qq-media-wrap-flash')).toBeNull();
});

it('闪照缩略图取不到时回退到代理路径，不直接判缺图', async () => {
  const host = await render({
    fileName: 'fixture.jpg',
    fileToken: '/1707889225-1108524972-91CFB712BCDAB31C397F4CB5F226B718',
    imgWidth: 1440,
    imgHeight: 1920,
  });
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  const image = host.querySelector('img')!;
  expect(image.src).not.toContain('flashpic');
  expect(new URL(image.src).searchParams.get('token')).toBe(
    '/1707889225-1108524972-91CFB712BCDAB31C397F4CB5F226B718',
  );
  expect(host.textContent).not.toContain('未找到');
});
