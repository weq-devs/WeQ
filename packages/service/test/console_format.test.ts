import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { formatConsoleRecord } from '../src/common/console_format';
import { projectConsoleContext } from '../src/common/console_logger';
import type { LoggerContext } from '../src/common/logger';

const options = { now: Date.UTC(2026, 0, 1, 16, 0, 0, 123), color: false, details: false };
describe('终端可读排版', () => {
  it('慢请求只显示时间、模块、方法和耗时，不输出 JSON 或内部元数据', () => {
    const line = formatConsoleRecord(
      'warn',
      '请求完成',
      {
        scope: 'trpc',
        event: 'request-slow',
        path: 'account.getUnreadInfos',
        type: 'query',
        durationMs: 2278,
        outcome: 'ok',
        operationId: '01234567-full-id',
        pid: 32214,
      },
      options,
    );
    expect(line).toBe('00:00:00 WARN  trpc  慢请求  account.getUnreadInfos  耗时 2.28s\n');
    for (const noise of [
      '{',
      '}',
      '"',
      '+08:00',
      '32214',
      'operationId',
      'request-slow',
      'query',
      '01234567',
    ])
      expect(line).not.toContain(noise);
  });
  it('级别、模块、数值与时间使用不同颜色，关闭颜色后内容相同', () => {
    for (const [level, code] of [
      ['debug', 90],
      ['info', 32],
      ['warn', 33],
      ['error', 31],
    ] as const) {
      const context = { scope: 'database', jsQueueWaitMs: 172.4, nativePromiseAwaitMs: 1677.7 };
      const line = formatConsoleRecord(level, '数据库等待超过阈值', context, {
        ...options,
        color: true,
      });
      expect(line).toContain(`\x1b[${code}m${level.toUpperCase()}`);
      expect(line).toContain('\x1b[36mdatabase');
      expect(line).toContain('\x1b[90m00:00:00');
      expect(line).toContain('\x1b[33m1.68s');
      expect(stripVTControlCharacters(line)).toBe(
        formatConsoleRecord(level, '数据库等待超过阈值', context, options),
      );
    }
  });
  it('媒体数量、来源和大小转成短文本，空值及无价值字段不展示', () => {
    const line = formatConsoleRecord(
      'info',
      '媒体下载汇总',
      {
        scope: 'media-download',
        source: 'external-rkey',
        count: 12,
        failed: 0,
        durationMs: 930,
        size: 2048,
        nativeVersion: 'unknown',
        empty: null,
        extra: { raw: 'noise' },
      },
      options,
    );
    expect(line).toContain('来源 外部 rkey');
    expect(line).toContain('共 12');
    expect(line).toContain('大小 2KB');
    expect(line).toContain('耗时 930ms');
    for (const noise of ['失败', 'unknown', 'null', 'noise', '[object Object]'])
      expect(line).not.toContain(noise);
  });
  it('失败原因和阶段摘要可读，堆栈独立缩进且默认最多六帧', () => {
    const stack = `Error: timeout\n${Array.from({ length: 10 }, (_, i) => `    at fn${i} (fixture.ts:${i + 1})`).join('\n')}`;
    const line = formatConsoleRecord(
      'error',
      '请求未完成',
      {
        scope: 'trpc',
        event: 'request-failed',
        path: 'account.open',
        errorMessage: '连接超时',
        code: 'TIMEOUT',
        errorStack: stack,
        failures: { 'local:http-404': 2 },
      },
      options,
    );
    expect(line).toContain('请求失败');
    expect(line).toContain('原因 连接超时');
    expect(line).toContain('local:http-404 ×2');
    expect(line).toContain('\n         at fn0');
    expect(line).not.toContain('fn6');
    expect(line).toContain('更多堆栈见日志文件');
  });
  it('DEBUG 显示短关联和有界对象摘要，嵌套 Error 保留诊断，凭据仍不展示', () => {
    const context = projectConsoleContext({
      scope: 'startup',
      operationId: '12345678-full-id',
      nativeBuild: { isDev: true, validitySecs: 0 },
      apiKey: 'secret-fixture',
      payload: { text: 'private-fixture' },
      error: new Error('fixture-error'),
    }) as LoggerContext;
    const normal = formatConsoleRecord('error', '初始化失败', context, options);
    expect(normal).toContain('原因 fixture-error');
    expect(normal).not.toContain('12345678');
    const detailed = formatConsoleRecord('error', '初始化失败', context, {
      ...options,
      details: true,
    });
    expect(detailed).toContain('关联 #12345678');
    expect(detailed).not.toContain('full-id');
    expect(detailed).toContain('nativeBuild.isDev 是');
    for (const noise of [
      'secret-fixture',
      'private-fixture',
      '[hidden]',
      '[omitted]',
      '{',
      '[object Object]',
    ])
      expect(detailed).not.toContain(noise);
  });
  it('重复汇总只保留原事件、定位方法及新增次数，不重复旧耗时与堆栈', () => {
    const line = formatConsoleRecord(
      'warn',
      '重复日志汇总',
      {
        scope: 'trpc',
        event: 'request-slow',
        originalMessage: '请求完成',
        repeated: 11,
        path: 'account.getUnreadInfos',
        durationMs: 2000,
        errorStack: 'old-stack',
      },
      options,
    );
    expect(line).toBe('00:00:00 WARN  trpc  慢请求  account.getUnreadInfos  另有 11 次相同记录\n');
  });
});
