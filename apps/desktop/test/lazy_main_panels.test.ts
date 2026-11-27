import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CompositionWorkspace,
  MailWorkspace,
  MemberProfileCard,
} from '../src/renderer/src/components/lazyMainPanels';

const fixture = vi.hoisted(() => ({
  mailLoaded: vi.fn(),
  compositionLoaded: vi.fn(),
  compositionReady: Promise.resolve(),
  profileLoaded: vi.fn(),
  profileReady: Promise.resolve(),
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
vi.mock('../src/renderer/src/components/MemberProfileCard', async () => {
  fixture.profileLoaded();
  await fixture.profileReady;
  return { MemberProfileCard: () => h('section', { 'aria-label': '合成名片' }) };
});
afterEach(() => vi.unstubAllGlobals());

it('首次进入邮箱才加载页面，离开后保留已有现场', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof MailWorkspace> = {
    active: false,
    selfUin: '10001',
  };
  try {
    await act(async () => root.render(h(MailWorkspace, props)));
    expect(fixture.mailLoaded).not.toHaveBeenCalled();
    await act(async () => root.render(h(MailWorkspace, { ...props, active: true })));
    expect(fixture.mailLoaded).toHaveBeenCalledOnce();
    const draft = host.querySelector('input')!;
    draft.value = '保留编辑内容';
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
    expect(popup.document.querySelector('[role="status"]')).not.toBeNull();
    expect(popup.document.querySelector('[data-weq-startup-pending]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.render(h(CompositionWorkspace, props)));
    expect(popup.document.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
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

it('名片只有点击坐标时，加载提示仍跟随入口，加载后交给正式名片', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let release = () => {};
  fixture.profileReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const props: ComponentProps<typeof MemberProfileCard> = {
    member: {
      id: 'synthetic',
      username: 'synthetic',
      displayName: '合成成员',
      identityLabel: 'QQ',
      identityValue: '10001',
      avatarUrl: null,
    },
    anchor: { x: 120, y: 80 },
    onClose: vi.fn(),
  };
  try {
    await act(async () => root.render(h(MemberProfileCard, props)));
    expect(fixture.profileLoaded).toHaveBeenCalledOnce();
    const loading = document.querySelector<HTMLElement>('.weq-profile-loading')!.parentElement!;
    expect(loading.style.getPropertyValue('--weq-popover-left')).toBe('128px');
    expect(loading.style.getPropertyValue('--weq-popover-top')).toBe('80px');
    await act(async () =>
      root.render(h(MemberProfileCard, { ...props, anchor: { x: 240, y: 160 } })),
    );
    expect(loading.style.getPropertyValue('--weq-popover-left')).toBe('248px');
    expect(loading.style.getPropertyValue('--weq-popover-top')).toBe('160px');
    await act(async () => release());
    expect(loading.isConnected).toBe(false);
    expect(host.querySelector('[aria-label="合成名片"]')).not.toBeNull();
  } finally {
    release();
    act(() => root.unmount());
    host.remove();
  }
});
