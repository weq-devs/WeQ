import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('首次完整错误、30 秒汇总、退出刷新和 512 项上限', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.logger.write('error', 'failed', {
      event: 'failed',
      errorStack: 'stack',
      operationId: 'first',
    });
    f.logger.write('error', 'failed', {
      event: 'failed',
      errorStack: 'stack',
      operationId: 'second',
    });
    expect(f.lines).toHaveLength(1);
    f.advance(30_000);
    vi.advanceTimersByTime(30_000);
    expect(f.lines).toHaveLength(2);
    expect(f.lines[1]).toContain('另有 1 次相同记录');
    for (let i = 0; i < 513; i++) f.logger.write('warn', 'unique', { event: `event-${i}` });
    const before = f.lines.length;
    f.logger.write('warn', 'unique', { event: 'event-0' });
    expect(f.lines.length).toBe(before + 1);
    f.logger.write('warn', 'unique', { event: 'event-0' });
    f.logger.dispose();
    expect(f.lines.at(-1)).toContain('另有 1 次相同记录');
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
  it('终端过滤及聚合不影响 JSON 文件格式或文件记录数', () => {
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
      getLogger().error('duplicate', { scope: 'fixture', event: 'duplicate' });
      getLogger().error('duplicate', { scope: 'fixture', event: 'duplicate' });
      expect(sink).toHaveBeenCalledTimes(1);
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
    } finally {
      configureConsoleLogger({ development: false, processName: 'test', env: {} });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
