export const FEED_TAG: string;
export const MARKET_EMOJI_FEED_TAG: string;
export const RESOURCE_FEED_TAG: string;
export type ResourceTrack = 'dress' | 'market-emoji';
export const RESOURCE_DESCRIPTORS: Record<ResourceTrack, string>;
export const FEED_ASSET: string;
export const RELEASE_SUMMARY_MAX_CHARS: number;
export interface ReleaseAsset {
  name: string;
  size: number;
  sha256: string;
}
export interface ReleaseDescriptor {
  tag: string;
  version: string | null;
  prerelease: boolean;
  publishedAt: string;
  summary?: string;
  assets: ReleaseAsset[];
  catalogs: Record<string, string>;
  track?: ResourceTrack;
}
export interface ReleaseIndex {
  schemaVersion: 1;
  kind: 'release-index' | 'resource-release-index';
  repository: string;
  generatedAt: string;
  releases: ReleaseDescriptor[];
}
export interface SignedReleaseIndex {
  schemaVersion: 1;
  keyId: string;
  payload: string;
  signature: string;
}
export function releaseKeyId(key: string | import('node:crypto').KeyObject): string;
export function validateReleaseIndex(value: unknown, repository: string): ReleaseIndex;
export function signReleaseIndex(index: ReleaseIndex, privateKey: string): SignedReleaseIndex;
export function verifyReleaseIndex(
  envelope: unknown,
  repository: string,
  publicKeys: string[],
): ReleaseIndex;
