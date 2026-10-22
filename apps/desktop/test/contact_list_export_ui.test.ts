import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import { initialContactScope } from '../src/renderer/src/views/export/exportScope';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
describe('联系人页面名单导出入口', () => {
  it.each(['friends', 'groups'] as const)('%s 页签可分别导出联系人或群聊名单', (contactTab) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Probe() {
      return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
    }
    try {
      const noop = vi.fn();
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(SidebarHeader, {
              user: createTemplateDemoData().user,
              view: 'contacts',
              query: '',
              onQueryChange: noop,
              onQuickInvite: noop,
              onCreateGroup: noop,
              onOpenProfile: noop,
              onOpenFriendNotices: noop,
              onOpenGroupNotices: noop,
              contactTab,
              onContactTabChange: noop,
              activeNotice: null,
            }),
            h(Probe),
          ),
        ),
      );
      for (const label of ['导出联系人名单', '导出群聊名单']) {
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="导出名单"]')!.click());
        const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (node) => node.textContent === label,
        )!;
        expect(button).toBeDefined();
        act(() => button.click());
        const selection = JSON.parse(host.querySelector('output')!.textContent!);
        expect(selection.owner).toEqual({
          kind: 'contacts',
          container: label === '导出联系人名单' ? 'friends' : 'group-list',
        });
        expect(selection.scope).toEqual({ type: 'all' });
        expect(initialContactScope(selection).scope).toBe(
          label === '导出联系人名单' ? 'friends' : 'groups',
        );
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
