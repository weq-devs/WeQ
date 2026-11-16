import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createConsoleLogger, projectConsoleContext } from '../src/common/console_logger';
import { configureConsoleLogger, getLogger, initLogger } from '../src/common/logger';

const disposals: Array<() => void> = [];
function fixture(env: NodeJS.ProcessEnv = {}, development = true) {
  const lines: string[] = [];
  let time = Date.UTC(2026, 0, 1, 16, 0, 0, 123);
  const logger = createConsoleLogger({
    development,
    processName: 'test',
    env,
    now: () => time,
    sink: (line) => {
      lines.push(line);
    },
    color: true,
  });
  disposals.push(logger.dispose);
  return {
    logger,
    lines,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
afterEach(() => {
  disposals.splice(0).forEach((dispose) => {
    dispose();
  });
  vi.useRealTimers();
});
describe('开发终端', () => {
  it('开发默认 info，正式关闭，支持显式打开和关闭', () => {
    const dev = fixture();
    dev.logger.write('debug', 'hidden');
    dev.logger.write('info', 'ready');
    expect(dev.lines).toHaveLength(1);
    const prod = fixture({}, false);
    prod.logger.write('error', 'hidden');
    expect(prod.lines).toEqual([]);
    const on = fixture({ WEQ_LOG_CONSOLE: '1' }, false);
    on.logger.write('info', 'ready');
    expect(on.lines).toHaveLength(1);
    const off = fixture({ WEQ_LOG_CONSOLE: '0' });
    off.logger.write('error', 'hidden');
    expect(off.lines).toEqual([]);
  });
  it('级别与精确模块过滤独立，警告不被模块过滤', () => {
    const f = fixture({ WEQ_LOG_LEVEL: 'debug', WEQ_LOG_SCOPES: 'media, db' });
    f.logger.write('debug', 'yes', { scope: 'media' });
    f.logger.write('info', 'no', { scope: 'media-other' });
    f.logger.write('warn', 'warn', { scope: 'other' });
    expect(f.lines).toHaveLength(2);
    const onlyErrors = fixture({ WEQ_LOG_LEVEL: 'error' });
    onlyErrors.logger.write('warn', 'no');
    expect(onlyErrors.lines).toEqual([]);
  });
  it('非法模块配置回落不过滤，默认 INFO 仅选定模块，DEBUG 可查看其他模块', () => {
    const invalid = fixture({ WEQ_LOG_SCOPES: 'trpc,*' });
    invalid.logger.write('info', 'visible', { scope: 'other' });
    expect(invalid.lines).toHaveLength(2);
    const lines: string[] = [];
    const logger = createConsoleLogger({
      development: true,
      processName: 'test',
      env: {},
      infoScopes: new Set(['startup']),
      sink: (line) => {
        lines.push(line);
      },
    });
    logger.write('info', 'noise', { scope: 'decoration' });
    logger.write('info', 'ready', { scope: 'startup' });
    logger.dispose();
    expect(lines).toHaveLength(1);
  });
  it('北京时间短时间，NO_COLOR 和非 TTY 无转义，非法设置只提示一次', () => {
    const f = fixture({ NO_COLOR: '', WEQ_LOG_LEVEL: 'trace', WEQ_LOG_CONSOLE: 'invalid' });
    f.logger.write('info', 'ready');
    f.logger.write('info', 'ready');
    expect(f.lines[1]).toContain('00:00:00 INFO');
    expect(f.lines[1]).not.toContain('+08:00');
    expect(f.lines[1]).not.toContain('[test:');
    expect(f.lines.join('')).not.toContain('\x1b[');
    expect(f.lines.filter((line) => line.includes('配置'))).toHaveLength(1);
    const sink = vi.fn();
    const redirected = createConsoleLogger({
      development: true,
      processName: 'test',
      env: {},
      sink,
      color: false,
    });
    redirected.write('info', 'redirected');
    redirected.dispose();
    expect(sink.mock.calls[0]![0]).not.toContain('\x1b[');
  });
  it('开发启动管道继承原终端颜色，NO_COLOR 仍优先', () => {
    for (const noColor of [false, true]) {
      const sink = vi.fn();
      const logger = createConsoleLogger({
        development: true,
        processName: 'test',
        env: { WEQ_DEV_STDERR_TTY: '1', ...(noColor ? { NO_COLOR: '' } : {}) },
        sink,
      });
      logger.write('info', 'ready');
      expect(sink.mock.calls[0]![0].includes('\x1b[')).toBe(!noColor);
      logger.dispose();
    }
  });
  it('脱敏递归投影、截断集合、堆栈及循环对象，不修改输入', () => {
    const data: Record<string, unknown> = {
      cookie: 'private-cookie',
      nested: { d2key: 'private-key', url: 'https://x.invalid/p?rkey=private-query' },
      body: 'private-body',
      bytes: Buffer.from('binary'),
      list: Array(50).fill('x'),
      long: 'x'.repeat(5000),
      error: new Error('test'),
    };
    data.self = data;
    const serialized = JSON.stringify(projectConsoleContext(data));
    for (const value of ['private-cookie', 'private-key', 'private-query', 'private-body'])
      expect(serialized).not.toContain(value);
    expect(serialized).toContain('[circular]');
    expect(serialized).toContain('stack');
    expect((projectConsoleContext(data) as { list: unknown[] }).list).toHaveLength(12);
    expect((projectConsoleContext(data) as { long: string }).long).toHaveLength(1000);
    expect(data.cookie).toBe('private-cookie');
    const wide = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [
        `key${i}`,
        Object.fromEntries(Array.from({ length: 24 }, (_, j) => [`value${j}`, 'x'.repeat(5000)])),
      ]),
    );
    expect(JSON.stringify(projectConsoleContext(wide)).length).toBeLessThan(25000);
  });
  it('慢请求和数据库慢操作逐条保留本次耗时及定位信息', () => {
    const f = fixture();
    for (const durationMs of [1200, 8600, 1400]) {
      f.logger.write('warn', '请求完成', {
        scope: 'trpc',
        event: 'request-slow',
        path: 'account.getUnreadInfos',
        durationMs,
      });
      f.logger.write('warn', '数据库等待超过阈值', {
        scope: 'database',
        event: 'database-slow',
        jsQueueWaitMs: durationMs,
        nativePromiseAwaitMs: durationMs + 100,
        fingerprint: 'query-fixture',
        caller: 'fixture.ts:12',
      });
    }
    const lines = f.lines.map(stripVTControlCharacters);
    expect(lines).toHaveLength(6);
    expect(lines[2]).toContain('耗时 8.6s');
    expect(lines[4]).toContain('耗时 1.4s');
    expect(lines[3]).toContain('原生等待 8.7s');
    expect(lines[3]).toContain('慢操作  fixture.ts:12');
    expect(lines[3]).not.toContain('指纹');
    expect(lines[3]).not.toContain('排队');
    f.logger.flush();
    expect(f.lines).toHaveLength(6);
  });
  it.each(['errorStack', 'error'] as const)(
    '每次错误保留详情，30 秒内仅收起相同 %s 堆栈',
    (field) => {
      const f = fixture();
      const error = new Error('fixture-timeout');
      error.stack = 'Error: fixture-timeout\n    at probe (fixture.ts:12)';
      const context = {
        scope: 'trpc',
        event: 'request-failed',
        path: 'account.open',
        code: 'TIMEOUT',
        errorMessage: error.message,
        [field]: field === 'error' ? error : error.stack,
      };
      f.logger.write('error', '请求未完成', {
        ...context,
        durationMs: 1200,
        operationId: 'first',
      });
      f.logger.write('error', '请求未完成', {
        ...context,
        durationMs: 8600,
        operationId: 'second',
      });
      const lines = f.lines.map(stripVTControlCharacters);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('at probe (fixture.ts:12)');
      expect(lines[1]).toContain('原因 fixture-timeout');
      expect(lines[1]).toContain('错误码 TIMEOUT');
      expect(lines[1]).toContain('耗时 8.6s');
      expect(lines[1]).toContain('堆栈同前');
      expect(lines[1]).not.toContain('at probe');
      f.advance(30_000);
      f.logger.write('error', '请求未完成', context);
      expect(f.lines[2]).toContain('at probe (fixture.ts:12)');
      f.logger.dispose();
      expect(f.lines).toHaveLength(3);
    },
  );
  it.each([
    { code: 'OTHER' },
    { errorCode: 42 },
    { errorMessage: 'another failure' },
    { reason: 'another reason' },
    { path: 'account.other' },
    { caller: 'other.ts:12' },
    { fingerprint: 'other-query' },
    { errorStack: 'Error: failure\n    at other (other.ts:12)' },
  ])('错误、对象或调用位置变化时重新展开堆栈：%j', (change) => {
    const f = fixture();
    const context = {
      scope: 'fixture',
      event: 'failed',
      path: 'account.open',
      code: 'TIMEOUT',
      errorMessage: 'failure',
      errorStack: 'Error: failure\n    at probe (fixture.ts:12)',
    };
    f.logger.write('warn', '失败', context);
    f.logger.write('warn', '失败', { ...context, ...change });
    expect(f.lines[1]).toContain('at ');
    expect(f.lines[1]).not.toContain('堆栈同前');
  });
  it('相同内容但无堆栈的警告和错误也逐次输出', () => {
    const f = fixture();
    for (const level of ['warn', 'error'] as const) {
      f.logger.write(level, 'failed', { event: 'failed', durationMs: 1200 });
      f.logger.write(level, 'failed', { event: 'failed', durationMs: 8600 });
    }
    expect(f.lines).toHaveLength(4);
    expect(f.lines[1]).toContain('8.6s');
    expect(f.lines[3]).toContain('8.6s');
  });
  it('堆栈缓存最多 512 项，淘汰后再次出现仍展开', () => {
    const f = fixture();
    const context = { errorStack: 'Error: failure\n    at probe (fixture.ts:12)' };
    for (let i = 0; i < 513; i++)
      f.logger.write('error', 'unique', { ...context, event: `event-${i}` });
    f.logger.write('error', 'unique', { ...context, event: 'event-0' });
    expect(f.lines.at(-1)).toContain('at probe');
    f.logger.write('error', 'unique', { ...context, event: 'event-0' });
    expect(f.lines.at(-1)).toContain('堆栈同前');
  });
  it('仅指定的轮询告警汇总，包含首条并统计各次真实耗时', () => {
    vi.useFakeTimers();
    const f = fixture();
    for (const durationMs of [1100, 8600, 1400])
      f.logger.write('warn', 'QQ 在线检测暂不可用', {
        scope: 'account-monitor',
        event: 'online-probe-failed',
        accountUin: 'fixture-account',
        errorMessage: 'probe unavailable',
        durationMs,
      });
    expect(f.lines).toHaveLength(1);
    f.advance(30_000);
    vi.advanceTimersByTime(30_000);
    const summary = stripVTControlCharacters(f.lines[1]!);
    expect(summary).toContain('QQ 在线检测暂不可用');
    expect(summary).toContain('原因 probe unavailable');
    expect(summary).toContain('近 30 秒 3 次');
    expect(summary).toContain('耗时 1.1～8.6 秒，平均 3.7 秒，最近 1.4 秒');
    expect(summary).not.toContain('耗时 1.1s');
    f.logger.dispose();
    expect(f.lines).toHaveLength(2);
  });
  it('轮询告警按原因、错误码和位置独立统计，退出按实际时长汇总', () => {
    const f = fixture();
    const context = {
      scope: 'account-monitor',
      event: 'online-probe-failed',
      errorMessage: 'unavailable',
      code: 'TIMEOUT',
      caller: 'fixture.ts:12',
    };
    f.logger.write('warn', '检测失败', context);
    f.logger.write('warn', '检测失败', { ...context, errorMessage: 'another failure' });
    f.logger.write('warn', '检测失败', { ...context, code: 'OTHER' });
    f.logger.write('warn', '检测失败', { ...context, caller: 'other.ts:12' });
    expect(f.lines).toHaveLength(4);
    f.advance(4500);
    f.logger.write('warn', '检测失败', context);
    f.logger.dispose();
    expect(f.lines).toHaveLength(5);
    expect(stripVTControlCharacters(f.lines[4]!)).toContain('近 4.5 秒 2 次');
  });
  it('窗口到期的新轮询先结清旧统计，单次事件不生成多余汇总', () => {
    const f = fixture();
    const context = { scope: 'account-monitor', event: 'online-probe-failed' };
    f.logger.write('warn', '检测失败', { ...context, durationMs: 1200 });
    f.logger.write('warn', '检测失败', { ...context, durationMs: 8600 });
    f.advance(30_000);
    f.logger.write('warn', '检测失败', { ...context, durationMs: 1400 });
    expect(f.lines).toHaveLength(3);
    expect(stripVTControlCharacters(f.lines[1]!)).toContain('近 30 秒 2 次');
    expect(stripVTControlCharacters(f.lines[1]!)).toContain('耗时 1.2～8.6 秒');
    expect(stripVTControlCharacters(f.lines[2]!)).toContain('耗时 1.4s');
    f.logger.flush();
    expect(f.lines).toHaveLength(3);
  });
  it('汇总只统计真实有限非负耗时，缺失与异常值不作为零参与平均', () => {
    const f = fixture();
    const context = { scope: 'account-monitor', event: 'online-probe-failed' };
    for (const durationMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1200, 3600])
      f.logger.write('warn', '检测失败', { ...context, durationMs });
    f.advance(30_000);
    f.logger.flush();
    const summary = stripVTControlCharacters(f.lines[1]!);
    expect(summary).toContain('近 30 秒 6 次');
    expect(summary).toContain('耗时 1.2～3.6 秒，平均 2.4 秒，最近 3.6 秒（2 次有记录）');
  });
  it('轮询统计最多 512 项，淘汰前输出已有汇总，ERROR 级别不参与合并', () => {
    const f = fixture();
    const context = { scope: 'account-monitor', event: 'online-probe-failed' };
    f.logger.write('warn', '检测失败', { ...context, accountUin: 'fixture-0' });
    f.logger.write('warn', '检测失败', { ...context, accountUin: 'fixture-0' });
    for (let i = 1; i < 513; i++)
      f.logger.write('warn', '检测失败', { ...context, accountUin: `fixture-${i}` });
    expect(f.lines).toHaveLength(514);
    expect(stripVTControlCharacters(f.lines[512]!)).toContain('本轮 2 次');
    expect(stripVTControlCharacters(f.lines[512]!)).toContain('账号 fixture-0');
    f.logger.write('error', '检测失败', context);
    f.logger.write('error', '检测失败', context);
    expect(f.lines).toHaveLength(516);
    f.logger.dispose();
    expect(f.lines).toHaveLength(516);
  });
  it('DEBUG 不汇总轮询告警，也不收起重复堆栈', () => {
    const f = fixture({ WEQ_LOG_LEVEL: 'debug' });
    const context = {
      scope: 'account-monitor',
      event: 'online-probe-failed',
      errorStack: 'Error: failure\n    at probe (fixture.ts:12)',
    };
    for (let i = 0; i < 3; i++) f.logger.write('warn', '检测失败', context);
    expect(f.lines).toHaveLength(3);
    for (const line of f.lines) expect(line).toContain('at probe');
    f.logger.flush();
    expect(f.lines).toHaveLength(3);
  });
  it('文件目录未就绪、目录创建失败及循环上下文不会阻断终端', () => {
    const sink = vi.fn();
    configureConsoleLogger({ development: true, processName: 'test', env: {}, sink });
    getLogger().info('before-init');
    expect(() => initLogger('/dev/null/not-a-directory')).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => getLogger().error('after-init', cyclic)).not.toThrow();
    expect(sink.mock.calls.some(([line]) => line.includes('after-init'))).toBe(true);
    const broken = createConsoleLogger({
      development: true,
      processName: 'test',
      env: {},
      sink: () => {
        throw new Error('closed');
      },
    });
    expect(() => broken.write('error', 'failure')).not.toThrow();
    broken.dispose();
    configureConsoleLogger({ development: false, processName: 'test', env: {} });
  });
  it('终端过滤及堆栈收起不影响 JSON 文件格式或文件记录数', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weq-log-test-'));
    const sink = vi.fn();
    configureConsoleLogger({
      development: true,
      processName: 'test',
      env: { WEQ_LOG_LEVEL: 'error' },
      sink,
    });
    try {
      initLogger(directory);
      getLogger().info('file-only', { event: 'fixture' });
      const context = {
        scope: 'fixture',
        event: 'duplicate',
        errorStack: 'Error: failure\n    at probe (fixture.ts:12)',
      };
      getLogger().error('duplicate', context);
      getLogger().error('duplicate', context);
      expect(sink).toHaveBeenCalledTimes(2);
      expect(sink.mock.calls[0]![0]).toContain('at probe');
      expect(sink.mock.calls[1]![0]).not.toContain('at probe');
      const path = join(directory, 'logs', readdirSync(join(directory, 'logs'))[0]!);
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(4);
      expect(lines[1]).toEqual({
        ts: expect.any(String),
        level: 'info',
        message: 'file-only',
        context: { event: 'fixture' },
      });
      expect(lines[2].context.errorStack).toBe(context.errorStack);
      expect(lines[3].context.errorStack).toBe(context.errorStack);
    } finally {
      configureConsoleLogger({ development: false, processName: 'test', env: {} });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
