import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { ProfileInfoDb } from '../src/profile/profile_info';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withDirectory = true) {
  const root = mkdtempSync(join(tmpdir(), 'weq-friendship-'));
  roots.push(root);
  const dbPath = join(root, 'profile.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE profile_info_v6 (
    "1000" TEXT, "1001" TEXT, "1002" INTEGER, "20002" TEXT, "20004" TEXT,
    "20006" INTEGER, "20007" INTEGER, "20008" INTEGER, "20009" TEXT, "20011" TEXT,
    "20014" INTEGER, "20057" BLOB, "20070" INTEGER, "20072" BLOB,
    "24103" INTEGER, "24104" INTEGER, "21000" BLOB)`);
  if (withDirectory) {
    sql.exec('CREATE TABLE buddy_list ("1000" TEXT PRIMARY KEY, "1002" INTEGER)');
    sql.prepare('INSERT INTO buddy_list VALUES (?, ?)').run('u_friend', 10001);
  }
  sql
    .prepare('INSERT INTO profile_info_v6 ("1000", "1002", "20072") VALUES (?, ?, ?)')
    .run('u_friend', 10001, null);
  sql
    .prepare('INSERT INTO profile_info_v6 ("1000", "1002", "20072") VALUES (?, ?, ?)')
    .run('u_stranger', 10002, Buffer.from('0a00', 'hex'));
  return { sql, db: new ProfileInfoDb(createSqliteStub(), { dbPath }) };
}

it('好友关系以名册为准：有关系缓存的非好友、没有关系缓存的好友均正确识别', async () => {
  const { db, sql } = fixture();
  expect(await db.getProfile('u_friend')).toMatchObject({ isFriend: true, friendshipKnown: true });
  expect(await db.getProfileByUin(10002n)).toMatchObject({
    isFriend: false,
    friendshipKnown: true,
  });
  for (const profiles of [
    await db.profilesByUids(['u_friend', 'u_stranger']),
    await db.listProfiles(),
  ]) {
    expect(profiles.find((profile) => profile.uid === 'u_friend')?.isFriend).toBe(true);
    expect(profiles.find((profile) => profile.uid === 'u_stranger')?.isFriend).toBe(false);
  }
  sql.exec('DELETE FROM buddy_list');
  expect(await db.getProfile('u_friend')).toMatchObject({ isFriend: false, friendshipKnown: true });
});

it('备份缺少好友名册时关系未知，不从关系缓存推断', async () => {
  const { db } = fixture(false);
  expect(await db.getProfile('u_stranger')).toMatchObject({
    isFriend: false,
    friendshipKnown: false,
  });
});
