import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import type { ContentSelection } from '../src/shared/content_selection';
import { useViewState } from '../src/renderer/src/state/view';
import { hasActiveModal } from '../src/renderer/src/lib/overlayStack';

const fixture = vi.hoisted(() => ({
  selection: null as ContentSelection | null,
  taskUnmounted: vi.fn(),
}));
vi.mock('../src/renderer/src/state/contentSelection', () => ({
  useCurrentContentSelection: () => fixture.selection,
}));

vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({
    initialSelection,
    surface,
  }: {
    initialSelection?: ContentSelection;
    surface?: 'tasks';
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
      { 'data-export-ids': seed?.scope.type === 'items' ? seed.scope.ids.join(',') : '' },
      '合成导出夹具',
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
  RoamingBackfillPanel: () => createElement('div', null, '合成补全夹具'),
}));

describe('全局工具条范围', () => {
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
        owner: { kind: 'messages', container: 'c2c:u_fixture' },
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
      expect(fixture.selection.scope).toEqual({ type: 'items', ids: ['3', '7'] });
    } finally {
      fixture.selection = null;
      act(() => root.unmount());
      host.remove();
      useViewState.setState({ openedUin: previousAccount });
      vi.unstubAllGlobals();
    }
  });
  it.each(['导出', '任务', '消息补全', 'WeQ 助手'])('%s 继续保留居中遮罩', (label) => {
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
  it('任务恢复遮罩，关闭与切换工具仍保留任务现场', () => {
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
      const dialog = document.querySelector<HTMLElement>('.weq-tools-modal')!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.parentElement!.classList.contains('weq-nonmodal-layer')).toBe(false);
      expect(hasActiveModal()).toBe(true);
      const progress = document.querySelector<HTMLButtonElement>('[data-task-progress]')!;
      act(() => progress.click());
      expect(progress.dataset.taskProgress).toBe('1');
      expect(dialog.closest('[hidden]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      expect(document.querySelector('[data-task-progress]')).toBe(progress);
      expect(fixture.taskUnmounted).not.toHaveBeenCalled();
      select('导出');
      expect(hasActiveModal()).toBe(true);
      select('任务');
      expect(hasActiveModal()).toBe(true);
      expect(document.querySelector('[data-task-progress]')).toBe(progress);
      expect(progress.dataset.taskProgress).toBe('1');
      expect(fixture.taskUnmounted).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
  it('仅保留全局工具并加入消息补全，不混入数据库或缓存维护', () => {
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
        '任务',
        '消息补全',
        '分析与报告',
        'WeQ 助手',
        '合成聊天记录',
      ]);
      act(() => buttons[3]!.click());
      expect(analysis).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
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
