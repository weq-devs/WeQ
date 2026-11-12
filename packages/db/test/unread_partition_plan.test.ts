import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UnreadInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('未读水位按 UID 定位，仅将类型作为剩余筛选，不重复扫描同类型的所有会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-watermark-plan-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40027" INTEGER);
    CREATE INDEX contacts_uid ON recent_contact_v3_table("40021");
    CREATE INDEX contacts_type_partition ON recent_contact_v3_table("40010","40027");
    INSERT INTO recent_contact_v3_table VALUES ('u_peer',12,1,42),('u_peer',99,2,43)`);
  const nt = createSqliteStub();
  const execute = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  const rows = await db.getUnreadInfos([
    { chatType: 1, uid: 'u_peer' },
    { chatType: 2, uid: 'u_peer' },
    { chatType: 1, uid: 'u_absent' },
  ]);
  expect(rows.map((row) => row.latestSeq)).toEqual(['12', '99', null]);
  const [, query, params] = execute.mock.calls.find(([, query]) => query.includes('WITH targets'))!;
  const plan = sql
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all(...(params ?? []))
    .map((row) => String(row.detail))
    .join('\n');
  expect(plan).toContain('SEARCH r USING INDEX contacts_uid (40021=?)');
  expect(plan).not.toContain('USING INDEX contacts_type_partition');
});
