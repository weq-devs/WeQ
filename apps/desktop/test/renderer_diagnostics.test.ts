import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyDiagnosticPage,
  createDiagnosticLog,
  projectDiagnosticProcesses,
} from '../src/main/renderer_diagnostics';
import { normalizeRendererSample } from '../src/shared/renderer_diagnostics';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('渲染内存诊断隐私与上限', () => {
  it('只记录页面类别，不保留 URL、账号、路径或查询参数', () => {
    expect(classifyDiagnosticPage(true, 'https://secret.invalid/?token=secret', 'window')).toBe(
      'main',
    );
    expect(
      classifyDiagnosticPage(false, 'https://user.qzone.qq.com/123?token=secret', 'webview'),
    ).toBe('qzone');
    expect(classifyDiagnosticPage(false, 'https://pd.qq.com/path?token=secret', 'webview')).toBe(
      'channel',
    );
    expect(classifyDiagnosticPage(false, 'https://qzone.qq.com.evil.invalid', 'webview')).toBe(
      'embedded-other',
    );
    expect(classifyDiagnosticPage(false, 'not a url', 'window')).toBe('window-other');
  });

  it('进程按 PID 归并页面，明确 KB 单位，不把缺少指标写成零', () => {
    const rows = projectDiagnosticProcesses(
      [
        {
          pid: 42,
          creationTime: 123,
          type: 'Tab',
          memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 },
          name: 'PRIVATE NAME',
        },
      ],
      [
        { id: 1, pid: 42, category: 'main' },
        { id: 2, pid: 42, category: 'qzone' },
      ],
    );
    expect(rows).toEqual([
      {
        pid: 42,
        createdAtMs: 123,
        type: 'Tab',
        workingSetKB: 1024,
        peakWorkingSetKB: 2048,
        privateBytesKB: null,
        pages: [
          { id: 1, category: 'main' },
          { id: 2, category: 'qzone' },
        ],
        omittedPages: 0,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });

  it('限制进程与页面条数，异常数字和未知类型不能污染记录', () => {
    const metrics = Array.from({ length: 100 }, (_, pid) => ({
      pid: pid + 1,
      creationTime: Number.NaN,
      type: 'PRIVATE TYPE',
      memory: { workingSetSize: Number.POSITIVE_INFINITY, peakWorkingSetSize: -1 },
    }));
    const rows = projectDiagnosticProcesses(
      metrics,
      Array.from({ length: 30 }, (_, id) => ({ id, pid: 1, category: 'main' as const })),
    );
    expect(rows).toHaveLength(32);
    expect(rows[0]).toMatchObject({
      type: 'Unknown',
      createdAtMs: null,
      workingSetKB: null,
      peakWorkingSetKB: null,
      omittedPages: 22,
    });
    expect(rows[0]?.pages).toHaveLength(8);
  });

  it('只接受数值白名单，监听器数量未知而不是零', () => {
    const sample = normalizeRendererSample({
      jsHeapUsedBytes: 500,
      domNodes: 12,
      token: 'secret',
      externalBytes: Infinity,
      blinkAllocatedKB: -1,
      resources: {
        retainedBytes: 1024,
        pinnedImages: 3,
        totalPendingImages: 5,
        token: 'secret',
        reservedBytes: Infinity,
      },
    });
    expect(sample).toMatchObject({
      jsHeapUsedBytes: 500,
      domNodes: 12,
      externalBytes: null,
      blinkAllocatedKB: null,
      eventListeners: null,
    });
    expect(JSON.stringify(sample)).not.toContain('secret');
    expect(sample.resources).toMatchObject({
      retainedBytes: 1024,
      pinnedImages: 3,
      totalPendingImages: 5,
      reservedBytes: null,
    });
    expect(normalizeRendererSample(null).jsHeapUsedBytes).toBeNull();
  });

  it('诊断日志同时限制文件大小与条数，只保留当前和上一份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-diagnostic-'));
    dirs.push(dir);
    const log = createDiagnosticLog(dir, { maxBytes: 128, maxEntries: 2 });
    for (let i = 0; i < 9; i++) expect(log.write({ i })).toBe(true);
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(['memory-diagnostics.jsonl', 'memory-diagnostics.previous.jsonl']);
    for (const file of files) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(128);
      expect(readFileSync(join(dir, file), 'utf8').trim().split('\n').length).toBeLessThanOrEqual(
        2,
      );
    }
    expect(log.write({ tooLarge: 'x'.repeat(200) })).toBe(false);
    const reopened = createDiagnosticLog(dir, { maxBytes: 128, maxEntries: 2 });
    expect(reopened.write({ i: 10 })).toBe(true);
    expect(reopened.write({ i: 11 })).toBe(true);
    expect(readFileSync(join(dir, 'memory-diagnostics.previous.jsonl'), 'utf8')).toContain('10');
  });

  it('即使条数尚未达上限，字节数也会独立触发轮转', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-diagnostic-bytes-'));
    dirs.push(dir);
    const log = createDiagnosticLog(dir, { maxBytes: 80, maxEntries: 100 });
    for (let i = 0; i < 5; i++) expect(log.write({ i, padding: 'x'.repeat(35) })).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
    for (const file of readdirSync(dir)) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(80);
    }
    expect(readFileSync(join(dir, 'memory-diagnostics.previous.jsonl'), 'utf8')).toContain('"i":3');
    expect(readFileSync(join(dir, 'memory-diagnostics.jsonl'), 'utf8')).toContain('"i":4');
  });
});
