/** 正式归档协议。业务读写与离线 schema 共用定义，不依赖规范测试工具。 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020';
import { syncArchiveDirectory } from './archive_resource';
import { bufferedFileWriter } from './stream_utils';
import {
  compressedArchiveWriter,
  compressedArchiveBlocks,
  compressArchiveBlock,
  type ArchiveFormat,
} from './archive_compression';
import addFormats from 'ajv-formats';
import archiveSchema from '../../../../../schemas/export/v1/archive.schema.json';
import commonSchema from '../../../../../schemas/export/v1/common.schema.json';
import messageSchema from '../../../../../schemas/export/v1/message.schema.json';
import qzoneSchema from '../../../../../schemas/export/v1/qzone.schema.json';
import collectionSchema from '../../../../../schemas/export/v1/collection.schema.json';
import mailSchema from '../../../../../schemas/export/v1/mail.schema.json';
import directorySchema from '../../../../../schemas/export/v1/directory.schema.json';
import generatedSchema from '../../../../../schemas/export/v1/generated.schema.json';
import resourceSchema from '../../../../../schemas/export/v1/resource-directory.schema.json';
import legacySchema from '../../../../../schemas/export/v1/legacy.schema.json';
import streamSchema from '../../../../../schemas/export/v1/stream.schema.json';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type ExportProfile = 'basic' | 'full';
export interface ArchiveOptions {
  extra?: import('../../common/export_content').ExportExtraOptions;
  content?: import('../../common/export_content').ExportContentPolicy;
  scanId?: string;
  observedAt?: number;
  profile?: ExportProfile;
  incrementalSupport?: boolean;
  accountUin?: string;
  partition?: string;
  archiveId?: string;
  formats?: ArchiveFormat[];
  selection?: Json;
}
export type ArchiveHeader = Pick<
  Archive,
  'format' | 'version' | 'profile' | 'archiveId' | 'scope' | 'formats' | 'incremental'
> &
  JsonObject;
export interface ArchiveRecord extends JsonObject {
  id: string;
  kind:
    | 'message'
    | 'qzone'
    | 'collection'
    | 'mail'
    | 'directory'
    | 'generated'
    | 'resource-directory';
  revision: string;
  state: 'present' | 'deleted';
  coverage: {
    acquisition: 'complete-for-selection' | 'partial' | 'unknown';
    parsing: 'complete' | 'partial' | 'opaque';
    issues?: string[];
  };
  data: JsonObject;
}
export interface Archive extends JsonObject {
  format: 'weq-export';
  version: string;
  profile: ExportProfile;
  archiveId: string;
  scope: JsonObject;
  formats: Array<'json' | 'jsonl'>;
  incremental: JsonObject;
  records: ArchiveRecord[];
  observations: JsonObject[];
  resources: JsonObject[];
}
export interface ArchiveEntry {
  record: ArchiveRecord;
  observation: JsonObject;
  resources?: JsonObject[];
  additionalObservations?: JsonObject[];
}

const namespace = 'https://weq.local/schemas/export/v1/';
const schemas = [
  archiveSchema,
  commonSchema,
  messageSchema,
  qzoneSchema,
  collectionSchema,
  mailSchema,
  directorySchema,
  generatedSchema,
  resourceSchema,
  legacySchema,
  streamSchema,
];
function readerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readerSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if ((key === 'additionalProperties' || key === 'unevaluatedProperties') && child === false)
        return [];
      if (key === 'version' && object(child).const === '1.0')
        return [[key, { type: 'string', pattern: '^1\\.(?:0|[1-9][0-9]*)$' }]];
      return [[key, readerSchema(child)]];
    }),
  );
}
function validator(read: boolean) {
  const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
  addFormats(ajv);
  for (const schema of schemas) {
    const shape = read ? readerSchema(schema) : schema;
    if (read && schema.$id.endsWith('legacy.schema.json')) {
      const attribute = object(object(object(shape).$defs).attribute);
      const first = (attribute.allOf as JsonObject[])[0]!;
      object(object(first.then).properties).name = { type: 'string', pattern: '^legacy\\.' };
    }
    ajv.addSchema(shape as object);
  }
  return ajv;
}
const writerValidator = validator(false);
const readerValidator = validator(true);
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
export function canonical(value: unknown): string {
  if (typeof value === 'number') {
    assert(Number.isFinite(value) && !Object.is(value, -0), '非规范 JSON 数值');
    assert(!Number.isInteger(value) || Number.isSafeInteger(value), '整数精度丢失');
  }
  if (value === null || typeof value !== 'object') {
    assert(value === null || ['string', 'number', 'boolean'].includes(typeof value), '非 JSON 值');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assert(Object.hasOwn(value, i), '稀疏数组');
    return `[${value.map(canonical).join(',')}]`;
  }
  assert([Object.prototype, null].includes(Object.getPrototypeOf(value)), '非 JSON 对象');
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(',')}}`;
}
export const sha256 = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');
export function recordRevision(record: JsonObject): string {
  const { revision: _revision, ...body } = record;
  return sha256(canonical(body));
}
export function stableId(kind: string, parts: Json[]): string {
  return `${kind}:${sha256(canonical(parts))}`;
}
export function typedValue(value: unknown): JsonObject {
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64'), encoding: 'base64' };
  if (typeof value === 'string') return { type: 'text', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return { type: 'integer', value: String(value) };
  canonical(value);
  return { type: 'json', value: value as Json };
}
export function actor(uin?: string, uid?: string, name?: string): JsonObject {
  const identities: Json[] = [];
  if (uin && uin !== '0') identities.push({ namespace: 'qq-uin', value: uin });
  if (uid) identities.push({ namespace: 'qq-uid', value: uid });
  return { identities, ...(name === undefined ? {} : { name }) };
}
export function archiveHeader(options: ArchiveOptions = {}): ArchiveHeader {
  const formats = [
    ...new Set(
      (options.formats?.length ? options.formats : (['json'] as const)).map((format) =>
        format === 'jsonl.gz' ? 'jsonl' : format,
      ),
    ),
  ];
  const account = actor(options.accountUin);
  return {
    format: 'weq-export',
    version: '1.0',
    profile: options.profile ?? 'basic',
    archiveId: options.archiveId ?? randomUUID(),
    scope: {
      account,
      ...(!(account.identities as Json[]).length
        ? { partition: options.partition ?? randomUUID() }
        : {}),
      selection: typedValue(options.selection ?? {}),
    },
    formats,
    incremental: options.incrementalSupport
      ? { enabled: true, authority: formats.includes('jsonl') ? 'jsonl' : 'json' }
      : { enabled: false },
  };
}
export function checkArchiveShape(name: string, value: unknown, read = false): void {
  const ajv = read ? readerValidator : writerValidator;
  const validate = ajv.getSchema(namespace + name);
  assert(validate, `缺少格式定义 ${name}`);
  assert(validate(value), `导出格式无效：${ajv.errorsText(validate.errors)}`);
  canonical(value);
}
export function makeEntry(
  kind: ArchiveRecord['kind'],
  identity: Json[],
  data: JsonObject,
  options: {
    profile?: ExportProfile;
    source?: JsonObject;
    attributes?: JsonObject[];
    residuals?: JsonObject[];
    coverage?: ArchiveRecord['coverage'];
    state?: ArchiveRecord['state'];
    observationId?: string;
    observedAt?: JsonObject | null;
  } = {},
): ArchiveEntry {
  const record: ArchiveRecord = {
    id: stableId(kind, identity),
    kind,
    revision: '',
    state: options.state ?? 'present',
    coverage: options.coverage ?? { acquisition: 'unknown', parsing: 'partial' },
    data,
    ...(options.profile === 'full'
      ? { native: { attributes: options.attributes ?? [], residuals: options.residuals ?? [] } }
      : {}),
  };
  record.revision = recordRevision(record);
  const observation: JsonObject = {
    id: options.observationId ?? randomUUID(),
    recordId: record.id,
    revision: record.revision,
    profile: options.profile ?? 'basic',
    observedAt:
      options.observedAt === undefined
        ? { unixSeconds: (Date.now() / 1000).toFixed(3), precision: 'millisecond' }
        : options.observedAt,
    source: options.source ?? { id: stableId('source', identity), kind: 'cache', locator: kind },
  };
  return { record, observation };
}

/** 原始结构原样返回；查看器投影不能成为后续增量写入的数据源。 */
export function readArchive(value: unknown): Archive {
  const document = object(value);
  assert(document.format === 'weq-export', '不是 WeQ 正式归档');
  assert(
    typeof document.version === 'string' && /^1\.(?:0|[1-9][0-9]*)$/.test(document.version),
    '不支持的导出格式版本',
  );
  checkArchiveShape('archive.schema.json', value, true);
  const archive = value as Archive;
  verifyArchive(archive);
  return archive;
}
export function latestArchiveRecords(archive: Archive): ArchiveRecord[] {
  const index = new Map(archive.records.map((record) => [key(record), record]));
  const selected = new Map<string, { record: ArchiveRecord; time: bigint | null; order: number }>();
  for (const [order, observation] of archive.observations.entries()) {
    const record = index.get(`${observation.recordId}\0${observation.revision}`)!;
    const seconds = object(observation.observedAt).unixSeconds;
    let time: bigint | null = null;
    if (typeof seconds === 'string') {
      const negative = seconds.startsWith('-'),
        [whole, fraction = ''] = (negative ? seconds.slice(1) : seconds).split('.');
      time =
        (BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0'))) * (negative ? -1n : 1n);
    }
    const previous = selected.get(record.id);
    if (
      !previous ||
      (time !== null && (previous.time === null || time >= previous.time)) ||
      (time === null && previous.time === null)
    )
      selected.set(record.id, { record, time, order });
  }
  return [...selected.values()].map(({ record }) => record);
}
function key(record: JsonObject): string {
  return `${record.id}\0${record.revision}`;
}
function unique(items: JsonObject[], identity: (item: JsonObject) => string): Set<string> {
  const set = new Set<string>();
  for (const item of items) {
    const id = identity(item);
    assert(!set.has(id), '归档包含重复对象');
    set.add(id);
  }
  return set;
}
export function verifyArchive(archive: Archive): void {
  const records = unique(archive.records, key);
  unique(archive.observations, (item) => String(item.id));
  unique(archive.resources, canonical);
  const referenced = new Set<string>();
  for (const observation of archive.observations) {
    const ref = `${observation.recordId}\0${observation.revision}`;
    assert(records.has(ref), '悬空来源观察');
    referenced.add(ref);
  }
  for (const record of archive.records) {
    assert(record.revision === recordRevision(record), '正文摘要不符');
    assert(referenced.has(key(record)), '正文缺少来源观察');
    verifyNative(
      record,
      archive.observations.filter(
        (item) => item.recordId === record.id && item.revision === record.revision,
      ),
    );
  }
  const account = object(object(archive.scope).account);
  assert(
    Array.isArray(account.identities) && (account.identities.length || archive.scope.partition),
    '未知账号缺少独立分区',
  );
  if (archive.incremental.enabled)
    assert(
      archive.formats.includes(archive.incremental.authority as 'json' | 'jsonl'),
      '增量 authority 未选中',
    );
  const graph = new ArchiveGraph(archive.externalReferences);
  for (const record of archive.records) graph.record(record);
  for (const resource of archive.resources) graph.resource(resource);
  graph.finish();
  for (const observation of archive.observations) {
    const record = archive.records.find(
      (item) => item.id === observation.recordId && item.revision === observation.revision,
    )!;
    const mappings = objects(observation.mappings);
    unique(mappings, (item) => String(item.from));
    for (const mapping of mappings) {
      pointer(record, String(mapping.to));
      assert(validPointer(String(mapping.from)), '无效来源 Pointer');
    }
    if (object(observation.source).kind === 'legacy-import') {
      assert(
        observation.importedAt && object(observation.source).provenance,
        '历史导入缺少来源或迁移时刻',
      );
      assert(record.identity, '历史导入缺少身份解释');
      if (record.kind === 'message' && record.data.messageId !== null)
        assert(object(record.identity).nativeNamespace, '历史消息缺少原生 ID 命名空间');
    } else assert(observation.observedAt !== null, '非历史观察缺少真实时刻');
  }
}

const objects = (value: Json | undefined): JsonObject[] =>
  Array.isArray(value) ? value.map(object) : [];
const validPointer = (path: string): boolean => /^(?:\/(?:[^~/]|~[01])*)*$/.test(path);
export function pointer(value: Json, path: string): Json {
  assert(validPointer(path), '无效 JSON Pointer');
  for (const token of path === '' ? [] : path.slice(1).split('/')) {
    const field = token.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(
      value !== null && typeof value === 'object' && Object.hasOwn(value, field),
      `悬空 Pointer ${path}`,
    );
    value = (value as JsonObject)[field]!;
  }
  return value;
}
export function verifyNative(record: JsonObject, observations: JsonObject[]): void {
  for (const observation of observations) {
    const mappings = objects(observation.mappings);
    unique(mappings, (item) => String(item.from));
    for (const mapping of mappings) {
      pointer(record, String(mapping.to));
      assert(validPointer(String(mapping.from)), '无效来源 Pointer');
    }
  }
  if (!record.native) return;
  const native = object(record.native),
    attributes = objects(native.attributes),
    residuals = objects(native.residuals);
  unique(attributes, (item) => `${item.target}\0${item.name}`);
  for (const attribute of attributes) {
    const target = pointer(record, String(attribute.target));
    assert(
      target && typeof target === 'object' && !Object.hasOwn(target, String(attribute.name)),
      '附加属性与规范字段重复',
    );
  }
  unique(residuals, (item) => `${item.source}\0${item.path}\0${item.offset ?? ''}`);
  const intervals = new Map<string, Array<[bigint, bigint]>>();
  for (const residual of residuals) {
    const path = String(residual.path);
    assert(validPointer(path), '无效残余 Pointer');
    const sources = observations.filter((item) => object(item.source).id === residual.source);
    assert(sources.length, '残余缺少来源观察');
    for (const source of sources)
      for (const mapping of objects(source.mappings)) {
        const from = String(mapping.from);
        assert(
          from !== path && !from.startsWith(`${path}/`) && !path.startsWith(`${from}/`),
          '残余重复已消费字段',
        );
      }
    if (residual.length !== undefined && object(residual.value).type === 'bytes')
      assert(
        BigInt(String(residual.length)) ===
          BigInt(Buffer.from(String(object(residual.value).value), 'base64').length),
        '残余长度不符',
      );
    if (residual.offset === undefined || residual.length === undefined) continue;
    const root = `${residual.source}\0${path.split('/')[1]}`,
      start = BigInt(String(residual.offset)),
      end = start + BigInt(String(residual.length));
    const ranges = intervals.get(root) ?? [];
    assert(
      ranges.every(([left, right]) => start >= right || end <= left),
      '残余字节区间重复',
    );
    ranges.push([start, end]);
    intervals.set(root, ranges);
  }
}

/** 只索引身份与引用；不把未知扩展字段中的同名键解释成业务关系。 */
export class ArchiveGraph {
  private readonly ids = new Map<string, string>();
  private readonly external = new Set<string>();
  private readonly resourceIds = new Set<string>();
  private readonly relations: Array<{ id: string; resource: boolean }> = [];
  private readonly paths = new Map<string, string>();
  private readonly derived = new Map<string, string>();
  private readonly pendingDerived = new Set<string>();
  private readonly bindingTargets = new Map<string, Set<string>>();
  private readonly bindings: Array<{ key: string; resourceId: string }> = [];
  private readonly successful = new Map<string, Set<string>>();
  private readonly derivationInputs = new Map<string, Set<string>>();
  private readonly pendingInputs = new Set<string>();
  private readonly qzoneTypes = new Map<string, Set<string>>();
  private readonly qzoneParents = new Map<string, string>();
  constructor(references?: Json) {
    for (const reference of objects(references)) {
      assert(!this.external.has(String(reference.id)), '重复外部引用');
      this.external.add(String(reference.id));
    }
  }
  record(record: ArchiveRecord): void {
    assert(!this.external.has(record.id), '外部引用与内部对象重复');
    const previous = this.ids.get(record.id);
    assert(!previous || previous === record.kind, '对象身份领域冲突');
    this.ids.set(record.id, record.kind);
    const schema = writerValidator.getSchema(`${namespace}${record.kind}.schema.json`)!.schema;
    const properties = object(object(object(object(schema).$defs).data).properties);
    const data = Object.fromEntries(
      Object.entries(record.data).filter(([field]) => Object.hasOwn(properties, field)),
    );
    if (record.kind === 'qzone') {
      const expected = this.qzoneParents.get(record.id);
      assert(!expected || expected === data.type, '空间互动父实体类型不符');
      const types = this.qzoneTypes.get(record.id) ?? new Set<string>();
      types.add(String(data.type));
      this.qzoneTypes.set(record.id, types);
      if (typeof data.parentType === 'string') {
        assert(typeof data.parentId === 'string', '父实体类型缺少父实体');
        assert(
          !this.qzoneParents.has(data.parentId) ||
            this.qzoneParents.get(data.parentId) === data.parentType,
          '空间互动父实体类型冲突',
        );
        const parents = this.qzoneTypes.get(data.parentId);
        assert(
          !parents || [...parents].every((type) => type === data.parentType),
          '空间互动父实体类型不符',
        );
        this.qzoneParents.set(data.parentId, data.parentType);
      }
    }
    if (
      record.kind === 'message' &&
      (data.messageId === null || object(data.conversation).kind === 'unknown')
    )
      assert(
        record.identity && object(record.identity).status !== 'verified',
        '未知原生身份不得声称已核实',
      );
    for (const field of ['parentId', 'repostId', 'replyToId', 'targetId'])
      if (typeof data[field] === 'string')
        this.relations.push({ id: String(data[field]), resource: false });
    for (const id of Array.isArray(data.categoryIds) ? data.categoryIds : [])
      this.relations.push({ id: String(id), resource: false });
    const embedded = new Set<string>();
    const contentRefs: string[] = [];
    for (const field of ['resourceIds', 'attachments', 'avatarResources'])
      for (const id of Array.isArray(data[field]) ? data[field] : [])
        this.relations.push({ id: String(id), resource: true });
    const visit = (node: JsonObject, path = '/data') => {
      for (const [index, element] of objects(node.content).entries()) {
        const elementPath = `${path}/content/${index}`;
        if (element.type === 'unknown')
          assert(record.coverage.parsing !== 'complete', '未知内容不能声称解析完整');
        if (element.type === 'media') {
          const key = `${record.id}\0${elementPath}`,
            ids = this.bindingTargets.get(key) ?? new Set<string>();
          for (const id of element.resourceIds as Json[]) {
            this.relations.push({ id: String(id), resource: true });
            ids.add(String(id));
          }
          this.bindingTargets.set(key, ids);
        }
        if (element.type === 'reference' && element.status === 'resolved')
          contentRefs.push(String(element.target));
        if (element.type === 'forward') {
          const nodes = objects(element.records);
          if (element.status === 'unavailable') assert(!nodes.length, '不可用转发含正文');
          if (typeof element.resourceId === 'string')
            this.relations.push({ id: element.resourceId, resource: true });
          for (const [childIndex, child] of nodes.entries()) {
            assert(!embedded.has(String(child.id)), '重复转发节点身份');
            embedded.add(String(child.id));
            visit(child, `${elementPath}/records/${childIndex}`);
          }
        }
      }
    };
    visit(data);
    for (const inline of objects(data.inlineResources))
      this.relations.push({ id: String(inline.resourceId), resource: true });
    for (const id of contentRefs)
      if (!embedded.has(id)) this.relations.push({ id, resource: false });
  }
  resource(resource: JsonObject): void {
    const id = String(resource.id);
    this.resourceIds.add(id);
    if (resource.status === 'saved') {
      assert(resource.path === `media/${resource.sha256}`, '资源路径不符内容寻址');
      const path = String(resource.path),
        size = String(resource.size);
      assert(!this.paths.has(path) || this.paths.get(path) === size, '同 hash 资源大小冲突');
      this.paths.set(path, size);
      const hashes = this.successful.get(id) ?? new Set<string>();
      hashes.add(String(resource.sha256));
      this.successful.set(id, hashes);
      for (const expected of this.derivationInputs.get(id) ?? [])
        assert(expected === resource.sha256, '派生输入摘要缺少匹配原件');
    }
    if (resource.role === 'playback') assert(resource.derivation, '播放副本缺少派生关系');
    if (resource.derivation) {
      const parent = String(object(resource.derivation).sourceResourceId);
      assert(parent !== id, '资源自引用');
      this.derived.set(id, parent);
      this.pendingDerived.add(id);
      this.relations.push({ id: parent, resource: true });
      const input = object(resource.derivation).inputSha256;
      if (typeof input === 'string') {
        const inputs = this.derivationInputs.get(parent) ?? new Set<string>();
        inputs.add(input);
        this.derivationInputs.set(parent, inputs);
        this.pendingInputs.add(parent);
      }
    }
    if (resource.native) verifyNative(resource, [{ source: resource.source! }]);
    const bindings = objects(resource.bindings);
    unique(bindings, (binding) => `${binding.recordId}\0${binding.target}`);
    for (const binding of bindings)
      this.bindings.push({ key: `${binding.recordId}\0${binding.target}`, resourceId: id });
  }
  canCommit(): boolean {
    return (
      this.relations.every((relation) =>
        relation.resource
          ? this.resourceIds.has(relation.id)
          : this.ids.has(relation.id) || this.external.has(relation.id),
      ) &&
      this.bindings.every((binding) =>
        this.bindingTargets.get(binding.key)?.has(binding.resourceId),
      ) &&
      [...this.pendingInputs].every(
        (id) =>
          this.successful.get(id)?.size &&
          [...this.derivationInputs.get(id)!].every((input) =>
            [...this.successful.get(id)!].every((hash) => hash === input),
          ),
      )
    );
  }
  finish(): void {
    for (const relation of this.relations)
      assert(
        relation.resource
          ? this.resourceIds.has(relation.id)
          : this.ids.has(relation.id) || this.external.has(relation.id),
        '归档包含悬空关系或资源',
      );
    this.relations.length = 0;
    for (const id of this.pendingDerived) {
      const seen = new Set([id]);
      let next = this.derived.get(id);
      while (next) {
        assert(!seen.has(next), '资源派生循环');
        seen.add(next);
        next = this.derived.get(next);
      }
    }
    this.pendingDerived.clear();
    for (const binding of this.bindings)
      assert(
        this.bindingTargets.get(binding.key)?.has(binding.resourceId),
        '附件绑定没有对应内容引用',
      );
    this.bindings.length = 0;
    for (const id of this.pendingInputs)
      for (const input of this.derivationInputs.get(id)!)
        assert(
          this.successful.get(id)?.size &&
            [...this.successful.get(id)!].every((hash) => hash === input),
          '派生输入摘要缺少匹配原件',
        );
    this.pendingInputs.clear();
  }
}

/** 大会话流式写入：JSON 的观察暂存于同目录，结束后拼接并移除；JSONL 分批提交。 */
export async function writeArchiveEntries(
  path: string,
  format: ArchiveFormat,
  header: ArchiveHeader,
  entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>,
  options: { retainInterrupted?: boolean } = {},
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const observationPath = `${temporary}.observations`;
  const resourcePath = `${temporary}.resources`;
  const file = await open(temporary, 'wx', 0o600);
  const observations = await open(observationPath, 'wx', 0o600);
  const resources = await open(resourcePath, 'wx', 0o600);
  const output = format === 'jsonl.gz' ? compressedArchiveWriter(file) : bufferedFileWriter(file),
    observationOutput = bufferedFileWriter(observations),
    resourceOutput = bufferedFileWriter(resources);
  const revisions = new Set<string>(),
    resourceKeys = new Set<string>(),
    observationIds = new Set<string>();
  const graph = new ArchiveGraph(header.externalReferences);
  let recordCount = 0,
    observationCount = 0,
    resourceCount = 0;
  let batchId = randomUUID(),
    sequence = 1n,
    previous: string | null = null,
    batchEntries = 0;
  let batchBytes = 0;
  let digest = createHash('sha256');
  const emit = async (type: string, value: JsonObject) => {
    const line = { type, batchId, [type === 'revision' ? 'record' : type]: value };
    checkArchiveShape('stream.schema.json', line);
    const text = `${canonical(line)}\n`;
    assert(Buffer.byteLength(text) - 1 <= 8 * 1024 * 1024, 'JSONL 单行超过 8 MiB');
    batchBytes += Buffer.byteLength(text);
    assert(batchBytes <= 64 * 1024 * 1024, 'JSONL 单批次超过 64 MiB，关联对象不能在单批次内提交');
    digest.update(text);
    batchEntries++;
    await output.write(text);
  };
  const commit = async () => {
    graph.finish();
    if (format !== 'jsonl.gz') await output.flush();
    await file.sync();
    const entry = {
      type: 'commit',
      batchId,
      sequence: String(sequence),
      entries: batchEntries,
      sha256: digest.digest('hex'),
      previous,
    };
    await output.write(`${canonical(entry)}\n`);
    await output.flush();
    await file.sync();
    previous = sha256(canonical(entry));
    sequence++;
    batchId = randomUUID();
    batchEntries = 0;
    batchBytes = 0;
    digest = createHash('sha256');
  };
  try {
    checkArchiveShape('archive.schema.json', {
      ...header,
      records: [],
      observations: [],
      resources: [],
    });
    await output.write(
      format !== 'json'
        ? `${canonical({ type: 'header', header })}\n`
        : `${canonical(header).slice(0, -1)},"records":[`,
    );
    try {
      for await (const entry of entries) {
        assert(entry.record.revision === recordRevision(entry.record), '正文摘要不符');
        const sourceObservations = [entry.observation, ...(entry.additionalObservations ?? [])];
        for (const observation of sourceObservations)
          assert(
            observation.recordId === entry.record.id &&
              observation.revision === entry.record.revision,
            '来源观察与正文不匹配',
          );
        checkArchiveShape(`${entry.record.kind}.schema.json`, entry.record);
        for (const observation of sourceObservations)
          checkArchiveShape('common.schema.json#/$defs/observation', observation);
        verifyNative(entry.record, sourceObservations);
        if (!revisions.has(key(entry.record))) {
          revisions.add(key(entry.record));
          graph.record(entry.record);
          if (format !== 'json') await emit('revision', entry.record);
          else await output.write(`${recordCount ? ',' : ''}${canonical(entry.record)}`);
          recordCount++;
        }
        for (const observation of sourceObservations) {
          assert(!observationIds.has(String(observation.id)), '重复来源观察');
          observationIds.add(String(observation.id));
          if (format !== 'json') await emit('observation', observation);
          else
            await observationOutput.write(
              `${observationCount ? ',' : ''}${canonical(observation)}`,
            );
          observationCount++;
        }
        for (const resource of entry.resources ?? []) {
          checkArchiveShape('archive.schema.json#/$defs/resource', resource);
          const resourceKey = canonical(resource);
          if (resourceKeys.has(resourceKey)) continue;
          resourceKeys.add(resourceKey);
          graph.resource(resource);
          if (format !== 'json') await emit('resource', resource);
          else await resourceOutput.write(`${resourceCount ? ',' : ''}${resourceKey}`);
          resourceCount++;
        }
        if (format !== 'json' && batchEntries >= 384 && graph.canCommit()) await commit();
      }
    } catch (error) {
      if (
        !(
          options.retainInterrupted &&
          error instanceof Error &&
          error.name === 'AbortError' &&
          recordCount > 0 &&
          graph.canCommit()
        )
      )
        throw error;
    }
    graph.finish();
    if (format !== 'json') {
      if (batchEntries || sequence === 1n) await commit();
    } else {
      await observationOutput.flush();
      await resourceOutput.flush();
      await observations.close();
      await resources.close();
      await output.write('],"observations":[');
      await output.flush();
      for await (const chunk of createReadStream(observationPath)) await file.writeFile(chunk);
      await output.write('],"resources":[');
      await output.flush();
      for await (const chunk of createReadStream(resourcePath)) await file.writeFile(chunk);
      await output.write(']}\n');
    }
    await output.flush();
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await syncArchiveDirectory(dirname(path));
  } finally {
    await Promise.all(
      [file, observations, resources].map((handle) => handle.close().catch(() => {})),
    );
    await Promise.all(
      [temporary, observationPath, resourcePath].map((file) => unlink(file).catch(() => {})),
    );
  }
}

/** JSON.parse 负责语法，token 栈负责识别已转义的重复键。 */
export function parseArchiveJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)].map((match) => match[0]);
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1),
        name = JSON.parse(token) as string;
      assert(keys && !keys.has(name), '重复 JSON 键');
      keys.add(name);
    }
  }
  canonical(value);
  return value;
}

export function encodeArchiveLog(archive: Archive): string {
  checkArchiveShape('archive.schema.json', archive);
  verifyArchive(archive);
  const { records, observations, resources, ...header } = archive;
  const batchId = randomUUID();
  const entries: JsonObject[] = [
    ...records.map((record) => ({ type: 'revision', batchId, record })),
    ...observations.map((observation) => ({ type: 'observation', batchId, observation })),
    ...resources.map((resource) => ({ type: 'resource', batchId, resource })),
  ];
  return `${canonical({ type: 'header', header })}\n${entries.map((entry) => `${canonical(entry)}\n`).join('')}${canonical({ type: 'commit', batchId, sequence: '1', entries: entries.length, sha256: sha256(entries.map((entry) => `${canonical(entry)}\n`).join('')), previous: null })}\n`;
}
export function decodeArchiveLog(text: string): { archive: Archive; uncommittedTail: boolean } {
  const lines = text.split('\n');
  const tail = lines.pop();
  const first = object(parseArchiveJson(lines.shift() ?? ''));
  assert(first.type === 'header', 'JSONL 缺少首行 header');
  assert(
    Object.keys(first).length === 2 && Object.hasOwn(first, 'header'),
    'JSONL header 外壳包含未知字段',
  );
  checkArchiveShape('stream.schema.json', first, true);
  for (const field of ['records', 'observations', 'resources'])
    assert(!Object.hasOwn(object(first.header), field), 'JSONL header 不得包含正文集合');
  const archive = {
    ...object(first.header),
    records: [],
    observations: [],
    resources: [],
  } as unknown as Archive;
  let pending: JsonObject[] = [],
    previous: string | null = null,
    sequence = 1n;
  const batches = new Set<string>();
  for (const line of lines) {
    const entry = object(parseArchiveJson(line));
    // 提交外壳保持闭合，只有内部正式对象允许新增可选属性。
    const fields =
      entry.type === 'commit'
        ? ['type', 'batchId', 'sequence', 'entries', 'sha256', 'previous']
        : entry.type === 'revision'
          ? ['type', 'batchId', 'record']
          : ['type', 'batchId', String(entry.type)];
    assert(
      Object.keys(entry).every((field) => fields.includes(field)),
      'JSONL 外壳包含未知字段',
    );
    checkArchiveShape('stream.schema.json', entry, true);
    assert(entry.type !== 'header', '重复 header');
    if (entry.type !== 'commit') {
      assert(!pending.length || pending[0]!.batchId === entry.batchId, 'JSONL 批次交错');
      pending.push(entry);
      continue;
    }
    assert(!batches.has(String(entry.batchId)), '重复 batchId');
    assert(sequence === 1n || pending.length, '重复空批次');
    assert(entry.sequence === String(sequence) && entry.previous === previous, 'JSONL 提交链不符');
    assert(
      pending.every((item) => item.batchId === entry.batchId),
      'JSONL 批次不符',
    );
    assert(
      entry.entries === pending.length &&
        entry.sha256 === sha256(pending.map((item) => `${canonical(item)}\n`).join('')),
      'JSONL 批次摘要或计数不符',
    );
    for (const item of pending) {
      if (item.type === 'revision') archive.records.push(item.record as ArchiveRecord);
      else if (item.type === 'observation') archive.observations.push(object(item.observation));
      else archive.resources.push(object(item.resource));
    }
    readArchive(archive);
    previous = sha256(canonical(entry));
    batches.add(String(entry.batchId));
    sequence++;
    pending = [];
  }
  assert(sequence > 1n, 'JSONL 没有已提交初始批次');
  return { archive: readArchive(archive), uncommittedTail: Boolean(tail || pending.length) };
}

/** 独占临时文件与原子发布；失败不截断目标，临时文件不作为正文基线。 */
export async function writeArchive(
  path: string,
  format: ArchiveFormat,
  archive: Archive,
): Promise<void> {
  checkArchiveShape('archive.schema.json', archive);
  verifyArchive(archive);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(
      format === 'jsonl.gz'
        ? await compressArchiveBlock(encodeArchiveLog(archive))
        : format === 'json'
          ? `${canonical(archive)}\n`
          : encodeArchiveLog(archive),
      'utf8',
    );
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await syncArchiveDirectory(dirname(path));
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function readArchiveFile(
  path: string,
  format: ArchiveFormat,
  signal?: AbortSignal,
): Promise<{ archive: Archive; uncommittedTail: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let compressedEnd = 0;
  const input =
    format === 'jsonl.gz'
      ? (async function* () {
          for await (const block of compressedArchiveBlocks(path, signal)) {
            compressedEnd = block.end;
            yield block.data;
          }
        })()
      : createReadStream(path, { signal });
  for await (const chunk of input) {
    size += chunk.length;
    assert(size <= 64 * 1024 * 1024, '正式归档超过当前读取器的 64 MiB 上限');
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (format === 'json')
    return { archive: readArchive(parseArchiveJson(text)), uncommittedTail: false };
  const result = decodeArchiveLog(text);
  if (format === 'jsonl.gz') {
    const { stat } = await import('node:fs/promises');
    result.uncommittedTail ||= (await stat(path)).size > compressedEnd;
  }
  return result;
}
