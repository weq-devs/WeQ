import type { Logger, Plugin } from 'vite';
import { stripVTControlCharacters } from 'node:util';
import { developmentRecord } from './development_console';

export function developmentViteLogging(
  target: 'main' | 'preload' | 'web' | 'renderer',
  env = process.env,
  sink = (line: string) => process.stderr.write(line),
  now = () => performance.now(),
): { config: { customLogger?: Logger; logLevel?: 'warn' }; plugins: Plugin[] } {
  if (env.WEQ_DEV_CONSOLE !== '1' || env.WEQ_LOG_LEVEL === 'debug')
    return { config: {}, plugins: [] };
  const scope = `vite-${target}`;
  const title = {
    main: '主进程构建',
    preload: '预加载构建',
    web: '内置 Web 构建',
    renderer: '界面构建',
  }[target];
  let started = 0;
  let building = target !== 'renderer';
  const warned = new Set<string>();
  const errors = new WeakSet<object>();
  const write = (level: 'info' | 'warn' | 'error', text: string) => {
    const lines = stripVTControlCharacters(text).trim().split(/\r?\n/);
    const message = lines.shift() ?? '';
    sink(developmentRecord(level, message, { scope }));
    for (const line of lines) sink(`         ${line}\n`);
  };
  const logger: Logger = {
    hasWarned: false,
    info(text) {
      if (building) return;
      const clean = stripVTControlCharacters(text).trim();
      const update = /^(?:\(\w+\)\s+)?hmr update\s+(.+)$/.exec(clean);
      if (update)
        write(
          'info',
          `热更新 ${[...new Set(update[1]!.split(',').map((path) => path.trim()))].join(', ')}`,
        );
      else if (clean === 'dev server running for the electron renderer process at:')
        write('info', '界面开发服务已启动');
      else if (clean) write('info', clean);
    },
    warn(text) {
      logger.hasWarned = true;
      write('warn', text);
    },
    warnOnce(text) {
      if (!warned.has(text)) {
        warned.add(text);
        logger.warn(text);
      }
    },
    error(text, options) {
      if (options?.error) errors.add(options.error);
      write('error', text);
    },
    hasErrorLogged(error) {
      return errors.has(error);
    },
    clearScreen() {
      /* 开发终端始终保留历史。 */
    },
  };
  const plugin: Plugin = {
    name: `weq-development-summary-${target}`,
    buildStart() {
      building = true;
      started = now();
      write('info', `${title}开始`);
    },
    writeBundle(_options, bundle) {
      sink(
        developmentRecord('info', `${title}完成`, {
          scope,
          durationMs: Math.round(now() - started),
          count: Object.keys(bundle).length,
        }),
      );
    },
    closeBundle() {
      building = false;
    },
  };
  return { config: { customLogger: logger, logLevel: 'warn' }, plugins: [plugin] };
}
