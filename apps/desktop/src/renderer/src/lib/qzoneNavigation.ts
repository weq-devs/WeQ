import { createContext } from 'react';

export interface QzoneSpaceRequest {
  accountUin: string;
  uin: string;
  nickname?: string;
  revision: string;
}

/** Profile surfaces share the main workspace's account-scoped navigation. */
export const QzoneNavigationContext = createContext<
  ((uin: string, nickname?: string) => void) | null
>(null);
