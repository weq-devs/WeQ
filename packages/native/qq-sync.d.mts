export interface QqSyncFile {
  path: string;
  asset: string;
  sha256: string;
  size: number;
}
export function qqSyncFiles(bundle: unknown): QqSyncFile[];
export function qqSyncArtifacts(
  manifest: unknown,
  platform: string,
  options?: { required?: boolean },
): (QqSyncFile & { label: string })[];
export function verifyQqSync(root: string): string;
