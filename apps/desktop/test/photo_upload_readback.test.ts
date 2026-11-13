import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePhotoUploadReadback } from '../src/renderer/src/hooks/usePhotoUploadReadback';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(refresh = vi.fn(async () => {})) {
  const root = createRoot(document.createElement('div'));
  let latest!: ReturnType<typeof usePhotoUploadReadback>;
  function Reader({ pending, available }: { pending: string[]; available: boolean }) {
    latest = usePhotoUploadReadback('synthetic-account:album', pending, available, refresh);
    return null;
  }
  const render = (pending = ['photo-1'], active = true, available = true) =>
    act(() => root.render(h(TabActivity, { active }, h(Reader, { pending, available }))));
  cleanups.push(() => act(() => root.unmount()));
  render();
  return { refresh, render, current: () => latest };
}
const advance = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it('上传后的缺失照片自动核对三次，耗尽后才提供重试，不无限轮询', async () => {
  const f = fixture();
  expect(f.current().exhausted).toBe(false);
  await advance(7000);
  expect(f.refresh).toHaveBeenCalledTimes(3);
  expect(f.current().exhausted).toBe(true);
  await advance(60_000);
  expect(f.refresh).toHaveBeenCalledTimes(3);
  act(() => f.current().retry());
  expect(f.current().exhausted).toBe(false);
  await advance(1000);
  expect(f.refresh).toHaveBeenCalledTimes(4);
});

it('相册已观察到照片后取消等待，不因普通重渲染重置计数', async () => {
  const f = fixture();
  await advance(1000);
  f.render();
  await advance(2000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  f.render([]);
  await advance(60_000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.current().exhausted).toBe(false);
});

it('切页、离线或上传仍在运行时停止读取，恢复可重新核对', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const f = fixture();
  f.render(['photo-1'], false);
  await advance(10_000);
  expect(f.refresh).not.toHaveBeenCalled();
  f.render();
  await advance(1000);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event('offline')));
  await advance(10_000);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event('online')));
  await advance(1000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  f.render(['photo-1'], true, false);
  await advance(10_000);
  expect(f.refresh).toHaveBeenCalledTimes(2);
});

it('读取失败仍有界，不重发上传；取消期间返回的旧请求不再安排下一次', async () => {
  const read = vi.fn(async () => {
    throw new Error('合成读取失败');
  });
  const f = fixture(read);
  await advance(7000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(f.current().exhausted).toBe(true);
  let resolve!: () => void;
  read.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  act(() => f.current().retry());
  await advance(1000);
  f.render([]);
  await act(async () => resolve());
  await advance(10_000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(f.current().exhausted).toBe(false);
});

it('恢复前台时复用尚未返回的核对请求，不并发重复读取', async () => {
  let resolve!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const f = fixture(refresh);
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  f.render(['photo-1'], false);
  f.render();
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  f.render([]);
  await advance(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});
