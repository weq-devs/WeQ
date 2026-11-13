import { act, createElement as h, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  ConversationDirectoryContext,
  virtualConversationRow,
} from '../src/renderer/src/lib/conversationDirectory';
import {
  assistantConversationRow,
  generatedAggregateRow,
} from '../src/renderer/src/lib/conversationDirectoryRows';
import {
  conversationViewRows,
  type ConversationView,
  type ConversationViewDirectory,
} from '../src/renderer/src/lib/conversationViews';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';
import { createTemplateDemoData } from './support/templateDemoData';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../src/renderer/src/im-template/template/shellController';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
let root: Root;
let host: HTMLDivElement;
const roaming = vi.fn();
const remove = vi.fn(async () => {});
const exportBatch = vi.fn();
const createAssistant = vi.fn();
const pin = vi.fn();
const clone = virtualConversationRow({
  id: 'virtual:persona:p1',
  kind: 'persona',
  ownerId: 'p1',
  name: '合成克隆',
});
const assistant = assistantConversationRow({ id: 's1', title: '合成助手对话', updatedAt: 12345 });
const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const group: Conversation = {
  ...base,
  id: '12345',
  group: { ...base.group, id: '12345', name: '分类内的群' },
};
const ordinary: Conversation = {
  ...group,
  id: '23456',
  group: { ...group.group, id: '23456', name: '普通群' },
};
const helper: Conversation = {
  ...generatedAggregateRow('clone', []),
  id: 'merged:group-assistant',
  mergedKind: 'groupAssistant',
  title: '群助手',
};
const directory: ConversationViewDirectory = {
  regular: [
    ordinary,
    helper,
    generatedAggregateRow('clone', [clone]),
    generatedAggregateRow('assistant', [assistant]),
  ],
  groupAssistant: [group],
  official: [],
  service: [],
  guild: [],
  hidden: [{ ...ordinary, id: '34567', hidden: true }],
  deleted: [],
  clone: [clone],
  assistant: [assistant],
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function Probe() {
  return h('output', { 'data-selection': '' }, JSON.stringify(useCurrentContentSelection()));
}
function Fixture({ initialView = 'regular' }: { initialView?: ConversationView }) {
  const [view, setView] = useState(initialView);
  const [back, setBack] = useState(false);
  const [chat, setChat] = useState('原先打开的聊天');
  const rows = useMemo(
    () => conversationViewRows(directory, view, { includeHidden: false, includeDeleted: false }),
    [view],
  );
  const value = useMemo(
    () => ({
      view,
      rows,
      views: directory,
      virtual: [],
      returnToRegular: back,
      onViewChange: (next: ConversationView, aggregate = false) => {
        setBack(aggregate && view === 'regular');
        setView(next);
      },
      onReturnToRegular: () => {
        setView('regular');
        setBack(false);
      },
      onVirtual: () => {},
      onCreate: () => {},
      onCreateGroup: () => {},
      onCreateAssistant: createAssistant,
      onPin: pin,
      onExportBatch: exportBatch,
      onDelete: remove,
      onRoaming: roaming,
      onReadState: () => {},
    }),
    [view, rows, back],
  );
  return h(
    ContentSelectionProvider,
    null,
    h(
      ConversationDirectoryContext.Provider,
      { value },
      h(ConversationList, {
        conversations: rows,
        activeConversationId: null,
        preferences: {},
        drafts: {},
        onSelect: setChat,
      }),
      h('output', { 'data-chat': '' }, chat),
      h(Probe),
    ),
  );
}
const click = (selector: string) => {
  const node = host.querySelector<HTMLButtonElement>(selector);
  expect(node, selector).not.toBeNull();
  act(() => node!.click());
};
const selected = (): string[] => {
  const value = JSON.parse(host.querySelector('[data-selection]')!.textContent!);
  return value?.scope.ids ?? [];
};
it('聚合入口不进入全选或反选，点击只切列表且保留右侧聊天', () => {
  act(() => root.render(h(Fixture)));
  click('[aria-label="多选会话"]');
  click('[aria-label="全选当前结果"]');
  expect(selected()).toEqual([ordinary.id]);
  click('[aria-label="反选当前结果"]');
  expect(selected()).toEqual([]);
  click('[data-conversation-id="merged:group-assistant"]');
  expect(host.querySelector('[data-conversation-id="12345"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="返回常规视图"]')).not.toBeNull();
  expect(host.querySelector('[data-chat]')!.textContent).toBe('原先打开的聊天');
  expect(selected()).toEqual([]);
  for (const label of ['搜索会话', '多选会话', '添加会话'])
    expect(host.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  click('[aria-label="返回常规视图"]');
  expect(host.querySelector('[data-conversation-id="merged:group-assistant"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="会话视图"]')).not.toBeNull();
});
it('菜单直接切换保留视图菜单，所有视图的新建菜单固定五项', () => {
  act(() => root.render(h(Fixture)));
  click('[aria-label="会话视图"]');
  expect(host.querySelectorAll('[role="menuitemradio"]')).toHaveLength(10);
  const target = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (node) => node.textContent === 'WeQ 助手会话',
  )!;
  act(() => target.click());
  expect(host.querySelector('[aria-label="返回常规视图"]')).toBeNull();
  expect(host.querySelector('[data-conversation-id="assistant:s1"]')).not.toBeNull();
  click('[aria-label="添加会话"]');
  expect([...host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toEqual([
    '新建好友克隆',
    '新建克隆体群聊',
    'QQ 号搜索',
    '群号搜索',
    '新建 WeQ 助手会话',
  ]);
  act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].at(-1)!.click());
  expect(createAssistant).toHaveBeenCalledOnce();
});
it('助手视图只展示导出和永久删除，未选对象时保留禁用及原因', () => {
  act(() => root.render(h(Fixture, { initialView: 'assistant' })));
  click('[aria-label="多选会话"]');
  const toolbar = host.querySelector('[aria-label="会话多选操作"]')!;
  expect(toolbar.querySelectorAll('button')).toHaveLength(2);
  const del = toolbar.querySelector<HTMLButtonElement>('[aria-label="永久删除所选 AI 会话"]')!;
  expect(del.disabled).toBe(true);
  expect(del.title).toBe('请先选择会话');
  click('[aria-label="全选当前结果"]');
  expect(del.disabled).toBe(false);
  act(() => del.click());
  expect(remove).toHaveBeenCalledWith([assistant]);
});
it('克隆单会话保留原有本地置顶能力，不借用 QQ 目标', () => {
  act(() => root.render(h(Fixture, { initialView: 'clone' })));
  act(() =>
    host
      .querySelector('[data-conversation-id="virtual:persona:p1"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })),
  );
  const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === '置顶',
  );
  expect(action).toBeDefined();
  act(() => action!.click());
  expect(pin).toHaveBeenCalledWith(clone, true);
});
it.each([false, true])(
  '自动选择只选具体会话，目录只有聚合入口时不打开聊天：%s',
  (onlyAggregate) => {
    const read = vi.fn();
    function Shell() {
      const shell = useChatShellController({
        conversations: onlyAggregate ? [helper] : [helper, ordinary],
        contacts: [],
        conversationPrefs: {},
        initialActiveConversationId: null,
        initialView: 'home',
        sidebarWidthStorageKey: 'fixture-sidebar',
        history: noopChatShellHistoryAdapter,
        onReadConversation: read,
      });
      return h(
        'div',
        null,
        h(
          'button',
          { onClick: () => shell.switchView('messages'), 'data-open-messages': '' },
          '消息',
        ),
        h('output', { 'data-open-conversation': '' }, shell.activeConversationId ?? 'none'),
      );
    }
    act(() => root.render(h(Shell)));
    click('[data-open-messages]');
    expect(host.querySelector('[data-open-conversation]')!.textContent).toBe(
      onlyAggregate ? 'none' : ordinary.id,
    );
    expect(read).not.toHaveBeenCalledWith(helper.id);
  },
);
it('全部会话混选拉取漫游和导出名单都须列明不支持对象，确认后再执行', () => {
  act(() => root.render(h(Fixture, { initialView: 'all' })));
  click('[aria-label="多选会话"]');
  click('[aria-label="全选当前结果"]');
  click('[aria-label="拉取所选会话漫游消息"]');
  expect(roaming).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('合成克隆');
  expect(dialog.textContent).toContain('合成助手对话');
  act(() =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '仅处理支持的会话')!
      .click(),
  );
  expect(roaming).toHaveBeenCalledOnce();
  expect(roaming.mock.calls[0]![0]).toHaveLength(2);
  click('[aria-label="导出名单"]');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('不支持导出群名单');
});
