import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb, GroupMsgDb } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { MsgService } from '../src/account/msg';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['c2c', 'group'] as const)(
  '所选 %s 区间分页补齐同序号边界，精确去重且不读取范围外内容',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-selection-range-'));
    roots.push(root);
    const path = join(root, 'fixture.db'),
      sql = fixtureDb(path),
      nt = createSqliteStub();
    for (const table of ['c2c_msg_table', 'group_msg_table']) {
      sql.exec(
        `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40013" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
      );
      const add = sql.prepare(
        `INSERT INTO ${table} ("40001","40003","40020","40021","40027","40050") VALUES(?,?,?,?,?,?)`,
      );
      for (let id = 1; id <= 406; id++)
        add.run(id, id <= 205 ? 100 : id, 'u_sender', 'u_peer', '777', 1792544400 + id);
    }
    const session = {
      uidMap: { sortNoByUid: () => undefined },
      c2cMsgs: new C2cMsgDb(nt, { dbPath: path }),
      groupMsgs: new GroupMsgDb(nt, { dbPath: path }),
    } as unknown as AccountSession;
    const service = new MsgService(session),
      conv = kind === 'group' ? '777' : 'u_peer';
    const first = await service.getSelectionRangePage(kind, conv, 100n, 405n, undefined, 200);
    expect(first.items).toHaveLength(205);
    expect(first.nextSeq).toBe('100');
    const second = await service.getSelectionRangePage(
      kind,
      conv,
      100n,
      405n,
      BigInt(first.nextSeq!),
      200,
    );
    expect(second.items).toHaveLength(200);
    expect(second.nextSeq).toBeNull();
    const ids = [...first.items, ...second.items].map((row) => row.msgId.toString());
    expect(new Set(ids).size).toBe(405);
    expect(ids).not.toContain('406');
  },
);
