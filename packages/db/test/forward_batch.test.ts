import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ForwardMsgDb } from '@weq/db';
import { ProtoMsg } from '@weq/codec';
import { MsgCacheBody } from '@weq/codec/proto/msg/40900';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root: string;
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('批量引用按真实 ID 返回，分批有界，坏缓存和另一个表不串消息', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-forward-batch-'));
  const dbPath = join(root, 'msg.db'),
    sql = fixtureDb(dbPath);
  for (const table of ['group_msg_table', 'c2c_msg_table'])
    sql.exec(`CREATE TABLE ${table} ("40001" INTEGER PRIMARY KEY, "40900" BLOB)`);
  const codec = new ProtoMsg(MsgCacheBody);
  const insert = sql.prepare('INSERT INTO group_msg_table VALUES (?, ?)');
  insert.setReadBigInts(true);
  const large = 7695126900078041334n;
  insert.run(large, codec.encode({ msgs: [{ msgSeq: 41 }] }));
  insert.run(2n, new Uint8Array([255]));
  sql
    .prepare('INSERT INTO c2c_msg_table VALUES (?, ?)')
    .run(1, codec.encode({ msgs: [{ msgSeq: 99 }] }));
  const nt = createSqliteStub(),
    execute = vi.spyOn(nt, 'executeSql');
  const db = new ForwardMsgDb(nt, { dbPath });
  const ids = [large, ...Array.from({ length: 256 }, (_, i) => BigInt(i + 1))];
  const rows = await db.listForMessages('group', ids);
  expect(rows.get(large)?.[0]?.msgSeq).toBe(41);
  expect(rows.get(2n)).toEqual([]);
  expect(rows.has(1n)).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
  expect((await db.listForMessages('c2c', [1n])).get(1n)?.[0]?.msgSeq).toBe(99);
  execute.mockClear();
  expect(await db.listForMessages('group', [])).toEqual(new Map());
  expect(execute).not.toHaveBeenCalled();
});
