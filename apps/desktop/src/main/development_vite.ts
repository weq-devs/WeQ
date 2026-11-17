import type { Logger, Plugin } from 'vite';
import { stripVTControlCharacters } from 'node:util';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  developmentRecord,
  isDevelopmentBuildTiming,
  summarizeDevelopmentBuildWarning,
} from './development_console';

type Target = 'main' | 'preload' | 'web' | 'renderer';
type InitialSummary = (target: Target, durationMs: number) => boolean;
const duration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${Number((ms / 1000).toFixed(2))}s`);

/** 仅同一开发配置中的首次主进程和预加载构建共享摘要。 */
export function developmentBuildSummary(
  sink = (line: string) => process.stderr.write(line),
): InitialSummary {
  const completed = new Map<Target, number>();
  return (target, durationMs) => {
    if ((target !== 'main' && target !== 'preload') || completed.has(target)) return false;
    completed.set(target, durationMs);
    if (completed.size === 2)
      sink(
        developmentRecord(
          'info',
          `初始构建完成  主进程 ${duration(completed.get('main')!)}；预加载 ${duration(completed.get('preload')!)}`,
          { scope: 'build' },
        ),
      );
    return true;
  };
}

export function developmentViteLogging(
  target: Target,
  env = process.env,
  sink = (line: string) => process.stderr.write(line),
  now = () => performance.now(),
  initialSummary?: InitialSummary,
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
  let serving = false;
  let successful = false;
  let failed = false;
  let emitted = false;
  let failureReported = false;
  let progress: ReturnType<typeof setTimeout> | undefined;
  let hmrTimer: ReturnType<typeof setTimeout> | undefined;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  const updates = new Set<string>();
  const recent: string[] = [];
  const repeats = new Map<string, number>();
  const warned = new Set<string>();
  let errors = new WeakSet<object>();
  const ineffectiveImports = new Set<string>();
  const write = (level: 'info' | 'warn' | 'error', text: string) => {
    const lines = stripVTControlCharacters(text).trim().split(/\r?\n/);
    const message = lines.shift() ?? '';
    sink(developmentRecord(level, message, { scope }));
    for (const line of lines) sink(`         ${line}\n`);
  };
  const stopProgress = () => {
    clearTimeout(progress);
    progress = undefined;
  };
  const remember = (text: string) => {
    recent.push(text.slice(-2048));
    if (recent.length > 12) recent.shift();
  };
  const diagnostics = () => {
    if (!recent.length) return;
    write('info', `最近的构建输出：\n${recent.join('\n')}`);
    recent.length = 0;
  };
  const flushUpdates = () => {
    clearTimeout(hmrTimer);
    hmrTimer = undefined;
    if (updates.size) {
      if (failed) {
        flushWarnings();
        warned.clear();
        errors = new WeakSet<object>();
      }
      write('info', `${failed ? '热更新已恢复；' : ''}已推送热更新  ${updates.size} 个文件`);
      failed = false;
    }
    updates.clear();
  };
  const flushWarnings = () => {
    clearTimeout(warningTimer);
    warningTimer = undefined;
    const count = [...repeats.values()].reduce((sum, value) => sum + value - 1, 0);
    if (count) write('warn', `另有 ${count} 次重复警告`);
    repeats.clear();
  };
  const failBuild = (error?: { message: string; stack?: string } | null, text?: string) => {
    stopProgress();
    failed = true;
    diagnostics();
    if (failureReported) return;
    failureReported = true;
    const previous = successful ? '；仍运行上次成功构建' : '；尚无本轮成功产物';
    const frame =
      error && 'frame' in error && typeof error.frame === 'string'
        ? error.frame
        : error?.stack?.split('\n').slice(1).join('\n');
    const loc =
      error && 'loc' in error && error.loc && typeof error.loc === 'object' ? error.loc : undefined;
    const file =
      loc && 'file' in loc && typeof loc.file === 'string'
        ? loc.file
        : error && 'id' in error && typeof error.id === 'string'
          ? error.id
          : undefined;
    const line = loc && 'line' in loc && typeof loc.line === 'number' ? loc.line : undefined;
    const column =
      loc && 'column' in loc && typeof loc.column === 'number' ? loc.column : undefined;
    const location = file
      ? `\nfile: ${file}${line === undefined ? '' : `:${line}`}${column === undefined ? '' : `:${column}`}`
      : '';
    const detail =
      !error || errors.has(error)
        ? ''
        : `\n${text ?? error.message}${!text ? `${location}${frame ? `\n${frame}` : ''}` : ''}`;
    if (error) errors.add(error);
    write('error', `${title}失败${previous}${detail}`);
  };
  const logger: Logger = {
    hasWarned: false,
    info(text) {
      const clean = stripVTControlCharacters(text).trim();
      if (clean.includes('\n')) {
        for (const line of clean.split(/\r?\n/)) logger.info(line);
        return;
      }
      const update = /^(?:\(\w+\)\s+)?hmr update\s+(.+)$/.exec(clean);
      if (update) {
        for (const path of update[1]!
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean)) {
          updates.add(path);
          if (updates.size >= 256) flushUpdates();
        }
        hmrTimer ??= setTimeout(flushUpdates, 100).unref();
      } else if (
        /^(?:vite v\S+ building .+|watching for file changes\.\.\.|build started\.\.\.|built in \d+ms\.|\[optimizer\] (?:scanning|bundling) dependencies\.\.\.|Re-optimizing dependencies because (?:lockfile|vite config) has changed|dev server running for the electron renderer process at:|➜\s+Network: use --host to expose)$/.test(
          clean,
        ) ||
        (building &&
          /^(?:transforming(?: \(\d+\))?\.\.\.|rendering chunks\.\.\.|computing gzip size\.\.\.|✓ \d+ modules transformed\.|✓ built in [\d.]+(?:ms|s)|\S+\s+[\d.]+\s*(?:kB|KB|MB)(?:\s*[│|]\s*(?:gzip|map):\s*[\d.]+\s*(?:kB|KB|MB))*)$/.test(
            clean,
          ))
      )
        remember(clean);
      else if (/^➜\s+Local:\s+/.test(clean))
        write('info', clean.replace(/^➜\s+Local:\s+/, '开发服务已启动  '));
      else if (clean) write('info', clean);
    },
    warn(text) {
      const clean = stripVTControlCharacters(text);
      if (isDevelopmentBuildTiming(clean)) return;
      logger.hasWarned = true;
      const ineffective =
        /^\[INEFFECTIVE_DYNAMIC_IMPORT\] (.+?) is dynamically imported by [\s\S]+dynamic import will not move module into another chunk\.?\s*$/.exec(
          clean,
        );
      if (building && ineffective && ineffectiveImports.size < 128)
        ineffectiveImports.add(ineffective[1]!);
      else {
        const key = createHash('sha256').update(clean).digest('hex');
        if (repeats.size >= 128 && !repeats.has(key)) flushWarnings();
        const count = repeats.get(key) ?? 0;
        repeats.set(key, count + 1);
        if (!count) write('warn', summarizeDevelopmentBuildWarning(clean));
        if (!building)
          warningTimer ??= setTimeout(() => {
            flushWarnings();
            warned.clear();
          }, 30_000).unref();
      }
    },
    warnOnce(text) {
      const key = createHash('sha256').update(text).digest('hex');
      if (!warned.has(key)) {
        if (warned.size >= 128) warned.clear();
        warned.add(key);
        logger.warn(text);
      }
    },
    error(text, options) {
      flushUpdates();
      flushWarnings();
      diagnostics();
      if (/^✗ Build failed in [\d.]+(?:ms|s)\s*$/.test(stripVTControlCharacters(text))) {
        if (!failureReported) failBuild(options?.error);
        return;
      }
      if (!serving && options?.error && !failureReported) {
        failBuild(options.error, text);
        return;
      }
      if (serving) failed = true;
      if (options?.error && errors.has(options.error)) return;
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
    configResolved(config) {
      serving = config.command === 'serve';
      if (serving) building = false;
    },
    configureServer(server) {
      server.httpServer?.once('close', () => {
        flushUpdates();
        flushWarnings();
      });
    },
    buildStart() {
      if (serving) return;
      building = true;
      emitted = false;
      failureReported = false;
      errors = new WeakSet<object>();
      flushWarnings();
      warned.clear();
      recent.length = 0;
      ineffectiveImports.clear();
      started = now();
      stopProgress();
      const report = () => {
        write('info', `${title}仍在进行  已耗时 ${duration(Math.round(now() - started))}`);
        progress = setTimeout(report, 15_000).unref();
      };
      progress = setTimeout(report, 3000).unref();
    },
    buildEnd(error) {
      if (error) failBuild(error);
    },
    renderError(error) {
      failBuild(error);
    },
    writeBundle() {
      emitted = true;
    },
    closeBundle() {
      stopProgress();
      if (serving) flushUpdates();
      if (emitted && !failureReported) {
        emitted = false;
        const durationMs = Math.round(now() - started);
        const recovered = failed;
        const incremental = successful;
        successful = true;
        failed = false;
        const summarized = initialSummary?.(target, durationMs);
        if (summarized && recovered) write('info', `${title}已恢复`);
        if (!summarized)
          sink(
            developmentRecord(
              'info',
              `${incremental ? title.replace('构建', '增量构建') : title}完成${recovered ? '（构建已恢复）' : ''}`,
              { scope, durationMs },
            ),
          );
      }
      flushWarnings();
      if (ineffectiveImports.size) {
        write(
          'warn',
          `${ineffectiveImports.size} 项动态导入未形成分包：${[...ineffectiveImports].map((path) => basename(path)).join('、')}（完整引用链见 debug 日志）`,
        );
        ineffectiveImports.clear();
      }
      building = false;
      recent.length = 0;
    },
  };
  return { config: { customLogger: logger, logLevel: 'warn' }, plugins: [plugin] };
}
