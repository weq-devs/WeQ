import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectImageFormat } from '@weq/protocol';
import { previewFromPath, type EmojiPreviewAddress } from './export/emoji_export';
import { downloadUrlToFile } from './media_url';

export const FAVORITE_EMOJI_MAX_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

interface FavoriteRow {
  hash: string;
  oriPath: string;
  thumbPath: string;
  remoteUrl: string;
}
interface FavoriteSendDeps {
  listRows(): Promise<FavoriteRow[]>;
  resolveFile(
    scope: 'personal' | 'recv',
    bucket: string,
    variant: 'ori' | 'thumb',
    file: string,
  ): Promise<string | null>;
  checkCurrent(): void;
  download?: typeof downloadUrlToFile;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
function address(value: Record<string, unknown>): EmojiPreviewAddress {
  const { scope, bucket, variant, file } = value;
  if (
    (scope !== 'personal' && scope !== 'recv') ||
    typeof bucket !== 'string' ||
    (scope === 'personal' ? bucket !== '' : !/^\d{4}-\d{2}$/.test(bucket)) ||
    (variant !== 'ori' && variant !== 'thumb') ||
    typeof file !== 'string' ||
    !/^[0-9a-f]{6,}[^/\\]*$/i.test(file) ||
    file.includes('..')
  )
    throw new Error('收藏表情资源地址无效');
  return { scope, bucket, variant, file };
}
function sameAddress(a: EmojiPreviewAddress | undefined, b: EmojiPreviewAddress): boolean {
  return (
    !!a &&
    a.scope === b.scope &&
    a.bucket === b.bucket &&
    a.variant === b.variant &&
    a.file === b.file
  );
}

/** 有界读取原图；不转码、不改写 QQ 缓存，也不把文件增长读成无限内存。 */
async function readOriginal(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size <= 0 || st.size > FAVORITE_EMOJI_MAX_BYTES) {
      throw new Error('收藏表情原图为空或超过 20 MiB');
    }
    const buffer = Buffer.alloc(st.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== st.size) throw new Error('收藏表情原图尚未写入完成，请稍后重试');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** 将收藏草稿的逻辑地址还原为普通图片元素；发送与回执仍交给原有发送链路。 */
export async function prepareFavoriteEmojiElements(
  elements: unknown[],
  deps: FavoriteSendDeps,
): Promise<unknown[]> {
  let rows: FavoriteRow[] | undefined;
  const resolved = new Map<string, Record<string, unknown>>();
  let totalBytes = 0;
  const output: unknown[] = [];
  for (const element of elements) {
    const el = record(element);
    const source = record(el?.source);
    if (source?.kind !== 'favoriteEmoji') {
      output.push(element);
      continue;
    }
    if (el?.kind !== 'image') throw new Error('收藏表情只能作为图片发送');
    const ref = address(source);
    const key = JSON.stringify(ref);
    const cached = resolved.get(key);
    if (cached) {
      output.push(cached);
      continue;
    }
    deps.checkCurrent();
    rows ??= await deps.listRows();
    deps.checkCurrent();
    // 旧草稿同样按真实收藏记录查原图，绝不信任渲染进程传来的本机路径或下载地址。
    const matches = rows.filter(
      (row) =>
        sameAddress(previewFromPath(row.oriPath), ref) ||
        sameAddress(previewFromPath(row.thumbPath), ref),
    );
    const row = matches[0];
    if (
      !row ||
      matches.some((other) => other.oriPath !== row.oriPath || other.remoteUrl !== row.remoteUrl)
    ) {
      throw new Error('收藏表情已移除或资源身份不明确，请重新选择');
    }
    const original = previewFromPath(row.oriPath);
    const path =
      original?.variant === 'ori'
        ? await deps.resolveFile(original.scope, original.bucket, 'ori', original.file)
        : null;
    deps.checkCurrent();
    let bytes: Buffer;
    if (path) {
      bytes = await readOriginal(path);
    } else {
      if (!/^https?:\/\//i.test(row.remoteUrl))
        throw new Error('收藏表情原图不存在，且没有可用的在线原图');
      const dir = await mkdtemp(join(tmpdir(), 'weq-favorite-send-'));
      try {
        const target = join(dir, 'original');
        const result = await (deps.download ?? downloadUrlToFile)(row.remoteUrl, target, {
          expectedKind: 'image',
          maxBytes: FAVORITE_EMOJI_MAX_BYTES,
          timeoutMs: 30_000,
        });
        deps.checkCurrent();
        if (!result.ok) throw new Error(`收藏表情原图下载失败：${result.reason}`);
        bytes = await readOriginal(target);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    deps.checkCurrent();
    const image = detectImageFormat(bytes);
    if (!image.width || !image.height) throw new Error('收藏表情原图损坏或格式不支持');
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new Error('本条消息收藏表情原图合计超过 40 MiB，请分开发送');
    const extension = (
      { 1000: 'jpg', 1001: 'png', 1002: 'webp', 1005: 'bmp', 2000: 'gif' } as Record<number, string>
    )[image.format];
    const name = /^[0-9a-f]+$/i.test(row.hash) ? row.hash : 'emoji';
    const imageElement = {
      kind: 'image',
      source: bytes,
      fileName: `${name}.${extension}`,
      subType: 1,
      summary: '[表情]',
      width: image.width,
      height: image.height,
      picFormat: image.format,
    };
    resolved.set(key, imageElement);
    output.push(imageElement);
  }
  deps.checkCurrent();
  return output;
}
