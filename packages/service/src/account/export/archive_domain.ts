import {
  archiveHeader,
  actor,
  makeEntry,
  object,
  recordRevision,
  stableId,
  typedValue,
  writeArchiveEntries,
  type ArchiveEntry,
  type ArchiveOptions,
  type Json,
  type JsonObject,
} from './archive';
import { sourceValue, unixTime, nativeValue } from './archive_value';
import type { GeneratedContentSnapshot } from '../generated_content';
import { archiveResource } from './archive_resource';
import { dirname } from 'node:path';
import type { EmotionWithInteraction, QzoneExportData, QzoneWriteOpts } from './qzone_export';
import type { CollectionExportRow, CollectionExportCoverage } from './collection_export';
import type { GeneratedResourceManifest } from './generated_resources';

/** 已规范化字段只存一份，其余实际取得的来源属性随明细选择保留。 */
function sourceAttributes(row: object, consumed: readonly string[]): Record<string, unknown> {
  const known = new Set(consumed);
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => !known.has(field))
      .map(([field, value]) => [`source.${field}`, value]),
  );
}

export class DomainArchive {
  readonly header;
  readonly entries: ArchiveEntry[] = [];
  private readonly observations = new Map<string, ArchiveEntry>();
  readonly account: Json;
  readonly profile;
  readonly observedAt;
  constructor(readonly options: ArchiveOptions = {}) {
    this.header = archiveHeader(options);
    this.account = object(this.header.scope).account ?? null;
    this.profile = options.profile ?? 'basic';
    this.observedAt = unixTime(options.observedAt ?? Date.now(), true)!;
  }
  identity(...parts: Json[]): Json[] {
    return [this.account, object(this.header.scope).partition ?? null, ...parts];
  }
  add(
    kind: ArchiveEntry['record']['kind'],
    identity: Json[],
    data: JsonObject,
    extra: Record<string, unknown> = {},
    sourceKind: 'cache' | 'database' | 'remote' | 'local-generated' = 'cache',
  ): ArchiveEntry {
    const source = { id: stableId('source', identity), kind: sourceKind, locator: kind };
    const option =
      kind === 'qzone'
        ? 'qzoneInteractions'
        : kind === 'collection'
          ? 'collectionProperties'
          : kind === 'mail'
            ? 'mailProperties'
            : kind === 'generated'
              ? 'generatedParameters'
              : kind === 'directory'
                ? 'directoryProperties'
                : 'resourceProperties';
    const attributes = Object.entries(this.options.extra?.[option] === false ? {} : extra)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ target: '/data', name, value: nativeValue(value) }));
    const entry = makeEntry(kind, identity, data, {
      profile: this.profile,
      attributes,
      source,
      observedAt: this.observedAt,
    });
    entry.observation.id = stableId('observation', [
      this.options.scanId ?? String(this.header.archiveId),
      source.id,
      entry.record.id,
      entry.record.revision,
    ]);
    const previous = this.observations.get(String(entry.observation.id));
    if (previous) return previous;
    this.entries.push(entry);
    this.observations.set(String(entry.observation.id), entry);
    return entry;
  }
  external(id: string, kind: string): void {
    const refs = (this.header.externalReferences ?? []) as JsonObject[];
    if (!refs.some((reference) => reference.id === id))
      refs.push({ id, kind, reason: 'not-selected' });
    this.header.externalReferences = refs;
  }
  async write(path: string, format: 'json' | 'jsonl' | 'jsonl.gz'): Promise<void> {
    await writeArchiveEntries(path, format, this.header, this.entries);
  }
}

async function webMedia(
  archive: DomainArchive,
  identity: Json[],
  items: Array<{
    url?: string;
    localPath?: string;
    name?: string;
    mediaType: 'image' | 'video' | 'audio' | 'file';
    sourceId?: string;
    role?: 'original' | 'preview' | 'cover' | 'unverified';
    status?: 'not-requested' | 'missing' | 'failed' | 'unavailable';
    error?: string;
  }>,
  root: string,
): Promise<{ content: JsonObject[]; resources: JsonObject[] }> {
  const content: JsonObject[] = [],
    resources: JsonObject[] = [];
  for (const [index, item] of items.entries()) {
    const id = stableId('resource', [...identity, 'media', item.sourceId ?? index]);
    const receipt: JsonObject = {
      id,
      role: item.role ?? 'unverified',
      status: item.status ?? 'not-requested',
      observedAt: archive.observedAt,
      ...(item.url ? { url: item.url } : {}),
      ...(item.name ? { name: item.name } : {}),
      ...(item.error ? { error: item.error } : {}),
    };
    resources.push(await archiveResource(root, item.localPath, receipt));
    content.push({
      type: 'media',
      mediaType: item.mediaType,
      resourceIds: [id],
      ...(item.name ? { caption: item.name } : {}),
    });
  }
  return { content, resources };
}

export async function writeQzoneArchive(
  data: QzoneExportData,
  opts: QzoneWriteOpts,
  format: 'json' | 'jsonl' | 'jsonl.gz',
): Promise<void> {
  const archive = new DomainArchive(opts.archive);
  const owner = actor(opts.targetUin);
  const root = dirname(opts.outputPath);
  const outcomes = new Map((data.mediaOutcomes ?? []).map((outcome) => [outcome.url, outcome]));
  const addPost = async (
    row: EmotionWithInteraction,
    author = owner,
    authorUin = opts.targetUin,
    source: object = row,
  ): Promise<ArchiveEntry> => {
    const identity = archive.identity('post', authorUin, row.tid);
    const paths = { ...data.mediaPaths, ...row.localMedia };
    const media = await webMedia(
      archive,
      identity,
      [
        ...row.images.map((url) => ({ url, localPath: paths[url], mediaType: 'image' as const })),
        ...row.videos.flatMap((video, index) => [
          {
            url: video.videoUrl,
            localPath: paths[video.videoUrl],
            mediaType: 'video' as const,
          },
          ...(video.coverUrl
            ? [
                {
                  url: video.coverUrl,
                  localPath: paths[video.coverUrl],
                  mediaType: 'image' as const,
                  role: 'cover' as const,
                  sourceId: `video-cover:${index}`,
                },
              ]
            : []),
        ]),
      ].map((item) => {
        const outcome = outcomes.get(item.url);
        return {
          ...item,
          ...(outcome?.status === 'failed'
            ? { status: 'failed' as const, error: outcome.reason }
            : {}),
        };
      }),
      root,
    );
    const entry = archive.add(
      'qzone',
      identity,
      {
        type: 'post',
        owner,
        sourceId: row.tid,
        author,
        createdAt: row.time ? unixTime(row.time) : null,
        content: [{ type: 'text', text: row.content }, ...media.content],
        counts: {
          comments: row.commentNum === null ? null : String(row.commentNum),
          ...(row.forwardNum === undefined ? {} : { reposts: String(row.forwardNum) }),
        },
      },
      {
        ...sourceAttributes(source, [
          'tid',
          'time',
          'content',
          'images',
          'videos',
          'commentNum',
          'forwardNum',
          'comments',
          'repost',
          'localMedia',
          'uin',
          'nickname',
        ]),
        'source.videoProperties': row.videos.map(
          ({ videoUrl: _url, coverUrl: _cover, ...properties }) => properties,
        ),
      },
      'remote',
    );
    entry.resources = media.resources;
    if (row.repost) {
      const original = row.repost;
      const originalEntry = await addPost(
        {
          tid: original.tid,
          time: 0,
          content: original.content,
          images: original.images,
          videos: original.videos,
          commentNum: null,
          isPrivate: false,
          contentTruncated: original.contentTruncated,
        },
        actor(original.uin, undefined, original.nickname),
        original.uin,
        original,
      );
      entry.record.data.repostId = originalEntry.record.id;
      entry.record.revision = recordRevision(entry.record);
      entry.observation.revision = entry.record.revision;
    }
    for (const comment of row.comments ?? []) {
      const commentIdentity = archive.identity('comment', authorUin, row.tid, comment.id);
      const parentId =
        comment.isReply && comment.parentCommentId
          ? stableId(
              'qzone',
              archive.identity('comment', authorUin, row.tid, comment.parentCommentId),
            )
          : entry.record.id;
      if (
        parentId !== entry.record.id &&
        !(row.comments ?? []).some((item) => item.id === comment.parentCommentId)
      )
        archive.external(parentId, 'qzone');
      const commentMedia = await webMedia(
        archive,
        commentIdentity,
        comment.images.map((url) => ({ url, localPath: paths[url], mediaType: 'image' as const })),
        root,
      );
      const added = archive.add(
        'qzone',
        commentIdentity,
        {
          type: comment.isReply ? 'reply' : 'comment',
          owner,
          sourceId: comment.id,
          author: actor(comment.uin, undefined, comment.nickname),
          createdAt: comment.time ? unixTime(comment.time) : null,
          parentId,
          parentType: comment.isReply && comment.parentCommentId ? 'comment' : 'post',
          ...(comment.replyToUin
            ? { replyTo: actor(comment.replyToUin, undefined, comment.replyToNickname) }
            : {}),
          content: [{ type: 'text', text: comment.content }, ...commentMedia.content],
        },
        sourceAttributes(comment, [
          'id',
          'uin',
          'nickname',
          'content',
          'time',
          'isReply',
          'parentCommentId',
          'replyToUin',
          'replyToNickname',
          'images',
        ]),
        'remote',
      );
      added.resources = commentMedia.resources;
    }
    return entry;
  };
  for (const row of data.rows) await addPost(row);
  await archive.write(opts.outputPath, format);
}

export async function writeCollectionArchive(
  rows: CollectionExportRow[],
  coverage: CollectionExportCoverage,
  path: string,
  format: 'json' | 'jsonl' | 'jsonl.gz',
  options: ArchiveOptions = {},
): Promise<void> {
  const archive = new DomainArchive(options);
  for (const row of rows) {
    const identity = archive.identity('collection', row.cid);
    const refs = coverage.attachments.filter((item) => item.cid === row.cid);
    const media = await webMedia(
      archive,
      identity,
      refs.map((item) => ({
        sourceId: item.referenceId,
        name: item.name,
        localPath: item.file ?? undefined,
        role: item.role,
        status:
          item.state === 'failed'
            ? ('failed' as const)
            : item.state === 'unavailable'
              ? ('unavailable' as const)
              : item.state === 'downloaded'
                ? ('missing' as const)
                : ('not-requested' as const),
        error: item.error ?? undefined,
        mediaType:
          item.kind === 'image'
            ? 'image'
            : item.kind === 'video'
              ? 'video'
              : item.kind === 'audio'
                ? 'audio'
                : 'file',
      })),
      dirname(path),
    );
    const content: JsonObject[] = [];
    if (row.fullContent !== undefined && row.fullContentFormat !== 'binary')
      content.push({
        type: 'text',
        text: row.fullContent,
        format: row.fullContentFormat === 'html' ? 'html' : 'plain',
      });
    else if (row.fullContent !== undefined)
      content.push({
        type: 'structured',
        kind: 'qq.collection-binary',
        value: typedValue(row.fullContent),
      });
    if (row.text && row.text !== row.fullContent) content.push({ type: 'text', text: row.text });
    for (const field of [
      'link',
      'gallery',
      'audio',
      'video',
      'file',
      'location',
      'richMedia',
    ] as const)
      if (row[field])
        content.push({
          type: 'structured',
          kind: `qq.collection.${field}`,
          value: typedValue(sourceValue(row[field])),
        });
    content.push(...media.content);
    const entry = archive.add(
      'collection',
      identity,
      {
        cid: row.cid,
        type: [
          'text',
          'link',
          'gallery',
          'audio',
          'video',
          'file',
          'location',
          'richMedia',
        ].includes(row.kind)
          ? row.kind
          : 'unknown',
        author: actor(row.authorUin, undefined, row.authorName),
        createdAt: unixTime(row.createTime, true),
        collectedAt: unixTime(row.collectTime, true),
        bodyStatus:
          row.contentStatus === 'complete'
            ? 'complete'
            : row.textTruncated || row.contentStatus === 'truncated'
              ? 'truncated'
              : row.fullContentFormat === 'binary'
                ? 'opaque'
                : 'summary',
        content,
      },
      {
        ...sourceAttributes(row, [
          'cid',
          'kind',
          'authorUin',
          'authorName',
          'createTime',
          'collectTime',
          'text',
          'fullContent',
          'fullContentFormat',
          'link',
          'gallery',
          'audio',
          'video',
          'file',
          'location',
          'richMedia',
          'mediaFiles',
        ]),
        'source.attachmentProperties': refs.map(
          ({
            cid: _cid,
            name: _name,
            file: _file,
            role: _role,
            state: _state,
            error: _error,
            kind: _kind,
            ...properties
          }) => properties,
        ),
      },
    );
    entry.resources = media.resources;
  }
  await archive.write(path, format);
}

export async function writeDirectoryArchive(
  rows: readonly object[],
  type: 'contact' | 'group' | 'member',
  path: string,
  format: 'json' | 'jsonl' | 'jsonl.gz',
  options: ArchiveOptions = {},
  groupCode?: string,
): Promise<void> {
  const archive = new DomainArchive(options);
  for (const value of rows) {
    const row = value as Record<string, unknown>;
    const uid = String(row.uid ?? ''),
      uin = String(row.uin ?? '');
    const group = String(row.groupCode ?? groupCode ?? '');
    const identity = archive.identity(
      type,
      type === 'member' ? group : null,
      type === 'group' ? group : uid || uin,
    );
    const data: JsonObject = {
      type,
      subject:
        type === 'group'
          ? { identities: [{ namespace: 'source', value: `group:${group}` }] }
          : actor(uin, uid),
      name: String(type === 'group' ? (row.groupName ?? '') : (row.nick ?? '')),
    };
    const consumed = new Set(['uid', 'uin', 'groupCode', 'groupName', 'nick', 'native']);
    if ('remark' in row) {
      data.remark = String(row.remark);
      consumed.add('remark');
    }
    if (type === 'member') {
      data.parentId = stableId('directory', archive.identity('group', null, group));
      archive.external(String(data.parentId), 'directory');
      data.role = String(row.role ?? '');
      consumed.add('role');
    }
    const raw =
      row.native && typeof row.native === 'object' ? (row.native as Record<string, unknown>) : row;
    const extras = Object.fromEntries(
      Object.entries(raw)
        .filter(([field]) => !consumed.has(field))
        .map(([field, value]) => [`source.${field}`, value]),
    );
    archive.add('directory', identity, data, extras, 'database');
  }
  await archive.write(path, format);
}

export async function writeGeneratedArchive(
  snapshot: GeneratedContentSnapshot,
  path: string,
  format: 'json' | 'jsonl' | 'jsonl.gz',
  options: ArchiveOptions = {},
  manifest?: GeneratedResourceManifest,
): Promise<void> {
  const archive = new DomainArchive({
    ...options,
    selection:
      options.selection ??
      sourceValue({ target: snapshot.target, selectedIds: snapshot.selectedIds }),
  });
  const target = snapshot.target;
  const messageIdentity = (id: string) =>
    archive.identity(target.kind, target.ownerId, target.sessionId, id);
  const selectedIds = new Set(snapshot.messages.map((row) => row.id));
  const mediaByMessage = new Map<string, { content: JsonObject[]; resources: JsonObject[] }>();
  for (const resource of manifest?.entries ?? []) {
    const media = await webMedia(
      archive,
      archive.identity('generated-resource', resource.key),
      resource.files?.length
        ? resource.files.map((file) => ({
            localPath: file.path,
            name: resource.name,
            mediaType:
              resource.kind === 'voice' ? 'audio' : resource.kind === 'sticker' ? 'image' : 'file',
          }))
        : [
            {
              name: resource.name,
              mediaType:
                resource.kind === 'voice'
                  ? 'audio'
                  : resource.kind === 'sticker'
                    ? 'image'
                    : 'file',
            },
          ],
      dirname(path),
    );
    if (resource.status === 'missing')
      for (const receipt of media.resources) {
        receipt.status = 'missing';
        if (resource.error) receipt.error = resource.error;
      }
    for (const id of resource.messageIds) {
      const current = mediaByMessage.get(id) ?? { content: [], resources: [] };
      current.content.push(...media.content);
      current.resources.push(...media.resources);
      mediaByMessage.set(id, current);
    }
  }
  for (const row of snapshot.messages) {
    const source = row as unknown as Record<string, unknown>;
    const process: JsonObject[] = [];
    if (options.extra?.generatedParameters !== false)
      for (const name of ['steps', 'actions', 'toolsUsed'])
        if (source[name] !== undefined)
          process.push(typedValue(sourceValue({ [name]: source[name] })));
    const consumed = new Set([
      'id',
      'text',
      'ts',
      'role',
      'senderKind',
      'senderId',
      'steps',
      'actions',
      'toolsUsed',
      'replyToId',
    ]);
    const media = mediaByMessage.get(row.id);
    const entry = archive.add(
      'generated',
      messageIdentity(row.id),
      {
        origin: 'local-generated',
        targetKind: target.kind,
        ownerId: target.ownerId,
        sessionId: target.sessionId,
        messageId: row.id,
        sender: { identities: row.senderId ? [{ namespace: 'local', value: row.senderId }] : [] },
        role: row.role || row.senderKind || 'unknown',
        sentAt: unixTime(row.ts, true),
        content: [{ type: 'text', text: row.text }, ...(media?.content ?? [])],
        process,
        ...(row.replyToId
          ? { replyToId: stableId('generated', messageIdentity(row.replyToId)) }
          : {}),
      },
      Object.fromEntries(
        Object.entries(source)
          .filter(([field]) => !consumed.has(field))
          .map(([field, value]) => [`source.${field}`, value]),
      ),
      'local-generated',
    );
    entry.resources = media?.resources;
    if (row.replyToId && !selectedIds.has(row.replyToId))
      archive.external(String(entry.record.data.replyToId), 'generated');
  }
  await archive.write(path, format);
}
