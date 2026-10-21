import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { ProfileInfoDb } from '../src/profile/profile_info';

let dir: string | undefined;
let db: ProfileInfoDb | undefined;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('只读取好友资料中的明确免打扰值，缺失、未知与损坏保持未知', async () => {
  dir = mkdtempSync(join(tmpdir(), 'weq-profile-settings-'));
  const dbPath = join(dir, 'profile_info.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE profile_info_v6 (
    "1000" TEXT, "1001" TEXT, "1002" INTEGER, "20002" TEXT, "20004" TEXT,
    "20006" INTEGER, "20007" INTEGER, "20008" INTEGER, "20009" TEXT, "20011" TEXT,
    "20014" INTEGER, "20057" BLOB, "20070" INTEGER, "20072" BLOB,
    "24103" INTEGER, "24104" INTEGER, "21000" BLOB)`);
  const insert = sql.prepare('INSERT INTO profile_info_v6 ("1000", "21000") VALUES (?, ?)');
  // 固定 wire：21000 → 22006 → 20032；显式 0 必须和字段缺失区别对待。
  for (const [uid, hex] of [
    ['u_on', 'c2a00a08b2df0a0480e40901'],
    ['u_off', 'c2a00a08b2df0a0480e40900'],
    ['u_unknown', 'c2a00a08b2df0a0480e40902'],
    ['u_missing', 'c2a00a04b2df0a00'],
    ['u_broken', 'c2a00a08b2df0a0480e409'],
  ])
    insert.run(uid!, Buffer.from(hex!, 'hex'));
  insert.run('u_null', null);
  db = new ProfileInfoDb(createSqliteStub(), { dbPath });
  expect((await db.getProfile('u_on'))?.extInfo?.friendDisturb).toBe(true);
  expect((await db.getProfile('u_off'))?.extInfo?.friendDisturb).toBe(false);
  for (const uid of ['u_unknown', 'u_missing', 'u_broken', 'u_null', 'u_absent'])
    expect((await db.getProfile(uid))?.extInfo?.friendDisturb).toBeUndefined();
});
