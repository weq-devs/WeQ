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
  aggregatePinPreferences,
  conversationViewRows,
  type ConversationView,
  type ConversationViewDirectory,
} from '../src/renderer/src/lib/conversationViews';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useCurrentContentSelection } from '../src/renderer/src/state/contentSelection.shared';
import {
  acceptAccountState,
  acceptPreferences,
  bindAccountState,
  useAccountRecords,
} from '../src/renderer/src/lib/clientPreferences';
import { createTemplateDemoData } from './support/templateDemoData';
import {
  mobileBack,
  mobileBackTarget,
  registerMobileBack,
} from '../src/renderer/src/hooks/useMobileNavigation';
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
const assistant = assistantConversationRow({
  id: 's1',
  title: '合成助手对话',
  updatedAt: 12345,
  directoryRead: { key: 'assistant:s1', position: '12345' },
});
const cloneGroup = virtualConversationRow({
  id: 'virtual:group:g1',
  kind: 'group',
  ownerId: 'g1',
  name: '合成克隆群',
});
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
  clone: [clone, cloneGroup],
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Probe() {
  return h('output', { 'data-selection': '' }, JSON.stringify(useCurrentContentSelection()));
}
function Fixture({
  initialView = 'regular',
  active = true,
  entries = directory,
  pinScope = '',
}: {
  initialView?: ConversationView;
  active?: boolean;
  entries?: ConversationViewDirectory;
  pinScope?: string;
}) {
  const [view, setView] = useState(initialView);
  const [back, setBack] = useState(false);
  const [chat, setChat] = useState('原先打开的聊天');
  const rows = useMemo(
    () => conversationViewRows(entries, view, { includeHidden: false, includeDeleted: false }),
    [entries, view],
  );
  const accountPins = useAccountRecords('pins', pinScope);
  const preferences = useMemo(
    () => aggregatePinPreferences(entries.regular, {}, accountPins),
    [entries.regular, accountPins],
  );
  const value = useMemo(
    () => ({
      view,
      rows,
      views: entries,
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
    [view, rows, entries, back],
  );
  return h(
    ContentSelectionProvider,
    null,
    h(
      ConversationDirectoryContext.Provider,
      { value },
      h(ConversationList, {
        active,
        conversations: rows,
        activeConversationId: null,
        preferences,
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
it('常规视图与全部会话图标不同，切换按钮跟随当前视图', () => {
  act(() => root.render(h(Fixture)));
  click('[aria-label="会话视图"]');
  const options = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const regular = options.find((node) => node.textContent === '常规视图')!;
  const all = options.find((node) => node.textContent === '全部会话')!;
  const regularIcon = regular.querySelector('svg')!.innerHTML;
  const allIcon = all.querySelector('svg')!.innerHTML;
  expect(allIcon).not.toBe(regularIcon);
  expect(host.querySelector('[aria-label="会话视图"] svg')!.innerHTML).toBe(regularIcon);
  act(() => all.click());
  expect(host.querySelector('[aria-label="会话视图"] svg')!.innerHTML).toBe(allIcon);
  click('[aria-label="会话视图"]');
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((node) => node.textContent === '常规视图')!
      .click(),
  );
  expect(host.querySelector('[aria-label="会话视图"] svg')!.innerHTML).toBe(regularIcon);
});
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
it('可取消已隐藏会话入口的默认置顶，回读后按普通会话排序', () => {
  const entry: Conversation = {
    ...helper,
    id: 'merged:hidden',
    mergedKind: 'hidden',
    title: '已隐藏会话',
    updatedAt: new Date(0).toISOString(),
    preference: { pinned: true, muted: false, blocked: false },
  };
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  const pinScope = JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId]);
  bindAccountState(binding);
  try {
    act(() =>
      root.render(h(Fixture, { entries: { ...directory, regular: [ordinary, entry] }, pinScope })),
    );
    const firstId = () =>
      host.querySelector<HTMLElement>('[data-conversation-id]')?.dataset.conversationId;
    const choose = (label: string) => {
      act(() =>
        host
          .querySelector(`[data-conversation-id="${entry.id}"]`)!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === label,
      );
      expect(item).toBeDefined();
      act(() => item!.click());
    };
    expect(firstId()).toBe(entry.id);
    choose('取消置顶');
    expect(pin).toHaveBeenLastCalledWith(entry, false);
    act(() =>
      acceptAccountState(
        { revision: 1, values: {}, records: { pins: { [entry.id]: false } } },
        binding,
      ),
    );
    expect(firstId()).toBe(ordinary.id);
    choose('置顶');
    expect(pin).toHaveBeenLastCalledWith(entry, true);
  } finally {
    act(() => bindAccountState(null));
  }
});
it.each(['groupAssistant', 'clone', 'assistant'] as const)(
  '移动端从常规进入 %s 后可逐层返回，切换标签时不保留后台返回入口',
  (view) => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (media) => Object.assign(new EventTarget(), { matches: true, media }) as MediaQueryList,
    );
    act(() => root.render(h(Fixture)));
    expect(mobileBack()).toBe(false);
    const entry = directory.regular.find(
      (row) => row.type === 'merged' && row.mergedKind === view,
    )!;
    click(`[data-conversation-id="${entry.id}"]`);
    expect(mobileBackTarget()).toBe(host.querySelector('.weq-conversation-directory'));
    const backChat = vi.fn();
    const removeChat = registerMobileBack({ id: 'fixture-chat', priority: 10, back: backChat });
    try {
      act(() => expect(mobileBack()).toBe(true));
      expect(backChat).toHaveBeenCalledOnce();
      expect(host.querySelector('[aria-label="返回常规视图"]')).not.toBeNull();
    } finally {
      removeChat();
    }
    act(() => root.render(h(Fixture, { active: false })));
    expect(mobileBack()).toBe(false);
    act(() => root.render(h(Fixture, { active: true })));
    act(() => expect(mobileBack()).toBe(true));
    expect(host.querySelector(`[data-conversation-id="${entry.id}"]`)).not.toBeNull();
    expect(host.querySelector('[data-chat]')!.textContent).toBe('原先打开的聊天');
    expect(mobileBack()).toBe(false);
    click(`[data-conversation-id="${entry.id}"]`);
    click('[aria-label="返回常规视图"]');
    expect(mobileBack()).toBe(false);
  },
);
it('移动端直接从视图菜单进入分类不新增返回常规层级', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) => Object.assign(new EventTarget(), { matches: true, media }) as MediaQueryList,
  );
  act(() => root.render(h(Fixture)));
  click('[aria-label="会话视图"]');
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((node) => node.textContent === '群助手')!
      .click(),
  );
  expect(host.querySelector('[data-conversation-id="12345"]')).not.toBeNull();
  expect(mobileBack()).toBe(false);
});
it('菜单直接切换保留视图菜单，助手视图的加号直接新建会话', () => {
  act(() => root.render(h(Fixture)));
  click('[aria-label="会话视图"]');
  expect(host.querySelectorAll('[role="menuitemradio"]')).toHaveLength(10);
  const target = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (node) => node.textContent === 'WeQ 助手会话',
  )!;
  act(() => target.click());
  expect(host.querySelector('[aria-label="返回常规视图"]')).toBeNull();
  expect(host.querySelector('[data-conversation-id="assistant:s1"]')).not.toBeNull();
  click('[aria-label="新建 WeQ 助手会话"]');
  expect(createAssistant).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="添加会话菜单"]')).toBeNull();
});
it('助手视图支持导出、标为已读和永久删除，未选对象时禁用', () => {
  act(() => root.render(h(Fixture, { initialView: 'assistant' })));
  click('[aria-label="多选会话"]');
  const toolbar = host.querySelector('[aria-label="会话多选操作"]')!;
  const read = toolbar.querySelector<HTMLButtonElement>('[aria-label="标为已读"]')!;
  expect(read.disabled).toBe(true);
  expect(toolbar.querySelector('[aria-label="导出聊天记录"]')).not.toBeNull();
  const del = toolbar.querySelector<HTMLButtonElement>('[aria-label="永久删除所选 AI 会话"]')!;
  expect(del.disabled).toBe(true);
  expect(del.title).toBe('请先选择会话');
  click('[aria-label="全选当前结果"]');
  expect(read.disabled).toBe(false);
  expect(del.disabled).toBe(false);
  act(() => del.click());
  expect(remove).toHaveBeenCalledWith([assistant]);
});
it('助手摘要和克隆草稿服从会话预览开关，图片草稿与未读仍各自表达', () => {
  const generated = [
    assistantConversationRow({
      id: 'preview',
      title: '预览助手',
      updatedAt: 35000,
      preview: '报告已完成',
      unreadCount: 1,
    }),
    virtualConversationRow({
      id: 'virtual:persona:draft',
      kind: 'persona',
      ownerId: 'draft',
      name: '预览克隆',
      preview: '上一条消息',
      draftPreview: '[图片] 草稿',
      unreadCount: 2,
    }),
  ];
  const entries = { ...directory, assistant: [generated[0]!], clone: [generated[1]!] };
  const render = (show: boolean, revision: number) =>
    act(() => {
      acceptPreferences(
        {
          epoch: 'fixture-preview',
          revision,
          values: { showConversationPreview: show },
          records: {},
        },
        false,
      );
      root.render(h(Fixture, { initialView: 'all', entries }));
    });
  try {
    const unreadBadges = () =>
      generated.map(
        (row) => host.querySelector(`[data-conversation-id="${row.id}"] .row-unread`)?.textContent,
      );
    render(true, 1);
    expect(host.textContent).toContain('报告已完成');
    expect(host.textContent).toContain('[图片] 草稿');
    expect(host.textContent).not.toContain('上一条消息');
    expect(unreadBadges()).toEqual(['1', '2']);
    render(false, 2);
    expect(host.textContent).not.toContain('报告已完成');
    expect(host.textContent).not.toContain('[图片] 草稿');
    expect(unreadBadges()).toEqual(['1', '2']);
  } finally {
    render(true, 3);
  }
});
it.each([
  ['clone', clone, cloneGroup],
  ['assistant', assistant, assistantConversationRow({ id: 's2', title: '另一会话', updatedAt: 0 })],
] as const)('%s 刷新删除结果后，只保留仍存在的选中项，再删完则退出多选', (view, first, second) => {
  const refresh = (rows: Conversation[]) =>
    act(() =>
      root.render(h(Fixture, { initialView: view, entries: { ...directory, [view]: rows } })),
    );
  refresh([first, second]);
  click('[aria-label="多选会话"]');
  click('[aria-label="全选当前结果"]');
  expect(host.querySelector('.weq-directory-selection-count')?.textContent).toBe('已选 2');
  click('[aria-label="永久删除所选 AI 会话"]');
  expect(remove).toHaveBeenCalledWith(expect.arrayContaining([first, second]));
  expect(selected()).toHaveLength(2);

  refresh([second]);
  expect(selected()).toEqual([second.id]);
  expect(host.querySelector('.weq-directory-selection-count')?.textContent).toBe('已选 1');
  click('[aria-label="永久删除所选 AI 会话"]');
  expect(remove).toHaveBeenLastCalledWith([second]);
  refresh([]);
  expect(host.querySelector('[data-selection]')?.textContent).toBe('null');
  expect(host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
  expect(host.querySelector('[aria-label="多选会话"]')).not.toBeNull();
});
it.each([
  ['assistant', assistant, 'WeQ 助手会话'],
  ['clone', clone, '克隆会话'],
  ['clone', cloneGroup, '克隆群聊'],
] as const)('%s 右键菜单显示实际会话类型，不提供内部标识复制', (view, row, label) => {
  act(() => root.render(h(Fixture, { initialView: view })));
  act(() =>
    host
      .querySelector(`[data-conversation-id="${row.id}"]`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })),
  );
  const target = document.querySelector('.weq-conversation-actions-target')!;
  expect(target.querySelector('small')!.textContent).toBe(label);
  expect(target.querySelector('.weq-conversation-copy-number')).toBeNull();
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
it('关闭当前聊天后不自动选中其他聊天，移动端返回也不会恢复已关闭的聊天', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) => Object.assign(new EventTarget(), { matches: true, media }) as MediaQueryList,
  );
  function Shell() {
    const shell = useChatShellController({
      conversations: [ordinary, group],
      contacts: [],
      initialActiveConversationId: ordinary.id,
      initialView: 'messages',
      sidebarWidthStorageKey: 'fixture-sidebar',
      history: noopChatShellHistoryAdapter,
    });
    return h(
      'div',
      null,
      h('button', { onClick: () => shell.openConversation(group.id) }, '打开聊天'),
      h('button', { onClick: () => shell.openConversation(null) }, '关闭聊天'),
      h('output', null, shell.activeConversationId ?? '未选中'),
    );
  }
  act(() => root.render(h(Shell)));
  click('button:first-child');
  expect(host.querySelector('output')!.textContent).toBe(group.id);
  click('button:nth-child(2)');
  expect(host.querySelector('output')!.textContent).toBe('未选中');
  expect(mobileBack()).toBe(false);
});
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
  click('[aria-label="导出群成员名单"]');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('不支持导出群成员名单');
});
