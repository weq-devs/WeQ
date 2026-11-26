import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { databasePerformance, UnreadInfoDb } from '@weq/db';
import { ChatType, ProtoMsg } from '@weq/codec';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(unique = true) {
  const root = mkdtempSync(join(tmpdir(), 'weq-no-unread-pages-'));
  roots.push(root);
  const path = join(root, 'msg.db'),
    nt = createSqliteStub(),
    sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT ${unique ? 'PRIMARY KEY' : ''},"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    CREATE INDEX recent_uid ON recent_contact_v3_table("40021");`);
  const query = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  return { path, sql, query, db };
}
const snapshotQueries = (f: ReturnType<typeof fixture>) =>
  f.query.mock.calls.filter(
    ([, statement]) => !/pragma_index_list\(|pragma_table_info\(/.test(statement),
  );

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
    await f.db.getAllUnreadInfos();
    f.query.mockClear();
    const before = databasePerformance(f.path).returnedRows;
    const rows = await f.db.getAllUnreadInfos();
    expect(rows).toHaveLength(1300);
    expect(databasePerformance(f.path).returnedRows - before).toBe(1300);
    expect(rows.every((row) => row.decreasedSeqs?.[0] === '101')).toBe(true);
    expect(snapshotQueries(f)).toHaveLength(1);
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
    expect(snapshotQueries(f)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});
it('临时私聊用普通私聊的未读键找到最新位置，打开后能清除手动标记', async () => {
  const f = fixture();
  const insert = f.sql.prepare(
    'INSERT INTO recent_contact_v3_table VALUES (?,?,?,NULL,NULL,NULL,NULL,NULL,NULL)',
  );
  const target = { chatType: ChatType.KCHATTYPEC2C, uid: 'u_temp' };
  insert.run(target.uid, 47, ChatType.KCHATTYPETEMPC2CFROMGROUP);
  insert.run('u_former_temp', 140, ChatType.KCHATTYPETEMPC2CFROMGROUP);
  insert.run('u_former_temp', 100, ChatType.KCHATTYPEC2C);
  insert.run('u_official', 200, ChatType.KCHATTYPETEMPPUBLICACCOUNT);
  const former = { ...target, uid: 'u_former_temp' };
  const official = { ...target, uid: 'u_official' };
  try {
    await f.db.setReadState(target.chatType, target.uid, '46', '46', false);
    await f.db.setReadState(target.chatType, target.uid, '46', '47', true);
    const snapshot = await f.db.getUnreadInfos([target, former, official]);
    expect(snapshot).toMatchObject([
      { peer: '1_u_temp', latestSeq: '47', msgSeq: 46, markUnread: true },
      { peer: '1_u_former_temp', latestSeq: '100' },
      { peer: '1_u_official', latestSeq: null },
    ]);
    expect(await f.db.getAllUnreadInfos()).toEqual(snapshot.slice(0, 2));

    expect(await f.db.markRead(target.chatType, target.uid, snapshot[0]!.latestSeq!)).toBe(true);
    expect((await f.db.getAllUnreadInfos())[0]).toMatchObject({ msgSeq: 47, markUnread: false });
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
    expect(snapshotQueries(f)).toHaveLength(3);
    expect(
      f.query.mock.calls.every(([, query]) => !/WITH page|msg_table|data_version/.test(query)),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});

it('同键合并和旧库快照在临时私聊、纯未读、设备、群提醒及缺档时一致', async () => {
  const indexed = fixture();
  const legacy = fixture(false);
  const proto = new ProtoMsg(UnreadInfo);
  try {
    for (const f of [indexed, legacy]) {
      f.sql.exec('ALTER TABLE recent_contact_v3_table ADD COLUMN "41220" INTEGER');
      const recent = f.sql.prepare(`INSERT INTO recent_contact_v3_table
        ("40021","40003","40010","41220") VALUES (?,?,?,?)`);
      recent.run('u_dupe', 25, ChatType.KCHATTYPETEMPC2CFROMGROUP, null);
      recent.run('u_dupe', 20, ChatType.KCHATTYPEC2C, null);
      recent.run('u_temp', 30, ChatType.KCHATTYPETEMPC2CFROMGROUP, null);
      recent.run('u_noread', 40, ChatType.KCHATTYPEC2C, null);
      recent.run('phone', 40, 8, null);
      recent.run('70001', 170, 2, 2);
      recent.run('70002', 171, 2, 0);
      const unread = f.sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)');
      for (const [peer, msgSeq] of [
        ['1_u_dupe', 11],
        ['1_u_temp', 22],
        ['2_only', 33],
        ['8_phone', 34],
      ] as const)
        unread.run(peer, proto.encode({ info: { msgSeq } }));
    }
    const expected = await legacy.db.getAllUnreadInfos();
    expect(expected).toMatchObject([
      { peer: '1_u_dupe', msgSeq: 11, latestSeq: '20' },
      { peer: '1_u_temp', msgSeq: 22, latestSeq: '30' },
      { peer: '1_u_noread', latestSeq: '40' },
      { peer: '8_phone', msgSeq: 34 },
      { peer: '2_70001', groupNotifyLevel: 2 },
      { peer: '2_70002' },
      { peer: '2_only', msgSeq: 33, latestSeq: null },
    ]);
    expect(expected.find((row) => row.uid === '70002')?.groupNotifyLevel).toBeUndefined();
    expect(await indexed.db.getAllUnreadInfos()).toEqual(expected);
    expect(await indexed.db.getUnreadInfos([{ chatType: 2, uid: '70001' }])).toEqual([
      expected.find((row) => row.uid === '70001'),
    ]);
  } finally {
    indexed.db.close();
    legacy.db.close();
  }
});

it('共享快照复用相同未读字段，返回副本并单独解码同水位的新减项', async () => {
  const f = fixture();
  const write = f.sql.prepare('INSERT OR REPLACE INTO msg_unread_info_table VALUES (?,?)');
  const proto = new ProtoMsg(UnreadInfo);
  const input = (msgSeq: number) => proto.encode({ info: { msgSeq: 90, decreases: [{ msgSeq }] } });
  write.run('2_70001', input(96));
  write.run('2_70002', input(97));
  const decode = vi.spyOn(ProtoMsg.prototype, 'decode');
  try {
    const first = await f.db.getAllUnreadInfos();
    expect(decode).toHaveBeenCalledTimes(2);
    first[0]!.decreasedSeqs!.push('200');
    write.run('2_70002', input(98));
    decode.mockClear();
    const second = await f.db.getAllUnreadInfos();
    expect(second.map((row) => row.decreasedSeqs)).toEqual([['96'], ['98']]);
    expect(decode).toHaveBeenCalledOnce();
  } finally {
    decode.mockRestore();
    f.db.close();
  }
});
