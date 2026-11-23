import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ElementType, GrayTipSubType, ProtoMsg } from '@weq/codec';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { databasePerformance, UnreadInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import type { SqlValue } from '@weq/native';

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

it('共享快照复用撤回区间，同水位撤回只使对应会话失效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-recall-window-cache-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    INSERT INTO recent_contact_v3_table("40021","40003","40010")
      VALUES ('70001',110,2),('70002',110,2),('70003',110,2);
    CREATE TABLE weq_recall_log(msgid INTEGER PRIMARY KEY, table_kind TEXT, conv TEXT, orig_seq INTEGER);
    CREATE INDEX weq_recall_by_conversation_seq ON weq_recall_log(table_kind,conv,orig_seq);
    INSERT INTO weq_recall_log VALUES (20,'group','70001',104),(30,'group','70002',105);`);
  const proto = new ProtoMsg(UnreadInfo);
  const write = sql.prepare('INSERT OR REPLACE INTO msg_unread_info_table VALUES (?,?)');
  for (const uid of ['70001', '70002', '70003'])
    write.run(`2_${uid}`, proto.encode({ info: { msgSeq: 100 } }));
  const nt = createSqliteStub();
  const query = vi.spyOn(nt, 'executeSql');
  const db = new UnreadInfoDb(nt, { dbPath: path });
  const reads = () =>
    query.mock.calls.filter(([, text]) => text.includes('CROSS JOIN weq_recall_log'));
  const sequences = async () => (await db.getAllUnreadInfos()).map((row) => row.recalledSeqs);
  try {
    expect(await sequences()).toEqual([['104'], ['105'], undefined]);
    query.mockClear();
    sql.exec(`UPDATE recent_contact_v3_table SET "40003"=111 WHERE "40021"='70003'`);
    write.run('2_70001', proto.encode({ info: { msgSeq: 104 } }));
    expect(await sequences()).toEqual([undefined, ['105'], undefined]);
    expect(reads()).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(2);

    // 新追加记录的消息 ID 可以更小，消息和已读水位保持不变。
    sql.exec(`INSERT INTO weq_recall_log VALUES (10,'group','70001',107)`);
    expect(await sequences()).toEqual([['107'], ['105'], undefined]);
    expect(reads().map(([, , params]) => params)).toEqual([[0n, 'group', '70001', 104n, 110n]]);

    sql.exec(`DROP TABLE weq_recall_log;
      CREATE TABLE weq_recall_log(msgid INTEGER PRIMARY KEY, table_kind TEXT, conv TEXT, orig_seq INTEGER);
      CREATE INDEX weq_recall_by_conversation_seq ON weq_recall_log(table_kind,conv,orig_seq);
      INSERT INTO weq_recall_log VALUES (1,'group','70003',108),(2,'group','70003',108),
        (3,'group','70003',108);`);
    expect(await sequences()).toEqual([undefined, undefined, ['108']]);
  } finally {
    db.close();
  }
});

it('撤回补查超预算后缩小会话批次，单个大区间按序号读完且跨页去重', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-paged-protected-recalls-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    INSERT INTO recent_contact_v3_table("40021","40003","40010") VALUES ('70001',400,2),('70002',400,2);
    CREATE TABLE weq_recall_log(msgid INTEGER PRIMARY KEY, table_kind TEXT, conv TEXT, orig_seq INTEGER);
    CREATE INDEX weq_recall_by_conversation_seq ON weq_recall_log(table_kind,conv,orig_seq);
    WITH RECURSIVE seq(value) AS (VALUES(100) UNION ALL SELECT value+1 FROM seq WHERE value<401)
      INSERT INTO weq_recall_log(table_kind,conv,orig_seq) SELECT 'group','70001',value FROM seq;
    WITH RECURSIVE dup(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM dup WHERE value<80)
      INSERT INTO weq_recall_log(table_kind,conv,orig_seq) SELECT 'group','70001',106 FROM dup;
    INSERT INTO weq_recall_log(table_kind,conv,orig_seq)
      VALUES ('group','70002',159),('c2c','70002',160),('group','70003',161);`);
  const unread = sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)');
  const data = new ProtoMsg(UnreadInfo).encode({ info: { msgSeq: 100 } });
  unread.run('2_70001', data);
  unread.run('2_70002', data);
  const nt = createSqliteStub();
  let simulateTimeout = true;
  const budgeted = vi.fn(
    async (dbPath: string, text: string, params: SqlValue[] | null, _budget: number) => {
      if (
        (simulateTimeout && text.includes('CROSS JOIN weq_recall_log') && params!.length > 5) ||
        (text.includes('SELECT orig_seq FROM weq_recall_log') && params!.at(-1) === 64n)
      )
        throw new Error('database_query_execution_timeout');
      return nt.executeSql(dbPath, text, params);
    },
  );
  nt.executeSqlBudgeted = budgeted;
  const db = new UnreadInfoDb(nt, { dbPath: path });
  try {
    for (const timeout of [true, false]) {
      simulateTimeout = timeout;
      budgeted.mockClear();
      const all = await db.getUnreadInfos([
        { chatType: 2, uid: '70001' },
        { chatType: 2, uid: '70002' },
      ]);
      expect(all.find(({ uid }) => uid === '70001')?.recalledSeqs).toEqual(
        Array.from({ length: 300 }, (_, index) => String(101 + index)),
      );
      expect(all.find(({ uid }) => uid === '70002')?.recalledSeqs).toEqual(['159']);
      const joined = budgeted.mock.calls.filter(([, text]) =>
        text.includes('CROSS JOIN weq_recall_log'),
      );
      expect(joined.map(([, , params, budget]) => [params?.length, budget])).toEqual([[10, 15]]);
    }
    const pages = budgeted.mock.calls.filter(([, text]) =>
      text.includes('SELECT orig_seq FROM weq_recall_log'),
    );
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]?.[2]?.at(-1)).toBe(64n);
    const [, statement, params] = pages[1]!;
    expect(params?.at(-1)).toBe(32n);
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...(params ?? []));
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('USING COVERING INDEX weq_recall_by_conversation_seq');
    expect(details).not.toContain('TEMP B-TREE');
  } finally {
    db.close();
  }
});

it('撤回版本不可用时走原索引补查，探测失败保留未检查的区间', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-recall-extents-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT,
      "40011" INTEGER,"40051" BLOB,"40001" INTEGER,"40027" INTEGER,"40050" INTEGER);
    CREATE TABLE weq_recall_log(msgid INTEGER PRIMARY KEY, table_kind TEXT, conv TEXT, orig_seq INTEGER);
    CREATE INDEX weq_recall_by_conversation_seq ON weq_recall_log(table_kind,conv,orig_seq);
    WITH RECURSIVE groups(uid) AS (VALUES(70001) UNION ALL SELECT uid+1 FROM groups WHERE uid<70300)
      INSERT INTO recent_contact_v3_table("40021","40003","40010") SELECT CAST(uid AS TEXT),200,2 FROM groups;
    INSERT INTO weq_recall_log(table_kind,conv,orig_seq) VALUES
      ('group','70001',100),('group','70002',201),('group','70203',101),('group','70203',101),
      ('group','70270',200),('c2c','70004',123),('group','70006',NULL);`);
  const readState = new ProtoMsg(UnreadInfo).encode({ info: { msgSeq: 100 } });
  sql
    .prepare(`INSERT INTO msg_unread_info_table
    SELECT '2_' || "40021", ? FROM recent_contact_v3_table`)
    .run(readState);
  const nt = createSqliteStub();
  const execute = nt.executeSql.bind(nt);
  vi.spyOn(nt, 'executeSql').mockImplementation(async (path, text, params) => {
    if (text.includes('FROM pragma_schema_version')) throw new Error('synthetic version failure');
    return execute(path, text, params);
  });
  let now = 0;
  let timeout = false;
  let maxProbe = 512n;
  let failSecondPage = false;
  const isPresence = (sql: string) => sql.includes('SELECT t.idx FROM targets t WHERE EXISTS');
  const budgeted = vi.fn(async (dbPath: string, text: string, params: SqlValue[] | null) => {
    if (timeout && text.includes('MIN(orig_seq)'))
      throw new Error('database_query_execution_timeout');
    if (isPresence(text) && BigInt(String(params?.at(-1))) > maxProbe)
      throw new Error('database_query_execution_timeout');
    if (failSecondPage && isPresence(text) && params?.[2] === '70151')
      throw new Error('synthetic read failure for second page');
    return nt.executeSql(dbPath, text, params);
  });
  nt.executeSqlBudgeted = budgeted;
  const db = new UnreadInfoDb(nt, { dbPath: path });
  const groupsChecked = () =>
    budgeted.mock.calls
      .filter(([, text]) => text.includes('CROSS JOIN weq_recall_log'))
      .map(([, , params]) => (params?.length ?? 0) / 5);
  const probes = () => budgeted.mock.calls.filter(([, text]) => isPresence(text));
  const expected = [
    ['70203', '101'],
    ['70270', '200'],
  ];
  const checkResults = async () => {
    const rows = await db.getAllUnreadInfos();
    expect(rows).toHaveLength(300);
    expect(
      rows.flatMap(({ uid, recalledSeqs }) => recalledSeqs?.map((seq) => [uid, seq]) ?? []),
    ).toEqual(expected);
  };
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    await checkResults();
    // 空区间也可安全继续校验，含 NULL 的旧记录保守留给补查。
    expect(groupsChecked()).toEqual([3]);
    const [, statement] = budgeted.mock.calls.find(([, text]) => text.includes('MIN(orig_seq)'))!;
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${statement}`).all();
    expect(plan.map((row) => row.detail).join('\n')).toContain('USING COVERING INDEX');

    timeout = true;
    maxProbe = 150n;
    budgeted.mockClear();
    await checkResults();
    expect(groupsChecked()).toEqual([2]);
    expect(probes().map(([, , params]) => params?.at(-1))).toEqual([300n, 150n, 150n]);
    const [, presenceSql, presenceArgs] = probes()[2]!;
    const presencePlan = sql
      .prepare(`EXPLAIN QUERY PLAN ${presenceSql}`)
      .all(...(presenceArgs ?? []));
    expect(presencePlan.map((node) => node.detail).join('\n')).toContain(
      'USING COVERING INDEX weq_recall_by_conversation_seq',
    );

    failSecondPage = true;
    budgeted.mockClear();
    await checkResults();
    expect(groupsChecked()).toEqual([128, 22]);
    expect(budgeted.mock.calls.some(([, text]) => text.includes('MIN(orig_seq)'))).toBe(false);

    now += 3_000;
    timeout = false;
    failSecondPage = false;
    maxProbe = 512n;
    sql.exec(`WITH RECURSIVE more(uid) AS (VALUES(80001) UNION ALL SELECT uid+1 FROM more WHERE uid<80513)
      INSERT INTO weq_recall_log(table_kind,conv,orig_seq) SELECT 'group',CAST(uid AS TEXT),111 FROM more;`);
    budgeted.mockClear();
    await checkResults();
    expect(groupsChecked()).toEqual([2]);
    expect(probes()).toHaveLength(1);

    sql.exec(`INSERT INTO weq_recall_log(table_kind,conv,orig_seq) VALUES ('group','70001',150);`);
    expected.unshift(['70001', '150']);
    budgeted.mockClear();
    await checkResults();
    expect(groupsChecked()).toEqual([3]);
    expect(budgeted.mock.calls.some(([, text]) => text.includes('MIN(orig_seq)'))).toBe(false);

    now += 30_000;
    sql.exec(`DELETE FROM weq_recall_log WHERE CAST(conv AS INTEGER)>=80001;`);
    budgeted.mockClear();
    await checkResults();
    expect(groupsChecked()).toEqual([4]);
    expect(probes()).toHaveLength(0);
    expect(databasePerformance(path).phases).toMatchObject({
      unreadSmallTables: { count: 6 },
      unreadSnapshotProjection: { count: 6 },
      unreadRecallLookup: { count: 6 },
      unreadRecallExtents: { count: 4 },
      unreadRecallPresence: { count: 4 },
    });
  } finally {
    clock.mockRestore();
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
  const contact = sql.prepare(
    'INSERT INTO recent_contact_v3_table VALUES (?,110,?,?,5,?,?,?,NULL)',
  );
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
