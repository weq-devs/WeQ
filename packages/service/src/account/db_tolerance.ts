/**
 * 账号级的数据库宽容（salvage）配置，以及降级账本的落盘。
 *
 * 三件事，各有明确理由：
 *
 * 1. **按账号存** —— 损坏情况每个账号的数据库都不一样，「A 账号开了宽容」不应该
 *    顺带影响 B 账号。存储复用 `AntiRecallService` 那套 per-account `JsonStore`
 *    模式（内存态即真源 + 原子落盘），不新增存储层。
 * 2. **默认严格** —— 缺文件即 `level: 0`，不需要迁移，也不存在「老用户被静默升级」。
 * 3. **账本落盘** —— 政策要求「降级全程可见」，而界面只在导出与检查报告里体现，
 *    所以账本必须留在磁盘上：一行一条 JSONL，只记 SQL **指纹**（不含参数值），
 *    随时能被打包进反馈包或写进报告。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SalvageLedger,
  clampSalvageLevel,
  type SalvageLedgerEntry,
  type SalvageLevel,
} from '@weq/db';
import { getLogger } from '../common/logger';
import { JsonStore } from '../common/json_store';

/** 一个账号的宽容配置。 */
export interface DbToleranceConfig {
  /** 已授权的宽容级别；0 = 严格（默认）。 */
  level: SalvageLevel;
  /** 最近一次授权的 ISO 时间；级别回到 0 时清空。用于报告里说明「何时开启」。 */
  grantedAt?: string;
}

const DEFAULT_CONFIG: DbToleranceConfig = { level: 0 };

/** 账本文件超过这个大小就丢掉最旧的一半（诊断日志，不需要无限增长）。 */
const LEDGER_MAX_BYTES = 2 * 1024 * 1024;
/** 一次压缩后保留的最大条数。 */
const LEDGER_KEEP_ENTRIES = 2000;

/** `JSON.parse` 出来的账目行是否长得像我们要的。 */
function isLedgerEntry(value: unknown): value is SalvageLedgerEntry {
  if (value == null || typeof value !== 'object') return false;
  const entry = value as Partial<SalvageLedgerEntry>;
  return typeof entry.at === 'string' && typeof entry.dbPath === 'string';
}

export class DbToleranceService {
  private readonly store: JsonStore<DbToleranceConfig>;
  /** 进程内账本，供设置页/报告即时读取（落盘是它的持久化投影）。 */
  private readonly ledger = new SalvageLedger();
  private readonly ledgerPath: string;
  private readonly log = getLogger().child({ scope: 'db-tolerance' });

  constructor(storePath: string) {
    this.store = new JsonStore<DbToleranceConfig>(storePath, () => ({ ...DEFAULT_CONFIG }), {
      normalize: (raw) => {
        const parsed = (raw ?? {}) as Partial<DbToleranceConfig>;
        const config: DbToleranceConfig = { level: clampSalvageLevel(parsed.level) };
        if (typeof parsed.grantedAt === 'string' && config.level > 0) {
          config.grantedAt = parsed.grantedAt;
        }
        return config;
      },
      pretty: true,
    });
    // 账本与配置放同一个目录：打包反馈、翻日志时不会漏。
    this.ledgerPath = join(dirname(storePath), 'salvage_ledger.jsonl');
    this.loadLedgerTail();
  }

  /** 当前级别。`wrapBindingForSalvage` 每次读查询都会实时取它。 */
  get level(): SalvageLevel {
    return this.store.data.level;
  }

  /** 当前配置的副本。 */
  getConfig(): DbToleranceConfig {
    return { ...this.store.data };
  }

  /**
   * 打包成 `@weq/db` 的宽容授权对象（给 `wrapBindingForSalvage` 与导出链路用）。
   *
   * 每次调用返回新对象，但里面的 `level()` 是**实时读**的：用户中途把级别调回严格，
   * 下一次读查询立刻就是严格语义，不需要重开账号。`onEntry` 直接落到账本落盘，
   * 所以"跳过了什么"会同时出现在内存账本、JSONL 与设置页。
   */
  binding(): { level: () => number; onEntry: (entry: SalvageLedgerEntry) => void } {
    return {
      level: () => this.level,
      onEntry: (entry) => this.recordLedgerEntry(entry),
    };
  }

  /** 进程内账目（最新在后）。 */
  listEntries(): readonly SalvageLedgerEntry[] {
    return this.ledger.list();
  }

  /** 汇总，给设置页与导出报告用。 */
  summary(): ReturnType<SalvageLedger['summary']> {
    return this.ledger.summary();
  }

  /** 账本文件路径（反馈包与"打开日志目录"用）。 */
  getLedgerPath(): string {
    return this.ledgerPath;
  }

  /**
   * 设置宽容级别。
   *
   * 只有用户显式动作才会走到这里（弹窗按钮 / 设置页开关），**没有任何自动降级**。
   * 升到 ≥1 时记下授权时间；回到 0 时清掉它 —— 报告里因此能准确回答
   * 「这个账号现在是严格模式还是宽容模式，以及是什么时候开的」。
   */
  setLevel(level: number, source: string): DbToleranceConfig {
    const next = clampSalvageLevel(level);
    const previous = this.store.data.level;
    if (next === previous) return this.getConfig();

    const config: DbToleranceConfig = { level: next };
    if (next > 0) config.grantedAt = new Date().toISOString();
    this.store.data = config;
    this.store.save();

    this.log.info('db tolerance level changed', {
      event: 'db-tolerance-changed',
      from: previous,
      to: next,
      source,
    });
    return this.getConfig();
  }

  /** 记录一次降级：进内存账本 + 追加一行 JSONL。 */
  recordLedgerEntry(entry: SalvageLedgerEntry): void {
    this.ledger.record(entry);
    this.appendLedgerLine(entry);
  }

  /** 读取磁盘上的账本（设置页与报告要展示"历史降级"，不只是本次进程的）。 */
  readLedgerFile(): SalvageLedgerEntry[] {
    try {
      return readFileSync(this.ledgerPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter(isLedgerEntry);
    } catch {
      return [];
    }
  }

  /** 启动时把磁盘上的尾部账目读进内存，让设置页一打开就有内容。 */
  private loadLedgerTail(): void {
    for (const entry of this.readLedgerFile()) this.ledger.record(entry);
  }

  private appendLedgerLine(entry: SalvageLedgerEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      appendFileSync(this.ledgerPath, line, 'utf8');
      this.rotateIfTooLarge();
    } catch (e) {
      // 落盘失败不影响查询：内存账本仍在，界面照样能看到本次降级。
      this.log.warn('failed to append salvage ledger', {
        event: 'salvage-ledger-append-failed',
        ...(e instanceof Error ? { error: e.message } : { error: String(e) }),
      });
    }
  }

  private rotateIfTooLarge(): void {
    if (statSync(this.ledgerPath).size <= LEDGER_MAX_BYTES) return;
    const lines = readFileSync(this.ledgerPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const kept = lines.slice(Math.max(0, lines.length - LEDGER_KEEP_ENTRIES));
    writeFileSync(this.ledgerPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    this.log.info('rotated salvage ledger', {
      event: 'salvage-ledger-rotated',
      dropped: lines.length - kept.length,
      kept: kept.length,
    });
  }
}
