import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContactList,
  ConversationList,
} from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { sortConversationRows } from '../src/renderer/src/lib/conversationListOrder';

afterEach(() => vi.unstubAllGlobals());

it('大目录排序每条会话只读取一次时间键，不在每次比较中重读', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const count = 2000;
  let reads = 0,
    latest = '';
  const rows = Array.from({ length: count }, (_, index) => {
    const rank = (index * 137) % count;
    const id = `synthetic-${index}`;
    if (rank === count - 1) latest = id;
    const updatedAt = new Date(Date.UTC(2030, 0, 1) + rank * 1000).toISOString();
    return {
      ...base,
      id,
      lastMessage: null,
      preference: { pinned: false, muted: false, blocked: false },
      get updatedAt() {
        reads++;
        return updatedAt;
      },
    };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(ConversationList, {
            conversations: rows,
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: () => {},
          }),
        ),
      ),
    );
    expect(host.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')).toBe(
      latest,
    );
    expect(reads).toBeLessThanOrEqual(count + 100);
    expect(host.querySelectorAll('[data-conversation-id]').length).toBeLessThan(100);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('保留置顶权威状态、草稿活动、最后消息与无效时间的排序口径', () => {
  const rows = [
    { id: 'a', updatedAt: 'invalid' },
    { id: 'b', updatedAt: '2030-01-01', lastMessage: { createdAt: '2030-01-03' } },
    { id: 'c', updatedAt: '2030-01-02', activityTime: Date.parse('2030-01-04') },
    { id: 'd', updatedAt: 'invalid', preference: { pinned: true } },
    { id: 'e', updatedAt: '2030-01-05', pinStateKnown: true, preference: { pinned: false } },
    { id: 'f', updatedAt: '2030-01-02', preference: { pinned: false } },
  ];
  expect(
    sortConversationRows(rows, { e: { pinned: true }, f: { pinned: true } }).map((row) => row.id),
  ).toEqual(['f', 'd', 'e', 'c', 'b', 'a']);
  expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

it('同时间按 ID 排序，重复 ID 不丢行且保留原始先后和对象引用', () => {
  const rows = ['b', 'a', 'a'].map((id, index) => ({ id, index, updatedAt: '2030-01-01' }));
  const result = sortConversationRows(rows);
  expect(result).toEqual([rows[1], rows[2], rows[0]]);
  expect(result[0]).toBe(rows[1]);
  expect(result[1]).toBe(rows[2]);
});

it('再次调用读取最新对象值与偏好，不使用跨轮次的过期缓存', () => {
  const rows = [
    { id: 'a', updatedAt: '2030-01-01' },
    { id: 'b', updatedAt: '2030-01-02' },
  ];
  expect(sortConversationRows(rows)[0]).toBe(rows[1]);
  rows[0]!.updatedAt = '2030-01-03';
  expect(sortConversationRows(rows)[0]).toBe(rows[0]);
  expect(sortConversationRows(rows, { b: { pinned: true } })[0]).toBe(rows[1]);
});

it.each([false, true])(
  '联系人切换活动项不重新扫描稳定分组和选择索引，传入空分组：%s',
  (explicit) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const base = createTemplateDemoData().contacts[0]!;
    let categoriesRead = 0,
      idsRead = 0;
    const contacts = Array.from({ length: 2000 }, (_, index) => ({
      ...base,
      get id() {
        idsRead++;
        return `synthetic-contact-${index}`;
      },
      get categoryId() {
        categoriesRead++;
        return 0;
      },
    }));
    const empty: [] = [];
    const options = explicit
      ? { categoryDefinitions: empty, specialSections: empty, trailingSections: empty }
      : {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (activeContactId: string) =>
      act(() =>
        root.render(
          createElement(
            ContentSelectionProvider,
            null,
            createElement(ContactList, {
              contacts,
              activeContactId,
              onSelect: () => {},
              ...options,
            }),
          ),
        ),
      );
    try {
      render('synthetic-contact-0');
      categoriesRead = 0;
      idsRead = 0;
      render('synthetic-contact-1');
      expect(host.querySelector('.contact-cat-count')?.textContent).toBe('2000');
      expect(categoriesRead).toBe(0);
      expect(idsRead).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('新的联系人快照会重新归类，不保留旧分组缓存', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const base = createTemplateDemoData().contacts[0]!;
  let contacts = [
    { ...base, id: 'a', categoryId: 0 },
    { ...base, id: 'b', categoryId: 1, categoryName: '其他' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(ContactList, { contacts, activeContactId: null, onSelect: () => {} }),
        ),
      ),
    );
  try {
    render();
    expect(host.querySelectorAll('.contact-cat-header')).toHaveLength(2);
    contacts = contacts.map((contact) => ({ ...contact, categoryId: 1, categoryName: '其他' }));
    render();
    expect(host.querySelectorAll('.contact-cat-header')).toHaveLength(1);
    expect(host.querySelector('.contact-cat-count')?.textContent).toBe('2');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
