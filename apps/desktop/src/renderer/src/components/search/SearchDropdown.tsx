/** The unified search dropdown under the sidebar search box. */

import { useCallback, useRef, type ReactElement } from 'react';
import { RotateCw } from 'lucide-react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import { restoreSearchPosition, type SearchPosition } from './searchPosition';
import {
  CATEGORY_META,
  CONTENT_CATEGORY_ORDER,
  isContentSearchCategory,
  contentCoverageText,
  SEARCH_CATEGORY_ORDER,
  searchHitKey,
  isSlowSearchCategory,
  type SearchCategory,
  type SearchHit,
  type QuickSearchResult,
  type SlowSearchResult,
} from './types';

export function SearchDropdown({
  keyword,
  quick,
  quickLoading,
  slow,
  slowLoading,
  categories,
  onCategoriesChange,
  quickError = false,
  slowError = false,
  onRetry,
  onSelect,
  onMore,
  initialPosition,
  onNavigate,
}: {
  keyword: string;
  quick: QuickSearchResult | null;
  quickLoading: boolean;
  slow: SlowSearchResult | null;
  slowLoading: boolean;
  categories: readonly SearchCategory[];
  onCategoriesChange: (categories: SearchCategory[]) => void;
  quickError?: boolean;
  slowError?: boolean;
  onRetry?: () => void;
  onSelect: (hit: SearchHit) => void;
  onMore: (category: SearchCategory) => void;
  initialPosition?: SearchPosition;
  onNavigate?: (position: SearchPosition) => void;
}): ReactElement {
  const root = useRef<HTMLDivElement | null>(null);
  const position = useRef(initialPosition);
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    if (node && position.current) {
      restoreSearchPosition(node, position.current);
      position.current = undefined;
    }
  }, []);
  // Map category → hits (or null while loading).
  const sections = new Map<SearchCategory, { hits: SearchHit[] | null; loading: boolean }>();
  sections.set('conversation', {
    hits: quick ? quick.conversations : null,
    loading: quickLoading && !quick,
  });
  sections.set('friend', { hits: quick ? quick.friends : null, loading: quickLoading && !quick });
  sections.set('groupMember', {
    hits: quick ? quick.groupMembers : null,
    loading: quickLoading && !quick,
  });
  sections.set('chatRecord', {
    hits: slow ? slow.chatRecords : null,
    loading: slowLoading && !slow,
  });
  sections.set('file', { hits: slow ? slow.files : null, loading: slowLoading && !slow });
  sections.set('collection', {
    hits: slow ? slow.collections : null,
    loading: slowLoading && !slow,
  });
  sections.set('cloneMessage', {
    hits: slow ? slow.cloneMessages : null,
    loading: slowLoading && !slow,
  });
  sections.set('assistantMessage', {
    hits: slow ? slow.assistantMessages : null,
    loading: slowLoading && !slow,
  });
  for (const category of CONTENT_CATEGORY_ORDER)
    sections.set(category, {
      hits: slow ? (slow.contentHits ?? []).filter((hit) => hit.category === category) : null,
      loading: slowLoading && !slow,
    });

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';
  const scopeSelection = useMultiSelection({
    ids: SEARCH_CATEGORY_ORDER,
    selected: new Set(categories),
    onChange: (next) =>
      onCategoriesChange(SEARCH_CATEGORY_ORDER.filter((category) => next.has(category))),
  });
  const failedFor = (category: SearchCategory) =>
    isSlowSearchCategory(category)
      ? slowError || Boolean(slow?.failedCategories?.includes(category))
      : quickError;
  const weight = (category: SearchCategory) =>
    sections.get(category)?.hits?.length
      ? 3
      : failedFor(category)
        ? 2
        : sections.get(category)?.loading
          ? 1
          : 0;
  const orderedCategories = SEARCH_CATEGORY_ORDER.filter((category) =>
    categories.includes(category),
  ).sort((left, right) => weight(right) - weight(left));

  return (
    <div className="weq-search-dropdown" ref={attachRoot}>
      <div
        className="weq-search-scope"
        role="group"
        aria-label="搜索范围"
        {...scopeSelection.rootProps}
      >
        <label>
          <input
            type="checkbox"
            aria-label="全部范围"
            checked={categories.length === SEARCH_CATEGORY_ORDER.length}
            ref={(node) => {
              if (node)
                node.indeterminate =
                  categories.length > 0 && categories.length < SEARCH_CATEGORY_ORDER.length;
            }}
            onChange={(event) =>
              onCategoriesChange(event.target.checked ? [...SEARCH_CATEGORY_ORDER] : [])
            }
          />
          全部
        </label>
        {SEARCH_CATEGORY_ORDER.map((category) => (
          <label key={category} {...scopeSelection.itemProps(category)}>
            <input type="checkbox" checked={categories.includes(category)} readOnly />
            {CATEGORY_META[category].label}
          </label>
        ))}
      </div>
      <div className="weq-search-index-hint">来源：当前账号 · 本地可检索记录</div>
      {indexBuilding ? (
        <div className="weq-search-index-hint">
          正在建立本地搜索索引，聊天记录/文件首次查询较慢…
        </div>
      ) : null}
      <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
        {categories.length === 0 ? <div className="weq-search-empty">未选择搜索范围</div> : null}
        {orderedCategories.map((category) => {
          const section = sections.get(category)!;
          const hits = section.hits;
          const coverage = isContentSearchCategory(category)
            ? slow?.contentCoverage?.[category]
            : undefined;
          const failed = failedFor(category);
          return (
            <div className="weq-search-section" key={category}>
              <div className="weq-search-section-header">
                <span className="weq-search-section-name">{CATEGORY_META[category].label}</span>
                {hits && hits.length >= 3 ? (
                  <button
                    type="button"
                    className="weq-search-more"
                    data-search-hit-key={`more:${category}`}
                    onClick={() => {
                      onNavigate?.({
                        scrollTop: root.current?.scrollTop ?? 0,
                        focusKey: `more:${category}`,
                      });
                      onMore(category);
                    }}
                  >
                    更多
                  </button>
                ) : null}
              </div>
              {coverage ? (
                <div className="weq-search-index-hint">{contentCoverageText(coverage)}</div>
              ) : null}
              {failed ? (
                <div className="weq-search-failure" role="status">
                  <span>搜索失败</span>
                  <button
                    type="button"
                    onClick={onRetry}
                    title="重试搜索"
                    aria-label={`重试${CATEGORY_META[category].label}搜索`}
                  >
                    <RotateCw size={14} />
                  </button>
                </div>
              ) : section.loading ? (
                <SearchSectionSkeleton />
              ) : !hits || hits.length === 0 ? (
                <div className="weq-search-empty">无结果</div>
              ) : (
                hits.map((hit) => (
                  <SearchResultCard
                    key={searchHitKey(hit)}
                    hit={hit}
                    keyword={keyword}
                    onSelect={(selected) => {
                      onNavigate?.({
                        scrollTop: root.current?.scrollTop ?? 0,
                        focusKey: searchHitKey(selected),
                      });
                      onSelect(selected);
                    }}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
