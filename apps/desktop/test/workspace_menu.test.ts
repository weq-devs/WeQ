import { act, createElement as h, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import {
  WorkspaceMenuButton,
  WorkspaceSettingsButton,
} from '../src/renderer/src/components/WorkspaceMenuButton';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { useUpdateStore } from '../src/renderer/src/state/update';

const fixture = vi.hoisted(() => ({ mounts: 0, clones: [] }));
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
    useUtils: () => ({}),
    account: {
      listExportTasks: { useQuery: () => ({ data: [] }) },
      roamingBackfill: { list: { useQuery: () => ({ data: { jobs: [] } }) } },
      flashListDownloadTasks: { useQuery: () => ({ data: [] }) },
    },
  },
}));
vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({ taskLayout, onTaskExpand }: { taskLayout: string; onTaskExpand?: () => void }) =>
    h('button', { onClick: onTaskExpand, 'data-task-layout': taskLayout }, '合成任务'),
}));
vi.mock('../src/renderer/src/views/ExportViewer', () => ({ ExportViewer: () => null }));
vi.mock('../src/renderer/src/views/analysis/AnalysisTool', () => ({ AnalysisTool: () => null }));
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
  useWorkspaceMenu.setState({ anchor: null, running: 0, failed: 0 });
  useUpdateStore.setState({ available: false });
});
afterEach(() => vi.unstubAllGlobals());

describe('统一竖向工作菜单', () => {
  it('点击打开，四个工具顺序固定，任务与助手展开收起保持同一子树', () => {
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
      act(() => button('切换到 WeQ 助手').click());
      const input = document.querySelector('[aria-label="合成助手草稿"]');
      act(() => button('打开完整助手面板').click());
      expect(document.querySelector('.weq-workspace-menu')?.getAttribute('aria-modal')).toBe(
        'true',
      );
      expect(document.querySelector('[aria-label="合成助手草稿"]')).toBe(input);
      act(() => button('关闭完整面板').click());
      act(() => button('菜单').click());
      expect(document.querySelector('[aria-label="合成助手草稿"]')).toBe(input);
      act(() => button('切换到任务列表').click());
      act(() => document.querySelector<HTMLButtonElement>('[data-task-layout="compact"]')!.click());
      expect(document.querySelector('[data-task-layout="split"]')).not.toBeNull();
      act(() => button('收起到菜单').click());
      expect(document.querySelector('[data-task-layout="compact"]')).not.toBeNull();
      expect(fixture.mounts).toBe(1);
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
