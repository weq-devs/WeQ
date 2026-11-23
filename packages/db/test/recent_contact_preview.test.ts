import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RecentContactDb } from '@weq/db';
import { ProtoMsg, ChatType } from '@weq/codec';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { RECENT_CONTACT_PREVIEW_CACHE_LIMITS } from '../src/contact/recent_contact';

let root = '';
let db: RecentContactDb | undefined;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-recent-preview-'));
  const path = join(root, 'nt_msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE recent_contact_v3_table (
    "40003" INTEGER, "40010" INTEGER, "40020" TEXT, "40021" TEXT, "40030" INTEGER,
    "40050" INTEGER, "40051" BLOB, "40090" TEXT, "40093" TEXT, "40094" TEXT,
    "40095" TEXT, "41110" TEXT, "41135" TEXT, "41148" TEXT, "41220" INTEGER,
    "60001" INTEGER, "41103" INTEGER, "41104" INTEGER)`);
  const nt = createSqliteStub();
  db = new RecentContactDb(nt, { dbPath: path });
  return { sql, db, nt };
}

const preview = (text: string) =>
  new ProtoMsg(RecentContactBody).encode({ preview: [{ elementType: 1, textContent: text }] });

it('水位只解码变化块，保留 64 位序号以及新增、删除与下调', async () => {
  const { sql, db } = createFixture();
  const insert = sql.prepare(`INSERT INTO recent_contact_v3_table
    (rowid,"40021","40010","40003","40050") VALUES (?,?,?,?,?)`);
  insert.run(1, 'u_old', 1, 9007199254740997n, 123);
  insert.run(64, 'u_removed', 1, 7, 100);
  insert.run(128, 'u_other', 2, 20, 200);
  const first = await db.listSeqWatermarks();
  expect(first[0]?.msgSeq).toBe(9007199254740997n);
  expect(await db.listSeqWatermarks()).toBe(first);
  sql.exec(`DELETE FROM recent_contact_v3_table WHERE rowid=64;
    UPDATE recent_contact_v3_table SET "40003"=18 WHERE rowid=128;`);
  insert.run(192, 'u_arrived', 2, 30, 240);
  const next = await db.listSeqWatermarks();
  expect(next[0]).toBe(first[0]);
  expect(next.map(({ targetUid, msgSeq }) => [targetUid, msgSeq])).toEqual([
    ['u_old', 9007199254740997n],
    ['u_other', 18n],
    ['u_arrived', 30n],
  ]);
});

it('旧格式水位仍采用原转换，不把十六进制序号丢成零', async () => {
  const { sql, db } = createFixture();
  sql.exec(`INSERT INTO recent_contact_v3_table ("40021","40010","40003","40050") VALUES
    ('u_backup', 1, '0x32', 100)`);
  expect(await db.listSeqWatermarks()).toEqual([
    { targetUid: 'u_backup', chatType: 1, msgSeq: 50n, sendTime: 100n },
  ]);
});

it('轻量目录保留原分页及元数据，正文只有定向补读时才解码', async () => {
  const { sql, db } = createFixture();
  const insert = sql.prepare(`INSERT INTO recent_contact_v3_table
    ("40003","40010","40021","40050","40051","40094","41220","41103","41104")
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run(3, 1, 'u_first', 300, preview('首屏'), '首屏', 1, 0, 0);
  insert.run(2, 1, 'u_hidden', 250, preview('被排除'), '过滤项', 4, 0, 0);
  insert.run(1, 2, '12345', 200, preview('旧群预览'), '旧群', 2, 150, 1);
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  const [summary] = await db.getRecentContact(1, 1, { summaryOnly: true, excludeChatTypes: [1] });
  expect(summary).toBeUndefined();
  const [group] = await db.getRecentContact(1, 2, { summaryOnly: true });
  expect(group).toMatchObject({
    targetUid: '12345',
    msgSeq: 1n,
    sendTime: 200n,
    preview: null,
    targetDisplayName: '旧群',
    notifyLevel: 2,
    topTime: 150n,
    pinned: true,
  });
  expect(decode).not.toHaveBeenCalled();
  const [loaded] = await db.getByTargetUids(['12345']);
  expect(loaded?.preview).toMatchObject({ kind: 'text', textContent: '旧群预览' });
  expect({ ...loaded, preview: null }).toEqual(group);
});

it('读取全部会话时不截在一千条，混排预览保留文字与表情的顺序', async () => {
  const { sql, db } = createFixture();
  const blob = new ProtoMsg(RecentContactBody).encode({
    preview: [
      { elementType: 1, textContent: '你好' },
      { elementType: 6, faceId: 14, displayText: '/微笑' },
      { elementType: 1, textContent: '！' },
    ],
  });
  const insert = sql.prepare(
    `INSERT INTO recent_contact_v3_table ("40010", "40021", "40050", "40051") VALUES (?, ?, ?, ?)`,
  );
  for (let i = 0; i < 1050; i++) insert.run(ChatType.KCHATTYPEC2C, `u_test${i}`, i, blob);
  const all = await db.getRecentContact(-1);
  expect(all).toHaveLength(1050);
  expect(all[0]?.preview?.previewElements).toMatchObject([
    { kind: 'text', textContent: '你好' },
    { kind: 'face', faceId: 14 },
    { kind: 'text', textContent: '！' },
  ]);
});

it('相同原始预览跨头页、目标与搜索查询只解码一次，其他资料仍读取最新值', async () => {
  const { sql, db } = createFixture();
  sql
    .prepare(
      `INSERT INTO recent_contact_v3_table ("40003","40010","40021","40050","40051","40094") VALUES (1,1,'u_cache',100,?,'合成会话')`,
    )
    .run(preview('原始预览'));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  const first = (await db.getRecentContact())[0]!;
  expect((await db.getByTargetUids(['u_cache']))[0]!.preview).toBe(first.preview);
  expect((await db.searchByName('合成会话')).items[0]!.preview).toBe(first.preview);
  sql.exec(
    `UPDATE recent_contact_v3_table SET "40003"=2,"40050"=101,"40094"='新名称',"41135"='新备注',"41220"=4,"41104"=1`,
  );
  const updated = (await db.getRecentContact())[0]!;
  expect(updated).toMatchObject({
    msgSeq: 2n,
    sendTime: 101n,
    targetDisplayName: '新名称',
    targetRemark: '新备注',
    notifyLevel: 4,
    pinned: true,
  });
  expect(updated.preview).toBe(first.preview);
  expect(decode).toHaveBeenCalledTimes(1);
  db.close();
  expect((await db.getRecentContact())[0]!.preview).toEqual(first.preview);
  expect(decode).toHaveBeenCalledTimes(2);
});

it('同序号同时间的预览修改立即更新，移除预览不能沿用旧缓存', async () => {
  const { sql, db } = createFixture();
  sql
    .prepare(
      `INSERT INTO recent_contact_v3_table ("40003","40010","40021","40050","40051") VALUES (1,1,'u_cache',100,?)`,
    )
    .run(preview('第一版'));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  const first = (await db.getRecentContact())[0]!;
  const changedBlob = new ProtoMsg(RecentContactBody).encode({
    preview: [
      { elementType: 1, textContent: '第二版' },
      { elementType: 6, faceId: 14, displayText: '/微笑' },
    ],
  });
  sql.prepare(`UPDATE recent_contact_v3_table SET "40051"=?`).run(changedBlob);
  const changed = (await db.getRecentContact())[0]!;
  expect(changed.msgSeq).toBe(first.msgSeq);
  expect(changed.sendTime).toBe(first.sendTime);
  expect(changed.preview?.previewElements).toMatchObject([
    { kind: 'text', textContent: '第二版' },
    { kind: 'face', faceId: 14 },
  ]);
  expect(changed.preview).not.toBe(first.preview);
  expect(decode).toHaveBeenCalledTimes(2);
  sql.exec(`UPDATE recent_contact_v3_table SET "40051"=NULL`);
  expect((await db.getRecentContact())[0]!.preview).toBeNull();
  sql.prepare(`UPDATE recent_contact_v3_table SET "40051"=?`).run(changedBlob);
  expect((await db.getRecentContact())[0]!.preview).toEqual(changed.preview);
  expect(decode).toHaveBeenCalledTimes(3);
});

it('缓存持有独立字节，原生返回缓冲区被复用也不会把新预览误判为未变化', async () => {
  const { sql, db, nt } = createFixture();
  const before = preview('甲');
  const after = preview('乙');
  expect(before.byteLength).toBe(after.byteLength);
  sql
    .prepare(`INSERT INTO recent_contact_v3_table ("40010","40021","40051") VALUES (1,'u_cache',?)`)
    .run(before);
  const execute = nt.executeSql.bind(nt);
  let nativeBlob: Uint8Array | undefined;
  vi.spyOn(nt, 'executeSql').mockImplementation(async (...args) => {
    const rows = await execute(...args);
    if (!nativeBlob && rows[0]?.[6] instanceof Uint8Array) nativeBlob = rows[0][6];
    return rows;
  });
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  expect((await db.getRecentContact())[0]?.preview).toMatchObject({ textContent: '甲' });
  expect(nativeBlob).toBeInstanceOf(Uint8Array);
  nativeBlob!.set(after);
  sql.prepare(`UPDATE recent_contact_v3_table SET "40051"=?`).run(after);
  expect((await db.getRecentContact())[0]?.preview).toMatchObject({ textContent: '乙' });
  expect(decode).toHaveBeenCalledTimes(2);
});

it('相同标识的不同会话类型独立复用预览', async () => {
  const { sql, db } = createFixture();
  const insert = sql.prepare(
    `INSERT INTO recent_contact_v3_table ("40010","40021","40051") VALUES (?,'same-id',?)`,
  );
  insert.run(1, preview('私聊'));
  insert.run(2, preview('群聊'));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  const first = await db.getRecentContact();
  const second = await db.getByTargetUids(['same-id']);
  expect(second.map((row) => row.preview)).toEqual(first.map((row) => row.preview));
  expect(decode).toHaveBeenCalledTimes(2);
});

it('预览缓存按 LRU 限制条数，不裁掉返回会话，近期访问仍命中', async () => {
  const { sql, db } = createFixture();
  const { entries } = RECENT_CONTACT_PREVIEW_CACHE_LIMITS;
  const insert = sql.prepare(
    `INSERT INTO recent_contact_v3_table ("40010","40021","40050","40051") VALUES (1,?,?,?)`,
  );
  for (let i = 0; i < entries; i++) insert.run(`u_${i}`, i, preview(String(i)));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  const all = await db.getRecentContact(-1);
  expect(all).toHaveLength(entries);
  const retained = all[0]!;
  const evicted = all[1]!;
  expect((await db.getByTargetUids([retained.targetUid]))[0]!.preview).toBe(retained.preview);
  insert.run('u_new', entries, preview('新预览'));
  await db.getByTargetUids(['u_new']);
  expect((await db.getByTargetUids([retained.targetUid]))[0]!.preview).toBe(retained.preview);
  expect((await db.getByTargetUids([evicted.targetUid]))[0]!.preview).toEqual(evicted.preview);
  expect(decode).toHaveBeenCalledTimes(entries + 2);
  expect(await db.countRecentContact()).toBe(entries + 1);
});

it('缓存同时限制原始字节总量，未达到条数上限也会淘汰', async () => {
  const { sql, db } = createFixture();
  const { sourceBytes, entryBytes, entries } = RECENT_CONTACT_PREVIEW_CACHE_LIMITS;
  const blob = preview('x'.repeat(Math.floor(entryBytes / 2)));
  expect(blob.byteLength).toBeLessThan(entryBytes);
  const count = Math.floor(sourceBytes / blob.byteLength) + 1;
  expect(count).toBeLessThan(entries);
  const insert = sql.prepare(
    `INSERT INTO recent_contact_v3_table ("40010","40021","40050","40051") VALUES (1,?,?,?)`,
  );
  for (let i = 0; i < count; i++) insert.run(`u_${i}`, i, blob);
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  expect(await db.getRecentContact(-1)).toHaveLength(count);
  await db.getByTargetUids([`u_${count - 1}`]);
  expect(decode).toHaveBeenCalledTimes(count + 1);
});

it('超出单项预算只跳过缓存，仍返回完整预览', async () => {
  const { sql, db } = createFixture();
  const text = 'x'.repeat(RECENT_CONTACT_PREVIEW_CACHE_LIMITS.entryBytes + 1);
  sql
    .prepare(`INSERT INTO recent_contact_v3_table ("40010","40021","40051") VALUES (1,'u_large',?)`)
    .run(preview(text));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  for (let i = 0; i < 2; i++)
    expect((await db.getRecentContact())[0]?.preview).toMatchObject({ textContent: text });
  expect(decode).toHaveBeenCalledTimes(2);
});
