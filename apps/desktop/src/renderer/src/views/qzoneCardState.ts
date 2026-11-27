import { createContext, useContext, useLayoutEffect, useState } from 'react';
import type { PageDataCache } from '../lib/pageDataCache';

export const PinFeedCard = createContext<((pinned: boolean) => void) | null>(null);
export const FeedCardData = createContext<PageDataCache | null>(null);
export const FeedRowKey = createContext('');

export function useFeedCardState(field: string) {
  const cache = useContext(FeedCardData);
  const key = `${useContext(FeedRowKey)}:${field}`;
  const [open, setOpen] = useState(() => cache?.get<boolean>(key) ?? false);
  useLayoutEffect(() => {
    if (open) cache?.put(key, true);
    else cache?.delete(key);
  }, [cache, key, open]);
  return [open, setOpen] as const;
}
