// @vitest-environment node
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createDevelopmentOutput,
  developmentChildEnvironment,
  summarizeDevelopmentBuildWarning,
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
    system.write('2026-11-12 14:25:49.733 Electron[52183:739564] Unknown system diagnostic\n');
    system.end();
    expect(lines.at(-1)).toContain('electron-system');
    expect(lines.at(-1)).toContain('Unknown system diagnostic');
    expect(lines.at(-1)).not.toContain('52183');
  });
  const macInputDiagnostics = [
    'TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit',
    '+[IMKClient subclass]: chose IMKClient_Modern',
    '+[IMKClient subclass]: chose IMKClient_Legacy',
    '+[IMKInputSession subclass]: chose IMKInputSession_Modern',
    '+[IMKInputSession subclass]: chose IMKInputSession_Legacy',
  ];
  it.each(['info', 'debug'])('%s 模式只收起已知无害的系统输入诊断', (level) => {
    vi.stubEnv('WEQ_LOG_LEVEL', level);
    onTestFinished(() => vi.unstubAllEnvs());
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    for (const diagnostic of macInputDiagnostics) {
      const bytes = Buffer.from(`2026-11-13 05:16:04.123 Electron[123:456] ${diagnostic}\r\n`);
      output.write(bytes.subarray(0, 60));
      output.write(bytes.subarray(60));
    }
    output.write('12:34:56 INFO  startup  已就绪\n');
    output.end();
    expect(lines).toHaveLength(level === 'debug' ? macInputDiagnostics.length + 1 : 1);
    if (level === 'debug') {
      for (const diagnostic of macInputDiagnostics) expect(lines.join('')).toContain(diagnostic);
    }
    expect(lines.at(-1)).toBe('12:34:56 INFO  startup  已就绪\n');
  });
  it('不吞掉输入系统的相似异常、未知实现与其他系统故障', () => {
    vi.stubEnv('WEQ_LOG_LEVEL', 'info');
    onTestFinished(() => vi.unstubAllEnvs());
    const messages = [
      `${macInputDiagnostics[0]} failed`,
      '+[IMKClient subclass]: chose IMKClient_Unknown',
      '+[IMKInputSession subclass]: failed to initialize',
      '+[IMKClient subclass]: chose IMKInputSession_Modern',
      'GPU process exited unexpectedly',
      'Certificate verification failed',
      'Permission denied',
      'Database error: fixture',
      'Native module failed to load',
      'Electron Security Warning: fixture',
    ];
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    for (const message of messages)
      output.write(`2026-11-13 05:16:04.123 Electron[123:456] ${message}\n`);
    output.write(`${macInputDiagnostics[0]}\n`);
    output.end();
    expect(lines).toHaveLength(messages.length + 1);
    for (const message of messages) expect(lines.join('')).toContain(message);
    expect(lines.at(-1)).toContain('dev-process');
    expect(lines.at(-1)).toContain(macInputDiagnostics[0]);
  });
  it('管道继承真实终端颜色，NO_COLOR 优先，已有 ANSI 在无色输出中移除', () => {
    expect(terminalColor('stderr', { WEQ_DEV_STDERR_TTY: '1' })).toBe(true);
    expect(
      developmentChildEnvironment({ WEQ_DEV_STDOUT_TTY: '1', WEQ_DEV_STDERR_TTY: '1' }).FORCE_COLOR,
    ).toBe('1');
    expect(developmentChildEnvironment({ WEQ_DEV_STDOUT_TTY: '1' }).WEQ_DEV_STDOUT_TTY).toBe('1');
    expect(terminalColor('stderr', { WEQ_DEV_STDERR_TTY: '1', NO_COLOR: '' })).toBe(false);
    expect(
      developmentChildEnvironment({ NO_COLOR: '', FORCE_COLOR: '1' }).FORCE_COLOR,
    ).toBeUndefined();
    const sink = vi.fn();
    const output = createDevelopmentOutput(sink, false);
    output.write('\x1b[32m12:34:56 INFO  startup  ready\x1b[0m\n');
    expect(sink).toHaveBeenCalledWith('12:34:56 INFO  startup  ready\n');
  });
  it('插件计时的独立输出行接续原告警，不变成 INFO，且不吞掉后续消息', () => {
    vi.stubEnv('WEQ_LOG_LEVEL', 'info');
    onTestFinished(() => vi.unstubAllEnvs());
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    output.write(
      '12:34:56 WARN  vite-main  [PLUGIN_TIMINGS] 插件回调累计 6.5s / 构建 7.3s（88%）\n',
    );
    output.write('The slowest callbacks, timed inside each callback:\n');
    output.write('- plugin weq-remote-web-assets buildStart (66%, 4.8s, 1 call)\n');
    output.write('Additional callback time came from callbacks under 1s.\n');
    output.write(
      'See https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.\n',
    );
    output.write('unrelated warning\n');
    output.end();
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '         - plugin weq-remote-web-assets buildStart (66%, 4.8s, 1 call)\n',
    );
    expect(lines[2]).toContain('WARN  dev-process');
  });
  it('DEBUG 保留插件计时原文，明细仍接续原告警', () => {
    vi.stubEnv('WEQ_LOG_LEVEL', 'debug');
    onTestFinished(() => vi.unstubAllEnvs());
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    output.write('[PLUGIN_TIMINGS] JavaScript callbacks ran for 6.5s of this 7.3s build (88%).\n');
    output.write('Additional callback time came from callbacks under 1s.\n');
    output.write('- plugin vite:esm-shim renderChunk (19%, 1.4s, 48 calls)\n');
    output.end();
    expect(lines.join('')).toContain('JavaScript callbacks ran for 6.5s');
    expect(lines[1]).toBe('         Additional callback time came from callbacks under 1s.\n');
    expect(lines[2]).toContain('         - plugin vite:esm-shim');
    expect(lines.join('')).not.toContain('INFO');
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
  it('真实 Vite 大包告警只显示阈值摘要，不输出通用建议', async () => {
    const { build } = await import('vite');
    const directory = await mkdtemp(join(tmpdir(), 'weq-console-warning-'));
    const sink = vi.fn();
    const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink);
    try {
      await writeFile(
        join(directory, 'entry.js'),
        `console.log(${JSON.stringify('fixture'.repeat(300))});`,
      );
      await build({
        configFile: false,
        root: directory,
        ...logging.config,
        plugins: logging.plugins,
        build: {
          outDir: 'dist',
          chunkSizeWarningLimit: 1,
          rollupOptions: { input: join(directory, 'entry.js') },
        },
      });
      const output = sink.mock.calls.flat().join('');
      expect(output).toContain('WARN  vite-web  部分构建块压缩后超过 1 kB');
      expect(output).not.toContain('Consider:');
      expect(output).not.toContain('code-split');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
      expect(sink.mock.calls[1]![0]).not.toContain('产物数');
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
    expect(sink.mock.calls.flat().join('')).toContain('耗时 2.4s');
    expect(sink.mock.calls.flat().join('')).not.toContain('产物数');
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
  it('已知动态导入告警按构建汇总、去重并重置，未知格式和其他告警不吞掉', () => {
    const sink = vi.fn();
    const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink);
    const plugin = logging.plugins[0]!;
    const logger = logging.config.customLogger!;
    hook(plugin, 'buildStart');
    const warning = (path: string) =>
      `[INEFFECTIVE_DYNAMIC_IMPORT] ${path} is dynamically imported by long/path.ts but also statically imported by other/path.ts, dynamic import will not move module into another chunk.`;
    logger.warn(warning('../../db/index.ts'));
    logger.warn(warning('../../db/index.ts'));
    logger.warn(warning('src/ai_images.ts'));
    hook(plugin, 'closeBundle');
    expect(sink.mock.calls).toHaveLength(2);
    expect(sink.mock.calls[1]![0]).toContain('2 项动态导入未形成分包：index.ts、ai_images.ts');
    expect(sink.mock.calls[1]![0]).not.toContain('long/path');
    hook(plugin, 'buildStart');
    hook(plugin, 'closeBundle');
    expect(sink.mock.calls).toHaveLength(3);
    logger.warn('[INEFFECTIVE_DYNAMIC_IMPORT] unknown format\nfixture.ts:3');
    expect(sink.mock.calls.flat().join('')).toContain('fixture.ts:3');
  });
  it('默认压缩大包建议，插件计时合并为单行，其他告警仍保留定位', () => {
    const sink = vi.fn();
    const logger = developmentViteLogging('main', { WEQ_DEV_CONSOLE: '1' }, sink).config
      .customLogger!;
    logger.warn(
      '[plugin builtin:vite-reporter]\n\n(!) Some chunks are larger than 500 kB after minification. Consider:\n- Using dynamic import() to code-split the application\n- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.',
    );
    expect(sink.mock.calls).toHaveLength(1);
    expect(sink.mock.calls[0]![0]).toContain('部分构建块压缩后超过 500 kB');
    sink.mockClear();
    logger.warn(
      '[PLUGIN_TIMINGS] JavaScript callbacks ran for 6.3s of this 7.1s build (90%).\n\nThe slowest callbacks, timed inside each callback (the wait before a callback starts is excluded, the time it awaits is included):\n\n- plugin weq-remote-web-assets buildStart (69%, 4.9s, 1 call)\n\n- plugin vite:esm-shim renderChunk (17%, 1.2s, 48 calls)\nAdditional callback time came from callbacks under 1s.\nSee https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.',
    );
    expect(sink.mock.calls).toHaveLength(1);
    expect(sink.mock.calls[0]![0]).toContain('WARN  vite-main');
    expect(sink.mock.calls[0]![0]).toContain(
      '构建 7.1s，插件 6.3s（90%）：Web 资源 4.9s，ESM 兼容 1.2s\n',
    );
    const lines: string[] = [];
    const output = createDevelopmentOutput((line) => lines.push(line), false);
    output.write(sink.mock.calls[0]![0]);
    output.end();
    expect(lines).toEqual([sink.mock.calls[0]![0]]);
    logger.warn('unrelated warning\nfixture.ts:3');
    expect(sink.mock.calls.at(-1)![0]).toContain('fixture.ts:3');
  });
  it('未知插件保留名称和耗时，未识别的计时格式与额外诊断不丢失', () => {
    expect(
      summarizeDevelopmentBuildWarning(
        '[PLUGIN_TIMINGS] JavaScript callbacks ran for 1.5s of this 2.0s build (75%).\n- plugin custom:assets transform (60%, 1.2s, 3 calls)\nfixture.ts:3',
      ),
    ).toBe('构建 2.0s，插件 1.5s（75%）：custom:assets 1.2s\nfixture.ts:3');
    const unknown = '[PLUGIN_TIMINGS] unknown timing format\nfixture.ts:4';
    expect(summarizeDevelopmentBuildWarning(unknown)).toBe(unknown);
  });
});
