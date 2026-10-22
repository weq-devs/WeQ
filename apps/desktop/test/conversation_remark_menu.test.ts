import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { chatHeaderTitle } from '../src/renderer/src/im-template/template/conversationDisplay';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ConversationDirectoryContext,
  virtualConversationRow,
} from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import {
  initialContactScope,
  initialExportMode,
} from '../src/renderer/src/views/export/exportScope';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../src/renderer/src/hooks/useFriendSpecialCare', () => ({
  useFriendSpecialCare: () => ({ enabled: false, disabled: false, change: vi.fn() }),
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());
describe('会话右键备注入口', () => {
  it('群备注同步标题和列表，真实群名仍可搜索，清空后恢复真实群名', () => {
    const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const originalName = group.group.name;
    const row = { ...group, group: { ...group.group, remark: '新群备注' } };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (remark: string) =>
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(ConversationList, {
              conversations: [{ ...row, group: { ...row.group, remark } }],
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
          ),
        ),
      );
    try {
      render('新群备注');
      expect(host.querySelector('.row-title-text')?.textContent).toBe('新群备注');
      expect(chatHeaderTitle(row)).toBe(`新群备注 (${group.group.memberCount})`);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="搜索会话"]')!.click());
      const input = host.querySelector<HTMLInputElement>('[aria-label="搜索会话名称或号码"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          originalName,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.querySelector('.row-title-text')?.textContent).toBe('新群备注');
      render('');
      expect(host.querySelector('.row-title-text')?.textContent).toBe(originalName);
      expect(row.group.name).toBe(originalName);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('群聊右键名单导出使用成员名单范围，不导出聊天消息或其他群', () => {
    const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const row = { ...group, id: '123', group: { ...group.group, id: '123' } };
    function Probe() {
      return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(ConversationList, {
              conversations: [row],
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
            h(Probe),
          ),
        ),
      );
      act(() =>
        host
          .querySelector('[data-conversation-id]')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }),
          ),
      );
      const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === '导出群成员名单',
      )!;
      expect(button).toBeDefined();
      act(() => button.click());
      const selection = JSON.parse(host.querySelector('output')!.textContent!);
      expect(selection).toEqual({
        owner: { kind: 'contacts', container: 'group:123' },
        scope: { type: 'all' },
      });
      expect(initialExportMode(selection)).toBe('contacts');
      expect(initialContactScope(selection)).toEqual({
        scope: 'group',
        groupIds: ['123'],
        memberUids: {},
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
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
