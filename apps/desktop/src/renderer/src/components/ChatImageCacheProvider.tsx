import { useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { createChatImageCache } from '../lib/chatImageCache';
import { ChatImageCacheContext } from './ChatImageCacheProvider.shared';

export function ChatImageCacheProvider({
  scope,
  budgetMiB,
  children,
}: {
  scope: string;
  budgetMiB: number;
  children: ReactNode;
}) {
  const { cache } = useMemo(() => ({ scope, cache: createChatImageCache() }), [scope]);
  useLayoutEffect(() => cache.setBudgetMiB(budgetMiB), [cache, budgetMiB]);
  useEffect(() => () => cache.clear(), [cache]);
  return <ChatImageCacheContext.Provider value={cache}>{children}</ChatImageCacheContext.Provider>;
}
