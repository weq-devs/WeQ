import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import type { ExportMode } from '../src/renderer/src/views/export/types';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

const clones: never[] = [];
vi.mock('../src/renderer/src/views/agentlab/cloneTaskStore', () => ({
  getCloneTasks: () => clones,
  subscribeCloneTasks: () => () => {},
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (state: { openedUin: string }) => unknown) =>
    select({ openedUin: 'fixture' }),
}));
vi.mock('../src/renderer/src/state/contentSelection', () => ({
  useContentExportRequest: () => null,
  useContentAnalysisRequest: () => null,
  useCurrentContentSelection: () => ({
    owner: { kind: 'messages', container: 'c2c:u_fixture' },
    scope: { type: 'all' },
  }),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: () => ({ enabled: false }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      listExportTasks: { useQuery: () => ({ data: [] }) },
      roamingBackfill: { list: { useQuery: () => ({ data: { jobs: [] } }) } },
      flashListDownloadTasks: { useQuery: () => ({ data: [] }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/lazyWorkspaces', () => ({
  preloadWorkspace: vi.fn(),
  ExportViewer: () => null,
  AnalysisTool: () => null,
  ExportTool: ({
    initialMode,
    initialSelection,
  }: {
    initialMode?: string;
    initialSelection?: unknown;
  }) =>
    h('div', {
      'data-export-mode': initialMode,
      'data-fixed-selection': Boolean(initialSelection),
    }),
  RoamingBackfillPanel: ({
    targetMode,
    initialTargets,
  }: {
    targetMode: string;
    initialTargets: unknown[];
  }) =>
    h('div', { 'data-roaming-mode': targetMode, 'data-roaming-targets': initialTargets.length }),
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantMenuWorkspace', () => ({
  AssistantMenuWorkspace: () => null,
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useWorkspaceMenu.setState({ anchor: null });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['scheduled', 'groupfile', 'album', 'generated'] satisfies ExportMode[])(
  '真实工具宿主把搜索指定的 %s 传入导出面板，不带当前聊天选区',
  (mode) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(WorkspaceTools, {
            accountScope: 'fixture',
            footerControls: null,
            onOpenAnalysis: vi.fn(),
            searchRequest: { scope: 'fixture', tool: 'export', exportMode: mode, revision: 1 },
          }),
        ),
      );
      const pane = document.querySelector(`[data-export-mode="${mode}"]`);
      expect(pane).not.toBeNull();
      expect(pane?.getAttribute('data-fixed-selection')).toBe('false');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('从定向漫游再次通过功能搜索打开时，回到可选择会话的面板', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = { accountScope: 'fixture', footerControls: null, onOpenAnalysis: vi.fn() };
  try {
    act(() =>
      root.render(
        h(WorkspaceTools, {
          ...props,
          roamingRequest: {
            revision: 1,
            targets: [{ kind: 'c2c', conv: 'u_fixture', name: '合成好友' }],
          },
        }),
      ),
    );
    expect(document.querySelector('[data-roaming-mode="fixed"]')).not.toBeNull();
    act(() =>
      root.render(
        h(WorkspaceTools, {
          ...props,
          searchRequest: { scope: 'fixture', tool: 'backfill', revision: 1 },
        }),
      ),
    );
    expect(
      document.querySelector('[data-roaming-mode="select"]')?.getAttribute('data-roaming-targets'),
    ).toBe('0');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
