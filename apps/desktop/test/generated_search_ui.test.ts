import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLabView } from '../src/renderer/src/views/AgentLabView';
import { WorkspaceTools } from '../src/renderer/src/components/WorkspaceTools';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import type { GeneratedSearchHit } from '../src/renderer/src/components/search/types';
import { isGeneratedSearchHit } from '../src/renderer/src/components/search/types';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  options: vi.fn(),
  mutate: vi.fn(),
  missing: false,
  fetching: false,
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn(), confirm: vi.fn(), prompt: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const data = (name: string) => {
    const message = fixture.fetching
      ? { id: 'cached-old', role: 'user', text: '缓存旧数据', ts: 0 }
      : { id: 'message-hit', role: 'user', text: '合成搜索命中', ts: 1 };
    switch (name) {
      case 'listAgentLabPersonas':
        return [
          {
            id: 'p',
            name: '合成克隆',
            sourceId: 'u_fixture',
            sourceTitle: '本地样本',
            sourceUin: '10001',
            systemFaces: [],
            corpusMessageCount: 1,
          },
        ];
      case 'listAgentLabGroups':
        return [{ id: 'g', name: '合成克隆群', ownerId: '10000', createdAt: 1, updatedAt: 1 }];
      case 'listAssistantSessions':
        return [{ id: 'as', title: '合成助手会话', createdAt: 1, updatedAt: 1 }];
      case 'getAgentLabPersonaSessionConversation':
      case 'getAgentLabConversation':
      case 'getAssistantConversation':
        return fixture.missing ? [] : [message];
      case 'getAgentLabGroupConversation':
        return fixture.missing
          ? []
          : [{ ...message, groupId: 'g', senderId: '10000', senderKind: 'user' }];
      case 'getAgentLabGroupDetail':
        return { group: { id: 'g', name: '合成克隆群' }, members: [] };
      case 'getAssistantConfig':
        return {};
      case 'getAssistantResumeState':
        return { resumable: false };
      case 'getSelfProfile':
        return { uid: 'u_self', uin: '10000', nick: '我' };
      case 'listAgentLabPersonaSessions':
        return [{ id: 'ps', title: '合成会话', createdAt: 1, updatedAt: 1 }];
      case 'listAgentLabGroupSessions':
        return [{ id: 'gs', title: '合成群会话', createdAt: 1, updatedAt: 1 }];
      case 'getAgentLabTokenStats':
        return { total: {}, byDay: [], byPersona: [], byModel: [], records: [] };
      default:
        return [];
    }
  };
  const utils = new Proxy(() => Promise.resolve(), { get: () => utils });
  const cache = new Map<string, unknown>();
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useUtils') return () => utils;
        if (key === 'useQuery')
          return (input?: { sessionId?: string }, options?: { enabled?: boolean }) => {
            const name = path.at(-1)!;
            fixture.options(name, options);
            if (options?.enabled !== false) fixture.query(name, input);
            const key = JSON.stringify([name, input, fixture.missing, fixture.fetching]);
            if (!cache.has(key)) cache.set(key, data(name));
            return {
              data: options?.enabled === false ? undefined : cache.get(key),
              isLoading: false,
              isFetching: fixture.fetching,
              isSuccess: options?.enabled !== false,
              isError: false,
            };
          };
        if (key === 'useMutation')
          return () => ({ mutate: fixture.mutate, mutateAsync: fixture.mutate, isLoading: false });
        if (key === 'subscribe') return () => ({ unsubscribe: vi.fn() });
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

function target(kind: GeneratedSearchHit['kind'], legacy = false): GeneratedSearchHit {
  return {
    category: kind === 'assistant' ? 'assistantMessage' : 'cloneMessage',
    kind,
    ownerId: kind === 'persona' ? 'p' : kind === 'group' ? 'g' : 'assistant',
    sessionId: legacy ? null : kind === 'persona' ? 'ps' : kind === 'group' ? 'gs' : 'as',
    messageId: 'message-hit',
    title: '合成来源',
    sessionTitle: '合成会话',
    content: '合成搜索命中',
    ts: 1,
  };
}

it('生成内容按搜索类别区分，不把其它结果的 kind 字段误当生成来源', () => {
  expect(isGeneratedSearchHit(target('persona'))).toBe(true);
  expect(isGeneratedSearchHit(target('group'))).toBe(true);
  expect(isGeneratedSearchHit(target('assistant'))).toBe(true);
  const native = {
    category: 'conversation' as const,
    targetUid: 'u_native',
    targetUin: '10000',
    chatType: 1,
    name: '合成私聊',
    typeLabel: '私聊',
    kind: 'native',
  };
  expect(isGeneratedSearchHit(native)).toBe(false);
});

afterEach(() => {
  fixture.missing = false;
  fixture.fetching = false;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    scroll,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('生成内容搜索定位', () => {
  it('嵌入共享列表时不显示无会话的克隆占位文字', () => {
    const f = mount();
    try {
      act(() => f.root.render(createElement(AgentLabView, { embedded: true })));
      expect(f.host.textContent).not.toContain('暂无打开的克隆会话');
      expect(f.host.querySelector('.weq-agentlab-workspace')).not.toBeNull();
      expect(fixture.mutate).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['persona', 'group', 'assistant'] as const)(
    '%s 搜索跳转等到新快照，不把旧缓存 seed 成最终历史',
    async (kind) => {
      const f = mount();
      const hit = target(kind);
      const props = {
        mode: kind === 'assistant' ? ('assistant' as const) : ('clones' as const),
        searchTarget: hit,
      };
      fixture.fetching = true;
      try {
        act(() => f.root.render(createElement(AgentLabView, props)));
        expect(f.host.textContent).not.toContain('缓存旧数据');
        fixture.fetching = false;
        act(() => f.root.render(createElement(AgentLabView, props)));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(f.host.querySelector('.is-search-hit')?.textContent).toContain('合成搜索命中');
        const query =
          kind === 'persona'
            ? 'getAgentLabPersonaSessionConversation'
            : kind === 'group'
              ? 'getAgentLabGroupConversation'
              : 'getAssistantConversation';
        expect(fixture.options).toHaveBeenCalledWith(
          query,
          expect.objectContaining({ staleTime: 0, refetchOnMount: 'always' }),
        );
      } finally {
        f.close();
      }
    },
  );
  it('搜索结果标明生成来源，点击保留会话与消息身份', () => {
    const f = mount();
    const hit = target('persona');
    const select = vi.fn();
    try {
      act(() =>
        f.root.render(
          createElement(SearchDropdown, {
            keyword: '合成',
            quick: null,
            quickLoading: false,
            slow: {
              chatRecords: [],
              files: [],
              cloneMessages: [hit],
              assistantMessages: [],
              indexStatus: 'disabled',
            },
            slowLoading: false,
            categories: ['cloneMessage'],
            onCategoriesChange: vi.fn(),
            onSelect: select,
            onMore: vi.fn(),
          }),
        ),
      );
      const row = f.host.querySelector<HTMLButtonElement>('[role="option"]')!;
      expect(row.textContent).toContain('本地克隆对话');
      act(() => row.click());
      expect(select).toHaveBeenCalledWith(hit);
    } finally {
      f.close();
    }
  });

  it('窄屏列表开关保留既有会话及定位，不把返回列表当作新建草稿', async () => {
    const f = mount();
    try {
      act(() => f.root.render(createElement(AgentLabView, { searchTarget: target('persona') })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const row = f.host.querySelector('.is-search-hit');
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="会话列表"]')!.click());
      expect(f.host.querySelector('.weq-agentlab-shell')?.classList.contains('is-list-open')).toBe(
        true,
      );
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="返回对话"]')!.click());
      expect(f.host.querySelector('.weq-agentlab-shell')?.classList.contains('is-list-open')).toBe(
        false,
      );
      expect(f.host.querySelector('.is-search-hit')).toBe(row);
      expect(fixture.mutate).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['persona', 'group', 'assistant'] as const)(
    '%s 搜索打开对应既有会话并定位消息，不建草稿或发起生成',
    async (kind) => {
      const f = mount();
      try {
        act(() =>
          f.root.render(
            createElement(AgentLabView, {
              mode: kind === 'assistant' ? 'assistant' : 'clones',
              searchTarget: target(kind),
            }),
          ),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(f.host.querySelector('.is-search-hit')?.textContent).toContain('合成搜索命中');
        expect(f.scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
        const name =
          kind === 'persona'
            ? 'getAgentLabPersonaSessionConversation'
            : kind === 'group'
              ? 'getAgentLabGroupConversation'
              : 'getAssistantConversation';
        expect(fixture.query).toHaveBeenCalledWith(
          name,
          expect.objectContaining({ sessionId: target(kind).sessionId }),
        );
        expect(fixture.mutate).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it.each(['persona', 'group'] as const)(
    '旧版 %s 记录不当作草稿，保持只读且不触发发送',
    async (kind) => {
      const f = mount();
      try {
        act(() => f.root.render(createElement(AgentLabView, { searchTarget: target(kind, true) })));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(f.host.querySelector('.is-search-hit')?.textContent).toContain('合成搜索命中');
        const composer = f.host.querySelector<HTMLTextAreaElement>(
          '.weq-agentlab-composer textarea',
        )!;
        expect(composer.disabled).toBe(true);
        expect(composer.placeholder).toContain('只读');
        expect(fixture.mutate).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it('记录已删除时给出缺失状态，不用相邻消息冒充定位', async () => {
    const f = mount();
    fixture.missing = true;
    try {
      act(() => f.root.render(createElement(AgentLabView, { searchTarget: target('persona') })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(f.host.querySelector('[role="status"]')?.textContent).toContain('已不在');
      expect(f.scroll).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('助手搜索由工具宿主打开，不在主内容区域新增助手导航', async () => {
    const f = mount();
    try {
      act(() =>
        f.root.render(
          createElement(WorkspaceTools, {
            onOpenAnalysis: vi.fn(),
            assistantSearchTarget: target('assistant'),
          }),
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(document.querySelector('#weq-tools-title')?.textContent).toBe('WeQ 助手');
      expect(document.querySelector('.weq-tools-modal .is-search-hit')?.textContent).toContain(
        '合成搜索命中',
      );
    } finally {
      f.close();
    }
  });
});
