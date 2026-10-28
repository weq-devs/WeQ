import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelView } from '../src/renderer/src/views/ChannelView';

vi.mock('../src/renderer/src/components/GuildDirectDialog', () => ({
  GuildDirectDialog: ({ onClose }: { onClose: () => void }) =>
    h('button', { onClick: onClose, 'aria-label': '关闭频道私聊' }, '频道私聊面板'),
}));
vi.mock('../src/renderer/src/views/EmbeddedBrowserView', () => ({
  EmbeddedBrowserView: () => h('div', null, '频道浏览页'),
}));
vi.mock('../src/renderer/src/views/ExternalSiteView', () => ({
  ExternalSiteView: () => h('div', null, '外部频道页'),
}));
afterEach(() => vi.unstubAllGlobals());

it('搜索频道私聊能展开面板，关闭后重复搜索仍能重新展开', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selfUser = {
    id: 'self',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: 'fixture',
    displayName: '测试',
    avatarUrl: null,
  };
  const render = (request: number) =>
    act(() => root.render(h(ChannelView, { selfUser, directOpenRequest: request })));
  try {
    render(0);
    expect(host.textContent).not.toContain('频道私聊面板');
    render(1);
    expect(host.textContent).toContain('频道私聊面板');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭频道私聊"]')!.click());
    expect(host.textContent).not.toContain('频道私聊面板');
    render(2);
    expect(host.textContent).toContain('频道私聊面板');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
