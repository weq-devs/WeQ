/**
 * 日志过期清理（设置 → 日志 → 日志保留时长）单测。
 *
 * 这段逻辑会**真的删用户的文件**，所以边界必须钉死：
 *
 *   1. 保留窗口是「最近 N 天（含今天）」—— 第 N 天前一天的还在，第 N 天前的就删；
 *   2. 今天的日志永远不删（正在写入的那个文件，retentionDays = 1 时也不能碰）；
 *   3. 0 / 负数 = 永久保留，一个都不删；
 *   4. 文件名里的日期是首要依据，没带日期的退回修改时间；
 *   5. 非 `.log` 文件、目录一律不碰（清理越界比不清理严重得多）。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planExpiredLogs, pruneExpiredLogs, type LogFileCandidate } from '../src/common/logger';

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-log-prune-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

/** 本地时区的「2026-09-20 10:00」，避免测试跟着机器时区漂。 */
const NOW = new Date(2026, 8, 20, 10, 0, 0);
const NOW_MS = NOW.getTime();

function file(name: string, daysAgo: number): LogFileCandidate {
  return { name, mtimeMs: NOW_MS - daysAgo * 24 * 60 * 60 * 1000 };
}

describe('planExpiredLogs', () => {
  it('保留最近 7 天（含今天），更早的删掉', () => {
    const files = [
      file('2026-09-20.log', 0), // 今天 → 留
      file('2026-09-14.log', 6), // 第 7 天 → 留（窗口边界）
      file('2026-09-13.log', 7), // 第 8 天 → 删（窗口外）
      file('2026-09-01.log', 19), // 更早 → 删
    ];
    expect(planExpiredLogs(files, 7, NOW)).toEqual(['2026-09-13.log', '2026-09-01.log']);
  });

  it('原生工具的日志文件名（带前缀）也认', () => {
    const files = [file('nt_helper_2026-09-20.log', 0), file('native_loader_2026-09-13.log', 7)];
    expect(planExpiredLogs(files, 7, NOW)).toEqual(['native_loader_2026-09-13.log']);
  });

  it('retentionDays = 1 时只留今天，正在写的日志不会被删', () => {
    expect(planExpiredLogs([file('2026-09-20.log', 0), file('2026-09-19.log', 1)], 1, NOW)).toEqual(
      ['2026-09-19.log'],
    );
    expect(planExpiredLogs([file('2026-09-20.log', 0)], 1, NOW)).toEqual([]);
  });

  it('0 / 负数 / NaN = 永久保留，一个都不删', () => {
    const files = [file('2020-01-01.log', 2000), file('other.log', 2000)];
    expect(planExpiredLogs(files, 0, NOW)).toEqual([]);
    expect(planExpiredLogs(files, -3, NOW)).toEqual([]);
    expect(planExpiredLogs(files, Number.NaN, NOW)).toEqual([]);
  });

  it('文件名没带日期 → 退回修改时间判断', () => {
    expect(planExpiredLogs([file('weq.log', 30)], 7, NOW)).toEqual(['weq.log']);
    expect(planExpiredLogs([file('weq.log', 1)], 7, NOW)).toEqual([]);
  });

  it('文件名里像日期但明显非法的（月份 13）当作没有日期，用修改时间', () => {
    expect(planExpiredLogs([file('2026-13-40.log', 1)], 7, NOW)).toEqual([]);
    expect(planExpiredLogs([file('2026-13-40.log', 30)], 7, NOW)).toEqual(['2026-13-40.log']);
  });

  it('跨月 / 跨年的窗口计算正确', () => {
    const newYear = new Date(2027, 0, 2, 9, 0, 0); // 2027-01-02
    expect(planExpiredLogs([{ name: '2026-12-27.log', mtimeMs: 0 }], 7, newYear)).toEqual([]);
    expect(planExpiredLogs([{ name: '2026-12-26.log', mtimeMs: 0 }], 7, newYear)).toEqual([
      '2026-12-26.log',
    ]);
  });
});

describe('pruneExpiredLogs（真实目录）', () => {
  it('删掉过期日志，保留窗口内的、非 .log 文件与子目录', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '2026-09-20.log'), 'today', 'utf-8');
    writeFileSync(join(dir, '2026-09-14.log'), 'in window', 'utf-8');
    writeFileSync(join(dir, '2026-09-01.log'), 'expired', 'utf-8');
    writeFileSync(join(dir, 'notes.txt'), 'keep me', 'utf-8');
    mkdirSync(join(dir, 'archive.log'), { recursive: true }); // 名字像日志的目录也不碰
    // 文件名里的日期才是依据，mtime 故意设成很旧，验证不会被误删。
    const old = new Date(NOW_MS - 300 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '2026-09-20.log'), old, old);

    expect(pruneExpiredLogs(dir, 7, NOW)).toEqual(['2026-09-01.log']);
    expect(readdirSync(dir).sort()).toEqual([
      '2026-09-14.log',
      '2026-09-20.log',
      'archive.log',
      'notes.txt',
    ]);
  });

  it('目录不存在时静默返回空（清理绝不抛错）', () => {
    expect(pruneExpiredLogs(join(tmpdir(), `weq-missing-${Date.now()}`), 7, NOW)).toEqual([]);
  });

  it('0 = 永久保留时连目录都不动', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '2020-01-01.log'), 'old', 'utf-8');
    expect(pruneExpiredLogs(dir, 0, NOW)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['2020-01-01.log']);
  });
});
