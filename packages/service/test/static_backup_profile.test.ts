import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { peekStaticSelfUin } from '@weq/account';
import type { Platform } from '@weq/platform';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it('旧备份 profile_info_v2 也可识别账号，不依赖不存在的 v6 表或 FTS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-old-profile-'));
  roots.push(dir);
  const sql = fixtureDb(join(dir, 'profile_info.db'));
  sql.exec(
    'CREATE TABLE profile_info_v2 ("1000" TEXT, "1002" INTEGER, "20002" TEXT, "20003" INTEGER)',
  );
  sql
    .prepare('INSERT INTO profile_info_v2 VALUES (?, ?, ?, ?)')
    .run('u_synthetic', 12345, '合成旧账号', 10);
  const platform = { native: { ntHelper: createSqliteStub() } } as Platform;
  expect(await peekStaticSelfUin(platform, dir)).toMatchObject({
    uin: '12345',
    uid: 'u_synthetic',
    nick: '合成旧账号',
  });
});
it('已有配置验证过的账号优先精确匹配，不误选更新时间更晚的联系人', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-old-profile-owner-'));
  roots.push(dir);
  const sql = fixtureDb(join(dir, 'profile_info.db'));
  sql.exec(
    'CREATE TABLE profile_info_v2 ("1000" TEXT, "1002" INTEGER, "20002" TEXT, "20003" INTEGER)',
  );
  const insert = sql.prepare('INSERT INTO profile_info_v2 VALUES (?, ?, ?, ?)');
  insert.run('u_owner', 12345, '合成主人', 1);
  insert.run('u_peer', 99999, '合成联系人', 99);
  const platform = { native: { ntHelper: createSqliteStub() } } as Platform;
  expect(await peekStaticSelfUin(platform, dir, undefined, undefined, '12345')).toMatchObject({
    uin: '12345',
    uid: 'u_owner',
  });
});
