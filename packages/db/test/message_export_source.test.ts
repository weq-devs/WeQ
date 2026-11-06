import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb, GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-export-source-'));
  const path = join(root, 'messages.db'),
    sql = fixtureDb(path);
  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER, "40021" TEXT, "40027" TEXT, "40035" INTEGER, "40800" BLOB, "999991" BLOB, "future""column" TEXT)`,
    );
    const insert = sql.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(1, 'peer', '777', 50, null, Buffer.from([255, 0, 254]), '未知列');
    insert.run(1, 'other', '888', 51, null, Buffer.from([1]), '不应导出');
    insert.run(2, 'peer', '777', 50, null, Buffer.from([2]), '未选消息');
  }
  return {
    sql,
    group: new GroupMsgDb(createSqliteStub(), { dbPath: path }),
    c2c: new C2cMsgDb(createSqliteStub(), { dbPath: path }),
  };
}
it('正式导出按真实列枚举，保留未知 BLOB 与带引号的列名，不夹带其他群或消息', async () => {
  const { group } = fixture();
  const rows = await group.exportSourceRows('777', ['1']);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.columns['999991']).toEqual(new Uint8Array([255, 0, 254]));
  expect(rows[0]?.columns['future"column']).toBe('未知列');
  expect(String(rows[0]?.message.msgId)).toBe('1');
});
it('私聊与服务号分别用自己的分区字段；空精确集合不退化成全表', async () => {
  const { c2c } = fixture();
  const peer = await c2c.exportSourceRows({ uid: 'peer' }, ['1']);
  const service = await c2c.exportSourceRows({ appId: 50n }, ['1']);
  expect(peer).toHaveLength(1);
  expect(service).toHaveLength(1);
  expect(service[0]?.columns['40035']).toBe(50n);
  expect(await c2c.exportSourceRows({ uid: 'peer' }, [])).toEqual([]);
});
