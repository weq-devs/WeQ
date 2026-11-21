import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ElementType, GrayTipSubType, ProtoMsg } from '@weq/codec';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { UnreadInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('防撤回保留的正文按会话及未读区间从撤回索引查出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-protected-recall-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    INSERT INTO recent_contact_v3_table("40021","40003","40010","40020") VALUES ('70001',110,2,'u_peer');
    CREATE TABLE weq_recall_log(msgid INTEGER PRIMARY KEY, table_kind TEXT, conv TEXT, orig_seq INTEGER);
    CREATE INDEX weq_recall_by_conversation_seq ON weq_recall_log(table_kind,conv,orig_seq);
    INSERT INTO weq_recall_log VALUES (1,'group','70001',106),(2,'group','70001',108),
      (3,'group','70001',108),(4,'group','70001',111),(5,'group','70002',109),
      (6,'c2c','70001',110);`);
  sql
    .prepare('INSERT INTO msg_unread_info_table VALUES (?,?)')
    .run('2_70001', new ProtoMsg(UnreadInfo).encode({ info: { msgSeq: 105, localReadSeq: 106 } }));
  const nt = createSqliteStub();
  const query = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  try {
    const all = await db.getAllUnreadInfos();
    expect(all[0]?.recalledSeqs).toEqual(['108']);
    expect(await db.getUnreadInfos([{ chatType: 2, uid: '70001' }])).toEqual(all);
    const [, statement, params] = query.mock.calls.find(([, text]) =>
      text.includes('CROSS JOIN weq_recall_log'),
    )!;
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...(params ?? []));
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'SEARCH r USING COVERING INDEX weq_recall_by_conversation_seq',
    );
  } finally {
    db.close();
  }
});

it('小表直接交付本地水位、减项、标志及最新发送者，不需要消息表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-small-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const nt = createSqliteStub();
  const query = vi.spyOn(nt, 'executeSql');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    INSERT INTO recent_contact_v3_table("40021","40003","40010","40020") VALUES ('70001',110,2,'u_self')`);
  sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)').run(
    '2_70001',
    new ProtoMsg(UnreadInfo).encode({
      info: {
        chatType: 2,
        peerUid: '70001',
        msgSeq: 90,
        localReadSeq: 100,
        decreases: [{ msgSeq: 99 }, { msgSeq: 102 }, { msgSeq: 102 }, { msgSeq: 111 }],
        markUnread: 1,
      },
    }),
  );
  const db = new UnreadInfoDb(nt, { dbPath: path });
  try {
    expect((await db.getUnreadInfos([{ chatType: 2, uid: '70001' }]))[0]).toMatchObject({
      msgSeq: 90,
      localReadSeq: '100',
      decreasedSeqs: ['99', '102', '111'],
      markUnread: true,
      latestSenderUid: 'u_self',
    });
    expect((await db.getAllUnreadInfos())[0]).toMatchObject({
      latestSeq: '110',
      latestSenderUid: 'u_self',
      decreasedSeqs: ['99', '102', '111'],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.every(
        ([, text]) => !/group_msg_table|c2c_msg_table|data_version/.test(text),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it('撤回和拍一拍按同会话同序号的正文归因，缺行不猜，普通消息仍走小表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-gray-tip-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    CREATE TABLE c2c_msg_table("40027" INTEGER,"40003" INTEGER,"40011" INTEGER,"40001" INTEGER,"40020" TEXT);
    CREATE INDEX c2c_seq ON c2c_msg_table("40027","40003");
    CREATE TABLE group_msg_table("40027" INTEGER,"40003" INTEGER,"40011" INTEGER,"40001" INTEGER,"40020" TEXT);
    CREATE INDEX group_seq ON group_msg_table("40027","40003");
    INSERT INTO c2c_msg_table VALUES (10,110,2,90001,'u_self'),(11,110,2,90002,'u_peer');
    INSERT INTO group_msg_table VALUES (70001,110,2,90101,'u_peer'),(70002,110,5,90102,'u_peer'),
      (70003,110,2,90103,'u_peer'),(70003,110,2,90203,'u_peer');`);
  const preview = new ProtoMsg(RecentContactBody);
  const poke = preview.encode({
    preview: [
      { elementType: ElementType.GRAY_TIP, subType: GrayTipSubType.XML_MSG, detailedId: 1061 },
    ],
  });
  const recall = preview.encode({
    preview: [{ elementType: ElementType.GRAY_TIP, subType: GrayTipSubType.REVOKE }],
  });
  const contact = sql.prepare('INSERT INTO recent_contact_v3_table VALUES (?,110,?,?,5,?,?,?,NULL)');
  // 私聊拍一拍摘要的 ID 可以不同于共号的正文，发送者也可以相反。
  contact.run('u_own', 1, 'u_peer', poke, 91001, 10);
  contact.run('u_inbound', 1, 'u_self', poke, 91002, 11);
  contact.run('70001', 2, 'u_peer', recall, 90101, 41);
  contact.run('70002', 2, 'u_peer', poke, 90102, 42);
  contact.run('70003', 2, 'u_self', recall, 90103, 43);
  contact.run('70004', 2, 'u_self', poke, 90104, 44);
  const targets = [
    { chatType: 1, uid: 'u_own' },
    { chatType: 1, uid: 'u_inbound' },
    ...['70001', '70002', '70003', '70004'].map((uid) => ({ chatType: 2, uid })),
  ];
  const info = new ProtoMsg(UnreadInfo).encode({ info: { msgSeq: 109 } });
  const insert = sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)');
  for (const { chatType, uid } of targets) insert.run(`${chatType}_${uid}`, info);

  const nt = createSqliteStub();
  const query = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  try {
    const all = await db.getAllUnreadInfos();
    const selected = await db.getUnreadInfos(targets);
    expect(selected).toEqual(all);
    expect(selected.map((row) => [row.latestSenderUid, row.latestSeqNonMessage])).toEqual([
      ['u_self', undefined],
      ['u_peer', undefined],
      [undefined, true],
      [undefined, true],
      ['u_peer', undefined],
      [undefined, undefined],
    ]);
    for (const table of ['c2c', 'group']) {
      const [, statement, params] = query.mock.calls.find(([, text]) =>
        text.includes(`LEFT JOIN ${table}_msg_table m`),
      )!;
      const plan = sql.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...(params ?? []));
      expect(plan.map((row) => row.detail).join('\n')).toContain(
        `SEARCH m USING INDEX ${table}_seq (40027=? AND 40003=?)`,
      );
    }
  } finally {
    db.close();
  }
});
