/**
 * Export task manager: schedule, track, pause/cancel conversations exports.
 * Tasks persist to JSON and survive restarts.
 */

import { EventEmitter, once } from 'node:events';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { MsgService } from '../msg';
import { exportGroupToJson } from './json_exporter';
import { exportGroupToTxt } from './txt_exporter';
import { exportGroupToJsonl } from './jsonl_exporter'
import { iterateGroupMessages, iterateC2cMessages, toExportedMessage } from './message_source';
import { runGroupExport, type Framing } from './run_export';
import { bigintReplacer } from './serialize';
import { messageToText } from './element_text';
import type { ExportFormat, ExportResult } from './types';

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ConvKind = 'group' | 'c2c';

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
      const outPath = join(this.cacheDir, `${task.name}.${task.format}`);
      const progressEvery = 1000;

      const onProgress = (p: { current: number; message: string }) => {
        if (abort.signal.aborted) return;
        task.current = p.current;
        task.progress = task.total > 0 ? Math.min(Math.floor((p.current / task.total) * 100), 99) : 0;
        task.updatedAt = Date.now();
        this.emit('progress', { taskId: id, status: 'running', progress: task.progress, current: p.current, message: p.message });
      };

      let result: ExportResult;
      if (task.kind === 'group') {
        if (task.format === 'json') {
          result = await exportGroupToJson(this.msgs, { groupCode: task.conv, outputPath: outPath, progressEvery, onProgress });
        } else if (task.format === 'jsonl') {
          result = await exportGroupToJsonl(this.msgs, { groupCode: task.conv, outputPath: outPath, progressEvery, onProgress });
        } else {
          result = await exportGroupToTxt(this.msgs, { groupCode: task.conv, outputPath: outPath, progressEvery, onProgress });
        }
      } else {
        result = await this.exportC2c(task.conv, outPath, task.format, progressEvery, onProgress);
      }

      if (abort.signal.aborted) {
        task.status = 'cancelled';
      } else {
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

  private async exportC2c(peerUid: string, outPath: string, format: ExportFormat, progressEvery: number, onProgress: (p: any) => void): Promise<ExportResult> {
    const framing: Framing = format === 'json' ? { head: '[\n', between: ',\n', tail: '\n]\n' } : { head: '', between: '', tail: '' };
    const renderRecord = format === 'txt' ? (m: any) => `${messageToText(m)}\n` : (m: any) => format === 'jsonl' ? `${JSON.stringify(m, bigintReplacer)}\n` : JSON.stringify(m, bigintReplacer);

    const start = Date.now();
    const { createWriteStream, statSync } = await import('node:fs');
    const stream = createWriteStream(outPath, { encoding: 'utf-8' });
    const write = async (chunk: string): Promise<void> => {
      if (!stream.write(chunk)) await once(stream, 'drain');
    };

    let count = 0;
    try {
      if (framing.head) await write(framing.head);
      for await (const m of iterateC2cMessages(this.msgs, peerUid, { pageSize: 2000 })) {
        const record = renderRecord(toExportedMessage(m));
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

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') this.abortControllers.get(id)?.abort();
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    if (task.filePath && existsSync(task.filePath)) {
      try {
        unlinkSync(task.filePath);
      } catch {}
    }
    this.saveTasks();
    this.emit('progress', { taskId: id, status: 'cancelled', progress: task.progress, current: task.current, message: '已取消' });
    return true;
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') return false;
    if (task.filePath && existsSync(task.filePath)) {
      try {
        unlinkSync(task.filePath);
      } catch {}
    }
    this.tasks.delete(id);
    this.saveTasks();
    return true;
  }
}
