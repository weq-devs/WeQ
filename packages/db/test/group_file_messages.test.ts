import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir: string;
let db: GroupMsgDb;
let add: (id: number, seq: number, token: string, type?: number, group?: string) => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-file-messages-'));
  const dbPath = join(dir, 'fixture.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE group_msg_table (
    "40001" INTEGER, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
    "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
    "40050" INTEGER, "40062" BLOB, "40800" BLOB, "40801" BLOB);
    CREATE INDEX group_seq ON group_msg_table ("40027", "40003");`);
  const insert = sql.prepare('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const codec = new ProtoMsg(MsgBody);
  add = (id, seq, token, type = 3, group = '777') => {
    // 独立构造 QQ 的 file(3) / text(1) 正文，不复用待测匹配器。
    const body = codec.encode({
      elements: [
        {
          elementType: type,
          fileName: '同名文件.txt',
          fileToken: token,
          textContent: token,
        },
      ],
    });
    insert.run(id, id, seq, 2, 0, 'u_fixture', group, 10001, 1000 + id, null, body, null);
  };
  db = new GroupMsgDb(createSqliteStub(), { dbPath });
});
afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

it('只返回当前群的精确文件元素，排除同名、文本、子串及无序号消息', async () => {
  add(1, 10, '/file-id');
  add(2, 11, '/file-id');
  add(3, 12, '/file-id', 3, '888');
  add(4, 13, '/other-id');
  add(5, 14, '/file-id', 1);
  add(6, 15, '/file-id-suffix');
  add(7, 0, '/file-id');
  const page = await db.findFileMessages('777', '/file-id');
  expect(page.messages.map((row) => row.msgId)).toEqual([2n, 1n]);
  expect(page.nextBefore).toBeNull();
  expect((await db.findFileMessages('777', 'missing')).messages).toEqual([]);
  expect((await db.findFileMessages('777', '')).messages).toEqual([]);
});

it('候选分页保留同序号的所有消息，不因非文件候选吞掉更早的匹配', async () => {
  add(1, 20, 'token');
  for (let id = 2; id <= 53; id++) add(id, 20, 'token', id === 53 ? 3 : 1);
  const first = await db.findFileMessages('777', 'token');
  expect(first.messages.map((row) => row.msgId)).toEqual([53n]);
  expect(first.nextBefore).not.toBeNull();
  const second = await db.findFileMessages('777', 'token', first.nextBefore!);
  expect(second.messages.map((row) => row.msgId)).toEqual([1n]);
  expect(second.nextBefore).toBeNull();
});
