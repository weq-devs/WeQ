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

/** Owner profile entry inside an individual space; other people still open their spaces. */
export const QzoneProfileContext = createContext<
  ((uin: string, nickname: string, anchor: { x: number; y: number }) => void) | null
>(null);

export interface QzoneAlbumRequest {
  hostUin: string;
  topicId: string;
  name: string;
  revision: string;
}

export const QzoneAlbumNavigationContext = createContext<
  ((hostUin: string, topicId: string, name: string, ownerNickname?: string) => void) | null
>(null);
