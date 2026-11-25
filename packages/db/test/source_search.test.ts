import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GroupMsgFtsDb,
  SourceMsgSearchDb,
  withDatabasePriority,
  type SourceSearchQuery,
} from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { sourceFtsContract } from '../src/msg/source_search_contract';

const TABLE = 'group_msg_fts';
const COLUMNS =
  '"41701","41702","41700" UNINDEXED,"40001" UNINDEXED,"40010" UNINDEXED,"40021" UNINDEXED,"40020" UNINDEXED,"40050" UNINDEXED,"40003" UNINDEXED,"40027" UNINDEXED';
let root: string | undefined;
let search: SourceMsgSearchDb | undefined;
afterEach(() => {
  search?.dispose();
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture(complete = true) {
  root = mkdtempSync(join(tmpdir(), 'weq-source-search-'));
  const path = join(root, 'group_msg_fts.db'),
    db = fixtureDb(path),
    nt = createSqliteStub();
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ${TABLE}("41700" INTEGER PRIMARY KEY,"40001" INTEGER UNIQUE,"40010" INTEGER,"40021" TEXT,"40020" TEXT,"40050" INTEGER,"40003" INTEGER,"40027" INTEGER,"41701" TEXT,"41702" TEXT);
    CREATE INDEX partition_idx ON ${TABLE}("40027");
    CREATE VIRTUAL TABLE ${TABLE}_fts USING fts5(${COLUMNS},content=${TABLE},tokenize='trigram');`);
  db.function('weq_trigram_contains', (body, needle) =>
    body !== null &&
    needle !== null &&
    String(body).toLowerCase().includes(String(needle).toLowerCase())
      ? 1
      : 0,
  );
  const insert = db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,2,'group',NULL,?,?,?, ?,?)`);
  insert.setReadBigInts(true);
  insert.run(
    7318775631454291968n,
    7318775631454291969n,
    100,
    1,
    77,
    '数据库 Alpha a  b CAFÉ',
    'one.txt',
  );
  insert.run(17n, 18n, 100, 2, 77, '数据库 Beta', '数据库.pdf');
  insert.run(3n, 4n, 99, 1, 88, 'nothing', '数据库.txt');
  db.exec(
    `INSERT INTO ${TABLE}_fts(rowid,"41701","41702") SELECT "41700","41701","41702" FROM ${TABLE} ${complete ? '' : 'WHERE "41700"<>17'};`,
  );
  const decrypt = vi.spyOn(nt, 'fastDecryptDatabase');
  const write = vi.spyOn(nt, 'executeSqlWrite');
  search = new SourceMsgSearchDb({ nt, dbPath: path, tableName: TABLE });
  return { db, nt, path, search, write, decrypt };
}
describe('SourceMsgSearchDb', () => {
  it('已取消的索引读取不会触发内容表回退', async () => {
    const f = fixture();
    const controller = new AbortController();
    const query = vi.fn<SourceSearchQuery>(async (target, sql, params, purpose, signal) => {
      if (purpose === 'search') {
        controller.abort();
        signal?.throwIfAborted();
      }
      return f.nt.executeSql(target.dbPath, sql, params);
    });
    search = new SourceMsgSearchDb({ nt: f.nt, dbPath: f.path, tableName: TABLE, query });
    await search.sync();
    query.mockClear();
    const current = search;
    await expect(
      withDatabasePriority('background', () => current.topPartitions('数据库'), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(query).toHaveBeenCalledOnce();
  });

  it('一次读取校验版本、列与 FTS，另一次检查索引覆盖', async () => {
    const f = fixture();
    const query = vi.fn<SourceSearchQuery>((target, sql, params) =>
      f.nt.executeSql(target.dbPath, sql, params),
    );
    search = new SourceMsgSearchDb({ nt: f.nt, dbPath: f.path, tableName: TABLE, query });
    await search.sync();
    expect(search.accelerated).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockClear();
    await search.sync();
    expect(query).toHaveBeenCalledOnce();
  });

  it('文件候选用一条探测保留相同首页，精确分页仍返回完整计数', async () => {
    const f = fixture();
    await f.search.sync();
    const query = vi.spyOn(f.nt, 'executeSql');
    const candidates = await f.search.searchFiles('数据库', 1, 0, true);
    expect(candidates.total).toBe(2);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).not.toContain('COUNT(*)');
    expect(await f.search.searchFiles('数据库', 1)).toEqual(candidates);
    expect((await f.search.searchFiles('数据库', 1, 1)).total).toBe(2);
  });
  it('keeps partition filtering correct after bigint parameters cross a JSON worker boundary', async () => {
    const f = fixture();
    const remote = new SourceMsgSearchDb({
      nt: f.nt,
      dbPath: f.path,
      tableName: TABLE,
      query: async (target, sql, params) =>
        f.nt.executeSql(
          target.dbPath,
          sql,
          params.map((value) => (typeof value === 'bigint' ? String(value) : value)),
        ),
    });
    search = remote;
    await remote.sync();
    expect((await remote.searchPartition(77n, '数据库')).total).toBe(2);
    expect((await remote.searchPartition(88n, '数据库')).total).toBe(1);
  });
  it('uses the original FTS and preserves bigint identities, file scope and snapshot pagination without writing', async () => {
    const f = fixture();
    await f.search.sync();
    expect(f.search.ready).toBe(true);
    expect(f.search.accelerated).toBe(true);
    const all = await f.search.searchPartition(77n, '数据库');
    expect(all.total).toBe(2);
    expect(all.items[0]?.msgId).toBe(7318775631454291969n);
    expect(all.items[0]?.senderUid).toBe('');
    const beyond = await f.search.searchPartition(77n, '数据库', 20, 100);
    expect(beyond).toEqual({ items: [], total: 2 });
    expect((await f.search.searchFiles('数据库')).total).toBe(2);
    expect(await f.search.topPartitions('数据库')).toEqual([
      { partition: 77n, count: 2 },
      { partition: 88n, count: 1 },
    ]);
    expect((await f.search.searchPartition(88n, '数据库', 20, 0, true)).total).toBe(0);
    expect((await f.search.searchPartition(77n, 'a  b')).total).toBe(1);
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(readdirSync(root!)).not.toContain('index.db');
  });
  it('reads missing indexed rows from the exact content fallback and picks up low rowids in the source', async () => {
    const f = fixture(false);
    await f.search.sync();
    expect(f.search.ready).toBe(true);
    expect(f.search.accelerated).toBe(false);
    expect((await f.search.searchPartition(77n, '数据库')).total).toBe(2);
    f.db.exec(`INSERT INTO ${TABLE} VALUES(1,111,2,'group','sender',101,3,77,'数据库 live','')`);
    expect((await f.search.searchPartition(77n, '数据库')).total).toBe(3);
  });
  it('加速旧搜索入口并保留字面匹配、同时间顺序和校验后尚未索引的消息', async () => {
    const f = fixture();
    await f.search.sync();
    const legacy = new GroupMsgFtsDb(f.nt, { dbPath: f.path });
    // 小 rowid 也可能出现在校验后；发送者、时间和正文应在候选上限之前生效。
    f.db.exec(`INSERT INTO ${TABLE} VALUES(2,901,2,'group','sender',100,3,77,'数据库 live','文件-会议%.pdf');
      INSERT INTO ${TABLE} VALUES(4,902,2,'group','other',100,4,77,'数据库 live','文件-会议x.pdf');
      INSERT INTO ${TABLE} VALUES(5,903,2,'group','sender',101,5,77,'数据库 live','文件-会议%.txt');`);
    const execute = vi.spyOn(f.nt, 'executeSql');
    const bounds = { start: 100, end: 100, senderUid: 'sender' };
    expect(await legacy.searchInGroup('77', '数据库', 20, f.search)).toEqual(
      await legacy.searchInGroup('77', '数据库', 20),
    );
    expect(await legacy.search('数据库', 20, f.search)).toEqual(await legacy.search('数据库', 20));
    expect(await legacy.searchFiles('会议%', 20, f.search)).toEqual(
      await legacy.searchFiles('会议%', 20),
    );
    const filtered = await legacy.searchRecordCandidates('数据库', bounds, 1, f.search);
    expect(filtered).toEqual(await legacy.searchRecordCandidates('数据库', bounds, 1));
    expect(filtered.map(({ msgId }) => msgId)).toEqual([901n]);
    expect(
      execute.mock.calls.filter(([, statement]) => statement.includes('MATCH ?')),
    ).toHaveLength(4);
    expect(await legacy.search('café', 20, f.search)).toEqual([]);
    expect(await legacy.search('数据库', 20, f.search)).toContainEqual(
      expect.objectContaining({ msgId: 903n }),
    );
  });
  it('全文候选读取失败时退回原查询，取消时停止读取', async () => {
    const f = fixture();
    const controller = new AbortController();
    let cancel = false;
    const query: SourceSearchQuery = async (target, sql, params) => {
      if (sql.includes('MATCH ?')) {
        if (cancel) controller.abort();
        throw new Error('合成全文索引读取失败');
      }
      return f.nt.executeSql(target.dbPath, sql, params);
    };
    search = new SourceMsgSearchDb({ nt: f.nt, dbPath: f.path, tableName: TABLE, query });
    const current = search;
    await current.sync();
    const legacy = new GroupMsgFtsDb(f.nt, { dbPath: f.path });
    expect(await legacy.search('数据库', 20, current)).toEqual(await legacy.search('数据库', 20));
    cancel = true;
    const execute = vi.spyOn(f.nt, 'executeSql');
    await expect(
      withDatabasePriority(
        'background',
        () => legacy.search('数据库', 20, current),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('can enable acceleration after QQ catches up previously missing index rows without a schema change', async () => {
    const f = fixture(false);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    await f.search.sync();
    expect(f.search.accelerated).toBe(false);
    f.db.exec(
      `INSERT INTO ${TABLE}_fts(rowid,"41701","41702") SELECT "41700","41701","41702" FROM ${TABLE} WHERE "41700"=17`,
    );
    clock.mockReturnValue(1000000 + 5 * 60000 + 1);
    await f.search.sync();
    expect(f.search.accelerated).toBe(true);
  });
  it('invalidates results after schema changes, including empty pages, and can re-probe', async () => {
    const f = fixture();
    await f.search.sync();
    f.db.exec('CREATE TABLE changed(n)');
    await expect(f.search.searchFiles('not-present')).rejects.toThrow('来源已变化');
    expect(f.search.ready).toBe(false);
    await f.search.sync();
    expect(f.search.ready).toBe(true);
    f.search.dispose();
    await expect(f.search.searchFiles('one')).rejects.toThrow('未就绪');
  });
  it('falls back when the FTS read fails instead of silently returning no results', async () => {
    const f = fixture();
    await f.search.sync();
    f.db.exec(`DROP TABLE ${TABLE}_fts`);
    await expect(f.search.searchFiles('数据库')).rejects.toThrow('来源已变化');
  });
});
it('parses options, comments and quoted fake options separately', () => {
  const ddl = `CREATE VIRTUAL TABLE ${TABLE}_fts USING fts5(${COLUMNS},content=${TABLE},tokenize='pinyin_letter 0')`;
  expect(sourceFtsContract(ddl, TABLE)?.tokenizer).toBe('pinyin0');
  expect(
    sourceFtsContract(ddl.replace(`content=${TABLE}`, `"content=${TABLE}",content=other`), TABLE),
  ).toBeNull();
  expect(sourceFtsContract(ddl.replace('"41702"', '"41702" UNINDEXED'), TABLE)).toBeNull();
  expect(
    sourceFtsContract(
      ddl.replace(`content=${TABLE}`, `content=${TABLE},content_rowid='40001'`),
      TABLE,
    ),
  ).toBeNull();
});
