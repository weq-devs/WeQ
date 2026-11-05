import { stat } from 'node:fs/promises';
import {
  archiveHeader,
  actor,
  canonical,
  checkArchiveShape,
  makeEntry,
  object,
  stableId,
  typedValue,
  writeArchiveEntries,
  type ArchiveEntry,
  type ArchiveOptions,
  type Json,
  type JsonObject,
} from './archive';
import type { MsgService, RenderC2cMsg, RenderGroupMsg } from '../msg';
import type { RenderElement } from '../msg_view';
import {
  iterateConv,
  fallbackSender,
  resolveGroupSenders,
  resolveC2cSenders,
  type SenderResolveDeps,
} from './sender_resolve';
import { toExportedMessage } from './message_source';
import { expandForwards } from './forward_expand';
import { collectFaceIds } from './element_text';
import { MessageAudit } from './message_audit';
import { mediaRelPath } from './element_text';
import { basename, dirname } from 'node:path';
import { archiveResource } from './archive_resource';
import { MessageJournal } from './message_journal';
import { recordRevision } from './archive';
import type { JsonMetaExportOptions } from './json_meta_exporter';
import type { ExportResult } from './types';
import { nativeValue, sourceValue, unixTime } from './archive_value';
import { attachNativeMessageSource } from './archive_native';
import { withDatabasePriority } from '@weq/db';
import { decodeMsgCacheColumn } from '@weq/codec';
import type { ContactsExportDeps } from './contacts_export';
import type { ResourceDirectoryEntry } from './archive_directory';
import { normalizeExportContent } from '../../common/export_content';
import { resolveOriginalUrl } from '../media_download';

interface ContentContext {
  transcripts?: Record<string, string>;
  ocr?: Record<string, string>;
  root?: string;
  sourceRoot?: string;
  withMediaPaths?: boolean;
  identity: Json[];
  profile: 'basic' | 'full';
  resources: JsonObject[];
  attributes: JsonObject[];
  residuals: JsonObject[];
  sourceId: string;
  observedAt: JsonObject;
  guild?: boolean;
  targets?: Map<number, number>;
  fieldTargets?: Map<string, string>;
  skipNativeRoot?: boolean;
  expansionSourceId?: string;
  hasExpanded?: { value: boolean };
  forwardNodes?: Map<string, string[]>;
  activeForwards?: Set<string>;
}
async function orderedMap<T, R>(
  values: readonly T[],
  transform: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (const [index, value] of values.entries()) result.push(await transform(value, index));
  return result;
}
function incompleteContent(value: JsonObject): boolean {
  return (Array.isArray(value.content) ? value.content : []).some((item) => {
    const element = object(item);
    if (element.type === 'unknown') return true;
    if (element.type === 'reference') return element.status !== 'resolved';
    if (element.type !== 'forward') return false;
    return (
      element.status !== 'complete' || (element.records as JsonObject[]).some(incompleteContent)
    );
  });
}
export async function archiveContent(
  elements: readonly RenderElement[],
  context: ContentContext,
  path = '/data/content',
  depth = 0,
  sourcePath = '/elements',
): Promise<JsonObject[]> {
  let contentIndex = 0;
  context.forwardNodes ??= new Map();
  context.activeForwards ??= new Set();
  const mapped = await orderedMap(elements, async (element, index): Promise<JsonObject[]> => {
    const data = element.data as unknown as Record<string, unknown>;
    const position = contentIndex++;
    const target = `${path}/${position}`;
    if (path === '/data/content') context.targets?.set(index, position);
    const additional: JsonObject[] = [];
    const sourceElementPath = `${sourcePath}/${index}/data`;
    const fragmentSourceId =
      path === '/data/content' ? context.sourceId : (context.expansionSourceId ?? context.sourceId);
    const extras = new Set(Object.keys(data));
    const take = (key: string) => {
      extras.delete(key);
      return data[key];
    };
    let output: JsonObject;
    if (depth >= 32)
      return [{ type: 'unknown', sourceType: element.type, reason: '嵌套层数超过导出上限' }];
    if (element.type === 'unknown') {
      output = {
        type: 'unknown',
        sourceType: String(data.elementType ?? object(data.nativeElement).elementType ?? 'unknown'),
        reason: '当前来源元素尚未解析',
      };
      if (context.profile === 'full' && !(context.skipNativeRoot && path === '/data/content')) {
        const source = data.nativeElement === undefined ? data : object(data.nativeElement);
        for (const [field, value] of Object.entries(source))
          if (field !== 'elementType' && value !== undefined)
            context.residuals.push({
              source: fragmentSourceId,
              path: `${sourceElementPath}/${data.nativeElement === undefined ? '' : 'nativeElement/'}${field.replaceAll('~', '~0').replaceAll('/', '~1')}`,
              reason: 'opaque-content',
              value: nativeValue(value),
            });
      }
      return [output];
    }
    if (element.type === 'text') output = { type: 'text', text: String(take('textContent') ?? '') };
    else if (element.type === 'at') {
      const uid = String(take('atTargetUid') ?? '');
      const name = String(take('textContent') ?? '');
      output = {
        type: 'mention',
        actor: actor(undefined, uid || undefined, name),
        ...(uid === 'all' ? { all: true } : {}),
      };
    } else if (element.type === 'multiMsg') {
      const nested = take('forwardMessages');
      if (Array.isArray(nested) && nested.length && context.hasExpanded)
        context.hasExpanded.value = true;
      const resId = String(take('resId') ?? '');
      const card = take('xmlContent');
      if (typeof card === 'string' && card) {
        additional.push({ type: 'structured', kind: 'qq.forward-card', value: typedValue(card) });
        if (path === '/data/content')
          context.fieldTargets?.set(`${index}:xmlContent`, `${path}/${contentIndex}/value/value`);
        contentIndex++;
      }
      const savedNodes = resId ? context.forwardNodes!.get(resId) : undefined;
      if (savedNodes?.length) {
        const status = context.activeForwards!.has(resId) ? 'cycle' : 'resolved';
        output = { type: 'reference', target: savedNodes[0]!, status };
        const references = savedNodes
          .slice(1)
          .map((target) => ({ type: 'reference', target, status }));
        additional.unshift(...references);
        contentIndex += references.length;
        if (typeof card === 'string' && card && path === '/data/content')
          context.fieldTargets?.set(
            `${index}:xmlContent`,
            `${path}/${position + savedNodes.length}/value/value`,
          );
      } else {
        const resourceKey =
          resId || (data.elementId ? `element:${String(data.elementId)}` : sourceElementPath);
        const nodeIds = Array.isArray(nested)
          ? nested.map((_, nodeIndex) =>
              stableId('forward', [...context.identity, resourceKey, nodeIndex]),
            )
          : [];
        if (resId && nodeIds.length) {
          context.forwardNodes!.set(resId, nodeIds);
          context.activeForwards!.add(resId);
        }
        output = {
          type: 'forward',
          status: Array.isArray(nested) ? 'complete' : 'unavailable',
          records: Array.isArray(nested)
            ? await orderedMap(nested, async (value, nodeIndex) => {
                const row = value as Record<string, unknown>;
                const id = nodeIds[nodeIndex]!;
                return {
                  id,
                  sender: actor(
                    String(row.senderUin ?? ''),
                    String(row.senderUid ?? ''),
                    typeof row.senderName === 'string' ? row.senderName : undefined,
                  ),
                  sentAt: unixTime(String(row.sendTime ?? '')),
                  seq: /^-?\d+$/.test(String(row.msgSeq)) ? String(row.msgSeq) : null,
                  content: await archiveContent(
                    Array.isArray(row.elements) ? (row.elements as RenderElement[]) : [],
                    context,
                    `${target}/records/${nodeIndex}/content`,
                    depth + 1,
                    `${sourceElementPath}/forwardMessages/${nodeIndex}/elements`,
                  ),
                };
              })
            : [],
        };
        if (resId) context.activeForwards!.delete(resId);
        if ((output.records as JsonObject[]).some(incompleteContent)) output.status = 'partial';
      }
      // 卡片的独立文案和资源标识不因展开成功而消失。
      if (
        resId &&
        context.profile === 'full' &&
        !(context.skipNativeRoot && path === '/data/content')
      )
        context.attributes.push({ target, name: 'source.resId', value: typedValue(resId) });
    } else if (['pic', 'video', 'ptt', 'file', 'onlineFile', 'mface'].includes(element.type)) {
      const resourceId = stableId('resource', [
        ...context.identity,
        sourceElementPath,
        element.type,
        String(data.md5 ?? data.md5Bytes ?? data.fileToken ?? data.fileName ?? ''),
      ]);
      const name = String(take('fileName') ?? '');
      const originalUrl = typeof data.originalUrl === 'string' ? data.originalUrl : undefined;
      let url: string | undefined;
      if (originalUrl)
        try {
          const resolved = new URL(resolveOriginalUrl(originalUrl)).href;
          checkArchiveShape('common.schema.json#/$defs/resource/properties/url', resolved);
          url = resolved;
        } catch {
          // 无效地址不进入 URI 字段；完整档仍通过原生属性保留原值。
        }
      const size =
        typeof data.fileSize === 'number' &&
        Number.isSafeInteger(data.fileSize) &&
        data.fileSize >= 0
          ? String(data.fileSize)
          : undefined;
      const receipt: JsonObject = {
        id: resourceId,
        role: element.type !== 'ptt' && data.isOriginal === true ? 'original' : 'unverified',
        status: 'not-requested',
        observedAt: context.observedAt,
        ...(name ? { name } : {}),
        ...(url ? { url } : {}),
        ...(size ? { size } : {}),
      };
      if (url === originalUrl) take('originalUrl');
      take('fileSize');
      context.resources.push(
        context.root && context.withMediaPaths
          ? await archiveResource(
              context.root,
              mediaRelPath(element) ?? undefined,
              receipt,
              context.sourceRoot,
            )
          : receipt,
      );
      const mediaType =
        element.type === 'pic'
          ? 'image'
          : element.type === 'video'
            ? 'video'
            : element.type === 'ptt'
              ? 'audio'
              : element.type === 'mface'
                ? 'sticker'
                : 'file';
      const transcript =
        element.type === 'ptt'
          ? context.transcripts?.[name] ||
            (typeof data.pttTranscript === 'string' ? data.pttTranscript : '')
          : element.type === 'pic'
            ? context.ocr?.[name]
            : undefined;
      if (transcript) take('pttTranscript');
      output = {
        type: 'media',
        mediaType,
        resourceIds: [resourceId],
        ...(transcript ? { caption: transcript } : {}),
      };
      const durationKey =
        element.type === 'video' ? 'videoDuration' : element.type === 'ptt' ? 'pttDuration' : '';
      if (durationKey && typeof data[durationKey] === 'number' && Number(data[durationKey]) >= 0)
        output.durationSeconds = Number(take(durationKey));
    } else {
      // Ark/回复/系统事件等保留唯一结构载荷，不拍平成显示占位符。
      const { nativeElement: _native, ...semantic } = data;
      output = {
        type: 'structured',
        kind: `qq.${element.type}`,
        value: typedValue(sourceValue(semantic)),
      };
      extras.clear();
    }
    // nativeElement 是另一套完整元素表示，不能与已映射内容一起再存一遍。
    extras.delete('nativeElement');
    extras.delete('exportPath');
    if (context.skipNativeRoot && path === '/data/content') return [output, ...additional];
    if (
      context.profile === 'full' &&
      data.nativeElement &&
      typeof data.nativeElement === 'object'
    ) {
      const native = object(data.nativeElement);
      const childKeys: Record<string, string> = {
        text: 'textElement',
        at: 'textElement',
        pic: 'picElement',
        file: 'fileElement',
        ptt: 'pttElement',
        video: 'videoElement',
        face: 'faceElement',
        ark: 'arkElement',
        markdown: 'markdownElement',
      };
      const childKey = childKeys[element.type];
      const aliases: Record<string, string> = {
        content: element.type === 'markdown' ? 'markdownContent' : 'textContent',
        atUid: 'atTargetUid',
        picWidth: 'imgWidth',
        picHeight: 'imgHeight',
        originImageUrl: 'originalUrl',
        duration: element.type === 'ptt' ? 'pttDuration' : 'videoDuration',
        text: 'pttTranscript',
        waveAmplitudes: 'waveform',
        faceIndex: 'faceId',
        bytesData: 'arkData',
        fileUuid: 'fileToken',
        fileUUID: 'fileToken',
      };
      for (const [field, value] of Object.entries(native)) {
        if (field === 'elementType') continue;
        if (field === childKey && value && typeof value === 'object') {
          for (const [name, source] of Object.entries(value)) {
            const mapped = aliases[name] ?? name;
            if (Object.hasOwn(data, mapped)) {
              if (
                (!extras.has(mapped) || output.type === 'structured') &&
                canonical(sourceValue(source)) === canonical(sourceValue(data[mapped]))
              )
                continue;
              context.attributes.push({
                target,
                name: `source.native.${field}.${name}`,
                value: nativeValue(source),
              });
            } else
              context.residuals.push({
                source: fragmentSourceId,
                path: `${sourceElementPath}/nativeElement/${field}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
                reason: 'unknown-field',
                value: nativeValue(source),
              });
          }
        } else if (['elementId', 'subType', 'isSender'].includes(field))
          context.attributes.push({
            target,
            name: `source.native.${field}`,
            value: nativeValue(value),
          });
        else
          context.residuals.push({
            source: fragmentSourceId,
            path: `${sourceElementPath}/nativeElement/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            reason: 'unknown-field',
            value: nativeValue(value),
          });
      }
    } else if (context.profile === 'full')
      for (const key of extras) {
        const value = data[key];
        if (value !== undefined)
          context.attributes.push({ target, name: `source.${key}`, value: nativeValue(value) });
      }
    return [output, ...additional];
  });
  return mapped.flat();
}

export async function exportArchiveConversation(
  msgs: MsgService,
  opts: JsonMetaExportOptions & {
    archive?: ArchiveOptions;
    guild?: { nodeId: string; guildId: string };
    transcripts?: Record<string, string>;
    ocr?: Record<string, string>;
    legacyJournal?: string;
    profiles?: ContactsExportDeps;
    onResource?: (resource: ResourceDirectoryEntry) => void;
    write?: boolean;
    onEntry?: (entry: ArchiveEntry) => Promise<void> | void;
  },
  deps: SenderResolveDeps = {},
): Promise<ExportResult> {
  const started = Date.now();
  const options = opts.archive ?? {};
  const profile = options.profile ?? 'basic';
  const policy = options.content ? normalizeExportContent(options.content) : undefined;
  const detail = (key: import('../../common/export_content').ExportContentDetailKey) =>
    !policy ||
    (policy.details?.[key] ?? (policy.messages === 'none' ? 'none' : 'local')) !== 'none';
  const includeBody = policy?.messages !== 'none';
  const includeRecords = includeBody || detail('messageProperties') || detail('protocol');
  const accountUin = options.accountUin ?? (await deps.self?.())?.uin;
  const header = archiveHeader({
    ...options,
    accountUin,
    formats: options.formats ?? [opts.format],
    selection: options.selection ?? {
      kind: opts.kind,
      conv: opts.conv,
      ...(opts.range ? { range: opts.range as unknown as Json } : {}),
    },
  });
  const account = object(header.scope).account ?? null;
  const observedAt = unixTime(options.observedAt ?? Date.now(), true)!;
  const kind = opts.guild ? 'guild-direct' : opts.kind;
  const conversation = {
    kind,
    id: opts.guild?.nodeId ?? opts.conv,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.guild?.guildId ? { guildId: opts.guild.guildId } : {}),
  };
  const senders =
    opts.kind === 'group'
      ? await resolveGroupSenders(msgs, opts.conv, opts.range, deps, '', opts.roam)
      : (await resolveC2cSenders(opts.conv, deps)).senders;
  let count = 0;
  const counted = new Set<string>();
  const participants = new Map<string, string>();
  const audit = new MessageAudit();
  type NativeSource = Awaited<ReturnType<MsgService['exportSourceRows']>>[number];
  async function* sources(): AsyncGenerator<{
    raw: RenderGroupMsg | RenderC2cMsg;
    legacy: boolean;
    native?: NativeSource;
  }> {
    if (opts.legacyJournal)
      for await (const raw of new MessageJournal(opts.legacyJournal).replay<
        RenderGroupMsg | RenderC2cMsg
      >())
        yield { raw, legacy: true };
    const pending: Array<RenderGroupMsg | RenderC2cMsg> = [];
    const emitted = new Set<string>();
    async function* flush(): AsyncGenerator<{
      raw: RenderGroupMsg | RenderC2cMsg;
      legacy: boolean;
      native?: NativeSource;
    }> {
      const batch = pending.splice(0);
      const includeCache = batch.some((row) =>
        row.elements.some((element) => element.type === 'multiMsg' || element.type === 'reply'),
      );
      const captured =
        includeRecords && !opts.guild && typeof msgs.exportSourceRows === 'function'
          ? await withDatabasePriority('background', () =>
              msgs.exportSourceRows(
                opts.kind,
                opts.conv,
                batch.map((row) => String(row.msgId)),
                profile === 'full' || includeCache,
              ),
            )
          : [];
      const byId = new Map<string, NativeSource[]>();
      for (const native of captured) {
        const id = String(native.columns['40001']);
        const rows = byId.get(id) ?? [];
        rows.push(native);
        byId.set(id, rows);
      }
      for (const initial of batch) {
        msgs.exportSignal?.throwIfAborted();
        const rows = byId.get(String(initial.msgId));
        if (!rows?.length) {
          yield { raw: initial, legacy: false };
          continue;
        }
        for (const native of rows) {
          const key = `${native.table}:${native.rowId}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          yield { raw: native.message, legacy: false, native };
        }
      }
    }
    for await (const raw of iterateConv(msgs, opts.kind, opts.conv, opts.range, opts.roam)) {
      pending.push(raw);
      if (pending.length >= 64) yield* flush();
    }
    if (pending.length) yield* flush();
  }
  async function* entries(): AsyncGenerator<ArchiveEntry> {
    for await (const { raw, legacy, native } of sources()) {
      const exported = toExportedMessage(raw);
      await expandForwards(
        msgs,
        opts.kind,
        exported,
        native && Object.hasOwn(native.columns, '40900')
          ? decodeMsgCacheColumn(native.columns['40900'])
          : undefined,
      );
      audit.observe(exported.elements);
      opts.collectSenders?.add(exported.senderUin);
      if (opts.collectFaces) collectFaceIds(exported.elements, opts.collectFaces);
      if (exported.senderUid) participants.set(exported.senderUid, exported.senderUin);
      if (policy && opts.onResource) {
        const collect = (elements: readonly RenderElement[], prefix = '') => {
          for (const [index, element] of elements.entries()) {
            const data = element.data as unknown as Record<string, unknown>;
            const category =
              element.type === 'pic'
                ? 'images'
                : element.type === 'ptt'
                  ? 'voice'
                  : element.type === 'video'
                    ? 'videos'
                    : element.type === 'file' || element.type === 'onlineFile'
                      ? 'files'
                      : element.type === 'face' || element.type === 'mface'
                        ? 'qqFaces'
                        : null;
            const propertyKey =
              category === 'images'
                ? 'imageProperties'
                : category === 'videos'
                  ? 'videoProperties'
                  : category === 'voice'
                    ? 'voiceProperties'
                    : category === 'files'
                      ? 'fileProperties'
                      : 'qqFaceProperties';
            if (
              category &&
              (policy[category] !== 'none' || policy.details?.[propertyKey] !== 'none')
            ) {
              const { fileName, nativeElement: _native, exportPath: _path, ...properties } = data;
              const name =
                typeof fileName === 'string' && fileName
                  ? fileName
                  : String(
                      data.faceText ?? data.faceId ?? data.marketEmoticonIdHex ?? element.type,
                    );
              opts.onResource!({
                sourceId: `${opts.conv}:${exported.msgId}:${prefix}${index}`,
                name,
                type:
                  element.type === 'pic'
                    ? 'photo'
                    : element.type === 'video'
                      ? 'video'
                      : category === 'qqFaces'
                        ? 'emoji'
                        : 'file',
                path:
                  policy[category] !== 'none' ? (mediaRelPath(element) ?? undefined) : undefined,
                attributes:
                  policy.details?.[propertyKey] === 'none'
                    ? undefined
                    : { ...properties, sourceMessageId: exported.msgId },
                status: 'not-requested',
              });
            }
            if (element.type === 'multiMsg')
              for (const [child, node] of (element.data.forwardMessages ?? []).entries())
                collect(node.elements, `${prefix}${index}/${child}/`);
            if (element.type === 'reply')
              collect(element.data.origElements, `${prefix}${index}/quote/`);
          }
        };
        collect(exported.elements);
      }
      if (!includeRecords) {
        count++;
        continue;
      }
      const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
      const identity: Json[] = [
        account,
        object(header.scope).partition ?? null,
        kind,
        conversation.id,
        exported.msgId,
      ];
      const resources: JsonObject[] = [],
        attributes: JsonObject[] = [],
        residuals: JsonObject[] = [];
      const sourceId = native
        ? stableId('source', [account, options.partition ?? null, native.table, native.rowId])
        : stableId('source', identity);
      const targets = new Map<number, number>(),
        fieldTargets = new Map<string, string>();
      const expansionSourceId = stableId('source', [...identity, 'expanded-content']);
      const hasExpanded = { value: false };
      const legacyRoot = legacy && opts.legacyJournal ? dirname(opts.legacyJournal) : undefined;
      const content = await archiveContent(exported.elements, {
        identity,
        profile,
        resources,
        attributes,
        residuals,
        sourceId,
        targets,
        fieldTargets,
        skipNativeRoot: Boolean(native),
        expansionSourceId,
        hasExpanded,
        observedAt,
        root: dirname(opts.outputPath),
        sourceRoot:
          legacyRoot && basename(legacyRoot).startsWith('.weq-export')
            ? dirname(legacyRoot)
            : legacyRoot,
        withMediaPaths: opts.withMediaPaths,
        transcripts: opts.transcripts,
        ocr: opts.ocr,
      });
      if (profile === 'full') {
        const consumed = new Set([
          'msgId',
          'msgSeq',
          'sendTime',
          'senderUin',
          'senderUid',
          'elements',
          'targetGroupCode',
          'targetUid',
        ]);
        const names: Record<string, string> = {
          msgRandom: 'msgRandom',
          msgType: 'msgType',
          subType: 'subMsgType',
          decoration: 'decoration',
          clientSeq: 'clientSeq',
          sendType: 'sendType',
          setEmojiList: 'reactions',
        };
        for (const [field, value] of Object.entries(raw))
          if (
            !consumed.has(field) &&
            value !== undefined &&
            (!native ||
              ![
                'targetUin',
                'msgRandom',
                'msgType',
                'subType',
                'decoration',
                'clientSeq',
                'sendType',
                'setEmojiList',
              ].includes(field))
          )
            attributes.push({
              target: '/data',
              name: names[field] ?? `source.${field}`,
              value: nativeValue(value),
            });
      }
      const entry = makeEntry(
        'message',
        identity,
        {
          conversation,
          messageId: exported.msgId,
          seq: exported.msgSeq,
          sentAt: unixTime(raw.sendTime),
          sender: opts.guild
            ? {
                identities: exported.senderUid
                  ? [{ namespace: 'guild-tiny', value: exported.senderUid }]
                  : [],
                ...(sender.sourceName === undefined ? {} : { name: sender.sourceName }),
              }
            : actor(exported.senderUin, exported.senderUid, sender.sourceName),
          content,
        },
        {
          profile,
          attributes,
          residuals,
          state: raw.deletedKind ? 'deleted' : 'present',
          coverage: { acquisition: 'unknown', parsing: 'partial' },
          observedAt,
          observationId: stableId('observation', [
            options.scanId ?? String(header.archiveId),
            stableId('message', identity),
          ]),
        },
      );
      if (native) {
        attachNativeMessageSource(
          entry,
          native,
          profile === 'full',
          sourceId,
          targets,
          fieldTargets,
        );
        if (profile === 'full') {
          (object(entry.record.native).attributes as JsonObject[]).push(...attributes);
          (object(entry.record.native).residuals as JsonObject[]).push(...residuals);
        }
        entry.record.revision = recordRevision(entry.record);
        entry.observation.revision = entry.record.revision;
        entry.observation.id = stableId('observation', [
          options.scanId ?? String(header.archiveId),
          entry.record.id,
          sourceId,
          entry.record.revision,
        ]);
      }
      if (hasExpanded.value)
        entry.additionalObservations = [
          {
            id: stableId('observation', [
              options.scanId ?? String(header.archiveId),
              expansionSourceId,
              entry.record.revision,
            ]),
            recordId: entry.record.id,
            revision: entry.record.revision,
            observedAt,
            profile,
            source: { id: expansionSourceId, kind: 'cache', locator: 'export-forward-expansion' },
          },
        ];
      if (legacy) {
        entry.record.identity = { status: 'source-local', nativeNamespace: 'qq-nt' };
        entry.record.revision = recordRevision(entry.record);
        entry.observation = {
          ...entry.observation,
          id: stableId('observation', [
            options.scanId ?? String(header.archiveId),
            entry.record.id,
            'legacy',
            entry.record.revision,
          ]),
          revision: entry.record.revision,
          observedAt: null,
          importedAt: observedAt,
          source: {
            id: stableId('source', [entry.record.id, 'legacy-journal']),
            kind: 'legacy-import',
            locator: 'legacy-message-journal',
            provenance: { file: 'messages.jsonl', row: exported.msgId },
          },
        };
        if (entry.record.native)
          for (const residual of object(entry.record.native).residuals as JsonObject[])
            if (residual.source === sourceId)
              residual.source = object(entry.observation.source).id!;
        entry.record.revision = recordRevision(entry.record);
        entry.observation.revision = entry.record.revision;
        for (const observation of entry.additionalObservations ?? []) {
          observation.revision = entry.record.revision;
          observation.id = stableId('observation', [
            options.scanId ?? String(header.archiveId),
            expansionSourceId,
            entry.record.revision,
          ]);
        }
      }
      if (policy) {
        if (!includeBody) {
          entry.record.data.content = [];
          entry.record.coverage = {
            ...entry.record.coverage,
            parsing: 'partial',
            issues: ['正文未选择导出'],
          };
        }
        const native = object(entry.record.native);
        const old = (native.attributes ?? []) as JsonObject[],
          kept: JsonObject[] = [],
          indices = new Map<number, number>();
        for (const [index, attribute] of old.entries()) {
          const target = String(attribute.target),
            match = /^\/data\/content\/(\d+)/.exec(target);
          let keep = detail('messageProperties');
          if (String(attribute.name).startsWith('source.cache.')) keep = detail('protocol');
          if (match) {
            const element = object((entry.record.data.content as JsonObject[])[Number(match[1])]);
            if (!includeBody) keep = false;
            else if (element.type === 'media') {
              const key =
                element.mediaType === 'image'
                  ? 'imageProperties'
                  : element.mediaType === 'audio'
                    ? 'voiceProperties'
                    : element.mediaType === 'video'
                      ? 'videoProperties'
                      : element.mediaType === 'sticker'
                        ? 'qqFaceProperties'
                        : 'fileProperties';
              keep = detail(key);
            }
          }
          if (keep) {
            indices.set(index, kept.length);
            kept.push(attribute);
          }
        }
        if (entry.record.native)
          entry.record.native = {
            ...native,
            attributes: kept,
            residuals: detail('protocol') ? (native.residuals ?? []) : [],
          };
        for (const observation of [entry.observation, ...(entry.additionalObservations ?? [])]) {
          if (!detail('protocol')) {
            delete observation.mappings;
            continue;
          }
          observation.mappings = ((observation.mappings ?? []) as JsonObject[]).flatMap(
            (mapping) => {
              const to = String(mapping.to),
                match = /^\/native\/attributes\/(\d+)(.*)$/.exec(to);
              if (match)
                return indices.has(Number(match[1]))
                  ? [
                      {
                        ...mapping,
                        to: `/native/attributes/${indices.get(Number(match[1]))}${match[2]}`,
                      },
                    ]
                  : [];
              return !includeBody && to.startsWith('/data/content') ? [] : [mapping];
            },
          );
        }
        entry.record.revision = recordRevision(entry.record);
        for (const observation of [entry.observation, ...(entry.additionalObservations ?? [])])
          observation.revision = entry.record.revision;
      }
      entry.resources = includeBody ? resources : [];
      await opts.onEntry?.(entry);
      yield entry;
      if (!counted.has(entry.record.id)) {
        counted.add(entry.record.id);
        count++;
      }
      if (count % (opts.progressEvery ?? 1000) === 0)
        opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
    }
    if (policy && policy.profiles !== 'none' && opts.profiles) {
      if (opts.kind === 'group' && opts.profiles.groupByCode) {
        const group = await opts.profiles.groupByCode(opts.conv);
        if (group) {
          if (group.groupCode !== opts.conv) throw new Error('资料来源返回了未选择的群。');
          const { groupCode, groupName, remark, ...properties } = group;
          const entry = makeEntry(
            'directory',
            [account, object(header.scope).partition ?? null, 'group', null, groupCode],
            {
              type: 'group',
              subject: { identities: [{ namespace: 'source', value: `group:${groupCode}` }] },
              name: groupName,
              remark,
            },
            {
              profile: 'full',
              observedAt,
              attributes: Object.entries(properties).map(([name, value]) => ({
                target: '/data',
                name: `source.${name}`,
                value: nativeValue(value),
              })),
            },
          );
          entry.observation.id = stableId('observation', [
            options.scanId ?? String(header.archiveId),
            groupCode,
            entry.record.revision,
            'group-profile',
          ]);
          await opts.onEntry?.(entry);
          yield entry;
        }
      }
      const uids = [...participants.keys()];
      for (let offset = 0; offset < uids.length; offset += 500)
        for (const source of await opts.profiles.profilesByUids(uids.slice(offset, offset + 500))) {
          const { uid, nick, remark, ...properties } = source;
          if (!uids.slice(offset, offset + 500).includes(uid))
            throw new Error('资料来源返回了未选择的 UID。');
          const entry = makeEntry(
            'directory',
            [account, object(header.scope).partition ?? null, 'contact', null, uid],
            { type: 'contact', subject: actor(participants.get(uid), uid), name: nick, remark },
            {
              profile: 'full',
              observedAt,
              attributes: Object.entries(properties)
                .filter(([, value]) => value !== undefined)
                .map(([name, value]) => ({
                  target: '/data',
                  name: `source.${name}`,
                  value: nativeValue(value),
                })),
            },
          );
          entry.observation.id = stableId('observation', [
            options.scanId ?? String(header.archiveId),
            uid,
            entry.record.revision,
            'profile',
          ]);
          await opts.onEntry?.(entry);
          yield entry;
        }
    }
  }
  if (opts.write === false) {
    for await (const _entry of entries()) {
      /* 只采集所选资源或交给派生视图，不落正文文件。 */
    }
  } else
    await writeArchiveEntries(opts.outputPath, opts.format, header, entries(), {
      retainInterrupted: true,
    });
  return {
    coverage: audit.coverage,
    filePath: opts.outputPath,
    format: opts.format,
    messageCount: count,
    fileSize: opts.write === false ? 0 : (await stat(opts.outputPath)).size,
    durationMs: Date.now() - started,
  };
}
