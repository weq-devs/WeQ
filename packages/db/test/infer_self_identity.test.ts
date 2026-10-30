import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb, GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const SELF_UIN = 12345;
const SELF_UID = 'u_self';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-infer-identity-'));
  const path = join(root, 'nt_msg.db');
  const sql = fixtureDb(path);
  for (const table of ['c2c_msg_table', 'group_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER,"40003" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40033" INTEGER,"40040" INTEGER,"40050" INTEGER,"40800" BLOB)`,
    );
  }
  return {
    path,
    sql,
    c2c: new C2cMsgDb(createSqliteStub(), { dbPath: path }),
    group: new GroupMsgDb(createSqliteStub(), { dbPath: path }),
  };
}

it('私聊从 40020≠40021 的自证行取本人 uin 与 uid', async () => {
  const { sql, c2c } = fixture();
  const add = sql.prepare(
    `INSERT INTO c2c_msg_table ("40001","40003","40020","40021","40033","40050") VALUES (?,?,?,?,?,?)`,
  );
  // 自己发的：40020 是本账号 uid，40021 恒为对端 —— 两者不等，是自证行。
  for (let i = 0; i < 3; i++) add.run(i, i, SELF_UID, 'u_peer', SELF_UIN, i);
  // 对端发来的：40020 = 40021 = 对端 uid，不是自证行（行数更多也不能当选）。
  for (let i = 0; i < 5; i++) add.run(10 + i, 10 + i, 'u_peer', 'u_peer', 99999, i);

  expect(await c2c.inferSelfIdentity()).toEqual({ uin: BigInt(SELF_UIN), uid: SELF_UID });
  expect(await c2c.inferSelfUin()).toBe(BigInt(SELF_UIN));
});

it('私聊推断排除 40020 被写成纯数字的占位行', async () => {
  const { sql, c2c } = fixture();
  const add = sql.prepare(
    `INSERT INTO c2c_msg_table ("40001","40003","40020","40021","40033","40050") VALUES (?,?,?,?,?,?)`,
  );
  add.run(1, 1, SELF_UID, 'u_peer', SELF_UIN, 1);
  // 删除/撤回留下的占位行：40020 直接是群号（纯数字），行数更多也不能当选。
  for (let i = 0; i < 5; i++) add.run(2 + i, 2 + i, '777', 'u_peer', 777, i);

  expect(await c2c.inferSelfIdentity()).toEqual({ uin: BigInt(SELF_UIN), uid: SELF_UID });
});

it('私聊没有任何自证行时返回空身份', async () => {
  const { sql, c2c } = fixture();
  sql
    .prepare(
      `INSERT INTO c2c_msg_table ("40001","40003","40020","40021","40033","40050") VALUES (?,?,?,?,?,?)`,
    )
    .run(1, 1, 'u_peer', 'u_peer', 99999, 1);

  expect(await c2c.inferSelfIdentity()).toEqual({ uin: null, uid: null });
  expect(await c2c.inferSelfUin()).toBeNull();
});

it('群聊用 40040=1 的自证行取本人 uin 与 uid', async () => {
  const { sql, group } = fixture();
  const add = sql.prepare(
    `INSERT INTO group_msg_table ("40001","40003","40020","40027","40033","40040","40050") VALUES (?,?,?,?,?,?,?)`,
  );
  // 自己真实发出的行：40040 = 1。
  add.run(1, 1, SELF_UID, '777', SELF_UIN, 1, 1);
  // 同步副本（自己转发别人的消息）：senderUid 是本人，但 40040 = 0。
  for (let i = 0; i < 4; i++) add.run(2 + i, 2 + i, SELF_UID, '777', SELF_UIN, 0, i);
  // 别人发的。
  add.run(9, 9, 'u_other', '777', 88888, 0, 9);

  expect(await group.inferSelfIdentity()).toEqual({ uin: BigInt(SELF_UIN), uid: SELF_UID });
});

it('群聊没发过言时返回空身份，且不会把占位行的群号当成 uid', async () => {
  const { sql, group } = fixture();
  const add = sql.prepare(
    `INSERT INTO group_msg_table ("40001","40003","40020","40027","40033","40040","40050") VALUES (?,?,?,?,?,?,?)`,
  );
  add.run(1, 1, 'u_other', '777', 88888, 0, 1);
  add.run(2, 2, '777', '777', 0, 0, 2);

  expect(await group.inferSelfIdentity()).toEqual({ uin: null, uid: null });
});
