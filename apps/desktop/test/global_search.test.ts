import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSearch } from '../src/renderer/src/hooks/useGlobalSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  SEARCH_CATEGORY_ORDER,
  type QuickSearchResult,
  type SearchCategory,
} from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ quick: vi.fn(), slow: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchQuick: { query: rpc.quick }, searchSlow: { query: rpc.slow } } },
}));

const quickResult: QuickSearchResult = {
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
const slowResult = { chatRecords: [], files: [], indexStatus: 'disabled' as const };

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
  }: {
    query: string;
    categories: SearchCategory[];
    account: string;
  }) => {
    result = useGlobalSearch(query, categories, account);
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
    ) {
      act(() => root.render(createElement(Harness, { query, categories, account })));
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
  it('默认全范围，切换关键词当帧清除旧结果，晚到响应不覆盖新查询', async () => {
    vi.useFakeTimers();
    const late = deferred<QuickSearchResult>();
    rpc.quick
      .mockResolvedValueOnce(quickResult)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce({ ...quickResult, friends: [] });
    rpc.slow.mockResolvedValue(slowResult);
    const f = mountSearch();
    try {
      f.render('第一次');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rpc.quick).toHaveBeenCalledWith({
        keyword: '第一次',
        limit: 3,
        categories: SEARCH_CATEGORY_ORDER,
      });
      expect(f.result.quick?.friends).toHaveLength(1);
      f.render('第二次');
      expect(f.result.quick).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      f.render('第三次');
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
      expect(f.result.slow).toEqual(slowResult);
      expect(rpc.slow).toHaveBeenCalledWith({ keyword: '关键词', limit: 3, categories: ['file'] });
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
      f.render('关键词');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(f.result.quickLoading).toBe(false);
      expect(f.result.quickError).toBe(true);
      expect(f.result.slow).toEqual(slowResult);
      act(() => f.result.retry());
      expect(f.result.quickError).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(f.result.quick).toEqual(quickResult);
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
  it('使用复选框调整范围、全部为混合态，失败只替代对应类别并可重试', () => {
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
            categories: ['friend', 'file'],
            onCategoriesChange: change,
            onRetry: retry,
            onSelect: vi.fn(),
            onMore: vi.fn(),
          }),
        ),
      );
      const all = host.querySelector<HTMLInputElement>('[aria-label="全部范围"]')!;
      expect(all.indeterminate).toBe(true);
      expect(
        [...host.querySelectorAll('.weq-search-section-name')].map((item) => item.textContent),
      ).toEqual(['好友', '文件']);
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="重试好友搜索"]')!.click());
      expect(retry).toHaveBeenCalledOnce();
      const friend = [...host.querySelectorAll('label')].find(
        (item) => item.textContent === '好友',
      )!;
      act(() => friend.querySelector('input')!.click());
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
