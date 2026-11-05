import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  UnreadInfoDb,
  UNREAD_OUTGOING_PAGE_SIZE,
  withDatabasePriority,
  scheduleDatabase,
} from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-pages-'));
  roots.push(root);
  const path = join(root, 'msg.db'),
    nt = createSqliteStub();
  let sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40027" INTEGER);
    CREATE TABLE group_msg_table("40027" INTEGER,"40003" INTEGER,"40020" TEXT,"40033" INTEGER);
    CREATE INDEX group_partition_seq ON group_msg_table("40027","40003");
    INSERT INTO recent_contact_v3_table VALUES ('70001',2,2,NULL)`);
  const db = new UnreadInfoDb(nt, { dbPath: path });
  await db.setReadState(2, '70001', '0', '2', false);
  sql = fixtureDb(path);
  const insert = sql.prepare(
    'INSERT INTO group_msg_table(rowid,"40027","40003","40020","40033") VALUES(?,?,?,?,?)',
  );
  insert.setReadBigInts(true);
  const count = UNREAD_OUTGOING_PAGE_SIZE * 2 + 9;
  const base = 9007199254740993000n;
  for (let i = 0; i < count; i++) insert.run(base + BigInt(i), 70001, 1, 'u_peer', 10002);
  return { path, sql, nt, db, insert, count, base };
}
const self = { selfUid: 'u_self', selfUin: '10001' };
const targets = [{ chatType: 2, uid: '70001' }];

it('零条自己发言仍分块读取，同 seq 大段与 64 位 rowid 不漏页且命中排序索引', async () => {
  const f = await fixture();
  const execute = vi.spyOn(f.nt, 'executeSql');
  const rows = await f.db.getUnreadInfos(targets, self);
  expect(rows[0]?.outgoingSeqs).toEqual([]);
  const calls = execute.mock.calls.filter(([, query]) => query.includes('group_msg_table'));
  expect(calls).toHaveLength(Math.ceil(f.count / UNREAD_OUTGOING_PAGE_SIZE) + 1);
  for (const [path, query, params] of calls) {
    expect(path).toBe(f.path);
    expect(params?.at(-1)).toBe(BigInt(UNREAD_OUTGOING_PAGE_SIZE));
    const statement = f.sql.prepare(`EXPLAIN QUERY PLAN ${query}`);
    const plan = statement
      .all(...(params ?? []))
      .map((row) => String(row.detail))
      .join('\n');
    expect(plan).toContain('USING INDEX group_partition_seq');
    expect(plan).not.toContain('TEMP B-TREE');
    if (query.includes('m.rowid > ?')) {
      const operations = f.sql.prepare(`EXPLAIN ${query}`).all(...(params ?? []));
      expect(operations.some((row) => row.opcode === 'SeekGT' && String(row.p4) === '3')).toBe(
        true,
      );
    }
    const result = await f.nt.executeSql(path, query, params);
    expect(result.length).toBeLessThanOrEqual(UNREAD_OUTGOING_PAGE_SIZE);
  }
});

it('跨页自己发言去重，UID/UIN 任一匹配成立，边界和其他群不混入', async () => {
  const f = await fixture();
  f.sql.exec('UPDATE group_msg_table SET "40020"=\'u_self\'');
  f.insert.run(1n, 70001, 0, 'u_self', 10001);
  f.insert.run(2n, 70001, 2, null, 10001);
  f.insert.run(3n, 70001, 3, 'u_self', 10001);
  f.insert.run(4n, 70002, 2, 'u_self', 10001);
  expect((await f.db.getUnreadInfos(targets, self))[0]?.outgoingSeqs).toEqual(['1', '2']);
});

it('普通递增序号跨满页前进，不遗漏页末、下一页首条和最后一页的自己发言', async () => {
  const f = await fixture();
  const sequenceUpdate = f.sql.prepare('UPDATE group_msg_table SET "40003"=rowid-?+1');
  sequenceUpdate.setReadBigInts(true);
  sequenceUpdate.run(f.base);
  const watermarkUpdate = f.sql.prepare('UPDATE recent_contact_v3_table SET "40003"=?');
  watermarkUpdate.setReadBigInts(true);
  watermarkUpdate.run(f.count + 1);
  const expected = [UNREAD_OUTGOING_PAGE_SIZE, UNREAD_OUTGOING_PAGE_SIZE + 1, f.count];
  const senderUpdate = f.sql.prepare(
    'UPDATE group_msg_table SET "40020"=\'u_self\' WHERE "40003" IN (?,?,?)',
  );
  senderUpdate.setReadBigInts(true);
  senderUpdate.run(...expected);
  expect((await f.db.getUnreadInfos(targets, self))[0]?.outgoingSeqs).toEqual(expected.map(String));
});

it('私聊索引分页保留 NULL 判定，未索引 UID 回退仍保持原有结果', async () => {
  const f = await fixture();
  await f.db.setReadState(1, 'u_friend', '0', '2', false);
  await f.db.setReadState(1, 'u_fallback', '0', '2', false);
  const sql = fixtureDb(f.path);
  sql.exec(`CREATE TABLE c2c_msg_table("40027" INTEGER,"40003" INTEGER,"40020" TEXT,"40021" TEXT);
    CREATE INDEX direct_partition_seq ON c2c_msg_table("40027","40003");
    INSERT INTO recent_contact_v3_table VALUES ('u_friend',2,1,42),('u_fallback',2,1,NULL);
    INSERT INTO c2c_msg_table VALUES
      (42,1,'u_self','u_friend'),(42,1,'u_friend','u_friend'),
      (42,2,'u_self',NULL),(42,2,NULL,'u_friend'),(42,2,'','u_friend'),
      (43,2,'u_self','u_other'),(44,2,'u_self','u_fallback')`);
  const rows = await f.db.getUnreadInfos(
    [
      { chatType: 1, uid: 'u_friend' },
      { chatType: 1, uid: 'u_fallback' },
    ],
    self,
  );
  expect(rows.map((row) => row.outgoingSeqs)).toEqual([['1'], ['2']]);
});

it('分页期间追加的新尾页不越过本次水位，失败与取消不交付部分计数', async () => {
  const f = await fixture();
  const execute = f.nt.executeSql.bind(f.nt);
  let pages = 0;
  vi.spyOn(f.nt, 'executeSql').mockImplementation(async (path, query, params) => {
    const rows = await execute(path, query, params);
    if (query.includes('group_msg_table') && ++pages === 1)
      f.insert.run(1n, 70001, 3, 'u_self', 10001);
    return rows;
  });
  expect((await f.db.getUnreadInfos(targets, self))[0]?.outgoingSeqs).toEqual([]);
  const controller = new AbortController();
  pages = 0;
  vi.spyOn(f.nt, 'executeSql').mockImplementation(async (path, query, params) => {
    const rows = await execute(path, query, params);
    if (query.includes('group_msg_table')) {
      pages++;
      controller.abort();
    }
    return rows;
  });
  await expect(
    withDatabasePriority('background', () => f.db.getUnreadInfos(targets, self), controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(pages).toBe(1);
  const failure = new Error('synthetic page failure');
  pages = 0;
  vi.spyOn(f.nt, 'executeSql').mockImplementation(async (path, query, params) => {
    if (query.includes('group_msg_table') && ++pages === 2) throw failure;
    return execute(path, query, params);
  });
  await expect(f.db.getUnreadInfos(targets, self)).rejects.toBe(failure);
});

it('后台统计在分页间让出，同 native 绑定的首屏可以先于下一页执行', async () => {
  const f = await fixture();
  const execute = f.nt.executeSql.bind(f.nt),
    order: string[] = [];
  let release!: () => void;
  vi.spyOn(f.nt, 'executeSql').mockImplementation(async (path, query, params) => {
    const rows = await execute(path, query, params);
    if (query.includes('group_msg_table')) {
      order.push('page');
      if (order.length === 1)
        await new Promise<void>((done) => {
          release = done;
        });
    }
    return rows;
  });
  const count = withDatabasePriority('background', () => f.db.getUnreadInfos(targets, self));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const foreground = scheduleDatabase(
    f.path,
    async () => {
      order.push('foreground');
    },
    f.nt,
  );
  release();
  await Promise.all([count, foreground]);
  expect(order.slice(0, 3)).toEqual(['page', 'foreground', 'page']);
});
