/** 设计规范验证器；不由业务导出器调用，也不是导出器实现。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const namespace = 'https://weq.local/schemas/export/v1/';
const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false });
addFormats(ajv);
export const schemaFiles = readdirSync(new URL('.', import.meta.url)).filter((name) =>
  name.endsWith('.schema.json'),
);
for (const name of schemaFiles) {
  const schema = JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
  assert(ajv.validateSchema(schema), `无效 schema ${name}`);
  ajv.addSchema(schema);
}
for (const name of schemaFiles) ajv.getSchema(namespace + name);

export function checkShape(name, value) {
  const validate = ajv.getSchema(namespace + name);
  assert(validate, `缺少 schema ${name}`);
  assert(validate(value), `${name}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`);
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export function revision(record) {
  const { id, kind, state, coverage, data, native, identity } = record;
  return hash(
    canonical({
      id,
      kind,
      state,
      coverage,
      data,
      ...(identity ? { identity } : {}),
      ...(native ? { native } : {}),
    }),
  );
}

const keyOf = (record) => `${record.id}\u0000${record.revision}`;
const same = (left, right) => canonical(left) === canonical(right);
function unique(items, key, label) {
  const keys = new Set();
  for (const item of items) {
    const value = key(item);
    assert(!keys.has(value), `${label} 重复`);
    keys.add(value);
  }
}

function walk(value, visitor) {
  visitor(value);
  if (value && typeof value === 'object')
    for (const child of Object.values(value)) walk(child, visitor);
}

function pointer(value, path) {
  assert(/^(?:\/(?:[^~/]|~[01])*)*$/.test(path), '无效 JSON Pointer');
  for (const token of path === '' ? [] : path.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(
      value !== null && typeof value === 'object' && Object.hasOwn(value, key),
      `悬空 Pointer ${path}`,
    );
    value = value[key];
  }
  return value;
}

function verifyScalars(document) {
  walk(document, (value) => {
    if (typeof value === 'number') {
      assert(Number.isFinite(value) && !Object.is(value, -0), '非规范 JSON 数值');
      assert(!Number.isInteger(value) || Number.isSafeInteger(value), '整数精度丢失');
    }
    if (!value || typeof value !== 'object') return;
    if ('unixSeconds' in value && 'precision' in value) {
      const precision = { second: 0, millisecond: 3, microsecond: 6, nanosecond: 9 }[
        value.precision
      ];
      assert((value.unixSeconds.split('.')[1]?.length ?? 0) <= precision, '时间精度不符');
      assert(!/^-0(?:\.0+)?$/.test(value.unixSeconds), '负零时间');
    }
    if (value.type === 'bytes') {
      assert(
        Buffer.from(value.value, 'base64').toString('base64') === value.value,
        '非规范 base64',
      );
    }
  });
}

function verifyNative(record, observations) {
  if (!record.native) return;
  unique(record.native.attributes, (item) => `${item.target}\u0000${item.name}`, '附加属性');
  for (const attribute of record.native.attributes) {
    const target = pointer(record, attribute.target);
    assert(target !== null && typeof target === 'object', '附加属性 target 非对象');
    assert(!Object.hasOwn(target, attribute.name), '附加属性重复已知字段');
  }
  const observed = observations.filter(
    (item) => keyOf(record) === `${item.recordId}\u0000${item.revision}`,
  );
  for (const observation of observed) {
    for (const mapping of observation.mappings ?? []) {
      pointer(record, mapping.to);
      assert(/^(?:\/(?:[^~/]|~[01])*)*$/.test(mapping.from), '无效来源 Pointer');
    }
  }
  unique(
    record.native.residuals,
    (item) => `${item.source}\u0000${item.path}\u0000${item.offset ?? ''}`,
    '残余片段',
  );
  for (const residual of record.native.residuals) {
    assert(/^(?:\/(?:[^~/]|~[01])*)*$/.test(residual.path), '无效残余 Pointer');
    const sources = observed.filter((item) => item.source.id === residual.source);
    assert(sources.length, '残余缺少来源观察');
    for (const source of sources) {
      for (const mapping of source.mappings ?? []) {
        const overlap =
          mapping.from === residual.path ||
          mapping.from.startsWith(`${residual.path}/`) ||
          residual.path.startsWith(`${mapping.from}/`);
        assert(!overlap, '残余重复已消费字段');
      }
    }
    if (residual.length !== undefined && residual.value.type === 'bytes') {
      assert(
        BigInt(residual.length) === BigInt(Buffer.from(residual.value.value, 'base64').length),
        '残余长度不符',
      );
    }
  }
  const intervals = new Map();
  for (const residual of record.native.residuals) {
    if (residual.offset === undefined || residual.length === undefined) continue;
    const root = `${residual.source}\u0000${residual.path.split('/')[1]}`;
    const start = BigInt(residual.offset),
      end = start + BigInt(residual.length);
    const previous = intervals.get(root) ?? [];
    assert(
      previous.every(([left, right]) => start >= right || end <= left),
      '残余字节区间重复',
    );
    previous.push([start, end]);
    intervals.set(root, previous);
  }
}

export function validateArchive(document) {
  checkShape('archive.schema.json', document);
  verifyScalars(document);
  if (!document.scope.account.identities.length)
    assert(document.scope.partition, '未知账号须保留独立来源分区');
  if (document.incremental.enabled)
    assert(document.formats.includes(document.incremental.authority), 'authority 未选中');
  unique(document.records, keyOf, '正文版本');
  unique(document.observations, (item) => item.id, '来源观察');
  unique(document.resources, canonical, '资源回执');
  unique(document.externalReferences ?? [], (item) => item.id, '外部引用');
  const records = new Map(document.records.map((item) => [keyOf(item), item]));
  const ids = new Set(document.records.map((item) => item.id));
  const embeddedByRecord = new Map();
  const resources = new Set(document.resources.map((item) => item.id));
  const kinds = new Map();
  for (const record of document.records) {
    const embedded = new Set();
    embeddedByRecord.set(keyOf(record), embedded);
    assert(record.revision === revision(record), '正文摘要不符');
    assert(!kinds.has(record.id) || kinds.get(record.id) === record.kind, '对象身份领域冲突');
    kinds.set(record.id, record.kind);
    assert(
      document.observations.some(
        (item) => `${item.recordId}\u0000${item.revision}` === keyOf(record),
      ),
      '正文缺少来源观察',
    );
    walk(record.data, (value) => {
      if (value?.type === 'forward') {
        if (value.status === 'unavailable')
          assert(value.records.length === 0, '不可用转发却含正文');
        for (const node of value.records) embedded.add(node.id);
      }
      if (value?.type === 'unknown')
        assert(record.coverage.parsing !== 'complete', '未知内容不能声称解析完整');
    });
    verifyNative(record, document.observations);
    if (
      record.kind === 'message' &&
      (record.data.messageId === null || record.data.conversation.kind === 'unknown')
    )
      assert(
        record.identity && record.identity.status !== 'verified',
        '未知原生身份不得声称已核实',
      );
  }
  for (const observation of document.observations) {
    assert(records.has(`${observation.recordId}\u0000${observation.revision}`), '悬空观察');
    const record = records.get(`${observation.recordId}\u0000${observation.revision}`);
    if (observation.source.kind === 'legacy-import') {
      assert(observation.source.provenance, '历史导入缺少来源定位');
      if (observation.source.provenance.scope)
        assert(
          observation.source.provenance.scope === document.scope.partition,
          '历史来源 scope 与归档分区不符',
        );
      assert(record.identity, '历史导入缺少身份解释');
      if (record.kind === 'message' && record.data.messageId !== null)
        assert(record.identity.nativeNamespace, '原生消息 ID 缺少平台命名空间');
      if (record.kind === 'qzone' && ['comment', 'reply'].includes(record.data.type))
        assert(record.data.parentType, '历史互动缺少父实体类型');
    }
    if (observation.observedAt === null)
      assert(
        observation.importedAt && observation.source.kind === 'legacy-import',
        '未知观察时刻只允许带迁移时间的历史导入',
      );
    unique(observation.mappings ?? [], (item) => item.from, '来源字段映射');
    for (const mapping of observation.mappings ?? []) {
      assert(/^(?:\/(?:[^~/]|~[01])*)*$/.test(mapping.from), '无效来源 Pointer');
      pointer(record, mapping.to);
    }
  }
  for (const reference of document.externalReferences ?? [])
    assert(!ids.has(reference.id), '外部引用与内部对象重复');
  const paths = new Map();
  for (const resource of document.resources) {
    unique(
      resource.bindings ?? [],
      (binding) => `${binding.recordId}\u0000${binding.target}`,
      '资源绑定',
    );
    for (const binding of resource.bindings ?? []) {
      const versions = document.records.filter((record) => record.id === binding.recordId);
      assert(versions.length, '附件绑定对象悬空');
      assert(
        versions.some((record) => {
          try {
            const element = pointer(record, binding.target);
            return element?.resourceIds?.includes(resource.id);
          } catch {
            return false;
          }
        }),
        '附件绑定没有对应内容引用',
      );
    }
    if (resource.role === 'playback') assert(resource.derivation, '播放副本缺少派生关系');
    if (resource.derivation) {
      assert(resource.derivation.sourceResourceId !== resource.id, '资源自引用派生');
      assert(resources.has(resource.derivation.sourceResourceId), '派生来源资源悬空');
      const visited = new Set([resource.id]);
      let next = resource;
      while (next?.derivation) {
        const id = next.derivation.sourceResourceId;
        assert(!visited.has(id), '资源派生循环');
        visited.add(id);
        next = document.resources.find((entry) => entry.id === id && entry.derivation);
      }
      if (resource.derivation.inputSha256) {
        const saved = document.resources.filter(
          (entry) => entry.id === resource.derivation.sourceResourceId && entry.status === 'saved',
        );
        assert(
          saved.length && saved.every((entry) => entry.sha256 === resource.derivation.inputSha256),
          '派生输入摘要缺少匹配原件',
        );
      }
    }
    if (resource.native) {
      const sourceObservation = {
        recordId: resource.id,
        revision: undefined,
        source: resource.source,
      };
      verifyNative(resource, [sourceObservation]);
    }
    if (resource.status !== 'saved') continue;
    assert(resource.path === `media/${resource.sha256}`, '资源路径不符内容寻址');
    assert(
      !paths.has(resource.path) || paths.get(resource.path) === resource.size,
      '同hash资源大小冲突',
    );
    paths.set(resource.path, resource.size);
  }
  for (const record of document.records) {
    for (const field of ['parentId', 'repostId', 'replyToId', 'targetId']) {
      if (record.data[field])
        assert(
          ids.has(record.data[field]) || external(document, record.data[field]),
          `悬空关系 ${field}`,
        );
    }
    if (record.kind === 'qzone' && record.data.parentType) {
      const parents = document.records.filter((entry) => entry.id === record.data.parentId);
      assert(record.data.parentId, '父实体类型缺少父实体');
      assert(
        parents.every(
          (entry) => entry.kind === 'qzone' && entry.data.type === record.data.parentType,
        ),
        '空间互动父实体类型不符',
      );
    }
    for (const id of record.data.categoryIds ?? [])
      assert(ids.has(id) || external(document, id), '悬空分类');
    walk(record.data, (value) => {
      if (!value || typeof value !== 'object') return;
      const refs = [
        ...(value.resourceIds ?? []),
        ...(value.attachments ?? []),
        ...(value.avatarResources ?? []),
      ];
      if ('resourceId' in value) refs.push(value.resourceId);
      for (const id of refs) assert(resources.has(id), '悬空资源');
      if (value.type === 'reference' && value.status === 'resolved')
        assert(
          ids.has(value.target) || embeddedByRecord.get(keyOf(record)).has(value.target),
          '悬空内容引用',
        );
    });
  }
  return document;
}

function external(document, id) {
  return document.externalReferences?.some((item) => item.id === id);
}

export function projectBasic(full, archiveId = `${full.archiveId}:basic`) {
  validateArchive(full);
  const output = structuredClone(full);
  output.profile = 'basic';
  assert(archiveId !== full.archiveId, '投影需要新 archiveId');
  output.archiveId = archiveId;
  const revisions = new Map();
  for (const record of output.records) {
    const old = keyOf(record);
    delete record.native;
    record.revision = revision(record);
    revisions.set(old, record.revision);
  }
  output.records = [...new Map(output.records.map((item) => [keyOf(item), item])).values()];
  for (const observation of output.observations) {
    observation.revision = revisions.get(`${observation.recordId}\u0000${observation.revision}`);
    if (observation.mappings) {
      observation.mappings = observation.mappings.filter((item) => !item.to.startsWith('/native/'));
      if (!observation.mappings.length) delete observation.mappings;
    }
  }
  for (const resource of output.resources) {
    delete resource.native;
    delete resource.source;
  }
  const referenced = new Set();
  for (const record of output.records)
    walk(record.data, (value) => {
      if (!value || typeof value !== 'object') return;
      for (const id of [
        ...(value.resourceIds ?? []),
        ...(value.attachments ?? []),
        ...(value.avatarResources ?? []),
      ])
        referenced.add(id);
      if ('resourceId' in value) referenced.add(value.resourceId);
    });
  let grew = true;
  while (grew) {
    const size = referenced.size;
    for (const resource of output.resources)
      if (referenced.has(resource.id) && resource.derivation)
        referenced.add(resource.derivation.sourceResourceId);
    grew = size !== referenced.size;
  }
  output.resources = output.resources.filter((resource) => referenced.has(resource.id));
  output.resources = [...new Map(output.resources.map((item) => [canonical(item), item])).values()];
  return validateArchive(output);
}

export function appendObjects(base, addition) {
  for (const field of ['archiveId', 'version', 'profile', 'scope', 'incremental'])
    assert(same(base[field], addition[field]), `归档 ${field} 不兼容`);
  const output = structuredClone(base);
  for (const [field, key] of [
    ['records', keyOf],
    ['observations', (item) => item.id],
    ['resources', canonical],
  ]) {
    const index = new Map(output[field].map((item) => [key(item), item]));
    for (const item of addition[field]) {
      const previous = index.get(key(item));
      assert(!previous || same(previous, item), '同一身份对象冲突');
      if (!previous) index.set(key(item), structuredClone(item));
    }
    output[field] = [...index.values()];
  }
  return validateArchive(output);
}

export function latest(document, id) {
  const observations = document.observations.filter((item) => item.recordId === id);
  const sorted = observations
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const time = (item) => {
        if (!item.observedAt?.unixSeconds) return null;
        const [whole, fraction = ''] = item.observedAt.unixSeconds.split('.');
        const sign = whole.startsWith('-') ? -1n : 1n;
        return BigInt(whole) * 1000000000n + sign * BigInt(fraction.padEnd(9, '0'));
      };
      const left = time(a.item),
        right = time(b.item);
      if (left === null || right === null)
        return left === right ? a.index - b.index : left === null ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : a.index - b.index;
    });
  const revisions = sorted.map(({ item }) =>
    document.records.find((record) => record.id === id && record.revision === item.revision),
  );
  const current = revisions.at(-1);
  if (!current) return null;
  const effective = structuredClone(current.data);
  if (
    current.state !== 'deleted' &&
    (current.coverage.acquisition !== 'complete-for-selection' ||
      current.coverage.parsing !== 'complete')
  ) {
    const complete = revisions.findLast(
      (item) =>
        item.state === 'present' &&
        item.coverage.acquisition === 'complete-for-selection' &&
        item.coverage.parsing === 'complete',
    );
    if (complete) {
      for (const [key, value] of Object.entries(complete.data))
        if (!(key in effective)) effective[key] = structuredClone(value);
      if (
        'content' in effective &&
        (current.coverage.parsing !== 'complete' ||
          current.data.bodyStatus === 'truncated' ||
          current.data.bodyStatus === 'summary')
      )
        effective.content = structuredClone(complete.data.content);
    }
  }
  return { record: current, effective };
}

export function validateArchiveSet(set, documents) {
  checkShape('archive-set.schema.json', set);
  unique(set.archives, (entry) => entry.archiveId, '集合归档');
  unique(set.archives, (entry) => entry.path, '集合路径');
  const archives = new Map();
  for (const entry of set.archives) {
    const document = documents.get(entry.archiveId);
    assert(document, '集合归档缺失');
    validateArchive(document);
    assert(
      document.archiveId === entry.archiveId && document.scope.partition === entry.scope,
      '集合范围不符',
    );
    archives.set(entry.archiveId, document);
  }
  const endpoint = (ref, field) => {
    const document = archives.get(ref.archiveId);
    assert(
      document?.[field].some((entry) => entry.id === ref.id),
      '集合端点悬空',
    );
    return document[field].filter((entry) => entry.id === ref.id);
  };
  for (const link of set.links) {
    endpoint(link.from, 'records');
    endpoint(link.to, 'records');
  }
  unique(set.sharedResources, (entry) => entry.sha256, '共享资源');
  for (const shared of set.sharedResources) {
    assert(shared.path === `media/${shared.sha256}`, '共享资源路径不符');
    for (const ref of shared.references)
      assert(
        endpoint(ref, 'resources').some(
          (entry) => entry.status === 'saved' && entry.sha256 === shared.sha256,
        ),
        '共享资源摘要不符',
      );
  }
  return set;
}

export function encodeLog(document) {
  const { records, observations, resources, ...header } = document;
  const events = [
    ...records.map((record) => ({ type: 'revision', batchId: 'batch-1', record })),
    ...observations.map((observation) => ({
      type: 'observation',
      batchId: 'batch-1',
      observation,
    })),
    ...resources.map((resource) => ({ type: 'resource', batchId: 'batch-1', resource })),
  ];
  const commit = makeCommit(events, '1', null);
  return [{ type: 'header', header }, ...events, commit]
    .map((line) => `${canonical(line)}\n`)
    .join('');
}

export function makeCommit(events, sequence, previous, batchId = events[0]?.batchId ?? 'batch-1') {
  return {
    type: 'commit',
    batchId,
    sequence,
    entries: events.length,
    sha256: hash(events.map((item) => `${canonical(item)}\n`).join('')),
    previous,
  };
}

export function decodeLog(text) {
  const lines = text.split('\n');
  const tail = lines.pop();
  const first = parseJson(lines.shift());
  checkShape('stream.schema.json', first);
  assert(first.type === 'header', '缺少首行 header');
  let document = { ...first.header, records: [], observations: [], resources: [] };
  let pending = [],
    previous = null,
    sequence = 1n;
  const batches = new Set();
  for (const line of lines) {
    const event = parseJson(line);
    checkShape('stream.schema.json', event);
    assert(event.type !== 'header', '重复 header');
    if (event.type !== 'commit') {
      assert(!pending.length || pending[0].batchId === event.batchId, '批次交错');
      pending.push(event);
      continue;
    }
    assert(!batches.has(event.batchId), '重复 batchId');
    assert(sequence === 1n || pending.length > 0, '重复空批次');
    assert(event.sequence === String(sequence) && event.previous === previous, '提交链不符');
    assert(
      pending.every((item) => item.batchId === event.batchId),
      '批次不符',
    );
    assert(
      same(event, makeCommit(pending, String(sequence), previous, event.batchId)),
      '批次摘要或计数不符',
    );
    const addition = { ...first.header, records: [], observations: [], resources: [] };
    for (const item of pending) {
      const field = { revision: 'records', observation: 'observations', resource: 'resources' }[
        item.type
      ];
      const value = item[item.type === 'revision' ? 'record' : item.type];
      const key =
        item.type === 'revision'
          ? keyOf
          : item.type === 'observation'
            ? (entry) => entry.id
            : canonical;
      assert(!document[field].some((entry) => key(entry) === key(value)), '重复写入已提交对象');
      addition[field].push(value);
    }
    document = appendObjects(document, addition);
    previous = hash(canonical(event));
    batches.add(event.batchId);
    sequence++;
    pending = [];
  }
  assert(sequence > 1n, '无已提交初始批次');
  return { document, uncommittedTail: Boolean(tail || pending.length), commitHash: previous };
}

/** 先用标准解析器校验语法，再只对字符串/容器 token 核对重复键。 */
export function parseJson(text) {
  const value = JSON.parse(text);
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)].map((match) => match[0]);
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const keys = stack.at(-1),
        key = JSON.parse(token);
      assert(keys && !keys.has(key), '重复 JSON 键');
      keys.add(key);
    }
  }
  return value;
}
