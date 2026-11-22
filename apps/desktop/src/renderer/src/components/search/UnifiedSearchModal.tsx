/** 搜索结果框内的分类分页结果，不创建独立弹窗。 */

import { NumericText } from '../NumericText';
import { EmptyState } from '../EmptyState';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ArrowLeft, RefreshCw, SearchX } from 'lucide-react';
import { SearchResultCard } from './SearchResultCard';
import { SearchListSkeleton } from './SearchSkeleton';
import {
  CATEGORY_META,
  searchHitKey,
  unavailableMessageSearchHint,
  type MoreSearchResult,
  type SearchCategory,
  type SearchHit,
} from './types';
import { client } from '../../trpc/client';
import { SearchPositionRestore, type SearchPosition } from './searchPosition';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import type {
  ConversationScope,
  GlobalChatRecordFilter,
  SearchSource,
} from '@weq/service/search-policy';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import '../../styles/search-more.css';

export interface SearchMoreSnapshot extends SearchPosition {
  category: SearchCategory;
  keyword: string;
  data: MoreSearchResult & { changed?: boolean };
  nextOffset: number;
  error: 'more' | null;
}

export function SearchMoreResults({
  category,
  keyword,
  onBack,
  onSelect,
  onOpenChatRecords,
  initialSnapshot,
  onNavigate,
  onSnapshot,
  conversationScope = 'all',
  sources,
  recordFilter,
  filters,
  accountBinding,
}: {
  category: SearchCategory;
  keyword: string;
  onBack: () => void;
  onSelect: (hit: SearchHit) => void;
  onOpenChatRecords: (hit: SearchHit) => void;
  initialSnapshot?: SearchMoreSnapshot;
  onNavigate?: (snapshot: SearchMoreSnapshot) => void;
  onSnapshot?: (snapshot: SearchMoreSnapshot) => void;
  conversationScope?: ConversationScope;
  sources?: readonly SearchSource[];
  recordFilter?: GlobalChatRecordFilter;
  filters?: ReactNode;
  accountBinding?: QQWriteBinding;
}): ReactElement {
  const activity = useQQReadActivity(true);
  const readEnabled = useRef(activity.enabled);
  readEnabled.current = activity.enabled;
  const debounceTimer = useRef<number | undefined>(undefined);
  const restored = useRef(initialSnapshot?.category === category ? initialSnapshot : undefined);
  const [data, setData] = useState<(MoreSearchResult & { changed?: boolean }) | null>(
    restored.current?.data ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<'initial' | 'more' | null>(restored.current?.error ?? null);
  const runRef = useRef(0);
  const pending = useRef(false);
  const nextOffset = useRef(restored.current?.nextOffset ?? 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedFocusKey = useRef<string | null>(restored.current?.focusKey ?? null);
  const backRef = useRef<HTMLButtonElement>(null);
  const expectedAccountUin = accountBinding?.expectedAccountUin;
  const expectedAccountConfigId = accountBinding?.expectedAccountConfigId;
  const relevantFilter = category === 'chatRecord' ? recordFilter : undefined;
  const isQQMessageSearch = Boolean(filters);
  const heading = isQQMessageSearch ? '筛选 QQ 消息' : `${CATEGORY_META[category].label}搜索`;
  useLayoutEffect(() => {
    if (isQQMessageSearch && !restored.current) backRef.current?.focus({ preventScroll: true });
  }, [isQQMessageSearch]);
  const requestKey = JSON.stringify([
    category,
    keyword,
    sources ?? conversationScope,
    relevantFilter,
  ]);
  const restoredRequest = useRef(
    restored.current
      ? JSON.stringify([
          category,
          restored.current.keyword,
          sources ?? conversationScope,
          relevantFilter,
        ])
      : null,
  );

  const fetchPage = useCallback(
    async (pageKeyword: string, offset: number, append: boolean) => {
      if (!readEnabled.current) return;
      const run = ++runRef.current;
      pending.current = true;
      setError(null);
      if (!append) setLoading(true);
      else setLoadingMore(true);
      try {
        const result = (await client.account.searchMore.query({
          category,
          keyword: pageKeyword,
          offset,
          limit: 30,
          conversationScope: sources ? 'all' : conversationScope,
          ...(relevantFilter ? { sources: ['qq'] } : sources ? { sources: [...sources] } : {}),
          ...(relevantFilter
            ? { recordFilter: relevantFilter, expectedAccountUin, expectedAccountConfigId }
            : {}),
        })) as MoreSearchResult;
        if (run !== runRef.current) return;
        nextOffset.current = offset + result.items.length;
        setData((prev) => {
          if (!append || !prev) return result;
          const items = [
            ...new Map(
              [...prev.items, ...result.items].map((hit) => [searchHitKey(hit), hit]),
            ).values(),
          ];
          const changed =
            prev.changed ||
            items.length !== prev.items.length + result.items.length ||
            prev.total !== result.total ||
            prev.coverage?.updatedAt !== result.coverage?.updatedAt;
          return { ...result, items, changed };
        });
      } catch (err) {
        if (run !== runRef.current) return;
        setError(append ? 'more' : 'initial');
        console.error('[search-more] failed', err);
      } finally {
        if (run === runRef.current) {
          pending.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [
      category,
      conversationScope,
      sources,
      relevantFilter,
      expectedAccountUin,
      expectedAccountConfigId,
    ],
  );

  // Reset + fetch first page when the keyword settles.
  useLayoutEffect(() => {
    if (restoredRequest.current === requestKey) {
      return () => {
        ++runRef.current;
      };
    }
    restoredRequest.current = null;
    ++runRef.current;
    pending.current = false;
    nextOffset.current = 0;
    setData(null);
    setError(null);
    setLoadingMore(false);
    scrollRef.current?.scrollTo(0, 0);
    const trimmed = keyword.trim();
    if (!trimmed) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = window.setTimeout(() => void fetchPage(trimmed, 0, false), 250);
    debounceTimer.current = timer;
    return () => {
      ++runRef.current;
      pending.current = false;
      window.clearTimeout(timer);
    };
  }, [keyword, fetchPage, requestKey]);

  const previousActivity = useRef(activity);
  const currentData = useRef(data);
  currentData.current = data;
  useEffect(() => {
    const previous = previousActivity.current;
    previousActivity.current = { enabled: activity.enabled, revision: activity.revision };
    if (previous.enabled === activity.enabled && previous.revision === activity.revision) return;
    if (!activity.enabled) {
      window.clearTimeout(debounceTimer.current);
      ++runRef.current;
      pending.current = false;
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    // 翻页中的结果保留当前位置；回到列表头部时才需要校准第一页。
    if (
      keyword.trim() &&
      !pending.current &&
      (!currentData.current || (scrollRef.current?.scrollTop ?? 0) <= 48)
    ) {
      window.clearTimeout(debounceTimer.current);
      void fetchPage(keyword.trim(), 0, false);
    }
  }, [activity.enabled, activity.revision, keyword, fetchPage]);

  // Infinite scroll: fetch the next page near the bottom.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || pending.current || error || loading || loadingMore || !data?.hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void fetchPage(keyword.trim(), nextOffset.current, true);
    }
  }, [data, keyword, error, loading, loadingMore, fetchPage]);

  const snapshot = useRef<(() => void) | null>(null);
  snapshot.current = () => {
    if (!data || loading) return;
    onSnapshot?.({
      category,
      keyword,
      data,
      nextOffset: nextOffset.current,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
      focusKey:
        scrollRef.current?.querySelector<HTMLElement>(':focus')?.dataset.searchHitKey ??
        selectedFocusKey.current,
      error: error === 'more' ? 'more' : null,
    });
  };
  useLayoutEffect(() => () => snapshot.current?.(), []);

  const retry = (
    <div className="weq-search-failure" role="status">
      <span>{error === 'more' ? '加载更多失败' : '搜索失败'}</span>
      <button
        type="button"
        title="重试搜索"
        aria-label="重试搜索"
        onClick={() =>
          void fetchPage(
            keyword.trim(),
            error === 'more' ? nextOffset.current : 0,
            error === 'more',
          )
        }
      >
        <RefreshCw size={14} aria-hidden />
      </button>
    </div>
  );

  const unavailableMessageSearch = unavailableMessageSearchHint(data?.unavailableMessageSources);
  return (
    <div
      className="weq-search-dropdown weq-search-more-results"
      data-field-popup-host={filters ? '' : undefined}
    >
      <div className="weq-search-more-head">
        <button
          type="button"
          className="weq-search-more-back"
          data-search-back
          ref={backRef}
          onClick={onBack}
          title="返回搜索总览"
          aria-label="返回搜索总览"
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <h3 id="weq-search-more-title" className="weq-search-more-title">
          {heading}
        </h3>
      </div>
      {filters}
      <div
        className="weq-search-more-body"
        ref={scrollRef}
        onScroll={onScroll}
        role="listbox"
        aria-label={filters ? 'QQ 消息筛选结果' : `${heading}结果`}
        aria-busy={loading || loadingMore}
      >
        {!loading && unavailableMessageSearch ? (
          <div className="weq-search-failure" role="status">
            <span>{unavailableMessageSearch}</span>
          </div>
        ) : null}
        {error === 'initial' ? (
          retry
        ) : loading ? (
          <SearchListSkeleton rows={5} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={unavailableMessageSearch ? '可用来源未找到结果' : '无结果'}
            body={
              data.limited && isQQMessageSearch && !unavailableMessageSearch
                ? '本轮候选中没有匹配消息，可缩小时间范围再查。'
                : undefined
            }
          />
        ) : data ? (
          <>
            <div className="weq-search-more-total">
              {data.changed ? (
                <NumericText>{`已载入 ${data.items.length} 条 · 结果可能已更新${data.limited && !unavailableMessageSearch ? ' · 候选池有上限' : ''}`}</NumericText>
              ) : data.limited && isQQMessageSearch && !unavailableMessageSearch ? (
                <NumericText>{`本轮候选 · ${data.total} 个会话`}</NumericText>
              ) : data.limited && !unavailableMessageSearch ? (
                <NumericText>{`当前候选 ${data.total} 条 · 超出本轮检索上限`}</NumericText>
              ) : (
                <NumericText>{`共 ${data.total} 条结果`}</NumericText>
              )}
            </div>
            {data.changed ? (
              <div className="weq-search-failure" role="status">
                <span>来源已更新</span>
              </div>
            ) : null}
            {data.items.map((hit) => (
              <SearchResultCard
                key={searchHitKey(hit)}
                hit={hit}
                keyword={keyword.trim()}
                onSelect={(selected, focusKey) => {
                  selectedFocusKey.current = focusKey ?? searchHitKey(selected);
                  onNavigate?.({
                    category,
                    keyword,
                    data,
                    nextOffset: nextOffset.current,
                    scrollTop: scrollRef.current?.scrollTop ?? 0,
                    focusKey: focusKey ?? searchHitKey(selected),
                    error: error === 'more' ? 'more' : null,
                  });
                  if (selected.category === 'chatRecord') onOpenChatRecords(selected);
                  else onSelect(selected);
                }}
              />
            ))}
            {loadingMore ? <SearchListSkeleton rows={2} /> : null}
            {error === 'more' ? retry : null}
            {!data.hasMore && data.items.length > 0 ? (
              <div className="weq-search-more-end">
                {data.limited && !unavailableMessageSearch ? '本轮候选已显示完' : '没有更多了'}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <SearchPositionRestore container={scrollRef} position={restored.current} />
    </div>
  );
}
