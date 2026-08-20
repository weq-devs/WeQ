/** The unified search dropdown under the sidebar search box. */

import type { ReactElement } from 'react';
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
  onSelect,
  onMore,
}: {
  keyword: string;
  quick: QuickSearchResult | null;
  quickLoading: boolean;
  slow: SlowSearchResult | null;
  slowLoading: boolean;
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

  const indexBuilding = !slowLoading && slow?.indexStatus === 'building';

  return (
    <div className="weq-search-dropdown" role="listbox" aria-label="搜索">
      {indexBuilding ? (
        <div className="weq-search-index-hint">
          正在建立本地搜索索引，聊天记录/文件首次查询较慢…
        </div>
      ) : null}
      {SEARCH_CATEGORY_ORDER.map((category) => {
        const section = sections.get(category)!;
        const hits = section.hits;
        return (
          <div className="weq-search-section" key={category}>
            <div className="weq-search-section-header">
              <span className="weq-search-section-name">{CATEGORY_META[category].label}</span>
              {hits && hits.length >= 3 ? (
                <button type="button" className="weq-search-more" onClick={() => onMore(category)}>
                  更多
                </button>
              ) : null}
            </div>
            {section.loading || hits === null ? (
              <SearchSectionSkeleton />
            ) : hits.length === 0 ? (
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
      })}
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
