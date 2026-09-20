/**
 * `DbRepairService` 的端到端单测：真文件、假 native。
 *
 * 这里钉住的是"错一步就会毁用户数据"的顺序与边界：
 *   - 备份发生在解密**之前**，且备份内容逐字节等于修复前的库；
 *   - 修复期间源库被写入 → 中止，且**源库一个字节都不动**；
 *   - 替换前仍被占用 → 中止，临时产物不留痕；
 *   - 产物自检不过 → 自动还原成修复前；
 *   - 同一时刻只允许一个修复任务；
 *   - 保留策略真的会删旧备份，但记录还留着。
 *
 * 假 native 的 `recover` 只做两件事：往 `outPath` 写一份"重建后"的内容、按 native 的
 * 形状回调进度与报告。真实算法由 nt_helper 侧的 Rust 测试覆盖。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAlgorithms } from '@weq/native';
import {
  DbRepairError,
  DbRepairService,
  type DbRepairDeps,
  type DbRepairLockProbe,
  type DbRepairProgress,
  type DbRepairRecoverOptions,
  type DbRepairRecoverReport,
  type DbRepairWalCheckpoint,
} from '../src/account/db_repair';

const ALGO: DatabaseAlgorithms = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' };
/** 服务只认 uin —— 目录与密钥由 `resolveAccount` 解析，测试里就是这个假账号。 */
const REF = '1707889225';

const tmpRoots: string[] = [];

function tmpDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `weq-db-repair-svc-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

/** 修复前的库内容（内容本身无意义，只要够用来比对 sha）。 */
function originalBytes(): Buffer {
  const buffer = Buffer.alloc(64 * 1024);
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = index % 251;
  return buffer;
}

/** "重建后"的内容：故意与原件不同，才能证明替换真的发生了。 */
function repairedBytes(): Buffer {
  return Buffer.concat([Buffer.from('WEQ-REPAIRED\n'), originalBytes()]);
}

/** 假 checkpoint 写进主文件的标记（真实现下是 WAL 里的帧）。 */
const MERGED_MARKER = Buffer.from('MERGED-FROM-WAL\n');

interface HarnessOptions {
  /** `null` = 账号配置里没有密钥；`undefined` = 用默认可用配置。 */
  credentials?: { dbKey: string; algos: Record<string, DatabaseAlgorithms> } | null;
  /** 账号完全解析不出来（没有账号配置 / 目录不存在）。 */
  unknownAccount?: boolean;
  /** 依次返回的锁探测结果；用完之后一直返回最后一项（默认"没锁"）。 */
  probes?: DbRepairLockProbe[];
  /** 覆盖假 native 的修复行为。 */
  recover?: (
    options: DbRepairRecoverOptions,
    onProgress: (progress: DbRepairProgress) => void,
  ) => Promise<DbRepairRecoverReport>;
  /** 覆盖替换后的复核。 */
  verify?: DbRepairDeps['verify'];
  /** 覆盖 WAL 合并（默认成功；可以改成抛错或报 `merged: false` 来验"合并不成"的分支）。 */
  checkpoint?: (dbPath: string) => Promise<DbRepairWalCheckpoint>;
  /** 报告里写死一个版本号，避免测试依赖宿主。 */
  appVersion?: string;
}

function makeReport(overrides: Partial<DbRepairRecoverReport> = {}): DbRepairRecoverReport {
  return {
    durationMs: 5000,
    sourceBytes: 64 * 1024,
    outputBytes: 64 * 1024 + 13,
    headerOffset: 1024,
    pageSize: 4096,
    sourcePages: 16,
    outputPages: 18,
    badPages: [7871],
    zeroPages: [],
    strictPages: false,
    scannedCells: 1234,
    phases: [
      { phase: 'Repair', ms: 4000 },
      { phase: 'Verify', ms: 120 },
    ],
    verification: {
      healthy: true,
      corruptedTables: [],
      badPages: [],
      tables: 33,
      indexes: 66,
      ms: 120,
    },
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const root = tmpDir('svc');
  const dbDir = join(root, 'nt_db');
  const cacheRoot = join(root, 'cache');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'nt_msg.db');
  writeFileSync(dbPath, originalBytes());

  const calls = { recover: 0, released: 0, verify: 0, probe: 0, checkpoint: 0 };
  const progress: DbRepairProgress[] = [];
  const recoverArgs: DbRepairRecoverOptions[] = [];
  let clockMs = Date.parse('2026-09-20T05:30:12.000Z');

  const probes = options.probes ?? [{ success: true, holders: [] }];

  const defaultRecover = async (
    recoverOptions: DbRepairRecoverOptions,
    onProgress: (item: DbRepairProgress) => void,
  ): Promise<DbRepairRecoverReport> => {
    writeFileSync(recoverOptions.outPath, repairedBytes());
    onProgress({ phase: 'Scan', percent: 3, message: '扫描坏页…' });
    onProgress({ phase: 'Repair', percent: 50, message: '正在恢复…' });
    onProgress({ phase: 'Verify', percent: 100, message: '完成' });
    return makeReport({ strictPages: recoverOptions.strictPages ?? false });
  };

  const deps: DbRepairDeps = {
    cacheDir: (...segments) => join(cacheRoot, ...segments),
    resolveAccount: () => {
      if (options.unknownAccount) return null;
      if (options.credentials === null) {
        return { dataDir: null, dbDir, dbKey: '', algos: {} };
      }
      return {
        dataDir: null,
        dbDir,
        dbKey: options.credentials?.dbKey ?? 'test-key',
        algos: options.credentials?.algos ?? { 'nt_msg.db': ALGO },
      };
    },
    recover: async (recoverOptions, onProgress) => {
      calls.recover += 1;
      recoverArgs.push(recoverOptions);
      const impl = options.recover ?? defaultRecover;
      return impl(recoverOptions, onProgress);
    },
    probeLock: (): DbRepairLockProbe => {
      const probe = probes[Math.min(calls.probe, probes.length - 1)]!;
      calls.probe += 1;
      return probe;
    },
    // 真实现是 `PRAGMA wal_checkpoint(TRUNCATE)`。这里用可观察的等价物：把一段标记
    // 追加进主文件（代表"帧写回了主文件"）并把 `-wal` 截成 0，好让"合并发生在备份之前"
    // 这件事能被断言。
    checkpointWal: async (path) => {
      calls.checkpoint += 1;
      if (options.checkpoint) return options.checkpoint(path);
      appendFileSync(path, MERGED_MARKER);
      if (existsSync(`${path}-wal`)) writeFileSync(`${path}-wal`, '');
      return { busy: 0, log: 0, checkpointed: 0, walBytes: 0, merged: true };
    },
    qqPid: () => null,
    releaseHandles: () => {
      calls.released += 1;
    },
    verify:
      options.verify ??
      (async () => {
        calls.verify += 1;
        return { healthy: true, corruptedTables: [] };
      }),
    appVersion: () => options.appVersion ?? '0.0.0-test',
    now: () => new Date(clockMs),
  };

  const service = new DbRepairService(deps);

  return {
    service,
    dbDir,
    dbPath,
    cacheRoot,
    calls,
    progress,
    recoverArgs,
    paths: () => service.paths(REF),
    advanceSeconds: (seconds: number) => {
      clockMs += seconds * 1000;
    },
    appendToSource: (text: string) => appendFileSync(dbPath, text),
  };
}

function collect(progress: DbRepairProgress[]): (progress: DbRepairProgress) => void {
  return (item) => progress.push(item);
}

// ────────────────────────── 成功路径 ──────────────────────────

describe('DbRepairService.repair 成功路径', () => {
  it('备份 → 重建 → 替换 → 自检，记录与报告齐备', async () => {
    const h = createHarness();
    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));

    expect(record.state).toBe('applied');
    expect(record.afterSha).not.toBe(record.beforeSha);
    expect(record.verification?.healthy).toBe(true);
    expect(record.badPages).toEqual([7871]);

    // 源库已经是"重建后"的内容
    expect(readFileSync(h.dbPath)).toEqual(repairedBytes());
    // 临时产物没有留在 QQ 目录里
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);

    // 备份逐字节等于修复前的库，meta 里记着同一份 sha256
    expect(record.backupPath).toBeTruthy();
    expect(readFileSync(record.backupPath!)).toEqual(originalBytes());
    const meta = JSON.parse(
      readFileSync(join(dirname(record.backupPath!), 'meta.json'), 'utf8'),
    ) as {
      sha256: string;
      bytes: number;
    };
    expect(meta.sha256).toBe(record.beforeSha);
    expect(meta.bytes).toBe(record.beforeBytes);

    // 报告写出来了，而且带三条边界
    expect(record.reportPath).toBeTruthy();
    const report = readFileSync(record.reportPath!, 'utf8');
    expect(report).toContain('# WeQ 数据库修复报告');
    expect(report).toContain('这是重建，不是打补丁');
    expect(report).toContain('0.0.0-test');

    // 历史一条
    expect(h.service.listRecords(REF)).toHaveLength(1);

    // 进度单调，且包含 TS 插入的步骤与 native 的阶段
    const percents = h.progress.map((item) => item.percent);
    expect(percents).toEqual([...percents].sort((left, right) => left - right));
    expect(h.progress[0]?.phase).toBe('backup');
    expect(h.progress.map((item) => item.phase)).toEqual(
      expect.arrayContaining(['backup', 'Scan', 'Repair', 'Verify', 'swapping', 'done']),
    );

    // native 拿到的是同目录临时产物 + 缓存里的 workDir
    const args = h.recoverArgs[0]!;
    expect(args.outPath.startsWith(h.dbDir)).toBe(true);
    expect(args.workDir).toBe(h.paths().workDir);
    expect(args.key).toBe('test-key');
  });

  it('backup: false 时不落备份（记录里如实写 null）', async () => {
    const h = createHarness();
    const record = await h.service.repair(
      { uin: REF, dbName: 'nt_msg.db', backup: false },
      collect(h.progress),
    );
    expect(record.state).toBe('applied');
    expect(record.backupPath).toBeNull();
    expect(existsSync(h.paths().backupsDir)).toBe(false);
  });

  it('strictPages 透传给 native 并写进报告', async () => {
    const h = createHarness();
    const record = await h.service.repair(
      { uin: REF, dbName: 'nt_msg.db', strictPages: true },
      collect(h.progress),
    );
    expect(h.recoverArgs[0]?.strictPages).toBe(true);
    expect(record.strictPages).toBe(true);
    expect(readFileSync(record.reportPath!, 'utf8')).toContain('坏页清零，明确丢这些行');
  });
});

// ────────────────────────── 中止与失败 ──────────────────────────

describe('DbRepairService.repair 中止 / 失败', () => {
  it('native 报错：源库不动、记录为失败、按原生信息透传', async () => {
    const h = createHarness({
      recover: async () => {
        throw new Error('recover 失败：errcode=11 database disk image is malformed');
      },
    });
    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'recover-failed' });

    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
    const records = h.service.listRecords(REF);
    expect(records[0]?.state).toBe('apply-failed');
    expect(records[0]?.error).toContain('malformed');
  });

  it('修复期间源库被写入 → 中止，且绝不替换（sha 保险）', async () => {
    const h = createHarness({
      recover: async (recoverOptions, onProgress) => {
        writeFileSync(recoverOptions.outPath, repairedBytes());
        onProgress({ phase: 'Repair', percent: 50, message: '正在恢复…' });
        // 模拟 WeQ 自己的写入路径（助手 ARK 同步 / 搜索索引 / db 编辑器）
        appendFileSync(recoverOptions.dbPath, 'CONCURRENT-WRITE');
        return makeReport();
      },
    });

    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'changed-during-repair' });

    // 替换没发生：源库是"被我们模拟写入后的"内容，而不是修复产物
    expect(readFileSync(h.dbPath)).toEqual(
      Buffer.concat([originalBytes(), Buffer.from('CONCURRENT-WRITE')]),
    );
    // 临时产物已清理
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
    const record = h.service.listRecords(REF)[0]!;
    expect(record.state).toBe('aborted');
    expect(record.error).toContain('修复期间该数据库被改动');
    expect(record.afterSha).toBeNull();
  });

  it('替换前复核发现仍被占用 → 中止（不依赖预检那一次的结果）', async () => {
    const h = createHarness({
      probes: [
        { success: true, holders: [] },
        { success: true, holders: [{ pid: 42, name: 'QQ.exe' }] },
      ],
    });
    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'blocked' });

    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
    expect(h.service.listRecords(REF)[0]?.state).toBe('aborted');
  });

  it('产物自检不过 → 自动还原成修复前（备份就是为了这一刻）', async () => {
    const h = createHarness({
      verify: async () => ({ healthy: false, corruptedTables: ['group_msg_table'] }),
    });
    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'verify-failed' });

    // 库回到修复前
    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
    const record = h.service.listRecords(REF)[0]!;
    expect(record.state).toBe('apply-failed');
    expect(record.error).toContain('自动还原');
    expect(record.verification?.corruptedTables).toContain('group_msg_table');
  });

  it('预检就被锁挡住时不会发起 native 修复', async () => {
    const h = createHarness({
      probes: [{ success: true, holders: [{ pid: 42, name: 'QQ.exe' }] }],
    });
    expect(h.service.preflight(REF, 'nt_msg.db').readiness).toBe('blocked-by-qq');
    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'blocked' });
    expect(h.calls.recover).toBe(0);
    expect(h.service.listRecords(REF)).toHaveLength(0);
  });

  it('同一时刻只允许一个修复任务', async () => {
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const h = createHarness({
      recover: async (recoverOptions) => {
        await gate;
        writeFileSync(recoverOptions.outPath, repairedBytes());
        return makeReport();
      },
    });

    const first = h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));
    expect(h.service.isBusy()).toBe(true);
    await expect(
      h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress)),
    ).rejects.toMatchObject({ code: 'busy' });
    openGate?.();
    expect((await first).state).toBe('applied');
    expect(h.service.isBusy()).toBe(false);
  });
});

// ────────────────────────── 目标解析 ──────────────────────────

describe('DbRepairService.resolveTarget', () => {
  it('挡住路径穿越（dbName 来自渲染层）', () => {
    const h = createHarness();
    for (const dbName of ['../nt_msg.db', '..', '.', 'a/b.db', 'C:\\x.db', '']) {
      expect(() => h.service.resolveTarget(REF, dbName)).toThrowError(DbRepairError);
      expect(() => h.service.resolveTarget(REF, dbName)).toThrowError(/非法的数据库文件名/);
    }
  });

  it('目录名不能被当成库文件（否则会被整体替换掉）', () => {
    const h = createHarness();
    mkdirSync(join(h.dbDir, 'subdir'), { recursive: true });
    expect(() => h.service.resolveTarget(REF, 'subdir')).toThrowError(/不是文件/);
  });

  it('库不存在 → not-found', () => {
    const h = createHarness();
    try {
      h.service.preflight(REF, 'nope.db');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(DbRepairError);
      expect((error as DbRepairError).code).toBe('not-found');
    }
  });

  it('账号没有密钥 → no-credentials', () => {
    const h = createHarness({ credentials: null });
    try {
      h.service.preflight(REF, 'nt_msg.db');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as DbRepairError).code).toBe('no-credentials');
    }
  });

  it('账号完全解析不出来 → not-found，且提示"先打开一次该账号"', () => {
    const h = createHarness({ unknownAccount: true });
    expect(() => h.service.preflight(REF, 'nt_msg.db')).toThrowError(/打开一次该账号/);
  });
});

// ────────────────────────── 回滚 ──────────────────────────

describe('DbRepairService.restore', () => {
  async function repairOnce(h: ReturnType<typeof createHarness>) {
    return h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));
  }

  it('回滚把库还原成修复前的字节，并记下 restoredAt', async () => {
    const h = createHarness();
    const record = await repairOnce(h);
    expect(readFileSync(h.dbPath)).toEqual(repairedBytes());

    const rolled = h.service.restore(REF, record.id);
    expect(rolled.state).toBe('rolled-back');
    expect(rolled.restoredAt).toBeTruthy();
    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
  });

  it('修完之后库又被写过 → 不 force 先拒绝，force 才回滚', async () => {
    const h = createHarness();
    const record = await repairOnce(h);
    h.advanceSeconds(60);
    h.appendToSource('NEW-MESSAGES');

    const preview = h.service.restorePreview(REF, record.id);
    expect(preview.matchesAfter).toBe(false);
    await expect(async () => h.service.restore(REF, record.id)).rejects.toMatchObject({
      code: 'needs-confirm',
    });

    const rolled = h.service.restore(REF, record.id, { force: true });
    expect(rolled.state).toBe('rolled-back');
    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
  });

  it('备份被清理后回滚给出明确原因', async () => {
    const h = createHarness();
    const record = await repairOnce(h);
    expect(h.service.restorePreview(REF, record.id).backupExists).toBe(true);

    h.service.deleteBackup(REF, record.id);
    expect(h.service.restorePreview(REF, record.id).backupExists).toBe(false);
    await expect(async () => h.service.restore(REF, record.id)).rejects.toMatchObject({
      code: 'no-backup',
    });
  });

  it('没有备份的记录不能回滚', async () => {
    const h = createHarness();
    const record = await h.service.repair(
      { uin: REF, dbName: 'nt_msg.db', backup: false },
      collect(h.progress),
    );
    await expect(async () => h.service.restore(REF, record.id)).rejects.toMatchObject({
      code: 'no-backup',
    });
  });
});

// ────────────────────────── 保留策略 ──────────────────────────

// ────────────────────────── 未合并的 WAL ──────────────────────────

/**
 * QQ 的库是 WAL 模式，`-wal` / `-shm` 是常态。这里钉住两件事：
 *   1. 未合并的 WAL 会被**如实记下来**（它的帧不在修复范围内）；
 *   2. 替换 / 回滚时旧的 sidecar 必须清掉 —— 实测把它们留在旁边，新库连
 *      `PRAGMA journal_mode` 都读不了。
 */
describe('未合并的 WAL（sidecar）', () => {
  it('preflight 报出 -wal 的字节数（没有 / 空文件都是 0）', () => {
    const h = createHarness();
    expect(h.service.preflight(REF, 'nt_msg.db').pendingWalBytes).toBe(0);
    writeFileSync(`${h.dbPath}-wal`, '');
    expect(h.service.preflight(REF, 'nt_msg.db').pendingWalBytes).toBe(0);
    writeFileSync(`${h.dbPath}-wal`, Buffer.alloc(16512));
    writeFileSync(`${h.dbPath}-shm`, Buffer.alloc(32768));
    expect(h.service.preflight(REF, 'nt_msg.db').pendingWalBytes).toBe(16512);
  });

  it('修复前先合并 WAL（发生在备份之前），并把字节数记进记录与报告', async () => {
    const h = createHarness();
    writeFileSync(`${h.dbPath}-wal`, Buffer.alloc(16512));
    writeFileSync(`${h.dbPath}-shm`, Buffer.alloc(32768));

    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));

    expect(record.state).toBe('applied');
    expect(record.pendingWalBytes).toBe(16512);
    expect(record.walMerged).toBe(true);
    expect(h.calls.checkpoint).toBe(1);
    // 合并发生在备份之前：备份里已经含了"合并后的主文件"（否则回滚就丢那批改动）
    expect(readFileSync(record.backupPath!)).toEqual(
      Buffer.concat([originalBytes(), MERGED_MARKER]),
    );
    expect(record.beforeSha).not.toBe(undefined);
    // 新库旁边不能留旧库的 sidecar
    expect(existsSync(`${h.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${h.dbPath}-shm`)).toBe(false);
    expect(readdirSync(h.dbDir)).toEqual(['nt_msg.db']);
    // 报告要写明这批改动**已经包含**在修复与备份里
    const report = readFileSync(record.reportPath!, 'utf8');
    expect(report).toContain('未合并的 WAL：**0.02 MB（16512 字节）**');
    expect(report).toContain('合并回主文件');
    expect(report).toContain('包含在本次修复与备份里');
    expect(report).not.toContain('不在本次修复范围内');
  });

  it('合并不成时照旧修复，但记录/报告如实说"这批改动没修进去"', async () => {
    const h = createHarness({
      checkpoint: async () => {
        throw new Error('database is locked');
      },
    });
    writeFileSync(`${h.dbPath}-wal`, Buffer.alloc(16512));

    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));

    expect(record.state).toBe('applied');
    expect(record.walMerged).toBe(false);
    expect(record.pendingWalBytes).toBe(16512);
    // 没合并成功 ⇒ 备份里不含那批改动（确实是丢了，所以要如实警告）
    expect(readFileSync(record.backupPath!)).toEqual(originalBytes());
    expect(existsSync(`${h.dbPath}-wal`)).toBe(false);
    const report = readFileSync(record.reportPath!, 'utf8');
    expect(report).toContain('没能把它合并回主文件');
    expect(report).toContain('不在本次修复范围内');
  });

  it('native 报 busy（没抛错）也算合并不成，同样如实警告', async () => {
    const h = createHarness({
      // 真实现里 TRUNCATE 被别的读事务挡住就是这个样子：SQLite 报 busy=1、checkpointed < log。
      checkpoint: async () => ({
        busy: 1,
        log: 12,
        checkpointed: 0,
        walBytes: 16512,
        merged: false,
      }),
    });
    writeFileSync(`${h.dbPath}-wal`, Buffer.alloc(16512));

    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));

    expect(record.state).toBe('applied');
    expect(record.walMerged).toBe(false);
    expect(h.calls.checkpoint).toBe(1);
    expect(readFileSync(record.reportPath!, 'utf8')).toContain('没能把它合并回主文件');
  });

  it('没有未合并的 WAL 时压根不去动 WAL，记录写 0，报告写"无"', async () => {
    const h = createHarness();
    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));
    expect(record.pendingWalBytes).toBe(0);
    expect(record.walMerged).toBe(false);
    expect(h.calls.checkpoint).toBe(0);
    // 源库没被合并动过 ⇒ 备份就是原件
    expect(readFileSync(record.backupPath!)).toEqual(originalBytes());
    expect(readFileSync(record.reportPath!, 'utf8')).toContain('- 未合并的 WAL：无');
  });

  it('回滚时清掉产物那一代的 sidecar，再把备份装回去', async () => {
    const h = createHarness();
    const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));
    // 修复后 WeQ 又打开过这个库 → 产物旁边留下 sidecar
    writeFileSync(`${h.dbPath}-wal`, Buffer.alloc(8192));
    writeFileSync(`${h.dbPath}-shm`, Buffer.alloc(32768));

    h.service.restore(REF, record.id);

    expect(readFileSync(h.dbPath)).toEqual(originalBytes());
    expect(existsSync(`${h.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${h.dbPath}-shm`)).toBe(false);
  });
});

describe('DbRepairService 保留策略', () => {
  it('连做 5 次修复只留 3 份备份，旧记录仍在但标 purgedAt', async () => {
    const h = createHarness();
    const ids: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      h.advanceSeconds(60);
      const record = await h.service.repair({ uin: REF, dbName: 'nt_msg.db' }, collect(h.progress));
      ids.push(record.id);
    }

    const records = h.service.listRecords(REF);
    expect(records).toHaveLength(5);
    const kept = records.filter((record) => record.purgedAt === undefined);
    expect(kept).toHaveLength(3);
    expect(readdirSync(h.paths().backupsDir)).toHaveLength(3);

    // 最旧的两次被清理，备份文件确实不在了
    const oldest = h.service.history(REF).find(ids[0]!);
    expect(oldest?.purgedAt).toBeTruthy();
    expect(existsSync(oldest!.backupPath!)).toBe(false);
    // 最新的那份还能回滚
    expect(existsSync(records[0]!.backupPath!)).toBe(true);
  });
});
