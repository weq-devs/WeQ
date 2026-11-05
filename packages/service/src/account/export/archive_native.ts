import { ProtoMsg, raw, ScalarType, type ProtoMessageType } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { MsgEmoji } from '@weq/codec/proto/msg/40062';
import { MsgDressBody } from '@weq/codec/proto/msg/40801';
import { MsgCacheBody } from '@weq/codec/proto/msg/40900';
import {
  canonical,
  actor,
  object,
  pointer,
  typedValue,
  type ArchiveEntry,
  type Json,
  type JsonObject,
} from './archive';
import { nativeValue, sourceValue, unixTime } from './archive_value';

export interface NativeCell {
  path: string;
  semantic: Array<string | number>;
  value: unknown;
}
interface Extraction {
  tree: Record<string, unknown>;
  cells: NativeCell[];
  residuals: JsonObject[];
}
const indexes = new WeakMap<ProtoMessageType, raw.SchemaIndex>();
function indexFor(schema: ProtoMessageType) {
  let index = indexes.get(schema);
  if (!index) {
    index = new raw.SchemaIndex(schema, 'export');
    indexes.set(schema, index);
  }
  return index;
}

/** 逐字段复用现有 wire/schema 解码；不经 sanitizer，未知字节和损坏尾部各归其位。 */
export function extractNativeProto(
  bytes: Uint8Array,
  schema: ProtoMessageType,
  source: string,
  root: string,
): Extraction {
  const cells: NativeCell[] = [],
    residuals: JsonObject[] = [];
  const keep = (
    data: Uint8Array,
    path: string,
    offset: number,
    reason: string,
    wireType?: number,
  ) =>
    residuals.push({
      source,
      path,
      reason,
      value: typedValue(data),
      offset: String(offset),
      length: String(data.length),
      ...(wireType === undefined ? {} : { wireType }),
    });
  const walk = (
    data: Uint8Array,
    definition: ProtoMessageType,
    path: string,
    semantic: Array<string | number>,
    base: number,
    depth: number,
  ): Record<string, unknown> => {
    if (depth > 64) {
      keep(data, path, base, 'opaque-content');
      return {};
    }
    const tree: Record<string, unknown> = {},
      occurrence = new Map<number, number>(),
      repeat = new Map<number, number>();
    let offset = 0;
    while (offset < data.length) {
      let field: raw.WireField;
      try {
        const next = raw.readField(data, offset);
        if (!next) break;
        field = next;
      } catch {
        keep(data.subarray(offset), `${path}/tail`, base + offset, 'unconsumed-tail');
        break;
      }
      offset = field.start + field.size;
      const count = occurrence.get(field.tag) ?? 0;
      occurrence.set(field.tag, count + 1);
      const fieldPath = `${path}/${field.tag}/${count}`,
        info = indexFor(definition).byTag.get(field.tag);
      const encoded = data.subarray(field.start, field.start + field.size);
      if (!info) {
        keep(encoded, fieldPath, base + field.start, 'unknown-field', field.wireType);
        continue;
      }
      if (!raw.wireMatches(info, field.wireType)) {
        keep(encoded, fieldPath, base + field.start, 'wire-type-mismatch', field.wireType);
        continue;
      }
      const arrayIndex = repeat.get(field.tag) ?? 0;
      const target = [...semantic, info.name, ...(info.repeat ? [arrayIndex] : [])];
      let value: unknown;
      if (info.kind === 'message' && info.messageRef) {
        value = walk(
          field.payload,
          info.messageRef(),
          fieldPath,
          target,
          base + field.start + field.size - field.payload.length,
          depth + 1,
        );
      } else {
        try {
          const codec = new ProtoMsg(definition);
          const decoded = codec.decode(encoded) as Record<string, unknown>;
          value = decoded[info.name];
          if (info.repeat) value = (value as unknown[])[0];
          // 打包的数值数组以一个已知结构值保留；不假装它是一个标量。
          if (
            info.repeat &&
            field.wireType === 2 &&
            ![ScalarType.STRING, ScalarType.BYTES].includes(info.scalarType!)
          )
            value = decoded[info.name];
          const comparable = codec.encode({
            [info.name]: info.repeat && !Array.isArray(value) ? [value] : value,
          });
          const roundtrip = [...raw.iterFields(comparable)].find((item) => item.tag === field.tag);
          if (!roundtrip) throw new Error('字段不能无损规范化');
          if (field.wireType === 0 && roundtrip.wireType === 0) {
            if (
              raw.readVarint(field.payload, 0).value !== raw.readVarint(roundtrip.payload, 0).value
            )
              throw new Error('字段数值被截断');
          } else if (
            field.wireType === roundtrip.wireType &&
            !Buffer.from(field.payload).equals(Buffer.from(roundtrip.payload))
          )
            throw new Error('字段不能无损规范化');
          sourceValue(value);
          cells.push({ path: fieldPath, semantic: target, value });
        } catch {
          keep(encoded, fieldPath, base + field.start, 'decode-failed', field.wireType);
          continue;
        }
      }
      if (info.repeat) {
        const values = Array.isArray(tree[info.name]) ? (tree[info.name] as unknown[]) : [];
        if (
          Array.isArray(value) &&
          info.kind === 'scalar' &&
          field.wireType === 2 &&
          ![ScalarType.STRING, ScalarType.BYTES].includes(info.scalarType!)
        )
          values.push(...value);
        else values.push(value);
        tree[info.name] = values;
        repeat.set(field.tag, values.length);
      } else
        tree[info.name] =
          info.kind === 'message' && tree[info.name] && typeof tree[info.name] === 'object'
            ? { ...(tree[info.name] as object), ...(value as object) }
            : value;
    }
    return tree;
  };
  const tree = walk(bytes, schema, root, [], 0, 0);
  if (!bytes.length) keep(bytes, root, 0, 'opaque-content');
  return { tree, cells, residuals };
}

function equivalent(value: unknown, target: Json | undefined): string | null {
  if (target === undefined) return null;
  if (canonical(sourceValue(value)) === canonical(target)) return 'identity-v1';
  if (typeof value === 'bigint' && typeof target === 'string' && value.toString() === target)
    return 'integer-string-v1';
  if (
    value instanceof Uint8Array &&
    typeof target === 'string' &&
    Buffer.from(value).toString('hex') === target.toLowerCase()
  )
    return 'bytes-hex-v1';
  return null;
}
export function attachNativeMessageSource(
  entry: ArchiveEntry,
  source: {
    table: string;
    rowId: string;
    columns: Record<string, unknown>;
    quoteCacheOffsets?: Record<number, number>;
  },
  full: boolean,
  sourceId: string,
  targets: ReadonlyMap<number, number> = new Map(),
  fieldTargets: ReadonlyMap<string, string> = new Map(),
): void {
  entry.observation.source = {
    id: sourceId,
    kind: 'database',
    locator: `nt-message/${source.table}`,
    provenance: { table: source.table, row: source.rowId },
  };
  const attributes: JsonObject[] = [],
    residuals: JsonObject[] = [],
    mappings: JsonObject[] = [];
  const conversationKind = object(entry.record.data.conversation).kind;
  const partition =
    conversationKind === 'group' || conversationKind === 'guild-direct'
      ? '40027'
      : conversationKind === 'service'
        ? '40035'
        : '40021';
  const fields: Record<string, string> = {
    '40001': '/data/messageId',
    '40003': '/data/seq',
    '40020': '/data/sender',
    '40033': '/data/sender',
    '40050': '/data/sentAt',
    [partition]: '/data/conversation',
  };
  const names: Record<string, string> = {
    '40002': 'msgRandom',
    '40005': 'clientSeq',
    '40010': 'chatType',
    '40011': 'msgType',
    '40012': 'subMsgType',
    '40013': 'sendType',
    '40041': 'sendStatus',
    '40030': 'source.targetUin',
    '40035': 'source.appId',
    '40040': 'source.sentSource',
    '40058': 'source.dayTimestamp',
  };
  const attributeCounts = new Map<string, number>();
  const preserve = (cell: NativeCell, target: string, prefix: string) => {
    const baseName = `${prefix}.${cell.semantic.map(String).join('.')}`,
      key = `${target}\0${baseName}`;
    const duplicate = attributeCounts.get(key) ?? 0;
    attributeCounts.set(key, duplicate + 1);
    attributes.push({
      target,
      name: `${baseName}${duplicate ? `@${duplicate}` : ''}`,
      value: nativeValue(cell.value),
    });
    mappings.push({
      from: cell.path,
      to: `/native/attributes/${attributes.length - 1}/value`,
      transform: 'protobuf-value-v1',
    });
  };
  const lookup = (
    root: Json,
    path: string,
    tokens: Array<string | number>,
  ): { target: Json; path: string } | null => {
    let value = root,
      location = path;
    for (const token of tokens) {
      const field = String(token),
        current = object(value);
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, field)) {
        value = (value as JsonObject)[field]!;
        location += `/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      } else if (Object.hasOwn(object(current.data), field)) {
        value = object(current.data)[field]!;
        location += `/data/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      } else return null;
    }
    return { target: value, path: location };
  };
  for (const [column, value] of Object.entries(source.columns)) {
    if (fields[column]) {
      if (column === '40003' && value === null) entry.record.data.seq = null;
      if (column === '40050' && value === null) entry.record.data.sentAt = null;
      if ((column === '40020' || column === '40033') && !String(value ?? '').replace(/^0$/, ''))
        residuals.push({
          source: sourceId,
          path: `/${column}`,
          reason: 'opaque-content',
          value: nativeValue(value),
        });
      else
        mappings.push({
          from: `/${column}`,
          to: fields[column]!,
          transform: column === '40050' ? 'unix-seconds-v1' : 'nt-message-identity-v1',
        });
      continue;
    }
    if (column === '40800' && value instanceof Uint8Array) {
      const extracted = extractNativeProto(value, MsgBody, sourceId, '/40800');
      residuals.push(...extracted.residuals);
      const sourceElements = Array.isArray(extracted.tree.elements) ? extracted.tree.elements : [];
      const content = entry.record.data.content as JsonObject[];
      for (const [sourceIndex, sourceElement] of sourceElements.entries()) {
        const index = targets.get(sourceIndex) ?? sourceIndex;
        if (
          content[index]?.type === 'text' &&
          !Object.hasOwn(sourceElement as object, 'textContent')
        )
          content[index] = {
            type: 'unknown',
            sourceType: String((sourceElement as Record<string, unknown>).elementType ?? 'unknown'),
            reason: '原始文本字段未取得或解码失败',
          };
      }
      for (const cell of extracted.cells) {
        const sourceIndex = cell.semantic[1];
        const index =
          typeof sourceIndex === 'number' ? (targets.get(sourceIndex) ?? sourceIndex) : sourceIndex;
        const elements = entry.record.data.content as JsonObject[];
        const element = typeof index === 'number' ? elements[index] : undefined;
        if (!element) {
          residuals.push({
            source: sourceId,
            path: cell.path,
            reason: 'opaque-content',
            value: nativeValue(cell.value),
          });
          continue;
        }
        const field = cell.semantic[2];
        let to: string | undefined, target: Json | undefined;
        const explicit = fieldTargets.get(`${sourceIndex}:${String(field)}`);
        if (explicit) {
          to = explicit;
          target = pointer(entry.record, explicit);
        } else if (field === 'elementType') {
          to = `/data/content/${index}`;
          target = undefined;
        } else if (element.type === 'text' && field === 'textContent') {
          to = `/data/content/${index}/text`;
          target = element.text;
        } else if (
          element.type === 'mention' &&
          ['textContent', 'atTargetUid'].includes(String(field))
        )
          to = `/data/content/${index}/actor`;
        else if (element.type === 'media' && ['fileName', 'originalUrl'].includes(String(field)))
          to = `/data/content/${index}/resourceIds`;
        else if (
          element.type === 'media' &&
          ['pttDuration', 'videoDuration'].includes(String(field)) &&
          element.durationSeconds !== undefined
        ) {
          to = `/data/content/${index}/durationSeconds`;
          target = element.durationSeconds;
        } else if (element.type === 'structured' && object(element.value).type === 'json') {
          const found = lookup(
            object(element.value).value!,
            `/data/content/${index}/value/value`,
            cell.semantic.slice(2),
          );
          if (found) {
            target = found.target;
            to = found.path;
          }
        }
        const transform =
          target === undefined && to ? 'nt-element-semantic-v1' : equivalent(cell.value, target);
        if (to && transform) mappings.push({ from: cell.path, to, transform });
        else {
          preserve(cell, `/data/content/${index}`, 'element');
        }
      }
    } else if (column === '40900' && value instanceof Uint8Array) {
      const extracted = extractNativeProto(value, MsgCacheBody, sourceId, '/40900');
      residuals.push(...extracted.residuals);
      const content = entry.record.data.content as JsonObject[];
      const forwardIndex = content.findIndex(
        (element) =>
          element.type === 'forward' && Array.isArray(element.records) && element.records.length,
      );
      const nodes = forwardIndex < 0 ? [] : (content[forwardIndex]!.records as JsonObject[]);
      const caches = Array.isArray(extracted.tree.msgs)
        ? (extracted.tree.msgs as Record<string, unknown>[])
        : [];
      // 本地缓存只在单一转发目标下归属到节点；关联不确定的字段仍保留为附加来源值。
      const sourceCards = content.filter((element) => element.type === 'forward');
      const canMapForward = nodes.length === caches.length && sourceCards.length === 1;
      if (canMapForward)
        for (const [index, cache] of caches.entries()) {
          nodes[index]!.sender = actor(
            cache.senderUin === undefined ? undefined : String(cache.senderUin),
            cache.senderUid === undefined ? undefined : String(cache.senderUid),
            typeof cache.sendNick === 'string' ? cache.sendNick : undefined,
          );
          nodes[index]!.sentAt =
            cache.sendTime === undefined ? null : unixTime(String(cache.sendTime));
          nodes[index]!.seq = cache.msgSeq === undefined ? null : String(cache.msgSeq);
        }
      for (const cell of extracted.cells) {
        let to: string | undefined, target: Json | undefined;
        const cacheIndex = cell.semantic[1],
          field = cell.semantic[2];
        if (
          canMapForward &&
          typeof cacheIndex === 'number' &&
          nodes[cacheIndex] &&
          !['elements', 'subMsgs'].includes(String(field))
        ) {
          const base = `/data/content/${forwardIndex}/records/${cacheIndex}`;
          if (['senderUin', 'senderUid', 'sendNick'].includes(String(field))) to = `${base}/sender`;
          else if (field === 'sendTime') to = `${base}/sentAt`;
          else if (field === 'msgSeq') to = `${base}/seq`;
        }
        if (
          canMapForward &&
          typeof cacheIndex === 'number' &&
          nodes[cacheIndex] &&
          field === 'elements' &&
          typeof cell.semantic[3] === 'number'
        ) {
          const elements = nodes[cacheIndex]!.content as JsonObject[];
          const index = cell.semantic[3];
          const candidates = elements
            .map((element, index) => ({ element, index }))
            .filter((item) => item.element.kind !== 'qq.forward-card');
          const element = candidates[index];
          if (element?.element.type === 'text' && cell.semantic[4] === 'textContent') {
            to = `/data/content/${forwardIndex}/records/${cacheIndex}/content/${element.index}/text`;
            target = element.element.text;
          } else if (
            element?.element.type === 'structured' &&
            object(element.element.value).type === 'json'
          ) {
            const found = lookup(
              object(element.element.value).value!,
              `/data/content/${forwardIndex}/records/${cacheIndex}/content/${element.index}/value/value`,
              cell.semantic.slice(4),
            );
            if (found) {
              to = found.path;
              target = found.target;
            }
          }
        }
        if (!canMapForward && caches.length === 1 && cacheIndex === 0)
          for (const [sourceIndex, offset] of Object.entries(source.quoteCacheOffsets ?? {})) {
            const index = targets.get(Number(sourceIndex)) ?? Number(sourceIndex),
              reply = content[index];
            if (reply?.type !== 'structured' || reply.kind !== 'qq.reply') continue;
            const root = object(reply.value).value!;
            if (field === 'elements' && typeof cell.semantic[3] === 'number') {
              const found = lookup(root, `/data/content/${index}/value/value`, [
                'origElements',
                offset + cell.semantic[3],
                ...cell.semantic.slice(4),
              ]);
              if (found) {
                to = found.path;
                target = found.target;
              }
            } else {
              const found = lookup(root, `/data/content/${index}/value/value`, [
                'exportQuoteCache',
                String(field),
              ]);
              if (found) {
                to = found.path;
                target = found.target;
              }
            }
          }
        const transform =
          to && target === undefined ? 'cache-message-semantic-v1' : equivalent(cell.value, target);
        if (to && transform) mappings.push({ from: cell.path, to, transform });
        else preserve(cell, '/data', 'source.cache');
      }
    } else if ((column === '40062' || column === '40801') && value instanceof Uint8Array) {
      const extracted = extractNativeProto(
        value,
        column === '40062' ? MsgEmoji : MsgDressBody,
        sourceId,
        `/${column}`,
      );
      const name = column === '40062' ? 'reactions' : 'decoration';
      if (Object.keys(extracted.tree).length) {
        attributes.push({ target: '/data', name, value: typedValue(sourceValue(extracted.tree)) });
        for (const cell of extracted.cells)
          mappings.push({
            from: cell.path,
            to: `/native/attributes/${attributes.length - 1}/value`,
            transform: 'protobuf-tree-v1',
          });
      }
      residuals.push(...extracted.residuals);
    } else if (names[column]) {
      if (
        !names[column]!.startsWith('source.') &&
        typeof value !== 'bigint' &&
        !(typeof value === 'number' && Number.isSafeInteger(value))
      ) {
        residuals.push({
          source: sourceId,
          path: `/${column}`,
          reason: 'decode-failed',
          value: nativeValue(value),
        });
        continue;
      }
      attributes.push({ target: '/data', name: names[column]!, value: nativeValue(value) });
      mappings.push({
        from: `/${column}`,
        to: `/native/attributes/${attributes.length - 1}/value`,
        transform: 'sql-value-v1',
      });
    } else
      residuals.push({
        source: sourceId,
        path: `/${column.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        reason: 'unknown-field',
        value: nativeValue(value),
      });
  }
  if (full) {
    entry.record.native = { attributes, residuals };
    if (mappings.length) entry.observation.mappings = mappings;
  }
}
