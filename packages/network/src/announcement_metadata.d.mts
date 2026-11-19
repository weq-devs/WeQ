export const ANNOUNCEMENT_REPOSITORY: 'weq-devs/WeQ';
export const ANNOUNCEMENT_ASSET: 'announcements-v1.json';
export const ANNOUNCEMENT_URL: string;
export const MAX_ANNOUNCEMENT_BYTES: number;
export const MAX_ANNOUNCEMENTS: number;
export const ANNOUNCEMENT_ID: RegExp;

export type AnnouncementPlatform = 'macos' | 'windows' | 'linux' | 'web';
export interface OfficialAnnouncement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  level: 'normal' | 'important';
  remindUntil?: string;
  platforms?: AnnouncementPlatform[];
  versionRange?: string;
}
export interface AnnouncementFeed {
  schemaVersion: 1;
  kind: 'official-announcements';
  repository: typeof ANNOUNCEMENT_REPOSITORY;
  revision: number;
  entries: OfficialAnnouncement[];
}
export interface SignedAnnouncementFeed {
  schemaVersion: 1;
  keyId: string;
  payload: string;
  signature: string;
}
export function validateAnnouncementFeed(feed: unknown): AnnouncementFeed;
export function signAnnouncementFeed(
  feed: AnnouncementFeed,
  privateKey: string,
): SignedAnnouncementFeed;
export function verifyAnnouncementFeed(
  envelope: unknown,
  publicKeys: readonly string[],
): AnnouncementFeed;
