import { isRecord } from './client_preferences';

export const DRAFT_MEDIA_DIR = 'draft-media';

/** 与草稿上传的内容寻址文件名一致，只接受此处支持迁移的图片。 */
export function isDraftImageName(name: string): boolean {
  return /^[a-f0-9]{64}(?:\.(png|jpe?g|gif|webp|bmp))?$/.test(name);
}

export function draftImageReferenceName(path: string): string | undefined {
  const prefix = `${DRAFT_MEDIA_DIR}/`;
  if (!path.startsWith(prefix)) return;
  const name = path.slice(prefix.length);
  if (!isDraftImageName(name)) throw new Error('备份草稿图片引用无效');
  return name;
}

export function mapDraftImagePaths(
  value: unknown,
  map: (path: string) => string | undefined,
  depth = 0,
): void {
  if (depth > 64 || !value || typeof value !== 'object') return;
  if (isRecord(value) && value.kind === 'pic' && typeof value.localPath === 'string') {
    const path = map(value.localPath);
    if (path !== undefined) value.localPath = path;
  }
  for (const child of Object.values(value)) mapDraftImagePaths(child, map, depth + 1);
}
