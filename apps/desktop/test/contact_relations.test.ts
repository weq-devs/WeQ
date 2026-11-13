import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock(
  '../src/renderer/src/hooks/useContactDirectoryOrder',
  () => import('./support/contact-order.stub'),
);
import { ContactList } from '../src/renderer/src/im-template/template/conversationLists';
import type { Contact, Conversation } from '../src/renderer/src/im-template/template/types';
import { createTemplateDemoData } from './support/templateDemoData';
import { intimateRelationOf, relationMeta } from '../src/renderer/src/lib/profileRelations';
import {
  ContactDirectoryContext,
  ConversationDirectoryContext,
} from '../src/renderer/src/lib/conversationDirectory';

afterEach(() => vi.unstubAllGlobals());

function contact(id: number, displayId?: number, preselectedIds: number[] = []): Contact {
  return {
    id: `fixture-${id}`,
    username: `fixture-${id}`,
    identityLabel: 'QQ',
    identityValue: String(id),
    displayName: `测试好友 ${id}`,
    createdAt: new Date(0).toISOString(),
    extRelation: { displayId, preselectedIds },
  };
}

describe('联系人亲密关系', () => {
  it('群消息变化不重新绘制好友列表，好友未读变化仍更新', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let reads = 0;
    const person = {
      ...contact(10001),
      get displayName() {
        reads++;
        return '测试好友';
      },
    };
    const contacts = [person];
    const friend: Conversation = {
      id: person.id,
      type: 'direct',
      otherUser: person,
      group: null,
      members: [],
      updatedAt: '',
      lastMessage: null,
      unreadCount: 1,
    };
    const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const select = vi.fn(),
      onVirtual = vi.fn(),
      onCreate = vi.fn();
    const virtual: [] = [];
    const host = document.createElement('div'),
      root = createRoot(host);
    document.body.append(host);
    const render = (rows: Conversation[]) =>
      act(() =>
        root.render(
          h(
            ConversationDirectoryContext.Provider,
            { value: { real: rows, virtual, onVirtual, onCreate, showContactUnreadCount: true } },
            h(ContactList, { contacts, activeContactId: null, onSelect: select }),
          ),
        ),
      );
    try {
      render([friend, group]);
      act(() => host.querySelector<HTMLButtonElement>('.contact-cat-header')!.click());
      const before = reads;
      render([friend, { ...group, updatedAt: '2026-01-02T00:00:00Z' }]);
      expect(reads).toBe(before);
      render([{ ...friend, unreadCount: 2 }, group]);
      expect(reads).toBeGreaterThan(before);
      expect(host.querySelector('.row-unread')?.textContent).toBe('2');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it.each([1, 26, 2, 3])('识别当前亲密关系 %s，与资料卡使用同一名称和图标', (id) => {
    expect(intimateRelationOf(contact(id, id))).toBe(relationMeta(id));
  });

  it('不把预设选项、空壳、搭子、未知关系或亲密度当成已建立的亲密关系', () => {
    for (const displayId of [undefined, 0, 81, 82, 101, 999]) {
      expect(
        intimateRelationOf({ ...contact(1, displayId, [1, 2, 3, 26]), intimacy: 9999 }),
      ).toBeNull();
    }
    expect(intimateRelationOf({})).toBeNull();
    expect(intimateRelationOf({ extRelation: null })).toBeNull();
  });

  it('头像标志覆盖四类关系，分组可折叠、搜索并选择联系人', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const select = vi.fn();
    const contacts = [1, 26, 2, 3].map((id) => contact(id, id));
    const specialSections = [
      { id: 'special:care', name: '特别关心', items: [] },
      { id: 'special:intimate', name: '亲密关系', items: contacts },
    ];
    const render = (query = '') =>
      act(() =>
        root.render(
          h(
            ContactDirectoryContext.Provider,
            {
              value: { query, onQuery: vi.fn(), ids: contacts.map((item) => item.id) },
            },
            h(ContactList, { contacts, specialSections, activeContactId: null, onSelect: select }),
          ),
        ),
      );
    try {
      render();
      const headers = [...host.querySelectorAll<HTMLButtonElement>('.contact-cat-header')];
      expect(headers.map((item) => item.querySelector('.contact-cat-name')?.textContent)).toEqual([
        '特别关心',
        '我的好友',
      ]);
      expect(host.querySelector('.contact-relation-mark')).toBeNull();
      act(() => headers[1]!.click());
      for (const item of contacts) {
        const label = relationMeta(item.extRelation!.displayId!).label;
        const mark = host.querySelector(`[aria-label="亲密关系：${label}"]`);
        expect(mark?.getAttribute('title')).toBe(label);
        expect(mark?.parentElement?.querySelector('.avatar')).not.toBeNull();
        expect(mark?.querySelector('svg')).not.toBeNull();
      }
      act(() => host.querySelector<HTMLButtonElement>('.contact-row')!.click());
      expect(select).toHaveBeenCalledWith(contacts[0]);
      render('测试好友 26');
      expect(host.querySelectorAll('.contact-row')).toHaveLength(1);
      expect(host.querySelectorAll('[aria-label="亲密关系：死党"]')).toHaveLength(1);
      render();
      act(() => headers[1]!.click());
      expect(host.querySelector('.contact-relation-mark')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
