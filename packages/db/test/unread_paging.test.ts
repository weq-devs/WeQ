import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UnreadInfoDb } from '@weq/db';
import { ProtoMsg } from '@weq/codec';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-no-unread-pages-'));
  roots.push(root);
  const path = join(root, 'msg.db'),
    nt = createSqliteStub(),
    sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT);
    CREATE INDEX recent_uid ON recent_contact_v3_table("40021");`);
  const query = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  return { path, sql, query, db };
}
it('1300 会话共享快照单条 SQL，不受未读区间长度或发送方向影响', async () => {
  const f = fixture();
  const insert = f.sql.prepare(
    'INSERT INTO recent_contact_v3_table ("40021","40003","40010") VALUES (?,?,?)',
  );
  const unread = f.sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)');
  const proto = new ProtoMsg(UnreadInfo);
  f.sql.exec('BEGIN');
  for (let i = 0; i < 1300; i++) {
    insert.run(String(i), 9000000, 2);
    unread.run(
      `2_${i}`,
      proto.encode({ info: { msgSeq: 1, localReadSeq: 100, decreases: [{ msgSeq: 101 }] } }),
    );
  }
  f.sql.exec('COMMIT');
  try {
    const rows = await f.db.getAllUnreadInfos();
    expect(rows).toHaveLength(1300);
    expect(rows.every((row) => row.decreasedSeqs?.[0] === '101')).toBe(true);
    expect(f.query).toHaveBeenCalledOnce();
    expect(
      f.query.mock.calls.every(
        ([, query]) => !/c2c_msg_table|group_msg_table|pragma_data_version/.test(query),
      ),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
it('缺最近会话行、缺水位、设备和纯标记均可读取，不触发隐藏精算', async () => {
  const f = fixture(),
    proto = new ProtoMsg(UnreadInfo);
  const insert = f.sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)');
  insert.run('2_70001', proto.encode({ info: { markUnread: 1 } }));
  insert.run('8_phone', proto.encode({ info: { localUnreadCount: 3 } }));
  insert.run('134_pad', proto.encode({ info: { unreadCount: 4 } }));
  insert.run('999_other', proto.encode({ info: { unreadCount: 5 } }));
  try {
    const rows = await f.db.getAllUnreadInfos();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.chatType === 2)).toMatchObject({
      markUnread: true,
      latestSeq: null,
    });
    expect(rows.find((row) => row.chatType === 8)?.localUnreadCount).toBe(3);
    expect(rows.find((row) => row.chatType === 134)?.storedUnreadCount).toBe(4);
    expect(f.query).toHaveBeenCalledOnce();
  } finally {
    f.db.close();
  }
});
it('无关会话写入和同水位内容修正只重读小表，不存在消息历史扫描', async () => {
  const f = fixture();
  f.sql.exec(
    `INSERT INTO recent_contact_v3_table ("40021","40003","40010") VALUES ('70001',100,2)`,
  );
  const proto = new ProtoMsg(UnreadInfo);
  f.sql
    .prepare('INSERT INTO msg_unread_info_table VALUES (?,?)')
    .run('2_70001', proto.encode({ info: { msgSeq: 90 } }));
  try {
    await f.db.getAllUnreadInfos();
    f.sql.exec(
      `INSERT INTO recent_contact_v3_table ("40021","40003","40010") VALUES ('70002',100,2)`,
    );
    await f.db.getAllUnreadInfos();
    f.sql
      .prepare('UPDATE msg_unread_info_table SET "48902"=?')
      .run(proto.encode({ info: { msgSeq: 90, decreases: [{ msgSeq: 99 }] } }));
    expect(
      (await f.db.getAllUnreadInfos()).find((row) => row.uid === '70001')?.decreasedSeqs,
    ).toEqual(['99']);
    expect(f.query.mock.calls).toHaveLength(3);
    expect(
      f.query.mock.calls.every(([, query]) => !/WITH page|msg_table|data_version/.test(query)),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
