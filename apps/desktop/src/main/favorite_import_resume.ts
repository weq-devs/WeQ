import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { writeFileAtomic } from '@weq/service/atomic-write';
import {
  FAVORITE_EMOJI_MAX_ITEMS,
  type FavoriteEmojiBundleItem,
  type FavoriteEmojiImportResult,
} from '@weq/service';
import { z } from 'zod/v3';
import { requirePlatform } from './context/app_context';

const row = z.object({
  key: z.string().min(1),
  md5: z.string().optional(),
  emojiId: z.string().nullable(),
  state: z.enum([
    'not-run',
    'exists',
    'failed',
    'accepted',
    'unconfirmed',
    'metadata-failed',
    'confirmed',
  ]),
  description: z.enum(['not-run', 'accepted', 'confirmed', 'failed']),
  order: z.enum(['not-run', 'accepted', 'confirmed', 'failed']),
  issue: z.string().nullable(),
});
export const favoriteImportPlan = z.object({
  type: z.literal('favorite-import'),
  items: z.array(row).min(1).max(FAVORITE_EMOJI_MAX_ITEMS),
});
export type FavoriteImportPlan = z.infer<typeof favoriteImportPlan>;

function sourcePath(configId: string, taskId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error('导入任务标识无效。');
  return join(
    requirePlatform().appDataRoot(),
    'config',
    'accounts',
    configId,
    'favorite-import',
    taskId,
  );
}

export async function makeFavoriteImportPlan(
  configId: string,
  taskId: string,
  items: FavoriteEmojiBundleItem[],
): Promise<FavoriteImportPlan> {
  await writeFileAtomic(sourcePath(configId, taskId), serialize(items));
  return {
    type: 'favorite-import',
    items: items
      .toSorted((a, b) => a.position - b.position)
      .map((item) => ({
        key: item.key,
        md5: item.image?.md5,
        emojiId: null,
        state: 'not-run',
        description: 'not-run',
        order: 'not-run',
        issue: null,
      })),
  };
}

export async function readFavoriteImportSource(configId: string, taskId: string) {
  return deserialize(await readFile(sourcePath(configId, taskId))) as FavoriteEmojiBundleItem[];
}

export async function removeFavoriteImportSource(configId: string, taskId: string) {
  await rm(sourcePath(configId, taskId), { force: true });
}

export function updateFavoriteImportPlan(
  plan: FavoriteImportPlan,
  result: FavoriteEmojiImportResult,
) {
  const updates = new Map(result.items.map((item) => [item.key, item]));
  return {
    ...plan,
    items: plan.items.map((original) => {
      const current = updates.get(original.key);
      if (!current) return original;
      return result.inFlightKey === current.key
        ? { ...current, state: 'unconfirmed' as const }
        : current;
    }),
  };
}

export function pendingFavoriteImports(plan: FavoriteImportPlan) {
  return plan.items
    .filter(({ state }) => state === 'not-run' || state === 'failed')
    .map(({ key }) => key);
}
