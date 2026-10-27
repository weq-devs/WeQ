import { act, createElement, useEffect, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import { WorkspaceMenuButton } from '../src/renderer/src/components/WorkspaceMenuButton';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import type { ContentSelection } from '../src/shared/content_selection';
import { useViewState } from '../src/renderer/src/state/view';
import { hasActiveModal } from '../src/renderer/src/lib/overlayStack';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';

const fixture = vi.hoisted(() => ({
  selection: null as ContentSelection | null,
  exportRequest: null as { selection: ContentSelection; revision: number } | null,
  taskUnmounted: vi.fn(),
}));
vi.mock('../src/renderer/src/state/contentSelection', () => ({
  useCurrentContentSelection: () => fixture.selection,
  useContentExportRequest: () => fixture.exportRequest,
  useContentAnalysisRequest: () => null,
}));

vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({
    initialSelection,
    surface,
    fixedScope,
  }: {
    initialSelection?: ContentSelection;
    surface?: 'tasks';
    fixedScope?: boolean;
  }) => {
    const [seed] = useState(initialSelection);
    const [progress, setProgress] = useState(0);
    useEffect(
      () => () => {
        if (surface === 'tasks') fixture.taskUnmounted();
      },
      [surface],
    );
    return createElement(
      'div',
      {
        'data-export-ids': seed?.scope.type === 'items' ? seed.scope.ids.join(',') : '',
        'data-fixed-scope': fixedScope,
      },
      '合成导出夹具',
      createElement('input', { 'aria-label': '合成导出草稿', defaultValue: '' }),
      surface === 'tasks' &&
        createElement(
          'button',
          {
            type: 'button',
            'data-task-progress': progress,
            onClick: () => setProgress((value) => value + 1),
          },
          '推进合成任务',
        ),
    );
  },
}));

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/views/agentlab/AssistantMenuWorkspace', () => ({
  AssistantMenuWorkspace: () => createElement('div', null, '合成助手夹具'),
}));
vi.mock('../src/renderer/src/components/RoamingBackfillPanel', () => ({
  RoamingBackfillPanel: ({
    targetMode,
    initialTargets,
  }: {
    targetMode?: string;
    initialTargets?: { conv: string }[];
  }) =>
    createElement(
      'div',
      {
        'data-roaming-mode': targetMode,
        'data-roaming-targets': initialTargets?.map((target) => target.conv).join(','),
      },
      '合成补全夹具',
    ),
}));

function workspaceTools(props: Partial<ComponentProps<typeof WorkspaceTools>> = {}) {
  return createElement(
    'div',
    null,
    createElement(WorkspaceMenuButton),
    createElement(WorkspaceTools, {
      accountScope: 'fixture/config',
      footerControls: null,
      onOpenAnalysis: vi.fn(),
      ...props,
    }),
  );
}

function activeMenu() {
  return [...document.querySelectorAll<HTMLElement>('.weq-workspace-menu')].find(
    (element) => !element.closest('[hidden], [inert]'),
  );
}

function menuTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>('.weq-workspace-menu-trigger');
  expect(trigger).not.toBeNull();
  return trigger!;
}

function openMenu() {
  if (!activeMenu()) act(() => menuTrigger().click());
  expect(activeMenu()).toBeDefined();
  return activeMenu()!;
}

function openTool(label: string) {
  const button = openMenu().querySelector<HTMLButtonElement>(
    `[aria-label="内容工具"] [aria-label="${label}"]`,
  );
  expect(button).not.toBeNull();
  act(() => button!.click());
}

beforeEach(() => {
  useWorkspaceMenu.setState({ anchor: null, running: 0, failed: 0 });
  fixture.selection = null;
  fixture.exportRequest = null;
});

describe('工作菜单与内容工具范围', () => {
  it('会话入口固定范围后，菜单分析沿用当前对象且不再显示选择器', () => {
    const previousAccount = useViewState.getState().openedUin;
    useViewState.setState({ openedUin: '10002' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const conversation: GroupConversation = {
      id: '777',
      type: 'group',
      updatedAt: '',
      lastMessage: null,
      otherUser: null,
      group: {
        id: '777',
        name: '合成群',
        identityLabel: '群号',
        identityValue: '777',
        avatarUrl: null,
        announcement: null,
        memberCount: 0,
        role: 'member',
      },
      members: [],
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      fixture.exportRequest = {
        selection: {
          owner: { kind: 'messages', container: 'group:777' },
          scope: { type: 'all' },
        },
        revision: 1,
      };
      act(() =>
        root.render(
          workspaceTools({
            currentConversation: conversation,
            analysisRequest: { target: { kind: 'group', groupCode: '777' }, revision: 1 },
            onOpenAnalysis: vi.fn(),
          }),
        ),
      );
      expect(document.querySelector('[data-fixed-scope="true"]')).not.toBeNull();
      openTool('导出');
      expect(document.querySelector('[data-fixed-scope="false"]')).not.toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      openTool('分析与报告');
      expect(document.querySelector('[aria-label="报告类型"]')).toBeNull();
      expect(document.querySelector('[aria-label="搜索分析对象"]')).toBeNull();
      expect(document.querySelector('[aria-label="分析时间范围"]')).not.toBeNull();
    } finally {
      fixture.exportRequest = null;
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it('联系人页确定好友后跳过对象选择，离开后重新打开恢复完整选择器', () => {
    const previousAccount = useViewState.getState().openedUin;
    useViewState.setState({ openedUin: '10002' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          workspaceTools({
            workspace: {
              view: 'contacts',
              contact: {
                id: 'u_fixture',
                username: '10003',
                displayName: '合成好友',
                identityLabel: 'QQ',
                identityValue: '10003',
                avatarUrl: null,
                createdAt: '',
              },
            },
          }),
        ),
      );
      openTool('分析与报告');
      expect(document.querySelector('[aria-label="报告类型"]')).toBeNull();
      expect(document.querySelector('[aria-label="搜索分析对象"]')).toBeNull();
      expect(document.querySelector('[aria-label="分析时间范围"]')).not.toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      act(() => root.render(workspaceTools({ workspace: { view: 'settings' } })));
      openTool('分析与报告');
      expect(document.querySelector('[aria-label="报告类型"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="搜索分析对象"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it.each<ContentSelection['owner']>([
    { kind: 'conversations', container: 'main-list' },
    { kind: 'messages', container: 'group:10001' },
    { kind: 'contacts', container: 'friends' },
    { kind: 'qzone-posts', container: '10001' },
    { kind: 'collections', container: 'all' },
  ])('多选 $kind 不自动展开，仍可手动打开和在外部点击关闭', (owner) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () => act(() => root.render(workspaceTools()));
    try {
      fixture.selection = null;
      render();
      fixture.selection = { owner, scope: { type: 'items', ids: [] } };
      render();
      expect(menuTrigger().getAttribute('aria-expanded')).toBe('false');
      fixture.selection = { owner, scope: { type: 'items', ids: ['fixture'] } };
      render();
      expect(activeMenu()).toBeUndefined();
      act(() => menuTrigger().click());
      expect(menuTrigger().getAttribute('aria-expanded')).toBe('true');
      expect(activeMenu()?.querySelector('[aria-label="内容工具"]')).toBeTruthy();
      act(() => {
        document.body.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
        );
        // 点外关闭会吞掉同次手势的 click；补齐事件，避免它误吞下一用例的菜单点击。
        document.body.click();
      });
      expect(activeMenu()).toBeUndefined();
    } finally {
      fixture.selection = null;
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it('会话漫游请求打开固定目标浮窗，不展开全局工具栏', () => {
    const previousAccount = useViewState.getState().openedUin;
    useViewState.setState({ openedUin: '10002' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          workspaceTools({
            onOpenAnalysis: vi.fn(),
            roamingRequest: {
              targets: [{ kind: 'c2c', conv: 'u_fixture', name: '合成好友' }],
              revision: 1,
            },
          }),
        ),
      );
      const dialog = document.querySelector('[data-roaming-mode="fixed"]')!;
      expect(dialog.getAttribute('data-roaming-targets')).toBe('u_fixture');
      expect(dialog.closest('.weq-tools-modal')?.getAttribute('aria-modal')).not.toBe('true');
      expect(activeMenu()).toBeUndefined();
    } finally {
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it('内容页的显式导出请求打开同一个工具宿主，不需要旧独立弹窗', () => {
    const previousAccount = useViewState.getState().openedUin;
    useViewState.setState({ openedUin: '10002' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      fixture.exportRequest = {
        selection: {
          owner: { kind: 'qzone-posts', container: '19999' },
          scope: { type: 'items', ids: ['a', 'c'] },
        },
        revision: 1,
      };
      fixture.selection = fixture.exportRequest.selection;
      act(() => root.render(workspaceTools()));
      expect(
        document
          .querySelector('.weq-tools-modal [data-export-ids]')
          ?.getAttribute('data-export-ids'),
      ).toBe('a,c');
      expect(document.querySelector('#weq-tools-title')?.textContent).toBe('导出');
      const draft = document.querySelector<HTMLInputElement>(
        '.weq-tools-modal [aria-label="合成导出草稿"]',
      )!;
      draft.value = '工具内调整后的范围';
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      openTool('导出');
      expect(
        document.querySelector<HTMLInputElement>('.weq-tools-modal [aria-label="合成导出草稿"]')!
          .value,
      ).toBe('工具内调整后的范围');
    } finally {
      fixture.exportRequest = null;
      fixture.selection = null;
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it('已经打开过导出后，新一轮内容多选仍会交接为独立草稿', () => {
    const previousAccount = useViewState.getState().openedUin;
    useViewState.setState({ openedUin: '10002' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () => act(() => root.render(workspaceTools()));
    try {
      fixture.selection = {
        owner: { kind: 'conversations', container: 'recent' },
        scope: { type: 'items', ids: ['1'] },
      };
      render();
      openTool('导出');
      expect(
        document
          .querySelector('.weq-tools-modal [data-export-ids]')
          ?.getAttribute('data-export-ids'),
      ).toBe('1');
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      fixture.selection = { ...fixture.selection, scope: { type: 'items', ids: ['3', '7'] } };
      render();
      openTool('导出');
      expect(
        document
          .querySelector('.weq-tools-modal [data-export-ids]')
          ?.getAttribute('data-export-ids'),
      ).toBe('3,7');
      expect(
        document
          .querySelector('.weq-tools-modal [data-fixed-scope]')
          ?.getAttribute('data-fixed-scope'),
      ).toBe('false');
      expect(fixture.selection.scope).toEqual({ type: 'items', ids: ['3', '7'] });
    } finally {
      fixture.selection = null;
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it.each(['导出', 'WeQ 助手'])('%s 继续保留居中遮罩', (label) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(workspaceTools()));
      if (label === 'WeQ 助手') {
        const menu = openMenu();
        act(() => menu.querySelector<HTMLButtonElement>('[aria-label="切换到 WeQ 助手"]')!.click());
        act(() =>
          menu.querySelector<HTMLButtonElement>('[aria-label="打开完整助手面板"]')!.click(),
        );
      } else openTool(label);
      const dialog =
        label === 'WeQ 助手' ? activeMenu()! : document.querySelector('.weq-tools-modal')!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.closest('[hidden], [inert]')).toBeNull();
      expect(dialog.parentElement!.classList.contains('weq-nonmodal-layer')).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it('任务使用无模态菜单，关闭与切换工具仍保留任务现场', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.taskUnmounted.mockClear();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(workspaceTools()));
      openMenu();
      const progress = document.querySelector<HTMLButtonElement>('[data-task-progress]')!;
      const dialog = progress.closest<HTMLElement>('.weq-workspace-menu')!;
      expect(dialog.getAttribute('aria-modal')).not.toBe('true');
      expect(dialog.classList.contains('is-compact')).toBe(true);
      expect(hasActiveModal()).toBe(false);
      act(() => progress.click());
      expect(progress.dataset.taskProgress).toBe('1');
      expect(dialog.closest('[hidden]')).toBeNull();
      act(() => menuTrigger().click());
      expect(document.querySelector('[data-task-progress]')).toBe(progress);
      expect(fixture.taskUnmounted).not.toHaveBeenCalled();
      expect(progress.closest('[hidden]')).not.toBeNull();
      openTool('导出');
      expect(hasActiveModal()).toBe(true);
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      openMenu();
      expect(hasActiveModal()).toBe(false);
      expect(document.querySelector('[data-task-progress]')).toBe(progress);
      expect(progress.dataset.taskProgress).toBe('1');
      expect(fixture.taskUnmounted).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it('仅保留全局工具，漫游由会话入口打开，不混入数据库或缓存维护', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const analysis = vi.fn();
    const composition = vi.fn();
    try {
      act(() =>
        root.render(
          workspaceTools({
            onOpenAnalysis: analysis,
            onOpenComposition: composition,
          }),
        ),
      );
      const menu = openMenu();
      const buttons = [
        ...menu.querySelectorAll<HTMLButtonElement>('[aria-label="内容工具"] button'),
      ];
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        '分析与报告',
        '导出',
        '导出查看器',
        '合成聊天记录',
      ]);
      openTool('分析与报告');
      expect(analysis).not.toHaveBeenCalled();
      expect(document.querySelector('#weq-tools-title')?.textContent).toBe('分析与报告');
      expect(document.querySelector('[aria-label="报告类型"]')).not.toBeNull();
      expect(activeMenu()).toBeUndefined();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      openTool('合成聊天记录');
      expect(composition).toHaveBeenCalledOnce();
      expect(
        [...document.querySelectorAll('[aria-modal="true"]')].every((element) =>
          Boolean(element.closest('[hidden], [inert]')),
        ),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
