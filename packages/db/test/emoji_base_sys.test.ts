/**
 * `BaseSysEmojiDb` —— emoji.db `base_sys_emoji_table` 的读取回归。
 *
 * 重点锁两件事：
 *   1. SELECT 的列顺序与 `rowToSysEmoji` 的按下标取值一一对应（加列最容易在这里
 *      错位 —— 81216/81217 插在中间，后面的 special/emojiType/category/urls 全部
 *      跟着往后挪，错一位就是静默串列）；
 *   2. 81216(packId) / 81217(stickerId) 的「有没有」判定：两者都非空且非 '0'
 *      才算 sticker，只填一个 / 填 '0' / 填 NULL 都不算。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseSysEmojiDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir: string;

afterEach(() => {
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

/** 建一张只含被测列的 base_sys_emoji_table，插一行。 */
function seedDb(values: Record<string, string | number | null>): BaseSysEmojiDb {
  dir = mkdtempSync(join(tmpdir(), 'weq-emoji-'));
  const dbPath = join(dir, 'emoji.db');
  const sql = fixtureDb(dbPath);
  const columns = [
    '81211',
    '81212',
    '81214',
    '81216',
    '81217',
    '81221',
    '81226',
    '81266',
    '81229',
    '81230',
  ];
  sql.exec(`CREATE TABLE base_sys_emoji_table (${columns.map((c) => `"${c}"`).join(', ')})`);
  const placeholders = columns.map(() => '?').join(', ');
  // node:sqlite 的 exec 不接受绑定参数，用 prepare().run() 传值（NULL 也照绑）。
  sql
    .prepare(`INSERT INTO base_sys_emoji_table VALUES (${placeholders})`)
    .run(...columns.map((c) => values[c] ?? null));
  return new BaseSysEmojiDb(createSqliteStub(), { dbPath });
}

describe('BaseSysEmojiDb', () => {
  it('贴纸行：81216/81217 都非空时 sticker=true，且各列不串位', async () => {
    const db = seedDb({
      81211: '358',
      81212: '/骰子',
      81214: 0,
      81216: 1,
      81217: 33,
      81221: 0,
      81226: 3,
      81266: '',
      81229: 'https://static/358.png',
      81230: 'https://apng/358.png',
    });
    expect(await db.listAll()).toEqual([
      {
        id: '358',
        desc: '/骰子',
        unicodeId: 0,
        packId: '1',
        stickerId: '33',
        sticker: true,
        special: 0,
        emojiType: 3,
        category: '',
        staticUrl: 'https://static/358.png',
        apngUrl: 'https://apng/358.png',
      },
    ]);
  });

  it('小黄脸行：81216/81217 为 NULL / 0 / 只填一个都不算贴纸', async () => {
    const cases: Array<Record<string, string | number | null>> = [
      { 81216: null, 81217: null },
      { 81216: 0, 81217: 0 },
      { 81216: 1, 81217: null },
      { 81216: null, 81217: 33 },
    ];
    for (const [index, extra] of cases.entries()) {
      const db = seedDb({
        81211: String(index),
        81212: '/微笑',
        81214: 0,
        81221: 0,
        81226: 1,
        81266: '小黄脸表情',
        81229: '',
        81230: '',
        ...extra,
      });
      const [row] = await db.listAll();
      expect(row?.sticker, `case ${index}`).toBe(false);
      expect(row?.category, `case ${index}`).toBe('小黄脸表情');
      // 分类列若因为串位被读成别的列，这里会立刻炸。
      expect(row?.emojiType, `case ${index}`).toBe(1);
      closeAllFixtureDbs();
    }
  });
});
