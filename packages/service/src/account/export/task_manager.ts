/**
 * Export task manager: schedule, track, pause/cancel conversations exports.
 * Tasks persist to JSON and survive restarts.
 */

import { EventEmitter, once } from 'node:events';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MsgService } from '../msg';
import type { AvatarCacheService } from '../../bootstrap/avatar_cache';
import { exportGroupToJson } from './json_exporter';
import { exportGroupToTxt } from './txt_exporter';
import { exportGroupToJsonl } from './jsonl_exporter';
import { exportGroupToCsv, csvFraming, renderCsvRow } from './csv_exporter';
import { exportToXlsx } from './xlsx_exporter';
import { exportAvatars } from './avatar_export';
import { iterateC2cMessages, toExportedMessage } from './message_source';
import { type Framing } from './run_export';
import { bigintReplacer } from './serialize';
import { messageToText } from './element_text';
import type { ConvKind, ExportedMessage, ExportFormat, ExportResult, ExportTimeRange, GroupExportOptions } from './types';

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type { ConvKind };

export interface ExportTask {
  id: string;
  kind: ConvKind;
  conv: string; // groupCode or peerUid
  name: string;
  format: ExportFormat;
  status: TaskStatus;
  progress: number; // 0-100
  current: number; // messages exported
  total: number; // total messages (estimate)
  error?: string;
  filePath?: string; // cache file path when completed
  /** True when sender avatars were requested (output is a bundle folder). */
  exportAvatar?: boolean;
  /** Inclusive send-time window for this export, if narrowed from 全部时间. */
  range?: ExportTimeRange;
  /** Bundle folder (message file + avatars/) when `exportAvatar` is on. */
  bundleDir?: string;
  /** Number of avatars written, when avatars were exported. */
  avatarCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskProgress {
  taskId: string;
  status: TaskStatus;
  progress: number;
  current: number;
  message: string;
}

export class ExportTaskManager extends EventEmitter {
  private tasks = new Map<string, ExportTask>();
  private abortControllers = new Map<string, AbortController>();
  private persistPath: string;

  constructor(
    private msgs: MsgService,
    private cacheDir: string,
    /** Resolves avatar bytes (cache-first, CDN fallback) for avatar export. */
    private avatarCache?: AvatarCacheService,
  ) {
    super();
    this.persistPath = join(cacheDir, 'export_tasks.json');
    this.loadTasks();
  }

  private loadTasks(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, 'utf-8')) as ExportTask[];
      for (const t of data) {
        if (t.status === 'running') t.status = 'paused'; // crashed tasks → paused
        this.tasks.set(t.id, t);
      }
    } catch (e) {
      console.error('[ExportTaskManager] failed to load tasks:', e);
    }
  }

  private saveTasks(): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.tasks.values()], null, 2), 'utf-8');
    } catch (e) {
      console.error('[ExportTaskManager] failed to save tasks:', e);
    }
  }

  override emit(event: 'progress', data: TaskProgress): boolean {
    return super.emit(event, data);
  }

  listTasks(): ExportTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getTask(id: string): ExportTask | null {
    return this.tasks.get(id) ?? null;
  }

  async startTask(opts: {
    kind: ConvKind;
    conv: string;
    name: string;
    format: ExportFormat;
    total: number;
    exportAvatar?: boolean;
    range?: ExportTimeRange;
  }): Promise<string> {
    const id = `${opts.kind}-${opts.conv}-${Date.now()}`;
    const task: ExportTask = {
      id,
      kind: opts.kind,
      conv: opts.conv,
      name: opts.name,
      format: opts.format,
      status: 'pending',
      progress: 0,
      current: 0,
      total: opts.total,
      exportAvatar: opts.exportAvatar ?? false,
      ...(opts.range ? { range: opts.range } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.saveTasks();
    void this.runTask(id);
    return id;
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();
    this.emit('progress', { taskId: id, status: 'running', progress: 0, current: 0, message: '开始导出' });

    const abort = new AbortController();
    this.abortControllers.set(id, abort);

    try {
      // With avatar export on, the message file + avatars/ live together in a
      // per-task bundle folder; otherwise the file sits directly in the cache.
      const wantAvatars = Boolean(task.exportAvatar && this.avatarCache);
      const outDir = wantAvatars ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (wantAvatars) mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${task.name}.${task.format}`);
      const progressEvery = 1000;
      const senders = wantAvatars ? new Set<string>() : undefined;

      const onProgress = (p: { current: number; message: string }) => {
        if (abort.signal.aborted) return;
        task.current = p.current;
        task.progress = task.total > 0 ? Math.min(Math.floor((p.current / task.total) * 100), 99) : 0;
        task.updatedAt = Date.now();
        this.emit('progress', { taskId: id, status: 'running', progress: task.progress, current: p.current, message: p.message });
      };

      const result = await this.exportMessages(task, outPath, progressEvery, onProgress, senders);

      if (abort.signal.aborted) {
        task.status = 'cancelled';
      } else {
        // Avatar phase: download every distinct sender's avatar into avatars/.
        if (wantAvatars && senders && this.avatarCache) {
          const avatars = await exportAvatars(this.avatarCache, senders, outDir, {
            onProgress: (done, total) => {
              if (abort.signal.aborted) return;
              this.emit('progress', { taskId: id, status: 'running', progress: task.progress, current: task.current, message: `下载头像 ${done}/${total}` });
            },
          });
          task.avatarCount = avatars.ok;
          task.bundleDir = outDir;
        }
        task.status = 'completed';
        task.progress = 100;
        task.current = result.messageCount;
        task.filePath = result.filePath;
      }
    } catch (e: any) {
      task.status = 'failed';
      task.error = String(e?.message ?? e);
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', { taskId: id, status: task.status, progress: task.progress, current: task.current, message: task.status === 'completed' ? '导出完成' : task.error ?? '已取消' });
    }
  }

  /** Dispatch one task to the right exporter by output format / conversation kind. */
  private exportMessages(
    task: ExportTask,
    outputPath: string,
    progressEvery: number,
    onProgress: (p: { current: number; message: string }) => void,
    senders: Set<string> | undefined,
  ): Promise<ExportResult> {
    // XLSX is a binary workbook, not a character stream — it has its own loop
    // and handles both conversation kinds itself.
    if (task.format === 'xlsx') {
      return exportToXlsx(this.msgs, {
        kind: task.kind,
        conv: task.conv,
        outputPath,
        progressEvery,
        onProgress,
        collectSenders: senders,
        range: task.range,
      });
    }
    if (task.kind === 'group') {
      const opts: GroupExportOptions = {
        groupCode: task.conv,
        outputPath,
        progressEvery,
        onProgress,
        collectSenders: senders,
        range: task.range,
      };
      switch (task.format) {
        case 'json':
          return exportGroupToJson(this.msgs, opts);
        case 'jsonl':
          return exportGroupToJsonl(this.msgs, opts);
        case 'csv':
          return exportGroupToCsv(this.msgs, opts);
        default:
          return exportGroupToTxt(this.msgs, opts);
      }
    }
    return this.exportC2c(task.conv, outputPath, task.format, progressEvery, onProgress, senders, task.range);
  }

  private async exportC2c(
    peerUid: string,
    outPath: string,
    format: ExportFormat,
    progressEvery: number,
    onProgress: (p: { current: number; message: string }) => void,
    senders?: Set<string>,
    range?: ExportTimeRange,
  ): Promise<ExportResult> {
    const framing: Framing =
      format === 'json'
        ? { head: '[\n', between: ',\n', tail: '\n]\n' }
        : format === 'csv'
          ? csvFraming
          : { head: '', between: '', tail: '' };
    const renderRecord: (m: ExportedMessage) => string =
      format === 'txt'
        ? (m) => `${messageToText(m)}\n`
        : format === 'csv'
          ? renderCsvRow
          : format === 'jsonl'
            ? (m) => `${JSON.stringify(m, bigintReplacer)}\n`
            : (m) => JSON.stringify(m, bigintReplacer);

    const start = Date.now();
    const { createWriteStream, statSync } = await import('node:fs');
    const stream = createWriteStream(outPath, { encoding: 'utf-8' });
    const write = async (chunk: string): Promise<void> => {
      if (!stream.write(chunk)) await once(stream, 'drain');
    };

    let count = 0;
    try {
      if (framing.head) await write(framing.head);
      for await (const m of iterateC2cMessages(this.msgs, peerUid, { pageSize: 2000, range })) {
        const exported = toExportedMessage(m);
        senders?.add(exported.senderUin);
        const record = renderRecord(exported);
        await write(count === 0 ? record : framing.between + record);
        count += 1;
        if (count % progressEvery === 0) onProgress({ current: count, message: `已导出 ${count} 条` });
      }
      if (framing.tail) await write(framing.tail);
    } finally {
      stream.end();
      await once(stream, 'finish');
    }

    return { filePath: outPath, format, messageCount: count, fileSize: statSync(outPath).size, durationMs: Date.now() - start };
  }

  pauseTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;
    this.abortControllers.get(id)?.abort();
    task.status = 'paused';
    task.updatedAt = Date.now();
    this.saveTasks();
    this.emit('progress', { taskId: id, status: 'paused', progress: task.progress, current: task.current, message: '已暂停' });
    return true;
  }

  /** Remove a task's on-disk output (the whole bundle folder, or the lone file). */
  private cleanupOutput(task: ExportTask): void {
    try {
      if (task.bundleDir && existsSync(task.bundleDir)) {
        rmSync(task.bundleDir, { recursive: true, force: true });
      } else if (task.filePath && existsSync(task.filePath)) {
        unlinkSync(task.filePath);
      }
    } catch {}
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') this.abortControllers.get(id)?.abort();
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    this.cleanupOutput(task);
    this.saveTasks();
    this.emit('progress', { taskId: id, status: 'cancelled', progress: task.progress, current: task.current, message: '已取消' });
    return true;
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') return false;
    this.cleanupOutput(task);
    this.tasks.delete(id);
    this.saveTasks();
    return true;
  }
}
