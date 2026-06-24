/**
 * Export task manager: schedule, track, pause/cancel conversation exports.
 * Tasks persist to JSON and survive restarts.
 *
 * A task runs as a sequence of *stages*, each with its own progress
 * (message → [media → record → image] when 导出媒体 is on). The renderer shows
 * one progress bar per stage. A plain export (no avatars / no media) is just the
 * single `message` stage writing one file into the cache.
 */

import { EventEmitter, once } from 'node:events';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MsgService } from '../msg';
import type { AvatarCacheService } from '../../bootstrap/avatar_cache';
import type { MediaDownloadService } from '../media_download';
import { exportGroupToJson } from './json_exporter';
import { exportGroupToTxt } from './txt_exporter';
import { exportGroupToJsonl } from './jsonl_exporter';
import { exportGroupToCsv, csvFraming, renderCsvRow } from './csv_exporter';
import { exportToXlsx } from './xlsx_exporter';
import { exportAvatars } from './avatar_export';
import { copyFoundMedia, decodeFoundVoices, downloadMissingImages, type DecodeSilk } from './media_export';
import { scanConvMedia, mediaDirsFromAccountDir, type MediaDirs } from './media_scan';
import { iterateC2cMessages, toExportedMessage } from './message_source';
import { type Framing } from './run_export';
import { bigintReplacer } from './serialize';
import { messageToText, annotateLocalPaths } from './element_text';
import type { ConvKind, ExportedMessage, ExportFormat, ExportResult, ExportTimeRange, GroupExportOptions } from './types';

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type { ConvKind };

/** A single stage of a task's pipeline. */
export type StageKey = 'message' | 'media' | 'record' | 'image' | 'video' | 'file';

export interface TaskStage {
  key: StageKey;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  current: number;
  total: number;
  /** Items that failed in this stage (e.g. images that couldn't be downloaded). */
  failed?: number;
  /** Short note (e.g. "已导出 1234 条", "下载 3/40", "下载接口修复中"). */
  note?: string;
}

/** Media-export options threaded from the lightbox. */
export interface MediaExportOptions {
  /** Export media files alongside the messages (turns the output into a bundle). */
  exportMedia: boolean;
  /** CDN-complete images missing from the local cache (needs a live rkey). */
  completeMedia: boolean;
  /** Reserved: include videos when downloading (download deferred). */
  downloadVideo: boolean;
  /** Reserved: include files when downloading (download deferred). */
  downloadFile: boolean;
}

export interface ExportTask {
  id: string;
  kind: ConvKind;
  conv: string; // groupCode or peerUid
  name: string;
  format: ExportFormat;
  status: TaskStatus;
  progress: number; // 0-100 (the active stage's percent, for a coarse summary)
  current: number; // messages exported
  total: number; // total messages (estimate)
  error?: string;
  filePath?: string; // message file path when completed
  /** True when sender avatars were requested. */
  exportAvatar?: boolean;
  /** Media export options, when 导出媒体 is on. */
  media?: MediaExportOptions;
  /** Inclusive send-time window for this export, if narrowed from 全部时间. */
  range?: ExportTimeRange;
  /** Bundle folder (message file + avatars/ + media/) when avatars or media are on. */
  bundleDir?: string;
  /** Number of avatars written, when avatars were exported. */
  avatarCount?: number;
  /** Per-stage progress; the renderer shows one bar per entry. */
  stages: TaskStage[];
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

/** Main-process dependencies injected for media export (silk-wasm lives in the app). */
export interface MediaDeps {
  avatarCache?: AvatarCacheService;
  mediaDownload?: MediaDownloadService;
  /** Absolute media base dirs for the open account (`…/<uin>/nt_qq/nt_data/*`). */
  accountDir?: string;
  /** SILK → WAV decode (writes to a given path). Injected from the app. */
  decodeSilk?: DecodeSilk;
}

export class ExportTaskManager extends EventEmitter {
  private tasks = new Map<string, ExportTask>();
  private abortControllers = new Map<string, AbortController>();
  private persistPath: string;

  constructor(
    private msgs: MsgService,
    private cacheDir: string,
    /** Main-process deps for avatar / media export (optional — plain exports need none). */
    private deps: MediaDeps = {},
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
        if (!Array.isArray(t.stages)) t.stages = []; // back-compat with pre-stages tasks
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
    media?: MediaExportOptions;
    range?: ExportTimeRange;
  }): Promise<string> {
    const id = `${opts.kind}-${opts.conv}-${Date.now()}`;
    const wantMedia = Boolean(opts.media?.exportMedia);
    const stages: TaskStage[] = [{ key: 'message', label: '导出消息', status: 'pending', current: 0, total: opts.total }];
    if (wantMedia) {
      stages.push({ key: 'media', label: '搬运媒体', status: 'pending', current: 0, total: 0 });
      stages.push({ key: 'record', label: '解码语音', status: 'pending', current: 0, total: 0 });
      if (opts.media?.completeMedia) {
        stages.push({ key: 'image', label: '补全图片', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'video', label: '补全视频', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'file', label: '补全文件', status: 'pending', current: 0, total: 0 });
      }
    }
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
      ...(opts.media ? { media: opts.media } : {}),
      ...(opts.range ? { range: opts.range } : {}),
      stages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.saveTasks();
    void this.runTask(id);
    return id;
  }

  // ---- stage helpers ----

  private stage(task: ExportTask, key: StageKey): TaskStage | undefined {
    return task.stages.find((s) => s.key === key);
  }

  /** Push a stage update + emit progress (debounced writes happen on stage edges). */
  private touchStage(
    task: ExportTask,
    key: StageKey,
    patch: Partial<TaskStage>,
    opts: { persist?: boolean } = {},
  ): void {
    const s = this.stage(task, key);
    if (!s) return;
    Object.assign(s, patch);
    if (s.total > 0) task.progress = Math.min(100, Math.floor((s.current / s.total) * 100));
    task.updatedAt = Date.now();
    if (opts.persist) this.saveTasks();
    this.emit('progress', {
      taskId: task.id,
      status: 'running',
      progress: task.progress,
      current: task.current,
      message: s.note ?? s.label,
    });
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();

    const abort = new AbortController();
    this.abortControllers.set(id, abort);
    const aborted = (): boolean => abort.signal.aborted;

    try {
      const wantAvatars = Boolean(task.exportAvatar && this.deps.avatarCache);
      const wantMedia = Boolean(task.media?.exportMedia);
      // Avatars or media → output is a bundle folder; otherwise a lone file.
      const isBundle = wantAvatars || wantMedia;
      const outDir = isBundle ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (isBundle) mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${task.name}.${task.format}`);
      const senders = wantAvatars ? new Set<string>() : undefined;

      // ---- stage: message (+ avatars) ----
      this.touchStage(task, 'message', { status: 'running', note: '开始导出' }, { persist: true });
      const result = await this.exportMessages(task, outPath, senders, wantMedia, (current, note) => {
        if (aborted()) return;
        this.touchStage(task, 'message', { current, note });
      });
      task.filePath = result.filePath;
      task.current = result.messageCount;
      this.touchStage(task, 'message', { status: 'completed', current: result.messageCount, total: result.messageCount, note: `${result.messageCount} 条` }, { persist: true });

      if (aborted()) { task.status = 'cancelled'; return; }

      if (wantAvatars && senders && this.deps.avatarCache) {
        const avatars = await exportAvatars(this.deps.avatarCache, senders, outDir, {
          onProgress: () => { /* avatar progress folds under the message stage */ },
        });
        task.avatarCount = avatars.ok;
      }
      if (isBundle) task.bundleDir = outDir;

      // ---- media stages ----
      if (wantMedia) {
        await this.runMediaStages(task, outDir, aborted);
      }

      if (aborted()) { task.status = 'cancelled'; return; }
      task.status = 'completed';
      task.progress = 100;
    } catch (e: any) {
      task.status = 'failed';
      task.error = String(e?.message ?? e);
      // Mark the running stage failed so the UI shows where it broke.
      const running = task.stages.find((s) => s.status === 'running');
      if (running) { running.status = 'failed'; running.note = task.error; }
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '导出完成' : task.error ?? '已取消',
      });
    }
  }

  /** Run the media → record → image stages over the scanned media. */
  private async runMediaStages(task: ExportTask, outDir: string, aborted: () => boolean): Promise<void> {
    const { mediaDownload, accountDir, decodeSilk } = this.deps;
    const mediaRoot = join(outDir, 'media');

    if (!accountDir) {
      // Can't locate on-disk media — skip every media stage rather than fail.
      for (const key of ['media', 'record', 'image', 'video', 'file'] as StageKey[]) {
        const s = this.stage(task, key);
        if (s) { s.status = 'skipped'; s.note = '无法定位媒体目录'; }
      }
      return;
    }

    const dirs: MediaDirs = mediaDirsFromAccountDir(accountDir);

    // Scan once: classify found vs missing across the whole conversation.
    this.touchStage(task, 'media', { status: 'running', note: '扫描媒体…' }, { persist: true });
    const scan = await scanConvMedia(this.msgs, task.kind, task.conv, dirs, {
      pageSize: 2000,
      range: task.range,
    });
    if (aborted()) return;

    // Stage: media — copy locally-found pic / video / file.
    {
      const found = scan.found.filter((r) => r.kind !== 'ptt');
      this.touchStage(task, 'media', { status: 'running', total: found.length, current: 0, note: `搬运 0/${found.length}` }, { persist: true });
      const r = await copyFoundMedia(scan, mediaRoot, (done, total) => {
        if (aborted()) return;
        this.touchStage(task, 'media', { current: done, total, note: `搬运 ${done}/${total}` });
      });
      this.touchStage(task, 'media', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已搬运 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}` }, { persist: true });
    }
    if (aborted()) return;

    // Stage: record — SILK-decode locally-found voices.
    {
      const voices = scan.found.filter((r) => r.kind === 'ptt');
      const recStage = this.stage(task, 'record');
      if (!decodeSilk) {
        if (recStage) { recStage.status = 'skipped'; recStage.note = '解码不可用'; }
      } else {
        this.touchStage(task, 'record', { status: 'running', total: voices.length, current: 0, note: `解码 0/${voices.length}` }, { persist: true });
        const r = await decodeFoundVoices(scan, mediaRoot, decodeSilk, (done, total) => {
          if (aborted()) return;
          this.touchStage(task, 'record', { current: done, total, note: `解码 ${done}/${total}` });
        });
        this.touchStage(task, 'record', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已解码 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}` }, { persist: true });
      }
    }
    if (aborted()) return;

    // Stage: image — CDN-complete missing images (only when completeMedia is on).
    if (task.media?.completeMedia) {
      const imgStage = this.stage(task, 'image');
      if (!mediaDownload) {
        if (imgStage) { imgStage.status = 'skipped'; imgStage.note = '下载不可用'; }
      } else {
        const missing = scan.downloadList.filter((r) => r.kind === 'pic' || r.kind === 'emoji');
        this.touchStage(task, 'image', { status: 'running', total: missing.length, current: 0, note: `下载 0/${missing.length}` }, { persist: true });
        const r = await downloadMissingImages(scan, mediaRoot, mediaDownload, (done, total) => {
          if (aborted()) return;
          this.touchStage(task, 'image', { current: done, total, note: `下载 ${done}/${total}` });
        });
        this.touchStage(task, 'image', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已补全 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}` }, { persist: true });
      }

      // Stages: video / file — download deferred (underlying interface in repair).
      for (const key of ['video', 'file'] as StageKey[]) {
        const s = this.stage(task, key);
        if (s) { s.status = 'skipped'; s.note = '下载接口修复中'; }
      }
      this.saveTasks();
    }
  }

  /** Dispatch the message stage to the right exporter by format / conversation kind. */
  private exportMessages(
    task: ExportTask,
    outputPath: string,
    senders: Set<string> | undefined,
    withMediaPaths: boolean,
    onProgress: (current: number, note: string) => void,
  ): Promise<ExportResult> {
    const progressEvery = 1000;
    const tick = (p: { current: number; message: string }): void => onProgress(p.current, p.message);
    // XLSX is a binary workbook, not a character stream — its own loop, both kinds.
    if (task.format === 'xlsx') {
      return exportToXlsx(this.msgs, {
        kind: task.kind,
        conv: task.conv,
        outputPath,
        progressEvery,
        onProgress: tick,
        collectSenders: senders,
        range: task.range,
        withMediaPaths,
      });
    }
    if (task.kind === 'group') {
      const opts: GroupExportOptions = {
        groupCode: task.conv,
        outputPath,
        progressEvery,
        onProgress: tick,
        collectSenders: senders,
        range: task.range,
        withMediaPaths,
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
    return this.exportC2c(task.conv, outputPath, task.format, progressEvery, tick, senders, task.range, withMediaPaths);
  }

  private async exportC2c(
    peerUid: string,
    outPath: string,
    format: ExportFormat,
    progressEvery: number,
    onProgress: (p: { current: number; message: string }) => void,
    senders?: Set<string>,
    range?: ExportTimeRange,
    withMediaPaths?: boolean,
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
        if (withMediaPaths) annotateLocalPaths(exported.elements);
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
