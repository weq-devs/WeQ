import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
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
vi.mock('../src/renderer/src/views/AgentLabView', () => ({
  AgentLabView: () => createElement('div', null, '合成助手夹具'),
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

describe('全局工具条范围', () => {
  it('会话入口固定范围后，全局图标恢复完整选择界面且保留当前位置预选', () => {
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
    const open = (label: string) => {
      if (!document.querySelector('[role="toolbar"]'))
        act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(`[role="toolbar"] [aria-label="${label}"]`)!
          .click(),
      );
    };
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
          createElement(WorkspaceTools, {
            currentConversation: conversation,
            analysisRequest: { target: { kind: 'group', groupCode: '777' }, revision: 1 },
            onOpenAnalysis: vi.fn(),
          }),
        ),
      );
      expect(document.querySelector('[data-fixed-scope="true"]')).not.toBeNull();
      open('导出');
      expect(document.querySelector('[data-fixed-scope="false"]')).not.toBeNull();
      open('分析与报告');
      const types = document.querySelector<HTMLSelectElement>('[aria-label="报告类型"]');
      expect(types?.value).toBe('group');
      // 年度报告已挪到侧栏独立入口，工具里只剩群聊 / 好友 / 群成员。
      expect(types?.options.length).toBe(3);
      expect(document.querySelector('[aria-label="搜索分析对象"]')).not.toBeNull();
    } finally {
      fixture.exportRequest = null;
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
    const render = () =>
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: vi.fn() })));
    try {
      fixture.selection = null;
      render();
      fixture.selection = { owner, scope: { type: 'items', ids: [] } };
      render();
      expect(document.querySelector('.weq-tools-trigger')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      fixture.selection = { owner, scope: { type: 'items', ids: ['fixture'] } };
      render();
      expect(document.querySelector('[aria-label="全局工具"]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      expect(document.querySelector('[aria-label="全局工具"]')).not.toBeNull();
      act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(document.querySelector('[aria-label="全局工具"]')).toBeNull();
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
          createElement(WorkspaceTools, {
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
      expect(document.querySelector('[aria-label="全局工具"]')).toBeNull();
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
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: vi.fn() })));
      expect(document.querySelector('[data-export-ids]')?.getAttribute('data-export-ids')).toBe(
        'a,c',
      );
      expect(document.querySelector('#weq-tools-title')?.textContent).toBe('导出');
      const draft = document.querySelector<HTMLInputElement>('[aria-label="合成导出草稿"]')!;
      draft.value = '工具内调整后的范围';
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      if (!document.querySelector('[role="toolbar"]'))
        act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document.querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="导出"]')!.click(),
      );
      expect(document.querySelector<HTMLInputElement>('[aria-label="合成导出草稿"]')!.value).toBe(
        '工具内调整后的范围',
      );
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
    const render = () =>
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: vi.fn() })));
    const open = () => {
      if (!document.querySelector('[role="toolbar"]'))
        act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document.querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="导出"]')!.click(),
      );
    };
    try {
      fixture.selection = {
        owner: { kind: 'conversations', container: 'recent' },
        scope: { type: 'items', ids: ['1'] },
      };
      render();
      open();
      expect(document.querySelector('[data-export-ids]')?.getAttribute('data-export-ids')).toBe(
        '1',
      );
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      fixture.selection = { ...fixture.selection, scope: { type: 'items', ids: ['3', '7'] } };
      render();
      open();
      expect(document.querySelector('[data-export-ids]')?.getAttribute('data-export-ids')).toBe(
        '3,7',
      );
      expect(document.querySelector('[data-fixed-scope]')?.getAttribute('data-fixed-scope')).toBe(
        'false',
      );
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
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: vi.fn() })));
      act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(`[role="toolbar"] [aria-label="${label}"]`)!
          .click(),
      );
      const dialog = document.querySelector('.weq-tools-modal')!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.parentElement!.classList.contains('weq-nonmodal-layer')).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it('任务使用无模态锚定面板，关闭与切换工具仍保留任务现场', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.taskUnmounted.mockClear();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const select = (label: string) => {
      if (!document.querySelector('[role="toolbar"]'))
        act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(`[role="toolbar"] [aria-label="${label}"]`)!
          .click(),
      );
    };
    try {
      act(() => root.render(createElement(WorkspaceTools, { onOpenAnalysis: vi.fn() })));
      select('任务');
      const progress = document.querySelector<HTMLButtonElement>('[data-task-progress]')!;
      const dialog = progress.closest<HTMLElement>('.weq-tools-modal')!;
      expect(dialog.getAttribute('aria-modal')).not.toBe('true');
      expect(dialog.classList.contains('is-anchored')).toBe(true);
      expect(hasActiveModal()).toBe(false);
      act(() => progress.click());
      expect(progress.dataset.taskProgress).toBe('1');
      expect(dialog.closest('[hidden]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭任务"]')!.click());
      expect(document.querySelector('[data-task-progress]')).toBe(progress);
      expect(fixture.taskUnmounted).not.toHaveBeenCalled();
      select('导出');
      expect(hasActiveModal()).toBe(true);
      select('任务');
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
          createElement(WorkspaceTools, {
            onOpenAnalysis: analysis,
            onOpenComposition: composition,
          }),
        ),
      );
      act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
      expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
        '导出',
        '导出查看器',
        '任务',
        '分析与报告',
        'WeQ 助手',
        '合成聊天记录',
      ]);
      act(() =>
        document
          .querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="分析与报告"]')!
          .click(),
      );
      expect(analysis).not.toHaveBeenCalled();
      expect(document.querySelector('#weq-tools-title')?.textContent).toBe('分析与报告');
      expect(document.querySelector('[aria-label="报告类型"]')).not.toBeNull();
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      act(() => document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="合成聊天记录"]')!
          .click(),
      );
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
