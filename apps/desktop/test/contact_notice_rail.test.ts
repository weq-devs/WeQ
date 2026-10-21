import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';

afterEach(() => vi.unstubAllGlobals());

it('联系人入口显示通知红点而非数字，查看清除后移除', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = vi.fn();
  const render = (contactBadgeCount: number) =>
    act(() =>
      root.render(
        createElement(AppRail, {
          user: {
            id: 'u_self',
            username: 'u_self',
            identityLabel: 'QQ',
            identityValue: '10001',
            displayName: '自己',
            avatarUrl: null,
          },
          view: 'messages',
          onViewChange: noop,
          onOpenSettings: noop,
          onOpenCollection: noop,
          onOpenDressUp: noop,
          onOpenProfile: noop,
          onOpenAbout: noop,
          onOpenInvite: noop,
          onOpenWonderfulTools: noop,
          onOpenAntiRecall: noop,
          onOpenDbRepair: noop,
          onOpenQzoneAlbum: noop,
          contactBadgeCount,
        }),
      ),
    );
  try {
    render(2);
    const dot = host.querySelector('[aria-label="有新的好友或群通知"]');
    expect(dot?.classList.contains('rail-badge-dot')).toBe(true);
    expect(dot?.textContent).toBe('');
    render(0);
    expect(host.querySelector('[aria-label="有新的好友或群通知"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
