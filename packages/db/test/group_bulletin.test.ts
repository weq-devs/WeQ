import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtoField, ProtoMsg, ScalarType } from '@weq/codec';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { GroupBulletinDb } from '../src/group_info/bulletin';

// 独立夹具模拟正文、图片和尾部标签，不能依赖生产 schema 已经认识类型字段。
const itemWire = {
  type: ProtoField(64451, ScalarType.INT32, { optional: true }),
  textContent: ProtoField(64452, ScalarType.STRING, { optional: true }),
};
const containerWire = { items: ProtoField(64242, () => itemWire, { repeat: true }) };
const detailWire = { contentContainer: ProtoField(64227, () => containerWire, { optional: true }) };
const bodyWire = { detail: ProtoField(64202, () => detailWire, { optional: true }) };
const fixtureCodec = new ProtoMsg({ body: ProtoField(64205, () => bodyWire, { optional: true }) });
let dir = '';
let db: GroupBulletinDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function read(items: Array<{ type?: number; textContent?: string }>) {
  dir = mkdtempSync(join(tmpdir(), 'weq-bulletin-'));
  const path = join(dir, 'group_info.db');
  db = new GroupBulletinDb(createSqliteStub(), { dbPath: path });
  const sql = fixtureDb(path);
  sql.exec('CREATE TABLE group_bulletin ("60001" INTEGER PRIMARY KEY, "64205" BLOB)');
  sql
    .prepare('INSERT INTO group_bulletin VALUES (?, ?)')
    .run(
      10001n,
      Buffer.from(fixtureCodec.encode({ body: { detail: { contentContainer: { items } } } })),
    );
  return (await db.listBulletins(10001n))[0].textContent;
}
describe('群公告正文与标签分离', () => {
  it('类型 10 的尾部标签不是正文，图片项不引入额外空行', async () => {
    expect(
      await read([
        { type: 0, textContent: '合成公告正文' },
        { type: 3 },
        { type: 10, textContent: '群公告' },
      ]),
    ).toBe('合成公告正文');
  });
  it('正文里的合法“群公告”和原有空白、换行原样保留', async () => {
    const body = '  关于群公告\n这段正文结尾就是群公告  ';
    expect(
      await read([
        { type: 0, textContent: body },
        { type: 10, textContent: '群公告' },
      ]),
    ).toBe(body);
  });
  it('空文本段落保留，非文本项缺少文本时跳过', async () => {
    expect(
      await read([
        { type: 0, textContent: '第一段' },
        { type: 0, textContent: '' },
        { type: 3 },
        { type: 0, textContent: '第二段\n最后一行' },
        { type: 10, textContent: '群公告' },
      ]),
    ).toBe('第一段\n\n第二段\n最后一行');
  });
  it('旧数据缺少类型与未知类型的文字不误删，标签文案不硬编码', async () => {
    expect(
      await read([
        { textContent: '旧公告' },
        { type: 999, textContent: '未识别类型的文字' },
        { type: 10, textContent: '其他标签' },
      ]),
    ).toBe('旧公告\n未识别类型的文字');
  });
});
