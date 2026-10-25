import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  realpathSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  describeViewerFile,
  discoverViewerSources,
  readViewerPage,
  resolveViewerMedia,
  EXPORT_VIEWER_LIMITS,
} from '../src/account/export/viewer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-viewer-'));
  roots.push(root);
  return root;
}
const row = (i = 1) => ({
  msgId: String(9000 + i),
  msgSeq: String(i),
  sendTime: 1792771200,
  senderUid: 'u_test',
  senderUin: '123',
  elements: [{ type: 'text', data: { textContent: `正文 ${i}` } }],
});
function file(root: string, name: string, value: unknown) {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
it('富 JSON 保留大整数标识、成员姓名与嵌套转发，HTML 仅作为文本', async () => {
  const root = fixture();
  const msg = {
    ...row(),
    msgId: '9223372036854775807',
    elements: [
      { type: 'text', data: { textContent: '<script>alert(1)</script>' } },
      {
        type: 'multiMsg',
        data: {
          forwardMessages: [
            {
              ...row(2),
              senderName: '内层',
              elements: [{ type: 'multiMsg', data: { forwardMessages: [row(3)] } }],
            },
          ],
        },
      },
    ],
  };
  const path = file(root, 'chat.json', {
    meta: { type: 'private', conversationId: 'u_peer', name: '合成聊天' },
    members: [{ uid: 'u_test', accountName: '合成姓名' }],
    messages: [msg],
  });
  const source = await describeViewerFile(path);
  expect(source.conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
  const result = await readViewerPage(source, { offset: 0, query: '正文 3' });
  expect(result.total).toBe(1);
  expect(result.messages[0]).toMatchObject({ msgId: msg.msgId, sender: '合成姓名' });
  expect(result.messages[0]?.parts[0]?.text).toBe('<script>alert(1)</script>');
  expect(result.messages[0]?.parts[1]?.messages?.[0]?.parts[0]?.messages?.[0]?.parts[0]?.text).toBe(
    '正文 3',
  );
});
it('JSONL 支持 header/member、CRLF、BOM、无换行末行和分页', async () => {
  const root = fixture(),
    path = join(root, 'messages-user.jsonl');
  writeFileSync(
    path,
    '\uFEFF' +
      [
        { _type: 'header', meta: { type: 'group', groupId: '777' } },
        { _type: 'member', uid: 'u_test', accountName: '离线成员' },
        ...Array.from({ length: 105 }, (_, i) => row(i)),
      ]
        .map((v) => JSON.stringify(v))
        .join('\r\n'),
  );
  const source = await describeViewerFile(path);
  const result = await readViewerPage(source, { offset: 100 });
  expect(result.total).toBe(105);
  expect(result.messages).toHaveLength(5);
  expect(result.messages[0]?.sender).toBe('离线成员');
});
it('目录优先日志并忽略未提交尾行，不重复列出同会话的 JSON 文件', async () => {
  const root = fixture(),
    hidden = join(root, '.weq-export-task');
  mkdirSync(hidden);
  const selection = 'a'.repeat(64),
    journal = `messages-${selection}.jsonl`;
  writeFileSync(
    join(hidden, journal),
    JSON.stringify({ ...row(), msgSeq: { $weqBigInt: '123' } }) + '\n{"unfinished":',
  );
  file(hidden, 'baseline.json', {
    version: 1,
    kind: 'group',
    conv: '777',
    selection,
    journal,
    name: '合成群聊',
    messageCount: 1,
  });
  file(root, 'chat.json', { meta: { type: 'group', groupId: '777' }, messages: [row()] });
  const result = await discoverViewerSources(root);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]?.baselineDirectory).toBe(realpathSync(hidden));
  expect((await readViewerPage(result.sources[0]!, { offset: 0 })).messages[0]?.msgSeq).toBe('123');
});
it('无基线的旧导出目录可查看 JSON，私聊不按昵称推断归属', async () => {
  const root = fixture();
  file(root, 'old.json', { meta: { type: 'private', name: '某人' }, messages: [row()] });
  file(root, 'integrity.json', { stages: [] });
  const result = await discoverViewerSources(root);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]?.conversation).toBeNull();
  expect(result.sources[0]?.baselineDirectory).toBeUndefined();
});
it('旧裸消息数组可查看，明确 targetUid 可以识别会话', async () => {
  const root = fixture(),
    path = file(root, 'old.json', [{ ...row(), targetUid: 'u_peer' }]);
  expect((await describeViewerFile(path)).conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
});
it('旧私聊 JSON/JSONL 按导出者与唯一对端成员识别，不依赖昵称', async () => {
  const root = fixture();
  const meta = { platform: 'qq', type: 'private', ownerId: '123' };
  const members = [
    { uid: 'u_self', platformId: '123' },
    { uid: 'u_peer', platformId: '456' },
  ];
  const json = file(root, 'legacy.json', { meta, members, messages: [row()] });
  const jsonl = join(root, 'legacy.jsonl');
  writeFileSync(
    jsonl,
    [{ _type: 'header', meta }, ...members.map((m) => ({ ...m, _type: 'member' })), row()]
      .map((v) => JSON.stringify(v))
      .join('\n'),
  );
  for (const path of [json, jsonl])
    expect((await describeViewerFile(path)).conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
});
it('成员归属不全、有歧义或目标冲突时不关联，群主不能当私聊导出者', async () => {
  const root = fixture();
  const members = [
    { uid: 'u_self', platformId: '123' },
    { uid: 'u_peer', platformId: '456' },
  ];
  for (const [index, doc] of [
    { meta: { type: 'private' }, members, messages: [row()] },
    { meta: { type: 'private', ownerId: '999' }, members, messages: [row()] },
    {
      meta: { type: 'private', ownerId: '123' },
      members: [...members, { uid: 'u_other', platformId: '789' }],
      messages: [row()],
    },
    { meta: { type: 'group', ownerId: '123' }, members, messages: [row()] },
    { meta: { type: 'group' }, messages: [{ ...row(), targetUid: 'u_peer' }] },
    { meta: { type: 'private' }, messages: [{ ...row(), targetGroupCode: '777' }] },
    {
      meta: { type: 'private', ownerId: '123', conversationId: 'u_other' },
      members,
      messages: [row()],
    },
    {
      messages: [
        { ...row(), targetUid: 'u_peer' },
        { ...row(2), targetUid: 'u_other' },
      ],
    },
  ].entries())
    expect(
      (await describeViewerFile(file(root, `ambiguous-${index}.json`, doc))).conversation,
    ).toBeNull();
});
it('首条灰条不妨碍读取后续目标，QQ 号通过成员映射为 UID', async () => {
  const root = fixture();
  const source = await describeViewerFile(
    file(root, 'targets.json', {
      members: [{ uid: 'u_peer', platformId: '456' }],
      messages: [row(), { ...row(2), targetUin: '456' }],
    }),
  );
  expect(source.conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
});
it('兼容明确的旧字段、只有 QQ 号的 ChatLab 成员与无成员表的双向私聊', async () => {
  const root = fixture();
  for (const meta of [
    { groupId: '777' },
    { kind: 'group', conv: '777' },
    { targetGroupCode: '777' },
  ])
    expect(
      (await describeViewerFile(file(root, 'group.json', { meta, messages: [row()] })))
        .conversation,
    ).toEqual({ kind: 'group', conv: '777' });
  const chatlab = file(root, 'chatlab-old.json', {
    meta: { type: 'private', ownerId: '123' },
    members: [{ platformId: '123' }, { platformId: '456' }],
    messages: [{ sender: '456', timestamp: 1792771200, type: 0, content: '合成正文' }],
  });
  expect((await describeViewerFile(chatlab)).conversation).toEqual({ kind: 'c2c', conv: '456' });
  const raw = file(root, 'senders.json', {
    meta: { type: 'private', ownerId: '123' },
    messages: [
      { ...row(), senderUid: 'u_self' },
      { ...row(2), senderUid: 'u_peer', senderUin: '456' },
    ],
  });
  expect((await describeViewerFile(raw)).conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
});
it('只信任配套的 WeQ 报告，报告不能覆盖冲突身份或其他平台限制', async () => {
  const root = fixture();
  const path = file(root, 'chat.json', [row()]);
  const report = { schema: 'weq-export-report/1', conversation: { kind: 'c2c', id: 'u_peer' } };
  file(root, 'chat.json.report.json', report);
  expect((await describeViewerFile(path)).conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
  file(root, 'chat.json', [{ ...row(), targetUid: 'u_other' }]);
  expect((await describeViewerFile(path)).conversation).toBeNull();
  file(root, 'chat.json', { meta: { platform: 'foreign' }, messages: [row()] });
  expect((await describeViewerFile(path)).conversation).toBeNull();
  file(root, 'chat.json', [row()]);
  file(root, 'chat.json.report.json', { ...report, schema: 'unrelated/1' });
  expect((await describeViewerFile(path)).conversation).toBeNull();
});
it('多个相同消息 ID 的隐藏日志有不同目标时不猜测，隐藏链接不跨目录读取', async () => {
  const root = fixture(),
    hidden = join(root, '.weq-export'),
    outside = fixture();
  mkdirSync(hidden);
  for (const [selection, targetUid] of [
    ['d', 'u_peer'],
    ['e', 'u_other'],
  ])
    writeFileSync(
      join(hidden, `messages-${selection!.repeat(64)}.jsonl`),
      JSON.stringify({ ...row(), targetUid }) + '\n',
    );
  const path = file(root, 'chat.json', [row()]);
  expect((await describeViewerFile(path)).conversation).toBeNull();
  rmSync(hidden, { recursive: true });
  writeFileSync(
    join(outside, `messages-${'f'.repeat(64)}.jsonl`),
    JSON.stringify({ ...row(), targetUid: 'u_peer' }) + '\n',
  );
  symlinkSync(outside, hidden);
  expect((await describeViewerFile(path)).conversation).toBeNull();
});
it('缺少基线清单的隐藏日志仍可发现，并通过共有消息关联旧 JSON', async () => {
  const root = fixture(),
    hidden = join(root, '.weq-export');
  mkdirSync(hidden);
  const journal = join(hidden, `messages-${'b'.repeat(64)}.jsonl`);
  writeFileSync(journal, JSON.stringify({ ...row(), targetUid: 'u_peer' }) + '\n');
  const path = file(root, 'legacy.json', { meta: { name: '旧导出' }, messages: [row()] });
  file(root, 'export-report.json', {
    schema: 'weq-export-report/1',
    conversation: { kind: 'c2c', id: 'u_peer' },
  });
  expect((await describeViewerFile(path)).conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
  const result = await discoverViewerSources(root);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]?.conversation).toEqual({ kind: 'c2c', conv: 'u_peer' });
  expect(result.sources[0]?.baselineDirectory).toBeUndefined();
  rmSync(path);
  const orphan = (await discoverViewerSources(root)).sources[0]!;
  expect(orphan.root).toBe(realpathSync(root));
  expect(orphan.committedOnly).toBe(true);
});
it('邻近报告和日志不能串到无关文件，报告矛盾时不自动关联', async () => {
  const root = fixture(),
    hidden = join(root, '.weq-export');
  mkdirSync(hidden);
  writeFileSync(
    join(hidden, `messages-${'c'.repeat(64)}.jsonl`),
    JSON.stringify({ ...row(), targetUid: 'u_peer' }) + '\n',
  );
  file(root, 'export-report.json', {
    schema: 'weq-export-report/1',
    conversation: { kind: 'c2c', id: 'u_other' },
  });
  expect(
    (await describeViewerFile(file(root, 'unrelated.json', [row(99)]))).conversation,
  ).toBeNull();
  expect((await describeViewerFile(file(root, 'conflict.json', [row()]))).conversation).toBeNull();
});
it('WeQ 的 ChatLab JSON/JSONL 按实际导出内容显示，不伪造已扁平化的嵌套结构', async () => {
  const root = fixture();
  const meta = { type: 'group', groupId: '777' };
  const member = { platformId: '123', accountName: 'ChatLab 成员' };
  const msg = {
    sender: '123',
    timestamp: 1792771200,
    type: 26,
    content: '[合并转发]\n  内部: 正文',
    platformMessageId: '9001',
  };
  const json = file(root, 'chatlab.json', {
    chatlab: { generator: 'WeQ' },
    meta,
    members: [member],
    messages: [msg],
  });
  const jsonl = join(root, 'chatlab.jsonl');
  writeFileSync(
    jsonl,
    [
      { _type: 'header', meta },
      { ...member, _type: 'member' },
      { ...msg, _type: 'message' },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n'),
  );
  for (const path of [json, jsonl]) {
    const result = await readViewerPage(await describeViewerFile(path), { offset: 0 });
    expect(result.messages[0]).toMatchObject({ sender: member.accountName, msgId: '9001' });
    expect(result.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: msg.content });
  }
});
it('日期筛选使用北京时间边界，不依赖系统时区', async () => {
  const root = fixture(),
    path = file(root, 'chat.json', [
      { ...row(1), sendTime: Date.parse('2026-10-23T15:59:59Z') / 1000 },
      { ...row(2), sendTime: Date.parse('2026-10-23T16:00:00Z') / 1000 },
    ]);
  const result = await readViewerPage(await describeViewerFile(path), {
    offset: 0,
    date: '2026-10-24',
  });
  expect(result.messages.map((r) => r.msgId)).toEqual([row(2).msgId]);
});
it('消息媒体只能解析到目录内普通文件，拒绝绝对路径、远端 URL 和链接逃逸', async () => {
  const root = fixture(),
    outside = fixture();
  mkdirSync(join(root, 'media'));
  writeFileSync(join(root, 'media', 'a.png'), 'synthetic');
  writeFileSync(join(outside, 'secret'), 'synthetic');
  symlinkSync(outside, join(root, 'escape'));
  const source = await describeViewerFile(file(root, 'chat.json', [row()]));
  expect(await resolveViewerMedia(source, 'media/a.png')).toBe(
    realpathSync(join(root, 'media', 'a.png')),
  );
  for (const path of [
    '../secret',
    join(outside, 'secret'),
    'https://example.invalid/a',
    'escape/secret',
    'media\\a.png',
  ]) {
    expect(await resolveViewerMedia(source, path)).toBeNull();
  }
});
it('损坏消息和非聊天 JSON 不伪装成成功，文件发生变化需重开', async () => {
  const root = fixture(),
    path = file(root, 'chat.json', [row()]);
  const source = await describeViewerFile(path);
  const info = statSync(path);
  utimesSync(path, info.atime, new Date(info.mtimeMs + 2000));
  await expect(readViewerPage(source, { offset: 0 })).rejects.toThrow('已变化');
  await expect(describeViewerFile(file(root, 'other.json', { stages: [] }))).rejects.toThrow(
    '缺少 messages',
  );
  const bad = join(root, 'bad.jsonl');
  writeFileSync(bad, JSON.stringify(row()) + '\n{broken}\n');
  await expect(describeViewerFile(bad)).rejects.toThrow();
  writeFileSync(
    bad,
    Array.from({ length: EXPORT_VIEWER_LIMITS.identityMessages }, (_, i) =>
      JSON.stringify(row(i)),
    ).join('\n') + '\n{broken}\n',
  );
  await expect(readViewerPage(await describeViewerFile(bad), { offset: 0 })).rejects.toThrow();
});
it('超大 JSON 在读取正文前拒绝，超长显示内容有明确截断', async () => {
  const root = fixture(),
    path = file(root, 'chat.json', [
      { ...row(), elements: [{ type: 'text', data: { textContent: 'a'.repeat(70000) } }] },
    ]);
  const result = await readViewerPage(await describeViewerFile(path), { offset: 0 });
  expect(result.messages[0]?.parts[0]?.text.length).toBeLessThan(66000);
  expect(result.messages[0]?.parts[0]?.text).toContain('截断');
  const huge = file(root, 'huge.json', []);
  truncateSync(huge, EXPORT_VIEWER_LIMITS.jsonBytes + 1);
  await expect(describeViewerFile(huge)).rejects.toThrow('超过 64 MiB');
});
it('关闭或取消读取时流式消息扫描可以中止', async () => {
  const root = fixture(),
    path = join(root, 'chat.jsonl');
  writeFileSync(path, JSON.stringify(row()) + '\n');
  const source = await describeViewerFile(path),
    controller = new AbortController();
  controller.abort();
  await expect(readViewerPage(source, { offset: 0 }, controller.signal)).rejects.toThrow();
});
it('空的旧 JSON 数组可以查看，不要求伪造会话标识', async () => {
  const root = fixture();
  const source = await describeViewerFile(file(root, 'empty.json', []));
  expect(source.conversation).toBeNull();
  expect(await readViewerPage(source, { offset: 0 })).toEqual({ messages: [], total: 0 });
});
it('其他平台的同号会话不能自动关联到本机 QQ', async () => {
  const root = fixture();
  const source = await describeViewerFile(
    file(root, 'foreign.json', {
      meta: { type: 'group', groupId: '777', platform: 'other-platform' },
      messages: [{ ...row(), targetGroupCode: '777' }],
    }),
  );
  expect(source.conversation).toBeNull();
});
it('搜索正文、姓名和长消息尾部，不把 JSON 属性名当作命中内容', async () => {
  const root = fixture();
  const source = await describeViewerFile(
    file(root, 'search.json', [
      {
        ...row(),
        elements: [{ type: 'text', data: { textContent: 'a'.repeat(70000) + '真实尾部内容' } }],
      },
    ]),
  );
  expect((await readViewerPage(source, { offset: 0, query: 'textContent' })).total).toBe(0);
  expect((await readViewerPage(source, { offset: 0, query: '真实尾部内容' })).total).toBe(1);
});
it('异常长的标识与媒体路径不进入跳转或响应，元数据展示有界', async () => {
  const root = fixture();
  const source = await describeViewerFile(
    file(root, 'bounded.json', {
      meta: { name: '名'.repeat(1000), type: 'private', conversationId: 'u'.repeat(513) },
      messages: [
        {
          ...row(),
          msgId: '9'.repeat(129),
          elements: [
            { type: 'pic', data: { fileName: 'image.png', exportPath: 'a'.repeat(5000) } },
          ],
        },
      ],
    }),
  );
  expect(source.name).toHaveLength(512);
  expect(source.conversation).toBeNull();
  const result = await readViewerPage(source, { offset: 0 });
  expect(result.messages[0]?.msgId).toBe('');
  expect(result.messages[0]?.parts[0]?.path).toBeUndefined();
});
it('嵌套过深明确提示显示限制，不丢失整份导出的可读性', async () => {
  const root = fixture();
  let nested: unknown = row();
  for (let i = 0; i < 20; i++)
    nested = { ...row(), elements: [{ type: 'multiMsg', data: { forwardMessages: [nested] } }] };
  const source = await describeViewerFile(file(root, 'deep.json', [nested]));
  const result = await readViewerPage(source, { offset: 0 });
  expect(result.total).toBe(1);
  expect(JSON.stringify(result)).toContain('嵌套层数超过查看上限');
});
