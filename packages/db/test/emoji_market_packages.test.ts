import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketEmoticonPackageDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { expect, it } from 'vitest';

it('商城表情包封面来自同一包的有效表情，缺少明细仍保留列表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-market-packages-'));
  try {
    const dbPath = join(dir, 'emoji.db');
    const sql = fixtureDb(dbPath);
    const coverHash = 'a'.repeat(32);
    sql.exec(`
      CREATE TABLE market_emoticon_package_table (
        "80943" TEXT PRIMARY KEY, "80947" TEXT, "80948" TEXT, "80963" INTEGER, "80970" TEXT
      );
      CREATE TABLE market_emoticon_table ("80920" TEXT, "80943" TEXT);
      INSERT INTO market_emoticon_package_table VALUES
        ('1', 'A', '', 1, ''), ('2', 'B', '', 2, ''), ('3', 'C', '', 3, '');
      INSERT INTO market_emoticon_table VALUES
        ('bad', '1'), ('${'!'.repeat(32)}', '1'), ('${coverHash}', '1'),
        ('${'b'.repeat(32)}', '1'), ('', '2'), ('${'c'.repeat(32)}', '4');
    `);
    const db = new MarketEmoticonPackageDb(createSqliteStub(), { dbPath });
    const packages = await db.listAll();
    expect(packages.map(({ packId, coverHash }) => [packId, coverHash])).toEqual([
      ['3', undefined],
      ['2', undefined],
      ['1', coverHash],
    ]);
    sql.exec('DROP TABLE market_emoticon_table');
    expect(await db.listAll()).toEqual(packages.map(({ coverHash: _cover, ...pack }) => pack));
  } finally {
    closeAllFixtureDbs();
    rmSync(dir, { recursive: true, force: true });
  }
});
