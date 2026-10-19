/**
 * `UnreadInfoDb` —— 未读/高亮的读语义 + 标记已读的**字节级**写回。
 *
 * 用真实 sqlite fixture + 真机抓到的 48902 blob 跑完整链路（不是 mock）：
 *   1. `getUnreadInfo` 能把 50060 高亮组展平成一个类别一条（含最大 seq）。
 *   2. `markRead` 抬 `41002` 到会话最新 seq、清掉所有 50060 组，
 *      同时**逐字节保留**未解析字段（41024 / 41027 / 41032 / 50006 / 50007 …）——
 *      这是「不能把整条 blob 用 schema 重编码」的原因（会丢 1/3 字节）。
 *   3. 幂等：已读且无高亮时再调一次不再写。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnreadInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const GROUP = '673646675';

/** 真机 blob：群 673646675，读 1731，一条 2005 高亮 @1732，带 41027/41032/41037。 */
const GROUP_BLOB =
  'B2F01772D0C41302AAC51309363733363436363735D08214C30D98841400C08414C30DE8841400AAB5184B8AB5180936373336343636373590B51802E2B8183680B518D50FC2B7182DA0B618C40DB2B61818755F74584D4B33706B6E6B6B4D7967363954426943367867B8B618F58C8AD606C2B61800';
/** 真机 blob：群 543984495，读 531800，两组高亮（2005@532195 / 2002@532771），带 41024 一串。 */
const GROUP_BLOB_TWO_HIGHLIGHTS =
  'B2F0179003D0C41302AAC51309353433393834343935D08214D8BA208284140698C413ADBC208284140698C413A4BC208284140698C4139ABC208284140698C413CBBB208284140698C4139ABB208284140698C413FCBA208284140698C4139FBD208284140698C413FBBE208284140698C413B4BE208284140698C4138DBE208284140698C413CABD208284140698C413B6BD208284140698C413A9BF208284140698C413A0C1208284140698C4138CC1208284140698C413B6C0208284140698C41390C0208284140698C4138BC0208284140698C413D6C1208284140698C413C1C1208284140698C413BFC1208284140698C413BDC1208284140698C413BBC1208284140698C413A5C4208284140698C413ECC2208284140698C413DCC22098841400C08414DDB420E8841400AAB518638AB5180935343339383434393590B51802B0B518E4BD20B8B518A3C220E2B8181F80B518D50FC2B71816A0B618E3BD20A8B618B6C7EBDE01B8B618D3BDECD506E2B8181F80B518D20FC2B71816A0B618A3C220A8B618B8E7F8FA0FB8B618F9CA83D606';

let dir: string;
let db: UnreadInfoDb;
let dbPath: string;

afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

function blobOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((h) => Number.parseInt(h, 16)));
}

function setup(peer: string, blobHex: string, latestSeq: number): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-unread-'));
  dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE msg_unread_info_table ("48901" TEXT PRIMARY KEY, "48902" BLOB)`);
  sql.exec(
    `CREATE TABLE recent_contact_v3_table ("40021" TEXT, "40003" INTEGER, "40010" INTEGER DEFAULT 2)`,
  );
  sql.prepare(`INSERT INTO msg_unread_info_table VALUES (?, ?)`).run(peer, blobOf(blobHex));
  sql
    .prepare(`INSERT INTO recent_contact_v3_table ("40021", "40003") VALUES (?, ?)`)
    .run(peer.split('_').slice(1).join('_'), latestSeq);
  db = new UnreadInfoDb(createSqliteStub(), { dbPath });
}

/** Hex of the stored 48902 blob, read straight from the fixture file. */
function storedHex(): string {
  const row = fixtureDb(dbPath)
    .prepare(`SELECT hex("48902") AS h FROM msg_unread_info_table LIMIT 1`)
    .get() as { h: string } | undefined;
  // SQLite 的 hex() 返回大写 —— 统一小写，便于断言 tag 字节。
  return (row?.h ?? '').toLowerCase();
}

describe('UnreadInfoDb.getUnreadInfo', () => {
  it('损坏的未读 BLOB 不影响同批其它会话，也不冒充空未读', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    fixtureDb(dbPath)
      .prepare(`INSERT INTO msg_unread_info_table VALUES (?, ?)`)
      .run('1_u_bad', blobOf('ff'));
    const rows = await db.getUnreadInfos([
      { chatType: 2, uid: GROUP },
      { chatType: 1, uid: 'u_bad' },
    ]);
    expect(rows[0]).toMatchObject({ msgSeq: 1731 });
    expect(rows[1]).toMatchObject({ uid: 'u_bad', readError: true });
  });
  it('批量读取包含同一快照的最新与已读序号，缺行返回空水位且目标去重', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const query = vi.spyOn(nt, 'executeSql');
    const reader = new UnreadInfoDb(nt, { dbPath });
    const targets = [
      { chatType: 2, uid: GROUP },
      { chatType: 1, uid: 'u_missing' },
    ];
    const rows = await reader.getUnreadInfos([...targets, targets[0]!]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ uid: GROUP, msgSeq: 1731, latestSeq: '1732' });
    expect(rows[0]?.highlights).toEqual((await db.getUnreadInfo(2, GROUP))?.highlights);
    expect(rows[1]).toMatchObject({ uid: 'u_missing', latestSeq: null, msgSeq: undefined });
    expect(await reader.getUnreadInfos([])).toEqual([]);
  });

  it('大量会话分批读取，不超过 SQLite 参数上限，不混淆同 UID 的会话类型', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const query = vi.spyOn(nt, 'executeSql');
    const targets = Array.from({ length: 600 }, (_, i) => ({ chatType: 1, uid: `u_${i}` }));
    targets.push({ chatType: 1, uid: GROUP }, { chatType: 2, uid: GROUP });
    const rows = await new UnreadInfoDb(nt, { dbPath }).getUnreadInfos(targets);
    expect(query).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(targets.length);
    expect(rows.find((r) => r.uid === GROUP && r.chatType === 1)?.latestSeq).toBeNull();
    expect(rows.find((r) => r.uid === GROUP && r.chatType === 2)?.latestSeq).toBe('1732');
  });

  it('flattens one highlight group into one entry with its newest seq', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const info = await db.getUnreadInfo(2, GROUP);
    expect(info?.msgSeq).toBe(1731);
    expect(info?.highlights).toEqual([
      {
        kind: 'groupAnnouncement',
        rawKind: 2005,
        msgSeq: 1732,
        senderUid: 'u_tXMK3pknkkMyg69TBiC6xg',
        sendTime: 1791133301,
        text: '',
      },
    ]);
  });

  it('keeps one entry per category, each with its own max seq', async () => {
    setup('2_543984495', GROUP_BLOB_TWO_HIGHLIGHTS, 532771);
    const info = await db.getUnreadInfo(2, '543984495');
    const kinds = (info?.highlights ?? []).map((h) => h.kind);
    expect(kinds).toEqual(['groupAnnouncement', 'unknown']);
    expect(info?.highlights?.[0]?.msgSeq).toBe(532195);
    expect(info?.highlights?.[1]?.msgSeq).toBe(532771);
  });

  it('returns null for a conversation with no unread row', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    expect(await db.getUnreadInfo(2, 'not-a-real-group')).toBeNull();
  });
});

describe('UnreadInfoDb.markRead', () => {
  it('并发更新已读水位时重新读取，不用旧 BLOB 覆盖 QQ 的新水位', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const write = nt.executeSqlWrite.bind(nt);
    let raced = false;
    nt.executeSqlWrite = async (...args) => {
      if (!raced) {
        raced = true;
        await db.markRead(2, GROUP, '1800');
      }
      return write(...args);
    };
    const concurrent = new UnreadInfoDb(nt, { dbPath });
    await concurrent.markRead(2, GROUP, '1732');
    expect((await db.getUnreadInfo(2, GROUP))?.msgSeq).toBe(1800);
  });

  it('并发到达的新提醒不被本次已读清除，也不扩大确认的消息范围', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const write = nt.executeSqlWrite.bind(nt);
    let raced = false;
    nt.executeSqlWrite = async (...args) => {
      if (!raced) {
        raced = true;
        await db.addHighlight(2, GROUP, {
          kind: 2006,
          msgSeq: 1740,
          senderUid: 'u_fixture',
          sendTime: 1,
          text: '新提醒',
        });
        fixtureDb(dbPath).exec(`UPDATE recent_contact_v3_table SET "40003" = 1740`);
      }
      return write(...args);
    };
    await new UnreadInfoDb(nt, { dbPath }).markRead(2, GROUP);
    const after = await db.getUnreadInfo(2, GROUP);
    expect(after?.msgSeq).toBe(1732);
    expect(after?.highlights).toMatchObject([{ kind: 'groupKeyword', msgSeq: 1740 }]);
  });

  it('持续冲突时有界退出，不能把没有写成当作成功', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const write = vi.fn(async () => 0);
    nt.executeSqlWrite = write;
    await expect(new UnreadInfoDb(nt, { dbPath }).markRead(2, GROUP)).rejects.toThrow('冲突');
    expect(write.mock.calls.length).toBeLessThanOrEqual(3);
    expect((await db.getUnreadInfo(2, GROUP))?.msgSeq).toBe(1731);
  });

  it('raises the read watermark and drops the highlight, preserving unknown fields', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    expect(await db.markRead(2, GROUP)).toBe(true);

    const after = await db.getUnreadInfo(2, GROUP);
    expect(after?.msgSeq).toBe(1732);
    expect(after?.highlights).toBeUndefined();

    // 未解析字段仍在原位：41032 与 50005→50001/50002 都逐字节保留。
    const raw = storedHex();
    expect(raw).toContain('8841400'); // 41032 的 tag/值字节
    expect(raw).toContain('8ab518'); // 50005 ext
    expect(raw).not.toContain('e2b818'); // 50060 已被移除
  });

  it('drops every highlight group when a blob carries more than one', async () => {
    setup('2_543984495', GROUP_BLOB_TWO_HIGHLIGHTS, 532771);
    expect(await db.markRead(2, '543984495', 532771n)).toBe(true);
    const after = await db.getUnreadInfo(2, '543984495');
    expect(after?.msgSeq).toBe(532771);
    expect(after?.highlights).toBeUndefined();
    const raw = storedHex();
    expect(raw).toContain('98c413'); // 41024 子项仍在
  });

  it('is idempotent — a second call on a read conversation is a no-op', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    expect(await db.markRead(2, GROUP)).toBe(true);
    expect(await db.markRead(2, GROUP)).toBe(false);
  });

  it('uses the explicit latestSeq when no recent-contact row exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'weq-unread-'));
    dbPath = join(dir, 'nt_msg.db');
    const sql = fixtureDb(dbPath);
    sql.exec(`CREATE TABLE msg_unread_info_table ("48901" TEXT PRIMARY KEY, "48902" BLOB)`);
    sql
      .prepare(`INSERT INTO msg_unread_info_table VALUES (?, ?)`)
      .run(`2_${GROUP}`, blobOf(GROUP_BLOB));
    db = new UnreadInfoDb(createSqliteStub(), { dbPath });
    expect(await db.markRead(2, GROUP, '9999')).toBe(true);
    expect((await db.getUnreadInfo(2, GROUP))?.msgSeq).toBe(9999);
  });

  it('refuses to write when there is no row or no usable watermark', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    expect(await db.markRead(2, 'missing')).toBe(false);
    expect(await db.markRead(2, GROUP, '0')).toBe(false);
  });
});

describe('UnreadInfoDb.addHighlight', () => {
  it('已读范围内的晚到提醒不会重新点亮会话', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    await db.markRead(2, GROUP, 1800);
    expect(
      await db.addHighlight(2, GROUP, {
        kind: 2006,
        msgSeq: 1740,
        senderUid: 'u_fixture',
        sendTime: 1,
        text: '晚到提醒',
      }),
    ).toBe(false);
    expect((await db.getUnreadInfo(2, GROUP))?.highlights).toBeUndefined();
  });
  it('新增提醒与已读并发时不把水位回退或恢复已经清除的提醒', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const nt = createSqliteStub();
    const write = nt.executeSqlWrite.bind(nt);
    let raced = false;
    nt.executeSqlWrite = async (...args) => {
      if (!raced) {
        raced = true;
        await db.markRead(2, GROUP);
      }
      return write(...args);
    };
    await new UnreadInfoDb(nt, { dbPath }).addHighlight(2, GROUP, {
      kind: 2006,
      msgSeq: 1740,
      senderUid: 'u_fixture',
      sendTime: 1,
      text: '新提醒',
    });
    const after = await db.getUnreadInfo(2, GROUP);
    expect(after?.msgSeq).toBe(1732);
    expect(after?.highlights).toMatchObject([{ kind: 'groupKeyword', msgSeq: 1740 }]);
  });

  it('writes a 2006 群提醒词 highlight into an existing row', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const ok = await db.addHighlight(2, GROUP, {
      kind: 2006,
      msgSeq: 1740,
      senderUid: 'u_sender',
      sendTime: 1791133400,
      text: '报名接龙',
    });
    expect(ok).toBe(true);

    const after = await db.getUnreadInfo(2, GROUP);
    const keyword = after?.highlights?.find((h) => h.kind === 'groupKeyword');
    expect(keyword).toMatchObject({
      rawKind: 2006,
      msgSeq: 1740,
      senderUid: 'u_sender',
      sendTime: 1791133400,
      // 50024 存命中的关键词，UI 据此区分是哪个提醒词命中的。
      text: '报名接龙',
    });
    // 原来的 2005 高亮仍在，且 41002 未被这台写操作抬高。
    expect(after?.msgSeq).toBe(1731);
    expect(after?.highlights?.some((h) => h.kind === 'groupAnnouncement')).toBe(true);
  });

  it('is idempotent per (kind, msgSeq)', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    const hit = {
      kind: 2006,
      msgSeq: 1740,
      senderUid: 'u_sender',
      sendTime: 1791133400,
      text: '报名',
    };
    expect(await db.addHighlight(2, GROUP, hit)).toBe(true);
    expect(await db.addHighlight(2, GROUP, hit)).toBe(false);
  });

  it('creates a minimal row when the conversation has no unread record', async () => {
    dir = mkdtempSync(join(tmpdir(), 'weq-unread-'));
    dbPath = join(dir, 'nt_msg.db');
    const sql = fixtureDb(dbPath);
    sql.exec(`CREATE TABLE msg_unread_info_table ("48901" TEXT PRIMARY KEY, "48902" BLOB)`);
    sql.exec(`CREATE TABLE recent_contact_v3_table ("40021" TEXT, "40003" INTEGER)`);
    db = new UnreadInfoDb(createSqliteStub(), { dbPath });

    expect(
      await db.addHighlight(2, GROUP, {
        kind: 2006,
        msgSeq: 500,
        senderUid: 'u_sender',
        sendTime: 1791133400,
        text: '报名',
      }),
    ).toBe(true);
    const after = await db.getUnreadInfo(2, GROUP);
    expect(after?.msgSeq).toBe(499);
    expect(after?.highlights?.[0]).toMatchObject({ kind: 'groupKeyword', msgSeq: 500 });
  });

  it('groups multiple hits of the same kind under one 50060', async () => {
    setup(`2_${GROUP}`, GROUP_BLOB, 1732);
    await db.addHighlight(2, GROUP, {
      kind: 2006,
      msgSeq: 1740,
      senderUid: 'u_a',
      sendTime: 1,
      text: 'a',
    });
    await db.addHighlight(2, GROUP, {
      kind: 2006,
      msgSeq: 1741,
      senderUid: 'u_b',
      sendTime: 2,
      text: 'b',
    });
    // 展平后同类只留 seq 最大的一条。
    const after = await db.getUnreadInfo(2, GROUP);
    const keywords = (after?.highlights ?? []).filter((h) => h.kind === 'groupKeyword');
    expect(keywords).toHaveLength(1);
    expect(keywords[0]?.msgSeq).toBe(1741);
  });
});
