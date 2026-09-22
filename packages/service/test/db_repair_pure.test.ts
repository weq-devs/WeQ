/**
 * 数据库修复链路的纯逻辑单测：路径布局 / 锁归类 / 记录与保留策略 / 报告文案。
 *
 * 全离线（tmp 目录），不碰 native、不碰真实配置。这里钉住的是几件"错了会很贵"的事：
 * 备份保留策略真的会删旧备份、损坏的 history.json 不会让功能崩掉、锁归类不会把
 * WeQ 自己认成 QQ、报告里必须出现的三条边界一句都不能少。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pendingWalBytes,
  removeSqliteSidecars,
  sqliteSidecarPaths,
} from '../src/account/db_repair/files';
import { DbRepairHistory, DEFAULT_BACKUP_KEEP } from '../src/account/db_repair/history';
import { classifyLock, isQqProcessName, isSelfProcessName } from '../src/account/db_repair/lock';
import {
  dbRepairPaths,
  dbRepairRoot,
  makeStamp,
  productTempPath,
  resolveAccountDbDir,
} from '../src/account/db_repair/paths';
import { renderDbRepairReportMarkdown } from '../src/account/db_repair/report';
import type { DbRepairRecord } from '../src/account/db_repair/types';

const tmpRoots: string[] = [];

function tmpDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `weq-db-repair-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

function makeRecord(overrides: Partial<DbRepairRecord> = {}): DbRepairRecord {
  const at = overrides.at ?? '2026-09-20T05:30:12.000Z';
  return {
    id: overrides.id ?? `${at}-nt_msg.db`,
    at,
    uin: '1707889225',
    dataDir: null,
    dbName: 'nt_msg.db',
    dbPath: '/qq/nt_db/nt_msg.db',
    state: 'applied',
    backupPath: null,
    backupBytes: null,
    beforeSha: 'a'.repeat(64),
    beforeBytes: 1024,
    afterSha: 'b'.repeat(64),
    afterBytes: 2048,
    badPages: [],
    zeroPages: [],
    pageSize: 4096,
    headerOffset: 1024,
    strictPages: false,
    sourcePages: 10,
    outputPages: 12,
    scannedCells: 100,
    phases: [],
    verification: null,
    pendingWalBytes: 0,
    walMerged: false,
    durationMs: 5000,
    reportPath: null,
    ...overrides,
  };
}

// ────────────────────────── 路径 ──────────────────────────

describe('dbRepairRoot / dbRepairPaths', () => {
  it('按 accountConfigId(uin, dataDir) 分目录：同 uin 不同目录互不干扰', () => {
    const cache = (...segments: string[]): string => join('/cache', ...segments);
    const a = dbRepairRoot(cache, '1707889225', '/qq/nt_qq_aaa');
    const b = dbRepairRoot(cache, '1707889225', '/qq/nt_qq_bbb');
    expect(a).toContain('db_repair');
    expect(a).not.toBe(b);
    // 同一个账号 + 同一个目录必须稳定
    expect(dbRepairRoot(cache, '1707889225', '/qq/nt_qq_aaa')).toBe(a);
  });

  it('无 dataDir 时回退到裸 uin（兼容旧配置）', () => {
    const cache = (...segments: string[]): string => join('/cache', ...segments);
    expect(dbRepairRoot(cache, '12345', null)).toBe(join('/cache', 'db_repair', '12345'));
  });

  it('备份 / 报告 / 工作目录都在缓存里，临时产物在库同目录', () => {
    const paths = dbRepairPaths('/cache/db_repair/12345');
    expect(paths.backupFile('20260920-053012', 'nt_msg.db')).toBe(
      join('/cache/db_repair/12345', 'backups', '20260920-053012', 'nt_msg.db'),
    );
    expect(paths.reportFile('20260920-053012')).toBe(
      join('/cache/db_repair/12345', 'reports', 'repair-20260920-053012.md'),
    );
    expect(paths.workDir).toBe(join('/cache/db_repair/12345', 'work'));
    // 临时产物必须与目标库同目录 —— 跨盘 rename 会 EXDEV。
    expect(productTempPath('/qq/nt_db', 'nt_msg.db', 'S')).toBe(
      '/qq/nt_db/.nt_msg.db.weq-repair-S',
    );
  });

  it('makeStamp：本地时间、字典序即时间序', () => {
    const stamp = makeStamp(new Date(2026, 8, 20, 5, 30, 12));
    expect(stamp).toBe('20260920-053012');
    expect(makeStamp(new Date(2026, 8, 20, 5, 30, 13)) > stamp).toBe(true);
  });
});

// ────────────────────────── 锁归类 ──────────────────────────

describe('resolveAccountDbDir', () => {
  /** 只有这些路径"存在"。 */
  const existsIn = (paths: string[]): ((path: string) => boolean) => {
    const set = new Set(paths);
    return (path) => set.has(path);
  };
  const platform = (ntDbDir: string | null, ntMsgDbPath: string | null) => ({
    ntDbDir: () => ntDbDir,
    ntMsgDbPath: () => ntMsgDbPath,
  });

  it('dataDir 直接就是库目录（静态导入的目录）', () => {
    expect(
      resolveAccountDbDir(
        platform('/qq/u_x/nt_db', null),
        '1707889225',
        '/backup/static',
        existsIn(['/backup/static/nt_msg.db']),
      ),
    ).toBe('/backup/static');
  });

  it('dataDir 是含 nt_db 的父目录（在线账号的 nt_qq_<hash>）', () => {
    expect(
      resolveAccountDbDir(
        platform('/qq/u_x/nt_db', null),
        '1707889225',
        '/qq/u_x',
        existsIn(['/qq/u_x/nt_db/nt_msg.db']),
      ),
    ).toBe('/qq/u_x/nt_db');
  });

  it('dataDir 优先于 platform —— 否则会修到另一个账号的库上', () => {
    expect(
      resolveAccountDbDir(
        platform('/qq/other/nt_db', null),
        '1707889225',
        '/imported/mine',
        existsIn(['/imported/mine/nt_msg.db', '/qq/other/nt_db/nt_msg.db']),
      ),
    ).toBe('/imported/mine');
  });

  it('dataDir 里没有库时回退 platform.ntDbDir', () => {
    expect(
      resolveAccountDbDir(platform('/qq/u_x/nt_db', null), '1707889225', '/gone', existsIn([])),
    ).toBe('/qq/u_x/nt_db');
  });

  it('ntDbDir 解析不到时用 ntMsgDbPath 的父目录', () => {
    expect(
      resolveAccountDbDir(
        platform(null, '/qq/u_x/nt_db/nt_msg.db'),
        '1707889225',
        null,
        existsIn([]),
      ),
    ).toBe('/qq/u_x/nt_db');
  });

  it('全都没有、或 ntMsgDbPath 抛错 → null（由上层报"先打开一次该账号"）', () => {
    expect(resolveAccountDbDir(platform(null, null), '1707889225', null, existsIn([]))).toBeNull();
    const throwing = {
      ntDbDir: () => null,
      ntMsgDbPath: () => {
        throw new Error('platform 未就绪');
      },
    };
    expect(resolveAccountDbDir(throwing, '1707889225', null, existsIn([]))).toBeNull();
  });
});

describe('SQLite sidecar（-wal / -shm）', () => {
  it('sidecar 路径就是主文件名加后缀', () => {
    expect(sqliteSidecarPaths('/qq/nt_db/nt_msg.db')).toEqual({
      wal: '/qq/nt_db/nt_msg.db-wal',
      shm: '/qq/nt_db/nt_msg.db-shm',
    });
  });

  it('pendingWalBytes：没有 -wal、空 -wal 都是 0，有帧就是它的字节数', () => {
    const dir = tmpDir('wal');
    const db = join(dir, 'nt_msg.db');
    writeFileSync(db, 'x');
    expect(pendingWalBytes(db)).toBe(0);
    writeFileSync(`${db}-wal`, '');
    expect(pendingWalBytes(db)).toBe(0);
    writeFileSync(`${db}-wal`, Buffer.alloc(16512));
    expect(pendingWalBytes(db)).toBe(16512);
  });

  it('removeSqliteSidecars：两个一起删，且幂等（再删一次不报错、返回空）', () => {
    const dir = tmpDir('sidecar');
    const db = join(dir, 'nt_msg.db');
    writeFileSync(db, 'main');
    writeFileSync(`${db}-wal`, Buffer.alloc(4096));
    writeFileSync(`${db}-shm`, Buffer.alloc(32768));

    expect(removeSqliteSidecars(db).sort()).toEqual([`${db}-shm`, `${db}-wal`]);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
    // 主文件不能被碰
    expect(existsSync(db)).toBe(true);
    expect(removeSqliteSidecars(db)).toEqual([]);
  });
});

describe('isQqProcessName', () => {
  it.each([
    ['QQ.exe', true],
    ['qq', true],
    ['QQProtect.exe', true],
    ['QQExternal', true],
    ['qqnt.exe', true],
  ])('%s → QQ', (name, expected) => {
    expect(isQqProcessName(name)).toBe(expected);
  });

  it.each([
    ['WeQ.exe', false],
    ['weq', false],
    ['electron.exe', false],
    ['', false],
    ['crashpad_handler.exe', false],
  ])('%s → 不是 QQ', (name, expected) => {
    expect(isQqProcessName(name)).toBe(expected);
  });
});

describe('isSelfProcessName', () => {
  it.each([
    ['WeQ.exe', true],
    ['weq', true],
    ['electron.exe', true],
    ['', false],
    ['QQ.exe', false],
    ['crashpad_handler.exe', false],
  ])('%s → %s', (name, expected) => {
    expect(isSelfProcessName(name)).toBe(expected);
  });
});

describe('classifyLock', () => {
  it('没有探测能力 → unknown-lock（不阻断，替换前会再查）', () => {
    const result = classifyLock(null);
    expect(result.readiness).toBe('unknown-lock');
    expect(result.holders).toEqual([]);
  });

  it('探测失败 → unknown-lock，不是 ready', () => {
    const result = classifyLock({ success: false, holders: [] });
    expect(result.readiness).toBe('unknown-lock');
  });

  it('没有持有者 → ready', () => {
    expect(classifyLock({ success: true, holders: [] }).readiness).toBe('ready');
  });

  it('QQ 持有 → blocked-by-qq，并把 pid 给界面', () => {
    const result = classifyLock({
      success: true,
      holders: [{ pid: 42, name: 'QQ.exe' }],
    });
    expect(result.readiness).toBe('blocked-by-qq');
    expect(result.qqHolders).toEqual([{ pid: 42, name: 'QQ.exe' }]);
    expect(result.selfHolders).toEqual([]);
    expect(result.otherHolders).toEqual([]);
  });

  // 这条是 v1.1.2 修的 bug：Windows 的 Restart Manager 枚举的是"谁打开着文件"，只要
  // 界面开着这个账号，WeQ 就一定在列表里。旧实现把它归成 blocked-by-other 并拒绝开修，
  // 于是给出"请先关闭该账号"——而面板只能在账号打开时进入，等于死路。
  it('WeQ 自己持有 → self-hold（不阻断，替换时会自动释放）', () => {
    const result = classifyLock({
      success: true,
      holders: [{ pid: 7, name: 'WeQ.exe' }],
    });
    expect(result.readiness).toBe('self-hold');
    expect(result.selfHolders).toEqual([{ pid: 7, name: 'WeQ.exe' }]);
    expect(result.otherHolders).toEqual([]);
  });

  it('第三方进程持有 → blocked-by-other（才是真需要用户动手的）', () => {
    const result = classifyLock({
      success: true,
      holders: [{ pid: 8, name: 'sqlitebrowser.exe' }],
    });
    expect(result.readiness).toBe('blocked-by-other');
    expect(result.otherHolders).toHaveLength(1);
    expect(result.selfHolders).toEqual([]);
  });

  it('WeQ 与第三方同时持有 → 按第三方报（WeQ 自己那份不算数）', () => {
    const result = classifyLock({
      success: true,
      holders: [
        { pid: 7, name: 'WeQ.exe' },
        { pid: 8, name: 'sqlitebrowser.exe' },
      ],
    });
    expect(result.readiness).toBe('blocked-by-other');
    expect(result.selfHolders).toHaveLength(1);
    expect(result.otherHolders).toEqual([{ pid: 8, name: 'sqlitebrowser.exe' }]);
  });

  it('名字拿不到时归到"其它"，不猜成 QQ', () => {
    const result = classifyLock({ success: true, holders: [{ pid: 9, name: '' }] });
    expect(result.readiness).toBe('blocked-by-other');
  });

  it('qqPid 命中时名称为空也算 QQ（resolveQqPid 是权威归属）', () => {
    const result = classifyLock({ success: true, holders: [{ pid: 99, name: '' }] }, 99);
    expect(result.readiness).toBe('blocked-by-qq');
  });

  it('selfPid 命中时名称为空也算自己（不依赖名字）', () => {
    const result = classifyLock({ success: true, holders: [{ pid: 7, name: '' }] }, null, 7);
    expect(result.readiness).toBe('self-hold');
    expect(result.selfHolders).toEqual([{ pid: 7, name: '' }]);
  });

  it('qqPid 与 selfPid 同时命中 → QQ 优先（两个进程不可能同 pid，但归属要确定）', () => {
    const result = classifyLock({ success: true, holders: [{ pid: 42, name: 'QQ.exe' }] }, 42, 42);
    expect(result.readiness).toBe('blocked-by-qq');
  });

  it('QQ 与 WeQ 同时持有 → 按 QQ 报（先结束 QQ，WeQ 那份会自动释放）', () => {
    const result = classifyLock({
      success: true,
      holders: [
        { pid: 42, name: 'QQ.exe' },
        { pid: 7, name: 'WeQ.exe' },
      ],
    });
    expect(result.readiness).toBe('blocked-by-qq');
    expect(result.qqHolders).toHaveLength(1);
    expect(result.selfHolders).toHaveLength(1);
    expect(result.otherHolders).toHaveLength(0);
  });
});

// ────────────────────────── 历史与保留策略 ──────────────────────────

describe('DbRepairHistory', () => {
  it('add / list 最新在前 / find', () => {
    const paths = dbRepairPaths(tmpDir('history'));
    const history = new DbRepairHistory(paths);
    history.add(makeRecord({ id: 'old', at: '2026-09-20T01:00:00.000Z' }));
    history.add(makeRecord({ id: 'new', at: '2026-09-20T02:00:00.000Z' }));
    expect(history.list().map((record) => record.id)).toEqual(['new', 'old']);
    expect(history.find('old')?.id).toBe('old');
    expect(history.update('old', { state: 'rolled-back' })?.state).toBe('rolled-back');
  });

  it('损坏的 history.json → 回落空历史（读盘永不抛）', () => {
    const root = tmpDir('history-broken');
    const paths = dbRepairPaths(root);
    writeFileSync(paths.history, '{not json');
    expect(new DbRepairHistory(paths).list()).toEqual([]);
  });

  it('结构不符的记录被丢掉，合法的留下', () => {
    const root = tmpDir('history-shape');
    const paths = dbRepairPaths(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      paths.history,
      JSON.stringify({ version: 1, records: [makeRecord({ id: 'ok' }), { id: 'bad' }] }),
    );
    expect(new DbRepairHistory(paths).list().map((record) => record.id)).toEqual(['ok']);
  });

  it('保留策略：只留最近 N 份备份，其余删目录并标 purgedAt（记录留着）', () => {
    const root = tmpDir('history-prune');
    const paths = dbRepairPaths(root);
    const history = new DbRepairHistory(paths);
    for (const [index, day] of ['01', '02', '03', '04'].entries()) {
      const stamp = `2026092${day}-000000`;
      const dir = paths.backupDir(stamp);
      mkdirSync(dir, { recursive: true });
      writeFileSync(paths.backupFile(stamp, 'nt_msg.db'), 'x');
      history.add(
        makeRecord({
          id: `r${index}`,
          at: `2026-09-${day}T00:00:00.000Z`,
          backupPath: paths.backupFile(stamp, 'nt_msg.db'),
          backupBytes: 1,
        }),
      );
    }
    const purged = history.pruneBackups(3);
    expect(purged).toEqual(['r0']);
    // readdir 的顺序不保证（取决于文件系统），排序后再比
    expect(readdirSync(paths.backupsDir).sort()).toEqual([
      '202609202-000000',
      '202609203-000000',
      '202609204-000000',
    ]);
    expect(history.find('r0')?.purgedAt).toBeTruthy();
    expect(history.find('r0')).toBeTruthy(); // 记录本身留着
    expect(history.backupExists(history.find('r1')!)).toBe(true);
  });

  it('默认保留份数是 3；keep=0 时不报错地清空', () => {
    expect(DEFAULT_BACKUP_KEEP).toBe(3);
    const root = tmpDir('history-keep0');
    const paths = dbRepairPaths(root);
    const history = new DbRepairHistory(paths);
    const stamp = '20260920-000000';
    mkdirSync(paths.backupDir(stamp), { recursive: true });
    writeFileSync(paths.backupFile(stamp, 'nt_msg.db'), 'x');
    history.add(
      makeRecord({
        backupPath: paths.backupFile(stamp, 'nt_msg.db'),
        at: '2026-09-20T00:00:00.000Z',
      }),
    );
    expect(history.pruneBackups(0)).toHaveLength(1);
  });

  it('没有备份的记录不参与保留策略（不会被动）', () => {
    const root = tmpDir('history-nobackup');
    const history = new DbRepairHistory(dbRepairPaths(root));
    history.add(makeRecord({ id: 'nobak', backupPath: null }));
    expect(history.pruneBackups(0)).toEqual([]);
    expect(history.find('nobak')?.purgedAt).toBeUndefined();
  });
});

// ────────────────────────── 报告 ──────────────────────────

describe('renderDbRepairReportMarkdown', () => {
  const record = makeRecord({
    state: 'applied',
    badPages: [7871, 8072],
    phases: [
      { phase: 'Repair', ms: 3448 },
      { phase: 'Verify', ms: 839 },
    ],
    verification: {
      healthy: true,
      corruptedTables: [],
      badPages: [],
      tables: 33,
      indexes: 66,
      ms: 839,
    },
    reportPath: '/cache/reports/repair-x.md',
  });
  const markdown = renderDbRepairReportMarkdown(record, { appVersion: '9.9.9' });

  it('头部把账号/库/路径/版本说清', () => {
    expect(markdown).toContain('# WeQ 数据库修复报告');
    expect(markdown).toContain('1707889225');
    expect(markdown).toContain('nt_msg.db');
    expect(markdown).toContain('9.9.9');
    expect(markdown).toContain('已修复并替换');
  });

  it('坏页与阶段耗时如实落纸', () => {
    expect(markdown).toContain('7871, 8072');
    expect(markdown).toContain('| Repair | 3.45 s |');
    expect(markdown).toContain('33 / 66');
  });

  it('三条边界一句都不能少（重建 / 未校验 / 会丢 cell）', () => {
    expect(markdown).toContain('这是重建，不是打补丁');
    expect(markdown).toContain('坏页上的内容无法校验');
    expect(markdown).toContain('读不出来的 cell 会丢');
  });

  it('严格模式写的是"明确丢这些行"，宽容模式写的是"恢复率最高"', () => {
    const strict = renderDbRepairReportMarkdown(makeRecord({ strictPages: true }));
    expect(strict).toContain('坏页清零，明确丢这些行');
    expect(markdown).toContain('恢复率最高');
  });

  it('中止 / 失败 / 已回滚各有自己的状态文案，并带上原因', () => {
    expect(
      renderDbRepairReportMarkdown(makeRecord({ state: 'aborted', error: '被改动' })),
    ).toContain('已中止（源库未被改动）');
    expect(
      renderDbRepairReportMarkdown(makeRecord({ state: 'apply-failed', error: 'native 报错' })),
    ).toContain('native 报错');
    expect(renderDbRepairReportMarkdown(makeRecord({ state: 'rolled-back' }))).toContain(
      '已回滚到修复前',
    );
  });

  it('没有备份 / 备份被清理 / 已回滚时都能说清"还能不能后悔"', () => {
    expect(renderDbRepairReportMarkdown(makeRecord({ backupPath: null }))).toContain(
      '本次没有做备份',
    );
    const purged = renderDbRepairReportMarkdown(
      makeRecord({
        backupPath: '/cache/backups/x/nt_msg.db',
        purgedAt: '2026-09-21T00:00:00.000Z',
      }),
    );
    expect(purged).toContain('已被保留策略清理');
    expect(purged).toContain('不可回滚');
    const restored = renderDbRepairReportMarkdown(
      makeRecord({ state: 'rolled-back', restoredAt: '2026-09-21T00:00:00.000Z' }),
    );
    expect(restored).toContain('已回滚时间');
  });

  it('合并成功：报告写"已包含在修复与备份里"，不出现警告', () => {
    const md = renderDbRepairReportMarkdown(
      makeRecord({ pendingWalBytes: 16512, walMerged: true }),
    );
    expect(md).toContain('未合并的 WAL：**0.02 MB（16512 字节）**');
    expect(md).toContain('合并回主文件');
    expect(md).toContain('包含在本次修复与备份里');
    expect(md).not.toContain('⚠');
    expect(md).not.toContain('不在本次修复范围内');
  });

  it('合并不成：报告说清"这批改动没修进去"', () => {
    const md = renderDbRepairReportMarkdown(
      makeRecord({ pendingWalBytes: 16512, walMerged: false }),
    );
    expect(md).toContain('未合并的 WAL：**0.02 MB（16512 字节）**');
    expect(md).toContain('页级读取，只看得见主文件');
    expect(md).toContain('不在本次修复范围内');
    expect(md).toContain('已被清理');
  });

  it('没有未合并的 WAL 时写"无"，不出现警告', () => {
    const md = renderDbRepairReportMarkdown(makeRecord());
    expect(md).toContain('- 未合并的 WAL：无');
    expect(md).not.toContain('⚠');
  });

  it('没走到替换那一步时自检段落明说"没有结果"', () => {
    expect(
      renderDbRepairReportMarkdown(makeRecord({ verification: null, state: 'aborted' })),
    ).toContain('没有自检结果');
  });
});
