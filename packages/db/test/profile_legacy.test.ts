import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { fixtureDb, createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import { ProfileInfoDb } from '../src/profile/profile_info';
import { resolveProfileTableSchema } from '../src/profile/profile_table';
import { QqDb } from '../src/qq_db';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-profile-v2-'));
  roots.push(dir);
  const path = join(dir, 'profile_info.db');
  const sql = fixtureDb(path);
  sql.exec(
    'CREATE TABLE profile_info_v2 ("1000" TEXT, "1002" INTEGER, "20002" TEXT); CREATE TABLE buddy_list ("1000" TEXT, "1002" INTEGER); CREATE TABLE profile_info_v99_fts (dummy TEXT)',
  );
  sql.prepare('INSERT INTO profile_info_v2 VALUES (?, ?, ?)').run('u_owner', 12345, '合成旧用户');
  sql.prepare('INSERT INTO buddy_list VALUES (?, ?)').run('u_owner', 12345);
  const nt = createSqliteStub();
  const qq = new QqDb(nt, { dbPath: path });
  const schema = await resolveProfileTableSchema(qq);
  return { sql, nt, schema, path, db: new ProfileInfoDb(nt, { dbPath: path, schema }) };
}
it('旧表和缺失列按真实 schema 读取，不把列号误当成字段值', async () => {
  const { db, schema } = await fixture();
  expect(schema.table).toBe('profile_info_v2');
  expect(await db.getProfile('u_owner')).toMatchObject({
    uid: 'u_owner',
    nick: '合成旧用户',
    intimacy: 0,
    isFriend: false,
  });
  expect((await db.getProfileByUin(12345n))?.uin).toBe(12345n);
  expect(await db.getUidByUin(12345n)).toBe('u_owner');
  expect(await db.nicksByUids(['u_owner'])).toEqual({ u_owner: '合成旧用户' });
  expect(await db.profilesByUids(['u_owner'])).toHaveLength(1);
  expect(await db.listProfiles()).toHaveLength(1);
  expect((await db.searchFriends('旧用户')).items[0]).toMatchObject({
    uid: 'u_owner',
    remark: '',
    avatarUrl: null,
  });
  expect((await db.listFriendsByIntimacy())[0]).toMatchObject({ uid: 'u_owner', intimacy: 0 });
  expect(await db.botUids()).toEqual(new Set());
});
it('优先合法的新版本，不能让同名 FTS 或不完整表抢占资料来源', async () => {
  const { sql, nt, path } = await fixture();
  sql.exec('CREATE TABLE profile_info_v6 ("1000" TEXT)');
  const qq = new QqDb(nt, { dbPath: path });
  expect((await resolveProfileTableSchema(qq)).table).toBe('profile_info_v2');
  sql.exec('CREATE TABLE profile_info_v10 ("1000" TEXT, "1002" INTEGER, "20002" TEXT)');
  expect((await resolveProfileTableSchema(qq)).table).toBe('profile_info_v10');
});
