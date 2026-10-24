import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QqImage } from '../src/renderer/src/components/QqMedia';

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/renderer/src/components/ImageLightbox', () => ({ openLightbox: state.open }));
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
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
  expect(host.querySelector('img')!.src).toContain('localfile');
});

it('缩略图损坏时回退原图，不直接显示缺图', async () => {
  const host = await render({ fileName: 'fixture.png', fileToken: 'fixture' });
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  const image = host.querySelector('img')!;
  expect(new URL(image.src).searchParams.has('v')).toBe(false);
  expect(host.textContent).not.toContain('未找到');
});
