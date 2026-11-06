import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { DatabasePriority, MessageWorkPhase } from './query_schedule';

const QUERY_LIMIT = 256;
export const ACTIVE_QUERY_DIAGNOSTIC_LIMIT = 64;
type Operation = 'message.window' | MessageWorkPhase;
interface Request {
  id: number;
  operation: Operation;
  queryCount: number;
  startedAtMs: number;
  endedAtMs?: number;
  outcome?: 'ok' | 'failed' | 'cancelled';
}
const context = new AsyncLocalStorage<{ request?: Request; phase?: MessageWorkPhase }>();
let nextRequest = 0;
let nextQuery = 0;

export interface QuerySource {
  fingerprint: string;
  caller: string;
}
export interface QueryTrace {
  id: number;
  source: QuerySource;
  request?: Request;
  phase?: MessageWorkPhase;
  priority: DatabasePriority;
  queuedAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  outcome: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  rows?: number;
  runningWhenQueued?: number;
}
const recent: Array<{ path: string; trace: QueryTrace }> = [];

export const databaseDiagnosticsEnabled = () => process.env.WEQ_DATABASE_DIAGNOSTICS === '1';

/** 仅对受控诊断计算查询指纹；不保留 SQL、参数、文件路径或错误正文。 */
export function queryDiagnosticSource(sql: string): QuerySource | undefined {
  if (!databaseDiagnosticsEnabled()) return undefined;
  const caller = new Error().stack
    ?.split('\n')
    .slice(2)
    .map((frame) => /^\s*at (?:async )?([\w.$]+)(?: \(|$)/.exec(frame)?.[1])
    .find((name) => name && name !== 'QqDb.query' && name !== 'QqDb.write');
  return {
    fingerprint: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    caller: caller && /^[\w.$]{1,100}$/.test(caller) ? caller : 'unknown',
  };
}

export async function withDatabaseRequest<T>(
  operation: Operation,
  run: () => Promise<T>,
): Promise<T> {
  if (!databaseDiagnosticsEnabled()) return run();
  const parent = context.getStore();
  if (parent?.request) return run();
  const request: Request = {
    id: ++nextRequest,
    operation,
    queryCount: 0,
    startedAtMs: performance.now(),
  };
  try {
    const result = await context.run({ ...parent, request }, run);
    request.outcome = 'ok';
    return result;
  } catch (error) {
    request.outcome =
      error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
    throw error;
  } finally {
    request.endedAtMs = performance.now();
  }
}

export function withDatabaseWorkPhase<T>(
  phase: MessageWorkPhase,
  run: () => Promise<T>,
): Promise<T> {
  if (!databaseDiagnosticsEnabled()) return run();
  return withDatabaseRequest(phase, () => context.run({ ...context.getStore(), phase }, run));
}

export function beginQueryTrace(
  path: string,
  priority: DatabasePriority,
  source?: QuerySource,
  running?: QueryTrace,
): QueryTrace | undefined {
  if (!databaseDiagnosticsEnabled()) return undefined;
  const scope = context.getStore();
  if (scope?.request) scope.request.queryCount++;
  const trace: QueryTrace = {
    id: ++nextQuery,
    source: {
      fingerprint:
        source && /^[a-f0-9]{16}$/.test(source.fingerprint) ? source.fingerprint : 'unknown',
      caller: source && /^[\w.$]{1,100}$/.test(source.caller) ? source.caller : 'unknown',
    },
    request: scope?.request,
    phase: scope?.phase,
    priority,
    queuedAtMs: performance.now(),
    outcome: 'queued',
    runningWhenQueued: running?.id,
  };
  recent.push({ path, trace });
  if (recent.length > QUERY_LIMIT) recent.shift();
  return trace;
}

export function databaseQueryDiagnostics(path: string, active: QueryTrace[] = []) {
  if (!databaseDiagnosticsEnabled()) return { enabled: false, requests: [], queries: [] };
  const now = performance.now();
  const traces = [
    ...new Map([
      ...recent
        .filter((entry) => entry.path === path)
        .map(({ trace }) => [trace.id, trace] as const),
      ...active.slice(0, ACTIVE_QUERY_DIAGNOSTIC_LIMIT).map((trace) => [trace.id, trace] as const),
    ]).values(),
  ];
  const requests = [
    ...new Map(
      traces.flatMap((trace) =>
        trace.request ? [[trace.request.id, trace.request] as const] : [],
      ),
    ).values(),
  ];
  return {
    enabled: true,
    clockOriginMs: performance.timeOrigin,
    sampledAtMs: now,
    recentLimit: QUERY_LIMIT,
    requests: requests.map((request) => ({
      ...request,
      elapsedMs: (request.endedAtMs ?? now) - request.startedAtMs,
    })),
    queries: traces.map((trace) => ({
      id: trace.id,
      requestId: trace.request?.id ?? null,
      phase: trace.phase ?? null,
      priority: trace.priority,
      fingerprint: trace.source.fingerprint,
      caller: trace.source.caller,
      queuedAtMs: trace.queuedAtMs,
      startedAtMs: trace.startedAtMs ?? null,
      endedAtMs: trace.endedAtMs ?? null,
      jsQueueWaitMs: (trace.startedAtMs ?? trace.endedAtMs ?? now) - trace.queuedAtMs,
      nativePromiseAwaitMs:
        trace.startedAtMs === undefined ? null : (trace.endedAtMs ?? now) - trace.startedAtMs,
      outcome: trace.outcome,
      returnedRows: trace.rows ?? null,
      runningWhenQueued: trace.runningWhenQueued ?? null,
    })),
  };
}
