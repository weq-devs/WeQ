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

import { GroupInfoPanel } from '@renderer/im-template/template/groupInfoPanel';
import { TabActivity } from '@renderer/components/RetainedTabs';

const rankQuery = vi.hoisted(() => vi.fn());
const avatarRender = vi.hoisted(() => vi.fn());
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
  client: { account: { listGroupMembersByLevel: { query: rankQuery } } },
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
    rankQuery.mockReset().mockResolvedValue([]);
    avatarRender.mockClear();
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
  });

  it('渲染群资料行，创建时间格式化成 年/月/日', () => {
    mountPanel(undefined, undefined, { onOpenDetail: () => undefined });

    // 侧栏不再把群简介压成一行省略号，改为标题行上的「查看完整资料 ›」入口；其余日常字段照旧。
    expect(metaRow('群简介')).toBeUndefined();
    expect(document.querySelector('.group-info-heading')?.textContent).toContain('查看完整资料');
    expect(metaRow('群容量')?.querySelector('strong')?.textContent).toBe('12/200');

    const created = metaRow('创建时间')?.querySelector('strong')?.textContent ?? '';
    // 不写死具体日期：格式化用的是本地时区，断言形状即可。
    expect(created).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it('渲染群成员列表', () => {
    mountPanel();
    expect(document.querySelector('.group-info-member-row')?.textContent).toContain('测试成员');
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
  it('已退群与等级排行是并列图标按钮，已退群保留原回调', () => {
    const open = vi.fn();
    mountPanel(undefined, undefined, { onOpenLeftMembers: open });
    const actions = document.querySelector('.group-info-member-actions')!;
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '查看已退群的成员',
      '群成员等级排行',
    ]);
    expect(buttons.every((button) => !button.textContent?.trim())).toBe(true);
    expect(rankQuery).not.toHaveBeenCalled();
    act(() => buttons[0].click());
    expect(open).toHaveBeenCalledOnce();
  });
  it('等级排行直接查询当前群，点击未加载的成员仍能打开资料', async () => {
    rankQuery.mockResolvedValue([
      { uid: 'uid-rank', uin: '10002', nick: '排行成员', memberLevel: 8 },
    ]);
    const open = vi.fn();
    mountPanel(undefined, undefined, { onOpenMember: open });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="群成员等级排行"]')!.click();
    });
    expect(rankQuery).toHaveBeenCalledOnce();
    expect(rankQuery).toHaveBeenCalledWith({ groupCode: 'g1', limit: 50, offset: 0 });
    expect(document.querySelector('.weq-rank-groupname')?.textContent).toBe('测试群');
    expect(document.querySelector('.weq-rank-back')).toBeNull();
    const row = document.querySelector<HTMLElement>('.weq-rank-row')!;
    expect(row.textContent).toContain('Lv.8');
    act(() => row.click());
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'uid-rank', uin: '10002' }),
      expect.anything(),
    );
    act(() => document.querySelector<HTMLButtonElement>('.weq-rank-close')!.click());
    expect(document.querySelector('.weq-rank')).toBeNull();
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
      'group-info-section group-info-overview',
      'weq-group-announcement',
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
    const entry = document.querySelector<HTMLButtonElement>('[title="查看群公告"]')!;
    expect(entry.textContent).toBe('群公告');
    act(() => entry.click());
    expect(open).toHaveBeenCalledOnce();
  });
  it('群资料栏直接展示打卡入口，点击只打开页面，不直接写入', () => {
    const open = vi.fn();
    mountPanel(undefined, open);
    const entry = document.querySelector<HTMLButtonElement>('.weq-group-content-actions button')!;
    expect(entry.textContent).toBe('打卡');
    act(() => entry.click());
    expect(open).toHaveBeenCalledOnce();
  });
});
