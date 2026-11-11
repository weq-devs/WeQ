import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContactMetricRows } from '@weq/service';
const metricState = vi.hoisted(() => ({ rows: {} as ContactMetricRows }));
vi.mock('../src/renderer/src/hooks/useContactDirectoryOrder', async () => {
  const order = await import('./support/contact-order.stub');
  return {
    ...order,
    useContactDirectoryOrder: (kind: string) => ({
      ...order.useContactDirectoryOrder(kind),
      rows: metricState.rows,
    }),
  };
});
import {
  ContactList,
  ConversationList,
} from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { sortConversationRows } from '../src/renderer/src/lib/conversationListOrder';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import {
  conversationActivityTime,
  conversationPinned,
  pinOrderDelta,
} from '@weq/service/conversation-order';

afterEach(() => {
  vi.unstubAllGlobals();
  metricState.rows = {};
});

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

it('切换会话和打开行菜单不重扫未变目录的选择 ID，目录更新仍接收新行', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const base = demo.conversations.find((row) => row.type === 'group')!;
  const count = 2000;
  let offscreenReads = 0;
  const rows = Array.from({ length: count }, (_, index) => ({
    ...base,
    get id() {
      if (index >= 100) offscreenReads++;
      return `synthetic-${String(index).padStart(4, '0')}`;
    },
    updatedAt: '2030-01-01T00:00:00Z',
    lastMessage: null,
    preference: { pinned: false, muted: false, blocked: false },
  }));
  const props = { conversations: rows, preferences: {}, drafts: {}, onSelect: vi.fn() };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (activeConversationId: string, conversations = rows) =>
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(ConversationList, { ...props, conversations, activeConversationId }),
        ),
      ),
    );
  try {
    render('synthetic-0000');
    expect(host.querySelectorAll('[data-conversation-id]').length).toBeLessThan(100);
    offscreenReads = 0;
    render('synthetic-0001');
    expect(offscreenReads).toBe(0);
    act(() =>
      host
        .querySelector('[data-conversation-id]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(offscreenReads).toBe(0);
    render('synthetic-new', [
      {
        ...base,
        id: 'synthetic-new',
        updatedAt: '2030-01-02T00:00:00Z',
        lastMessage: null,
        preference: { pinned: false, muted: false, blocked: false },
      },
      ...rows,
    ]);
    const added = host.querySelector<HTMLButtonElement>('[data-conversation-id="synthetic-new"]')!;
    expect(added).not.toBeNull();
    act(() => added.click());
    expect(props.onSelect.mock.calls.at(-1)?.[0]).toBe('synthetic-new');
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

it.each([Date.parse('2030-01-05'), Number.NaN, Number.POSITIVE_INFINITY, -100])(
  '主视图附加活动时间 %s 保留旧比较口径，单轮每行仅计算一次',
  (extra) => {
    const rows = [
      { id: 'a', updatedAt: 'invalid' },
      { id: 'b', updatedAt: '2030-01-01', activityTime: Date.parse('2030-01-02') },
      { id: 'c', updatedAt: '2030-01-01', lastMessage: { createdAt: '2030-01-04' } },
      { id: 'pinned', updatedAt: 'invalid', preference: { pinned: true } },
    ];
    const appearedAt: Record<string, number> = { b: extra };
    const expected = [...rows].sort((a, b) => {
      const pin = pinOrderDelta(conversationPinned(a), conversationPinned(b));
      return (
        pin ||
        Math.max(conversationActivityTime(b), appearedAt[b.id] ?? 0) -
          Math.max(conversationActivityTime(a), appearedAt[a.id] ?? 0) ||
        a.id.localeCompare(b.id)
      );
    });
    const time = vi.fn((row: (typeof rows)[number]) =>
      Math.max(conversationActivityTime(row), appearedAt[row.id] ?? 0),
    );
    const actual = sortConversationRows(rows, undefined, time);
    expect(actual).toEqual(expected);
    expect(time).toHaveBeenCalledTimes(rows.length);
    for (const [index, row] of actual.entries()) expect(row).toBe(expected[index]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'pinned']);
    time.mockClear();
    appearedAt.b = Date.parse('2030-01-06');
    expect(sortConversationRows(rows, undefined, time).map((row) => row.id)).toEqual([
      'pinned',
      'b',
      'c',
      'a',
    ]);
    expect(time).toHaveBeenCalledTimes(rows.length);
  },
);

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

it('展开好友目录只重画活动项和未读变化行，未重画的行仍调用最新选择回调', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const base = demo.contacts[0]!;
  const reads = new Map<string, number>();
  const contacts = Array.from({ length: 80 }, (_, index) => {
    const id = `synthetic-contact-${index}`;
    return {
      ...base,
      id,
      identityValue: String(10000 + index),
      categoryId: 0,
      get signature() {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return `签名 ${id}`;
      },
    };
  });
  const baseConversation = demo.conversations.find((row) => row.type === 'direct')!;
  const real = contacts.map((contact) => ({
    ...baseConversation,
    id: contact.id,
    otherUser: contact,
    unreadCount: 0,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  const row = (index: number) =>
    [...host.querySelectorAll<HTMLButtonElement>('.contact-row')].find(
      (element) => element.dataset.weqSelectionId === contacts[index]!.id,
    )!;
  const render = (activeContactId: string | null, revision: number, unread = false) =>
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(
            ConversationDirectoryContext.Provider,
            {
              value: {
                real: unread
                  ? real.map((row, index) => (index === 2 ? { ...row, unreadCount: 8 } : row))
                  : real,
                virtual: [],
                onVirtual: () => {},
                onCreate: () => {},
                showContactUnreadCount: true,
              },
            },
            createElement(ContactList, {
              contacts,
              activeContactId,
              onSelect: (contact) => onSelect(contact.id, revision),
            }),
          ),
        ),
      ),
    );
  try {
    render(contacts[0]!.id, 0);
    act(() => host.querySelector<HTMLButtonElement>('.contact-cat-header')!.click());
    expect(host.querySelectorAll('.contact-row')).toHaveLength(contacts.length);
    reads.clear();
    render(contacts[1]!.id, 1);
    expect([...reads.keys()].sort()).toEqual([contacts[0]!.id, contacts[1]!.id].sort());
    reads.clear();
    render(contacts[1]!.id, 2, true);
    expect([...reads.keys()]).toEqual([contacts[2]!.id]);
    expect(host.querySelector('.row-unread')?.textContent).toBe('8');
    act(() => row(3).click());
    expect(onSelect).toHaveBeenLastCalledWith(contacts[3]!.id, 2);
    reads.clear();
    act(() =>
      row(3).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(reads.size).toBe(0);
    metricState.rows = {
      'friend:unrelated': { level: { value: 8, state: 'ready', attemptedAt: 1 } },
    };
    render(contacts[1]!.id, 3, true);
    expect(reads.size).toBe(0);
    metricState.rows = { ...metricState.rows, [`friend:${contacts[3]!.id}`]: {} };
    render(contacts[1]!.id, 4, true);
    expect([...reads.keys()]).toEqual([contacts[3]!.id]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
