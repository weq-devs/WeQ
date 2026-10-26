import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSearch } from '../src/renderer/src/hooks/useGlobalSearch';
import type { ConversationScope } from '@weq/service/search-policy';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { contactSearchHit } from './support/search-fixtures';
import {
  SEARCH_CATEGORY_ORDER,
  DEFAULT_SEARCH_CATEGORIES,
  type QuickSearchResult,
  type SearchCategory,
  type SlowSearchResult,
  type ChatRecordSearchHit,
} from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ quick: vi.fn(), slow: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchQuick: { query: rpc.quick }, searchSlow: { query: rpc.slow } } },
}));

const quickResult: QuickSearchResult = {
  contacts: [contactSearchHit({ uin: '10001' })],
  conversations: [],
  friends: [
    {
      category: 'friend',
      uid: 'u_fixture',
      uin: '10001',
      nick: '合成好友',
      remark: '',
      avatarUrl: null,
    },
  ],
  groupMembers: [],
};
const slowResult = {
  chatRecords: [],
  files: [],
  cloneMessages: [],
  assistantMessages: [],
  collections: [],
  indexStatus: 'disabled' as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountSearch() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let result!: ReturnType<typeof useGlobalSearch>;
  const Harness = ({
    query,
    categories,
    account,
    scope,
  }: {
    query: string;
    categories: SearchCategory[];
    account: string;
    scope: ConversationScope;
  }) => {
    result = useGlobalSearch(query, categories, account, scope);
    return null;
  };
  return {
    get result() {
      return result;
    },
    render(
      query: string,
      categories: SearchCategory[] = SEARCH_CATEGORY_ORDER,
      account = 'account-a',
      scope: ConversationScope = 'all',
    ) {
      act(() => root.render(createElement(Harness, { query, categories, account, scope })));
    },
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('全局搜索请求生命周期', () => {
  it('默认全选的每个分类均在同一轮防抖后独立派发', async () => {
    vi.useFakeTimers();
    rpc.quick.mockResolvedValue({ conversations: [], friends: [], groupMembers: [] });
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      f.render('合成');
      await act(async () => vi.advanceTimersByTimeAsync(200));
      const dispatched = [...rpc.quick.mock.calls, ...rpc.slow.mock.calls].flatMap(
        ([input]) => input.categories,
      );
      expect(new Set(dispatched)).toEqual(new Set(SEARCH_CATEGORY_ORDER));
      expect(dispatched).toHaveLength(SEARCH_CATEGORY_ORDER.length);
      expect(Object.values(f.result.categoryStates).every((status) => !status.loading)).toBe(true);
    } finally {
      f.close();
    }
  });
  it('分类同时发出、独立完成和失败，慢分类不阻塞结果，后到空结果不覆盖消息', async () => {
    vi.useFakeTimers();
    const contact = deferred<QuickSearchResult>();
    const group = deferred<QuickSearchResult>();
    const message = deferred<SlowSearchResult>();
    const messageHit: ChatRecordSearchHit = {
      category: 'chatRecord',
      source: 'group',
      partition: '1',
      targetUid: '1',
      targetUin: '0',
      name: '合成群',
      count: 1,
    };
    const file = deferred<typeof slowResult>();
    rpc.quick.mockImplementation(({ categories }) =>
      categories[0] === 'contact' ? contact.promise : group.promise,
    );
    rpc.slow.mockImplementation(({ categories }) =>
      categories[0] === 'chatRecord' ? message.promise : file.promise,
    );
    const f = mountSearch();
    try {
      f.render('合成', ['contact', 'group', 'chatRecord', 'file']);
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(rpc.quick.mock.calls.map(([input]) => input.categories)).toEqual([
        ['contact'],
        ['group'],
      ]);
      expect(rpc.slow.mock.calls.map(([input]) => input.categories)).toEqual([
        ['chatRecord'],
        ['file'],
      ]);
      await act(async () => contact.resolve(quickResult));
      expect(f.result.quick?.contacts).toEqual(quickResult.contacts);
      expect(f.result.quickLoading).toBe(true);
      expect(f.result.categoryStates.contact).toEqual({ loading: false, error: false });
      expect(f.result.categoryStates.group?.loading).toBe(true);
      await act(async () =>
        message.resolve({ ...slowResult, chatRecords: [messageHit], messageHits: [messageHit] }),
      );
      const hits = f.result.slow?.messageHits;
      await act(async () => file.resolve(slowResult));
      expect(f.result.slow?.messageHits).toBe(hits);
      expect(f.result.slow?.chatRecords).toEqual([messageHit]);
      expect(f.result.slowLoading).toBe(false);
      // 一个分类失败不污染其它分类的状态或已有结果。
      f.render('下一次', ['contact', 'group']);
      rpc.quick.mockImplementation(({ categories }) =>
        categories[0] === 'contact'
          ? Promise.resolve(quickResult)
          : Promise.reject(new Error('合成失败')),
      );
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(f.result.categoryStates.group).toEqual({ loading: false, error: true });
      expect(f.result.categoryStates.contact).toEqual({ loading: false, error: false });
      expect(f.result.quick?.contacts).toEqual(quickResult.contacts);
    } finally {
      f.close();
    }
  });
  it('切换会话显示范围即清除旧结果，迟到响应不覆盖新范围', async () => {
    vi.useFakeTimers();
    const old = deferred<QuickSearchResult>();
    rpc.quick
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...quickResult, contacts: [] });
    const f = mountSearch();
    try {
      const categories: SearchCategory[] = ['contact'];
      f.render('合成', categories, 'account-a', 'all');
      await act(async () => vi.advanceTimersByTimeAsync(200));
      f.render('合成', categories, 'account-a', 'virtual');
      expect(f.result.quick).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(rpc.quick).toHaveBeenLastCalledWith({
        keyword: '合成',
        categories,
        limit: 3,
        conversationScope: 'virtual',
      });
      await act(async () => old.resolve(quickResult));
      expect(f.result.quick?.contacts).toEqual([]);
    } finally {
      f.close();
    }
  });
  it('空输入时调整范围不发查询，开始输入后使用预先选择的范围', async () => {
    vi.useFakeTimers();
    rpc.quick.mockResolvedValue(quickResult);
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      for (const keyword of ['', '   ']) {
        f.render(keyword, ['friend']);
        f.render(keyword, ['file']);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(rpc.quick).not.toHaveBeenCalled();
        expect(rpc.slow).not.toHaveBeenCalled();
        expect(f.result.quickLoading || f.result.slowLoading).toBe(false);
      }
      f.render('关键词', ['file']);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rpc.quick).not.toHaveBeenCalled();
      expect(rpc.slow).toHaveBeenCalledWith({
        keyword: '关键词',
        limit: 3,
        categories: ['file'],
        conversationScope: 'all',
      });
    } finally {
      f.close();
    }
  });

  it('切换关键词当帧清除旧结果，晚到响应不覆盖新查询', async () => {
    vi.useFakeTimers();
    const late = deferred<QuickSearchResult>();
    rpc.quick
      .mockResolvedValueOnce(quickResult)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce({ ...quickResult, friends: [] });
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      f.render('第一次', ['friend']);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rpc.quick).toHaveBeenCalledWith({
        keyword: '第一次',
        limit: 3,
        categories: ['friend'],
        conversationScope: 'all',
      });
      expect(f.result.quick?.friends).toHaveLength(1);
      f.render('第二次', ['friend']);
      expect(f.result.quick).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      f.render('第三次', ['friend']);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await act(async () => {
        late.resolve(quickResult);
      });
      expect(f.result.quick?.friends).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it('范围变化和账号变化隔离在途结果，空范围不发 RPC', async () => {
    vi.useFakeTimers();
    const oldAccount = deferred<QuickSearchResult>();
    rpc.quick.mockReturnValueOnce(oldAccount.promise).mockResolvedValue(quickResult);
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      f.render('关键词', ['friend']);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rpc.slow).not.toHaveBeenCalled();
      f.render('关键词', ['file'], 'account-b');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await act(async () => {
        oldAccount.resolve(quickResult);
      });
      expect(f.result.quick).toBeNull();
      expect(f.result.slow).toMatchObject(slowResult);
      expect(rpc.slow).toHaveBeenCalledWith({
        keyword: '关键词',
        limit: 3,
        categories: ['file'],
        conversationScope: 'all',
      });
      f.render('关键词', []);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rpc.quick).toHaveBeenCalledOnce();
      expect(rpc.slow).toHaveBeenCalledOnce();
      expect(f.result.quickLoading || f.result.slowLoading).toBe(false);
    } finally {
      f.close();
    }
  });

  it('局部查询失败停止占位，重试不修改范围', async () => {
    vi.useFakeTimers();
    rpc.quick.mockRejectedValueOnce(new Error('离线夹具失败')).mockResolvedValue(quickResult);
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      f.render('关键词', ['friend', 'file']);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(f.result.quickLoading).toBe(false);
      expect(f.result.quickError).toBe(true);
      expect(f.result.slow).toMatchObject(slowResult);
      act(() => f.result.retry());
      expect(f.result.quickError).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(f.result.quick?.friends).toEqual(quickResult.friends);
      expect(rpc.quick).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  });

  it('卸载前取消防抖，已经发出的响应在卸载后被丢弃', async () => {
    vi.useFakeTimers();
    const f = mountSearch();
    f.render('关键词');
    f.close();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(rpc.quick).not.toHaveBeenCalled();
    expect(rpc.slow).not.toHaveBeenCalled();
    const late = deferred<QuickSearchResult>();
    rpc.quick.mockReturnValue(late.promise);
    const active = mountSearch();
    active.render('关键词', ['friend']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const before = active.result;
    active.close();
    await act(async () => {
      late.resolve(quickResult);
    });
    expect(active.result).toBe(before);
  });
});

describe('搜索范围与失败界面', () => {
  it('可见分类默认全选，频道与克隆合并且移除公共商城范围', () => {
    expect(DEFAULT_SEARCH_CATEGORIES).not.toContain('marketEmoji');
    expect(DEFAULT_SEARCH_CATEGORIES).not.toContain('cloneMessage');
    expect(DEFAULT_SEARCH_CATEGORIES).toContain('assistantMessage');
    expect(SEARCH_CATEGORY_ORDER).toHaveLength(new Set(SEARCH_CATEGORY_ORDER).size);
    expect(SEARCH_CATEGORY_ORDER).toEqual(DEFAULT_SEARCH_CATEGORIES);
    expect(SEARCH_CATEGORY_ORDER).not.toContain('guildMessage');
  });

  it('空间默认勾选，统一包含个人与他人的说说和相册来源', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const change = vi.fn();
    try {
      act(() =>
        root.render(
          createElement(SearchDropdown, {
            keyword: 'needle',
            quick: quickResult,
            slow: slowResult,
            quickLoading: false,
            slowLoading: false,
            categories: DEFAULT_SEARCH_CATEGORIES,
            onCategoriesChange: change,
            onSelect: vi.fn(),
            onMore: vi.fn(),
          }),
        ),
      );
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('.weq-search-scope button')];
      expect(
        buttons.find((node) => node.textContent === '空间')?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(buttons.some((node) => ['个人空间', '他人空间'].includes(node.textContent!))).toBe(
        false,
      );
      act(() => buttons.find((node) => node.textContent === '空间')!.click());
      const selected = change.mock.lastCall![0] as SearchCategory[];
      expect(selected).not.toContain('qzone');
    } finally {
      act(() => root.unmount());
    }
  });

  it('有结果的分类按最佳匹配排序，精确文件命中排在较长联系人命中之前', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(SearchDropdown, {
            keyword: '报告',
            quick: {
              ...quickResult,
              contacts: [contactSearchHit({ nick: '报告的作者' })],
            },
            slow: {
              ...slowResult,
              files: [
                {
                  category: 'file',
                  source: 'group',
                  partition: '1',
                  targetUid: '1',
                  targetUin: '0',
                  fileName: '报告',
                  msgId: '1',
                  msgSeq: '1',
                  sendTime: '1',
                  convName: '群',
                },
              ],
            },
            quickLoading: false,
            slowLoading: false,
            categories: ['contact', 'file'],
            onCategoriesChange: vi.fn(),
            onSelect: vi.fn(),
            onMore: vi.fn(),
          }),
        ),
      );
      expect(
        [...host.querySelectorAll('.weq-search-section-name')].map((node) => node.textContent),
      ).toEqual(['文件', '联系人']);
    } finally {
      act(() => root.unmount());
    }
  });
  it('使用图标按钮调整范围、全部为混合态，失败只替代对应类别并可重试', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const change = vi.fn();
    const retry = vi.fn();
    try {
      act(() =>
        root.render(
          createElement(SearchDropdown, {
            keyword: '合成',
            quick: null,
            slow: slowResult,
            quickLoading: false,
            slowLoading: false,
            quickError: true,
            categories: ['contact', 'file'],
            onCategoriesChange: change,
            onRetry: retry,
            onSelect: vi.fn(),
            onMore: vi.fn(),
          }),
        ),
      );
      const all = host.querySelector<HTMLButtonElement>('[aria-label="全部范围"]')!;
      expect(all.getAttribute('aria-pressed')).toBe('mixed');
      expect(
        [...host.querySelectorAll('.weq-search-section-name')].map((item) => item.textContent),
      ).toEqual(['联系人', '文件']);
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="重试联系人搜索"]')!.click());
      expect(retry).toHaveBeenCalledOnce();
      const friend = [...host.querySelectorAll<HTMLButtonElement>('.weq-search-scope button')].find(
        (item) => item.textContent === '联系人',
      )!;
      act(() => friend.click());
      expect(change).toHaveBeenLastCalledWith(['file']);
      act(() => all.click());
      expect(change).toHaveBeenLastCalledWith(SEARCH_CATEGORY_ORDER);
      expect(host.querySelector('.weq-search-skeleton')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
