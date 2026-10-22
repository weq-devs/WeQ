import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QrImage } from '../src/renderer/src/components/QrImage';
const api = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toString: api.generate } }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.generate.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(url: string) {
  await act(async () => root.render(createElement(QrImage, { url, size: 154 })));
}
it('新目标生成期间不显示旧二维码，晚到的旧结果不覆盖当前目标', async () => {
  const pending = new Map<string, (value: string) => void>();
  api.generate.mockImplementation(
    (url: string) => new Promise<string>((resolve) => pending.set(url, resolve)),
  );
  await render('synthetic:first');
  await act(async () => pending.get('synthetic:first')!('<svg data-first="true"/>'));
  expect(host.querySelector('img')).not.toBeNull();
  await render('synthetic:second');
  expect(host.querySelector('img')).toBeNull();
  await render('synthetic:third');
  await act(async () => pending.get('synthetic:second')!('<svg data-second="true"/>'));
  expect(host.querySelector('img')).toBeNull();
  await act(async () => pending.get('synthetic:third')!('<svg data-third="true"/>'));
  expect(decodeURIComponent(host.querySelector('img')!.src)).toContain('data-third');
});
it('一次生成失败后换目标可以恢复，不保留过时错误', async () => {
  api.generate
    .mockRejectedValueOnce(Error('合成生成失败'))
    .mockResolvedValueOnce('<svg data-ready="true"/>');
  await render('synthetic:bad');
  expect(host.textContent).toContain('合成生成失败');
  await render('synthetic:ready');
  expect(host.querySelector('img')).not.toBeNull();
  expect(host.textContent).not.toContain('合成生成失败');
});

it('同一目标的尺寸变化也要等待对应的新结果', async () => {
  let finish: ((value: string) => void) | undefined;
  api.generate.mockResolvedValueOnce('<svg data-small="true"/>').mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await render('synthetic:same');
  await act(async () => root.render(createElement(QrImage, { url: 'synthetic:same', size: 192 })));
  expect(host.querySelector('img')).toBeNull();
  await act(async () => finish!('<svg data-large="true"/>'));
  expect(host.querySelector('img')!.style.width).toBe('192px');
  expect(decodeURIComponent(host.querySelector('img')!.src)).toContain('data-large');
});
