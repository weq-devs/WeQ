/** Large horizontal "more" modal: full paginated results for one search category. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { RotateCw, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { SearchResultCard } from './SearchResultCard';
import { SearchListSkeleton } from './SearchSkeleton';
import {
  CATEGORY_META,
  contentCoverageText,
  searchHitKey,
  type MoreSearchResult,
  type SearchCategory,
  type SearchHit,
} from './types';
import { client } from '../../trpc/client';
import { SearchPositionRestore, type SearchPosition } from './searchPosition';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';

export interface SearchMoreSnapshot extends SearchPosition {
  category: SearchCategory;
  keyword: string;
  data: MoreSearchResult & { changed?: boolean };
  nextOffset: number;
  error: 'more' | null;
}

export function UnifiedSearchModal({
  category,
  initialKeyword,
  onClose,
  onSelect,
  onOpenChatRecords,
  initialSnapshot,
  onNavigate,
}: {
  category: SearchCategory;
  initialKeyword: string;
  onClose: () => void;
  onSelect: (hit: SearchHit) => void;
  onOpenChatRecords: (hit: SearchHit) => void;
  initialSnapshot?: SearchMoreSnapshot;
  onNavigate?: (snapshot: SearchMoreSnapshot) => void;
}): ReactElement {
  const activity = useQQReadActivity(true);
  const readEnabled = useRef(activity.enabled);
  readEnabled.current = activity.enabled;
  const debounceTimer = useRef<number | undefined>(undefined);
  const restored = useRef(initialSnapshot?.category === category ? initialSnapshot : undefined);
  const [keyword, setKeyword] = useState(restored.current?.keyword ?? initialKeyword);
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
  const restoredRequest = useRef(
    restored.current ? JSON.stringify([category, restored.current.keyword]) : null,
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
    [category],
  );

  // Reset + fetch first page when the keyword settles.
  useLayoutEffect(() => {
    if (restoredRequest.current === JSON.stringify([category, keyword])) {
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
  }, [keyword, fetchPage, category]);

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
        <RotateCw size={14} />
      </button>
    </div>
  );

  return (
    <Modal
      presentation="floating"
      title="搜索结果"
      onClose={onClose}
      labelledBy="weq-search-more-title"
      width={760}
    >
      <div className="weq-search-more-modal">
        <div className="weq-search-more-head" data-window-drag-handle>
          <h3 id="weq-search-more-title" className="weq-search-more-title">
            {CATEGORY_META[category].label}搜索
          </h3>
          <button type="button" className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <input
          className="weq-search-more-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={`搜索${CATEGORY_META[category].label}`}
          autoFocus
        />
        {data?.coverage ? (
          <div className="weq-search-index-hint">{contentCoverageText(data.coverage)}</div>
        ) : null}
        <div className="weq-search-more-body" ref={scrollRef} onScroll={onScroll}>
          {error === 'initial' ? (
            retry
          ) : loading ? (
            <SearchListSkeleton rows={5} />
          ) : data && data.items.length === 0 ? (
            <div className="weq-search-empty">无结果</div>
          ) : data ? (
            <>
              <div className="weq-search-more-total">
                {data.changed
                  ? `已载入 ${data.items.length} 条 · 结果可能已更新${data.limited ? ' · 候选池有上限' : ''}`
                  : data.limited
                    ? `当前候选 ${data.total} 条 · 超出本轮检索上限`
                    : `共 ${data.total} 条结果`}
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
                  onSelect={(selected) => {
                    onNavigate?.({
                      category,
                      keyword,
                      data,
                      nextOffset: nextOffset.current,
                      scrollTop: scrollRef.current?.scrollTop ?? 0,
                      focusKey: searchHitKey(selected),
                      error: error === 'more' ? 'more' : null,
                    });
                    // 点击结果跳转会话 / 打开聊天记录时,关闭"更多"模态。
                    if (selected.category === 'chatRecord') onOpenChatRecords(selected);
                    else onSelect(selected);
                    onClose();
                  }}
                />
              ))}
              {loadingMore ? <SearchListSkeleton rows={2} /> : null}
              {error === 'more' ? retry : null}
              {!data.hasMore && data.items.length > 0 ? (
                <div className="weq-search-more-end">
                  {data.limited ? '本轮候选已显示完' : '没有更多了'}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <SearchPositionRestore container={scrollRef} position={restored.current} />
      </div>
    </Modal>
  );
}
