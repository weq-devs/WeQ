import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import type { SearchableTool } from '../src/renderer/src/components/search/appSearchCatalog';

const fixture = vi.hoisted(() => ({ clones: [] }));
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
vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({ surface }: { surface?: string }) =>
    h('div', { 'data-search-tool': surface === 'tasks' ? 'tasks' : 'export' }),
}));
vi.mock('../src/renderer/src/views/ExportViewer', () => ({
  ExportViewer: () => h('div', { 'data-search-tool': 'viewer' }),
}));
vi.mock('../src/renderer/src/views/analysis/AnalysisTool', () => ({
  AnalysisTool: () => h('div', { 'data-search-tool': 'analysis' }),
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantMenuWorkspace', () => ({
  AssistantMenuWorkspace: () => h('div', { 'data-search-tool': 'assistant' }),
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

describe('搜索直达现有工作工具', () => {
  it.each(['export', 'viewer', 'analysis', 'tasks', 'assistant'] as const)(
    '%s 仅处理当前账号来源的请求，关闭后可再次打开',
    (tool: SearchableTool) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const render = (scope: string, revision: number) =>
        act(() =>
          root.render(
            h(WorkspaceTools, {
              accountScope: 'fixture/config',
              footerControls: null,
              onOpenAnalysis: vi.fn(),
              searchRequest: { scope, revision, tool },
            }),
          ),
        );
      try {
        render('other/config', 1);
        expect(document.querySelector(`[data-search-tool="${tool}"]`)).toBeNull();
        render('fixture/config', 2);
        expect(document.querySelector(`[data-search-tool="${tool}"]`)).not.toBeNull();
        const closeSelector =
          tool === 'tasks' || tool === 'assistant'
            ? '[aria-label="关闭完整面板"]'
            : '[aria-label="关闭工具"]';
        const close = document.querySelector<HTMLButtonElement>(closeSelector)!;
        act(() => close.click());
        const closedButton = document.querySelector(closeSelector);
        expect(!closedButton || Boolean(closedButton.closest('[hidden], [inert]'))).toBe(true);
        render('fixture/config', 3);
        expect(document.querySelector(`[data-search-tool="${tool}"]`)).not.toBeNull();
        expect(document.querySelector(closeSelector)?.closest('[hidden], [inert]')).toBeNull();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
});
