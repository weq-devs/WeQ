import { useLayoutEffect, useState } from 'react';
import type { SearchCategory } from '../components/search/types';
import type { SearchPosition } from '../components/search/searchPosition';
import type { SearchMoreSnapshot } from '../components/search/UnifiedSearchModal';
import type { ConversationScope } from '@weq/service/search-policy';

type SearchReturnTarget =
  | { kind: 'dropdown'; position: SearchPosition }
  | { kind: 'more'; snapshot: SearchMoreSnapshot };

export function useSearchReturn(
  accountKey: string | null,
  keyword: string,
  categories: readonly SearchCategory[],
  scope: ConversationScope = 'all',
) {
  const key = JSON.stringify([accountKey, keyword, categories, scope]);
  const [saved, setSaved] = useState<{ key: string; target: SearchReturnTarget } | null>(null);
  useLayoutEffect(() => {
    setSaved((previous) => (previous?.key === key ? previous : null));
  }, [key]);
  return {
    target: saved?.key === key && accountKey ? saved.target : null,
    remember: (target: SearchReturnTarget) => setSaved({ key, target }),
    clear: () => setSaved(null),
  };
}
