import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageReadIndexDb } from '@weq/db';
import { QqDb } from '../src/qq_db';
import { MESSAGE_READ_INDEX_COLUMNS } from '../src/msg/message_read_index';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-read-index-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  fixtureDb(
    path,
  ).exec(`CREATE TABLE c2c_msg_table("40001" INTEGER PRIMARY KEY,"40021" TEXT,"40003" INTEGER,"40050" INTEGER,"40027" INTEGER);
    INSERT INTO c2c_msg_table VALUES (1,'u_peer',4,100,10),(2,'u_peer',4,101,11),(3,'u_other',9,120,12)`);
  const nt = createSqliteStub();
  return {
    path,
    nt,
    db: new MessageReadIndexDb(nt, { dbPath: path }),
    qq: new QqDb(nt, { dbPath: path }),
  };
}

it('缺失 UID 索引只安装一次，所有分区的数据一致且分页不再排序扫描', async () => {
  const f = fixture();
  const writes = vi.spyOn(f.nt, 'executeSqlWrite');
  expect(await f.db.ensure()).toEqual(['c2c_msg_table']);
  expect(await f.db.ensure()).toEqual(['c2c_msg_table']);
  expect(writes).toHaveBeenCalledOnce();
  const sql = fixtureDb(f.path);
  const query =
    'SELECT "40001" FROM c2c_msg_table WHERE "40021"=? ORDER BY "40003" DESC,"40050" DESC,"40001" DESC LIMIT 10';
  expect(
    sql
      .prepare(query)
      .all('u_peer')
      .map((r) => r['40001']),
  ).toEqual([2, 1]);
  const plan = sql
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all('u_peer')
    .map((r) => String(r.detail))
    .join('\n');
  expect(plan).toContain('USING COVERING INDEX weq_read_uid_seq_c2c');
  expect(plan).not.toContain('SCAN c2c_msg_table');
  expect(plan).not.toContain('TEMP B-TREE');
  sql.exec(`INSERT INTO c2c_msg_table VALUES(4,'u_peer',5,102,13);
    UPDATE c2c_msg_table SET "40021"='u_other' WHERE "40001"=2;
    DELETE FROM c2c_msg_table WHERE "40001"=1`);
  expect(
    sql
      .prepare(query)
      .all('u_peer')
      .map((r) => r['40001']),
  ).toEqual([4]);
});

it('只识别完整非局部前缀，不把单 UID 索引或局部索引误当完整读取索引', async () => {
  const f = fixture();
  fixtureDb(f.path).exec(`CREATE INDEX uid_only ON c2c_msg_table("40021");
    CREATE INDEX partial_read ON c2c_msg_table("40021","40003","40050","40001") WHERE "40027"=10`);
  expect(await f.qq.hasIndexPrefix('c2c_msg_table', MESSAGE_READ_INDEX_COLUMNS)).toBe(false);
  await f.db.ensure();
  expect(await f.qq.hasIndexPrefix('c2c_msg_table', MESSAGE_READ_INDEX_COLUMNS)).toBe(true);
});

it('保留已有等价索引，取消空闲等待不写入，名称冲突不冒称成功', async () => {
  const f = fixture();
  const writes = vi.spyOn(f.nt, 'executeSqlWrite');
  expect(await f.db.ensure({ beforeCreate: async () => false })).toEqual([]);
  expect(writes).not.toHaveBeenCalled();
  fixtureDb(f.path).exec('CREATE INDEX weq_read_uid_seq_c2c ON c2c_msg_table("40027")');
  await expect(f.db.ensure()).rejects.toThrow('占用');
  fixtureDb(f.path).exec(
    `CREATE INDEX equivalent ON c2c_msg_table("40021","40003","40050","40001")`,
  );
  writes.mockClear();
  expect(await f.db.ensure()).toEqual(['c2c_msg_table']);
  expect(writes).not.toHaveBeenCalled();
});
