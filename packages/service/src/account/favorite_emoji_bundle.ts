import { createHash } from 'node:crypto';
import { detectImageFormat } from '@weq/protocol';
import { buildZip, readZipEntries } from '../common/zip';
import { sniffImageExt } from './export/emoji_export';

export const FAVORITE_EMOJI_BUNDLE_FORMAT = 'weq-favorite-emoji';
export const FAVORITE_EMOJI_BUNDLE_VERSION = 1;
export const FAVORITE_EMOJI_MAX_ITEMS = 2000;
export const FAVORITE_EMOJI_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const FAVORITE_EMOJI_MAX_DATA_BYTES = 256 * 1024 * 1024;
export const FAVORITE_EMOJI_MAX_MANIFEST_BYTES = 1024 * 1024;
export const FAVORITE_EMOJI_MAX_ARCHIVE_BYTES =
  FAVORITE_EMOJI_MAX_DATA_BYTES + FAVORITE_EMOJI_MAX_MANIFEST_BYTES + 1024 * 1024;
export const FAVORITE_EMOJI_MANIFEST = 'favorite-emoji.json';

export interface FavoriteEmojiExportSource {
  /** 只作为来源记录；导入时由目标账号上传生成新 ID，不复用此 ID 写入。 */
  emojiId: string;
  md5: string;
  description: string;
  position: number;
}

export interface FavoriteEmojiImage {
  file: string;
  md5: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  extension: string;
}

interface FavoriteEmojiManifestEntry {
  emojiId: string;
  description: string;
  position: number;
  image?: FavoriteEmojiImage;
  error?: string;
}

export interface FavoriteEmojiBundleItem {
  key: string;
  emojiId: string;
  description: string;
  position: number;
  issue: string | null;
  /** 仅后端使用；预览 IPC 不应透传原图字节。 */
  image: (FavoriteEmojiImage & { bytes: Buffer }) | null;
}

export type FavoriteEmojiImportDisposition = 'ready' | 'exists' | 'duplicate' | 'invalid';
export type FavoriteEmojiImportPlanItem = FavoriteEmojiBundleItem & {
  disposition: FavoriteEmojiImportDisposition;
};

const hash = (algorithm: 'md5' | 'sha256', bytes: Uint8Array) =>
  createHash(algorithm).update(bytes).digest('hex');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('收藏包元数据结构无效');
  return value as Record<string, unknown>;
}

function metadata(raw: unknown) {
  const value = object(raw);
  if (
    typeof value.emojiId !== 'string' ||
    value.emojiId.length < 1 ||
    value.emojiId.length > 1024 ||
    typeof value.description !== 'string' ||
    value.description.length > 256 ||
    typeof value.position !== 'number' ||
    !Number.isSafeInteger(value.position) ||
    value.position < 1
  )
    throw new Error('收藏包条目元数据无效');
  return { emojiId: value.emojiId, description: value.description, position: value.position };
}

function imageInfo(bytes: Buffer): FavoriteEmojiImage {
  if (bytes.length < 1 || bytes.length > FAVORITE_EMOJI_MAX_IMAGE_BYTES)
    throw new Error('图片体积超限或为空');
  const extension = sniffImageExt(bytes);
  const { width, height } = detectImageFormat(bytes);
  if (
    !extension ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768 ||
    width * height > 100_000_000
  )
    throw new Error('图片格式或尺寸无效');
  const sha256 = hash('sha256', bytes);
  return {
    file: `images/${sha256}${extension}`,
    md5: hash('md5', bytes),
    sha256,
    byteLength: bytes.length,
    width,
    height,
    extension,
  };
}

/** 同一图片只存一次，备注与原顺序逐项保留；失败项留在清单，不降级成缩略图。 */
export async function createFavoriteEmojiBundle(
  sources: readonly FavoriteEmojiExportSource[],
  loadImage: (source: FavoriteEmojiExportSource) => Promise<Uint8Array | null>,
  options: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {},
): Promise<{
  archive: Buffer;
  total: number;
  written: number;
  uniqueImages: number;
  failed: Array<{ position: number; description: string; error: string }>;
}> {
  if (sources.length > FAVORITE_EMOJI_MAX_ITEMS) throw new Error('收藏包条目数超限，请分批导出');
  const snapshot = sources.map((source) => ({
    ...metadata(source),
    md5: source.md5.toLowerCase(),
  }));
  const entries: FavoriteEmojiManifestEntry[] = [];
  const images = new Map<string, Buffer>();
  const failed: Array<{ position: number; description: string; error: string }> = [];
  let totalBytes = 0;
  for (const source of snapshot) {
    options.signal?.throwIfAborted();
    const entry: FavoriteEmojiManifestEntry = {
      emojiId: source.emojiId,
      description: source.description,
      position: source.position,
    };
    let input: Uint8Array | null = null;
    try {
      input = await loadImage({ ...source });
    } catch {
      options.signal?.throwIfAborted();
    }
    options.signal?.throwIfAborted();
    try {
      if (!input) throw new Error('无法读取原图');
      if (input.byteLength > FAVORITE_EMOJI_MAX_IMAGE_BYTES) throw new Error('图片体积超限');
      const bytes = Buffer.from(input);
      const image = imageInfo(bytes);
      if (!/^[a-f0-9]{32}$/.test(source.md5) || image.md5 !== source.md5)
        throw new Error('原图 MD5 不匹配');
      if (!images.has(image.file)) {
        if (totalBytes + bytes.length > FAVORITE_EMOJI_MAX_DATA_BYTES)
          throw new Error('收藏包图片总量超限，请分批导出');
        images.set(image.file, bytes);
        totalBytes += bytes.length;
      }
      entry.image = image;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : '图片校验失败';
      failed.push({ position: entry.position, description: entry.description, error: entry.error });
    }
    entries.push(entry);
    options.progress?.(entries.length, snapshot.length);
  }
  options.signal?.throwIfAborted();
  const manifest = Buffer.from(
    JSON.stringify(
      {
        format: FAVORITE_EMOJI_BUNDLE_FORMAT,
        version: FAVORITE_EMOJI_BUNDLE_VERSION,
        entries,
      },
      null,
      2,
    ),
  );
  if (manifest.length > FAVORITE_EMOJI_MAX_MANIFEST_BYTES) throw new Error('收藏包清单体积超限');
  const archive = buildZip(
    [
      { name: FAVORITE_EMOJI_MANIFEST, data: manifest },
      ...[...images].map(([name, data]) => ({ name, data })),
    ],
    { compress: false },
  );
  if (archive.length > FAVORITE_EMOJI_MAX_ARCHIVE_BYTES) throw new Error('收藏包体积超限');
  return {
    archive,
    total: snapshot.length,
    written: snapshot.length - failed.length,
    uniqueImages: images.size,
    failed,
  };
}

/** 只在内存按受限 ZIP 读取，不把包内路径用于文件系统寻址。坏图片逐项反馈。 */
export function readFavoriteEmojiBundle(archive: Buffer): FavoriteEmojiBundleItem[] {
  if (archive.length > FAVORITE_EMOJI_MAX_ARCHIVE_BYTES) throw new Error('收藏包体积超限');
  const files = new Map(
    readZipEntries(archive, {
      maxEntries: FAVORITE_EMOJI_MAX_ITEMS + 1,
      maxEntryBytes: FAVORITE_EMOJI_MAX_IMAGE_BYTES,
      maxTotalBytes: FAVORITE_EMOJI_MAX_DATA_BYTES + FAVORITE_EMOJI_MAX_MANIFEST_BYTES,
    }).map((entry) => [entry.name, entry.data]),
  );
  for (const name of files.keys())
    if (
      name !== FAVORITE_EMOJI_MANIFEST &&
      !/^images\/[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)$/.test(name)
    )
      throw new Error('收藏包包含未知文件');
  const manifest = files.get(FAVORITE_EMOJI_MANIFEST);
  if (!manifest || manifest.length > FAVORITE_EMOJI_MAX_MANIFEST_BYTES)
    throw new Error('收藏包清单缺失或体积超限');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
  } catch {
    throw new Error('收藏包清单不是有效的 UTF-8 JSON');
  }
  const root = object(decoded);
  if (
    root.format !== FAVORITE_EMOJI_BUNDLE_FORMAT ||
    root.version !== FAVORITE_EMOJI_BUNDLE_VERSION
  )
    throw new Error('不支持的收藏包格式或版本');
  if (!Array.isArray(root.entries) || root.entries.length > FAVORITE_EMOJI_MAX_ITEMS)
    throw new Error('收藏包条目列表无效或超限');
  return root.entries.map((raw: unknown, index): FavoriteEmojiBundleItem => {
    const item: FavoriteEmojiBundleItem = {
      key: `item-${index + 1}`,
      emojiId: '',
      description: '',
      position: index + 1,
      issue: null,
      image: null,
    };
    try {
      const entry = object(raw);
      Object.assign(item, metadata(entry));
      if (entry.error !== undefined) {
        if (
          typeof entry.error !== 'string' ||
          !entry.error ||
          entry.error.length > 512 ||
          entry.image !== undefined
        )
          throw new Error('收藏包失败记录无效');
        item.issue = entry.error;
        return item;
      }
      const claimed = object(entry.image);
      if (typeof claimed.file !== 'string') throw new Error('收藏包图片定位缺失');
      const bytes = files.get(claimed.file);
      if (!bytes) throw new Error('收藏包图片缺失');
      const actual = imageInfo(bytes);
      for (const key of [
        'file',
        'md5',
        'sha256',
        'byteLength',
        'width',
        'height',
        'extension',
      ] as const)
        if (claimed[key] !== actual[key]) throw new Error('收藏包图片与元数据校验不一致');
      item.image = { ...actual, bytes };
    } catch (error) {
      item.issue = error instanceof Error ? error.message : '收藏包条目无效';
    }
    return item;
  });
}

/** 服务端以 MD5 标识收藏；包内额外以 SHA-256 核对内容，重复项不覆盖现有备注。 */
export function planFavoriteEmojiImport(
  items: readonly FavoriteEmojiBundleItem[],
  existingMd5: readonly string[],
): FavoriteEmojiImportPlanItem[] {
  if (existingMd5.some((value) => !/^[a-f0-9]{32}$/i.test(value)))
    throw new Error('远端收藏标识无效');
  const existing = new Set(existingMd5.map((value) => value.toLowerCase()));
  const seen = new Map<string, string>();
  return items.map((item) => {
    if (item.issue || !item.image) return { ...item, disposition: 'invalid' };
    const { md5, sha256 } = item.image;
    if (existing.has(md5)) return { ...item, disposition: 'exists' };
    const previous = seen.get(md5);
    if (previous && previous !== sha256)
      return {
        ...item,
        image: null,
        issue: '同一 MD5 对应不同图片，需单独核对',
        disposition: 'invalid',
      };
    if (previous) return { ...item, disposition: 'duplicate' };
    seen.set(md5, sha256);
    return { ...item, disposition: 'ready' };
  });
}
