/**
 * `appendClonedRow` —— 新增消息的 seq 契约。
 *
 * 锁住两件事：
 *  - 新消息的 seq = 该会话 `MAX("40003") + 1`。fixture 故意把「行序」与「seq 序」
 *    拆开（最后插入的那行不是最大 seq），因为「模板行 + 1」与「MAX + 1」只有在两者
 *    同序时才碰巧一致 —— 同序正是这条契约最容易悄悄退化的地方；
 *  - 模板行只负责携带不透明列：40801 / 40900 / 40062 被置空（拷过来会让回复 /
 *    转发渲染错乱），其余列原样跟着模板走。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupMsgDb } from '@weq/db';
import type { AppendMsgFields } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const GROUP = '777';
/** 隔壁群，用来证明 MAX 不会跨会话串台。 */
const OTHER_GROUP = '999';

let dir: string;
let dbPath: string;
let db: GroupMsgDb;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-append-'));
  dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`
    CREATE TABLE group_msg_table (
      "40001" INTEGER, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
      "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
      "40050" INTEGER, "40058" INTEGER, "40062" BLOB, "40800" BLOB,
      "40801" BLOB, "40900" BLOB, "42000" TEXT
    )
  `);
  const ins = sql.prepare(
    `INSERT INTO group_msg_table
       ("40001","40002","40003","40011","40012","40020","40027","40033",
        "40050","40058","40062","40800","40801","40900","42000")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const row = (
    group: string,
    msgId: number,
    seq: number,
    sendTime: number,
    opaque: string,
  ): void => {
    ins.run(
      BigInt(msgId),
      1n,
      BigInt(seq),
      2n,
      16n,
      'u_sender',
      group,
      10001n,
      BigInt(sendTime),
      0n,
      null,
      null,
      null,
      null,
      opaque,
    );
  };

  // 插入顺序刻意打乱：最大 seq 的行是第二行，最后插入的反而是 seq=20 那行。
  row(GROUP, 11, 10, 1000, 'seq10');
  row(GROUP, 12, 30, 3000, 'seq30'); // 模板行（最大 seq）
  row(GROUP, 13, 20, 2000, 'seq20'); // 最后插入
  row(OTHER_GROUP, 14, 500, 5000, 'other');

  db = new GroupMsgDb(createSqliteStub(), { dbPath });
}

function fields(overrides: Partial<AppendMsgFields> = {}): AppendMsgFields {
  return {
    senderUid: 'u_new',
    senderUin: 424242n,
    msgType: 2,
    sendTime: 9999n,
    dayTimestamp: 9600n,
    body: new Uint8Array([0xaa, 0xbb, 0xcc]),
    ...overrides,
  };
}

function sql() {
  return fixtureDb(join(dir, 'nt_msg.db'));
}

describe('appendClonedRow', () => {
  it('takes the new seq from MAX(40003) + 1, not from the newest row', async () => {
    createFixture();

    const res = await db.appendMessage(GROUP, fields());
    expect(res).not.toBeNull();
    // 最大 seq 是 30（不是最后插入的 20），所以新 seq 必须是 31。
    expect(res?.msgSeq).toBe(31n);

    const rows = sql()
      .prepare(`SELECT "40003" FROM group_msg_table WHERE "40027" = ? ORDER BY "40003"`)
      .all(GROUP) as Array<{ '40003': number }>;
    expect(rows.map((r) => r['40003'])).toEqual([10, 20, 30, 31]);
  });

  it('keeps MAX scoped to the target conversation', async () => {
    createFixture();

    // 隔壁群有一条 seq=500 的消息，不能把本群的 seq 顶上去。
    const res = await db.appendMessage(GROUP, fields());
    expect(res?.msgSeq).toBe(31n);
  });

  it('hides the template row only for the opaque columns', async () => {
    createFixture();

    const res = await db.appendMessage(GROUP, fields({ sendTime: 9999n, dayTimestamp: 9600n }));
    expect(res).not.toBeNull();

    const written = sql()
      .prepare(
        `SELECT "40011","40020","40033","40050","40058","40062","40801","40900","42000"
           FROM group_msg_table WHERE "40001" = ?`,
      )
      .get(res!.msgId) as Record<string, unknown>;

    expect(written['40011']).toBe(2); // caller msgType
    expect(written['40020']).toBe('u_new');
    expect(String(written['40033'])).toBe('424242');
    expect(written['40050']).toBe(9999);
    expect(written['40058']).toBe(9600);
    // 模板行只贡献不透明列 —— 以及那条被刻意写进 42000 的标记。
    expect(written['42000']).toBe('seq30');
    // 这三个必须被清空，拷过来会让回复 / 转发 / 贴表情渲染错乱。
    expect(written['40062']).toBeNull();
    expect(written['40801']).toBeNull();
    expect(written['40900']).toBeNull();
  });

  it('returns null when the conversation has no message to clone', async () => {
    createFixture();
    expect(await db.appendMessage('no-such-group', fields())).toBeNull();
  });
});
