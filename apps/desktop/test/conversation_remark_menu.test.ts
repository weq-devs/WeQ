import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ConversationDirectoryContext,
  virtualConversationRow,
} from '../src/renderer/src/lib/conversationDirectory';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: React.ReactNode }) => children,
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());
describe('会话右键备注入口', () => {
  it.each(['group', 'direct', 'virtual'] as const)(
    '%s 仅实际 QQ 好友／群可打开备注编辑',
    (kind) => {
      const demo = createTemplateDemoData().conversations;
      const group = demo.find((row) => row.type === 'group')!;
      const friend = demo.find((row) => row.type === 'direct')!;
      const virtual = {
        id: 'virtual:persona:a',
        kind: 'persona' as const,
        ownerId: 'a',
        name: '虚拟会话',
      };
      const row: Conversation =
        kind === 'group'
          ? { ...group, id: '123', group: { ...group.group, id: '123' } }
          : kind === 'direct'
            ? { ...friend, id: 'u_peer', otherUser: { ...friend.otherUser, id: 'u_peer' } }
            : virtualConversationRow(virtual);
      const edit = vi.fn(),
        select = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      try {
        act(() =>
          root.render(
            h(
              ContentSelectionProvider,
              null,
              h(
                ConversationDirectoryContext.Provider,
                {
                  value: {
                    virtual: kind === 'virtual' ? [virtual] : [],
                    onVirtual: vi.fn(),
                    onCreate: vi.fn(),
                    onEditRemark: edit,
                  },
                },
                h(ConversationList, {
                conversations: kind === 'virtual' ? [] : [row],
                  activeConversationId: null,
                  preferences: {},
                  drafts: {},
                  onSelect: select,
                }),
              ),
            ),
          ),
        );
        act(() =>
          host
            .querySelector('[data-conversation-id]')!
            .dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 60 }),
            ),
        );
        const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (node) => node.textContent?.includes('修改'),
        );
        if (kind === 'virtual') expect(button).toBeUndefined();
        else {
          expect(button?.textContent).toContain(kind === 'group' ? '修改群备注' : '修改好友备注');
          act(() => button!.click());
          expect(edit).toHaveBeenCalledWith(row);
        }
        expect(select).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
});
