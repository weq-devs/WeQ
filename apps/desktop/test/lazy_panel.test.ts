import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { lazyPanel } from '../src/renderer/src/lib/lazyPanel';

afterEach(() => vi.unstubAllGlobals());
it('未打开页面不加载模块，预热与真正打开复用同一请求', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const load = vi.fn(async () => ({
    default: ({ label }: { label: string }) => h('output', null, label),
  }));
  const Panel = lazyPanel(load);
  expect(load).not.toHaveBeenCalled();
  await Promise.all([Panel.preload(), Panel.preload()]);
  expect(load).toHaveBeenCalledOnce();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Panel, { label: 'ready' })));
    expect(host.textContent).toBe('ready');
    expect(load).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
it('失败的导航预热可以重试，不缓存一次失败作为已加载', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ default: () => null });
  const Panel = lazyPanel(load);
  await expect(Panel.preload()).rejects.toThrow('offline');
  await Panel.preload();
  expect(load).toHaveBeenCalledTimes(2);
});
