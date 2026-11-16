export const FEED_TAG: string;
export const FEED_ASSET: string;
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
  assets: ReleaseAsset[];
  catalogs: Record<string, string>;
}
export interface ReleaseIndex {
  schemaVersion: 1;
  kind: 'release-index';
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
