import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { lazyPanel, lazyRetainedPanel } from '../src/renderer/src/lib/lazyPanel';

afterEach(() => vi.unstubAllGlobals());
it('模块等待首帧显示转圈，完成后移除占位且不重复请求', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (value: { default: () => ReturnType<typeof h> }) => void;
  const load = vi.fn(
    () => new Promise<{ default: () => ReturnType<typeof h> }>((resolve) => (finish = resolve)),
  );
  const Panel = lazyPanel(load);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Panel)));
    const loading = host.querySelector('[data-weq-startup-pending]');
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.querySelector('.weq-loading-indicator-spinner')).not.toBeNull();
    expect(loading?.textContent).toContain('正在加载');
    await act(async () => finish({ default: () => h('output', null, '已就绪') }));
    expect(host.textContent).toBe('已就绪');
    expect(host.querySelector('[data-weq-startup-pending]')).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

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

it('未加载的保留页切走即撤下占位，返回共用请求，加载后的现场继续保留', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const Content = ({ active }: { active?: boolean }) => h('input', { hidden: !active });
  const pending = Promise.withResolvers<{ default: typeof Content }>();
  const load = vi.fn(() => pending.promise);
  const Panel = lazyRetainedPanel(load);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (active: boolean) => act(async () => root.render(h(Panel, { active })));
  try {
    await render(false);
    expect(load).not.toHaveBeenCalled();
    await render(true);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('[data-weq-startup-pending]')).toBeNull();
    await render(false);
    expect(host.textContent).toBe('');
    await render(true);
    await act(async () => pending.resolve({ default: Content }));
    const field = host.querySelector('input')!;
    field.value = '保留草稿';
    await render(false);
    expect(field.hidden).toBe(true);
    await render(true);
    expect(host.querySelector('input')).toBe(field);
    expect(field.value).toBe('保留草稿');
    expect(load).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it('切离仍在加载的保留页后，迟到的加载失败不影响当前页', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const pending = Promise.withResolvers<{ default: (_: { active?: boolean }) => null }>();
  const Panel = lazyRetainedPanel(() => pending.promise);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (active: boolean) =>
    act(async () => root.render(h('main', null, h('p', null, '当前页'), h(Panel, { active }))));
  try {
    await render(true);
    await render(false);
    await act(async () => pending.reject(new Error('offline')));
    expect(host.textContent).toBe('当前页');
  } finally {
    await act(async () => root.unmount());
  }
});
