/**
 * 群资料面板（`im-template/template/groupInfoPanel`）的渲染回归测试。
 *
 * 背景：群资料卡片从 `groupInfoPanel.tsx` 搬到应用层时，`formatShortDate` 这个被
 * **面板与卡片共用**的小工具被跟着删掉了（它还留着一条 `// @ts-nocheck`，typecheck
 * 看不见），于是打开群资料面板当场 `ReferenceError: formatShortDate is not defined`。
 *
 * 这里真挂一次面板并断言「创建时间」那一行渲染出来了：只要那个工具再丢一次，
 * 渲染就会抛错 / 该行消失，测试立刻红。
 */

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GroupInfoPanel } from '@renderer/im-template/template/groupInfoPanel';
import { TabActivity } from '@renderer/components/RetainedTabs';
import { GroupRosterPanel } from '@renderer/components/groupProfile/GroupRosterPanel';
import { GROUP_MEMBER_SORTS } from '../src/shared/group_member_order';
import { formatShortDate } from '@renderer/im-template/template/format';

const avatarRender = vi.hoisted(() => vi.fn());
const metricsRender = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/components/GroupProfileMetrics', () => ({
  GroupProfileMetrics: ({ children }: { children: (rows: []) => unknown }) => {
    metricsRender();
    return children([]);
  },
}));
vi.mock('../src/renderer/src/im-template/template/primitives', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/im-template/template/primitives')>();
  return {
    ...actual,
    Avatar: (props: ComponentProps<typeof actual.Avatar>) => {
      avatarRender(props);
      return createElement(actual.Avatar, props);
    },
  };
});
vi.mock('../src/renderer/src/trpc/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/trpc/client')>()),
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: undefined }) },
      qqActions: {
        groupJoinManagement: { useQuery: () => ({ data: undefined }) },
        groupSelectedTags: { useQuery: () => ({}) },
      },
      contactMetrics: {
        groupFriendSources: {
          useQuery: () => ({
            data: {
              friendUids: [],
              addedUids: [],
              pendingUids: [],
              rosterComplete: true,
              unknown: 0,
            },
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ binding: null, available: false }),
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

/** 最小可渲染的群会话：面板只读 group.* 与 members。 */
const CONVERSATION = {
  id: 'g1',
  type: 'group',
  title: '测试群',
  group: {
    name: '测试群',
    identityLabel: '群号',
    identityValue: '123456',
    description: '群简介',
    remark: null,
    createTime: '2024-03-05T08:00:00.000Z',
    memberCount: 12,
    maxMemberCount: 200,
    labels: '游戏',
    customLabels: null,
    addressName: null,
    entranceQ: null,
  },
  members: [
    {
      id: 'uid-1',
      uin: '10001',
      identityLabel: 'QQ',
      identityValue: '10001',
      displayName: '测试成员',
      avatarUrl: null,
      role: 'owner',
    },
  ],
};

function mountPanel(
  onOpenAnnouncements?: () => void,
  onOpenSign?: () => void,
  extra: Partial<ComponentProps<typeof GroupInfoPanel>> = {},
): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(GroupInfoPanel, {
        conversation: CONVERSATION,
        onOpenAnnouncements,
        onOpenSign,
        ...extra,
      }),
    );
  });
  roots.push(root);
  hosts.push(host);
}

/** 面板第一段里的「标签 → 值」行。 */
function metaRow(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.group-info-meta-row')].find(
    (row) => row.querySelector('span')?.textContent === label,
  );
}

describe('群资料面板', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    avatarRender.mockClear();
    metricsRender.mockClear();
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
  });

  it('完整资料保留群容量与统一的创建时间显示', () => {
    mountPanel(undefined, undefined, { layout: 'profile', onOpenDetail: () => undefined });

    // 侧栏不再把群简介压成一行省略号，改为标题行上的「查看完整资料 ›」入口；其余日常字段照旧。
    expect(metaRow('群简介')).toBeUndefined();
    expect(document.querySelector('.group-info-heading')?.textContent).toContain('查看完整资料');
    expect(metaRow('群容量')?.querySelector('strong')?.textContent).toBe('12/200');

    const created = metaRow('创建时间')?.querySelector('strong')?.textContent ?? '';
    expect(created).toBe(formatShortDate(CONVERSATION.group.createTime));
  });

  it('渲染群成员列表', () => {
    mountPanel();
    expect(document.querySelector('.group-info-member-row')?.textContent).toContain('测试成员');
  });
  it('成员面板尺寸可见时请求名单，隐藏后释放，尺寸变化不重复请求', () => {
    let panelSize: ((width: number, height: number) => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          if (target.tagName === 'ASIDE')
            panelSize = (width, height) =>
              this.callback(
                [{ target, contentRect: { width, height } } as ResizeObserverEntry],
                this,
              );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const request = vi.fn();
    try {
      mountPanel(undefined, undefined, { onMemberVisibilityChange: request });
      expect(panelSize).toBeDefined();
      act(() => panelSize!(0, 0));
      expect(request).not.toHaveBeenCalled();
      act(() => panelSize!(260, 680));
      act(() => panelSize!(260, 650));
      expect(request.mock.calls).toEqual([['g1', true]]);
      act(() => panelSize!(0, 0));
      expect(request.mock.calls).toEqual([
        ['g1', true],
        ['g1', false],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('侧栏移除资料区与指标读取，只保留紧凑摘要和成员', () => {
    mountPanel(vi.fn(), vi.fn());
    expect(document.querySelector('.group-info-overview')).toBeNull();
    expect(document.querySelector('.group-info-meta-list')).toBeNull();
    expect(metricsRender).not.toHaveBeenCalled();
    expect(document.querySelector('.group-info-panel')?.getAttribute('aria-label')).toBe(
      '群聊侧栏',
    );
  });
  it('成员行不随未读和回调变化重画，真实资料只更新目标行且事件调用最新实现', () => {
    const members = Array.from({ length: 200 }, (_, index) => ({
      ...CONVERSATION.members[0],
      id: `uid-${index}`,
      uin: String(10000 + index),
      identityValue: String(10000 + index),
      displayName: `合成成员 ${index}`,
    }));
    const open = vi.fn(),
      nextOpen = vi.fn(),
      menu = vi.fn();
    mountPanel(undefined, undefined, {
      conversation: { ...CONVERSATION, members },
      onOpenMember: open,
      onMemberContextMenu: menu,
    });
    const root = roots.at(-1)!,
      host = hosts.at(-1)!;
    const rows = () => [...host.querySelectorAll<HTMLElement>('.group-info-member-row')];
    expect(rows()).toHaveLength(members.length);
    expect(avatarRender).toHaveBeenCalledTimes(members.length);
    expect(avatarRender.mock.calls.every(([props]) => props.resolution === 'small')).toBe(true);
    avatarRender.mockClear();
    const render = (overrides: Partial<ComponentProps<typeof GroupInfoPanel>> = {}) =>
      act(() =>
        root.render(
          createElement(GroupInfoPanel, {
            conversation: { ...CONVERSATION, members, unreadCount: 9 },
            onOpenMember: (member, anchor) => nextOpen(member, anchor),
            onMemberContextMenu: (event, member) => menu(event, member),
            ...overrides,
          }),
        ),
      );
    render();
    render();
    expect(avatarRender).not.toHaveBeenCalled();
    act(() =>
      rows()[0]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }),
      ),
    );
    expect(open).not.toHaveBeenCalled();
    expect(nextOpen).toHaveBeenLastCalledWith(members[0], { x: 10, y: 20 });
    act(() => rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(menu.mock.calls.at(-1)?.[1]).toBe(members[0]);
    const updated = members.map((member, index) =>
      index === 1 ? { ...member, displayName: '已更新成员', role: 'admin' } : member,
    );
    render({ conversation: { ...CONVERSATION, members: updated } });
    expect(avatarRender).toHaveBeenCalledOnce();
    expect(rows()[1]!.textContent).toContain('已更新成员');
    expect(rows()[1]!.classList.contains('is-admin')).toBe(true);
    act(() =>
      rows()[1]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(nextOpen.mock.calls.at(-1)?.[0]).toBe(updated[1]);
    render({ onOpenMember: undefined, onMemberContextMenu: undefined });
    expect(rows()[0]!.hasAttribute('role')).toBe(false);
    expect(rows()[0]!.hasAttribute('tabindex')).toBe(false);
    nextOpen.mockClear();
    menu.mockClear();
    act(() => {
      rows()[0]!.click();
      rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(nextOpen).not.toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
  });
  it('群资料展示排序依据中的活跃度和群内好友数，缺少缓存不误报零，也不写「未知」占位', () => {
    mountPanel();
    // 设计契约 §3：没有可信缓存时整行不渲染；既不能报 0，也不允许「未知」占位。
    expect(metaRow('活跃度')).toBeUndefined();
    expect(metaRow('群内好友数')).toBeUndefined();
    expect(document.querySelector('.group-info-panel')?.textContent).not.toContain('未知');
  });
  it('更多菜单保留已退群成员，群等级由排序菜单提供', () => {
    const open = vi.fn();
    mountPanel(undefined, undefined, { onOpenLeftMembers: open });
    const actions = document.querySelector('.group-info-member-actions')!;
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['更多成员操作']);
    expect(buttons.every((button) => !button.textContent?.trim())).toBe(true);
    act(() => buttons[0].click());
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    act(() =>
      document.querySelector<HTMLButtonElement>('[role="menuitem"][title="已退群的成员"]')!.click(),
    );
    expect(open).toHaveBeenCalledOnce();
  });
  it('群内字段排在联系人字段之前，排序菜单可关闭群主和管理员置顶', () => {
    const onSort = vi.fn();
    const onPrioritizeAdmins = vi.fn();
    const detail = { text: 'Lv8' };
    mountPanel(undefined, undefined, {
      memberOrder: {
        options: GROUP_MEMBER_SORTS,
        sort: 'memberLevel',
        descending: true,
        details: new Map([['uid-1', detail]]),
        onSort,
        onDirection: vi.fn(),
        prioritizeAdmins: true,
        onPrioritizeAdmins,
      },
    });
    const row = document.querySelector('.group-info-member-row')!;
    expect(row.querySelector('.member-name-with-badge')?.textContent).toContain('群主');
    expect(row.querySelector('.weq-directory-sort-detail')?.textContent).toBe(detail.text);
    const trigger = document.querySelector<HTMLButtonElement>('.group-info-sort-button')!;
    expect(trigger.getAttribute('aria-label')).toBe('排序');
    expect(trigger.textContent).toBe('');
    expect(trigger.hasAttribute('data-active')).toBe(true);
    act(() => trigger.click());
    const menu = document.querySelector('[role="dialog"][aria-label="排序"]')!;
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.slice(0, 5).map((option) => option.dataset.value)).toEqual([
      'displayName',
      'joinedAt',
      'lastSpeakAt',
      'memberLevel',
      'remark',
    ]);
    act(() => options[2]!.click());
    expect(onSort).toHaveBeenCalledWith('lastSpeakAt');
    const toggle = menu.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-label')).toBe('群主和管理员始终最前');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => toggle.click());
    expect(onPrioritizeAdmins).toHaveBeenCalledWith(false);
  });
  it('切换会话并重新打开群成员列表时，恢复该群的排序字段和方向', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    const client = new QueryClient({ defaultOptions: { queries: { cacheTime: 0 } } });
    const members = [
      { ...CONVERSATION.members[0], displayName: '甲', nick: 'Alice' },
      { ...CONVERSATION.members[0], id: 'uid-2', displayName: '乙', nick: 'Bob' },
    ];
    const open = (id?: string) =>
      act(() =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            id
              ? createElement(GroupRosterPanel, {
                  conversation: { ...CONVERSATION, id, members, generated: true },
                })
              : null,
          ),
        ),
      );
    const showSort = () =>
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="排序"]')!.click());
    const selectedSort = () =>
      document.querySelector('[aria-label="排序依据"] [aria-selected="true"]')?.textContent;
    const values = () =>
      [...host.querySelectorAll('.weq-directory-sort-detail')].map((row) => row.textContent);

    open('clone-1');
    showSort();
    act(() =>
      document.querySelector<HTMLButtonElement>('[role="option"][data-value="nick"]')!.click(),
    );
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '拼音 Z–A')!
        .click(),
    );
    expect(values()).toEqual(['Bob', 'Alice']);

    open('clone-2');
    showSort();
    expect(selectedSort()).toBe('群内显示昵称');
    open();
    open('clone-1');
    showSort();
    expect(selectedSort()).toBe('昵称');
    expect(values()).toEqual(['Bob', 'Alice']);
  });
  it('合成群不提供真实群的等级查询入口', () => {
    mountPanel(undefined, undefined, { conversation: { ...CONVERSATION, generated: true } });
    expect(document.querySelector('[aria-label="群成员等级排行"]')).toBeNull();
    expect(metaRow('活跃度')).toBeUndefined();
    expect(metaRow('群内好友数')).toBeUndefined();
  });
  it('联系人资料把公告与资料、内容入口与成员分别分组，默认侧栏不增加分组', () => {
    mountPanel(vi.fn(), vi.fn(), { layout: 'profile' });
    const panel = document.querySelector('.weq-group-profile-details')!;
    const primary = panel.querySelector('.weq-group-profile-primary')!;
    const secondary = panel.querySelector('.weq-group-profile-secondary')!;
    expect([...primary.children].map((element) => element.className)).toEqual([
      'weq-group-announcement',
      'group-info-section group-info-overview',
    ]);
    expect([...secondary.children].map((element) => element.className)).toEqual([
      'weq-group-content-actions',
      'group-info-section member-list-section',
    ]);

    mountPanel(vi.fn(), vi.fn());
    const sidebar = document.querySelector('.group-info-panel:not(.weq-group-profile-details)')!;
    expect([...sidebar.children].map((element) => element.className)).toEqual([
      'weq-group-summary',
      'weq-group-content-actions',
      'group-info-section member-list-section',
    ]);
  });
  it('成员读取失败时保留原因并允许重试', () => {
    const retry = vi.fn();
    mountPanel(undefined, undefined, { loadingError: '合成读取失败', onRetryMembers: retry });
    const error = document.querySelector('.group-info-member-error')!;
    expect(error.textContent).toContain('合成读取失败');
    act(() => error.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it('隐藏的联系人或聊天页不安排成员分页探测', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    try {
      act(() =>
        root.render(
          createElement(
            TabActivity,
            { active: false },
            createElement(GroupInfoPanel, {
              conversation: CONVERSATION,
              onLoadMoreMembers: vi.fn(),
            }),
          ),
        ),
      );
      expect(frame).not.toHaveBeenCalled();
    } finally {
      frame.mockRestore();
    }
  });
  it('公告区域保留独立入口，复用原打开回调', () => {
    const open = vi.fn();
    mountPanel(open);
    const entry = document.querySelector<HTMLButtonElement>('[aria-label="查看群公告"]')!;
    expect(entry.textContent).toContain('群公告');
    act(() => entry.click());
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenLastCalledWith(entry);
  });
  it('群资料栏直接展示打卡入口，点击只打开页面，不直接写入', () => {
    const open = vi.fn();
    mountPanel(undefined, open);
    const entry = document.querySelector<HTMLButtonElement>('.weq-group-content-actions button')!;
    expect(entry.textContent).toBe('打卡');
    act(() => entry.click());
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenLastCalledWith(entry);
  });
});
