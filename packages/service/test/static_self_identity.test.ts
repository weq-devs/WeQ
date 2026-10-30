import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { resolveStaticSelfIdentity } from '@weq/account';

const SELF_UIN = 12345;
const SELF_UID = 'u_self';
const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-static-identity-'));
  roots.push(dir);
  const sql = fixtureDb(join(dir, 'nt_msg.db'));
  sql.exec(
    `CREATE TABLE c2c_msg_table ("40001" INTEGER,"40003" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40033" INTEGER,"40040" INTEGER,"40050" INTEGER,"40800" BLOB)`,
  );
  return { dir, sql };
}

/** 写一行「自己发出」的私聊消息：40020 是本账号 uid，40021 恒为对端。 */
function selfSent(sql: ReturnType<typeof fixtureDb>, n = 1) {
  const add = sql.prepare(
    `INSERT INTO c2c_msg_table ("40001","40003","40020","40021","40033","40050") VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < n; i++) add.run(i + 1, i + 1, SELF_UID, 'u_peer', SELF_UIN, i);
}

it('资料库缺失或表结构不认识时，仍能从 nt_msg.db 定出 uin 与 uid', async () => {
  const { dir, sql } = fixture();
  selfSent(sql, 3);
  // profile_info.db 故意写成空文件：表结构解析必然失败，但不能影响身份。
  const plain = Buffer.alloc(1040);
  plain.write('SQLite format 3\0');
  fixtureDb(join(dir, 'profile_info.db'));

  expect(await resolveStaticSelfIdentity(createSqliteStub(), dir)).toEqual({
    uin: String(SELF_UIN),
    uid: SELF_UID,
    nick: '',
    avatarUrl: '',
  });
});

it('推导链给出的身份优先于库内推断，昵称也一并带回', async () => {
  const { dir, sql } = fixture();
  selfSent(sql, 3);
  expect(
    await resolveStaticSelfIdentity(createSqliteStub(), dir, {
      seed: { uid: SELF_UID, uin: String(SELF_UIN), nick: '合成昵称' },
    }),
  ).toMatchObject({ uin: String(SELF_UIN), uid: SELF_UID, nick: '合成昵称' });
});

it('库内推断与已校验的 uin 冲突时明确报错，不静默采信任一方', async () => {
  const { dir, sql } = fixture();
  selfSent(sql, 3);
  await expect(
    resolveStaticSelfIdentity(createSqliteStub(), dir, { expectedUin: '99999' }),
  ).rejects.toThrow('数据库账号与配置不匹配');
});

it('没有消息可自证时退回资料库，资料库也读不到才报错', async () => {
  const { dir } = fixture();
  fixtureDb(join(dir, 'profile_info.db')).exec(
    'CREATE TABLE profile_info_v2 ("1000" TEXT, "1002" INTEGER, "20002" TEXT)',
  );
  await expect(resolveStaticSelfIdentity(createSqliteStub(), dir)).rejects.toThrow(
    '无法从备份中识别账号',
  );
});

it('没有消息可自证时，资料库能给出完整身份', async () => {
  const { dir } = fixture();
  const sql = fixtureDb(join(dir, 'profile_info.db'));
  sql.exec('CREATE TABLE profile_info_v2 ("1000" TEXT, "1002" INTEGER, "20002" TEXT)');
  sql.prepare('INSERT INTO profile_info_v2 VALUES (?, ?, ?)').run(SELF_UID, SELF_UIN, '合成账号');

  expect(await resolveStaticSelfIdentity(createSqliteStub(), dir)).toEqual({
    uin: String(SELF_UIN),
    uid: SELF_UID,
    nick: '合成账号',
    avatarUrl: '',
  });
});
