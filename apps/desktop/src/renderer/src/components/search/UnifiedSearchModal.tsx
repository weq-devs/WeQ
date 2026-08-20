/** Large horizontal "more" modal: full paginated results for one search category. */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { Modal } from '../Dialog';
import { SearchResultCard } from './SearchResultCard';
import { SearchListSkeleton } from './SearchSkeleton';
import { CATEGORY_META, type MoreSearchResult, type SearchCategory, type SearchHit } from './types';
import { client } from '../../trpc/client';

export function UnifiedSearchModal({
  category,
  initialKeyword,
  onClose,
  onSelect,
  onOpenChatRecords,
}: {
  category: SearchCategory;
  initialKeyword: string;
  onClose: () => void;
  onSelect: (hit: SearchHit) => void;
  onOpenChatRecords: (hit: SearchHit) => void;
}): ReactElement {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [data, setData] = useState<MoreSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const runRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(
    async (pageKeyword: string, offset: number, append: boolean) => {
      const run = ++runRef.current;
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
        setData((prev) => {
          if (!append || !prev) return result;
          return { ...result, items: [...prev.items, ...result.items] };
        });
      } catch (err) {
        console.error('[search-more] failed', err);
      } finally {
        if (run === runRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [category],
  );

  // Reset + fetch first page when the keyword settles.
  useEffect(() => {
    setData(null);
    const trimmed = keyword.trim();
    if (!trimmed) {
      setLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => void fetchPage(trimmed, 0, false), 250);
    return () => window.clearTimeout(timer);
  }, [keyword, fetchPage]);

  // Infinite scroll: fetch the next page near the bottom.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingMore || !data?.hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void fetchPage(keyword.trim(), data.items.length, true);
    }
  }, [data, keyword, loading, loadingMore, fetchPage]);

  return (
    <Modal onClose={onClose} labelledBy="weq-search-more-title" width={760}>
      <div className="weq-search-more-modal">
        <div className="weq-search-more-head">
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
        <div className="weq-search-more-body" ref={scrollRef} onScroll={onScroll}>
          {loading ? (
            <SearchListSkeleton rows={5} />
          ) : data && data.items.length === 0 ? (
            <div className="weq-search-empty">无结果</div>
          ) : data ? (
            <>
              <div className="weq-search-more-total">共 {data.total} 条结果</div>
              {data.items.map((hit) => (
                <SearchResultCard
                  key={cardKey(hit)}
                  hit={hit}
                  keyword={keyword.trim()}
                  onSelect={(selected) => {
                    // 点击结果跳转会话 / 打开聊天记录时,关闭"更多"模态。
                    if (selected.category === 'chatRecord') onOpenChatRecords(selected);
                    else onSelect(selected);
                    onClose();
                  }}
                />
              ))}
              {loadingMore ? <SearchListSkeleton rows={2} /> : null}
              {!data.hasMore && data.items.length > 0 ? (
                <div className="weq-search-more-end">没有更多了</div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function cardKey(hit: SearchHit): string {
  switch (hit.category) {
    case 'conversation':
      return `conversation:${hit.targetUid}`;
    case 'friend':
      return `friend:${hit.uid}`;
    case 'groupMember':
      return `groupMember:${hit.groupCode}:${hit.memberUid}`;
    case 'chatRecord':
      return `chatRecord:${hit.source}:${hit.partition}`;
    case 'file':
      return `file:${hit.source}:${hit.targetUid}:${hit.fileName}`;
  }
}
