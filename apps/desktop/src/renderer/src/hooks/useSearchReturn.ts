import { useLayoutEffect, useState } from 'react';
import type { SearchCategory, SearchHit } from '../components/search/types';
import { searchHitSource } from '../components/search/types';
import { searchHitParentCategory } from '../components/search/searchNavigation';
import type { SearchPosition } from '../components/search/searchPosition';
import type { SearchMoreSnapshot } from '../components/search/UnifiedSearchModal';
import {
  searchCategorySupportsSources,
  type ConversationScope,
  type SearchSource,
} from '@weq/service/search-policy';

type SearchReturnTarget = { kind: 'dropdown'; position: SearchPosition };

export function useSearchReturn(
  accountKey: string | null,
  keyword: string,
  categories: readonly SearchCategory[],
  scope: ConversationScope | readonly SearchSource[] = 'all',
) {
  const key = JSON.stringify([accountKey, keyword, categories, scope]);
  const [saved, setSaved] = useState<{ key: string; target: SearchReturnTarget } | null>(null);
  const [expanded, setExpanded] = useState<{
    accountKey: string | null;
    category: SearchCategory;
    snapshotKey?: string;
    snapshot?: SearchMoreSnapshot;
  } | null>(null);
  const [detail, setDetail] = useState<{ accountKey: string | null; hit: SearchHit } | null>(null);
  const detailHit =
    detail?.accountKey === accountKey &&
    keyword.trim() &&
    (categories.includes(detail.hit.category) ||
      categories.includes(searchHitParentCategory(detail.hit))) &&
    (typeof scope === 'string' || scope.includes(searchHitSource(detail.hit)))
      ? detail.hit
      : null;
  const category =
    expanded &&
    expanded.accountKey === accountKey &&
    keyword.trim() &&
    categories.includes(expanded.category) &&
    (typeof scope === 'string' || searchCategorySupportsSources(expanded.category, scope))
      ? expanded.category
      : null;
  useLayoutEffect(() => {
    setSaved((previous) => (previous?.key === key ? previous : null));
    setExpanded((previous) =>
      previous?.snapshotKey && previous.snapshotKey !== key
        ? { ...previous, snapshotKey: undefined, snapshot: undefined }
        : previous,
    );
  }, [key]);
  useLayoutEffect(() => {
    if (!category) setExpanded(null);
  }, [category, accountKey]);
  useLayoutEffect(() => {
    if (!detailHit) setDetail(null);
  }, [detailHit, accountKey]);
  return {
    target: saved?.key === key && accountKey ? saved.target : null,
    remember: (target: SearchReturnTarget) => setSaved({ key, target }),
    clear: () => setSaved(null),
    category,
    moreSnapshot: expanded?.snapshotKey === key ? expanded.snapshot : undefined,
    expand: (next: SearchCategory) => setExpanded({ accountKey, category: next }),
    back: () => setExpanded(null),
    detail: detailHit,
    openDetail: (hit: SearchHit) => setDetail({ accountKey, hit }),
    backDetail: () => setDetail(null),
    rememberMore: (snapshot: SearchMoreSnapshot) =>
      setExpanded((previous) =>
        previous?.accountKey === accountKey && previous.category === snapshot.category
          ? { ...previous, snapshotKey: key, snapshot }
          : previous,
      ),
  };
}
