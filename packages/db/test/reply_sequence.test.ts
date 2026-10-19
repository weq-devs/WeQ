import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('私聊引用按会话、client sequence、发送者及时间消歧，不把 client sequence 当会话序号', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-reply-seq-'));
  const dbPath = join(root, 'synthetic.db');
  fixtureDb(
    dbPath,
  ).exec(`CREATE TABLE c2c_msg_table ("40021" TEXT,"40027" INTEGER,"40003" INTEGER,"40005" INTEGER,"40033" INTEGER,"40050" INTEGER);
    INSERT INTO c2c_msg_table VALUES ('u_peer',1,120,7,20002,1700000000),('u_peer',1,121,7,10001,1700000001),('u_other',2,999,7,20002,1700000000)`);
  const db = new C2cMsgDb(createSqliteStub(), { dbPath });
  expect(await db.resolveReplySeq({ sortNo: 1n }, 7n, 20002n, 1700000000n)).toBe(120n);
  expect(await db.resolveReplySeq({ uid: 'u_peer' }, 7n, 10001n)).toBe(121n);
  expect(await db.resolveReplySeq({ uid: 'u_peer' }, 7n)).toBeNull();
  expect(await db.resolveReplySeq({ uid: 'u_missing' }, 7n)).toBeNull();
});
