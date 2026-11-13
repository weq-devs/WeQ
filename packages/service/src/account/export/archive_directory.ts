import { readdir, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DomainArchive } from './archive_domain';
import { archiveResource } from './archive_resource';
import {
  recordRevision,
  canonical,
  stableId,
  type ArchiveOptions,
  type JsonObject,
  type ArchiveEntry,
} from './archive';

export interface ResourceDirectoryEntry {
  variants?: Array<{ path: string; role: 'original' | 'thumbnail' | 'preview' | 'cover' }>;
  status?: 'not-requested' | 'missing' | 'failed';
  sourceId: string;
  name: string;
  type?:
    | 'folder'
    | 'file'
    | 'album'
    | 'photo'
    | 'video'
    | 'emoji-pack'
    | 'emoji'
    | 'bubble'
    | 'font'
    | 'widget'
    | 'artifact'
    | 'report'
    | 'bot-package';
  path?: string;
  attributes?: Record<string, unknown>;
  owner?: JsonObject;
  parentSourceId?: string;
}

/** 仅处理本次明确选择的资源，绝不递归扫描导出目录或附带其他文件。 */
export async function selectedResourceEntries(
  root: string,
  metadata: ResourceDirectoryEntry[],
  options: ArchiveOptions,
): Promise<ArchiveEntry[]> {
  const archive = new DomainArchive(options);
  for (const source of metadata) {
    const identity = archive.identity('selected-resource', source.sourceId);
    const variants = [
      ...(source.path ? [{ path: source.path, role: 'original' as const }] : []),
      ...(source.variants ?? []),
    ];
    const resources: JsonObject[] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
      const key = `${variant.role}\0${variant.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(
        await archiveResource(root, variant.path, {
          id: stableId('resource', [...identity, variant.role, variant.path]),
          role: variant.role,
          status:
            variant.role === 'original' ? (source.status ?? 'not-requested') : 'not-requested',
          name: source.name,
          observedAt: archive.observedAt,
        }),
      );
    }
    if (source.status && !source.path)
      resources.unshift({
        id: stableId('resource', [...identity, 'original']),
        role: 'original',
        status: source.status,
        name: source.name,
        observedAt: archive.observedAt,
      });
    const entry = archive.add(
      'resource-directory',
      identity,
      {
        type: source.type ?? 'file',
        sourceId: source.sourceId,
        owner: source.owner ?? archive.account,
        name: source.name,
        resourceIds: resources.map((resource) => resource.id!),
      },
      Object.fromEntries(
        Object.entries(source.attributes ?? {}).map(([key, value]) => [`source.${key}`, value]),
      ),
    );
    entry.resources = resources;
  }
  return archive.entries;
}
/** 资源任务的正式文件清单；数据库/图片/HTML/运行包本身仍保留原格式。 */
export async function writeResourceDirectoryArchive(
  root: string,
  format: 'json' | 'jsonl' | 'jsonl.gz',
  options: ArchiveOptions,
  failed: Array<{ fileName: string; error: string }>,
  metadata: ResourceDirectoryEntry[] = [],
  signal?: AbortSignal,
): Promise<void> {
  const archive = new DomainArchive(options);
  const byPath = new Map(metadata.filter((item) => item.path).map((item) => [item.path!, item]));
  const visited = new Set<string>();
  const directories = new Map<string, string>();
  const identityFor = (source: ResourceDirectoryEntry) =>
    archive.identity(
      'resource-directory',
      source.owner ?? archive.account,
      source.parentSourceId ?? null,
      source.sourceId,
    );
  const sourceKey = (sourceId: string, owner?: JsonObject) =>
    canonical([owner ?? archive.account, sourceId]);
  const bySource = new Map(
    metadata.map((source) => [sourceKey(source.sourceId, source.owner), source]),
  );
  const parentFor = (relative: string, source?: ResourceDirectoryEntry): string | undefined => {
    if (!source?.parentSourceId) return directories.get(dirname(relative).replaceAll('\\', '/'));
    const parent = bySource.get(sourceKey(source.parentSourceId, source.owner));
    const id = stableId(
      'resource-directory',
      identityFor(parent ?? { sourceId: source.parentSourceId, name: '', owner: source.owner }),
    );
    if (!parent) archive.external(id, 'resource-directory');
    return id;
  };
  const receiptsFor = async (
    identity: Parameters<typeof stableId>[1],
    source: ResourceDirectoryEntry,
    primary?: string,
  ): Promise<JsonObject[]> => {
    const receipts: JsonObject[] = [];
    const seen = new Set<string>();
    const variants = [
      ...(primary ? [{ path: primary, role: 'original' as const }] : []),
      ...(source.variants ?? []),
    ];
    for (const variant of variants) {
      const key = `${variant.role}\0${variant.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      receipts.push(
        await archiveResource(root, variant.path, {
          id: stableId('resource', [...identity, variant.role, variant.path]),
          role: variant.role,
          status: 'not-requested',
          name: source.name,
          observedAt: archive.observedAt,
        }),
      );
    }
    if (!primary && !variants.some((variant) => variant.role === 'original'))
      receipts.unshift({
        id: stableId('resource', identity),
        role: 'original',
        status: source.status ?? 'missing',
        name: source.name,
        observedAt: archive.observedAt,
      });
    return receipts;
  };
  const addDirectory = (relative: string, source?: ResourceDirectoryEntry) => {
    const identity = source
      ? identityFor(source)
      : archive.identity('resource-directory', String(archive.header.archiveId), relative);
    const parentId = parentFor(relative, source);
    const entry = archive.add(
      'resource-directory',
      identity,
      {
        type: source?.type ?? 'folder',
        sourceId: source?.sourceId ?? relative,
        owner: source?.owner ?? archive.account,
        name: source?.name ?? basename(relative),
        resourceIds: [],
        ...(parentId ? { parentId } : {}),
      },
      Object.fromEntries(
        Object.entries(source?.attributes ?? {}).map(([field, value]) => [
          `source.${field}`,
          value,
        ]),
      ),
    );
    directories.set(relative, entry.record.id);
    return entry;
  };
  async function visit(relative: string): Promise<void> {
    signal?.throwIfAborted();
    const file = join(root, relative),
      info = await lstat(file);
    if (info.isDirectory()) {
      if (relative !== 'files') addDirectory(relative, byPath.get(relative));
      visited.add(relative);
      for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
      return;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('资源任务包含非普通文件，未发布。');
    const source = byPath.get(relative);
    visited.add(relative);
    const identity = source
      ? identityFor(source)
      : archive.identity('resource-directory', String(archive.header.archiveId), relative);
    const receipts = await receiptsFor(
      identity,
      source ?? { sourceId: relative, name: basename(relative) },
      relative,
    );
    const parentId = parentFor(relative, source);
    const entry = archive.add(
      'resource-directory',
      identity,
      {
        type: source?.type ?? 'file',
        sourceId: source?.sourceId ?? relative,
        owner: source?.owner ?? archive.account,
        name: source?.name ?? basename(relative),
        resourceIds: receipts.map((receipt) => receipt.id!),
        ...(parentId ? { parentId } : {}),
      },
      Object.fromEntries(
        Object.entries(source?.attributes ?? {}).map(([field, value]) => [
          `source.${field}`,
          value,
        ]),
      ),
    );
    if (!source) entry.record.identity = { status: 'source-local' };
    entry.resources = receipts;
  }
  await visit('files');
  for (const source of metadata)
    if (!source.path || !visited.has(source.path)) {
      const entry = addDirectory(source.path ?? source.sourceId, source);
      if (source.type !== 'folder' && source.type !== 'album' && source.type !== 'emoji-pack') {
        entry.resources = await receiptsFor(identityFor(source), source);
        entry.record.data.resourceIds = entry.resources.map((receipt) => receipt.id!);
      }
    }
  for (const [index, failure] of failed.entries()) {
    const identity = archive.identity('resource-directory-failure', failure.fileName, index);
    const resourceId = stableId('resource', identity);
    const entry = archive.add('resource-directory', identity, {
      type: 'file',
      sourceId: `failed:${failure.fileName}`,
      owner: archive.account,
      name: failure.fileName,
      resourceIds: [resourceId],
    });
    entry.resources = [
      {
        id: resourceId,
        role: 'unverified',
        status: 'failed',
        error: failure.error,
        name: failure.fileName,
        observedAt: archive.observedAt,
      },
    ];
  }
  // identity 是正式摘要的一部分，补充来源本地身份后统一重算。
  for (const entry of archive.entries) {
    entry.record.revision = recordRevision(entry.record);
    entry.observation.revision = entry.record.revision;
  }
  await archive.write(join(root, `resource-results.${format}`), format);
}
