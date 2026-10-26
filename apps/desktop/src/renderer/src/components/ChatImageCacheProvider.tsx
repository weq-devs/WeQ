import { createContext, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { createChatImageCache, type ChatImageCache } from '../lib/chatImageCache';

export const ChatImageCacheContext = createContext<ChatImageCache | null>(null);

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
