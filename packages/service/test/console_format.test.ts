import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { formatConsoleRecord } from '../src/common/console_format';
import { projectConsoleContext } from '../src/common/console_logger';
import type { LoggerContext } from '../src/common/logger';

const options = { now: Date.UTC(2026, 0, 1, 16, 0, 0, 123), color: false, details: false };
describe('终端可读排版', () => {
  it('生命周期摘要按模块和事件翻译，不改变未知消息，重复路径和端口不再展示', () => {
    expect(
      formatConsoleRecord(
        'info',
        'logger initialized',
        {
          scope: 'logger',
          event: 'init',
          logDir: '/fixture/logs',
        },
        options,
      ),
    ).toContain('日志已就绪  日志 /fixture/logs');
    const context = { scope: 'app-context', event: 'init-app-context', logDir: '/fixture/logs' };
    expect(formatConsoleRecord('info', 'initializing app context', context, options)).not.toContain(
      '/fixture/logs',
    );
    expect(context.logDir).toBe('/fixture/logs');
    expect(
      formatConsoleRecord(
        'info',
        'started',
        {
          scope: 'mcp-server',
          event: 'mcp-start',
          address: 'http://127.0.0.1:48766/',
          port: 48766,
        },
        options,
      ),
    ).toContain('MCP 服务已启动  地址 http://127.0.0.1:48766/');
    expect(
      formatConsoleRecord(
        'info',
        'started',
        {
          scope: 'mcp-server',
          event: 'mcp-start',
          address: 'http://127.0.0.1:48766/',
          port: 48766,
        },
        options,
      ),
    ).not.toContain('端口');
    expect(
      formatConsoleRecord('info', 'original message', { scope: 'other', event: 'init' }, options),
    ).toContain('original message');
    expect(
      formatConsoleRecord('info', 'started', { address: 'socket', port: 48766 }, options),
    ).toContain('端口 48766');
  });
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
  it('数据库慢操作沿用通用行头与操作位置，默认只显示自身等待及阻塞影响', () => {
    const context = {
      scope: 'database',
      event: 'database-slow',
      caller: 'FixtureReader.read',
      fingerprint: 'aaaaaaaaaaaaaaaa',
      nativePromiseAwaitMs: 3200,
      jsQueueWaitMs: 900,
      affectedQueryCount: 28,
      maxBlockedMs: 3100,
      priority: 'background',
      outcome: 'ok',
    };
    const plain = formatConsoleRecord('warn', '数据库慢操作', context, options);
    expect(plain).toBe(
      '00:00:00 WARN  database  慢操作  FixtureReader.read  原生等待 3.2s  受影响查询 28  最长阻塞 3.1s\n',
    );
    expect(
      stripVTControlCharacters(
        formatConsoleRecord('warn', '数据库慢操作', context, { ...options, color: true }),
      ),
    ).toBe(plain);
    const details = formatConsoleRecord('warn', '数据库慢操作', context, {
      ...options,
      details: true,
    });
    expect(details).toContain('指纹 aaaaaaaaaaaaaaaa');
    expect(details).toContain('排队 900ms');
    expect(details).toContain('优先级 后台');
    expect(details.match(/FixtureReader.read/g)).toHaveLength(1);
    const fallback = formatConsoleRecord(
      'warn',
      '数据库慢操作',
      { ...context, caller: 'unknown', affectedQueryCount: 0, maxBlockedMs: 0 },
      options,
    );
    expect(fallback).toContain('指纹 aaaaaaaaaaaaaaaa');
    expect(fallback).not.toContain('unknown');
    expect(fallback).not.toContain('受影响查询');
    expect(fallback).not.toContain('最长阻塞');
  });
  it.each([
    ['failed', '慢操作失败'],
    ['cancelled', '慢操作已取消'],
  ])('数据库慢操作 %s 不被普通慢操作标题掩盖', (outcome, title) => {
    expect(
      formatConsoleRecord(
        'warn',
        '数据库慢操作',
        { scope: 'database', event: 'database-slow', outcome },
        options,
      ),
    ).toBe(`00:00:00 WARN  database  ${title}\n`);
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
  it('轮询汇总精炼展示次数和耗时范围，不拿首条耗时充当本次耗时', () => {
    const line = formatConsoleRecord(
      'warn',
      'QQ 在线检测暂不可用',
      {
        scope: 'account-monitor',
        event: 'online-probe-failed',
        errorMessage: '连接超时',
        durationMs: 2000,
        errorStack: 'Error: 连接超时\n    at probe (fixture.ts:12)',
      },
      {
        ...options,
        summary: {
          count: 12,
          windowMs: 30000,
          timings: {
            durationMs: { count: 12, min: 1100, max: 8600, total: 27600, last: 1400 },
          },
        },
      },
    );
    expect(line).toBe(
      '00:00:00 WARN  account-monitor  QQ 在线检测暂不可用  原因 连接超时\n' +
        '         近 30 秒 12 次，耗时 1.1～8.6 秒，平均 2.3 秒，最近 1.4 秒\n',
    );
    expect(line).not.toContain('at probe');
  });
  it('多种指标各自统计，缺样本时标出实际样本数，不把缺失当作零', () => {
    const line = formatConsoleRecord(
      'warn',
      '检测失败',
      {},
      {
        ...options,
        summary: {
          count: 3,
          windowMs: 1500,
          timings: {
            durationMs: { count: 3, min: 100, max: 900, total: 1500, last: 500 },
            jsQueueWaitMs: { count: 1, min: 100, max: 100, total: 100, last: 100 },
          },
        },
      },
    );
    expect(line).toContain('近 1.5 秒 3 次，耗时 100～900 毫秒，平均 500 毫秒，最近 500 毫秒');
    expect(line).toContain('排队 100 毫秒（1 次有记录）');
  });
  it('收起堆栈仍保留错误原因、错误码和耗时，且不修改上下文', () => {
    const context = {
      errorStack: 'Error: timeout\n    at probe (fixture.ts:12)',
      code: 'TIMEOUT',
      durationMs: 8600,
    };
    const line = formatConsoleRecord('error', '失败', context, {
      ...options,
      stackRepeated: true,
    });
    expect(line).toContain('原因 Error: timeout');
    expect(line).toContain('错误码 TIMEOUT');
    expect(line).toContain('耗时 8.6s');
    expect(line).toContain('堆栈同前');
    expect(line).not.toContain('at probe');
    expect(context.errorStack).toContain('at probe');
  });
  it('字段较多时换行，不再因单行字段上限丢失诊断信息', () => {
    const line = formatConsoleRecord(
      'error',
      '失败',
      {
        errorMessage: 'timeout',
        reason: 'network',
        code: 'TIMEOUT',
        errorCode: 42,
        retCode: 43,
        httpStatus: 504,
        statusCode: 504,
        exitCode: 1,
        accountUin: 'fixture-account',
        mediaId: 'fixture-media',
        taskId: 'fixture-task',
        durationMs: 8600,
        jsQueueWaitMs: 1200,
        nativePromiseAwaitMs: 7400,
      },
      options,
    );
    expect(line).toContain('\n         ');
    for (const value of [
      '耗时 8.6s',
      '排队 1.2s',
      '原生等待 7.4s',
      'fixture-account',
      'fixture-task',
    ])
      expect(line).toContain(value);
  });
});
