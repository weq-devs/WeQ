import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { GroupTodoTopBannerColumn } from '@weq/codec/proto/group_info/todo';
import { GroupTodoDb } from '../src/group_info/todo';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

/**
 * 真实账号 `group_todo_top_banner.48902` 的字节（见 codec 的
 * `group_todo.test.ts` 同一批样本）：一条「图片」待办 + 一条已消失的占位行。
 */
const PIC_HEX =
  'b2f017ad020aa402080f10021a103439363934335f333937383935303432200040b9e4e3ee065a0f080012005800' +
  '600068007200a20100620a0a0012001a00200028006a0b0800120058006200a2010072040a001200a201b6010a7f' +
  '0a5d68747470733a2f2f702e6971756e2e71712e636f6d2f7765622f7461736b2f323032353731352f3934336664' +
  '3339332d313963312d343432332d613561332d3366306134386435376231392d313735323535303038383235302e' +
  '706e67120ce7bea4e5be85e58a9eefbd9c1a085be59bbee789875d22002802300338001227080312001a217b227365' +
  '71223a3439363934332c2272616e646f6d223a3339373839353034327d18a8d0d2c60620a8d0d2c606c202040800' +
  '1000c802a29c01d002c801d80200e00200e80201f00201100018afaa1e';

const DISAPPEARED_HEX =
  'b2f0177a0a74080f10001a00200140005a0f080012005800600068007200a20100620a0a0012001a0020002800' +
  '6a0b0800120058006200a2010072040a001200a2011c0a0e0a0012001a0022002800300038001206080012001a00' +
  '18002000c2020408001000c802a29c01d00200d80200e00200e80200f0020010001800';

let dir: string;
let db: GroupTodoDb;

afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function newDb(): GroupTodoDb {
  dir = mkdtempSync(join(tmpdir(), 'weq-group-todo-'));
  return new GroupTodoDb(createSqliteStub(), { dbPath: join(dir, 'group_info.db') });
}

describe('group_todo_top_banner', () => {
  it('returns [] when the table does not exist (account never used 群待办)', async () => {
    db = newDb();
    // 建库但不建表 —— 模拟老账号 / 从没设置过待办。
    fixtureDb(join(dir, 'group_info.db')).exec('CREATE TABLE unrelated (x INTEGER)');

    await expect(db.listAll()).resolves.toEqual([]);
    await expect(db.getForGroup(10001n)).resolves.toBeNull();
  });

  it('reads a real banner and skips the isDisappear placeholder rows', async () => {
    db = newDb();
    const sql = fixtureDb(join(dir, 'group_info.db'));
    sql.exec('CREATE TABLE group_todo_top_banner ("48901" INTEGER PRIMARY KEY, "48902" BLOB)');
    const insert = sql.prepare('INSERT INTO group_todo_top_banner VALUES (?, ?)');
    insert.run(543984495n, Buffer.from(PIC_HEX, 'hex'));
    insert.run(602142028n, Buffer.from(DISAPPEARED_HEX, 'hex'));

    const all = await db.listAll();
    expect(all).toHaveLength(1);

    const todo = all[0]!;
    expect(todo.groupCode).toBe('543984495');
    expect(todo.msgSeq).toBe(496943n);
    expect(todo.msgRandom).toBe(397895042n);
    expect(todo.text).toBe('[图片]');
    expect(todo.preText).toBe('群待办｜');
    expect(todo.iconUrl).toContain('p.iqun.qq.com');
    expect(todo.jumpType).toBe(3);
    expect(JSON.parse(todo.jumpParam)).toEqual({ seq: 496943, random: 397895042 });
    expect(todo.createTime).toBe(1758767144);
    expect(todo.expireTime).toBe(1842934329);
    expect(todo.bannerType).toBe(2);

    // 占位行不算待办。
    await expect(db.getForGroup(602142028n)).resolves.toBeNull();
    await expect(db.getForGroup(543984495n)).resolves.toEqual(todo);
  });

  it('falls back to msgId when jumpParam is missing', async () => {
    db = newDb();
    const sql = fixtureDb(join(dir, 'group_info.db'));
    sql.exec('CREATE TABLE group_todo_top_banner ("48901" INTEGER PRIMARY KEY, "48902" BLOB)');
    // 只有 msgId、没有 jumpParam 的横幅：seq/random 仍然要从 msgId 里读出来。
    const blob = new ProtoMsg(GroupTodoTopBannerColumn).encode({
      info: {
        banner: {
          bizType: 15,
          bannerType: 2,
          msgId: '777_888',
          commonBanner: { ui: { text: '[文件]a.docx' }, createTime: 10n, updateTime: 11n },
        },
      },
    });
    sql.prepare('INSERT INTO group_todo_top_banner VALUES (?, ?)').run(10001n, Buffer.from(blob));

    const todo = await db.getForGroup(10001n);
    expect(todo?.msgSeq).toBe(777n);
    expect(todo?.msgRandom).toBe(888n);
    expect(todo?.text).toBe('[文件]a.docx');
  });

  it('ignores rows of other bizTypes and garbage blobs', async () => {
    db = newDb();
    const sql = fixtureDb(join(dir, 'group_info.db'));
    sql.exec('CREATE TABLE group_todo_top_banner ("48901" INTEGER PRIMARY KEY, "48902" BLOB)');
    const proto = new ProtoMsg(GroupTodoTopBannerColumn);
    const other = proto.encode({
      info: { banner: { bizType: 99, bannerType: 2, msgId: '1_1' } },
    });
    const insert = sql.prepare('INSERT INTO group_todo_top_banner VALUES (?, ?)');
    insert.run(10001n, Buffer.from(other));
    insert.run(10002n, Buffer.from([0xff, 0xff, 0xff]));

    await expect(db.listAll()).resolves.toEqual([]);
  });
});
