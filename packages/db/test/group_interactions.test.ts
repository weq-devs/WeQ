/**
 * 群聊互动聚合（`GroupMsgDb.tallyInteractions`）的离线回归 —— 用真实正文
 * （40800 编码后解码回 Element）在一个两行 SQLite fixture 上跑一遍，锁住年度报告
 * @ / 戳 / 复读三页共用的六组统计。
 *
 * 重点锁住这次拆页新增的两件事：
 *  - **被戳方向**（pokeMe）：别人戳到我要单独计数，并且冠军是「戳我最勤的人」，
 *    不能把我戳出去的那一半也算进去；
 *  - **去重人数**（at.distinct / atMe.distinct）：@ 的次数与「喊过多少个不同的
 *    名字」是两个口径，重复 @ 同一个人只加次数不加人数。
 *
 * 复读口径（连续相同正文 ≥ 4 条且至少两人）与「我参与过的最长一轮」也一并锁住。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeElement, GrayTipSubType, ProtoMsg, type Element } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const GROUP = '777';
const SELF_UID = 'u_me';

let dir: string;
let db: GroupMsgDb;

const bodyCodec = new ProtoMsg(MsgBody);

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

/** 把一组 Element 编码成 40800 的 BLOB。 */
function encodeBody(elements: Element[]): Uint8Array {
  return bodyCodec.encode({ elements: elements.map((element) => encodeElement(element)) });
}

/** 一条纯文本消息。 */
function text(content: string): Element[] {
  return [{ kind: 'text', textContent: content }];
}

/** 一条带 @ 的消息（`atTargetUid` 非空才会解码成 at 而不是 text）。 */
function mention(targetUid: string, name: string): Element[] {
  return [{ kind: 'at', textContent: `@${name}`, atTargetUid: targetUid }];
}

/** 一条戳一戳灰条。 */
function poke(
  initiatorUid: string,
  initiatorName: string,
  targetUid: string,
  targetName: string,
): Element[] {
  return [
    {
      kind: 'grayTipPoke',
      subType: GrayTipSubType.JSON,
      actionId: 0,
      detailedId: 1061,
      typeFlag: 0,
      grayTipXmlContent: '',
      businessId: 0,
      actionUniqueId: 0,
      tipJson: '',
      tipType: 0,
      actionInitiator: { uid: initiatorUid, nickname: initiatorName },
      actionTarget: { uid: targetUid, nickname: targetName },
    },
  ];
}

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-group-interactions-'));
  const sql = fixtureDb(join(dir, 'nt_msg.db'));
  sql.exec(`
    CREATE TABLE group_msg_table (
      "40001" INTEGER, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
      "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
      "40050" INTEGER, "40062" BLOB, "40800" BLOB, "40801" BLOB
    )
  `);
  const ins = sql.prepare(
    `INSERT INTO group_msg_table
       ("40001","40002","40003","40011","40012","40020","40027","40033","40050","40062","40800","40801")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ins.setReadBigInts(true);

  const rows: Array<{ sender: string; uin: bigint; elements: Element[] }> = [
    // 连续四条一样的正文 → 一个达标复读回合，且我参与过。
    { sender: 'u_a', uin: 10001n, elements: text('哈哈哈') },
    { sender: SELF_UID, uin: 10002n, elements: text('哈哈哈') },
    { sender: 'u_b', uin: 10003n, elements: text('哈哈哈') },
    { sender: 'u_c', uin: 10004n, elements: text('哈哈哈') },
    // 我 @ 同一个人两次：次数 +2，人数只 +1。
    { sender: SELF_UID, uin: 10002n, elements: mention('u_b', 'B') },
    { sender: SELF_UID, uin: 10002n, elements: mention('u_b', 'B') },
    // 别人 @ 我一次。
    { sender: 'u_b', uin: 10003n, elements: mention(SELF_UID, '我') },
    // 我戳出去一次。
    { sender: SELF_UID, uin: 10002n, elements: poke(SELF_UID, '我', 'u_b', 'B') },
    // 别人戳我一次。
    { sender: 'u_b', uin: 10003n, elements: poke('u_b', 'B', SELF_UID, '我') },
  ];

  rows.forEach((row, index) => {
    ins.run(
      BigInt(index + 1), // 40001
      1n, // 40002
      BigInt(index + 1), // 40003
      2n, // 40011
      16n, // 40012
      row.sender, // 40020
      GROUP, // 40027
      row.uin, // 40033
      BigInt(1700000000 + index), // 40050
      null, // 40062
      encodeBody(row.elements), // 40800
      null, // 40801
    );
  });

  db = new GroupMsgDb(createSqliteStub(), { dbPath: join(dir, 'nt_msg.db') });
}

describe('GroupMsgDb.tallyInteractions (offline fixture)', () => {
  it('separates poking out from being poked', async () => {
    createFixture();

    const tally = await db.tallyInteractions({ senderUid: SELF_UID });

    expect(tally.poke.total).toBe(1);
    expect(tally.poke.top?.targetUid).toBe('u_b');
    expect(tally.poke.top?.count).toBe(1);

    expect(tally.pokeMe.total).toBe(1);
    expect(tally.pokeMe.top?.targetUid).toBe('u_b');
    expect(tally.pokeMe.top?.displayName).toBe('B');
  });

  it('counts @ by total and by distinct people separately', async () => {
    createFixture();

    const tally = await db.tallyInteractions({ senderUid: SELF_UID });

    // 我 @ 同一个人两次：总次数 2，人数 1。
    expect(tally.at.total).toBe(2);
    expect(tally.at.distinct).toBe(1);
    expect(tally.at.top?.targetUid).toBe('u_b');
    expect(tally.at.top?.count).toBe(2);

    // 别人 @ 我一次：总次数 1，人数 1，落点是我所在的那个群。
    expect(tally.atMe.total).toBe(1);
    expect(tally.atMe.distinct).toBe(1);
    expect(tally.atMe.topGroup?.groupCode).toBe(GROUP);
  });

  it('keeps the echo run totals and the longest run I joined', async () => {
    createFixture();

    const tally = await db.tallyInteractions({ senderUid: SELF_UID });

    expect(tally.echo.runs).toBe(1);
    expect(tally.echo.messages).toBe(4);
    expect(tally.echo.participatedRuns).toBe(1);
    expect(tally.echo.longest?.count).toBe(4);
    expect(tally.echo.longest?.text).toBe('哈哈哈');
    expect(tally.echo.mineLongest?.count).toBe(4);
    expect(tally.echo.mineLongest?.groupCode).toBe(GROUP);
  });
});
