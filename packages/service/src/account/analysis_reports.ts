import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export interface SavedAnalysisRequest {
  id: string;
  kind: 'buddy' | 'group' | 'member';
  name: string;
  peerUid?: string;
  groupCode?: string;
  groupName?: string;
  memberUid?: string;
  memberUin?: string;
  period: string;
  scope: {
    expectedAccountUin: string;
    expectedAccountConfigId: string;
    startTime?: number;
    endTime?: number;
    messageIds?: string[];
  };
}
export interface SavedAnalysisReport {
  request: SavedAnalysisRequest;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  results: Record<string, unknown>;
  pending: Record<string, unknown>;
  completed: string[];
  logs: Array<{ ts: number; text: string }>;
  revision: number;
  resultRevision: number;
  position: number;
  updatedAt: number;
  error?: string;
  taskHidden?: boolean;
}
export type AnalysisReportSummary = Omit<SavedAnalysisReport, 'results' | 'pending'>;
export type AnalysisResultVersion = Pick<
  SavedAnalysisReport,
  'request' | 'results' | 'resultRevision' | 'updatedAt'
>;
export type AnalysisStageRunner = (
  request: SavedAnalysisRequest,
  stage: string,
  signal: AbortSignal,
) => Promise<unknown>;

// SQLite 与压缩仅在 worker 执行；计算结果保留 BigInt、Map 等原有类型。
function reportWorker() {
  const { parentPort, workerData } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { dirname } = require('node:path') as typeof import('node:path');
  const { serialize, deserialize } = require('node:v8') as typeof import('node:v8');
  const { deflateSync, inflateSync } = require('node:zlib') as typeof import('node:zlib');
  mkdirSync(dirname(workerData.path), { recursive: true });
  const db = new DatabaseSync(workerData.path);
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, meta TEXT NOT NULL, payload BLOB NOT NULL); CREATE TABLE IF NOT EXISTS result_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, meta TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(id,revision))',
  );
  for (const row of db.prepare('SELECT id, meta FROM reports').all()) {
    const meta = JSON.parse(String(row.meta));
    if (meta.status === 'running') {
      meta.status = 'paused';
      db.prepare('UPDATE reports SET meta=? WHERE id=?').run(JSON.stringify(meta), String(row.id));
    }
  }
  parentPort!.on(
    'message',
    ({
      id,
      method,
      input,
    }: {
      id: number;
      method: string;
      input: SavedAnalysisReport & { id: string; version: number };
    }) => {
      try {
        let value: unknown;
        if (method === 'put') {
          const { results, pending, ...meta } = input;
          const previous = db.prepare('SELECT meta FROM reports WHERE id=?').get(input.request.id);
          if (previous) meta.position = JSON.parse(String(previous.meta)).position;
          db.prepare(
            'INSERT INTO reports VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,payload=excluded.payload',
          ).run(
            input.request.id,
            JSON.stringify(meta),
            deflateSync(serialize({ results, pending })),
          );
          if (input.status === 'completed' && input.resultRevision > 0) {
            db.prepare('INSERT OR IGNORE INTO result_versions VALUES (?,?,?,?)').run(
              input.request.id,
              input.resultRevision,
              JSON.stringify({
                request: input.request,
                resultRevision: input.resultRevision,
                updatedAt: input.updatedAt,
              }),
              deflateSync(serialize(results)),
            );
          }
        } else if (method === 'versions') {
          value = db
            .prepare('SELECT meta FROM result_versions WHERE id=? ORDER BY revision DESC')
            .all(input.id)
            .map((row) => JSON.parse(String(row.meta)));
        } else if (method === 'version') {
          const row = db
            .prepare('SELECT meta,payload FROM result_versions WHERE id=? AND revision=?')
            .get(input.id, input.version);
          value = row
            ? {
                ...JSON.parse(String(row.meta)),
                results: deserialize(inflateSync(row.payload as Uint8Array)),
              }
            : null;
        } else if (method === 'get') {
          const row = db.prepare('SELECT meta,payload FROM reports WHERE id=?').get(input.id);
          value = row
            ? {
                ...JSON.parse(String(row.meta)),
                ...deserialize(inflateSync(row.payload as Uint8Array)),
              }
            : null;
        } else if (method === 'list') {
          value = db
            .prepare("SELECT meta FROM reports ORDER BY json_extract(meta,'$.updatedAt') DESC")
            .all()
            .map((row) => JSON.parse(String(row.meta)));
        } else if (method === 'position') {
          const row = db.prepare('SELECT meta FROM reports WHERE id=?').get(input.id);
          if (row) {
            const meta = { ...JSON.parse(String(row.meta)), position: input.position };
            db.prepare('UPDATE reports SET meta=? WHERE id=?').run(JSON.stringify(meta), input.id);
          }
        } else if (method === 'remove') {
          db.prepare('DELETE FROM result_versions WHERE id=?').run(input.id);
          db.prepare('DELETE FROM reports WHERE id=?').run(input.id);
        } else if (method === 'close') db.close();
        else throw new Error('未知报告存储操作');
        parentPort!.postMessage({ id, value });
      } catch (error) {
        parentPort!.postMessage({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

export class AnalysisReportsService extends EventEmitter {
  private worker: Worker;
  private sequence = 0;
  private requests = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private runs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private closed = false;
  private failure?: Error;
  constructor(
    root: string,
    private readonly runStage: AnalysisStageRunner,
  ) {
    super();
    this.worker = new Worker(`(${reportWorker.toString()})()`, {
      eval: true,
      workerData: { path: join(root, 'reports.sqlite') },
      execArgv:
        Number(process.versions.node.split('.')[0]) === 22 &&
        Number(process.versions.node.split('.')[1]) < 13
          ? ['--experimental-sqlite']
          : [],
    });
    this.worker.unref();
    this.worker.on('message', (reply: { id: number; value: unknown; error?: string }) => {
      const request = this.requests.get(reply.id);
      this.requests.delete(reply.id);
      if (reply.error) request?.reject(new Error(reply.error));
      else request?.resolve(reply.value);
      if (!this.requests.size) this.worker.unref();
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => {
      if (!this.closing) fail(new Error(`报告存储已退出：${code}`));
    });
  }
  private call<T>(method: string, input: object = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('报告存储已关闭'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, method, input });
    });
  }
  list() {
    return this.call<AnalysisReportSummary[]>('list');
  }
  versions(id: string) {
    return this.call<Omit<AnalysisResultVersion, 'results'>[]>('versions', { id });
  }
  version(id: string, version: number) {
    return this.call<AnalysisResultVersion | null>('version', { id, version });
  }
  async get(id: string) {
    const report = await this.call<SavedAnalysisReport | null>('get', { id });
    if (!report) throw new Error('报告已不存在');
    return report;
  }
  private async save(report: SavedAnalysisReport) {
    report.updatedAt = Math.max(Date.now(), report.updatedAt + 1);
    await this.call('put', report);
    this.emit('changed', report.request.id);
  }
  async create(request: SavedAnalysisRequest) {
    if (this.closing) throw new Error('账号正在关闭');
    const existing = await this.call<SavedAnalysisReport | null>('get', { id: request.id });
    if (existing) {
      const identity = (value: SavedAnalysisRequest) =>
        JSON.stringify([
          value.kind,
          value.peerUid,
          value.groupCode,
          value.memberUid,
          value.memberUin,
          value.scope.expectedAccountUin,
          value.scope.expectedAccountConfigId,
          value.scope.messageIds,
        ]);
      if (identity(existing.request) !== identity(request))
        throw new Error('报告身份已被其他分析使用');
      return existing;
    }
    const report: SavedAnalysisReport = {
      request: structuredClone(request),
      status: 'paused',
      results: {},
      pending: {},
      completed: [],
      logs: [],
      revision: 1,
      resultRevision: 0,
      position: 0,
      updatedAt: Date.now(),
    };
    await this.save(report);
    return report;
  }
  async resume(id: string, refresh = false) {
    if (this.closing) throw new Error('账号正在关闭');
    if (this.runs.has(id)) return;
    const controller = new AbortController();
    const done = this.execute(id, controller.signal, refresh)
      .catch((error: unknown) => {
        this.emit('storageError', error);
      })
      .finally(() => this.runs.delete(id));
    this.runs.set(id, { controller, done });
  }
  private async execute(id: string, signal: AbortSignal, refresh: boolean) {
    const report = await this.get(id);
    if (report.status === 'completed' && !refresh) return;
    if (refresh) {
      report.pending = {};
      report.completed = [];
      report.revision++;
    }
    report.status = 'running';
    report.taskHidden = false;
    delete report.error;
    await this.save(report);
    const stages = report.request.kind === 'group' ? ['report', 'batches', 'graph'] : ['report'];
    try {
      for (const stage of stages) {
        if (report.completed.includes(stage)) continue;
        signal.throwIfAborted();
        const labels: Record<string, string> = {
          report: '消息统计',
          batches: '入群批次',
          graph: '关系图',
        };
        report.logs.push({ ts: Date.now(), text: `正在计算${labels[stage]}` });
        await this.save(report);
        const result = await this.runStage(report.request, stage, signal);
        signal.throwIfAborted();
        report.pending[stage] = result;
        report.completed.push(stage);
        await this.save(report);
      }
      report.results = report.pending;
      report.resultRevision = report.revision;
      report.pending = {};
      report.status = 'completed';
      report.logs.push({ ts: Date.now(), text: '报告已保存' });
    } catch (error) {
      report.status = signal.aborted ? (this.closing ? 'paused' : 'cancelled') : 'failed';
      report.error = error instanceof Error ? error.message : String(error);
      report.logs.push({
        ts: Date.now(),
        text: signal.aborted ? '分析已停止，可继续未完成阶段' : report.error,
      });
    }
    await this.save(report);
  }
  async cancel(id: string) {
    const run = this.runs.get(id);
    if (run) {
      run.controller.abort();
      await run.done;
    } else {
      const report = await this.get(id);
      if (report.status === 'completed') return;
      report.status = 'cancelled';
      await this.save(report);
    }
  }
  async position(id: string, position: number) {
    await this.call('position', { id, position });
  }
  async hideTask(id: string) {
    const report = await this.get(id);
    if (report.status === 'running') throw new Error('请先停止分析');
    report.taskHidden = true;
    await this.save(report);
  }
  async revise(id: string, range: { startTime: number; endTime: number }) {
    if (range.startTime > range.endTime) throw new Error('分析日期范围无效');
    if (this.runs.has(id)) await this.cancel(id);
    const report = await this.get(id);
    report.request.scope = { ...report.request.scope, ...range };
    await this.save(report);
    await this.resume(id, true);
  }
  async remove(id: string) {
    await this.cancel(id);
    await this.call('remove', { id });
    this.emit('changed', id);
  }
  async dispose() {
    this.closing = true;
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.all([...this.runs.values()].map((run) => run.done));
    try {
      await this.call('close');
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
  }
}
