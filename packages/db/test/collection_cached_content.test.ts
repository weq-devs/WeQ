import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { CollectionRichMediaContentColumn } from '@weq/codec/proto/collection/index';
import { CollectionDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir = '';
let db: CollectionDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function setup(withContentTable = true): { dbPath: string; sql: ReturnType<typeof fixtureDb> } {
  dir = mkdtempSync(join(tmpdir(), 'weq-collection-cache-'));
  const dbPath = join(dir, 'collection.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE collection_list_info_table(
    "180001" TEXT PRIMARY KEY,
    "180002" INTEGER,
    "180009" INTEGER,
    "180010" INTEGER,
    "180012" INTEGER,
    "180004" BLOB,
    "180015" BLOB
  )`);
  if (withContentTable) {
    sql.exec(`CREATE TABLE content_list_info_table(
      "180700" TEXT PRIMARY KEY,
      "180720" INTEGER,
      "180701" BLOB,
      "180702" BLOB,
      "180703" BLOB,
      "180704" BLOB,
      "180705" BLOB,
      "180706" BLOB,
      "180707" BLOB,
      "180708" BLOB
    )`);
  }
  db = new CollectionDb(createSqliteStub(), { dbPath });
  return { dbPath, sql };
}

describe('CollectionDb official-client detail cache', () => {
  it('joins a lossless rich-media detail cached after QQ opens the item', async () => {
    const { sql } = setup();
    sql
      .prepare(`INSERT INTO collection_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?) `)
      .run('cid-rich', 8, 1000, 3000, 2000, null, null);
    const html = '<div><span>完整正文</span><br></div>';
    const encoded = new ProtoMsg(CollectionRichMediaContentColumn).encode({
      content: { rawData: html, bizDataList: ['biz'] },
    });
    sql
      .prepare(`INSERT INTO content_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('cid-rich', 3000, null, null, null, null, null, null, null, encoded);

    const items = await db!.listAll(20, 0);
    expect(items).toHaveLength(1);
    expect(items[0]?.cachedContent?.recordTime).toBe(3000);
    expect(Buffer.from(items[0]!.cachedContent!.richMedia!)).toEqual(Buffer.from(encoded));
    expect(items[0]?.cachedContent?.richMediaContent).toEqual({
      rawData: html,
      bizDataList: ['biz'],
    });
    expect(items[0]?.cachedContent?.text).toBeUndefined();
  });

  it('preserves cached bytes even when they are not UTF-8 text', async () => {
    const { sql } = setup();
    sql
      .prepare(`INSERT INTO collection_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?) `)
      .run('cid-audio', 4, 1000, 3000, 2000, null, null);
    const raw = Buffer.from([0xff, 0x00, 0x81, 0x7f]);
    sql
      .prepare(`INSERT INTO content_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('cid-audio', 3000, null, null, null, raw, null, null, null, null);

    const cached = await db!.cachedContent('cid-audio');
    expect(Buffer.from(cached!.audio!)).toEqual(raw);
  });

  it('keeps old collection databases working when the content table is absent', async () => {
    const { sql } = setup(false);
    sql
      .prepare(`INSERT INTO collection_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?) `)
      .run('cid-old', 1, 1000, 3000, 2000, null, null);

    const items = await db!.listAll(20, 0);
    expect(items).toHaveLength(1);
    expect(items[0]?.cachedContent).toBeUndefined();
  });

  it('re-reads details added by QQ after the list was loaded', async () => {
    const { sql } = setup();
    sql
      .prepare('INSERT INTO collection_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('cid-later', 8, 1000, 3000, 2000, null, null);
    expect((await db!.listAll())[0]?.cachedContent).toBeUndefined();
    const encoded = new ProtoMsg(CollectionRichMediaContentColumn).encode({
      content: { rawData: '<div>后来加载的正文</div>' },
    });
    sql
      .prepare('INSERT INTO content_list_info_table VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cid-later', 3000, null, null, null, null, null, null, null, encoded);
    expect((await db!.getByCid('cid-later'))?.cachedContent?.richMediaContent?.rawData).toBe(
      '<div>后来加载的正文</div>',
    );
    expect(await db!.getByCid('missing')).toBeNull();
    expect(await db!.getByCid("' OR 1=1 --")).toBeNull();
  });
});
