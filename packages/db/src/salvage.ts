/**
 * 损坏宽容（salvage）在 JS 侧的契约与装配。
 *
 * 设计原则（与 native 侧一一对应，缺一不可）：
 *
 * 1. **默认不开启**。`level === 0` 时本模块不做任何事 —— 读取照旧走原来的严格方法，
 *    连连接都不多开一条。默认行为逐字节不变。
 * 2. **降级必须用户授权**。级别由上层（账号级设置）决定，这里只读不猜。
 * 3. **降级全程可见**。每一次降级都写进 {@link SalvageLedger}：换了访问路径、
 *    还是"损坏且救不回来"，都留下一条账目。绝不静默丢数据。
 * 4. **只有损坏会被宽容**。按 native 返回的**错误码**判定，不用错误文案。
 *    `BUSY` / 权限 / 语法 / 参数 / 表不存在一律照旧抛错。
 *
 * 级别含义（native 侧 0–3 已全部实现；接入情况逐级别标注）：
 *
 * | 级别 | 含义 | 会丢数据吗 | 接入情况 |
 * | ---- | ---- | ---------- | -------- |
 * | 0 | 严格：任何错误原样报出 | —（默认） | 默认路径 |
 * | 1 | 换访问路径（`NOT INDEXED`），只改 SQLite 的访问方式 | **不会** | 所有读查询自动生效 |
 * | 2 | 跳过坏页覆盖的行区间（分块扫描） | 会 | 导出链路按需回退（见 `iterateSalvageWindows`）；其余读取入口仍是严格 |
 * | 3 | 整表放弃：隔离读不动的表，保证其它表可用 | 会 | 已接入分块扫描（导出链路），隔离清单可在设置里清除 |
 *
 * 级别 2 的接入是**按需回退**而不是默认走法：只有在一条读查询**真的**报出损坏、
 * 且用户已授权级别 2 时，才从当前游标切到分块扫描续读。健康库因此零成本，
 * 也不会出现"其实没坏但悄悄换了读法"这种事。
 */

import type {
  DatabaseAlgorithms,
  NtHelperBinding,
  SalvageKeyRange,
  SalvageQueryOutcome,
  SalvageScanOutcome,
  SalvageSkippedRange,
  SqlRow,
  SqlValue,
} from '@weq/native';
import { isLikelyCorruptionError } from './errors';

/** 宽容级别。0 = 严格（默认）。 */
export type SalvageLevel = 0 | 1 | 2 | 3;

/**
 * 面向用户的级别说明**不在这里**。
 *
 * 原来这里有一份 `SALVAGE_LEVEL_DESCRIPTIONS`，但没有任何调用方 —— 设置页/弹窗用的是
 * `@weq/service` 的 `db_tolerance_copy.ts`。同一批文案存两处必然漂移（而且漂移的方向
 * 通常是越写越宽），所以只留 service 那一份，并且它带守卫测试。
 */

/** 把任意输入夹到一个合法级别；非法值一律回到严格（0）。 */
export function clampSalvageLevel(value: unknown): SalvageLevel {
  const n = typeof value === 'number' ? Math.trunc(value) : 0;
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

/** 级别是否已授权"可以动读取路径"。 */
export function isSalvageEnabled(level: SalvageLevel): boolean {
  return level >= 1;
}

// ────────────────────── native 产物能力检查 ──────────────────────

/**
 * 宽容链路（含坏页扫描）依赖的 native 接口。
 *
 * 为什么要有这份清单：`nt_helper.node` **不入库**，每个平台各自下载（`pnpm native:fetch`）。
 * 只要某个平台的产物比源码旧，它就没有这些方法 —— 而调用处得到的是
 * `undefined is not a function` 这种无从下手的信息（`loadNative` 只校验初始状态，
 * 抓不到"方法级缺能力"）。2026-09-20 实测：本机 linux/x64 是新的，其它四个平台目录
 * 的产物里 **一个 salvage 符号都没有**。
 *
 * 所以：只要真的要用宽容，就先点一遍名；缺了就在**这里**说清楚要重新取产物。
 */
export const SALVAGE_QUERY_METHODS = ['executeSqlSalvage', 'executeSqlSalvageWithKey'] as const;
export const SALVAGE_SCAN_METHODS = [
  'executeSqlSalvageScan',
  'executeSqlSalvageScanWithKey',
] as const;
export const SALVAGE_HEALTH_METHODS = [
  'scanBadPages',
  'closeSalvageDb',
  'listQuarantinedTables',
  'clearQuarantinedTables',
] as const;

/** 宽容链路的全部接口（体检时点名用）。 */
export const SALVAGE_BINDING_METHODS = [
  ...SALVAGE_QUERY_METHODS,
  ...SALVAGE_SCAN_METHODS,
  ...SALVAGE_HEALTH_METHODS,
] as const;

export type SalvageBindingMethod = (typeof SALVAGE_BINDING_METHODS)[number];

/**
 * 数据库修复（`recoverDatabase`）依赖的 native 接口。
 *
 * 与宽容链路的清单**分开**：宽容没取到新产物只是"降级不可用，严格照旧"，而修复没
 * 取到新产物是"这个功能没法用" —— 报错时要说的是两件事；而且老产物上这两个能力的
 * 缺失本来也不一定同步。
 */
export const RECOVER_METHODS = ['recoverDatabase'] as const;
export type RecoverBindingMethod = (typeof RECOVER_METHODS)[number];

/**
 * 这个绑定上**缺**哪些宽容接口（空数组 = 该项能力完好）。
 *
 * `required` 默认是全量清单；调用方通常只该校验**马上要用到**的那几个 ——
 * 否则一个只做坏页扫描的调用会被"缺少扫描方法"拦住，报错与事实不符。
 */
export function missingSalvageMethods(
  nt: NtHelperBinding,
  required: readonly SalvageBindingMethod[] = SALVAGE_BINDING_METHODS,
): SalvageBindingMethod[] {
  return missingMethods(nt, required);
}

/** 这个绑定上**缺**哪些修复接口（空数组 = 修复能力完好）。 */
export function missingRecoverMethods(
  nt: NtHelperBinding,
  required: readonly RecoverBindingMethod[] = RECOVER_METHODS,
): RecoverBindingMethod[] {
  return missingMethods(nt, required);
}

/** 两个清单共用的点名实现。 */
function missingMethods<T extends string>(nt: NtHelperBinding, required: readonly T[]): T[] {
  const bag = nt as unknown as Record<string, unknown>;
  return required.filter((name) => typeof bag[name] !== 'function');
}

/** 缺产物时的统一话术后半段（前半句按能力各自写）。 */
function missingBindingHint(missing: readonly string[]): string {
  return (
    `缺少 ${missing.join(', ')}。\n` +
    '这通常意味着这份 nt_helper.node 是旧版本 —— 重新获取对应平台的产物即可\n' +
    '（`pnpm native:fetch --platform <win32|linux|darwin> --arch <x64|arm64>`）。\n'
  );
}

/**
 * 用宽容之前先确认 native 产物支持它；不支持就抛一条**能照着做**的错误。
 *
 * `feature` 只用于报错文案（“分块扫描”/“读查询”），因为同一个缺失集合在不同入口
 * 下的第一句话不该一模一样。
 */
export function assertSalvageCapable(
  nt: NtHelperBinding,
  feature: string,
  required: readonly SalvageBindingMethod[] = SALVAGE_BINDING_METHODS,
): void {
  const missing = missingSalvageMethods(nt, required);
  if (missing.length === 0) return;
  throw new Error(
    `当前平台的 native 产物不支持${feature}：${missingBindingHint(missing)}` +
      '在补齐之前，宽容级别不会有任何效果，读取会一直走严格通道。',
  );
}

/**
 * 用数据库修复之前先确认 native 产物支持它。
 *
 * 与 {@link assertSalvageCapable} 的区别只在话术：修复是用户主动发起的、有明确
 * 目的的操作，所以要点明"修复入口会一直报这个错"，而不是谈宽容级别。
 */
export function assertRecoverCapable(
  nt: NtHelperBinding,
  feature = '数据库修复',
  required: readonly RecoverBindingMethod[] = RECOVER_METHODS,
): void {
  const missing = missingRecoverMethods(nt, required);
  if (missing.length === 0) return;
  throw new Error(
    `当前平台的 native 产物不支持${feature}：${missingBindingHint(missing)}` +
      '在补齐之前，修复入口会一直报这个错（数据库本身没有被改动）。',
  );
}

// ────────────────────────────── 账本 ──────────────────────────────

/** 一次降级的账目。 */
export interface SalvageLedgerEntry {
  /** ISO 时间戳。 */
  at: string;
  /** 发生降级的数据库路径。 */
  dbPath: string;
  /** 当时的宽容级别。 */
  level: SalvageLevel;
  /**
   * `index-retreat`：换了访问路径后拿到了结果（完整，不丢数据）。
   * `unrecoverable`：损坏且替代路径也救不回来（本次查询没有结果）。
   * `skipped-ranges`：分块扫描里有区间读不出来，**已跳过**（结果不完整，但可用）。
   * `quarantined`：该表已被整表放弃（L3），本次压根没读。
   */
  kind: 'index-retreat' | 'unrecoverable' | 'skipped-ranges' | 'quarantined';
  /** `'corrupt'` | `'not-a-database'`。 */
  errorKind: string;
  /** SQLite 主错误码。 */
  errorCode: number | null;
  /** 原始错误文案（native 提供，便于对照日志）。 */
  message: string | null;
  /** SQL 结构指纹 —— **不含参数值**，避免把聊天内容写进账本。 */
  sqlFingerprint: string;
  /** 仅 `skipped-ranges`：跳过了几处区间（相邻同类区间已合并过）。 */
  skippedRangeCount?: number;
  /**
   * 仅 `skipped-ranges`：跳过的 key 跨度总和。
   *
   * ⚠️ 它**不是丢失行数的上界**：同一个键可能对应多行（共享 `seq` 的灰条、贴表情），
   * 实测就有"丢 21 行而跨度只有 18"。字段名沿用历史（已落盘的账目里就是这个键），
   * 但展示与报告里的措辞必须是"键区间"而不是"N 行"。
   */
  skippedSpanUpperBound?: number;
}

/**
 * 把一条 SQL 归一化成"结构指纹"：去掉所有字面量与数字，只留关键字与标识符。
 *
 * 这么做的原因很直接：账本要落盘、要进反馈包，而 SQL 里的参数往往就是用户的消息
 * 内容。指纹足够定位"是哪条查询出了毛病"，又不会把数据带走。
 */
export function fingerprintSql(sql: string): string {
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, '?') // 字符串字面量（含 '' 转义）
    .replace(/--[^\n]*/g, ' ') // 行注释
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    // 位置参数编号（`?1` / `?2`）先归一成 `?`：编号是占位符的一部分，不是数据。
    // 漏了这一步的话，下面的数字规则会把 `?1` 变成 `??` —— 分块扫描的 SQL 恰好
    // 以 `?1`/`?2` 结尾，账本里每一条都会看起来像拼错了。
    .replace(/\?\d+/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // 数字字面量
    .replace(/\s+/g, ' ')
    .trim();
  const LIMIT = 240;
  if (stripped.length <= LIMIT) return stripped;
  let end = LIMIT;
  while (end > 0 && !isHighSurrogateSafe(stripped, end)) end -= 1;
  return `${stripped.slice(0, end)}…`;
}

/** 避免在代理对中间截断（`slice` 按 UTF-16 码元切）。 */
function isHighSurrogateSafe(text: string, index: number): boolean {
  const code = text.charCodeAt(index - 1);
  return Number.isNaN(code) || code < 0xd800 || code > 0xdbff;
}

/**
 * 进程内的降级账本。
 *
 * 刻意只做"记录 + 汇报"，不碰文件系统 —— 落盘由上层（`@weq/service`）负责，
 * 这样 `@weq/db` 不引入路径/日志依赖，单测里也能直接用内存账本断言行为。
 */
export class SalvageLedger {
  private readonly entries: SalvageLedgerEntry[] = [];
  private readonly listeners = new Set<(entry: SalvageLedgerEntry) => void>();

  /** 记录一条降级账目，并通知订阅者。 */
  record(entry: SalvageLedgerEntry): void {
    this.entries.push(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* 观察者绝不能影响查询路径 */
      }
    }
  }

  /** 全部账目（按发生顺序）。 */
  list(): readonly SalvageLedgerEntry[] {
    return this.entries;
  }

  /**
   * 汇总：给设置页与导出报告用。
   *
   * 四种结局各自计数，**不合并**：`unrecoverable` 只是"这条查询没结果"，而
   * `skipped-ranges` 是"拿到了结果但少了若干区间"，两者在报告里的说法完全不同。
   */
  summary(): {
    total: number;
    indexRetreat: number;
    unrecoverable: number;
    skipped: number;
    quarantined: number;
    databases: string[];
    lastAt: string | null;
  } {
    let indexRetreat = 0;
    let unrecoverable = 0;
    let skipped = 0;
    let quarantined = 0;
    const databases = new Set<string>();
    for (const entry of this.entries) {
      if (entry.kind === 'index-retreat') indexRetreat += 1;
      else if (entry.kind === 'skipped-ranges') skipped += 1;
      else if (entry.kind === 'quarantined') quarantined += 1;
      else unrecoverable += 1;
      databases.add(entry.dbPath);
    }
    return {
      total: this.entries.length,
      indexRetreat,
      unrecoverable,
      skipped,
      quarantined,
      databases: [...databases],
      lastAt: this.entries.length > 0 ? this.entries[this.entries.length - 1]!.at : null,
    };
  }

  /** 订阅新账目（返回退订函数）。 */
  subscribe(listener: (entry: SalvageLedgerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 清空账本（例如切账号）。 */
  clear(): void {
    this.entries.length = 0;
  }
}

// ────────────────────────── 绑定包装 ──────────────────────────

/** 宽容模式下抛出的错误：保留原文案，额外带上可判定的结构化字段。 */
export interface SalvageQueryError extends Error {
  readonly salvage: true;
  readonly dbPath: string;
  readonly errorKind: string;
  readonly errorCode: number | null;
}

export interface SalvageBindingOptions {
  /** 当前授权的宽容级别（每次读取实时取，支持运行中改设置）。 */
  level: () => number;
  /** 账本；省略则不记账（但错误仍会照旧抛出）。 */
  ledger?: SalvageLedger;
  /** 额外回调，供上层落盘 / 打日志。 */
  onEntry?: (entry: SalvageLedgerEntry) => void;
}

interface ReadCredentials {
  key: string;
  algo: import('@weq/native').DatabaseAlgorithms;
}

/**
 * 把 `nt` 包一层：**只读**方法在宽容级别 ≥ 1 时改走 salvage 通道。
 *
 * 严格级别下这是一个纯粹的透传（连一次包装调用都不会多花），所以"默认不开启"是
 * 结构上保证的，而非靠约定。写方法（`executeSqlWrite*`）永远不被改写。
 */
export function wrapBindingForSalvage(
  nt: NtHelperBinding,
  opts: SalvageBindingOptions,
): NtHelperBinding {
  return new Proxy(nt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;

      if (prop === 'executeSql') {
        return (dbPath: string, sql: string, params?: SqlValue[] | null): Promise<SqlRow[]> =>
          runRead(target, dbPath, sql, params ?? null, null, opts);
      }
      if (prop === 'executeSqlWithKey') {
        return (
          dbPath: string,
          sql: string,
          key: string,
          algo: ReadCredentials['algo'],
          params?: SqlValue[] | null,
        ): Promise<SqlRow[]> => runRead(target, dbPath, sql, params ?? null, { key, algo }, opts);
      }
      // 其余方法（含写路径与 closeDb）原样透传，`this` 指向真实绑定。
      return fn.bind(target);
    },
  });
}

/** 执行一条被包装的读查询：严格级别直通，宽容级别走 salvage 通道。 */
async function runRead(
  nt: NtHelperBinding,
  dbPath: string,
  sql: string,
  params: SqlValue[] | null,
  credentials: ReadCredentials | null,
  opts: SalvageBindingOptions,
): Promise<SqlRow[]> {
  const level = clampSalvageLevel(opts.level());

  if (!isSalvageEnabled(level)) {
    return credentials
      ? nt.executeSqlWithKey(dbPath, sql, credentials.key, credentials.algo, params)
      : nt.executeSql(dbPath, sql, params);
  }

  assertSalvageCapable(
    nt,
    '宽容读查询（级别 1 及以上）',
    credentials ? ['executeSqlSalvageWithKey'] : ['executeSqlSalvage'],
  );

  const outcome = credentials
    ? await nt.executeSqlSalvageWithKey(
        dbPath,
        sql,
        credentials.key,
        credentials.algo,
        params,
        level,
      )
    : await nt.executeSqlSalvage(dbPath, sql, params, level);

  return interpretOutcome(outcome, dbPath, sql, level, opts);
}

/** 把 native 的结果翻译成"旧行为 + 账本"：有结果就返回，没结果就把错误抛回去。 */
function interpretOutcome(
  outcome: SalvageQueryOutcome,
  dbPath: string,
  sql: string,
  level: SalvageLevel,
  opts: SalvageBindingOptions,
): SqlRow[] {
  if (!outcome.ok) {
    // L3 短路：该表**这次根本没读**。它必须与"又读到损坏"分开记账 —— 界面上的说法
    // 完全不同（一个是"可以清除隔离再试"，另一个是"数据可能真没了"），所以这里
    // 与 `runSalvageScan` 用同一套判据，而不是一律记成 `unrecoverable`。
    if (outcome.quarantined) {
      recordEntry(
        {
          at: new Date().toISOString(),
          dbPath,
          level: clampSalvageLevel(outcome.levelUsed),
          kind: 'quarantined',
          errorKind: outcome.errorKind,
          errorCode: null,
          message: outcome.errorMessage ?? null,
          sqlFingerprint: fingerprintSql(sql),
        },
        opts,
      );
      throw buildQuarantinedError(outcome.table, dbPath, outcome.errorKind);
    }
    recordEntry(
      {
        at: new Date().toISOString(),
        dbPath,
        level,
        kind: 'unrecoverable',
        errorKind: outcome.errorKind,
        errorCode: outcome.errorCode ?? null,
        message: outcome.errorMessage ?? null,
        sqlFingerprint: fingerprintSql(sql),
      },
      opts,
    );
    throw buildSalvageError(outcome, dbPath);
  }

  if (outcome.degraded) {
    recordEntry(
      {
        at: new Date().toISOString(),
        dbPath,
        level: clampSalvageLevel(outcome.levelUsed),
        kind: 'index-retreat',
        errorKind: outcome.errorKind,
        errorCode: outcome.errorCode ?? null,
        message: null,
        sqlFingerprint: fingerprintSql(sql),
      },
      opts,
    );
  }

  return outcome.rows;
}

function recordEntry(entry: SalvageLedgerEntry, opts: SalvageBindingOptions): void {
  opts.ledger?.record(entry);
  try {
    opts.onEntry?.(entry);
  } catch {
    /* 落盘失败不能影响查询 */
  }
}

/**
 * 构造一个"看起来和严格模式一样的"损坏错误。
 *
 * 关键点：**文案必须与 native 原文一致** —— 上层的 `isLikelyCorruptionError`
 * 靠文案做"疑似"判定、健康检查弹窗靠它触发，这些既有行为一个都不能变。
 * 结构化字段只是额外附带的，给新代码用。
 */
/** 失败结局该记进账本的那句话（超预算要说明是主动放弃，而不是"读不出来"）。 */
function describeFailure(outcome: SalvageScanOutcome): string | null {
  return outcome.budgetExhausted
    ? budgetSentence(outcome.skipped.length, outcome.skippedSpan)
    : (outcome.errorMessage ?? null);
}

/** 超预算时给用户看的一句话（与 {@link buildBudgetError} 共用一个口径）。 */
function budgetSentence(ranges: number, span: number): string {
  return `损坏超出宽容预算（已跳过 ${ranges} 处 / 键跨度 ≤ ${span}）：本次读取按严格模式失败`;
}

/**
 * 超预算错误：保留"能救但不想无限制地救"的结构化信息，且仍带 `salvage: true`。
 *
 * 它**不是**损坏错误：`isLikelyCorruptionError` 认不出它（文案与错误码都不是损坏），
 * 所以既有的"疑似损坏 → 弹窗 + 健康检查"链路不会因为它被误触发。
 */
function buildBudgetError(outcome: SalvageScanOutcome, dbPath: string): SalvageQueryError {
  return Object.assign(new Error(budgetSentence(outcome.skipped.length, outcome.skippedSpan)), {
    name: 'SalvageBudgetError',
    salvage: true as const,
    dbPath,
    errorKind: outcome.errorKind,
    errorCode: outcome.errorCode ?? null,
  });
}

function buildSalvageError(
  outcome: Pick<SalvageQueryOutcome, 'errorKind' | 'errorCode' | 'errorMessage'>,
  dbPath: string,
): SalvageQueryError {
  const message = outcome.errorMessage ?? '数据库损坏，且替代访问路径也无法读取该数据';
  return Object.assign(new Error(message), {
    name: 'SalvageQueryError',
    salvage: true as const,
    dbPath,
    errorKind: outcome.errorKind,
    errorCode: outcome.errorCode ?? null,
  });
}

/**
 * L3（整表放弃）短路时抛出的错误。
 *
 * 它**不是**损坏错误：`errorCode` 为 `null`，文案里也不含任何损坏签名，所以既有的
 * "疑似损坏 → 弹窗 + 健康检查"链路不会被它误触发 —— 该表早先就已经判定过了。文案的
 * 重点是给出**恢复路径**：清除隔离记录（设置 → 数据库宽容）就能立刻再试。
 */
function buildQuarantinedError(
  table: string | null | undefined,
  dbPath: string,
  errorKind: string,
): SalvageQueryError {
  return Object.assign(
    new Error(
      `表 ${table ?? '(未知)'} 已被整表放弃（宽容级别 3）：` +
        '可在 设置 → 数据库宽容 里清除隔离记录后再试，或先修复数据库',
    ),
    {
      name: 'SalvageQuarantinedError',
      salvage: true as const,
      dbPath,
      errorKind,
      errorCode: null,
    },
  );
}

// ───────────────────────── 分块容错扫描（L2 / L3） ─────────────────────────

/** 扫描的目标连接（一般是 `QqDb` 持有的那三个字段）。 */
export interface SalvageScanTarget {
  /** 绝对路径。 */
  dbPath: string;
  /** SQLCipher 密钥；明文库省略。 */
  key?: string;
  /** 对应的算法对；明文库省略。 */
  algo?: DatabaseAlgorithms;
}

/**
 * 一次分块扫描的请求。
 *
 * SQL 契约（native 不解析 SQL）：末两个 `?` 是 `(lo, hi)`、结果按 key 升序、
 * **第一列是整数 key**（一般是 `rowid`）。
 */
export interface SalvageScanRequest {
  /** 扫描下界（不含）。 */
  lo: bigint;
  /**
   * 扫描上界（含）；省略 = **一直读到表尾**（必须配 `seekSql`）。
   *
   * `rowid` 这种稀疏键空间应当直接省略上界 + 给探针：`MAX(rowid)` 既超出 JS 安全整数，
   * 又会让"按块推进"变成 `1e13` 量级的窗口。
   */
  hi?: bigint;
  /** 除区间边界之外的其它 `?` 参数。 */
  params?: SqlValue[] | null;
  /** 每块覆盖的 key 跨度；默认 4096。 */
  chunk?: number;
  /** 二分的下限跨度；默认 1。 */
  minSpan?: number;
  /** 预算：最多跳过几处**损坏区域**（相邻同类区间会合并）；默认 256。 */
  maxSkippedRanges?: number;
  /** 预算：最多跳过多少 key 跨度（**不是行数**）；默认 8192。 */
  maxSkippedSpan?: number;
  /**
   * 已知键探针（见 `SalvageScanOptions.seekSql`）：给上它，空键区间一次探针就跳过去。
   * 只在"一次扫完一段稀疏键空间"时才有意义；`scanWindows` 是逐窗口读，用不到它。
   */
  seekSql?: string;
  /** 最多允许多少个窗口（仅在没有 `seekSql` 时检查）；默认 100000。 */
  maxWindows?: number;
  /**
   * 已知坏区间 —— 把上一次扫描结果的 `skipped` 原样回填即可（`lo` / `hi` 就是当时
   * 查询用的窗口边界），下次扫描就不必为它们重试。
   */
  hints?: SalvageKeyRange[];
}

/**
 * 分块容错扫描：**尽量多地把数据读出来**，读不出来的区间如实记账。
 *
 * 这是唯一会丢数据的读取入口，所以它把三条纪律写死在代码里：
 *
 * 1. **授权是第一道门**：`level === 0`（严格）直接拒绝 —— 严格模式请用 `QqDb.query`，
 *    不要用一个"本来就会跳过"的入口；
 * 2. **没拿到可用结果就照旧报错**：`ok === false`（超预算 / 未授权 L2 / 表被隔离）一律
 *    抛出与严格模式同源的错误，绝不返回部分数据；
 * 3. **降级全程可见**：跳过的区间、被隔离的表都写进账本，报告里能说出"少了哪一段、
 *    上界是多少"。
 */
export async function runSalvageScan(
  nt: NtHelperBinding,
  target: SalvageScanTarget,
  sql: string,
  request: SalvageScanRequest,
  opts: SalvageBindingOptions,
): Promise<SalvageScanOutcome> {
  const level = clampSalvageLevel(opts.level());
  if (level === 0) {
    throw new Error('分块容错扫描需要宽容级别 ≥ 1（当前是严格模式）：请改用 QqDb.query');
  }
  // 产物能力先于预算/参数校验：缺方法时的报错必须是"去取产物"，而不是"参数不对"。
  // 只点名**马上要调**的那一个：加密库用 `WithKey`，明文库用另一支。
  assertSalvageCapable(
    nt,
    '分块容错扫描',
    target.key !== undefined ? ['executeSqlSalvageScanWithKey'] : ['executeSqlSalvageScan'],
  );

  const options = {
    lo: request.lo,
    ...(request.hi !== undefined ? { hi: request.hi } : {}),
    ...(request.chunk !== undefined ? { chunk: request.chunk } : {}),
    ...(request.minSpan !== undefined ? { minSpan: request.minSpan } : {}),
    ...(request.maxSkippedRanges !== undefined
      ? { maxSkippedRanges: request.maxSkippedRanges }
      : {}),
    ...(request.maxSkippedSpan !== undefined ? { maxSkippedSpan: request.maxSkippedSpan } : {}),
    ...(request.maxWindows !== undefined ? { maxWindows: request.maxWindows } : {}),
    ...(request.seekSql !== undefined ? { seekSql: request.seekSql } : {}),
    ...(request.hints && request.hints.length > 0 ? { hints: request.hints } : {}),
  };

  const outcome =
    target.key !== undefined && target.algo !== undefined
      ? await nt.executeSqlSalvageScanWithKey(
          target.dbPath,
          sql,
          target.key,
          target.algo,
          request.params ?? null,
          options,
          level,
        )
      : await nt.executeSqlSalvageScan(target.dbPath, sql, request.params ?? null, options, level);

  if (!outcome.ok) {
    recordEntry(
      {
        at: new Date().toISOString(),
        dbPath: target.dbPath,
        level,
        kind: outcome.quarantined ? 'quarantined' : 'unrecoverable',
        errorKind: outcome.errorKind,
        errorCode: outcome.errorCode ?? null,
        message: describeFailure(outcome),
        sqlFingerprint: fingerprintSql(sql),
      },
      opts,
    );
    if (outcome.quarantined) {
      throw buildQuarantinedError(outcome.table, target.dbPath, outcome.errorKind);
    }
    // 超预算是"主动放弃"，不是"这一页读不出来" —— 错误里必须说清楚，否则用户会以为
    // 只是某条消息缺失，实际是整个结果都没给。
    throw outcome.budgetExhausted
      ? buildBudgetError(outcome, target.dbPath)
      : buildSalvageError(outcome, target.dbPath);
  }

  // 拿到结果但少了若干区间：这是**会丢数据**的结局，必须留下账目。
  if (outcome.skipped.length > 0) {
    recordEntry(
      {
        at: new Date().toISOString(),
        dbPath: target.dbPath,
        level: clampSalvageLevel(outcome.levelUsed),
        kind: 'skipped-ranges',
        errorKind: outcome.skipped[0]?.errorKind ?? 'none',
        errorCode: outcome.skipped[0]?.errorCode ?? null,
        message: describeSkipped(outcome),
        sqlFingerprint: fingerprintSql(sql),
        skippedRangeCount: outcome.skipped.length,
        skippedSpanUpperBound: outcome.skippedSpan,
      },
      opts,
    );
  }

  return outcome;
}

/**
 * 把跳过区间写成一句人能读的话（进账本 / 报告）。
 *
 * 刻意只报**键区间**，不报行数：区间内部究竟有多少行，读不出来就是不知道；而键跨度
 * **不是行数的上界**（同一个键可能对应多行 —— 共享 `seq` 的灰条、贴表情，实测就有
 * "丢 21 行而跨度只有 18"）。
 */
export function describeSkipped(outcome: SalvageScanOutcome): string {
  const parts = outcome.skipped.map((range) => {
    const left = range.prevKey == null ? '起始处' : `key ${range.prevKey} 之后`;
    const right = range.nextKey == null ? '到扫描结束' : `直到 key ${range.nextKey} 之前`;
    return `${left}、${right}`;
  });
  const where = parts.length > 0 ? `：${parts.join('；')}` : '';
  const hint = outcome.skipped.some((range) => range.errorKind === 'hint')
    ? '（含按已知坏页直接跳过的区间）'
    : '';
  return `跳过 ${outcome.skipped.length} 处（键跨度合计 ${outcome.skippedSpan}）${hint}${where}`;
}

// ──────────────────── 分块窗口驱动（流式读取，不整段入内存） ────────────────────

/**
 * 一个沿键轴推进的分块计划（窗口语义 `(lo, hi]`，与 native 一致）。
 *
 * 与 {@link SalvageScanRequest} 的区别在"粒度"：那个是「一次性扫完一个区间」，本结构
 * 是「沿键轴逐块推进」。导出一场几万条的会话时，一次性扫完会把整段结果留在内存里，
 * 而导出之所以写成 async generator，就是为了避免这件事。
 */
export interface SalvageWindowPlan {
  /** 起始键（不含）。 */
  lo: bigint;
  /** 结束键（含）。 */
  hi: bigint;
  /** 每块覆盖的键跨度；默认 `4096`。 */
  chunk?: number;
  /** 二分的下限跨度；默认 `1`。 */
  minSpan?: number;
  /** **跨窗口累计**的预算：最多允许跳过几处**损坏区域**（相邻同类区间会合并）；默认 `20`。 */
  maxSkippedRanges?: number;
  /** **跨窗口累计**的预算：最多允许跳过多少键跨度（**不是行数**）；默认 `500`。 */
  maxSkippedSpan?: number;
  /**
   * **跨窗口跳空用的已知键探针**（契约与 native 的 `seekSql` 一致，见
   * `SalvageScanOptions.seekSql`）。
   *
   * 键空间稀疏时必需：`rowid` 实测在 `7.6e18` 量级，一个 `4096` 宽的窗口里往往
   * 一个键都没有，逐格推进等于永远走不完。给了它，空窗口就一次探针跳到下一个真的
   * 存在的键（见 {@link iterateSalvageWindows}）。
   */
  seekSql?: string;
}

/** 默认分块跨度：与 native 侧的默认值保持一致（`DEFAULT_SCAN_CHUNK`）。 */
const WINDOW_CHUNK = 4096;
/**
 * 默认跨窗口预算。单位是"损坏**区域**"而不是"键"：native 会先合并相邻同类区间，
 * 所以一整页坏掉只算一处。
 *
 * 这两个数只由驱动层兜底 —— 正常情况下 native 自己会先用剩余额度拦住。
 */
const WINDOW_MAX_SKIPPED_RANGES = 20;
const WINDOW_MAX_SKIPPED_SPAN = 500;

/**
 * 为什么**故意**比 native 的默认值（256 / 8192）小：这两个数决定的是"要假死多久才肯
 * 放弃"，而不是"能救回多少"。
 *
 * 实测代价（2026-09-20，真实损坏库、二分地板 span=1）：一个读不出来的键大约要付
 * **215ms**（两次 native 尝试），即：
 *   - 500 键跨度  → 约 108 秒后干净地失败（可接受的等待）；
 *   - 8192 键跨度 → 约 29 分钟后才失败（UI 上看起来就是卡死）。
 *
 * 所以驱动层把额度收紧，native 那份较大的默认值留给"调用方明确要求”的场景
 * （例如将来的离线修复），不当作交互式读取的默认。
 */

export interface SalvageWindowOptions {
  /** 原生绑定（未包过 salvage 也行，这里直接调用扫描方法）。 */
  nt: NtHelperBinding;
  /** 目标库（路径 + 可选密钥/算法）。 */
  target: SalvageScanTarget;
  /**
   * 扫描语句。契约与 {@link SalvageScanRequest} 一致：末两个 `?` 是 `(lo, hi)`，
   * 结果按第一列（整数键）升序。
   */
  sql: string;
  /** 区间边界之外的其它参数（SQL 里排在 `(lo, hi)` 之前）。 */
  params?: SqlValue[] | null;
  /** 分块计划：从哪个键读到哪个键、每块多大、允许多少降级。 */
  plan: SalvageWindowPlan;
  /** 宽容授权（含账本与回调）。 */
  opts: SalvageBindingOptions;
  /** 已知坏区间（一般是上次扫描的 `skipped`），第一个窗口就免查这些区间。 */
  hints?: SalvageKeyRange[];
  /** 每次跳过回调一批：`ranges` 是本批区间，`span` 是本批键跨度合计。 */
  onSkipped?: (ranges: SalvageSkippedRange[], span: number) => void;
}

/**
 * 沿键轴逐块容错读取，逐块把行交出去。
 *
 * 逐块调用 {@link runSalvageScan}：块内坏了先换访问路径（L1）、再二分（L2）、真的读不出来
 * 就记成跳过区间；块与块之间把**已知坏区间累积成 hints** 回填给后面的块 —— 跨块延展的
 * 坏页因此只会被二分一次，而不是每块都从头试错一遍。
 *
 * 四条边界（与单次扫描同一套纪律，缺一不可）：
 *  1. **要求 `level >= 2`**：跳过数据必须有授权。级别 1 请用普通查询 —— 它不丢数据；
 *  2. **预算跨窗口累计**：剩余额度透传给 native（由它先拦），驱动层再兜一次底，
 *     用尽即按严格语义抛错，绝不"越救越多"；
 *  3. **跳过的区间逐批回调**："少了什么"必须能被写进报告，而不是只存在于内存里；
 *  4. **空窗口靠探针跳过去**：给了 `plan.seekSql` 时，空窗口不再按固定步长推进，
 *     而是直接跳到下一个真的存在的键 —— 没有它，`rowid` 这种稀疏键空间（实测
 *     `7.6e18` 量级）会让窗口循环永远跑不完（实测 15 秒仍未结束）。
 */
export async function* iterateSalvageWindows(o: SalvageWindowOptions): AsyncGenerator<SqlRow[]> {
  const level = clampSalvageLevel(o.opts.level());
  if (level < 2) {
    throw new Error(`分块容错读取需要宽容级别 ≥ 2（当前 ${level}）：请改用 QqDb.query`);
  }

  const chunk = BigInt(positiveInt(o.plan.chunk, WINDOW_CHUNK));
  const maxRanges = positiveInt(o.plan.maxSkippedRanges, WINDOW_MAX_SKIPPED_RANGES);
  const maxSpan = positiveInt(o.plan.maxSkippedSpan, WINDOW_MAX_SKIPPED_SPAN);
  const seekSql = o.plan.seekSql;
  const hints: SalvageKeyRange[] = [...(o.hints ?? [])];
  let skippedRanges = 0;
  let skippedSpan = 0;
  let cursor = o.plan.lo;

  while (cursor < o.plan.hi) {
    const hi = cursor + chunk < o.plan.hi ? cursor + chunk : o.plan.hi;
    const rangesLeft = maxRanges - skippedRanges;
    const spanLeft = maxSpan - skippedSpan;
    if (rangesLeft <= 0 || spanLeft <= 0) {
      throw new Error(budgetSentence(skippedRanges, skippedSpan));
    }

    const outcome = await runSalvageScan(
      o.nt,
      o.target,
      o.sql,
      {
        lo: cursor,
        hi,
        chunk: Number(chunk),
        ...(o.plan.minSpan !== undefined ? { minSpan: o.plan.minSpan } : {}),
        // 把**剩余**额度交下去：一个块自己就超了预算的话，native 会直接按失败返回。
        maxSkippedRanges: rangesLeft,
        maxSkippedSpan: spanLeft,
        ...(hints.length > 0 ? { hints: [...hints] } : {}),
        ...(o.params ? { params: o.params } : {}),
      },
      o.opts,
    );

    if (outcome.skipped.length > 0) {
      // **只上报/只计入新发现的区间**。
      //
      // 一段坏区间会被相邻两个窗口各报一次：游标只推进到最后一个**好**键，所以
      // 下一个窗口会把同一段再盖一遍。实测（2026-09-20，真实损坏库）一个 7 键的洞
      // 被记成 2 处 / 键跨度 14 —— 处数与跨度双双翻倍，预算也跟着双倍消耗，
      // 而导出日志与账本里那个数字是给用户看的，不能虚。
      const fresh = subtractCoveredRanges(outcome.skipped, hints);
      // 无论新旧都回填提示：下一次窗口扫描不必再为这些键重试（hint 区间不消耗预算）。
      for (const range of outcome.skipped) hints.push({ lo: range.lo, hi: range.hi });
      if (fresh.length > 0) {
        const span = spanOfRanges(fresh);
        skippedRanges += fresh.length;
        skippedSpan += span;
        o.onSkipped?.(fresh, span);
      }
    }

    if (outcome.rows.length === 0) {
      // 这一块没有任何行（键区间里本来就没数据，或整块被跳过）：跨过去。
      cursor = await advanceEmptyWindow(o, seekSql, cursor, hi);
      continue;
    }

    yield outcome.rows;
    const last = keyOfRow(outcome.rows[outcome.rows.length - 1]!);
    // 键必须严格前进，否则会在同一段上打转（SQL 契约说结果是升序的，这里是兜底）。
    cursor = last > cursor ? last : cursor + 1n;
  }
}

/**
 * 分块扫描的可选附件：已知坏区间与跳过回调。
 *
 * 两者成对出现的原因很直接：`hints` 是"上次已知的坏"，`onSkipped` 是"这次新发现的坏"，
 * 而上层通常只做一件事 —— 把 `onSkipped` 收到的区间攒下来，下次当作 `hints` 回填。
 */
export interface SalvageWindowExtras {
  /** 已知坏区间（上次扫描的 `skipped` 原样回填即可）。 */
  hints?: SalvageKeyRange[];
  /** 每次跳过回调一批区间（导出报告用）。 */
  onSkipped?: (ranges: SalvageSkippedRange[], span: number) => void;
}

/**
 * 容错续读的公共选项（`GroupMsgDb` / `C2cMsgDb` 的 `streamSalvage*` 共用）。
 */
export interface SalvageStreamOptions extends SalvageWindowExtras {
  /** 宽容授权（含账本与回调）。`level()` 实时读，支持运行中改设置。 */
  salvage: SalvageBindingOptions;
  /** 结束键（含）；省略则自动查该会话的 `MAX(key)`。 */
  hi?: bigint;
  /** 每块键跨度；默认 `4096`。 */
  chunk?: number;
  /** 跨窗口累计的降级预算（见 {@link SalvageWindowPlan}）。 */
  maxSkippedRanges?: number;
  maxSkippedSpan?: number;
  /** 跨窗口跳空用的已知键探针；看 {@link SalvageWindowPlan.seekSql}。 */
  seekSql?: string;
}

/** 把 {@link SalvageStreamOptions} 换算成驱动要的分块计划。 */
export function windowPlanFrom(
  lo: bigint,
  hi: bigint,
  opts: Pick<
    SalvageStreamOptions,
    'chunk' | 'maxSkippedRanges' | 'maxSkippedSpan' | 'seekSql'
  > = {},
): SalvageWindowPlan {
  return {
    lo,
    hi,
    ...(opts.chunk !== undefined ? { chunk: opts.chunk } : {}),
    ...(opts.maxSkippedRanges !== undefined ? { maxSkippedRanges: opts.maxSkippedRanges } : {}),
    ...(opts.maxSkippedSpan !== undefined ? { maxSkippedSpan: opts.maxSkippedSpan } : {}),
    ...(opts.seekSql !== undefined ? { seekSql: opts.seekSql } : {}),
  };
}

/** 第一列就是键（`rowid` / `40003`）；不是整数就说明调用方的 SQL 不符合契约。 */
function keyOfRow(row: SqlRow): bigint {
  const first = row[0];
  if (typeof first === 'bigint') return first;
  if (typeof first === 'number') return BigInt(Math.trunc(first));
  if (typeof first === 'string' && /^-?\d+$/.test(first)) return BigInt(first);
  throw new Error('分块容错读取要求结果第一列是整数键（一般是 rowid / msgSeq）');
}

/** 一次"下一个存在的键"探测的结果。 */
type ProbeOutcome =
  | { kind: 'next'; key: bigint }
  /** 键轴上后面再没有键了：扫描可以收工。 */
  | { kind: 'end' }
  /** 探针自己踩到坏页：不知道下一个键在哪，退回固定步长推进。 */
  | { kind: 'unknown' };

/**
 * 空窗口之后游标推到哪里。
 *
 * * 没给探针（或探针踩到坏页）：按窗口上界推进 —— 老行为；
 * * 给了探针：跳到"下一个真的存在的键减一"，那个键正好落进下一个窗口，而它之前的
 *   键（按探针契约）都不存在，不会重复读。
 *
 * **必须严格前进**：探针给出的键可能正好是 `cursor + 1`，而它所在的窗口刚刚整体
 * 被跳过（读不出来）—— 这时只推进 `cursor + 1`，否则会在同一段上打转。
 */
async function advanceEmptyWindow(
  o: SalvageWindowOptions,
  seekSql: string | undefined,
  cursor: bigint,
  hi: bigint,
): Promise<bigint> {
  if (seekSql === undefined) return hi;
  const probe = await probeNextKey(o, seekSql, cursor);
  // 后面没有更大的键了：把游标推到终点，外层循环自然结束。
  if (probe.kind === 'end') return o.plan.hi;
  if (probe.kind === 'unknown') return hi;
  const anchored = probe.key - 1n;
  return anchored > cursor ? anchored : cursor + 1n;
}

/**
 * 用调用方给的探针 SQL 找"严格大于 `from` 的最小键"。
 *
 * 走的是**普通读**（就不是一条 `MIN(key)`）：探针失败不影响结果语义，所以这里没有
 * 任何降级可言 —— 踩到坏页只说明这次加速没生效，交给固定步长推进，让正常的窗口扫描
 * 去二分那一小段。其它错误（SQL 写错 / 权限 / BUSY）原样抛出：那是调用方的问题。
 */
async function probeNextKey(
  o: SalvageWindowOptions,
  seekSql: string,
  from: bigint,
): Promise<ProbeOutcome> {
  const params: SqlValue[] = [...(o.params ?? []), from];
  let rows: SqlRow[];
  try {
    rows =
      o.target.key !== undefined && o.target.algo !== undefined
        ? await o.nt.executeSqlWithKey(
            o.target.dbPath,
            seekSql,
            o.target.key,
            o.target.algo,
            params,
          )
        : await o.nt.executeSql(o.target.dbPath, seekSql, params);
  } catch (err) {
    if (isLikelyCorruptionError(err)) return { kind: 'unknown' };
    throw err;
  }

  const row = rows[0];
  // 空结果，或 `MIN()` 在空集上给出的一行 NULL —— 都表示后面没有键了。
  if (!row || row[0] === null || row[0] === undefined) return { kind: 'end' };
  return { kind: 'next', key: keyOfRow(row) };
}

/**
 * 一批区间的键跨度合计（半开区间 `[lo, hi)` 的长度）。
 *
 * 口径：**键跨度不是行数**。同一个键可能对应多行（共享 seq 的灰条、贴表情），
 * 所以这个数字只能当"哪一段读不出来、有多宽"看，不能当"丢了多少条"。
 */
export function spanOfRanges(ranges: readonly SalvageKeyRange[]): number {
  let total = 0n;
  for (const range of ranges) {
    const width = range.hi - range.lo;
    if (width > 0n) total += width;
  }
  // 跨度只用于预算与展示：超出安全整数时夹住（真实场景里不会到这个量级）。
  const cap = BigInt(Number.MAX_SAFE_INTEGER);
  return total >= cap ? Number.MAX_SAFE_INTEGER : Number(total);
}

/**
 * 从 `ranges` 里减掉已经被 `covered` 盖住的部分，只留新碎片（已排序、相邻已合并）。
 *
 * 用途只有一个：驱动层跨窗口计数时避免把同一段坏区间数两遍（见
 * {@link iterateSalvageWindows}）。区间端点都按 `[lo, hi)` 处理，与 native 的
 * 窗口语义一致。
 */
export function subtractCoveredRanges<R extends SalvageKeyRange>(
  ranges: readonly R[],
  covered: readonly SalvageKeyRange[],
): R[] {
  const fresh: R[] = [];
  for (const range of ranges) {
    if (range.hi <= range.lo) continue;
    // 半开语义（`lo` 侧开、`hi` 侧闭）下的"区间减集合"。
    let segments: R[] = [range];
    for (const known of covered) {
      if (known.hi <= known.lo) continue;
      const next: R[] = [];
      for (const segment of segments) {
        // 完全不重叠（边界相接不算相交）：原样留下。
        if (known.hi <= segment.lo || known.lo >= segment.hi) {
          next.push(segment);
          continue;
        }
        // 左边剩下的部分：它的右邻就是这块已知区间的左边界。
        if (known.lo > segment.lo) next.push({ ...segment, hi: known.lo });
        // 右边剩下的部分：它的左邻就是这块已知区间的右边界。
        if (known.hi < segment.hi) next.push({ ...segment, lo: known.hi });
      }
      segments = next;
      if (segments.length === 0) break;
    }
    fresh.push(...segments);
  }
  return mergeAdjacentRanges(fresh);
}

/** 排序并合并相邻/重叠区间（同一段坏区间被切碎后重新粘回去）。 */
function mergeAdjacentRanges<R extends SalvageKeyRange>(ranges: R[]): R[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const merged: R[] = [sorted[0]!];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (range.lo <= last.hi) {
      if (range.hi > last.hi) merged[merged.length - 1] = { ...last, hi: range.hi };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/** 取一个正整数字段，非法值（NaN / 0 / 负数）回落到默认值。 */
function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}
