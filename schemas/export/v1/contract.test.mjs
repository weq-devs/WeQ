import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { historicalFixture } from './historical-fixtures.mjs';
import {
  appendObjects,
  canonical,
  checkShape,
  decodeLog,
  encodeLog,
  hash,
  latest,
  makeCommit,
  namespace,
  parseJson,
  projectBasic,
  revision,
  schemaFiles,
  validateArchive,
  validateArchiveSet,
} from './conformance.mjs';
import {
  actor,
  basicFixture,
  emptyNative,
  fullFixture,
  makeRecord,
  observation,
  time,
} from './fixtures.mjs';

const load = (name) => readFileSync(new URL(`examples/${name}`, import.meta.url), 'utf8');
const clone = structuredClone;
function edit(document, change) {
  const output = clone(document);
  change(output);
  const changed = new Map();
  for (const record of output.records) {
    const old = record.revision;
    record.revision = revision(record);
    changed.set(`${record.id}\u0000${old}`, record.revision);
  }
  for (const item of output.observations)
    item.revision = changed.get(`${item.recordId}\u0000${item.revision}`) ?? item.revision;
  return output;
}
function oneRevision(document, record, suffix, at = time('1793856200')) {
  return {
    ...document,
    records: [record],
    observations: [observation(record, suffix, at)],
    resources: [],
  };
}
function messageVariant(base, text, suffix) {
  const record = clone(base.records[1]);
  record.data.content = [{ type: 'text', text }];
  record.revision = revision(record);
  return oneRevision(base, record, suffix);
}

test('全部 schema 自校验、引用闭合并预编译', () => {
  assert.equal(schemaFiles.length, 19);
  assert.equal(namespace, 'https://weq.local/schemas/export/v1/');
});

for (const profile of ['basic', 'full']) {
  const archive = profile === 'basic' ? basicFixture() : fullFixture();
  for (const [index, record] of archive.records.entries()) {
    test(`${profile} 正例 ${record.kind}/${record.data.type ?? record.data.targetKind ?? record.data.conversation?.kind ?? 'mail'} #${index}`, () => {
      checkShape(`${record.kind}.${profile}.schema.json`, record);
    });
  }
  test(`${profile} 静态 JSON/JSONL 与夹具相同且语义等价`, () => {
    const json = parseJson(load(`${profile}.json`));
    assert.deepEqual(validateArchive(json), archive);
    const log = decodeLog(load(`${profile}.jsonl`));
    assert.deepEqual(log.document, json);
    assert.equal(log.uncommittedTail, false);
    assert.equal(encodeLog(json), load(`${profile}.jsonl`));
  });
}

test('独立黄金摘要与规范化顺序', () => {
  assert.equal(canonical({ z: [3, { b: 2, a: 1 }], a: 'x' }), '{"a":"x","z":[3,{"a":1,"b":2}]}');
  assert.equal(hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('full→basic 投影不改变语义，重算版本并改观察引用', () => {
  assert.deepEqual(projectBasic(fullFixture(), 'synthetic-archive'), basicFixture());
});
test('full 特有属性不同的版本在 basic 投影合并正文但保留观察', () => {
  const full = fullFixture();
  const modified = clone(full.records[1]);
  modified.native.attributes[0].value.value = '3';
  modified.revision = revision(modified);
  full.records.push(modified);
  full.observations.push(observation(modified, 'extra'));
  const basic = projectBasic(full);
  assert.equal(basic.records.length, full.records.length - 1);
  assert.equal(basic.observations.length, full.observations.length);
});

const negatives = [
  [
    '缺消息 ID',
    (a) => {
      delete a.records[0].data.messageId;
    },
  ],
  [
    'seq 使用数值',
    (a) => {
      a.records[0].data.seq = 9007199254740992;
    },
  ],
  [
    '已知字段重复为 raw',
    (a) => {
      a.records[0].data.raw = { msgId: 'msg-c2c' };
    },
  ],
  [
    '嵌套转发缺发送者',
    (a) => {
      delete a.records[0].data.content[2].records[0].sender;
    },
  ],
  [
    '照片缺父对象',
    (a) => {
      delete a.records.find((r) => r.kind === 'qzone' && r.data.type === 'photo').data.parentId;
    },
  ],
  [
    '负互动计数',
    (a) => {
      a.records.find((r) => r.kind === 'qzone').data.counts.likes = '-1';
    },
  ],
  [
    '收藏缺 CID',
    (a) => {
      delete a.records.find((r) => r.kind === 'collection').data.cid;
    },
  ],
  [
    '生成来源冒充 QQ',
    (a) => {
      a.records.find((r) => r.kind === 'generated').data.origin = 'qq';
    },
  ],
  [
    '助手旧会话 null',
    (a) => {
      a.records.find((r) => r.data.targetKind === 'assistant').data.sessionId = null;
    },
  ],
  [
    '成员无群归属',
    (a) => {
      delete a.records.find((r) => r.kind === 'directory' && r.data.type === 'member').data
        .parentId;
    },
  ],
  [
    '成功附件无摘要',
    (a) => {
      delete a.resources[0].sha256;
    },
  ],
  [
    '未下载却有文件路径',
    (a) => {
      a.resources[1].path = 'media/example';
    },
  ],
  [
    '包外相对路径',
    (a) => {
      a.resources[0].path = '../original';
    },
  ],
  [
    '绝对路径',
    (a) => {
      a.resources[0].path = '/tmp/original';
    },
  ],
  [
    'Windows 路径',
    (a) => {
      a.resources[0].path = 'C:\\original';
    },
  ],
  [
    '编码穿越路径',
    (a) => {
      a.resources[0].path = '%2e%2e/original';
    },
  ],
  [
    'CID 悬空',
    (a) => {
      a.records.find((r) => r.kind === 'mail').data.inlineResources[0].resourceId = 'missing';
    },
  ],
  [
    '悬空关系',
    (a) => {
      a.records.find((r) => r.kind === 'qzone' && r.data.type === 'comment').data.parentId =
        'missing';
    },
  ],
  [
    '悬空分类',
    (a) => {
      a.records.find((r) => r.data.type === 'contact').data.categoryIds = ['missing'];
    },
  ],
  [
    '未知内容却称完整解析',
    (a) => {
      a.records.find((r) => r.data.type === 'unknown').coverage.parsing = 'complete';
    },
  ],
  [
    '虚构时间精度',
    (a) => {
      a.records[0].data.sentAt.unixSeconds = '1793856000.1';
    },
  ],
  [
    '负零时间',
    (a) => {
      a.records[0].data.sentAt.unixSeconds = '-0';
    },
  ],
  [
    '结构化大整数已丢精度',
    (a) => {
      a.scope.selection.value.number = 9007199254740992;
    },
  ],
  [
    'authority 未选格式',
    (a) => {
      a.formats = ['json'];
    },
  ],
  [
    '未开启却指定 authority',
    (a) => {
      a.incremental.enabled = false;
    },
  ],
  [
    'basic 混入 full',
    (a) => {
      a.records[0].native = emptyNative();
    },
  ],
];
for (const [name, change] of negatives)
  test(`反例：${name}`, () => assert.throws(() => validateArchive(edit(basicFixture(), change))));

const fullNegatives = [
  [
    '附加属性覆盖已有规范字段',
    (a) => {
      a.records[0].native.attributes[0].name = 'messageId';
    },
  ],
  [
    '附加属性重复',
    (a) => {
      a.records[0].native.attributes.push(clone(a.records[0].native.attributes[0]));
    },
  ],
  [
    '已消费嵌套 tag 再作为残余',
    (a) => {
      a.observations[0].mappings.push({
        from: '/40800/45001/0/99999/0',
        to: '/data/content',
        transform: 'synthetic',
      });
    },
  ],
  [
    '父 BLOB 与部分解析重复',
    (a) => {
      a.records[0].native.residuals[0].path = '/40800';
      a.observations[0].mappings.push({
        from: '/40800/known/0',
        to: '/data/content',
        transform: 'synthetic',
      });
    },
  ],
  [
    '残余来源丢失',
    (a) => {
      a.records[0].native.residuals[0].source = 'missing';
    },
  ],
  [
    '尾部字节长度不符',
    (a) => {
      a.records[0].native.residuals[1].length = '4';
    },
  ],
  [
    '无效 base64',
    (a) => {
      a.records[0].native.residuals[0].value.value = '??';
    },
  ],
  [
    '非规范 base64 pad bits',
    (a) => {
      a.records[0].native.residuals[0].value.value = 'AB==';
      delete a.records[0].native.residuals[0].length;
    },
  ],
  [
    '非字节却附编码',
    (a) => {
      a.records[0].native.attributes[0].value.encoding = 'base64';
    },
  ],
  [
    '映射目标悬空',
    (a) => {
      a.observations[0].mappings[0].to = '/data/missing';
    },
  ],
  [
    '缺 native',
    (a) => {
      delete a.records[0].native;
    },
  ],
  [
    '已知属性类型不符',
    (a) => {
      a.records[0].native.attributes[0].value = { type: 'text', value: 'bad-client-seq' };
    },
  ],
  [
    '不同残余路径重复同一字节区间',
    (a) => {
      a.records[0].native.residuals[1].offset = '21';
    },
  ],
];
for (const [name, change] of fullNegatives)
  test(`full 反例：${name}`, () =>
    assert.throws(() => validateArchive(edit(fullFixture(), change))));

test('显式声明范围外关系，不扩读未选对象', () => {
  const basic = edit(basicFixture(), (a) => {
    a.records.find((r) => r.kind === 'qzone' && r.data.type === 'comment').data.parentId =
      'not-selected-post';
    a.externalReferences = [{ id: 'not-selected-post', kind: 'qzone', reason: 'not-selected' }];
  });
  validateArchive(basic);
});
test('full 字节精确保留；未知 wire/尾部不进入 basic', () => {
  const full = fullFixture();
  assert.deepEqual(
    [...Buffer.from(full.records[0].native.residuals[0].value.value, 'base64')],
    [0, 1, 2],
  );
  assert.deepEqual(
    [...Buffer.from(full.records[0].native.residuals[1].value.value, 'base64')],
    [255, 0],
  );
  assert(!('native' in projectBasic(full).records[0]));
  const mismatch = edit(full, (a) => {
    a.records[0].native.residuals[0].reason = 'wire-type-mismatch';
  });
  validateArchive(mismatch);
});
test('数值零、false、空字符串和未知 null 不互相替换', () => {
  const archive = edit(basicFixture(), (a) => {
    a.records[0].data.seq = '0';
    a.records[0].data.sentAt = null;
    a.records[0].data.content = [{ type: 'text', text: '' }];
  });
  validateArchive(archive);
  assert.equal(
    fullFixture().records.find((r) => r.kind === 'mail').native.attributes[0].value.value,
    false,
  );
});
test('未知对象不因重试重复写正文，晚到历史按身份追加', () => {
  const basic = basicFixture();
  assert.deepEqual(appendObjects(basic, basic), basic);
  const early = makeRecord('message', 'late-history', {
    conversation: { kind: 'c2c', id: 'conversation-c2c' },
    messageId: 'late-history',
    sender: actor,
    sentAt: time('1'),
    seq: '1',
    content: [{ type: 'text', text: '晚到的早期历史' }],
  });
  const merged = appendObjects(basic, oneRevision(basic, early, 'late'));
  assert.equal(merged.records.length, basic.records.length + 1);
  assert.equal(merged.records.at(-1).data.sentAt.unixSeconds, '1');
});
test('正文变化和来源冲突保留两版，观察与修改时刻分开', () => {
  const basic = basicFixture();
  const changed = messageVariant(basic, '新的正文', 'changed');
  changed.observations[0].source.modifiedAt = time('10');
  const merged = appendObjects(basic, changed);
  assert.equal(merged.records.filter((r) => r.id === basic.records[1].id).length, 2);
  assert.equal(latest(merged, basic.records[1].id).effective.content[0].text, '新的正文');
});
test('partial 不抹掉已有完整正文；回执失败不删除已保存资源', () => {
  const basic = basicFixture();
  const partial = messageVariant(basic, '截断摘要', 'partial');
  partial.records[0].coverage = { acquisition: 'partial', parsing: 'partial' };
  partial.records[0].revision = revision(partial.records[0]);
  partial.observations[0].revision = partial.records[0].revision;
  const merged = appendObjects(basic, partial);
  assert.deepEqual(
    latest(merged, basic.records[1].id).effective.content,
    basic.records[1].data.content,
  );
  const failed = {
    ...basic,
    records: [],
    observations: [],
    resources: [
      {
        id: 'asset-original',
        role: 'original',
        status: 'failed',
        observedAt: time('1793856300'),
        error: '合成失败',
      },
    ],
  };
  const withFailure = appendObjects(merged, failed);
  assert.equal(withFailure.resources.filter((r) => r.id === 'asset-original').length, 2);
  assert(withFailure.resources.some((r) => r.id === 'asset-original' && r.status === 'saved'));
});
test('附件补齐只增资源回执，同内容不同 URL 复用文件', () => {
  const basic = basicFixture();
  const saved = {
    ...basic.resources[0],
    id: 'asset-inline',
    name: 'synthetic-copy.txt',
    url: 'https://example.invalid/another',
    observedAt: time('1793856300'),
  };
  const merged = appendObjects(basic, {
    ...basic,
    records: [],
    observations: [],
    resources: [saved],
  });
  assert.equal(merged.records.length, basic.records.length);
  assert.equal(merged.resources.filter((r) => r.status === 'saved').length, 2);
  assert.equal(
    new Set(merged.resources.filter((r) => r.status === 'saved').map((r) => r.path)).size,
    1,
  );
});
test('明确删除保存新状态与旧正文；未观察不视为删除', () => {
  const basic = basicFixture();
  const deleted = messageVariant(basic, '', 'deleted');
  deleted.records[0].state = 'deleted';
  deleted.records[0].revision = revision(deleted.records[0]);
  deleted.observations[0].revision = deleted.records[0].revision;
  const merged = appendObjects(basic, deleted);
  assert.equal(latest(merged, basic.records[1].id).record.state, 'deleted');
  assert(basic.records.every((r) => r.state === 'present'));
  assert.deepEqual(
    appendObjects(basic, { ...basic, records: [], observations: [], resources: [] }),
    basic,
  );
});
test('档位升级、不兼容版本与账号不能原位混写', () => {
  const basic = basicFixture();
  assert.throws(() => appendObjects(basic, { ...basic, profile: 'full' }));
  assert.throws(() => appendObjects(basic, { ...basic, version: '2.0' }));
  assert.throws(() =>
    appendObjects(basic, { ...basic, scope: { ...basic.scope, account: actor } }),
  );
});
test('正文摘要损坏、重复版本和悬空观察拒绝', () => {
  const broken = basicFixture();
  broken.records[0].revision = '0'.repeat(64);
  assert.throws(() => validateArchive(broken));
  assert.throws(() =>
    validateArchive({
      ...basicFixture(),
      records: [...basicFixture().records, basicFixture().records[0]],
    }),
  );
  const dangling = basicFixture();
  dangling.observations[0].revision = '0'.repeat(64);
  assert.throws(() => validateArchive(dangling));
});
test('JSONL 缺索引可完整重建；未换行尾段和未提交尾批不计成功', () => {
  const basic = basicFixture();
  const log = encodeLog(basic);
  assert.deepEqual(decodeLog(log).document, basic);
  assert.equal(decodeLog(`${log}{"type":`).uncommittedTail, true);
  const tail = { type: 'revision', batchId: 'batch-2', record: basic.records[0] };
  assert.deepEqual(decodeLog(`${log}${canonical(tail)}\n`).document, basic);
  const noFinalNewline = log.slice(0, -1);
  assert.throws(() => decodeLog(noFinalNewline), /无已提交/);
});
test('JSONL 两批追加、链、计数和复用，坏提交不得当尾部恢复', () => {
  const basic = basicFixture();
  const log = encodeLog(basic);
  const firstHash = decodeLog(log).commitHash;
  const update = messageVariant(basic, '第二批正文', 'batch2');
  const events = [
    { type: 'revision', batchId: 'batch-2', record: update.records[0] },
    { type: 'observation', batchId: 'batch-2', observation: update.observations[0] },
  ];
  const commit = makeCommit(events, '2', firstHash);
  const suffix = (end) => [...events, end].map((item) => `${canonical(item)}\n`).join('');
  assert.equal(decodeLog(log + suffix(commit)).document.records.length, basic.records.length + 1);
  for (const broken of [
    { ...commit, sha256: '0'.repeat(64) },
    { ...commit, entries: 0 },
    { ...commit, previous: null },
    { ...commit, sequence: '3' },
    { ...commit, batchId: 'batch-1' },
  ])
    assert.throws(() => decodeLog(log + suffix(broken)));
  assert.throws(() => decodeLog(log.replace('"msg-c2c"', '"corrupted"')));
});
test('JSONL 禁止交错批次、重复 header、混档与未来引用', () => {
  const basic = basicFixture();
  const log = encodeLog(basic);
  const events = [
    { type: 'revision', batchId: 'a', record: basic.records[0] },
    { type: 'revision', batchId: 'b', record: basic.records[1] },
  ];
  assert.throws(() => decodeLog(log + events.map((e) => `${canonical(e)}\n`).join('')));
  assert.throws(() => decodeLog(log + log));
  const fullEvents = [{ type: 'revision', batchId: 'b', record: fullFixture().records[0] }];
  const fullCommit = makeCommit(fullEvents, '2', decodeLog(log).commitHash);
  assert.throws(() =>
    decodeLog(log + [...fullEvents, fullCommit].map((e) => `${canonical(e)}\n`).join('')),
  );
  const future = [
    {
      type: 'observation',
      batchId: 'b',
      observation: { ...basic.observations[0], id: 'future', recordId: 'future-record' },
    },
  ];
  assert.throws(() =>
    decodeLog(
      log +
        [...future, makeCommit(future, '2', decodeLog(log).commitHash)]
          .map((e) => `${canonical(e)}\n`)
          .join(''),
    ),
  );
});
test('JSONL 不重写已提交正文，不追加无变化空批次', () => {
  const basic = basicFixture(),
    log = encodeLog(basic);
  const previous = decodeLog(log).commitHash;
  const duplicate = [{ type: 'revision', batchId: 'dup', record: basic.records[0] }];
  assert.throws(
    () =>
      decodeLog(
        log +
          [...duplicate, makeCommit(duplicate, '2', previous)]
            .map((e) => `${canonical(e)}\n`)
            .join(''),
      ),
    /重复写入/,
  );
  assert.throws(
    () => decodeLog(`${log}${canonical(makeCommit([], '2', previous, 'empty'))}\n`),
    /空批次/,
  );
});
test('JSON 重复键（含转义别名）拒绝；字符串和嵌套对象不误报', () => {
  assert.throws(() => parseJson('{"id":1,"id":2}'), /重复/);
  assert.throws(() => parseJson('{"id":1,"\\u0069d":2}'), /重复/);
  assert.deepEqual(parseJson('{"a":{"id":1},"b":{"id":2},"text":"{\\"id\\":1}"}'), {
    a: { id: 1 },
    b: { id: 2 },
    text: '{"id":1}',
  });
});
test('basic 来源映射不得指向缺席的 native', () => {
  const basic = basicFixture();
  basic.observations[0].mappings = [
    { from: '/40001', to: '/native/attributes', transform: 'identity-v1' },
  ];
  assert.throws(() => validateArchive(basic), /悬空 Pointer/);
});
test('来源已取得但解析不完整，也不能抹掉完整旧正文', () => {
  const basic = basicFixture();
  const partial = messageVariant(basic, '不完整解析', 'parse-partial');
  partial.records[0].coverage.parsing = 'partial';
  partial.records[0].revision = revision(partial.records[0]);
  partial.observations[0].revision = partial.records[0].revision;
  const merged = appendObjects(basic, partial);
  assert.deepEqual(
    latest(merged, basic.records[1].id).effective.content,
    basic.records[1].data.content,
  );
});
test('full→basic 不夹带仅全量附加信息引用的资源变体', () => {
  const full = fullFixture();
  full.resources.push({ ...full.resources[1], id: 'full-only-thumbnail', role: 'thumbnail' });
  validateArchive(full);
  assert(!projectBasic(full).resources.some((item) => item.id === 'full-only-thumbnail'));
});
test('示例真实资源 hash/size 与回执一致', () => {
  const resource = basicFixture().resources[0];
  const bytes = readFileSync(new URL(`examples/${resource.path}`, import.meta.url));
  assert.equal(hash(bytes), resource.sha256);
  assert.equal(String(bytes.length), resource.size);
});

test('历史全量和 basic 投影均通过，JSONL 无损保留旧 ID、未知身份和 UTF-16', () => {
  const full = validateArchive(historicalFixture());
  assert.deepEqual(decodeLog(encodeLog(full)).document, full);
  const basic = projectBasic(full);
  assert.deepEqual(decodeLog(encodeLog(basic)).document, basic);
  assert.equal(basic.records[0].data.messageId, null);
  assert.equal(basic.records[0].data.content[0].text.charCodeAt(7), 0xd800);
  assert.deepEqual(basic.observations[0].legacyReferences, full.observations[0].legacyReferences);
  assert.equal(basic.observations[0].observedAt, null);
  assert.equal(basic.resources[0].bindings[0].status, 'candidate');
});

const historicalNegatives = [
  [
    '排版类型错误',
    (a) => {
      a.records[0].native.attributes[0].value.type = 'text';
    },
  ],
  [
    '旧字段缺解释状态',
    (a) => {
      delete a.records[0].native.attributes[0].interpretation;
    },
  ],
  [
    'read 冒充已验证语义',
    (a) => {
      a.records[0].native.attributes[6].interpretation = 'verified';
    },
  ],
  [
    '旧字段未登记',
    (a) => {
      a.records[0].native.attributes[0].name = 'legacy.pcqq.header.guessed';
    },
  ],
  [
    '迁移时间缺失',
    (a) => {
      delete a.observations[0].importedAt;
    },
  ],
  [
    '来源定位缺失',
    (a) => {
      delete a.observations[0].source.provenance;
    },
  ],
  [
    '未知身份声称已核实',
    (a) => {
      a.records[0].identity.status = 'verified';
    },
  ],
  [
    '原生 ID 无平台空间',
    (a) => {
      a.records[0].data.messageId = '123';
      delete a.records[0].identity.nativeNamespace;
    },
  ],
  [
    '照片互动误挂日志',
    (a) => {
      a.records.find((r) => r.data.sourceId === 'photo-comment').data.parentId = a.records[1].id;
    },
  ],
  [
    '未知账号丢分区',
    (a) => {
      delete a.scope.partition;
    },
  ],
  [
    '空间收藏无对象',
    (a) => {
      delete a.records.find((r) => r.data.type === 'favorite').data.targetId;
    },
  ],
  [
    '播放副本无派生关系',
    (a) => {
      delete a.resources[1].derivation;
    },
  ],
  [
    '派生输入摘要不匹配',
    (a) => {
      a.resources[1].derivation.inputSha256 = 'b'.repeat(64);
    },
  ],
  [
    '派生循环',
    (a) => {
      a.resources[1].derivation.sourceResourceId = 'legacy-playback';
    },
  ],
  [
    'TAR 偏移冒充媒体路径',
    (a) => {
      a.resources[0].path = 'old.tar:512';
    },
  ],
  [
    '附件绑定目标错误',
    (a) => {
      a.resources[0].bindings[0].target = '/data/content/0';
    },
  ],
  [
    '无时区值混装 UTC',
    (a) => {
      a.records[0].data.sentAt.unixSeconds = '1';
    },
  ],
];
for (const [name, change] of historicalNegatives)
  test(`历史反例：${name}`, () =>
    assert.throws(() => validateArchive(edit(historicalFixture(), change))));

test('未知历史观察不按迁移日期压过实际观察', () => {
  const base = historicalFixture();
  const current = clone(base.records[0]);
  current.data.content = [{ type: 'text', text: '真实较新观察' }];
  current.revision = revision(current);
  const observed = clone(base.observations[0]);
  observed.id = 'real-observation';
  observed.revision = current.revision;
  observed.observedAt = time('2');
  delete observed.mappings;
  base.records.push(current);
  base.observations.unshift(observed);
  validateArchive(base);
  assert.equal(latest(base, current.id).effective.content[0].text, '真实较新观察');
});

test('集合保留大小号 scope、跨归档关系和共享资源，不按相同 ID 合并', () => {
  const first = historicalFixture(),
    second = historicalFixture();
  second.archiveId = 'second-history';
  second.scope.partition = 'personal';
  for (const item of second.observations) item.source.provenance.scope = 'personal';
  const endpoint = (archive, id) => ({ archiveId: archive.archiveId, id });
  const set = {
    format: 'weq-export-set',
    version: '1.0',
    archives: [first, second].map((a, i) => ({
      archiveId: a.archiveId,
      path: `archives/${i}.jsonl`,
      scope: a.scope.partition,
    })),
    links: [
      {
        from: endpoint(first, first.records[0].id),
        to: endpoint(second, second.records[0].id),
        status: 'candidate',
        evidence: 'synthetic/not-auto-merged',
      },
    ],
    sharedResources: [
      {
        sha256: first.resources[0].sha256,
        path: first.resources[0].path,
        references: [endpoint(first, 'legacy-audio'), endpoint(second, 'legacy-audio')],
      },
    ],
  };
  const documents = new Map([first, second].map((a) => [a.archiveId, a]));
  validateArchiveSet(set, documents);
  const wrong = clone(set);
  wrong.archives[1].scope = 'shokou_private';
  assert.throws(() => validateArchiveSet(wrong, documents), /范围/);
  const dangling = clone(set);
  dangling.links[0].to.id = 'missing';
  assert.throws(() => validateArchiveSet(dangling, documents), /端点/);
});

test('旧变体引用和可信关联随版本保留，不把不同原生命名空间按数值归并', () => {
  const archive = historicalFixture();
  const other = clone(archive.records[0]);
  other.id = 'message:independent-ios-local-id';
  other.data.messageId = '123';
  other.identity = { status: 'source-local', nativeNamespace: 'ios/message' };
  other.data.content = [{ type: 'text', text: '另一来源' }];
  other.revision = revision(other);
  const item = clone(archive.observations[0]);
  item.id = 'ios-observation';
  item.recordId = other.id;
  item.revision = other.revision;
  item.legacyReferences[0].variantId = 'ios-original-variant';
  item.identityLinks = [
    {
      relation: 'same-object',
      target: archive.records[0].id,
      status: 'candidate',
      evidence: 'synthetic/not-verified',
    },
  ];
  archive.records.push(other);
  archive.observations.push(item);
  const original = archive.records[0];
  original.data.messageId = '123';
  const updated = edit(archive, () => {});
  const decoded = decodeLog(encodeLog(updated)).document;
  assert.equal(decoded.records.filter((r) => r.kind === 'message').length, 2);
  assert.deepEqual(decoded.observations.at(-1).legacyReferences, item.legacyReferences);
  const alias = clone(decoded.observations[0]);
  alias.id = 'historical-verified-alias';
  alias.legacyReferences[0].variantId = 'same-revision-old-variant';
  alias.identityLinks = [
    {
      relation: 'actor-alias',
      target: 'qq-uin:synthetic',
      status: 'verified',
      evidence: 'synthetic/explicit-identity-map',
    },
  ];
  decoded.observations.push(alias);
  assert.equal(projectBasic(decoded).observations.length, decoded.observations.length);
});

test('旧资源观察时间未知，不用迁移时间伪装保存时刻', () => {
  const archive = historicalFixture();
  archive.resources[0].observedAt = null;
  archive.resources[0].importedAt = time();
  assert.equal(
    decodeLog(encodeLog(validateArchive(archive))).document.resources[0].observedAt,
    null,
  );
  delete archive.resources[0].importedAt;
  assert.throws(() => validateArchive(archive));
});
