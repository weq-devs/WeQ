import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { expect, it, vi } from 'vitest';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { APP_NAVIGATION } from '../src/renderer/src/lib/appNavigation';

it.each(['friends', 'groups'] as const)(
  '群交集固定在 %s 目录顶部通知之后，不属于资料操作',
  (contactTab) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    const root = createRoot(host);
    const open = vi.fn();
    try {
      act(() =>
        root.render(
          h(SidebarHeader, {
            user: {
              id: 'self',
              username: 'self',
              displayName: '我',
              identityLabel: 'QQ',
              identityValue: '10001',
              avatarUrl: null,
            },
            view: 'contacts',
            query: '',
            onQueryChange: vi.fn(),
            onOpenProfile: vi.fn(),
            onOpenFriendNotices: vi.fn(),
            onOpenGroupNotices: vi.fn(),
            onOpenContactOverview: open,
            contactOverviewActive: true,
            contactTab,
            onContactTabChange: vi.fn(),
            activeNotice: null,
            showSearch: false,
          }),
        ),
      );
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('.contact-notice-row > button')];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        APP_NAVIGATION['friend-notice'].label,
        APP_NAVIGATION['group-notice'].label,
        APP_NAVIGATION['group-intersection'].label,
      ]);
      expect(buttons[2]?.getAttribute('aria-current')).toBe('page');
      act(() => buttons[2]!.click());
      expect(open).toHaveBeenCalledOnce();
      expect(host.querySelectorAll('[title="群交集"]')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
