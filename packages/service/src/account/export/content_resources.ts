import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExportContentPolicy } from '../../common/export_content';
import type { AvatarLocalFile } from '../avatar_resource';
import type { DressService } from '../dress_service';
import type { JsonObject } from './archive';
import type { ResourceDirectoryEntry } from './archive_directory';
import type { DressUsage, DressExportManifest } from './dress_export';
import { localFaceVariants } from './sysface_export';
import type { MediaScanResult } from './media_scan';
import { sourceValue } from './archive_value';
import { fileDigest } from './archive_resource';

/** 缓存版本只读原文件；不调用 fetch、下载或推断其他 CDN 地址。 */
export async function collectContentResources(
  root: string,
  policy: ExportContentPolicy,
  options: {
    scan?: MediaScanResult | null;
    senders?: Iterable<string>;
    avatarLocal?: (uin: string, variant: 'big' | 'small') => Promise<AvatarLocalFile | null>;
    dress?: DressService;
    usage?: DressUsage | null;
    dressManifest?: DressExportManifest | null;
    faces?: Iterable<string>;
    emojiDir?: string | null;
    marketFaceVariants?: (pack: string, hash: string) => Promise<string[]>;
    signal?: AbortSignal;
    copyPrimary?: boolean;
  },
): Promise<ResourceDirectoryEntry[]> {
  const output: ResourceDirectoryEntry[] = [];
  const selected = (key: keyof NonNullable<ExportContentPolicy['details']>) =>
    policy.details?.[key] === 'local';
  const copy = async (path: string, folder = 'variants'): Promise<string> => {
    options.signal?.throwIfAborted();
    const digest = await fileDigest(path);
    const relative = `${folder}/${digest.sha256}/${basename(path)}`;
    await mkdir(join(root, folder, digest.sha256), { recursive: true });
    try {
      await copyFile(
        path,
        join(root, relative),
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const copied = await fileDigest(join(root, relative));
    if (copied.sha256 !== digest.sha256 || copied.size !== digest.size)
      throw new Error('资源版本在复制期间发生变化。');
    return relative;
  };
  for (const ref of [...(options.scan?.found ?? []), ...(options.scan?.missing ?? [])]) {
    const category =
      ref.kind === 'pic' || ref.kind === 'emoji'
        ? 'image'
        : ref.kind === 'ptt'
          ? 'voice'
          : ref.kind;
    const variantsKey = `${category}Variants` as keyof NonNullable<ExportContentPolicy['details']>;
    const parent =
      category === 'image'
        ? 'images'
        : category === 'video'
          ? 'videos'
          : category === 'voice'
            ? 'voice'
            : 'files';
    if (
      policy[parent] !== 'none' &&
      ref.path &&
      (options.copyPrimary !== false || ref.kind === 'ptt')
    )
      output.push({
        sourceId: `${ref.kind}:${ref.stem}:original`,
        name: ref.fileName,
        path: await copy(ref.path, 'media/originals'),
        type: parent === 'images' ? 'photo' : parent === 'videos' ? 'video' : 'file',
      });
    if (!selected(variantsKey)) continue;
    const variants: NonNullable<ResourceDirectoryEntry['variants']> = [];
    for (const variant of ref.localVariants ?? [])
      variants.push({ path: await copy(variant.path), role: variant.role });
    if (variants.length)
      output.push({
        sourceId: `${ref.kind}:${ref.stem}:versions`,
        name: ref.fileName,
        type:
          ref.kind === 'pic' || ref.kind === 'emoji'
            ? 'photo'
            : ref.kind === 'video'
              ? 'video'
              : 'file',
        variants,
      });
  }
  if (policy.avatar !== 'none' || selected('avatarProperties') || selected('avatarVariants'))
    for (const uin of options.senders ?? []) {
      const variants: NonNullable<ResourceDirectoryEntry['variants']> = [],
        attributes: Record<string, unknown> = {};
      const seen = new Set<string>();
      for (const variant of ['big', 'small'] as const) {
        const local = await options.avatarLocal?.(uin, variant);
        if (!local || seen.has(local.path)) continue;
        seen.add(local.path);
        if (selected('avatarVariants'))
          variants.push({
            path: await copy(local.path),
            role: local.variant === 'big' ? 'original' : 'thumbnail',
          });
        if (selected('avatarProperties'))
          attributes[local.variant] = {
            variant: local.variant,
            stale: local.stale,
            mtimeMs: local.mtimeMs,
          };
      }
      let path: string | undefined;
      if (policy.avatar !== 'none')
        try {
          const names = await readdir(join(root, 'avatars'));
          const name = names.find((name) =>
            ['png', 'jpg', 'gif', 'webp'].some((ext) => name === `${uin}.${ext}`),
          );
          if (name) path = `avatars/${name}`;
        } catch {
          /* 头像未导出。 */
        }
      output.push({
        sourceId: `avatar:${uin}`,
        name: uin,
        type: 'photo',
        path,
        variants,
        attributes: selected('avatarProperties') ? attributes : undefined,
      });
    }
  for (const face of options.faces ?? []) {
    if (policy.qqFaces !== 'none')
      output.push({
        sourceId: `qq-face:${face}:primary`,
        name: face,
        type: 'emoji',
        path: face.includes(':')
          ? `media/mface/${face.slice(face.indexOf(':') + 1)}.gif`
          : `media/face/${face}.png`,
      });
    if (!selected('qqFaceVariants')) continue;
    const paths = face.includes(':')
      ? ((await options.marketFaceVariants?.(
          face.slice(0, face.indexOf(':')),
          face.slice(face.indexOf(':') + 1),
        )) ?? [])
      : options.emojiDir
        ? await localFaceVariants(options.emojiDir, face)
        : [];
    const variants: NonNullable<ResourceDirectoryEntry['variants']> = [];
    for (const path of paths)
      variants.push({
        path: await copy(path),
        role: path.includes('/png/') || path.includes('_thu') ? 'thumbnail' : 'original',
      });
    output.push({ sourceId: `qq-face:${face}`, name: face, type: 'emoji', variants });
  }
  if (options.dress && options.usage)
    for (const [kind, ids] of [
      ['bubble', options.usage.bubbles],
      ['font', options.usage.fonts],
      ['widget', options.usage.widgets],
    ] as const) {
      if (!selected(`${kind}Properties`)) continue;
      for (const id of ids) {
        const value =
          kind === 'bubble'
            ? options.dress.localBubble(id)
            : kind === 'font'
              ? options.dress.fontDerived(id)
              : options.dress.localPendant(id);
        const properties = value ? (sourceValue(value) as JsonObject) : {};
        const { file: _file, localFile: _local, ...attributes } = properties;
        output.push({
          sourceId: `${kind}:${id}`,
          name: String(id),
          type: kind,
          attributes: { itemId: id, ...attributes },
        });
      }
    }
  for (const [kind, entries] of [
    ['bubble', options.dressManifest?.bubbles ?? []],
    ['font', options.dressManifest?.fonts ?? []],
    ['widget', options.dressManifest?.widgets ?? []],
  ] as const)
    for (const entry of entries) {
      const files =
        'staticPng' in entry
          ? [
              entry.staticPng,
              ...(entry.frames ?? []),
              ...(entry.animation ? [entry.animation] : []),
            ]
          : 'frames' in entry
            ? [entry.file, ...(entry.frames ?? [])]
            : [entry.file];
      output.push({
        sourceId: `${kind}:${entry.itemId}:files`,
        name: String(entry.itemId),
        type: kind,
        variants: [...new Set(files)].map((path) => ({ path, role: 'original' })),
      });
    }
  return output;
}
