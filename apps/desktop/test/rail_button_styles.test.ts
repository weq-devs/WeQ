import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { WorkspaceMenuButton } from '../src/renderer/src/components/WorkspaceMenuButton';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { useUpdateStore } from '../src/renderer/src/state/update';

afterEach(() => {
  useWorkspaceMenu.setState({ anchor: null, running: 0, failed: 0 });
  useUpdateStore.setState({ available: false });
  vi.unstubAllGlobals();
});

describe('左栏统一按钮', () => {
  it('内容与菜单共用按钮类，角标保持独立命中，选中与展开语义不丢失', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useWorkspaceMenu.setState({ anchor: null, running: 2, failed: 0 });
    useUpdateStore.setState({ available: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const navigate = vi.fn(),
      unread = vi.fn(),
      noop = () => {};
    try {
      act(() =>
        root.render(
          h(
            'div',
            { className: 'app-shell' },
            h(AppRail, {
              user: createTemplateDemoData().user,
              view: 'messages',
              hideAvatar: true,
              onViewChange: navigate,
              messageBadgeCount: 12,
              contactBadgeCount: 1,
              mailBadgeCount: 3,
              onMessageBadgeClick: unread,
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
              footerContent: () => h(WorkspaceMenuButton),
            }),
          ),
        ),
      );
      for (const button of host.querySelectorAll('.rail-nav .rail-tab'))
        expect(button.classList.contains('weq-rail-button')).toBe(true);
      const message = host.querySelector<HTMLButtonElement>('.rail-tab-messages')!;
      expect(message.getAttribute('aria-current')).toBe('page');
      const contacts = host.querySelector<HTMLButtonElement>('.rail-tab-contacts')!;
      expect(contacts.querySelector('svg.lucide-users-round')).not.toBeNull();
      act(() => contacts.click());
      expect(navigate).toHaveBeenCalledWith('contacts');
      const badge = host.querySelector<HTMLButtonElement>('.rail-message-badge')!;
      expect(badge.classList.contains('weq-rail-button')).toBe(false);
      act(() => badge.click());
      expect(unread).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledTimes(1);
      const menu = host.querySelector<HTMLButtonElement>('.weq-workspace-menu-trigger')!;
      expect(menu.classList.contains('weq-rail-button')).toBe(true);
      expect(menu.classList.contains('weq-rail-control')).toBe(false);
      expect(menu.querySelector('.weq-workspace-dot')).not.toBeNull();
      expect(menu.querySelector('.weq-workspace-status-count.is-running')?.textContent).toBe('2');
      act(() => menu.click());
      expect(menu.getAttribute('aria-expanded')).toBe('true');
      expect(message.getAttribute('aria-current')).toBe('page');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
