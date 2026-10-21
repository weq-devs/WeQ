import { createHash } from 'node:crypto';
import { parseCustomFaceId } from '@weq/protocol';
import { canonicalHash, type FavEmojiRow } from './export/emoji_export';
import { webRequestBytes } from './web/http';
import {
  createFavoriteEmojiBundle,
  FAVORITE_EMOJI_MAX_IMAGE_BYTES,
  FAVORITE_EMOJI_MAX_ITEMS,
  type FavoriteEmojiExportSource,
} from './favorite_emoji_bundle';

export interface FavoriteEmojiExportPort {
  fetchOnlineFavoriteIds(): Promise<string[]>;
  fetchOnlineFavoriteDetails(
    refs: { emojiId: string; md5: string }[],
  ): Promise<readonly { emojiId: string; desc: string }[]>;
  listFavEmojiRows(): Promise<FavEmojiRow[]>;
}

/** 只使用缓存明确登记的 QQ 原图 URL，不推导 CDN 地址，也不跟随重定向。 */
export function favoriteEmojiOriginalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !(url.hostname.endsWith('.qpic.cn') || url.hostname === 'gxh.vip.qq.com')
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function exportOnlineFavoriteEmojiBundle(
  port: FavoriteEmojiExportPort,
  options: {
    current: () => void;
    readLocal: (path: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
    readRemote?: (url: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
    signal?: AbortSignal;
    progress?: (done: number, total: number) => void;
  },
) {
  const current = () => {
    options.signal?.throwIfAborted();
    options.current();
  };
  current();
  const ids = await port.fetchOnlineFavoriteIds();
  current();
  if (ids.length > FAVORITE_EMOJI_MAX_ITEMS) throw new Error('收藏条目数超过单包上限，本次未导出');
  if (new Set(ids).size !== ids.length) throw new Error('远端收藏列表含重复标识，请刷新');
  const refs = ids.map(parseCustomFaceId);
  const details = await port.fetchOnlineFavoriteDetails(refs);
  current();
  const sources: FavoriteEmojiExportSource[] = refs.map((ref, index) => {
    const matches = details.filter((detail) => detail.emojiId === ref.emojiId);
    if (matches.length !== 1) throw new Error('收藏备注读取不完整，请刷新后重试');
    return { ...ref, description: matches[0]!.desc, position: index + 1 };
  });
  const rows = await port.listFavEmojiRows();
  current();
  const byHash = new Map<string, FavEmojiRow[]>();
  for (const row of rows) {
    const key = canonicalHash(row.hash);
    const group = byHash.get(key) ?? [];
    group.push({ ...row });
    byHash.set(key, group);
  }
  const result = await createFavoriteEmojiBundle(
    sources,
    async (source) => {
      const candidates = byHash.get(source.md5.toLowerCase()) ?? [];
      const matches = (bytes: Uint8Array | null): bytes is Uint8Array =>
        bytes !== null &&
        bytes.byteLength <= FAVORITE_EMOJI_MAX_IMAGE_BYTES &&
        createHash('md5').update(bytes).digest('hex') === source.md5;
      for (const path of new Set(candidates.map((row) => row.oriPath).filter(Boolean))) {
        current();
        try {
          const bytes = await options.readLocal(path, options.signal);
          current();
          if (matches(bytes)) return bytes;
        } catch {
          current();
        }
      }
      for (const url of new Set(candidates.map((row) => favoriteEmojiOriginalUrl(row.remoteUrl)))) {
        if (!url) continue;
        current();
        try {
          const bytes = await (options.readRemote ?? readRemote)(url, options.signal);
          current();
          if (matches(bytes)) return bytes;
        } catch {
          current();
        }
      }
      return null;
    },
    { signal: options.signal, progress: options.progress },
  );
  current();
  return result;
}

function readRemote(url: string, signal?: AbortSignal) {
  return webRequestBytes(url, {
    cookie: '',
    redirect: 'error',
    maxResponseBytes: FAVORITE_EMOJI_MAX_IMAGE_BYTES,
    signal,
  });
}
