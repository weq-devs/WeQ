/**
 * 损坏宽容（salvage）在 `@weq/db` 这一层的离线回归。
 *
 * 最该被测试守住的两条不变量：
 *
 *  1. **默认不开启** —— `level === 0` 时整层是纯透传：不调用任何 salvage 方法，
 *     不多开连接，账本里也不会凭空多出记录。这是"默认行为逐字节不变"的第一道闸门。
 *  2. **降级可见** —— 一旦真的发生降级（换访问路径成功 / 损坏且救不回来），账本里
 *     必须有对应的一条；同时"救不回来"必须抛出一个仍然能被
 *     `isLikelyCorruptionError` 认出的错误，这样既有的"疑似损坏 → 健康检查"链路
 *     不会因为引入宽容模式而失效。
 *
 * 另外锁住两条边界：写路径永不被改写；账本/回调自己出错绝不能影响读路径。
 */

import { describe, expect, it } from 'vitest';
import {
  QqDb,
  SalvageLedger,
  clampSalvageLevel,
  fingerprintSql,
  isLikelyCorruptionError,
  runSalvageScan,
  wrapBindingForSalvage,
} from '@weq/db';
import type {
  NtHelperBinding,
  SalvageQueryOutcome,
  SalvageScanOutcome,
  SalvageScanOptions,
  SqlRow,
} from '@weq/native';

const ROW: SqlRow = [1n, 'hello'];
const DB = '/x/nt_msg.db';
const SCAN_SQL = 'SELECT rowid, msg FROM group_msg_table WHERE rowid > ?1 AND rowid <= ?2';

/** 记录调用顺序的桩：只实现本测试用到的方法。 */
function makeStub(
  salvageOutcome: Partial<SalvageQueryOutcome>,
  scanOutcome: Partial<SalvageScanOutcome> = {},
) {
  const calls: string[] = [];
  const scanCalls: Array<{ sql: string; options: SalvageScanOptions; level?: number | null }> = [];
  const outcome: SalvageQueryOutcome = {
    rows: [ROW],
    ok: true,
    degraded: false,
    levelUsed: 0,
    errorKind: 'none',
    errorCode: null,
    errorMessage: null,
    retriedWithNotIndexed: false,
    table: null,
    quarantined: false,
    ...salvageOutcome,
  };
  const scanned: SalvageScanOutcome = {
    rows: [ROW],
    ok: true,
    degraded: false,
    levelUsed: 2,
    errorKind: 'none',
    errorCode: null,
    errorMessage: null,
    skipped: [],
    queries: 3,
    budgetExhausted: false,
    rowCount: 1,
    skippedSpan: 0,
    table: 'group_msg_table',
    quarantined: false,
    ...scanOutcome,
  };

  const stub = {
    calls,
    executeSql(_dbPath: string, sql: string): Promise<SqlRow[]> {
      calls.push(`strict:${sql}`);
      return Promise.resolve([ROW]);
    },
    executeSqlWithKey(_dbPath: string, sql: string): Promise<SqlRow[]> {
      calls.push(`strictKey:${sql}`);
      return Promise.resolve([ROW]);
    },
    executeSqlSalvage(_dbPath: string, sql: string, _p?: unknown, level?: number | null) {
      calls.push(`salvage:${sql}:level=${level}`);
      return Promise.resolve(outcome);
    },
    executeSqlSalvageWithKey(
      _dbPath: string,
      sql: string,
      _key: string,
      _algo: unknown,
      _p?: unknown,
      level?: number | null,
    ) {
      calls.push(`salvageKey:${sql}:level=${level}`);
      return Promise.resolve(outcome);
    },
    executeSqlSalvageScan(
      _dbPath: string,
      sql: string,
      _p: unknown,
      options: SalvageScanOptions,
      level?: number | null,
    ) {
      calls.push(`scan:${sql}:level=${level}`);
      scanCalls.push({ sql, options, level });
      return Promise.resolve(scanned);
    },
    executeSqlSalvageScanWithKey(
      _dbPath: string,
      sql: string,
      _key: string,
      _algo: unknown,
      _p: unknown,
      options: SalvageScanOptions,
      level?: number | null,
    ) {
      calls.push(`scanKey:${sql}:level=${level}`);
      scanCalls.push({ sql, options, level });
      return Promise.resolve(scanned);
    },
    executeSqlWrite(_dbPath: string, sql: string): Promise<number> {
      calls.push(`write:${sql}`);
      return Promise.resolve(1);
    },
    closeDb(): number {
      calls.push('closeDb');
      return 1;
    },
  };

  return { stub: stub as unknown as NtHelperBinding, calls, scanCalls };
}

describe('salvage level helpers', () => {
  it('clamps anything unknown back to strict', () => {
    expect(clampSalvageLevel(1)).toBe(1);
    expect(clampSalvageLevel(3)).toBe(3);
    for (const bad of [0, -1, 4, 1.9, Number.NaN, '2', null, undefined, {}]) {
      const level = clampSalvageLevel(bad);
      // 1.9 截断成 1 是合法的；其余非法输入必须回到严格。
      expect([0, 1, 2, 3]).toContain(level);
      if (typeof bad !== 'number') expect(level).toBe(0);
    }
    expect(clampSalvageLevel(1.9)).toBe(1);
    expect(clampSalvageLevel(999)).toBe(0);
  });

  it('fingerprints sql without keeping literals or parameters', () => {
    const sql = 'SELECT * FROM group_msg_table WHERE "40027" = 12345 AND "40062" = \'secret 喵\'';
    const fingerprint = fingerprintSql(sql);
    expect(fingerprint).not.toContain('12345');
    expect(fingerprint).not.toContain('secret');
    expect(fingerprint).toContain('group_msg_table');
  });

  it('normalises positional parameter numbers instead of doubling the placeholder', () => {
    // `?1` / `?2` 是 SQLite 的位置参数（分块扫描的区间边界恰好用它），
    // 归一后必须还是一个 `?`，而不是被数字规则再吃掉一次变成 `??`。
    expect(fingerprintSql('SELECT a FROM t WHERE rowid > ?1 AND rowid <= ?2')).toBe(
      'SELECT a FROM t WHERE rowid > ? AND rowid <= ?',
    );
  });
});

describe('wrapBindingForSalvage', () => {
  it('is a pure passthrough while the level is strict (default off)', async () => {
    const { stub, calls } = makeStub({});
    const ledger = new SalvageLedger();
    const nt = wrapBindingForSalvage(stub, { level: () => 0, ledger });

    await expect(nt.executeSql('/x/nt_msg.db', 'SELECT 1')).resolves.toEqual([ROW]);
    await expect(
      nt.executeSqlWithKey('/x/nt_msg.db', 'SELECT 1', 'k', {
        pageHmacAlgorithm: 'x',
        kdfHmacAlgorithm: 'y',
      }),
    ).resolves.toEqual([ROW]);

    expect(calls).toEqual(['strict:SELECT 1', 'strictKey:SELECT 1']);
    expect(calls.some((call) => call.startsWith('salvage'))).toBe(false);
    expect(ledger.list()).toHaveLength(0);
  });

  it('routes reads to the salvage channel and records the retreat once enabled', async () => {
    const { stub, calls } = makeStub({ degraded: true, levelUsed: 1, retriedWithNotIndexed: true });
    const ledger = new SalvageLedger();
    const nt = wrapBindingForSalvage(stub, { level: () => 1, ledger });

    await expect(nt.executeSql('/x/nt_msg.db', 'SELECT 2')).resolves.toEqual([ROW]);

    expect(calls).toEqual(['salvage:SELECT 2:level=1']);
    const entries = ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('index-retreat');
    expect(entries[0]?.level).toBe(1);
    expect(entries[0]?.sqlFingerprint).toBe('SELECT ?');
    expect(ledger.summary()).toMatchObject({ total: 1, indexRetreat: 1, unrecoverable: 0 });
  });

  it('still throws a recognisable corruption error and records it when unrecoverable', async () => {
    const { stub } = makeStub({
      rows: [],
      ok: false,
      levelUsed: 0,
      errorKind: 'corrupt',
      errorCode: 11,
      errorMessage: 'database disk image is malformed',
    });
    const ledger = new SalvageLedger();
    const nt = wrapBindingForSalvage(stub, { level: () => 1, ledger });

    // 既有的"疑似损坏"检测必须仍然认得出来 —— 否则健康检查弹窗就不会触发。
    await expect(nt.executeSql('/x/nt_msg.db', 'SELECT 3')).rejects.toSatisfy((err: unknown) =>
      isLikelyCorruptionError(err),
    );
    expect(ledger.summary()).toMatchObject({ total: 1, unrecoverable: 1 });
    expect(ledger.list()[0]?.errorCode).toBe(11);
  });

  it('separates a quarantined short-circuit from a real corruption failure', async () => {
    // L3 短路：这次**根本没读**。它必须与"又读到损坏"分开记账（界面上的说法不同），
    // 且抛出的错误里要给出恢复路径，而不是把用户丢在一条裸错误上。
    const { stub } = makeStub({
      rows: [],
      ok: false,
      levelUsed: 3,
      errorKind: 'quarantined',
      errorCode: null,
      errorMessage: 'table group_msg_table is temporarily unavailable',
      table: 'group_msg_table',
      quarantined: true,
    });
    const ledger = new SalvageLedger();
    const nt = wrapBindingForSalvage(stub, { level: () => 3, ledger });

    await expect(nt.executeSql('/x/nt_msg.db', 'SELECT 5')).rejects.toThrow(
      /已被整表放弃（宽容级别 3）[\s\S]*设置 → 数据库宽容/,
    );
    expect(ledger.summary()).toMatchObject({
      total: 1,
      quarantined: 1,
      unrecoverable: 0,
      indexRetreat: 0,
    });
    expect(ledger.list()[0]?.kind).toBe('quarantined');
    expect(ledger.list()[0]?.level).toBe(3);
  });

  it('never rewrites the write path, even at a permissive level', async () => {
    const { stub, calls } = makeStub({});
    const nt = wrapBindingForSalvage(stub, { level: () => 3, ledger: new SalvageLedger() });

    await expect(nt.executeSqlWrite('/x/nt_msg.db', 'DELETE FROM t')).resolves.toBe(1);
    expect(calls).toEqual(['write:DELETE FROM t']);
  });

  it('survives a ledger sink that throws', async () => {
    const { stub } = makeStub({ degraded: true, levelUsed: 1 });
    const nt = wrapBindingForSalvage(stub, {
      level: () => 1,
      onEntry: () => {
        throw new Error('disk full');
      },
    });

    await expect(nt.executeSql('/x/nt_msg.db', 'SELECT 4')).resolves.toEqual([ROW]);
  });
});

/**
 * 分块扫描（L2/L3）在 `@weq/db` 这一层的契约。
 *
 * 它是唯一会丢数据的读取入口，所以三件事必须被测试钉死：
 * 严格级别**拒绝**扫描（不能用一个"本来就会跳过"的入口）；`ok === false` 时**绝不**
 * 返回部分数据，而是抛出与严格模式同源的错误；每一次跳过都进账本，且**只给键区间**
 * （键跨度不是行数上界）。
 */
describe('runSalvageScan', () => {
  it('refuses to scan while the level is strict', async () => {
    const { stub, calls, scanCalls } = makeStub({});

    await expect(
      runSalvageScan(stub, { dbPath: DB }, SCAN_SQL, { lo: 0n, hi: 9n }, { level: () => 0 }),
    ).rejects.toThrow(/严格模式/);

    expect(calls).toEqual([]);
    expect(scanCalls).toEqual([]);
  });

  it('passes the window, the budget and the hints straight to native', async () => {
    const { stub, scanCalls } = makeStub({});

    await runSalvageScan(
      stub,
      { dbPath: DB },
      SCAN_SQL,
      {
        lo: 0n,
        hi: 1000n,
        chunk: 200,
        minSpan: 1,
        maxSkippedRanges: 5,
        maxSkippedSpan: 50,
        hints: [{ lo: 100n, hi: 102n }],
      },
      { level: () => 2 },
    );

    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]?.level).toBe(2);
    expect(scanCalls[0]?.options).toEqual({
      lo: 0n,
      hi: 1000n,
      chunk: 200,
      minSpan: 1,
      maxSkippedRanges: 5,
      maxSkippedSpan: 50,
      hints: [{ lo: 100n, hi: 102n }],
    });
  });

  it('leaves unset knobs unset (native 的默认值才是唯一来源)', async () => {
    const { stub, scanCalls } = makeStub({});

    await runSalvageScan(stub, { dbPath: DB }, SCAN_SQL, { lo: 1n, hi: 2n }, { level: () => 2 });

    expect(scanCalls[0]?.options).toEqual({ lo: 1n, hi: 2n });
  });

  it('records skipped ranges as key spans, never a fake row count', async () => {
    const { stub } = makeStub(
      {},
      {
        degraded: true,
        levelUsed: 2,
        rowCount: 998,
        skippedSpan: 2,
        skipped: [
          { prevKey: 100n, nextKey: 103n, lo: 100n, hi: 102n, errorKind: 'corrupt', errorCode: 11 },
        ],
      },
    );
    const ledger = new SalvageLedger();

    const outcome = await runSalvageScan(
      stub,
      { dbPath: DB },
      SCAN_SQL,
      { lo: 0, hi: 1000 },
      { level: () => 2, ledger },
    );

    // 有结果的降级：照常返回行，但账目必须留下。
    expect(outcome.ok).toBe(true);
    expect(outcome.rows).toEqual([ROW]);

    const entry = ledger.list()[0]!;
    expect(entry.kind).toBe('skipped-ranges');
    expect(entry.level).toBe(2);
    expect(entry.skippedRangeCount).toBe(1);
    expect(entry.skippedSpanUpperBound).toBe(2);
    // 口径：只报键区间。键跨度**不是**行数上界（同一个键可能对应多行），所以文案里
    // 不允许出现"≤ N 行"这种话。
    expect(entry.message).toContain('键跨度合计 2');
    expect(entry.message).toContain('key 100 之后');
    expect(entry.message).toContain('key 103 之前');
    expect(entry.sqlFingerprint).toBe(
      'SELECT rowid, msg FROM group_msg_table WHERE rowid > ? AND rowid <= ?',
    );
    expect(ledger.summary()).toMatchObject({
      total: 1,
      skipped: 1,
      indexRetreat: 0,
      unrecoverable: 0,
      quarantined: 0,
    });
  });

  it('marks hint-driven skips as such (它们根本没被查询过)', async () => {
    const { stub } = makeStub(
      {},
      {
        skipped: [{ lo: 100n, hi: 102n, errorKind: 'hint' }],
        skippedSpan: 2,
        levelUsed: 2,
        degraded: true,
      },
    );
    const ledger = new SalvageLedger();

    await runSalvageScan(
      stub,
      { dbPath: DB },
      SCAN_SQL,
      { lo: 0n, hi: 1000n },
      { level: () => 2, ledger },
    );

    expect(ledger.list()[0]?.message).toContain('已知坏页');
  });

  it('never returns partial rows when the budget is exhausted', async () => {
    const { stub } = makeStub(
      {},
      {
        rows: [],
        ok: false,
        budgetExhausted: true,
        rowCount: 0,
        errorKind: 'corrupt',
        errorCode: 11,
        errorMessage: 'database disk image is malformed',
      },
    );
    const ledger = new SalvageLedger();

    // 既有的"疑似损坏"链路必须仍然认得出来（超预算 = 按严格语义失败）。
    await expect(
      runSalvageScan(
        stub,
        { dbPath: DB },
        SCAN_SQL,
        { lo: 0n, hi: 1000n },
        { level: () => 2, ledger },
      ),
    ).rejects.toSatisfy((err: unknown) => isLikelyCorruptionError(err));
    expect(ledger.list()[0]?.kind).toBe('unrecoverable');
  });

  it('reports a quarantined table without pretending anything was read', async () => {
    const { stub } = makeStub(
      {},
      {
        rows: [],
        ok: false,
        levelUsed: 3,
        rowCount: 0,
        errorKind: 'quarantined',
        errorMessage: null,
        table: 'group_msg_table',
        quarantined: true,
      },
    );
    const ledger = new SalvageLedger();

    await expect(
      runSalvageScan(
        stub,
        { dbPath: DB },
        SCAN_SQL,
        { lo: 0n, hi: 10n },
        { level: () => 3, ledger },
      ),
    ).rejects.toThrow(/整表放弃/);
    expect(ledger.list()[0]?.kind).toBe('quarantined');
    expect(ledger.summary()).toMatchObject({ total: 1, quarantined: 1, unrecoverable: 0 });
  });

  it('survives a ledger sink that throws while skipping', async () => {
    const { stub } = makeStub(
      {},
      { skipped: [{ lo: 0n, hi: 1n, errorKind: 'hint' }], skippedSpan: 1 },
    );

    const outcome = await runSalvageScan(
      stub,
      { dbPath: DB },
      SCAN_SQL,
      { lo: 0n, hi: 10n },
      {
        level: () => 2,
        onEntry: () => {
          throw new Error('disk full');
        },
      },
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('QqDb.scan', () => {
  it('routes an encrypted database to the keyed scan channel', async () => {
    const { stub, calls } = makeStub({});
    const db = new QqDb(stub, {
      dbPath: DB,
      key: 'k',
      algo: { pageHmacAlgorithm: 'HMAC_SHA512', kdfHmacAlgorithm: 'PBKDF2_HMAC_SHA512' },
    });

    const outcome = await db.scan(SCAN_SQL, { lo: 0n, hi: 10n }, { level: () => 2 });

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([`scanKey:${SCAN_SQL}:level=2`]);
  });

  it('routes a plain database to the keyless scan channel', async () => {
    const { stub, calls } = makeStub({});
    const db = new QqDb(stub, { dbPath: DB });

    await db.scan(SCAN_SQL, { lo: 0n, hi: 10n }, { level: () => 1 });

    expect(calls).toEqual([`scan:${SCAN_SQL}:level=1`]);
  });
});
