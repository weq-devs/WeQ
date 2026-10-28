// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  searchAppEntries,
  type AppSearchEntry,
} from '../src/renderer/src/components/search/appSearchCatalog';
import type { ExportMode } from '../src/renderer/src/views/export/types';

// 执行真实处理器，避免只验证目录目标而漏掉页面状态切换。
function sourceHandler<T>(relative: string, name: string, context: Record<string, unknown>): T {
  const file = new URL(relative, import.meta.url);
  const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      handler = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!handler) throw new Error('未找到全局搜索点击处理器');
  const compiled = ts.transpileModule(`export default ${handler.getText(source)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: { default?: T } = {};
  runInNewContext(compiled.outputText, { ...context, exports });
  if (!exports.default) throw new Error('未导出全局搜索点击处理器');
  return exports.default;
}

function searchHandler(context: Record<string, unknown>) {
  return sourceHandler<(entry: AppSearchEntry) => void>(
    '../src/renderer/src/views/MainView.tsx',
    'openAppSearchEntry',
    context,
  );
}

function navigationContext() {
  return {
    setSearchDismissed: vi.fn(),
    setSearchFocused: vi.fn(),
    setSettingsOpen: vi.fn(),
    setSettingsSearchTarget: vi.fn(),
    setMaintenanceTool: vi.fn(),
    setDressUpOpen: vi.fn(),
  };
}

describe('功能搜索实际导航', () => {
  it('导出请求携带具体种类，重复点击仍有新的 revision', () => {
    const setToolSearchRequest = vi.fn();
    searchHandler({ ...navigationContext(), setToolSearchRequest, messageScope: 'fixture' })(
      searchAppEntries('群文件导出')[0]!,
    );
    const update = setToolSearchRequest.mock.calls[0]![0];
    expect(update({ revision: 5 })).toEqual({
      scope: 'fixture',
      tool: 'export',
      exportMode: 'groupfile',
      revision: 6,
    });
  });
  it.each(['scheduled', 'groupfile', 'album', 'generated'] as const)(
    '导出工具采用搜索指定的 %s，不沿用当前聊天或旧选区',
    (mode) => {
      const openExport = vi.fn();
      const requestedSelection = { current: { old: true } as unknown };
      const select = sourceHandler<(tool: string, mode?: ExportMode) => void>(
        '../src/renderer/src/components/WorkspaceTools.tsx',
        'select',
        { closeWorkspace: vi.fn(), openExport, requestedSelection },
      );
      select('export', mode);
      expect(openExport).toHaveBeenCalledWith(null, { mode, fixed: false });
      expect(requestedSelection.current).toBeNull();
    },
  );
  it('漫游入口清除上一次的固定对象，由使用者在工具内选择', () => {
    const context = {
      closeWorkspace: vi.fn(),
      setRoamingTargets: vi.fn(),
      setRoamingSeed: vi.fn(),
      setTool: vi.fn(),
      setAssistantSettings: vi.fn(),
      setOpen: vi.fn(),
    };
    const select = sourceHandler<(tool: string) => void>(
      '../src/renderer/src/components/WorkspaceTools.tsx',
      'select',
      context,
    );
    select('backfill');
    expect(context.setRoamingTargets).toHaveBeenCalledWith([]);
    expect(context.setRoamingSeed).toHaveBeenCalledOnce();
    expect(context.setTool).toHaveBeenCalledWith('backfill');
    expect(context.setOpen).toHaveBeenCalledWith(true);
  });
  it.each([
    ['商城表情', 'emoji'],
    ['通话背景', 'callbg'],
  ] as const)('%s 重置旧表情包目标并定位 %s 页签', (query, kind) => {
    const context = {
      ...navigationContext(),
      setDressUpEmojiTarget: vi.fn(),
      setDressUpSearchKind: vi.fn(),
    };
    searchHandler(context)(searchAppEntries(query)[0]!);
    expect(context.setDressUpEmojiTarget).toHaveBeenCalledWith(null);
    expect(context.setDressUpSearchKind).toHaveBeenCalledWith(kind);
    expect(context.setDressUpOpen).toHaveBeenLastCalledWith(true);
  });
  it('频道私聊清除旧消息定位，发起新的展开请求', () => {
    const context = {
      ...navigationContext(),
      setGuildSearchTarget: vi.fn(),
      setGuildDirectOpenRequest: vi.fn(),
      shell: { view: 'home', switchView: vi.fn() },
    };
    searchHandler(context)(searchAppEntries('频道私聊')[0]!);
    expect(context.setGuildSearchTarget).toHaveBeenCalledWith(null);
    expect(context.setGuildDirectOpenRequest).toHaveBeenCalledOnce();
    expect(context.shell.switchView).toHaveBeenCalledWith('guild-direct');
  });
  it.each(['home', 'messages', 'agentlab'])('从 %s 打开克隆目录，清除旧筛选和详情', (view) => {
    const state = {
      view,
      query: '不匹配克隆的旧筛选',
      activeConversationId: 'old-chat' as string | null,
    };
    const context = {
      setSearchDismissed: vi.fn(),
      setSearchFocused: vi.fn(),
      setSettingsOpen: vi.fn(),
      setSettingsSearchTarget: vi.fn(),
      setMaintenanceTool: vi.fn(),
      setDressUpOpen: vi.fn(),
      flushAllDirtyDrafts: vi.fn(),
      setSurfaceNavigation: vi.fn(),
      setArkFeedState: vi.fn(),
      setCloneSearchTarget: vi.fn(),
      setVirtualOpen: vi.fn(),
      setConversationScope: vi.fn(),
      shell: {
        get view() {
          return state.view;
        },
        setQuery: (query: string) => {
          state.query = query;
        },
        switchView: (next: string) => {
          state.view = next;
          state.activeConversationId = 'auto-selected-chat';
        },
        backConversation: () => {
          state.activeConversationId = null;
        },
      },
    };
    searchHandler(context)(searchAppEntries('克隆')[0]!);
    expect(state).toEqual({ view: 'messages', query: '', activeConversationId: null });
    expect(context.setConversationScope).toHaveBeenCalledWith('virtual');
    expect(context.setVirtualOpen).toHaveBeenCalledWith(null);
    expect(context.setCloneSearchTarget).toHaveBeenCalledWith(null);
    expect(context.setArkFeedState).toHaveBeenCalledWith(null);
    expect(context.flushAllDirtyDrafts).toHaveBeenCalledOnce();
    expect(context.setSearchDismissed).toHaveBeenCalledWith(true);
  });
});
