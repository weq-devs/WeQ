/** The unified search dropdown under the sidebar search box. */

import type { ReactElement } from 'react';
import { RotateCw } from 'lucide-react';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import {
  CATEGORY_META,
  SEARCH_CATEGORY_ORDER,
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
}): ReactElement {
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

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';

  return (
    <div className="weq-search-dropdown">
      <div className="weq-search-scope" role="group" aria-label="搜索范围">
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
          <label key={category}>
            <input
              type="checkbox"
              checked={categories.includes(category)}
              onChange={(event) =>
                onCategoriesChange(
                  SEARCH_CATEGORY_ORDER.filter((item) =>
                    item === category ? event.target.checked : categories.includes(item),
                  ),
                )
              }
            />
            {CATEGORY_META[category].label}
          </label>
        ))}
      </div>
      {indexBuilding ? (
        <div className="weq-search-index-hint">
          正在建立本地搜索索引，聊天记录/文件首次查询较慢…
        </div>
      ) : null}
      <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
        {categories.length === 0 ? <div className="weq-search-empty">未选择搜索范围</div> : null}
        {SEARCH_CATEGORY_ORDER.filter((category) => categories.includes(category)).map(
          (category) => {
            const section = sections.get(category)!;
            const hits = section.hits;
            const failed =
              category === 'chatRecord' || category === 'file' ? slowError : quickError;
            return (
              <div className="weq-search-section" key={category}>
                <div className="weq-search-section-header">
                  <span className="weq-search-section-name">{CATEGORY_META[category].label}</span>
                  {hits && hits.length >= 3 ? (
                    <button
                      type="button"
                      className="weq-search-more"
                      onClick={() => onMore(category)}
                    >
                      更多
                    </button>
                  ) : null}
                </div>
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
                      key={cardKey(hit)}
                      hit={hit}
                      keyword={keyword}
                      onSelect={onSelect}
                    />
                  ))
                )}
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}

function cardKey(hit: SearchHit): string {
  switch (hit.category) {
    case 'conversation':
      return hit.targetUid;
    case 'friend':
      return hit.uid;
    case 'groupMember':
      return `${hit.groupCode}:${hit.memberUid}`;
    case 'chatRecord':
      return `${hit.source}:${hit.partition}`;
    case 'file':
      return `${hit.source}:${hit.targetUid}:${hit.fileName}`;
  }
}
