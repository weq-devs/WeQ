/**
 * 分块窗口驱动（`iterateSalvageWindows`）的离线回归。
 *
 * 这是级别 2 唯一会丢数据的读取入口，所以测试盯的不是"能不能读到数据"，而是
 * 三条**边界**有没有被守住：
 *
 *  1. **没授权就不许跳** —— 级别 < 2 直接拒绝，且一次原生调用都不发；
 *  2. **预算跨窗口累计** —— 剩余额度一路透传，用尽即按严格语义失败，绝不会
 *     "这块超了就再放宽一点"；
 *  3. **坏区间会被回填成提示** —— 下一次窗口不必为一个已经知道的坏页再试错一遍。
 *
 * 另外钉住两个会让循环失控的实现细节：行数不足以推进键时必须强制 +1、
 * 空窗口必须整块跨过去。
 */

import { describe, expect, it } from 'vitest';
import {
  GroupMsgDb,
  clampSalvageLevel,
  isLikelyCorruptionError,
  iterateSalvageWindows,
} from '@weq/db';
import type {
  DatabaseAlgorithms,
  NtHelperBinding,
  SalvageScanOptions,
  SalvageScanOutcome,
  SqlRow,
} from '@weq/native';

const DB = '/x/nt_msg.db';
const SCAN_SQL = 'SELECT "40003", * FROM group_msg_table WHERE "40003" > ?1 AND "40003" <= ?2';
const ALGO = { pageHmacAlgorithm: 'x', kdfHmacAlgorithm: 'y' } as unknown as DatabaseAlgorithms;

function outcome(over: Partial<SalvageScanOutcome>): SalvageScanOutcome {
  return {
    rows: [],
    ok: true,
    degraded: false,
    levelUsed: 2,
    errorKind: 'none',
    errorCode: null,
    errorMessage: null,
    skipped: [],
    queries: 1,
    budgetExhausted: false,
    rowCount: 0,
    skippedSpan: 0,
    table: 'group_msg_table',
    quarantined: false,
    ...over,
  };
}

/** 按请求的窗口边界回放预设结局的桩。 */
function windowStub(script: (options: SalvageScanOptions) => Partial<SalvageScanOutcome>) {
  const calls: SalvageScanOptions[] = [];
  const stub = {
    executeSqlSalvageScan(
      _dbPath: string,
      _sql: string,
      _params: unknown,
      options: SalvageScanOptions,
    ): Promise<SalvageScanOutcome> {
      calls.push(options);
      return Promise.resolve(outcome(script(options)));
    },
  };
  return { stub: stub as unknown as NtHelperBinding, calls };
}

/** 收集驱动交出来的所有行。 */
async function collect(
  gen: AsyncGenerator<SqlRow[]>,
): Promise<{ rows: SqlRow[]; batches: number }> {
  const rows: SqlRow[] = [];
  let batches = 0;
  for await (const batch of gen) {
    batches += 1;
    rows.push(...batch);
  }
  return { rows, batches };
}

/** 每块返回该窗口的首尾两个键（模拟"这块有数据"）。 */
const boundaryRows = (options: SalvageScanOptions): Partial<SalvageScanOutcome> => ({
  rows: [[options.lo + 1n], [options.hi!]] as unknown as SqlRow[],
  rowCount: 2,
});

/**
 * 稀疏键空间桩：扫描只回给窗口内真的存在的键，`executeSql` 当"下一个存在的键"探针。
 *
 * 真实的 `rowid` 就是这样：键在 `7.6e18` 量级、间距极大，一个 `4096` 宽的窗口里
 * 往往一个键都没有。
 */
function seekStub(keys: bigint[]) {
  const calls: SalvageScanOptions[] = [];
  let probes = 0;
  const stub = {
    executeSqlSalvageScan(
      _dbPath: string,
      _sql: string,
      _params: unknown,
      options: SalvageScanOptions,
    ): Promise<SalvageScanOutcome> {
      calls.push(options);
      const hi = options.hi ?? 0n;
      const rows = keys
        .filter((key) => key > options.lo && key <= hi)
        .map((key) => [key] as SqlRow);
      return Promise.resolve(outcome({ rows, rowCount: rows.length }));
    },
    executeSql(_dbPath: string, _sql: string, params: unknown[]): Promise<SqlRow[]> {
      probes += 1;
      const from = params[params.length - 1] as bigint;
      const next = keys.find((key) => key > from);
      return Promise.resolve(next === undefined ? [] : [[next] as SqlRow]);
    },
  };
  return { stub: stub as unknown as NtHelperBinding, calls, probes: () => probes };
}

describe('iterateSalvageWindows', () => {
  it('refuses to skip anything below level 2, without touching native', async () => {
    const { stub, calls } = windowStub(boundaryRows);
    const gen = iterateSalvageWindows({
      nt: stub,
      target: { dbPath: DB },
      sql: SCAN_SQL,
      plan: { lo: 0n, hi: 10n, chunk: 4 },
      opts: { level: () => 1 },
    });

    await expect(gen.next()).rejects.toThrow(/宽容级别 ≥ 2/);
    expect(calls).toHaveLength(0);
  });

  it('walks the key axis window by window and yields each batch', async () => {
    const { stub, calls } = windowStub(boundaryRows);
    const { rows, batches } = await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 10_000n, chunk: 4096 },
        opts: { level: () => 2 },
      }),
    );

    // 窗口边界严格按 chunk 推进：0 → 4096 → 8192 → 10000（最后一块被 hi 截断）。
    expect(calls.map((c) => [c.lo, c.hi])).toEqual([
      [0n, 4096n],
      [4096n, 8192n],
      [8192n, 10_000n],
    ]);
    expect(calls.every((c) => c.chunk === 4096)).toBe(true);
    // 第一块没有已知坏区间，就不该凭空塞一个空数组给 native。
    expect(calls[0]?.hints).toBeUndefined();
    expect(batches).toBe(3);
    expect(rows.map((r) => r[0])).toEqual([1n, 4096n, 4097n, 8192n, 8193n, 10_000n]);
  });

  it('carries the windows past empty ranges instead of stalling on them', async () => {
    const { stub, calls } = windowStub(() => ({ rows: [], rowCount: 0 }));
    const { rows, batches } = await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 10_000n, chunk: 4096 },
        opts: { level: () => 2 },
      }),
    );

    expect(rows).toEqual([]);
    expect(batches).toBe(0);
    expect(calls.map((c) => [c.lo, c.hi])).toEqual([
      [0n, 4096n],
      [4096n, 8192n],
      [8192n, 10_000n],
    ]);
  });

  it('jumps straight to the next existing key instead of walking empty windows', async () => {
    // 稀疏键空间（真实 rowid 就在 7.6e18 量级）：没有探针时逐格推进等于永远跑不完
    // （实测 15 秒仍未结束），有探针就一次跳过去。
    const keys = [7_616_328_302_822_264_237n, 7_616_328_302_822_264_250n];
    const { stub, calls, probes } = seekStub(keys);
    const { rows } = await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: {
          lo: 0n,
          hi: keys[1]! + 1000n,
          chunk: 4096,
          seekSql: 'SELECT MIN(rowid) FROM group_msg_table WHERE rowid > ?',
        },
        opts: { level: () => 2 },
      }),
    );

    expect(rows.map((r) => r[0])).toEqual(keys);
    // 第一个（空）窗口一次探针跳到第一个真键，两个键同一窗口读完，最后再探一次确认到底。
    expect(probes()).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.lo).toBe(keys[0]! - 1n);
  });

  it('keeps advancing past a key whose window was skipped whole', async () => {
    // 探针给出的键可能正好是 `cursor + 1`，而它所在的那一小段刚刚整体被跳过
    // （读不出来）。游标必须至少 +1，否则会在同一段上打转。
    const calls: SalvageScanOptions[] = [];
    const stub = {
      executeSqlSalvageScan(
        _db: string,
        _sql: string,
        _params: unknown,
        options: SalvageScanOptions,
      ): Promise<SalvageScanOutcome> {
        calls.push(options);
        return Promise.resolve(
          outcome({
            rows: [],
            rowCount: 0,
            skipped: [{ lo: options.lo, hi: options.hi!, errorKind: 'corrupt', errorCode: 11 }],
            skippedSpan: 1,
          }),
        );
      },
      // 探针总是说"下一个键就是当前键 +1"，而那一小段刚被整块跳过：游标必须至少 +1。
      executeSql(_db: string, _sql: string, params: unknown[]): Promise<SqlRow[]> {
        const from = params[params.length - 1] as bigint;
        return Promise.resolve([[from + 1n] as SqlRow]);
      },
    } as unknown as NtHelperBinding;

    await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 4n, chunk: 4, seekSql: 'SELECT MIN(rowid) FROM t WHERE rowid > ?' },
        opts: { level: () => 2 },
      }),
    );

    // 每一块都以同一个探针结果结束，但游标必须严格前进（不能停在 0 上转圈）。
    expect(calls.map((c) => c.lo)).toEqual([0n, 1n, 2n, 3n]);
  });

  it('feeds skipped ranges back as hints so later windows never re-probe them', async () => {
    const bad = [
      { lo: 100n, hi: 200n, prevKey: 99n, nextKey: 201n, errorKind: 'corrupt', errorCode: 11 },
    ];
    const { stub, calls } = windowStub((options) =>
      options.lo === 0n ? { skipped: bad, skippedSpan: 100 } : boundaryRows(options),
    );
    const seen: Array<{ ranges: number; span: number }> = [];

    await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 8192n, chunk: 4096 },
        opts: { level: () => 2 },
        onSkipped: (ranges, span) => seen.push({ ranges: ranges.length, span }),
      }),
    );

    expect(seen).toEqual([{ ranges: 1, span: 100 }]);
    // 第一块报出来的坏区间，第二块起必须出现在 hints 里（且是原样回填的窗口边界）。
    expect(calls[0]?.hints).toBeUndefined();
    expect(calls[1]?.hints).toEqual([{ lo: 100n, hi: 200n }]);
  });

  it('also honours hints supplied by the caller on the very first window', async () => {
    const { stub, calls } = windowStub(boundaryRows);
    await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 10n, chunk: 10 },
        opts: { level: () => 2 },
        hints: [{ lo: 4n, hi: 6n }],
      }),
    );

    expect(calls[0]?.hints).toEqual([{ lo: 4n, hi: 6n }]);
  });

  it('spends the degradation budget across windows and then fails strict', async () => {
    const skip = [
      { lo: 1n, hi: 2n, prevKey: 0n, nextKey: 3n, errorKind: 'corrupt', errorCode: 11 },
    ];
    const { stub, calls } = windowStub((options) =>
      options.lo === 0n ? { skipped: skip, skippedSpan: 1 } : boundaryRows(options),
    );
    const gen = iterateSalvageWindows({
      nt: stub,
      target: { dbPath: DB },
      sql: SCAN_SQL,
      plan: { lo: 0n, hi: 30n, chunk: 10, maxSkippedRanges: 1, maxSkippedSpan: 500 },
      opts: { level: () => 2 },
    });

    await expect(collect(gen)).rejects.toThrow(/超出宽容预算/);
    // 预算在第一块就用光：第二块**一次原生调用都不发**，直接按严格语义失败。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxSkippedRanges).toBe(1);
  });

  it('passes the remaining budget (not the original one) down to native', async () => {
    const skip = [
      { lo: 1n, hi: 2n, prevKey: 0n, nextKey: 3n, errorKind: 'corrupt', errorCode: 11 },
    ];
    const { stub, calls } = windowStub((options) =>
      options.lo === 0n ? { skipped: skip, skippedSpan: 40 } : boundaryRows(options),
    );

    await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 20n, chunk: 10, maxSkippedRanges: 5, maxSkippedSpan: 500 },
        opts: { level: () => 2 },
      }),
    );

    expect(calls.map((c) => [c.maxSkippedRanges, c.maxSkippedSpan])).toEqual([
      [5, 500],
      [4, 460],
    ]);
  });

  it('still terminates when a window hands back a key that does not advance', async () => {
    // SQL 契约说结果是升序的；如果某条驱动违反契约（键不前进），兜底必须让游标至少 +1，
    // 否则整个扫描会卡在同一个窗口上转不出去。
    const { stub, calls } = windowStub(() => ({
      rows: [[0n]] as unknown as SqlRow[],
      rowCount: 1,
    }));
    const { rows } = await collect(
      iterateSalvageWindows({
        nt: stub,
        target: { dbPath: DB },
        sql: SCAN_SQL,
        plan: { lo: 0n, hi: 5n, chunk: 100 },
        opts: { level: () => 2 },
      }),
    );

    expect(calls.map((c) => c.lo)).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(rows).toHaveLength(5);
  });
});

describe('GroupMsgDb.streamSalvageAfter', () => {
  /** 只实现本测试用到的方法：普通读走严格通道，扫描走 salvage 通道。 */
  function dbStub(maxSeq: SqlRow[], scanRows: SqlRow[], algoCalls: string[]) {
    const stub = {
      executeSqlWithKey(_dbPath: string, sql: string): Promise<SqlRow[]> {
        algoCalls.push(`strict:${sql}`);
        return Promise.resolve(maxSeq);
      },
      executeSqlSalvageScanWithKey(
        _dbPath: string,
        _sql: string,
        _key: string,
        _algo: unknown,
        _params: unknown,
        options: SalvageScanOptions,
        _level: number,
      ): Promise<SalvageScanOutcome> {
        algoCalls.push(`scan:${options.lo}-${options.hi}`);
        return Promise.resolve(outcome({ rows: scanRows, rowCount: scanRows.length }));
      },
    };
    return stub as unknown as NtHelperBinding;
  }

  it('derives the scan ceiling from MAX(seq) and maps rows through the normal decoder', async () => {
    // 行布局 = `SELECT "40003", <SELECT_COLUMNS>`：key 在前，其余列与严格读一致。
    const scanned: SqlRow[] = [
      [1n, 10n, 'uid-a', '12345', 456n, 1_700_000_000n, null, null, 1n, 0n, 0n, null],
      [2n, 11n, 'uid-b', '12345', 789n, 1_700_000_100n, null, null, 2n, 0n, 0n, null],
    ];
    const calls: string[] = [];
    const db = new GroupMsgDb(dbStub([[2n]], scanned, calls), {
      dbPath: DB,
      key: 'k',
      algo: ALGO,
    });

    const out: Array<{ msgId: bigint; msgSeq: bigint }> = [];
    for await (const batch of db.streamSalvageAfter('12345', 0n, {
      salvage: { level: () => 2 },
      chunk: 4096,
    })) {
      out.push(...batch.map((m) => ({ msgId: m.msgId, msgSeq: m.msgSeq })));
    }

    expect(out).toEqual([
      { msgId: 10n, msgSeq: 1n },
      { msgId: 11n, msgSeq: 2n },
    ]);
    expect(calls[0]).toMatch(/strict:SELECT MAX\("40003"\)/);
    expect(calls[1]).toBe('scan:0-2');
  });

  it('does not query at all when the conversation has nothing past the cursor', async () => {
    const calls: string[] = [];
    const db = new GroupMsgDb(dbStub([[7n]], [], calls), { dbPath: DB, key: 'k', algo: ALGO });

    const batches: unknown[] = [];
    for await (const batch of db.streamSalvageAfter('12345', 7n, { salvage: { level: () => 2 } })) {
      batches.push(batch);
    }

    expect(batches).toEqual([]);
    expect(calls.some((c) => c.startsWith('scan:'))).toBe(false);
  });

  it('keeps the strict semantics when the caller was never granted level 2', async () => {
    const calls: string[] = [];
    const db = new GroupMsgDb(dbStub([[2n]], [], calls), { dbPath: DB, key: 'k', algo: ALGO });

    const iterate = async (): Promise<void> => {
      for await (const _ of db.streamSalvageAfter('12345', 0n, { salvage: { level: () => 1 } })) {
        /* 不该有数据 */
      }
    };

    await expect(iterate()).rejects.toThrow(/宽容级别 ≥ 2/);
    expect(calls.some((c) => c.startsWith('scan:'))).toBe(false);
  });
});

describe('budget failures and the "suspected corruption" detector', () => {
  it('still counts as suspected corruption, because corruption is why it gave up', () => {
    // 超预算是**主动放弃**，但放弃的原因就是“数据库确实坏了”—— 所以它必须照旧触发
    // 既有的"疑似损坏 → 健康检查 + 弹窗"链路（那也是用户能看到报告、决定要不要升级
    // 宽容级别的地方）。判定靠 native 写的错误码，而不是被改写过的文案。
    const error = Object.assign(new Error('损坏超出宽容预算（已跳过 20 处 / 键跨度 ≤ 500）'), {
      name: 'SalvageBudgetError',
      errorCode: 11,
    });
    expect(isLikelyCorruptionError(error)).toBe(true);
  });

  it('does not turn unrelated failures into corruption', () => {
    // 没有错误码、文案也不沾损坏的，一律不算 —— 宽容模式不能成为误报的来源。
    for (const message of ['database is locked', 'no such table: t', 'disk I/O error']) {
      expect(isLikelyCorruptionError(new Error(message))).toBe(false);
    }
    expect(clampSalvageLevel(2)).toBe(2);
  });
});
