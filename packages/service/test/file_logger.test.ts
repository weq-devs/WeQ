import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { LogFileWriter } from '../src/common/log_file_writer';
import {
  archiveLogFile,
  readLogFileChunk,
  readLogFileInfo,
  scanLogFiles,
  utcLogDay,
} from '../src/common/log_files';
import { flushFileLogger, initLogger } from '../src/common/logger';
import { RequestLogBatch } from '../src/common/request_log_batch';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-file-log-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await flushFileLogger();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('按大小和日期封段，保留活动明文，归档路径仍可按原偏移读取', async () => {
  const dir = tmp();
  const yesterday = utcLogDay(new Date(Date.now() - 86_400_000));
  const today = utcLogDay();
  const writer = new LogFileWriter(dir, 18);
  writer.record('yesterday\n', yesterday, false);
  writer.record('first\nsecond\n', today, false);
  writer.record('third\n', today, false);
  await writer.flush();
  await writer.waitForArchives();
  const files = scanLogFiles(dir);
  const archives = files.filter((entry) => entry.archived);
  const active = files.find((entry) => !entry.archived)!;
  expect(files).toHaveLength(3);
  expect(files.every((entry) => entry.kind === 'weq')).toBe(true);
  expect(active.path).toBe(writer.activePath);
  expect(readFileSync(active.path, 'utf8')).toBe('third\n');
  const sameDay = archives.find((entry) => entry.name.startsWith(today))!;
  expect(existsSync(sameDay.path)).toBe(false);
  expect(gunzipSync(readFileSync(`${sameDay.path}.gz`)).toString()).toBe('first\nsecond\n');
  expect(await readLogFileInfo(sameDay.path)).toMatchObject({ size: 13 });
  expect(await readLogFileChunk(sameDay.path, -7, 7)).toEqual({
    text: 'second\n',
    nextOffset: 13,
    eof: true,
    size: 13,
  });
  expect(await readLogFileChunk(sameDay.path, 0, 6)).toMatchObject({
    text: 'first\n',
    nextOffset: 6,
    eof: false,
  });
});

it('归档冲突不覆盖也不删明文，旧版多段 gzip 直接回读', async () => {
  const dir = tmp();
  const file = join(dir, '2026-09-10.log');
  const archive = `${file}.gz`;
  const previous = Buffer.concat([gzipSync('first\n'), gzipSync('second\n')]);
  writeFileSync(file, 'original\n');
  writeFileSync(archive, previous);
  await archiveLogFile(file);
  expect(readFileSync(file, 'utf8')).toBe('original\n');
  expect(readFileSync(archive)).toEqual(previous);
  expect(readdirSync(dir).sort()).toEqual(['2026-09-10.log', '2026-09-10.log.gz']);
  rmSync(file);
  expect(await readLogFileChunk(file, -7, 7)).toMatchObject({ text: 'second\n', size: 13 });
});

it('启动归档旧整日明文，不碰当天旧版日志或仍在写入的进程分段', async () => {
  const dir = tmp();
  const today = utcLogDay();
  const yesterday = utcLogDay(new Date(Date.now() - 86_400_000));
  const legacy = join(dir, `${yesterday}.log`);
  const legacyToday = join(dir, `${today}.log`);
  const live = join(dir, `${yesterday}.${process.pid}.123456abcdef.0001.log`);
  for (const path of [legacy, legacyToday, live]) writeFileSync(path, 'keep\n');
  const writer = new LogFileWriter(dir);
  writer.archiveHistorical();
  await writer.waitForArchives();
  expect(existsSync(`${legacy}.gz`)).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(legacyToday)).toBe(true);
  expect(existsSync(live)).toBe(true);
});

it('只有高频快速成功合并，低频明细、慢成功和失败都落盘', async () => {
  vi.stubEnv('WEQ_LOG_REQUEST_DETAILS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T08:02:01Z'));
  const dir = tmp();
  const logger = initLogger(dir).child({ scope: 'mcp-server' });
  const success = { event: 'request-complete', type: 'tool', outcome: 'ok' };
  for (let i = 0; i < 10; i++) {
    logger.debug('success', { ...success, path: 'busy', durationMs: i });
    if (i < 9) logger.debug('success', { ...success, path: 'occasional', durationMs: i });
  }
  vi.setSystemTime(new Date('2026-09-20T08:02:20Z'));
  logger.debug('slow tool', { ...success, path: 'busy', durationMs: 2000 });
  logger.debug('failed', { event: 'request-failed', path: 'busy', outcome: 'failed' });
  logger.warn('slow warning', { event: 'request-slow', durationMs: 3000 });
  await flushFileLogger();
  const [file] = scanLogFiles(join(dir, 'logs'));
  const rows = readFileSync(file!.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.context.path === 'occasional')).toHaveLength(9);
  const busy = rows.filter((row) => row.context.path === 'busy');
  expect(busy.map((row) => row.message)).toEqual([
    'success',
    'slow tool',
    'failed',
    '请求完成汇总',
  ]);
  expect(busy.at(-1)?.context).toMatchObject({
    count: 10,
    minMs: 0,
    avgMs: 4.5,
    maxMs: 9,
    windowMs: 20_000,
  });
  expect(rows.some((row) => row.message === 'slow warning' && row.level === 'warn')).toBe(true);
});

it('排障开关保留高频请求逐条明细', async () => {
  vi.stubEnv('WEQ_LOG_REQUEST_DETAILS', '1');
  const dir = tmp();
  const logger = initLogger(dir).child({ scope: 'trpc' });
  for (let i = 0; i < 12; i++)
    logger.debug('each request', {
      event: 'request-complete',
      type: 'query',
      outcome: 'ok',
      path: 'busy',
      durationMs: 1,
    });
  await flushFileLogger();
  const [file] = scanLogFiles(join(dir, 'logs'));
  expect(readFileSync(file!.path, 'utf8').match(/each request/g)).toHaveLength(12);
});

it('分钟结束自动结算，下一分钟不会继承上一个窗口的计数', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T08:02:59.500Z'));
  const summary = vi.fn();
  const detail = vi.fn();
  const batch = new RequestLogBatch(summary);
  const request = { scope: 'trpc', type: 'query', path: 'busy', durationMs: 4 };
  for (let i = 0; i < 10; i++) batch.record(request, detail, Date.now());
  expect(detail).toHaveBeenCalledOnce();
  expect(summary).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(summary).toHaveBeenCalledWith(expect.objectContaining({ count: 10, windowMs: 60_000 }));
  batch.record(request, detail, Date.now());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(detail).toHaveBeenCalledTimes(2);
  expect(summary).toHaveBeenCalledOnce();
});
