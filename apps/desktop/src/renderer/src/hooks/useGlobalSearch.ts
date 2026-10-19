import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { isSlowSearchCategory } from '../components/search/types';
import type {
  QuickSearchResult,
  SearchCategory,
  SlowSearchResult,
} from '../components/search/types';

interface SearchState {
  key: string;
  quick: QuickSearchResult | null;
  slow: SlowSearchResult | null;
  quickLoading: boolean;
  slowLoading: boolean;
  quickError: boolean;
  slowError: boolean;
}

function emptyState(key: string, quickLoading = false, slowLoading = false): SearchState {
  return {
    key,
    quick: null,
    slow: null,
    quickLoading,
    slowLoading,
    quickError: false,
    slowError: false,
  };
}

export function useGlobalSearch(
  keyword: string,
  categories: readonly SearchCategory[],
  accountKey: string | null,
) {
  const query = keyword.trim();
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([accountKey, query, categories, revision]);
  const hasQuick = Boolean(
    accountKey &&
      query &&
      categories.some((c) => ['conversation', 'friend', 'groupMember'].includes(c)),
  );
  const hasSlow = Boolean(accountKey && query && categories.some(isSlowSearchCategory));
  const [state, setState] = useState<SearchState>(() => emptyState(key, hasQuick, hasSlow));
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    let cancelled = false;
    const update = (patch: Partial<SearchState>) => {
      if (cancelled || currentKey.current !== key) return;
      setState((previous) => ({
        ...(previous.key === key ? previous : emptyState(key, hasQuick, hasSlow)),
        ...patch,
      }));
    };
    update(emptyState(key, hasQuick, hasSlow));
    if (!hasQuick && !hasSlow) return undefined;
    const timer = window.setTimeout(() => {
      const input = { keyword: query, limit: 3, categories: [...categories] };
      if (hasQuick) {
        void client.account.searchQuick.query(input).then(
          (quick) => update({ quick, quickLoading: false }),
          () => update({ quickError: true, quickLoading: false }),
        );
      }
      if (hasSlow) {
        void client.account.searchSlow.query(input).then(
          (slow) => update({ slow, slowLoading: false }),
          () => update({ slowError: true, slowLoading: false }),
        );
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, query, categories, hasQuick, hasSlow]);

  // 渲染新关键词/范围的第一帧就隐藏旧结果，不等 effect 才清空。
  return {
    ...(state.key === key ? state : emptyState(key, hasQuick, hasSlow)),
    retry: () => setRevision((value) => value + 1),
  };
}
