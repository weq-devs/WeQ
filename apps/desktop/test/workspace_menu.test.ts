import { act, createElement as h, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import {
  WorkspaceMenuButton,
  WorkspaceSettingsButton,
} from '../src/renderer/src/components/WorkspaceMenuButton';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { useUpdateStore } from '../src/renderer/src/state/update';

const fixture = vi.hoisted(() => ({
  mounts: 0,
  clones: [],
  exports: [] as { id: string; status: 'running' | 'completed' | 'failed' }[],
}));
// 工具行为在这里同步验证，懒加载生命周期由页面卸载测试覆盖。
vi.mock('../src/renderer/src/components/lazyWorkspaces', async () => ({
  ...(await import('../src/renderer/src/views/ExportView')),
  ...(await import('../src/renderer/src/views/ExportViewer')),
  ...(await import('../src/renderer/src/views/analysis/AnalysisTool')),
  ...(await import('../src/renderer/src/components/RoamingBackfillPanel')),
  preloadWorkspace: vi.fn(),
}));
vi.mock('../src/renderer/src/views/agentlab/cloneTaskStore', () => ({
  getCloneTasks: () => fixture.clones,
  subscribeCloneTasks: () => () => {},
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (state: { openedUin: string }) => unknown) =>
    select({ openedUin: 'fixture' }),
}));
vi.mock('../src/renderer/src/state/contentSelection', () => ({
  useContentExportRequest: () => null,
  useContentAnalysisRequest: () => null,
  useCurrentContentSelection: () => null,
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    backgroundTasks: { list: { useQuery: () => ({ data: [] }) } },
    useUtils: () => ({}),
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: 'fixture', configId: 'fixture' } }) },
      listExportTasks: { useQuery: () => ({ data: fixture.exports }) },
      roamingBackfill: { list: { useQuery: () => ({ data: { jobs: [] } }) } },
      flashListDownloadTasks: { useQuery: () => ({ data: [] }) },
    },
  },
}));
vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({
    taskLayout,
    onTaskExpand,
    taskToolbarAction,
  }: {
    taskLayout: string;
    onTaskExpand?: () => void;
    taskToolbarAction?: ReactNode;
  }) =>
    h(
      'div',
      null,
      taskToolbarAction,
      h('button', { onClick: onTaskExpand, 'data-task-layout': taskLayout }, '合成任务'),
    ),
}));
vi.mock('../src/renderer/src/views/ExportViewer', () => ({ ExportViewer: () => null }));
vi.mock('../src/renderer/src/views/analysis/AnalysisTool', () => ({ AnalysisTool: () => null }));
vi.mock('../src/renderer/src/components/RoamingBackfillPanel', () => ({
  RoamingBackfillPanel: ({ onSubmitted }: { onSubmitted?: () => void }) =>
    h('button', { onClick: onSubmitted }, '合成漫游提交成功'),
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantMenuWorkspace', () => ({
  AssistantMenuWorkspace: () => {
    const [text, setText] = useState('');
    useEffect(() => {
      fixture.mounts++;
    }, []);
    return h('input', {
      'aria-label': '合成助手草稿',
      value: text,
      onChange: (event) => setText(event.currentTarget.value),
    });
  },
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  fixture.mounts = 0;
  fixture.exports = [];
  useWorkspaceMenu.setState({
    anchor: null,
    running: 0,
    failed: 0,
    finished: 0,
    assistant: 'idle',
    assistantUnread: false,
    taskScope: null,
    taskItems: [],
    readTaskResults: {},
    readTaskResultsByScope: {},
  });
  useUpdateStore.setState({ available: false });
});
afterEach(() => vi.unstubAllGlobals());

describe('统一竖向工作菜单', () => {
  it('现行工具菜单支持 Escape 和外部点击关闭，关闭后焦点回到原入口', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(
            'div',
            null,
            h(WorkspaceMenuButton),
            h(WorkspaceTools, {
              accountScope: 'retirement-menu',
              footerControls: null,
              onOpenAnalysis: vi.fn(),
            }),
          ),
        ),
      );
      const trigger = host.querySelector<HTMLButtonElement>('.weq-workspace-menu-trigger')!;
      act(() => {
        trigger.focus();
        trigger.click();
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(useWorkspaceMenu.getState().anchor).toBeNull();
      expect(document.activeElement).toBe(trigger);
      act(() => trigger.click());
      act(() => {
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        document.body.click();
      });
      expect(useWorkspaceMenu.getState().anchor).toBeNull();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('账号来源尚未确定时不建立任务已读快照', () => {
    const root = createRoot(document.createElement('div'));
    try {
      fixture.exports = [{ id: 'old', status: 'completed' }];
      act(() =>
        root.render(
          h(WorkspaceTools, {
            accountScope: '',
            footerControls: null,
            onOpenAnalysis: vi.fn(),
          }),
        ),
      );
      expect(useWorkspaceMenu.getState().taskScope).toBeNull();
      expect(window.localStorage.getItem('weq:workspace-read:v1::tasks')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('历史任务不弹出，新任务自动打开完整列表，状态刷新不重复打开', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(() =>
        root.render(
          h(WorkspaceTools, {
            accountScope: 'new-task-entry',
            footerControls: null,
            onOpenAnalysis: vi.fn(),
          }),
        ),
      );
    try {
      fixture.exports = [{ id: 'old', status: 'completed' }];
      render();
      expect(document.querySelector('[data-task-layout="split"]')).toBeNull();
      fixture.exports = [{ id: 'new', status: 'running' }];
      render();
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
      const taskPanel = document
        .querySelector('[data-task-layout="split"]')!
        .closest('.weq-workspace-menu')!;
      const request = useWorkspaceMenu.getState().taskOpenRequest;
      act(() => taskPanel.querySelector<HTMLButtonElement>('[aria-label="关闭完整面板"]')!.click());
      fixture.exports = [{ id: 'new', status: 'completed' }];
      render();
      expect(document.querySelector('[data-task-layout="split"]')).toBeNull();
      expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(request);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('漫游提交成功后关闭配置并打开常规任务完整面板', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(WorkspaceTools, {
            accountScope: 'roaming-entry',
            footerControls: null,
            onOpenAnalysis: vi.fn(),
            roamingRequest: {
              revision: 1,
              targets: [{ kind: 'c2c', conv: 'u_fixture', name: '合成好友' }],
            },
          }),
        ),
      );
      expect(document.querySelector('#weq-backfill-title')).not.toBeNull();
      act(() =>
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent === '合成漫游提交成功')!
          .click(),
      );
      expect(document.querySelector('#weq-backfill-title')?.closest('[hidden]')).not.toBeNull();
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('闪传入口直接打开常规任务完整面板，重复打开仍然有效', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(WorkspaceTools, {
            accountScope: 'flash-entry',
            footerControls: null,
            onOpenAnalysis: vi.fn(),
          }),
        ),
      );
      act(() => useWorkspaceMenu.getState().openTasks());
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭完整面板"]')!.click());
      act(() => useWorkspaceMenu.getState().openTasks());
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it('菜单汇总蓝红点，助手状态并入汇总，版本更新不串到菜单头操作', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(() =>
        root.render(
          h(
            'div',
            null,
            h(WorkspaceMenuButton),
            h(WorkspaceTools, {
              accountScope: 'indicators',
              footerControls: null,
              onOpenAnalysis: vi.fn(),
            }),
          ),
        ),
      );
    const trigger = () => host.querySelector<HTMLButtonElement>('.weq-workspace-menu-trigger')!;
    // 菜单头部仅保留关闭；助手侧状态已并入菜单按钮的汇总标记。
    const head = () => document.querySelector('.weq-workspace-menu-head-actions');
    try {
      render();
      act(() => trigger().click());
      act(() => useUpdateStore.setState({ available: true }));
      expect(trigger().querySelector('.is-finished')).not.toBeNull();
      expect(trigger().querySelector('.is-finished')?.textContent).toBe('1');
      expect(head()?.querySelector('.weq-workspace-dot') ?? null).toBeNull();
      act(() => useWorkspaceMenu.getState().setAssistant('running'));
      expect(trigger().querySelector('.is-running')).not.toBeNull();
      expect(trigger().querySelector('.is-running')?.textContent).toBe('1');
      expect(head()?.querySelector('.is-running') ?? null).toBeNull();
      const output = process.env.WEQ_WORKSPACE_LAYOUT_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        const styles = ['index.css', 'workspace-menu.css', 'rail-navigation.css']
          .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
          .join('\n');
        writeFileSync(
          resolve(output, 'workspace-indicators.html'),
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>body{margin:20px;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}.weq-workspace-menu{width:320px}</style><body>${host.innerHTML}${document.querySelector('.weq-workspace-menu')!.outerHTML}</body></html>`,
        );
      }
      act(() => useWorkspaceMenu.getState().setAssistant('finished'));
      // 助手未读与版本更新都汇总到菜单按钮，菜单头操作不带状态点。
      expect(trigger().querySelector('.is-finished')?.textContent).toBe('2');
      expect(head()?.querySelector('.weq-workspace-dot') ?? null).toBeNull();
      fixture.exports = [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'completed' },
        { id: 'c', status: 'failed' },
      ];
      render();
      expect(useWorkspaceMenu.getState()).toMatchObject({ running: 1, finished: 2, failed: 1 });
      expect(trigger().querySelector('.is-running')).not.toBeNull();
      expect(trigger().querySelector('.is-running')?.textContent).toBe('1');
      expect(head()?.querySelector('.weq-workspace-dot') ?? null).toBeNull();
      fixture.exports = [
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'completed' },
        { id: 'c', status: 'failed' },
      ];
      render();
      expect(trigger().querySelector('.is-finished')).not.toBeNull();
      // 已完成任务 2 + 助手未读 1 + 版本更新 1。
      expect(trigger().querySelector('.is-finished')?.textContent).toBe('5');
      act(() => useWorkspaceMenu.getState().readTasks());
      expect(head()?.querySelector('.weq-workspace-dot') ?? null).toBeNull();
      expect(trigger().querySelector('.is-finished')?.textContent).toBe('2');
      fixture.exports = [];
      render();
      expect(head()?.querySelector('.weq-workspace-dot') ?? null).toBeNull();
      expect(trigger().querySelector('.is-finished')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('点击打开，四个工具顺序固定，任务面板展开收起保持同一子树', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.getAttribute('aria-label') === label,
      )!;
    try {
      act(() =>
        root.render(
          h(
            'div',
            null,
            h(WorkspaceMenuButton),
            h(WorkspaceTools, {
              accountScope: 'fixture/config',
              footerControls: h(WorkspaceSettingsButton, { onClick: close }),
              onOpenAnalysis: vi.fn(),
              onOpenComposition: vi.fn(),
            }),
          ),
        ),
      );
      act(() => button('菜单').click());
      expect(
        [...document.querySelectorAll('.weq-workspace-actions button')].map((item) =>
          item.getAttribute('aria-label'),
        ),
      ).toEqual(['分析与报告', '导出', '导出查看器', '合成聊天记录']);
      expect(
        [...document.querySelectorAll('.weq-workspace-actions button span')].map(
          (item) => item.textContent,
        ),
      ).toEqual(['分析', '导出', '查看', '合成']);
      // 菜单里只有任务面板：紧凑布局展开成完整面板再收起，仍复用同一棵子树。
      const compact = document.querySelector('[data-task-layout="compact"]');
      expect(compact).not.toBeNull();
      expect(document.querySelector('.weq-workspace-menu-head')).toBeNull();
      expect(button('打开完整任务面板')).toBeDefined();
      act(() => compact!.click());
      expect(document.querySelector('.weq-workspace-menu')?.getAttribute('aria-modal')).toBe(
        'true',
      );
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
      act(() => button('收起到菜单').click());
      expect(document.querySelector('[data-task-layout="compact"]')).toBe(compact);
      act(() => button('打开完整任务面板').click());
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
      act(() => button('关闭完整面板').click());
      expect(useWorkspaceMenu.getState().anchor).toBeNull();
      act(() => button('菜单').click());
      expect(document.querySelector('[data-task-layout="compact"]')).not.toBeNull();
      act(() => button('设置').click());
      expect(close).toHaveBeenCalledOnce();
      expect(useWorkspaceMenu.getState().anchor).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('入口汇总更新与失败提示，设置按钮标明更新来源，打开不抹掉提示', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => {
        useUpdateStore.setState({ available: true });
        useWorkspaceMenu.setState({ running: 2, failed: 1 });
        root.render(
          h('div', null, h(WorkspaceMenuButton), h(WorkspaceSettingsButton, { onClick: vi.fn() })),
        );
      });
      expect(
        host.querySelector('[aria-label="设置，有新版本可更新"] .weq-workspace-dot'),
      ).not.toBeNull();
      const trigger = host.querySelector<HTMLButtonElement>('.weq-workspace-menu-trigger')!;
      expect(trigger.getAttribute('aria-label')).toContain('2 项任务进行中');
      expect(trigger.getAttribute('aria-label')).toContain('1 项任务失败');
      act(() => trigger.click());
      expect(useUpdateStore.getState().available).toBe(true);
      expect(useWorkspaceMenu.getState().failed).toBe(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
