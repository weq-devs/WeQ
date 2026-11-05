import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { JSONParser, TokenType } from '@streamparser/json';
import {
  ArchiveGraph,
  canonical,
  checkArchiveShape,
  object,
  parseArchiveJson,
  recordRevision,
  sha256,
  verifyNative,
  type ArchiveHeader,
  type ArchiveRecord,
  type Json,
  type JsonObject,
} from './archive';

export type ArchiveEvent =
  | { type: 'revision'; value: ArchiveRecord }
  | { type: 'observation' | 'resource' | 'commit'; value: JsonObject };
export class NotFormalArchiveError extends Error {}
type Section = { section: string; key?: string; value: Json };
/** 使用标准增量解析器；每轮只保留一个输入块及其已完成对象。 */
async function* jsonSections(path: string, signal?: AbortSignal): AsyncGenerator<Section> {
  const pending: Section[] = [];
  const parser = new JSONParser({
    paths: ['$.*', '$.records.*', '$.observations.*', '$.resources.*'],
    keepStack: false,
    stringBufferSize: 65536,
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const keys: Array<Set<string> | null> = [];
  let previous: { token: TokenType; value: Json } | undefined;
  parser.onToken = ({ token, value }) => {
    if (token === TokenType.LEFT_BRACE) keys.push(new Set());
    else if (token === TokenType.LEFT_BRACKET) keys.push(null);
    else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) keys.pop();
    else if (token === TokenType.COLON) {
      assert(previous?.token === TokenType.STRING, '无效 JSON 对象键');
      const current = keys.at(-1),
        key = String(previous.value);
      assert(current && !current.has(key), '重复 JSON 键');
      current.add(key);
    } else if (token === TokenType.NUMBER) canonical(value);
    previous = { token, value };
  };
  parser.onValue = ({ value, key, stack }) => {
    if (stack.length === 1)
      pending.push({ section: 'header', key: String(key), value: value as Json });
    else if (stack.length === 2)
      pending.push({ section: String(stack[1]?.key), value: value as Json });
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 65536, signal })) {
    parser.write(decoder.decode(chunk, { stream: true }));
    yield* pending.splice(0);
  }
  const remaining = decoder.decode();
  if (remaining) parser.write(remaining);
  if (!parser.isEnded) parser.end();
  yield* pending.splice(0);
}
function verifyHeader(header: JsonObject): ArchiveHeader {
  assert(header.format === 'weq-export', '不是 WeQ 正式归档');
  assert(
    typeof header.version === 'string' && /^1\.(?:0|[1-9][0-9]*)$/.test(header.version),
    '不支持的导出格式版本',
  );
  checkArchiveShape(
    'archive.schema.json',
    { ...header, records: [], observations: [], resources: [] },
    true,
  );
  const account = object(object(header.scope).account);
  assert(
    (account.identities as Json[]).length || object(header.scope).partition,
    '未知账号缺少独立分区',
  );
  if (object(header.incremental).enabled)
    assert(
      (header.formats as Json[]).includes(object(header.incremental).authority!),
      'authority 未选中',
    );
  return header as ArchiveHeader;
}
export async function* archiveLines(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ value: JsonObject; end: number; error?: unknown }> {
  let buffer = Buffer.alloc(0),
    offset = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let newline = buffer.indexOf(10);
    while (newline >= 0) {
      assert(newline <= 8 * 1024 * 1024, '归档单行超过 8 MiB');
      const line = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline));
      offset += newline + 1;
      let value: JsonObject = {},
        error: unknown;
      try {
        value = object(parseArchiveJson(line));
      } catch (cause) {
        error = cause;
      }
      yield { value, end: offset, ...(error ? { error } : {}) };
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(10);
    }
    assert(buffer.length <= 8 * 1024 * 1024, '归档单行超过 8 MiB');
  }
  // 未换行尾段由扫描结果报告，不交给正式读取器。
}
export async function readArchiveHeader(
  path: string,
  format: 'json' | 'jsonl',
  signal?: AbortSignal,
): Promise<ArchiveHeader> {
  if (format === 'jsonl') {
    for await (const { value, error } of archiveLines(path, signal)) {
      if (error) throw error;
      assert(
        value.type === 'header' &&
          Object.keys(value).length === 2 &&
          Object.hasOwn(value, 'header'),
        'JSONL 缺少正式 header',
      );
      checkArchiveShape('stream.schema.json', value, true);
      for (const field of ['records', 'observations', 'resources'])
        assert(!Object.hasOwn(object(value.header), field), 'JSONL header 不得包含正文集合');
      return verifyHeader(object(value.header));
    }
    throw new Error('JSONL 缺少首行 header');
  }
  const header: JsonObject = {},
    arrays = new Set<string>();
  for await (const entry of jsonSections(path, signal))
    if (entry.section === 'header') {
      if (['records', 'observations', 'resources'].includes(entry.key!)) {
        assert(Array.isArray(entry.value), '归档集合不是数组');
        arrays.add(entry.key!);
      } else header[entry.key!] = entry.value;
    }
  if (header.format !== 'weq-export') throw new NotFormalArchiveError('不是 WeQ 正式归档');
  assert(arrays.size === 3, '归档缺少正式集合');
  return verifyHeader(header);
}
export interface StreamState {
  uncommittedTail: boolean;
  committedBytes: number;
  sequence: string;
  previous: string | null;
}
export async function* streamArchiveEvents(
  path: string,
  format: 'json' | 'jsonl',
  state: StreamState,
  signal?: AbortSignal,
): AsyncGenerator<ArchiveEvent> {
  if (format === 'json') {
    for await (const entry of jsonSections(path, signal)) {
      if (entry.section === 'records')
        yield { type: 'revision', value: entry.value as ArchiveRecord };
      else if (entry.section === 'observations')
        yield { type: 'observation', value: object(entry.value) };
      else if (entry.section === 'resources')
        yield { type: 'resource', value: object(entry.value) };
    }
    return;
  }
  let first = true,
    batchId: string | null = null,
    sequence = 1n,
    previous: string | null = null;
  let pending: ArchiveEvent[] = [],
    pendingBytes = 0,
    digest = createHash('sha256');
  const batches = new Set<string>();
  let pendingError: unknown;
  for await (const { value, end, error } of archiveLines(path, signal)) {
    if (first) {
      first = false;
      if (error) throw error;
      assert(value.type === 'header', 'JSONL 缺少首行 header');
      continue;
    }
    if (error) {
      pendingError ??= error;
      continue;
    }
    if (value.type === 'commit' && pendingError) throw pendingError;
    if (pendingError) continue;
    try {
      checkArchiveShape('stream.schema.json', value, true);
      assert(value.type !== 'header', '重复 header');
      const fields =
        value.type === 'commit'
          ? ['type', 'batchId', 'sequence', 'entries', 'sha256', 'previous']
          : value.type === 'revision'
            ? ['type', 'batchId', 'record']
            : ['type', 'batchId', String(value.type)];
      assert(
        Object.keys(value).every((key) => fields.includes(key)),
        'JSONL 外壳包含未知字段',
      );
      if (value.type !== 'commit') {
        assert(batchId === null || batchId === value.batchId, 'JSONL 批次交错');
        batchId = String(value.batchId);
        const canonicalLine = `${canonical(value)}\n`;
        pendingBytes += Buffer.byteLength(canonicalLine);
        assert(pendingBytes <= 64 * 1024 * 1024, 'JSONL 单批次超过 64 MiB');
        digest.update(canonicalLine);
        pending.push(
          value.type === 'revision'
            ? { type: 'revision', value: value.record as ArchiveRecord }
            : {
                type: value.type as 'observation' | 'resource',
                value: object(value[String(value.type)]),
              },
        );
        continue;
      }
    } catch (error) {
      if (value.type === 'commit') throw error;
      pendingError = error;
      continue;
    }
    assert(!batches.has(String(value.batchId)), '重复 batchId');
    assert(sequence === 1n || pending.length, '重复空批次');
    assert(batchId === null || batchId === value.batchId, 'JSONL 批次不符');
    assert(value.sequence === String(sequence) && value.previous === previous, 'JSONL 提交链不符');
    assert(
      value.entries === pending.length && value.sha256 === digest.digest('hex'),
      'JSONL 批次摘要或计数不符',
    );
    yield* pending;
    yield { type: 'commit', value };
    state.committedBytes = end;
    state.sequence = String(sequence);
    state.previous = sha256(canonical(value));
    batches.add(String(value.batchId));
    previous = state.previous;
    sequence++;
    batchId = null;
    pending = [];
    pendingBytes = 0;
    digest = createHash('sha256');
  }
  assert(sequence > 1n, 'JSONL 没有已提交初始批次');
  const { stat } = await import('node:fs/promises');
  state.uncommittedTail = (await stat(path)).size > state.committedBytes;
}

export interface ArchiveScan {
  graph: ArchiveGraph;
  revisions: Set<string>;
  resourceReceipts: Set<string>;
  messageIds: Set<string>;
  header: ArchiveHeader;
  state: StreamState;
  latest: Map<string, { revision: string; time: bigint | null }>;
  resources: Map<string, JsonObject>;
  observations: Map<string, JsonObject[]>;
  observationOrder: Map<string, number>;
  messageCount: number;
  conversations: Map<string, JsonObject>;
}
export async function scanArchiveFile(
  path: string,
  format: 'json' | 'jsonl',
  signal?: AbortSignal,
): Promise<ArchiveScan> {
  const header = await readArchiveHeader(path, format, signal);
  const state: StreamState = {
    uncommittedTail: false,
    committedBytes: 0,
    sequence: '0',
    previous: null,
  };
  const graph = new ArchiveGraph(header.externalReferences);
  const messageIds = new Set<string>();
  let deferredNativeChecks = false;
  const revisions = new Set<string>(),
    observed = new Set<string>(),
    observationIds = new Set<string>(),
    receipts = new Set<string>();
  const latest: ArchiveScan['latest'] = new Map(),
    resources: ArchiveScan['resources'] = new Map();
  const conversations: ArchiveScan['conversations'] = new Map();
  const nativeObservations = new Map<string, JsonObject[]>();
  const observationOrder = new Map<string, number>();
  const missingRecords = new Set<string>(),
    missingObservations = new Set<string>();
  const verifyReferences = () => {
    assert(!missingRecords.size, '悬空来源观察');
    assert(!missingObservations.size, '正文缺少来源观察');
    graph.finish();
  };
  for await (const event of streamArchiveEvents(path, format, state, signal)) {
    const value = event.value;
    if (event.type === 'commit') {
      verifyReferences();
      continue;
    }
    if (event.type === 'revision') {
      const record = value as ArchiveRecord,
        key = `${record.id}\0${record.revision}`;
      checkArchiveShape(`${record.kind}.schema.json`, record, true);
      assert(record.revision === recordRevision(record), '正文摘要不符');
      assert(!revisions.has(key), '重复正文版本');
      revisions.add(key);
      graph.record(record);
      if (
        Array.isArray(object(record.native).residuals) &&
        (object(record.native).residuals as Json[]).length
      )
        deferredNativeChecks = true;
      else verifyNative(record, []);
      if (record.kind === 'message') {
        messageIds.add(record.id);
        const conversation = object(record.data.conversation);
        conversations.set(`${conversation.kind}:${conversation.id}`, conversation);
      }
      missingRecords.delete(key);
      if (!observed.has(key)) missingObservations.add(key);
    } else if (event.type === 'observation') {
      checkArchiveShape('common.schema.json#/$defs/observation', value, true);
      const key = `${value.recordId}\0${value.revision}`;
      observed.add(key);
      missingObservations.delete(key);
      if (!revisions.has(key)) missingRecords.add(key);
      assert(!observationIds.has(String(value.id)), '重复来源观察');
      observationIds.add(String(value.id));
      observationOrder.set(String(value.id), observationOrder.size);
      const items = nativeObservations.get(key) ?? [];
      items.push(value);
      if (Array.isArray(value.mappings) && value.mappings.length) deferredNativeChecks = true;
      nativeObservations.set(key, items);
      const seconds = object(value.observedAt).unixSeconds;
      let time: bigint | null = null;
      if (typeof seconds === 'string') {
        const negative = seconds.startsWith('-'),
          [whole, fraction = ''] = (negative ? seconds.slice(1) : seconds).split('.');
        time =
          (BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0'))) * (negative ? -1n : 1n);
      }
      const previous = latest.get(String(value.recordId));
      if (
        !previous ||
        (time !== null && (previous.time === null || time >= previous.time)) ||
        (time === null && previous.time === null)
      )
        latest.set(String(value.recordId), { revision: String(value.revision), time });
    } else {
      checkArchiveShape('archive.schema.json#/$defs/resource', value, true);
      const key = canonical(value);
      assert(!receipts.has(key), '重复资源回执');
      receipts.add(key);
      graph.resource(value);
      if (value.status === 'saved' || !resources.has(String(value.id)))
        resources.set(String(value.id), value);
    }
  }
  verifyReferences();
  // 再流读正文核对附加属性/残余与来源映射，不缓存所有正文。
  if (deferredNativeChecks)
    for await (const event of streamArchiveEvents(path, format, { ...state }, signal))
      if (event.type === 'revision')
        verifyNative(
          event.value,
          nativeObservations.get(`${event.value.id}\0${event.value.revision}`) ?? [],
        );
  return {
    graph,
    revisions,
    resourceReceipts: receipts,
    messageIds,
    header,
    state,
    latest,
    resources,
    observations: nativeObservations,
    observationOrder,
    messageCount: messageIds.size,
    conversations,
  };
}
