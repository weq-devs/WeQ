import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import type { ConversationScope } from '@weq/service/search-policy';
import { isSlowSearchCategory } from '../components/search/types';
import type {
  QuickSearchResult,
  SearchCategory,
  SearchCategoryStates,
  SlowSearchResult,
} from '../components/search/types';

interface CategoryResult {
  quick?: QuickSearchResult;
  slow?: SlowSearchResult;
  error: boolean;
}
interface SearchState {
  key: string;
  results: Partial<Record<SearchCategory, CategoryResult>>;
}

export function useGlobalSearch(
  keyword: string,
  categories: readonly SearchCategory[],
  accountKey: string | null,
  conversationScope: ConversationScope = 'all',
) {
  const query = keyword.trim();
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([accountKey, query, categories, conversationScope, revision]);
  const [state, setState] = useState<SearchState>(() => ({ key, results: {} }));
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    let cancelled = false;
    setState({ key, results: {} });
    const update = (category: SearchCategory, result: CategoryResult) => {
      if (cancelled || currentKey.current !== key) return;
      setState((previous) => ({
        key,
        results: { ...(previous.key === key ? previous.results : {}), [category]: result },
      }));
    };
    if (!accountKey || !query || !categories.length) return undefined;
    const timer = window.setTimeout(() => {
      for (const category of new Set(categories)) {
        const input = { keyword: query, limit: 3, categories: [category], conversationScope };
        if (isSlowSearchCategory(category)) {
          void client.account.searchSlow.query(input).then(
            (slow) => update(category, { slow, error: false }),
            () => update(category, { error: true }),
          );
        } else {
          void client.account.searchQuick.query(input).then(
            (quick) => update(category, { quick, error: false }),
            () => update(category, { error: true }),
          );
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, query, categories, accountKey, conversationScope]);

  // 按分类顺序合并，响应先后不改变同分结果顺序；新请求第一帧即隔离旧数据。
  const results = state.key === key ? state.results : {};
  const categoryStates: SearchCategoryStates = {};
  const quick: QuickSearchResult = { conversations: [], friends: [], groupMembers: [] };
  const slow: SlowSearchResult = {
    chatRecords: [],
    files: [],
    collections: [],
    cloneMessages: [],
    assistantMessages: [],
    indexStatus: 'disabled',
  };
  let hasQuick = false;
  let hasSlow = false;
  let quickLoading = false;
  let slowLoading = false;
  let quickError = false;
  let slowError = false;
  for (const category of new Set(categories)) {
    const result = results[category];
    const loading = Boolean(accountKey && query && !result);
    const error = result?.error ?? false;
    categoryStates[category] = { loading, error };
    if (isSlowSearchCategory(category)) {
      slowLoading ||= loading;
      slowError ||= error;
    } else {
      quickLoading ||= loading;
      quickError ||= error;
    }
    if (result?.quick) {
      hasQuick = true;
      const next = result.quick;
      if (category === 'contact') quick.contacts = next.contacts ?? [];
      if (category === 'group') quick.groups = next.groups ?? [];
      if (category === 'conversation') quick.conversations = next.conversations;
      if (category === 'friend') quick.friends = next.friends;
      if (category === 'groupMember') quick.groupMembers = next.groupMembers;
    }
    if (result?.slow) {
      hasSlow = true;
      const next = result.slow;
      if (category === 'chatRecord') {
        slow.messageHits = next.messageHits;
        slow.messageCoverage = next.messageCoverage;
      }
      if (category === 'chatRecord' || category === 'file') slow.indexStatus = next.indexStatus;
      slow.chatRecords.push(...next.chatRecords);
      slow.files.push(...next.files);
      slow.collections.push(...next.collections);
      slow.cloneMessages.push(...next.cloneMessages);
      slow.assistantMessages.push(...next.assistantMessages);
      slow.contentHits ??= [];
      slow.contentHits.push(...(next.contentHits ?? []));
      slow.contentCoverage = { ...slow.contentCoverage, ...next.contentCoverage };
      slow.failedCategories ??= [];
      slow.failedCategories.push(...(next.failedCategories ?? []));
    }
  }
  return {
    quick: hasQuick ? quick : null,
    slow: hasSlow ? slow : null,
    quickLoading,
    slowLoading,
    quickError,
    slowError,
    categoryStates,
    retry: () => setRevision((value) => value + 1),
  };
}
