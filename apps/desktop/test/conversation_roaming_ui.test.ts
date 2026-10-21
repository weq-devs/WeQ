import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import { RoamingBackfillPanel } from '../src/renderer/src/components/RoamingBackfillPanel';

const fixture = vi.hoisted(() => ({ plan: vi.fn(), contacts: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { roamingBackfill: { list: { invalidate: vi.fn() } } } }),
    account: {
      listConversationsWithCount: { useQuery: fixture.contacts },
      // 固定范围的真人头像要按 uid 补一次资料；日期密度用导出页日历。
      getProfilesByUids: { useQuery: () => ({ data: [] }) },
      exportCalendar: { useQuery: () => ({ data: [] }) },
      roamingBackfill: {
        list: { useQuery: () => ({ data: { historyVersion: 2, jobs: [], online: true } }) },
        plan: { useMutation: () => ({ mutate: fixture.plan }) },
        start: { useMutation: () => ({}) },
        pause: { useMutation: () => ({}) },
        cancel: { useMutation: () => ({}) },
        remove: { useMutation: () => ({}) },
      },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  fixture.contacts.mockReturnValue({ data: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    render: (next: typeof element) => act(() => root.render(next)),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe('会话底部多选栏', () => {
  it('右键与多选标记使用完整选区，混入虚拟会话时提醒，不清空选区', () => {
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const groups = ['10001', '10002'].map((id) => ({
      ...base,
      id,
      unreadCount: 0,
      group: { ...base.group, id, name: id },
    }));
    const mark = vi.fn();
    const f = mount(
      h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: groups,
              virtual: [
                { id: 'virtual:fixture', kind: 'persona', ownerId: 'fixture', name: '虚拟会话' },
              ],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onReadState: mark,
            },
          },
          h(ConversationList, {
            conversations: groups,
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
      ),
    );
    const row = (id: string) =>
      f.host.querySelector<HTMLButtonElement>(`[data-conversation-id="${id}"]`)!;
    const menuButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === label,
      )!;
    try {
      act(() =>
        row('10001').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
      );
      expect(menuButton('标为已读')).toBeUndefined();
      act(() => menuButton('标为未读').click());
      expect(mark).toHaveBeenLastCalledWith([groups[0]], true);
      act(() => button(f.host, '多选会话').click());
      expect(button(f.host, '标为已读').disabled).toBe(true);
      act(() => row('10001').click());
      act(() => row('10002').click());
      act(() => button(f.host, '标为已读').click());
      expect(mark).toHaveBeenLastCalledWith(groups, false);
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() =>
        row('10001').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
      );
      act(() => menuButton('标为未读').click());
      expect(mark).toHaveBeenLastCalledWith(groups, true);
      expect(menuButton('撤销标记')).toBeUndefined();
      expect(button(f.host, '撤销标记')).toBeNull();
      act(() => button(f.host, '全选当前结果').click());
      expect(button(f.host, '标为已读').disabled).toBe(false);
      expect(button(f.host, '标为未读').disabled).toBe(false);
      act(() => button(f.host, '标为已读').click());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain('1 个会话不支持标为已读');
      expect(dialog.textContent).toContain('虚拟会话');
      act(() =>
        [...dialog.querySelectorAll('button')]
          .find((node) => node.textContent === '仅处理支持的会话')!
          .click(),
      );
      expect(mark).toHaveBeenLastCalledWith(groups, false);
      act(() =>
        row('10001').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
      );
      expect(menuButton('标为已读')).toBeUndefined();
      expect(menuButton('标为未读').disabled).toBe(false);
    } finally {
      f.close();
    }
  });

  it.each([
    { counts: [0], unread: true },
    { counts: [3], unread: false },
    { counts: [0, 0], unread: true },
    { counts: [0, 3], unread: false },
    { counts: [2, 0], unread: false },
  ])('右键已读菜单只显示当前选区需要的一个操作：$counts', ({ counts, unread }) => {
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const groups = counts.map((unreadCount, index) => ({
      ...base,
      id: String(10001 + index),
      unreadCount,
      group: { ...base.group, id: String(10001 + index), name: String(index) },
    }));
    const mark = vi.fn();
    const f = mount(
      h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: groups,
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onReadState: mark,
            },
          },
          h(ConversationList, {
            conversations: groups,
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
      ),
    );
    const row = (id: string) =>
      f.host.querySelector<HTMLButtonElement>(`[data-conversation-id="${id}"]`)!;
    try {
      if (groups.length > 1) {
        act(() => button(f.host, '多选会话').click());
        for (const group of groups) act(() => row(group.id).click());
      }
      act(() =>
        row(groups[0]!.id).dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
      );
      const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
        (node) => node.textContent === '标为已读' || node.textContent === '标为未读',
      );
      expect(actions).toHaveLength(1);
      expect(
        [...document.querySelectorAll('[role="menuitem"]')].some(
          (node) => node.textContent === '撤销标记',
        ),
      ).toBe(false);
      expect(actions[0]!.textContent).toBe(unread ? '标为未读' : '标为已读');
      act(() => actions[0]!.click());
      expect(mark).toHaveBeenCalledWith(groups, unread);
    } finally {
      f.close();
    }
  });

  it('修饰键鼠标多选不显示键盘焦点框，实际键盘操作恢复焦点提示', () => {
    const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const f = mount(
      h(ConversationList, {
        conversations: [group],
        activeConversationId: null,
        preferences: {},
        drafts: {},
        onSelect: vi.fn(),
      }),
    );
    try {
      const row = f.host.querySelector<HTMLElement>('[data-conversation-id]')!;
      act(() =>
        row.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            ctrlKey: true,
          }),
        ),
      );
      const directory = f.host.querySelector<HTMLElement>('.weq-conversation-directory')!;
      expect(directory.dataset.weqSelectionInput).toBe('pointer');
      expect(f.host.querySelector('.is-multiselected')).not.toBeNull();
      act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true })));
      expect(directory.dataset.weqSelectionInput).toBe('pointer');
      act(() =>
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
      );
      expect(directory.dataset.weqSelectionInput).toBe('keyboard');
    } finally {
      f.close();
    }
  });
  it('保留顶部搜索，空选禁用操作，混选不静默过滤，操作后保留选区', () => {
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const group = { ...base, id: '10001', group: { ...base.group, id: '10001', name: '合成群聊' } };
    const roaming = vi.fn();
    function Probe() {
      return h('output', null, JSON.stringify(useContentExportRequest()));
    }
    const f = mount(
      h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: [group],
              virtual: [
                {
                  id: 'virtual:fixture',
                  kind: 'persona',
                  ownerId: 'fixture',
                  name: '合成虚拟会话',
                },
              ],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onRoaming: roaming,
            },
          },
          h(ConversationList, {
            conversations: [group],
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
        h(Probe),
      ),
    );
    try {
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
      act(() => button(f.host, '多选会话').click());
      expect(button(f.host, '搜索会话')).not.toBeNull();
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(true);
      act(() => f.host.querySelector<HTMLButtonElement>('[data-conversation-id="10001"]')!.click());
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(false);
      act(() => button(f.host, '拉取所选会话漫游消息').click());
      expect(roaming).toHaveBeenCalledWith([{ kind: 'group', conv: '10001', name: '合成群聊' }]);
      act(() => button(f.host, '导出所选会话').click());
      expect(JSON.parse(f.host.querySelector('output')!.textContent!).selection.scope.ids).toEqual([
        '10001',
      ]);
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(1);
      act(() => button(f.host, '全选当前结果').click());
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(false);
      expect(button(f.host, '导出所选会话').disabled).toBe(false);
      act(() => button(f.host, '拉取所选会话漫游消息').click());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain('1 个会话不支持拉取漫游消息');
      expect(dialog.textContent).toContain('合成虚拟会话');
      expect(roaming).toHaveBeenCalledTimes(1);
      act(() =>
        [...dialog.querySelectorAll('button')]
          .find((node) => node.textContent === '仅处理支持的会话')!
          .click(),
      );
      expect(roaming).toHaveBeenCalledTimes(2);
      act(() => button(f.host, '导出所选会话').click());
      const exportDialog = document.querySelector('[role="dialog"]')!;
      expect(exportDialog.textContent).toContain('1 个会话不支持导出');
      expect(exportDialog.textContent).toContain('合成虚拟会话');
      act(() =>
        [...exportDialog.querySelectorAll('button')]
          .find((node) => node.textContent === '取消')!
          .click(),
      );
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() => f.host.querySelector<HTMLButtonElement>('[data-conversation-id="10001"]')!.click());
      act(() => button(f.host, '拉取所选会话漫游消息').click());
      const unsupportedDialog = document.querySelector('[role="dialog"]')!;
      expect(unsupportedDialog.textContent).toContain('没有可处理的会话');
      expect(unsupportedDialog.textContent).not.toContain('仅处理支持的会话');
      act(() =>
        [...unsupportedDialog.querySelectorAll('button')]
          .find((node) => node.textContent === '知道了')!
          .click(),
      );
      expect(roaming).toHaveBeenCalledTimes(2);
      act(() => f.host.querySelector<HTMLButtonElement>('[data-conversation-id="10001"]')!.click());
      act(() => button(f.host, '取消全选当前结果').click());
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(0);
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).not.toBeNull();
      expect(button(f.host, '全选当前结果')).not.toBeNull();
      expect(button(f.host, '导出所选会话').disabled).toBe(true);
      act(() => button(f.host, '全选当前结果').click());
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() => button(f.host, '退出多选').click());
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
    } finally {
      f.close();
    }
  });
});

describe('漫游目标范围', () => {
  it('编辑列表后保留入口选择，增减目标只影响本次任务', () => {
    const targets = [
      { kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' },
      { kind: 'group' as const, conv: '10001', name: '合成群聊' },
    ];
    const f = mount(h(RoamingBackfillPanel, { initialTargets: targets, targetMode: 'fixed' }));
    try {
      act(() => button(f.host, '编辑列表').click());
      expect(f.host.querySelector('[aria-label="搜索补全会话"]')).not.toBeNull();
      const inputs = f.host.querySelectorAll<HTMLInputElement>('.weq-roaming-target input');
      expect([...inputs].map((input) => input.checked)).toEqual([true, true]);
      act(() => inputs[0]!.click());
      act(() =>
        [...f.host.querySelectorAll('button')]
          .find((node) => node.textContent?.includes('扫描候选缺口'))!
          .click(),
      );
      expect(fixture.plan).toHaveBeenCalledWith(expect.objectContaining({ targets: [targets[1]] }));
      expect(targets).toHaveLength(2);
    } finally {
      f.close();
    }
  });
  it.each([
    [{ kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' }],
    [
      { kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' },
      { kind: 'group' as const, conv: '10001', name: '合成群聊' },
    ],
  ])('固定目标不再展示全库选择器，扫描只使用入口快照 %#', (...targets) => {
    const f = mount(h(RoamingBackfillPanel, { initialTargets: targets, targetMode: 'fixed' }));
    try {
      expect(fixture.contacts).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ enabled: false }),
      );
      expect(f.host.querySelector('[aria-label="搜索补全会话"]')).toBeNull();
      expect(f.host.querySelectorAll('.weq-roaming-scope input[type="checkbox"]')).toHaveLength(1);
      expect(f.host.textContent).toContain(targets[0]!.name);
      const selectText = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => f.host.querySelector('.weq-roaming-scope strong')!.dispatchEvent(selectText));
      expect(selectText.defaultPrevented).toBe(false);
      const scan = [...f.host.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('扫描候选缺口'),
      )!;
      act(() => scan.click());
      expect(fixture.plan).toHaveBeenCalledWith(expect.objectContaining({ targets }));
    } finally {
      f.close();
    }
  });

  it('全局入口保留会话选择，空选不能扫描', () => {
    const f = mount(h(RoamingBackfillPanel));
    try {
      expect(fixture.contacts).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ enabled: true }),
      );
      expect(f.host.querySelector('[aria-label="搜索补全会话"]')).not.toBeNull();
      expect(
        [...f.host.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('扫描候选缺口'),
        )!.disabled,
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it('固定范围不随上游选区或目标对象变化，非法目标不退回全库选择', () => {
    const target = { kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' };
    const f = mount(h(RoamingBackfillPanel, { initialTargets: [target], targetMode: 'fixed' }));
    try {
      target.conv = 'u_changed';
      f.render(
        h(RoamingBackfillPanel, {
          initialTargets: [target, { kind: 'group', conv: '10001', name: '后来选择' }],
          targetMode: 'fixed',
        }),
      );
      const scan = [...f.host.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('扫描候选缺口'),
      )!;
      act(() => scan.click());
      expect(fixture.plan).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ kind: 'c2c', conv: 'u_fixture', name: '合成好友' }],
        }),
      );
    } finally {
      f.close();
    }
    const invalid = mount(
      h(RoamingBackfillPanel, {
        initialTargets: [{ kind: 'c2c', conv: 'dataline', name: '合成设备' }],
        targetMode: 'fixed',
      }),
    );
    try {
      expect(invalid.host.querySelector('[role="alert"]')?.textContent).toContain('不支持');
      expect(invalid.host.querySelector('[aria-label="搜索补全会话"]')).toBeNull();
      expect(
        [...invalid.host.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('扫描候选缺口'),
        )!.disabled,
      ).toBe(true);
    } finally {
      invalid.close();
    }
  });
});
