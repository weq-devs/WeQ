// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import { developmentViteLogging, developmentBuildSummary } from '../src/main/development_vite';
import { successfulDevelopmentReload } from '../src/main/development_reload';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function hook(plugin: Plugin, name: keyof Plugin, ...args: unknown[]) {
  const value = plugin[name];
  const handler =
    typeof value === 'function'
      ? value
      : value && typeof value === 'object' && 'handler' in value
        ? value.handler
        : undefined;
  if (typeof handler !== 'function') throw new Error(`缺少 ${String(name)}`);
  return Reflect.apply(handler, {}, args);
}

it('首次主进程和预加载构建合并，后续构建独立报告，失败不填充成功摘要', () => {
  const sink = vi.fn();
  const summary = developmentBuildSummary(sink);
  let time = 0;
  const main = developmentViteLogging('main', { WEQ_DEV_CONSOLE: '1' }, sink, () => time, summary);
  const preload = developmentViteLogging(
    'preload',
    { WEQ_DEV_CONSOLE: '1' },
    sink,
    () => time,
    summary,
  );
  hook(main.plugins[0]!, 'buildStart');
  time = 500;
  hook(main.plugins[0]!, 'writeBundle');
  hook(main.plugins[0]!, 'closeBundle');
  expect(sink).not.toHaveBeenCalled();
  hook(preload.plugins[0]!, 'buildStart');
  hook(preload.plugins[0]!, 'buildEnd', new Error('fixture failure'));
  hook(preload.plugins[0]!, 'closeBundle');
  expect(sink.mock.calls.flat().join('')).not.toContain('初始构建完成');
  hook(preload.plugins[0]!, 'buildStart');
  time = 530;
  hook(preload.plugins[0]!, 'writeBundle');
  hook(preload.plugins[0]!, 'closeBundle');
  expect(sink.mock.calls.flat().join('')).toContain('初始构建完成 主进程 500ms；预加载 30ms');
  sink.mockClear();
  hook(main.plugins[0]!, 'buildStart');
  time = 560;
  hook(main.plugins[0]!, 'writeBundle');
  hook(main.plugins[0]!, 'closeBundle');
  expect(sink.mock.calls.flat()).toEqual([expect.stringContaining('主进程增量构建完成')]);
});

it('失败保留旧进程说明和定位，恢复后明确报告，不将 closeBundle 当成功', () => {
  const sink = vi.fn();
  const logging = developmentViteLogging('main', { WEQ_DEV_CONSOLE: '1' }, sink);
  const plugin = logging.plugins[0]!;
  hook(plugin, 'buildStart');
  hook(plugin, 'writeBundle');
  hook(plugin, 'closeBundle');
  sink.mockClear();
  hook(plugin, 'buildStart');
  const error = new Error('src/main/fixture.ts:42 Unexpected token');
  hook(plugin, 'buildEnd', error);
  hook(plugin, 'closeBundle');
  expect(sink.mock.calls.flat().join('')).toContain('仍运行上次成功构建');
  expect(sink.mock.calls.flat().join('')).toContain('fixture.ts:42');
  expect(sink.mock.calls.flat().join('')).not.toContain('构建完成');
  hook(plugin, 'buildStart');
  hook(plugin, 'writeBundle');
  hook(plugin, 'closeBundle');
  expect(sink.mock.calls.flat().join('')).toContain('构建已恢复');
});

it('快构建不报开始，慢构建低频进度，结束后清理计时器', () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  const logging = developmentViteLogging('preload', { WEQ_DEV_CONSOLE: '1' }, sink);
  const plugin = logging.plugins[0]!;
  hook(plugin, 'buildStart');
  vi.advanceTimersByTime(2999);
  expect(sink).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(sink.mock.calls.flat().join('')).toContain('预加载构建仍在进行');
  vi.advanceTimersByTime(15_000);
  expect(sink).toHaveBeenCalledTimes(2);
  hook(plugin, 'buildEnd', new Error('failure'));
  hook(plugin, 'closeBundle');
  const count = sink.mock.calls.length;
  vi.advanceTimersByTime(60_000);
  expect(sink).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('同轮热更新有界合并，不宣称页面已更新，未知输出不吞掉', () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  const logging = developmentViteLogging('renderer', { WEQ_DEV_CONSOLE: '1' }, sink);
  hook(logging.plugins[0]!, 'configResolved', { command: 'serve' });
  const logger = logging.config.customLogger!;
  logger.info('(client) hmr update /a.tsx, /b.css, /a.tsx');
  logger.info('(client) hmr update /b.css, /c.tsx');
  vi.advanceTimersByTime(100);
  expect(sink.mock.calls.flat()).toEqual([expect.stringContaining('已推送热更新 3 个文件')]);
  logger.info('unknown optimizer diagnostic');
  expect(sink.mock.calls.at(-1)![0]).toContain('unknown optimizer diagnostic');
  logger.info('[optimizer] scanning dependencies...');
  expect(sink.mock.calls.at(-1)![0]).not.toContain('scanning dependencies');
  logger.error('真实错误 fixture.ts:8');
  expect(sink.mock.calls.flat().join('')).toContain('scanning dependencies');
  logger.info('[optimizer] scanning dependencies...\nunknown attached diagnostic');
  expect(sink.mock.calls.at(-1)![0]).toContain('unknown attached diagnostic');
});

it('恢复后的新一轮失败即使复用同一个 Error 对象也重新保留诊断', () => {
  const sink = vi.fn();
  const logging = developmentViteLogging('preload', { WEQ_DEV_CONSOLE: '1' }, sink);
  const plugin = logging.plugins[0]!;
  const error = new Error('fixture repeated error at src/preload.ts:7');
  for (let i = 0; i < 2; i++) {
    hook(plugin, 'buildStart');
    hook(plugin, 'buildEnd', error);
    hook(plugin, 'closeBundle');
    hook(plugin, 'buildStart');
    hook(plugin, 'writeBundle');
    hook(plugin, 'closeBundle');
  }
  expect(sink.mock.calls.filter(([line]) => line.includes('fixture repeated error'))).toHaveLength(
    2,
  );
});

it('重复警告保留首次与次数，下轮构建重新报告，错误始终保留', () => {
  const sink = vi.fn();
  const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink);
  const plugin = logging.plugins[0]!;
  const logger = logging.config.customLogger!;
  hook(plugin, 'buildStart');
  logger.warn('warning fixture.ts:1');
  logger.warn('warning fixture.ts:1');
  logger.warn('warning fixture.ts:2');
  logger.error('error fixture.ts:3');
  logger.error('error fixture.ts:4');
  hook(plugin, 'closeBundle');
  expect(sink.mock.calls.flat().join('')).toContain('另有 1 次重复警告');
  const count = sink.mock.calls.length;
  hook(plugin, 'buildStart');
  logger.warn('warning fixture.ts:1');
  expect(sink.mock.calls.length).toBe(count + 1);
});

it('开发服务中的告警窗口会重置，热更新错误修正后报告恢复，关闭时刷新尾部', () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  const logging = developmentViteLogging('web', { WEQ_DEV_CONSOLE: '1' }, sink);
  const plugin = logging.plugins[0]!;
  hook(plugin, 'configResolved', { command: 'serve' });
  const logger = logging.config.customLogger!;
  logger.warnOnce('warning fixture.ts:1');
  logger.warnOnce('warning fixture.ts:1');
  vi.advanceTimersByTime(30_000);
  logger.warnOnce('warning fixture.ts:1');
  expect(sink.mock.calls.filter(([line]) => line.includes('warning fixture.ts:1'))).toHaveLength(2);
  logger.error('transform error fixture.ts:8');
  logger.info('(client) hmr update /fixed.tsx');
  vi.advanceTimersByTime(100);
  expect(sink.mock.calls.at(-1)![0]).toContain('热更新已恢复');
  const listeners: Array<() => void> = [];
  hook(plugin, 'configureServer', {
    httpServer: { once: (_name: string, callback: () => void) => listeners.push(callback) },
  });
  logger.info('(client) hmr update /tail.tsx');
  for (const listener of listeners) listener();
  expect(sink.mock.calls.at(-1)![0]).toContain('已推送热更新');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['renderChunk', 'generateBundle', 'writeBundle'] as const)(
  '真实 Vite 的 %s 失败也保留旧构建说明及恢复结果',
  async (failureHook) => {
    const { build } = await import('vite');
    const root = await mkdtemp(join(tmpdir(), 'weq-output-failure-'));
    const sink = vi.fn();
    const logging = developmentViteLogging('main', { WEQ_DEV_CONSOLE: '1' }, sink);
    let fail = false;
    const config = {
      ...logging.config,
      configFile: false as const,
      root,
      plugins: [
        ...logging.plugins,
        {
          name: 'fixture-output',
          [failureHook]() {
            if (fail) throw new Error('fixture output failed');
          },
        },
      ],
      build: { rollupOptions: { input: join(root, 'entry.js') } },
    };
    try {
      await writeFile(join(root, 'entry.js'), 'console.log("fixture");');
      await build(config);
      sink.mockClear();
      fail = true;
      await expect(build(config)).rejects.toThrow('fixture output failed');
      expect(sink.mock.calls.flat().join('')).toContain('仍运行上次成功构建');
      expect(sink.mock.calls.flat().join('')).not.toContain('构建完成');
      fail = false;
      await build(config);
      expect(sink.mock.calls.flat().join('')).toContain('构建已恢复');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('仅主进程后续成功写出才标记重启，失败不改变下个子进程环境', () => {
  vi.stubEnv('WEQ_DEV_CONSOLE', '1');
  vi.stubEnv('WEQ_DEV_RESTART', '');
  const plugin = successfulDevelopmentReload('main');
  const reload = vi.fn();
  const watcher = { name: 'vite:electron-watcher', closeBundle: reload };
  hook(plugin, 'configResolved', { build: { watch: {} }, plugins: [watcher] });
  const close = () =>
    Reflect.apply((watcher.closeBundle as unknown as { handler: () => void }).handler, {}, []);
  hook(plugin, 'buildStart');
  hook(plugin, 'writeBundle');
  close();
  expect(process.env.WEQ_DEV_RESTART).not.toBe('1');
  hook(plugin, 'buildStart');
  close();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(process.env.WEQ_DEV_RESTART).not.toBe('1');
  hook(plugin, 'buildStart');
  hook(plugin, 'writeBundle');
  close();
  expect(process.env.WEQ_DEV_RESTART).toBe('1');
  expect(Number(process.env.WEQ_DEV_STARTED_AT)).toBeGreaterThan(0);
});
