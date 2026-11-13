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
  // 处理器闭包引用的页面状态很多（还散落在 useCallback 依赖数组里），
  // 用例只给需要断言的键，其余标识符用空实现兜住，避免逐项追着源码补。
  const sandbox: Record<string | symbol, unknown> = { ...context, exports };
  runInNewContext(
    compiled.outputText,
    new Proxy(sandbox, {
      has: (target, key) => (typeof key === 'string' ? true : key in target),
      get: (target, key) => {
        if (key in target) return target[key as string];
        if (typeof key === 'string' && key in globalThis)
          return (globalThis as unknown as Record<string, unknown>)[key];
        return vi.fn();
      },
      set: (target, key, value) => {
        target[key as string] = value;
        return true;
      },
    }),
  );
  if (!exports.default) throw new Error('未导出全局搜索点击处理器');
  return exports.default;
}

function searchHandler(context: Record<string, unknown>) {
  const openAppSearchEntryNow = sourceHandler<(entry: AppSearchEntry) => void>(
    '../src/renderer/src/views/MainView.tsx',
    'openAppSearchEntryNow',
    context,
  );
  return sourceHandler<(entry: AppSearchEntry) => void>(
    '../src/renderer/src/views/MainView.tsx',
    'openAppSearchEntry',
    {
      settingsNavigation: { navigate: (action: () => void) => action() },
      ...context,
      openAppSearchEntryNow,
    },
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
  it('导航确认未放行时不切换工具或清除设置现场', () => {
    const context = {
      ...navigationContext(),
      settingsNavigation: { navigate: vi.fn() },
      setToolSearchRequest: vi.fn(),
    };
    searchHandler(context)(searchAppEntries('群文件导出')[0]!);
    expect(context.settingsNavigation.navigate).toHaveBeenCalledOnce();
    expect(context.setToolSearchRequest).not.toHaveBeenCalled();
    expect(context.setSettingsOpen).not.toHaveBeenCalled();
  });
  it('群搜索进入临时会话时分别保留真实群名和备注，供群名片使用', () => {
    const setTemporaryConversations = vi.fn();
    const jumpToConvSeq = vi.fn();
    const open = sourceHandler<(hit: unknown) => void>(
      '../src/renderer/src/views/MainView.tsx',
      'openSearchHit',
      {
        useCallback: (callback: unknown) => callback,
        setSearchDismissed: vi.fn(),
        setSearchFocused: vi.fn(),
        isContentSearchHit: () => false,
        isGeneratedSearchHit: () => false,
        conversations: [],
        hiddenConversationsById: new Map(),
        deletedConversationsById: new Map(),
        setTemporaryConversations,
        jumpToConvSeq,
        groupAvatarSrc: () => null,
        fallbackPreference: {},
        centerWindowOnSeq: vi.fn(),
        pushToast: vi.fn(),
        shell: {},
        searchQuery: '',
        user: { identityValue: '10001' },
        setSettingsOpen: vi.fn(),
        setDressUpOpen: vi.fn(),
      },
    );
    open({ category: 'group', groupCode: '20001', name: '真实群名', remark: '群备注' });
    const update = setTemporaryConversations.mock.calls[0]![0];
    expect(update({})['20001'].conversation.group).toMatchObject({
      name: '真实群名',
      remark: '群备注',
    });
    expect(jumpToConvSeq).toHaveBeenCalledWith(
      'group',
      '20001',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
    );
  });

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
  it('频道私聊切到频道会话视图并进消息页，不沿用旧的消息定位', () => {
    const context = {
      ...navigationContext(),
      changeConversationView: vi.fn(),
      setGuildSearchTarget: vi.fn(),
      shell: { view: 'home', switchView: vi.fn() },
    };
    searchHandler(context)(searchAppEntries('频道私聊')[0]!);
    expect(context.changeConversationView).toHaveBeenCalledWith('guild');
    expect(context.shell.switchView).toHaveBeenCalledWith('messages');
    expect(context.setGuildSearchTarget).not.toHaveBeenCalled();
  });
  it.each(['home', 'messages', 'agentlab'])('从 %s 打开克隆目录，清除旧筛选和详情', (view) => {
    const state = {
      view,
      query: '不匹配克隆的旧筛选',
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
      changeConversationView: vi.fn(),
      shell: {
        get view() {
          return state.view;
        },
        setQuery: (query: string) => {
          state.query = query;
        },
        switchView: (next: string) => {
          state.view = next;
        },
      },
    };
    searchHandler(context)(searchAppEntries('克隆')[0]!);
    // 克隆目录是会话视图：清掉旧搜索词、重放页面状态，再切到克隆视图进消息页。
    expect(state).toEqual({ view: 'messages', query: '' });
    expect(context.changeConversationView).toHaveBeenCalledWith('clone');
    expect(context.setSurfaceNavigation).toHaveBeenCalledOnce();
    expect(context.flushAllDirtyDrafts).toHaveBeenCalledOnce();
    expect(context.setSearchDismissed).toHaveBeenCalledWith(true);
  });
});
