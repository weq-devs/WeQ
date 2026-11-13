import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CompositionWorkspace, MailWorkspace } from '../src/renderer/src/components/lazyMainPanels';

const fixture = vi.hoisted(() => ({
  mailLoaded: vi.fn(),
  compositionLoaded: vi.fn(),
  compositionReady: Promise.resolve(),
}));
vi.mock('../src/renderer/src/views/MailView', () => {
  fixture.mailLoaded();
  return { MailWorkspace: () => h('input', { 'aria-label': '邮箱草稿' }) };
});
vi.mock('../src/renderer/src/components/mergeForward/CompositionWorkspace', async () => {
  fixture.compositionLoaded();
  await fixture.compositionReady;
  return { CompositionWorkspace: () => h('input', { 'aria-label': '合成草稿' }) };
});
afterEach(() => vi.unstubAllGlobals());

it('未使用邮箱不加载正文，后台提醒仍可启动，离开后保留已有现场', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof MailWorkspace> = {
    active: false,
    selfUin: '10001',
    onUnreadChange: vi.fn(),
  };
  try {
    await act(async () => root.render(h(MailWorkspace, props)));
    expect(fixture.mailLoaded).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        h(MailWorkspace, { ...props, preferences: { showUnread: false, notifications: true } }),
      ),
    );
    expect(fixture.mailLoaded).toHaveBeenCalledOnce();
    const draft = host.querySelector('input')!;
    draft.value = '保留编辑内容';
    await act(async () => root.render(h(MailWorkspace, { ...props, active: true })));
    await act(async () => root.render(h(MailWorkspace, props)));
    expect(host.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('保留编辑内容');
  } finally {
    act(() => root.unmount());
  }
});

it('合成正文首次打开才加载，占位跟随所属窗口，关闭及重开保留状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let release = () => {};
  fixture.compositionReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const popup = new HappyWindow();
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof CompositionWorkspace> = {
    popup: null,
    fallback: false,
    self: { uid: 'synthetic', uin: '10001', name: '合成账号' },
    targets: [],
    sendAvailable: false,
    onClose: vi.fn(),
    onPopOut: vi.fn(),
    onForward: vi.fn(async () => {}),
    onSend: vi.fn(async () => {}),
    onOpenTarget: vi.fn(),
  };
  try {
    await act(async () => root.render(h(CompositionWorkspace, props)));
    expect(fixture.compositionLoaded).not.toHaveBeenCalled();
    await act(async () =>
      root.render(h(CompositionWorkspace, { ...props, popup: popup as unknown as Window })),
    );
    expect(fixture.compositionLoaded).toHaveBeenCalledOnce();
    expect(popup.document.querySelector('[data-weq-startup-pending]')).not.toBeNull();
    expect(host.querySelector('[data-weq-startup-pending]')).toBeNull();
    await act(async () => root.render(h(CompositionWorkspace, props)));
    expect(popup.document.querySelector('[data-weq-startup-pending]')).toBeNull();
    expect(host.querySelector('[data-weq-startup-pending]')).toBeNull();
    await act(async () => release());
    await act(async () => root.render(h(CompositionWorkspace, { ...props, fallback: true })));
    const draft = host.querySelector('input')!;
    draft.value = '保留合成内容';
    await act(async () => root.render(h(CompositionWorkspace, props)));
    await act(async () => root.render(h(CompositionWorkspace, { ...props, fallback: true })));
    expect(host.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('保留合成内容');
  } finally {
    release();
    act(() => root.unmount());
    popup.close();
  }
});
