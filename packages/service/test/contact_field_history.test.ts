import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ContactHistoryService } from '../src/account/contact_history';
import { projectContactHistoryFields } from '../src/account/contact_field_history';

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

const opened: Array<{ history: ContactHistoryService; root: string }> = [];
async function open() {
  const root = await mkdtemp(join(tmpdir(), 'weq-field-history-'));
  const history = new ContactHistoryService(root);
  opened.push({ history, root });
  await history.migration;
  return history;
}
afterEach(async () => {
  for (const { history, root } of opened.splice(0)) {
    await history.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('跨接口连续相同值合并，跨页保留真正的 A→B→A', async () => {
  const h = await open();
  const entity = 'friend:u_duplicates';
  for (const [at, category, nick] of [
    [100, 'getProfile', 'A'],
    [110, 'profile.profilesByUids', 'A'],
    [120, 'getProfile', 'B'],
    [130, 'profile.profilesByUids', 'B'],
    [140, 'getProfile', 'A'],
    [150, 'profile.profilesByUids', 'A'],
  ] as const)
    await h.observe({ entity, category, source: 'local', value: { nick }, at });
  await h.fieldSummary(entity);
  const page = await h.fieldVersions(entity, 'nick', '', undefined, 2);
  expect(page.rows.map((row) => [row.value, row.first_at, row.last_at])).toEqual([
    ['A', 140, 150],
    ['B', 120, 130],
  ]);
  expect(
    (await h.fieldVersions(entity, 'nick', '', page.nextBefore!, 2)).rows.map((r) => r.value),
  ).toEqual(['A']);
});
it('只变头像链接不算换头像，图片内容变化才产生历史', async () => {
  const h = await open();
  const entity = 'friend:u_avatar';
  let bytes = Buffer.from('picture A');
  h.setAvatarReader(async () => bytes);
  for (const [at, avatarUrl] of [
    [100, 'https://qh.qlogo.cn/g?ek=old'],
    [110, 'https://qh.qlogo.cn/g?ek=new'],
  ] as const)
    await h.observe({ entity, category: 'getProfile', source: 'local', value: { avatarUrl }, at });
  expect((await h.fieldSummary(entity)).fields).not.toContain('avatar');
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(1);
  bytes = Buffer.from('picture B');
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { avatarUrl: 'https://qh.qlogo.cn/g?ek=new' },
    at: 120,
  });
  expect((await h.fieldSummary(entity)).fields).toContain('avatar');
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(2);
});
it('跨来源合并相同值，已核实不同图片的跨来源观察也保留', async () => {
  const h = await open();
  const entity = 'friend:u_sources';
  h.setAvatarReader(async (url) => Buffer.from(url.endsWith('/c') ? 'different' : 'same'));
  for (const [at, source, avatarUrl] of [
    [100, 'local', 'https://example.test/a'],
    [110, 'online', 'https://example.test/b'],
    [120, 'online', 'https://example.test/c'],
  ] as const) {
    await h.observe({
      entity,
      category: 'getProfile',
      source,
      value: { nick: '同名', avatarUrl },
      at,
    });
  }
  expect((await h.fieldSummary(entity)).fields).toEqual(['avatar']);
  expect((await h.fieldVersions(entity, 'nick')).rows).toHaveLength(1);
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(2);
});
it('旧头像仅用缓存补算；缺图和下载失败不把 URL 变化当作头像变化', async () => {
  const h = await open();
  const entity = 'friend:u_old_avatar';
  for (const [at, avatarUrl] of [
    [100, 'https://example.test/a'],
    [110, 'https://example.test/b'],
  ] as const)
    await h.observe({ entity, category: 'getProfile', source: 'local', value: { avatarUrl }, at });
  const calls: boolean[] = [];
  h.setAvatarReader(async (_url, cachedOnly) => {
    calls.push(cachedOnly);
    return Buffer.from('same image');
  });
  expect((await h.fieldSummary(entity)).fields).not.toContain('avatar');
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(1);
  expect(calls).toEqual([true, true]);
  h.setAvatarReader(async () => {
    throw new Error('offline');
  });
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { avatarUrl: 'https://example.test/c' },
    at: 120,
  });
  expect((await h.fieldSummary(entity)).fields).not.toContain('avatar');
});
it('缓存稍后出现时自动补算；目录采集不批量下载头像', async () => {
  const h = await open();
  const entity = 'friend:u_late_avatar';
  let cached = false;
  const modes: boolean[] = [];
  h.setAvatarReader(async (_url, cachedOnly) => {
    modes.push(cachedOnly);
    return cached ? Buffer.from('cached picture') : null;
  });
  await h.capture([
    {
      entity,
      category: 'profile.profilesByUids',
      source: 'local',
      value: { avatarUrl: 'https://example.test/a', nick: 'A' },
      at: 100,
    },
  ]);
  expect((await h.fieldSummary(entity)).fields).toEqual([]);
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(0);
  cached = true;
  await h.fieldSummary(entity);
  expect((await h.fieldVersions(entity, 'avatar')).rows).toHaveLength(1);
  expect(modes.every(Boolean)).toBe(true);
});
it('升级自动重建旧字段索引且不删除原始观察版本', async () => {
  const h = await open();
  const entity = 'friend:u_upgrade';
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { nick: 'A' },
    at: 100,
  });
  await h.fieldSummary(entity);
  const entry = opened.at(-1)!;
  await h.dispose();
  const db = new DatabaseSync(join(entry.root, 'history.sqlite'));
  db.exec(
    "UPDATE field_index_meta SET version=3 WHERE key='format'; UPDATE field_versions SET value='\"stale\"';",
  );
  db.close();
  entry.history = new ContactHistoryService(entry.root);
  await entry.history.migration;
  expect((await entry.history.fieldSummary(entity)).fields).toEqual([]);
  expect((await entry.history.fieldVersions(entity, 'nick')).rows.map((r) => r.value)).toEqual([
    'A',
  ]);
  expect((await entry.history.list(entity)).rows).toHaveLength(1);
});
it('详细资料的 null 表示未返回，不覆盖历史；空字符串明确清空会产生变化', async () => {
  const h = await open();
  const entity = 'friend:u_details';
  await h.observe({
    entity,
    category: 'details',
    source: 'online',
    value: { company: '旧公司', errors: {} },
    at: 100,
  });
  await h.observe({
    entity,
    category: 'details',
    source: 'online',
    value: { company: null, errors: {} },
    at: 200,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual([]);
  await h.observe({
    entity,
    category: 'details',
    source: 'online',
    value: { company: '', errors: {} },
    at: 300,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual(['company']);
  expect((await h.fieldVersions(entity, 'company')).rows.map((row) => row.value)).toEqual([
    '',
    '旧公司',
  ]);
});
it('字段投影不把缺字段、失败项或不同标签顺序当成新内容', () => {
  expect(
    projectContactHistoryFields('details', {
      company: null,
      email: '',
      personalDescription: null,
      errors: {},
    }),
  ).toEqual([['email', '']]);
  expect(projectContactHistoryFields('getPeerStats', { level: null, likeCount: 12 })).toEqual([
    ['likes', 12],
  ]);
  expect(projectContactHistoryFields('metric.level', { state: 'failed', value: null })).toEqual([]);
  expect(
    projectContactHistoryFields('metric.level', { state: 'stale', value: 30, updatedAt: 100 }),
  ).toEqual([['level', 30]]);
  expect(
    projectContactHistoryFields('personalityPhotos', () => {
      throw new Error('不应解压无关照片正文');
    }),
  ).toEqual([]);
  expect(
    projectContactHistoryFields(
      'getProfile',
      () => {
        throw new Error('群内历史不应读取个人资料');
      },
      'u_peer',
      '123',
    ),
  ).toEqual([]);
  expect(
    projectContactHistoryFields('details', {
      company: '公司',
      email: '坏值',
      errors: { email: '失败' },
    }),
  ).toEqual([['company', '公司']]);
  expect(projectContactHistoryFields('getProfile', { gender: 1 })).toEqual([['gender', 1]]);
  expect(projectContactHistoryFields('getProfile', { nick: '本地昵称', nickname: '别名' })).toEqual(
    [['nick', '本地昵称']],
  );
  expect(projectContactHistoryFields('getProfile', { extInfo: { interests: ['B', 'A'] } })).toEqual(
    [['labels', ['A', 'B']]],
  );
});
it('只有同一来源流里真正发生不同值的项目才出现历史，不显示重复读取或其他字段变化', async () => {
  const h = await open();
  const entity = 'friend:u_fields';
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { nick: 'A', gender: 1 },
    at: 100,
  });
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'online',
    value: { nick: '云端B' },
    at: 110,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual([]);
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { gender: 2 },
    at: 120,
  });
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { nick: 'A', gender: 2 },
    at: 130,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual(['gender']);
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { nick: 'B' },
    at: 140,
  });
  expect((await h.fieldSummary(entity)).fields.sort()).toEqual(['gender', 'nick']);
  const page = await h.fieldVersions(entity, 'gender');
  expect(page.rows.map((row) => row.value)).toEqual([2, 1]);
  expect(page.rows.every((row) => typeof row.value === 'number')).toBe(true);
});
it('复合项目的部分返回保留未返回子字段，明确清空仍是一次变化', async () => {
  const h = await open();
  const entity = 'friend:u_birth';
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { birthYear: 2000, birthMonth: 1, birthDay: 2 },
    at: 100,
  });
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { birthMonth: 1 },
    at: 110,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual([]);
  await h.observe({
    entity,
    category: 'getProfile',
    source: 'local',
    value: { birthMonth: 0 },
    at: 120,
  });
  expect((await h.fieldSummary(entity)).fields).toEqual(['birthday']);
  expect((await h.fieldVersions(entity, 'birthday')).rows[0].value).toEqual({
    birthYear: 2000,
    birthMonth: 0,
    birthDay: 2,
  });
});
it('按批渐进构建并分页保留 A→B→A，重开后复用索引', async () => {
  const h = await open();
  const entity = 'friend:u_pages';
  for (let n = 0; n < 105; n++)
    await h.observe({
      entity,
      category: 'getProfile',
      source: 'local',
      value: { nick: n % 2 ? 'B' : 'A' },
      at: 100 + n,
    });
  expect((await h.fieldSummary(entity)).pending).toBe(true);
  expect((await h.fieldSummary(entity)).pending).toBe(false);
  const first = await h.fieldVersions(entity, 'nick', '', undefined, 30);
  expect(first.rows).toHaveLength(30);
  expect(first.nextBefore).not.toBeNull();
  const second = await h.fieldVersions(entity, 'nick', '', first.nextBefore!, 30);
  expect(second.rows).toHaveLength(30);
  expect(first.rows.some((a) => second.rows.some((b) => a.id === b.id))).toBe(false);
  const entry = opened.at(-1)!;
  await h.dispose();
  entry.history = new ContactHistoryService(entry.root);
  await entry.history.migration;
  expect((await entry.history.fieldSummary(entity)).pending).toBe(false);
  expect((await entry.history.fieldVersions(entity, 'nick')).rows).toHaveLength(30);
});
it('群成员项目隔离群、成员和分页，兼容所在群名单的历史', async () => {
  const h = await open();
  await h.observe({
    entity: 'friend:u_peer',
    category: 'listUserGroups',
    source: 'local',
    value: [
      { groupCode: 123n, uid: 'u_peer', card: 'A' },
      { groupCode: 456n, uid: 'u_peer', card: '其他群' },
    ],
    at: 100,
  });
  await h.observe({
    entity: 'friend:u_peer',
    category: 'listUserGroups',
    source: 'local',
    value: [
      { groupCode: 123n, uid: 'u_peer', card: 'B' },
      { groupCode: 456n, uid: 'u_peer', card: '其他群' },
    ],
    at: 110,
  });
  expect((await h.fieldSummary('group:123', 'u_peer')).fields).toEqual(['card']);
  expect((await h.fieldSummary('group:456', 'u_peer')).fields).toEqual([]);
  expect((await h.fieldSummary('group:123', 'u_other')).fields).toEqual([]);
  expect((await h.fieldVersions('group:123', 'card', 'u_peer')).rows.map((r) => r.value)).toEqual([
    'B',
    'A',
  ]);
  await h.observe({
    entity: 'group:789',
    category: 'listMembersInGroup',
    source: 'local',
    scope: 'page-0',
    value: [{ uid: 'u_peer', card: 'C' }],
    at: 200,
  });
  await h.observe({
    entity: 'group:789',
    category: 'listMembersInGroup',
    source: 'local',
    scope: 'page-100',
    value: [{ uid: 'u_peer', card: 'D' }],
    at: 300,
  });
  expect((await h.fieldSummary('group:789', 'u_peer')).fields).toEqual(['card']);
  expect((await h.fieldVersions('group:789', 'card', 'u_peer')).rows.map((r) => r.value)).toEqual([
    'D',
    'C',
  ]);
});
it('合并 UID 与 QQ 号后重新建立项目索引，不漏掉较早的记录', async () => {
  const h = await open();
  await h.observe({
    entity: 'friend:10001',
    category: 'getProfile',
    source: 'local',
    value: { nick: 'A' },
    at: 100,
  });
  await h.observe({
    entity: 'friend:u_alias',
    category: 'getProfile',
    source: 'local',
    value: { nick: 'B' },
    at: 200,
  });
  expect((await h.fieldSummary('friend:u_alias')).fields).toEqual([]);
  await h.link('u_alias', '10001');
  expect((await h.fieldSummary('friend:u_alias')).fields).toEqual(['nick']);
});

it('群基础资料跨接口去重，未返回不清空，零人数与明确清空保留历史', async () => {
  const h = await open();
  const entity = 'group:12345';
  for (const [at, category, source, value] of [
    [100, 'groupInfo.getGroupDetail', 'local', { groupName: 'A', remark: '备注', memberCount: 2 }],
    [110, 'joinProfile', 'online', { name: '云端名', memberCount: null }],
    [120, 'groupInfo.listAllGroups', 'local', { groupName: 'A', remark: null }],
    [130, 'groupInfo.getGroupDetail', 'local', { groupName: 'B', remark: '', memberCount: 0 }],
  ] as const) await h.observe({ entity, category, source, value, at });
  expect((await h.fieldSummary(entity)).fields.sort()).toEqual(['groupName', 'memberCount', 'remark']);
  expect((await h.fieldVersions(entity, 'remark')).rows.map((row) => row.value)).toEqual(['', '备注']);
  expect((await h.fieldVersions(entity, 'memberCount')).rows.map((row) => row.value)).toEqual([0, 2]);
  expect((await h.fieldSummary('group:54321')).fields).toEqual([]);
  expect((await h.fieldSummary(entity, 'u_peer')).fields).toEqual([]);
});

it('群标签规范顺序，部分返回保留另一类标签；扩展零值不遗漏且不投影头像元数据', async () => {
  const h = await open();
  const entity = 'group:12345';
  await h.observe({ entity, category: 'getGroupDetail', source: 'local', value: { labels: 'B A', customLabels: [{ content: '音乐' }] }, at: 100 });
  await h.observe({ entity, category: 'getGroupDetail', source: 'local', value: { labels: 'A B' }, at: 110 });
  expect((await h.fieldSummary(entity)).fields).toEqual([]);
  await h.observe({ entity, category: 'getGroupDetail', source: 'local', value: { customLabels: [] }, at: 120 });
  expect((await h.fieldSummary(entity)).fields).toEqual(['labels']);
  expect((await h.fieldVersions(entity, 'labels')).rows[0].value).toEqual({ labels: ['A', 'B'], customLabels: [] });
  expect(projectContactHistoryFields('extendedProfile', { grade: 0, activeMemberCount: 0, freezeState: 0, joinedAt: null, portraitSequence: 6, portrait: { count: 1 } }, '', '12345')).toEqual([
    ['grade', 0], ['activeMemberCount', 0], ['freezeState', 0],
  ]);
});

it('升级群字段索引后读取已有历史，原始观察及个人和成员历史均保留', async () => {
  const h = await open();
  for (const [at, groupName] of [[100, 'A'], [110, 'B']] as const)
    await h.observe({ entity: 'group:12345', category: 'getGroupDetail', source: 'local', value: { groupName }, at });
  await h.fieldSummary('group:12345');
  const entry = opened.at(-1)!;
  await h.dispose();
  const db = new DatabaseSync(join(entry.root, 'history.sqlite'));
  db.exec("UPDATE field_index_meta SET version=4 WHERE key='format'; DELETE FROM field_versions; DELETE FROM field_changed;");
  db.close();
  entry.history = new ContactHistoryService(entry.root);
  await entry.history.migration;
  expect((await entry.history.fieldSummary('group:12345')).fields).toEqual(['groupName']);
  expect((await entry.history.fieldVersions('group:12345', 'groupName')).rows.map((row) => row.value)).toEqual(['B', 'A']);
  expect((await entry.history.list('group:12345')).rows).toHaveLength(2);
});
