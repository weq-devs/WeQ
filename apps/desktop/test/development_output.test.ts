// @vitest-environment node
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createDevelopmentOutput,
  developmentChildEnvironment,
  superviseDevelopmentChild,
  terminalColor,
} from '../src/main/development_console';
import { developmentViteLogging } from '../src/main/development_vite';
import type { Plugin } from 'vite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('开发进程输出', () => {
  it('跨块中文、CRLF、半行与退出尾行不丢字，已格式化记录不重复包裹', () => {
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    const bytes = Buffer.from('启动完成\r\n');
    output.write(bytes.subarray(0, 2));
    expect(lines).toEqual([]);
    output.write(bytes.subarray(2));
    output.write('12:34:56 INFO  startup  已就绪\n');
    output.write('Error: fixture\n    at fn (fixture.ts:1)\n尾行');
    output.end();
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('启动完成');
    expect(lines[1]).toBe('12:34:56 INFO  startup  已就绪\n');
    expect(lines[2]).toContain('ERROR dev-process');
    expect(lines[3]).toContain('at fn (fixture.ts:1)');
    expect(lines[4]).toContain('尾行');
  });
  it('超长行有界分段但不截断后续内容，系统消息保留正文并移除旧时间与 PID', () => {
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false, 64);
    output.write('x'.repeat(160));
    expect(lines).toHaveLength(2);
    output.end();
    expect(lines).toHaveLength(3);
    expect(lines.join('').match(/x/g)).toHaveLength(160);
    const system = createDevelopmentOutput((line) => lines.push(line), false);
    system.write(
      '2026-11-12 14:25:49.733 Electron[52183:739564] TSM AdjustCapsLockLEDForKeyTransitionHandling - Inhibit\n',
    );
    system.end();
    expect(lines.at(-1)).toContain('electron-system');
    expect(lines.at(-1)).toContain('TSM AdjustCapsLockLEDForKeyTransitionHandling - Inhibit');
    expect(lines.at(-1)).not.toContain('52183');
  });
  it('管道继承真实终端颜色，NO_COLOR 优先，已有 ANSI 在无色输出中移除', () => {
    expect(terminalColor('stderr', { WEQ_DEV_STDERR_TTY: '1' })).toBe(true);
    expect(terminalColor('stderr', { WEQ_DEV_STDERR_TTY: '1', NO_COLOR: '' })).toBe(false);
    expect(
      developmentChildEnvironment({ NO_COLOR: '', FORCE_COLOR: '1' }).FORCE_COLOR,
    ).toBeUndefined();
    const sink = vi.fn();
    const output = createDevelopmentOutput(sink, false);
    output.write('\x1b[32m12:34:56 INFO  startup  ready\x1b[0m\n');
    expect(sink).toHaveBeenCalledWith('12:34:56 INFO  startup  ready\n');
  });
  it('子进程真实失败与无法启动均返回非零，退出刷新尾行', async () => {
    const sink = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await superviseDevelopmentChild(
          spawn(process.execPath, ['-e', 'process.stdout.write("tail"); process.exitCode = 7']),
        ),
      ).toBe(7);
      expect(sink.mock.calls.some(([line]) => String(line).includes('tail'))).toBe(true);
      expect(await superviseDevelopmentChild(spawn('/weq-fixture-missing-executable'))).toBe(1);
      expect(errors.mock.calls.some(([line]) => String(line).includes('ENOENT'))).toBe(true);
    } finally {
      sink.mockRestore();
      errors.mockRestore();
    }
  });
  it('转发中断并移除信号监听，不将信号退出当成功', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const before = process.listenerCount('SIGTERM');
    const finished = superviseDevelopmentChild(child);
    await once(child, 'spawn');
    process.emit('SIGTERM');
    expect(await finished).toBe(143);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it.skipIf(process.platform === 'win32')(
    '开发进程退出后清理本次进程组中的后代，不等待遗留输出管道',
    async () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
      const {spawn} = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
      setTimeout(() => process.exit(0), 100);
    `,
        ],
        { detached: true },
      );
      onTestFinished(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      });
      expect(await superviseDevelopmentChild(child, true)).toBe(0);
    },
  );
});

function hook(
  plugin: Plugin,
  name: 'buildStart' | 'writeBundle' | 'closeBundle',
  ...args: unknown[]
) {
  const value = plugin[name];
  const fn = typeof value === 'function' ? value : value?.handler;
  if (!fn) throw new Error(`缺少 ${name}`);
  return Reflect.apply(fn, {}, args);
}
describe('开发构建摘要', () => {
  it('真实 Vite 构建通过生命周期摘要收起产物清单，语法错误不误报成功', async () => {
    const { build } = await import('vite');
    const directory = await mkdtemp(join(tmpdir(), 'weq-console-build-'));
    const sink = vi.fn();
    const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink);
    try {
      await writeFile(join(directory, 'entry.js'), 'console.log("fixture");');
      const config = {
        configFile: false as const,
        root: directory,
        ...logging.config,
        build: { outDir: 'dist', rollupOptions: { input: join(directory, 'entry.js') } },
        plugins: [
          ...logging.plugins,
          {
            name: 'fixture-assets',
            generateBundle(this: {
              emitFile(file: { type: 'asset'; fileName: string; source: string }): void;
            }) {
              for (let i = 0; i < 120; i++)
                this.emitFile({ type: 'asset', fileName: `fixture-${i}.txt`, source: 'fixture' });
            },
          },
        ],
      };
      await build(config);
      expect(sink.mock.calls).toHaveLength(2);
      expect(sink.mock.calls[0]![0]).toContain('内置 Web 构建开始');
      expect(sink.mock.calls[1]![0]).toContain('内置 Web 构建完成');
      expect(sink.mock.calls[1]![0]).toContain('共 121');
      expect(sink.mock.calls.flat().join('')).not.toContain('fixture-');
      sink.mockClear();
      await writeFile(join(directory, 'entry.js'), 'export const = ;');
      await expect(build(config)).rejects.toThrow();
      expect(sink.mock.calls.flat().join('')).not.toContain('构建完成');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('大量产物仅输出开始和成功摘要，真实警告、错误及定位保留', () => {
    const sink = vi.fn();
    let time = 0;
    const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink, () => time);
    const plugin = logging.plugins[0]!;
    hook(plugin, 'buildStart');
    for (let i = 0; i < 1000; i++) logging.config.customLogger!.info(`asset-${i}.js 10 KB`);
    const error = new Error('fixture');
    logging.config.customLogger!.warn('真实警告\n位置 fixture.ts:3');
    logging.config.customLogger!.error('真实错误\n    at fixture.ts:4', { error });
    expect(logging.config.customLogger!.hasErrorLogged(error)).toBe(true);
    time = 2400;
    hook(
      plugin,
      'writeBundle',
      {},
      Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`asset-${i}`, {}])),
    );
    hook(plugin, 'closeBundle');
    expect(sink.mock.calls).toHaveLength(6);
    expect(sink.mock.calls.flat().join('')).toContain('耗时 2.4s  共 1000');
    expect(sink.mock.calls.flat().join('')).toContain('位置 fixture.ts:3');
  });
  it('构建失败不产生完成摘要，热更新去重但保留每次记录及不同路径', () => {
    const sink = vi.fn();
    const failed = developmentViteLogging('main', { WEQ_DEV_CONSOLE: '1' }, sink);
    hook(failed.plugins[0]!, 'buildStart');
    failed.config.customLogger!.error('build failed');
    hook(failed.plugins[0]!, 'closeBundle');
    expect(sink.mock.calls.flat().join('')).not.toContain('构建完成');
    const renderer = developmentViteLogging('renderer', { WEQ_DEV_CONSOLE: '1' }, sink);
    for (let i = 0; i < 2; i++)
      renderer.config.customLogger!.info('(client) hmr update /a.tsx, /b.css, /a.tsx');
    expect(sink.mock.calls.slice(-2).map(([line]) => line)).toEqual([
      expect.stringContaining('热更新 /a.tsx, /b.css'),
      expect.stringContaining('热更新 /a.tsx, /b.css'),
    ]);
  });
  it('DEBUG 和非开发启动完全保留 Vite 默认 logger 与构建行为', () => {
    expect(developmentViteLogging('main', {})).toEqual({ config: {}, plugins: [] });
    expect(developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1', WEQ_LOG_LEVEL: 'debug' })).toEqual(
      { config: {}, plugins: [] },
    );
  });
});
