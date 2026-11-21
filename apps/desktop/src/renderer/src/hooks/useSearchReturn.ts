import { useLayoutEffect, useState } from 'react';
import type { SearchCategory, SearchHit } from '../components/search/types';
import { searchHitSource } from '../components/search/types';
import { searchHitParentCategory } from '../components/search/searchNavigation';
import type { SearchPosition } from '../components/search/searchPosition';
import type { SearchMoreSnapshot } from '../components/search/UnifiedSearchModal';
import {
  searchCategorySupportsSources,
  type ConversationScope,
  type GlobalChatRecordFilter,
  type SearchSource,
} from '@weq/service/search-policy';

type SearchReturnTarget = { kind: 'dropdown'; position: SearchPosition };
type QQMessageSearch = {
  filter: GlobalChatRecordFilter;
  senderLabel?: string;
};

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
    qqMessages?: QQMessageSearch;
    snapshotKey?: string;
    snapshot?: SearchMoreSnapshot;
  } | null>(null);
  const [detail, setDetail] = useState<{
    accountKey: string | null;
    filterKey: string;
    hit: SearchHit;
  } | null>(null);
  const category =
    expanded &&
    expanded.accountKey === accountKey &&
    keyword.trim() &&
    categories.includes(expanded.category) &&
    (typeof scope === 'string' ||
      (expanded.qqMessages
        ? scope.includes('qq')
        : searchCategorySupportsSources(expanded.category, scope)))
      ? expanded.category
      : null;
  const qqMessages = category ? expanded?.qqMessages : undefined;
  const snapshotKey = JSON.stringify([key, qqMessages?.filter]);
  const detailHit =
    detail?.accountKey === accountKey &&
    detail.filterKey === JSON.stringify(qqMessages?.filter) &&
    keyword.trim() &&
    (categories.includes(detail.hit.category) ||
      categories.includes(searchHitParentCategory(detail.hit))) &&
    (typeof scope === 'string' || scope.includes(searchHitSource(detail.hit)))
      ? detail.hit
      : null;
  useLayoutEffect(() => {
    setSaved((previous) => (previous?.key === key ? previous : null));
    setExpanded((previous) =>
      previous?.snapshotKey && previous.snapshotKey !== snapshotKey
        ? { ...previous, snapshotKey: undefined, snapshot: undefined }
        : previous,
    );
  }, [key, snapshotKey]);
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
    moreSnapshot: expanded?.snapshotKey === snapshotKey ? expanded.snapshot : undefined,
    expand: (next: SearchCategory) => setExpanded({ accountKey, category: next }),
    qqMessages,
    filterQQMessages: () =>
      setExpanded({ accountKey, category: 'chatRecord', qqMessages: { filter: {} } }),
    setQQMessages: (next: QQMessageSearch) =>
      setExpanded((previous) =>
        previous?.accountKey === accountKey && previous.qqMessages
          ? { ...previous, qqMessages: next, snapshotKey: undefined, snapshot: undefined }
          : previous,
      ),
    back: () => setExpanded(null),
    detail: detailHit,
    openDetail: (hit: SearchHit) =>
      setDetail({ accountKey, filterKey: JSON.stringify(qqMessages?.filter), hit }),
    backDetail: () => setDetail(null),
    rememberMore: (snapshot: SearchMoreSnapshot) =>
      setExpanded((previous) =>
        previous?.accountKey === accountKey &&
        previous.category === snapshot.category &&
        previous.qqMessages === qqMessages
          ? { ...previous, snapshotKey, snapshot }
          : previous,
      ),
  };
}
