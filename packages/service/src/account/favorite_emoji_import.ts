import { parseCustomFaceId } from '@weq/protocol';
import { planFavoriteEmojiImport, type FavoriteEmojiBundleItem } from './favorite_emoji_bundle';

export type FavoriteEmojiImportState =
  | 'not-run'
  | 'exists'
  | 'failed'
  | 'accepted'
  | 'unconfirmed'
  | 'metadata-failed'
  | 'confirmed';
type MetadataState = 'not-run' | 'accepted' | 'confirmed' | 'failed';
export interface FavoriteEmojiImportResultItem {
  key: string;
  emojiId: string | null;
  state: FavoriteEmojiImportState;
  description: MetadataState;
  order: MetadataState;
  issue: string | null;
}
export interface FavoriteEmojiImportResult {
  items: FavoriteEmojiImportResultItem[];
  stopped: string | null;
}

/** 复用 EmojiService 的真实写路径；不把来源 emojiId 当成目标账号的写入标识。 */
export interface FavoriteEmojiImportPort {
  fetchOnlineFavoriteIds(): Promise<string[]>;
  fetchOnlineFavoriteDetails(
    refs: { emojiId: string; md5: string }[],
  ): Promise<readonly { emojiId: string; desc: string }[]>;
  addFavorite(
    bytes: Uint8Array,
    log?: (message: string) => void,
    beforeSend?: () => void,
  ): Promise<string>;
  modifyFavoriteDesc(emojiId: string, description: string): Promise<void>;
  moveFavorite(emojiId: string, position: number, beforeSend?: () => void): Promise<void>;
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : '收藏导入操作失败').slice(0, 512);

export async function runFavoriteEmojiImport(
  items: readonly FavoriteEmojiBundleItem[],
  selectedKeys: readonly string[],
  port: FavoriteEmojiImportPort,
  options: {
    current: () => void;
    signal?: AbortSignal;
    progress?: (result: FavoriteEmojiImportResult) => void;
  },
): Promise<FavoriteEmojiImportResult> {
  const keys = new Set(selectedKeys);
  const available = planFavoriteEmojiImport(items, []);
  if (
    keys.size !== selectedKeys.length ||
    new Set(items.map((item) => item.key)).size !== items.length ||
    [...keys].some(
      (key) => !available.some((item) => item.key === key && item.disposition === 'ready'),
    )
  )
    throw new Error('导入选择无效，请重新预览收藏包');
  const selected = available
    .filter((item) => keys.has(item.key))
    .sort((a, b) => a.position - b.position);
  const result: FavoriteEmojiImportResult = {
    items: selected.map((item) => ({
      key: item.key,
      emojiId: null,
      state: 'not-run',
      description: 'not-run',
      order: 'not-run',
      issue: null,
    })),
    stopped: null,
  };
  const notify = () =>
    options.progress?.({ ...result, items: result.items.map((item) => ({ ...item })) });
  const current = () => {
    try {
      options.signal?.throwIfAborted();
      options.current();
    } catch (error) {
      result.stopped = options.signal?.aborted ? '已取消；已发送的操作不会撤销' : message(error);
      throw error;
    }
  };
  const list = async () => {
    current();
    const ids = await port.fetchOnlineFavoriteIds();
    current();
    if (new Set(ids).size !== ids.length) throw new Error('远端收藏列表含重复标识，请刷新');
    return ids.map(parseCustomFaceId);
  };
  if (!selected.length) return result;
  notify();
  let existing: Awaited<ReturnType<typeof list>>;
  try {
    existing = await list();
  } catch (error) {
    if (!result.stopped) throw error;
    return result;
  }
  const initialIds = new Set(existing.map((ref) => ref.emojiId));
  const knownMd5 = new Set(existing.map((ref) => ref.md5.toLowerCase()));
  const added: FavoriteEmojiImportResultItem[] = [];

  for (let index = 0; index < selected.length; index++) {
    const source = selected[index]!;
    const row = result.items[index]!;
    const image = source.image!;
    try {
      current();
    } catch {
      break;
    }
    if (knownMd5.has(image.md5)) {
      row.state = 'exists';
      notify();
      continue;
    }
    let sent = false;
    try {
      row.emojiId = await port.addFavorite(image.bytes, undefined, () => {
        current();
        sent = true;
      });
      row.state = 'accepted';
      added.push(row);
      current();
      if (parseCustomFaceId(row.emojiId).md5.toLowerCase() !== image.md5)
        throw new Error('上传返回的图片标识与所选原图不符');
      if (initialIds.has(row.emojiId)) {
        added.pop();
        row.state = 'exists';
        knownMd5.add(image.md5);
        notify();
        continue;
      }
      const online = await list();
      if (!online.some((ref) => ref.emojiId === row.emojiId))
        throw new Error('上传后尚未在远端收藏列表读到该图片');
      knownMd5.add(image.md5);
    } catch (error) {
      row.issue = message(error);
      if (result.stopped) {
        if (sent && !row.emojiId) row.state = 'unconfirmed';
        break;
      }
      if (sent || row.emojiId) {
        row.state = 'unconfirmed';
        result.stopped = '上传结果未确认，已停止后续导入；请刷新 QQ 收藏后核对，不要直接重试';
        notify();
        return result;
      }
      row.state = 'failed';
      notify();
      continue;
    }

    try {
      current();
      await port.modifyFavoriteDesc(row.emojiId!, source.description);
      row.description = 'accepted';
      current();
    } catch (error) {
      row.issue = `图片已添加，备注未完成：${message(error)}`;
      if (result.stopped) break;
      row.description = 'failed';
      row.state = 'metadata-failed';
    }
    notify();
  }

  // 只操作新项，逆序置前重建来源相对顺序，不用未知位置参数或重排原有收藏。
  if (!result.stopped) {
    for (const row of [...added].reverse()) {
      try {
        const online = await list();
        if (!online.some((ref) => ref.emojiId === row.emojiId))
          throw new Error('新增图片已不在收藏列表中');
        current();
        await port.moveFavorite(row.emojiId!, 1, current);
        row.order = 'accepted';
        current();
      } catch (error) {
        row.issue = [row.issue, `图片已添加，排序未完成：${message(error)}`]
          .filter(Boolean)
          .join('；');
        if (result.stopped) break;
        row.order = 'failed';
        row.state = 'metadata-failed';
      }
      notify();
    }
  }

  if (added.length && !result.stopped) {
    try {
      const online = await list();
      const details = await port.fetchOnlineFavoriteDetails(online);
      current();
      const addedIds = added.map((row) => row.emojiId);
      const prefix = online.slice(0, added.length).map((ref) => ref.emojiId);
      const orderMatches =
        prefix.length === addedIds.length &&
        prefix.every((value, index) => value === addedIds[index]);
      for (const row of added) {
        const source = selected.find((item) => item.key === row.key)!;
        const present = online.some((ref) => ref.emojiId === row.emojiId);
        const matchingDetails = details.filter((detail) => detail.emojiId === row.emojiId);
        if (
          present &&
          matchingDetails.length === 1 &&
          matchingDetails[0]!.desc === source.description
        )
          row.description = 'confirmed';
        if (present && orderMatches) row.order = 'confirmed';
        if (present && row.description === 'confirmed' && row.order === 'confirmed') {
          row.state = 'confirmed';
        } else {
          row.state = 'metadata-failed';
          row.issue = row.issue ?? '图片已添加，但备注或顺序读回不一致，请刷新后核对';
        }
      }
    } catch (error) {
      for (const row of added) {
        if (row.state !== 'metadata-failed') row.state = 'unconfirmed';
        row.issue = row.issue ?? `图片已添加，读回未完成：${message(error)}`;
      }
    }
  }
  notify();
  return result;
}
