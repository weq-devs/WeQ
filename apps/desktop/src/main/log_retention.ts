import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_APP_SETTINGS,
  archiveHistoricalLogs,
  getActiveLogPath,
  getLogDir,
  getLogger,
  isHistoricalWeqLog,
  logErrorContext,
  logFileSource,
  planExpiredLogs,
  scanLogFiles,
  type AppSettings,
  type LogFileEntry,
} from '@weq/service';
import { getNativeLogRoot } from '@weq/native';
import type { LogPrunePreview } from '../shared/settings_reset';

const logger = getLogger().child({ scope: 'log-retention' });
const MIB = 1024 * 1024;
const AGE_SWEEP_MS = 6 * 60 * 60 * 1000;

type LogPolicy = Pick<AppSettings, 'logRetentionDays' | 'logCapacityMiB'>;

export function logRootKey(path: string): string {
  let canonical = resolve(path);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // 日志目录可在首次写入时才创建。
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function logRoots(appDir = getLogDir()): string[] {
  const roots = new Map<string, string>();
  if (appDir) roots.set(logRootKey(appDir), resolve(appDir));
  try {
    const nativeDir = resolve(getNativeLogRoot());
    const key = logRootKey(nativeDir);
    if (!roots.has(key)) roots.set(key, nativeDir);
  } catch {
    // 原生组件尚未初始化时，下次再查找。
  }
  return [...roots.values()];
}

function isClosedWeqLog(file: LogFileEntry, now: Date): boolean {
  // gzip 已完成封段。其他实例仍在写入的明文分段及旧版当天日志继续保留。
  return file.archived || isHistoricalWeqLog(basename(file.path), now.toISOString().slice(0, 10));
}

function appLogFiles(entries: LogFileEntry[], now = new Date()) {
  const files = entries.filter((file) => file.kind === 'weq');
  const history = files.filter((file) => isClosedWeqLog(file, now));
  return {
    history,
    bytes: files.reduce((total, file) => total + file.size, 0),
    files: files.length,
    historyFiles: history.length,
  };
}

export function appLogStorage() {
  const dir = getLogDir();
  const { bytes, files, historyFiles } = appLogFiles(dir ? scanLogFiles(dir) : []);
  return { bytes, files, historyFiles };
}

export function planLogRetention(policy: LogPolicy, now = new Date()) {
  const rawAppDir = getLogDir();
  const appDir = rawAppDir ? resolve(rawAppDir) : null;
  const appEntries = appDir ? scanLogFiles(appDir) : [];
  const app = appLogFiles(appEntries, now);
  const active = getActiveLogPath();
  const expired = (policy.logRetentionDays > 0 ? logRoots(appDir) : []).flatMap((dir) => {
    const candidates = (dir === appDir ? appEntries : scanLogFiles(dir)).filter(
      (file) => file.path !== active && (file.kind !== 'weq' || isClosedWeqLog(file, now)),
    );
    const names = new Set(
      planExpiredLogs(
        candidates.map(({ name, mtime }) => ({ name, mtimeMs: mtime })),
        policy.logRetentionDays,
        now,
      ),
    );
    return candidates.filter(({ name }) => names.has(name));
  });
  const identities = new Map(expired.map((file) => [logFileSource(file), file.identity]));
  const capacityBytes = policy.logCapacityMiB * MIB;
  let remaining = app.history.reduce(
    (bytes, file) => (identities.has(logFileSource(file)) ? bytes - file.size : bytes),
    app.bytes,
  );
  let capacityFiles = 0;
  for (const file of app.history.sort(
    (a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name),
  )) {
    if (!capacityBytes || remaining <= capacityBytes) break;
    const path = logFileSource(file);
    if (identities.has(path)) continue;
    identities.set(path, file.identity);
    remaining -= file.size;
    capacityFiles++;
  }
  return {
    targets: new Set(identities.keys()),
    identities,
    preview: {
      bytes: app.bytes,
      expiredFiles: expired.length,
      capacityFiles,
    },
  };
}

export function planDefaultLogRetention(current: LogPolicy) {
  const defaults = DEFAULT_APP_SETTINGS;
  if (
    current.logRetentionDays === defaults.logRetentionDays &&
    current.logCapacityMiB === defaults.logCapacityMiB
  )
    return null;
  return planLogRetention(defaults);
}

export function describeLogPrune(
  plan: ReturnType<typeof planLogRetention> | null,
): LogPrunePreview | null {
  if (!plan?.targets.size) return null;
  const { expiredFiles, capacityFiles } = plan.preview;
  return {
    expiredFiles,
    capacityFiles,
    confirmation: createHash('sha256')
      .update(JSON.stringify([expiredFiles, capacityFiles, [...plan.identities].sort()]))
      .digest('hex'),
  };
}

export function assertLogPruneConfirmed(
  plan: ReturnType<typeof planLogRetention> | null,
  confirmation?: string | null,
) {
  if (describeLogPrune(plan)?.confirmation !== (confirmation ?? undefined))
    throw new TRPCError({ code: 'CONFLICT', message: '预计删除的日志已变化，请重新确认。' });
}

function removeLogs(paths: Iterable<string>, identities?: ReadonlyMap<string, string>) {
  let removed = 0;
  let failed = 0;
  for (const path of paths) {
    try {
      if (identities) {
        const stat = lstatSync(path);
        const identity = stat.ino ? `${stat.dev}:${stat.ino}` : path;
        if (!stat.isFile() || identities.get(path) !== identity) {
          failed++;
          continue;
        }
      }
      unlinkSync(path);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed++;
    }
  }
  return { removed, failed };
}

export function clearAppLogHistory() {
  const dir = getLogDir();
  const { history } = appLogFiles(dir ? scanLogFiles(dir) : []);
  return removeLogs(history.map(logFileSource));
}

export function runLogRetentionSweep(policy: LogPolicy, plan = planLogRetention(policy)) {
  const result = removeLogs(plan.targets, plan.identities);
  archiveHistoricalLogs();
  if (result.removed || result.failed)
    logger.info('pruned log files', { event: 'log-prune', ...result });
  return result;
}

export function startLogRetention(readPolicy: () => LogPolicy): () => void {
  let lastSweep = 0;
  function sweep() {
    try {
      const policy = readPolicy();
      if (!policy.logCapacityMiB && Date.now() - lastSweep < AGE_SWEEP_MS) return;
      lastSweep = Date.now();
      runLogRetentionSweep(policy);
    } catch (error) {
      logger.warn('log retention sweep failed', {
        event: 'log-prune-failed',
        ...logErrorContext(error),
      });
    }
  }
  sweep();
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
