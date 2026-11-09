import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { GroupDetailDb, GroupMemberDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { afterEach, expect, it } from 'vitest';
import { GroupInfoService } from '../src/account/group_info';

const dirs: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(groupCount: number, memberCount: number) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-relation-limits-'));
  dirs.push(dir);
  const dbPath = join(dir, 'fixture.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE group_detail_info_ver1 (
    "60001" INTEGER, "60007" TEXT, "60216" TEXT, "60217" TEXT, "60026" TEXT,
    "60002" TEXT, "60004" INTEGER, "60005" INTEGER, "60006" INTEGER,
    "60218" TEXT, "60224" TEXT, "60241" BLOB, "60242" BLOB);
    CREATE TABLE group_member3 ("60001" INTEGER, "1000" TEXT, "1002" INTEGER,
      "20002" TEXT, "64003" TEXT, "64016" INTEGER);
    CREATE INDEX members_by_group ON group_member3 ("60001");
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${groupCount})
    INSERT INTO group_detail_info_ver1 ("60001", "60007", "60004")
      SELECT i, 'synthetic-group-' || i, ${memberCount} FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${memberCount})
    INSERT INTO group_member3
      SELECT 1, 'u_member_' || i, 100000+i, 'synthetic-member', '', 0 FROM n;
    INSERT INTO group_member3 SELECT 2, "1000", "1002", "20002", "64003", 0
      FROM group_member3 WHERE "60001" = 1;
    INSERT INTO group_member3 VALUES (${groupCount}, 'u_member_1', 100001, 'synthetic-member', '', 0);
    INSERT INTO group_member3 VALUES
      (1,'u_self',42,'self','',0),(2,'u_self',42,'self','',0),
      (1,'u_single',123,'single','',0),(2,'u_single',123,'single','',1);`);
  const nt = createSqliteStub();
  const session = {
    context: { uin: 42 },
    groupDetail: new GroupDetailDb(nt, { dbPath }),
    groupMembers: new GroupMemberDb(nt, { dbPath }),
    profileInfo: { profilesByUids: async () => [] },
  } as unknown as AccountSession;
  return { service: new GroupInfoService(session), sql };
}

it('扫描超过 2000 个群，末尾群参与交集统计', async () => {
  const { service } = fixture(2001, 1);
  const data = await service.getRelationGraph();
  expect(data.scannedGroups).toBe(2001);
  expect(data.groups.map((group) => group.code)).toContain('2001');
  expect(data.nodes[0]?.groupCodes).toEqual(['1', '2', '2001']);
});

it('超过 600 位跨群成员仍全部返回，保留跨群口径及自己、退群过滤', async () => {
  const { service } = fixture(2, 601);
  const data = await service.getRelationGraph();
  expect(data.nodes).toHaveLength(601);
  expect(data.groups.map((group) => group.sharedCount)).toEqual([601, 601]);
  expect(data.nodes.some((node) => node.uid === 'u_member_601')).toBe(true);
  expect(data.nodes.some((node) => ['u_self', 'u_single'].includes(node.uid))).toBe(false);
});

it('超过 5000 名群成员不截断，强制刷新重建完整结果，普通读取复用缓存', async () => {
  const { service, sql } = fixture(2, 5001);
  const first = await service.getRelationGraph();
  expect(first.nodes).toHaveLength(5001);
  expect(first.nodes.some((node) => node.uid === 'u_member_5001')).toBe(true);
  sql.exec(`INSERT INTO group_member3 VALUES
    (1,'u_new',999999,'new','',0),(2,'u_new',999999,'new','',0)`);
  expect(await service.getRelationGraph()).toBe(first);
  const fresh = await service.getRelationGraph({ force: true });
  expect(fresh.nodes).toHaveLength(5002);
  expect(fresh.groups.map((group) => group.sharedCount)).toEqual([5002, 5002]);
  expect(await service.getRelationGraph()).toBe(fresh);
});
