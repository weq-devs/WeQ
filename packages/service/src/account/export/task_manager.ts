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
import { exportToChatlab, type ChatlabDeps } from './chatlab_exporter';
import { exportAvatars } from './avatar_export';
import {
  copyFoundMedia,
  decodeFoundVoices,
  transcribeFoundVoices,
  downloadMissingImages,
  downloadMissingVideos,
  downloadMissingFiles,
  type DecodeSilk,
  type TranscribeVoiceFn,
  type MediaFailure,
} from './media_export';
import { scanConvMedia, mediaDirsFromAccountDir, type MediaDirs, type MediaScanResult } from './media_scan';
import type { MediaUrlService } from '../media_url';
import { iterateC2cMessages, toExportedMessage } from './message_source';
import { type Framing } from './run_export';
import { bigintReplacer } from './serialize';
import { messageToText, annotateLocalPaths } from './element_text';
import type { ConvKind, ExportedMessage, ExportFormat, ExportResult, ExportTimeRange, GroupExportOptions } from './types';

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type { ConvKind };

/** A single stage of a task's pipeline. */
export type StageKey = 'message' | 'media' | 'avatar' | 'record' | 'image' | 'video' | 'file' | 'transcribe';

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
  /** Per-file failure details (capped). Drives the failure-detail lightbox. */
  failures?: MediaFailure[];
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
  /** Transcribe locally-found voice clips into a `transcripts.json` (needs a model). */
  transcribeVoice: boolean;
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
  /** ChatLab interchange format (json/jsonl carry ChatLab structure, not raw). */
  chatlab?: boolean;
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
  /** OIDB-backed video / file download URL resolver (needs online QQ). */
  mediaUrl?: MediaUrlService;
  /** Absolute media base dirs for the open account (`…/<uin>/nt_qq/nt_data/*`). */
  accountDir?: string;
  /** SILK → WAV decode (writes to a given path). Injected from the app. */
  decodeSilk?: DecodeSilk;
  /** SILK voice → text transcription (native engine; injected from the app). */
  transcribe?: TranscribeVoiceFn;
  /** ChatLab name / role / profile resolvers (account-side; injected from the app). */
  chatlab?: ChatlabDeps;
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
      // A `writeFileSync('w')` truncates before writing, so a process killed
      // mid-save leaves a 0-byte / partial file. Treat empty content as "no
      // tasks" instead of throwing on `JSON.parse('')`.
      const raw = readFileSync(this.persistPath, 'utf-8').trim();
      if (!raw) return;
      const data = JSON.parse(raw) as ExportTask[];
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
    /** ChatLab format (json/jsonl carry ChatLab structure). */
    chatlab?: boolean;
    media?: MediaExportOptions;
    range?: ExportTimeRange;
  }): Promise<string> {
    const id = `${opts.kind}-${opts.conv}-${Date.now()}`;
    const wantMedia = Boolean(opts.media?.exportMedia);
    const wantAvatars = Boolean(opts.exportAvatar);
    const wantTranscribe = Boolean(opts.media?.transcribeVoice);
    // Stage order is the display order. message + 搬运媒体 run first (sequential);
    // the rest (avatar / record / image / video / file / transcribe) run together.
    const stages: TaskStage[] = [{ key: 'message', label: '导出消息', status: 'pending', current: 0, total: opts.total }];
    if (wantMedia) {
      stages.push({ key: 'media', label: '搬运媒体', status: 'pending', current: 0, total: 0 });
    }
    if (wantAvatars) {
      stages.push({ key: 'avatar', label: '下载头像', status: 'pending', current: 0, total: 0 });
    }
    if (wantMedia) {
      stages.push({ key: 'record', label: '解码语音', status: 'pending', current: 0, total: 0 });
      if (opts.media?.completeMedia) {
        stages.push({ key: 'image', label: '补全图片', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'video', label: '补全视频', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'file', label: '补全文件', status: 'pending', current: 0, total: 0 });
      }
    }
    if (wantTranscribe) {
      stages.push({ key: 'transcribe', label: '语音转写', status: 'pending', current: 0, total: 0 });
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
      ...(opts.chatlab ? { chatlab: true } : {}),
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

  /** A single stage's completion percent (0–100). */
  private stagePercent(s: TaskStage): number {
    if (s.status === 'completed' || s.status === 'skipped') return 100;
    if (s.status === 'pending' || s.total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.floor((s.current / s.total) * 100)));
  }

  /**
   * Coarse overall percent — the mean of every stage's percent. With the
   * post-message stages running concurrently, a single "active stage" percent
   * would jump around; averaging keeps the summary bar smooth and monotonic-ish.
   */
  private overallProgress(task: ExportTask): number {
    if (task.stages.length === 0) return task.progress;
    let sum = 0;
    for (const s of task.stages) sum += this.stagePercent(s);
    return Math.min(100, Math.floor(sum / task.stages.length));
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
    task.progress = this.overallProgress(task);
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
      const { avatarCache, mediaDownload, accountDir, decodeSilk, transcribe } = this.deps;
      const wantAvatars = Boolean(task.exportAvatar && avatarCache);
      const wantMedia = Boolean(task.media?.exportMedia);
      const wantTranscribe = Boolean(task.media?.transcribeVoice && transcribe);
      const needsScan = wantMedia || wantTranscribe;
      // Avatars / media / transcription → output is a bundle folder; else a lone file.
      const isBundle = wantAvatars || wantMedia || wantTranscribe;
      const outDir = isBundle ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (isBundle) mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${task.name}.${task.format}`);
      const mediaRoot = join(outDir, 'media');
      const senders = wantAvatars ? new Set<string>() : undefined;

      // Defensive: a stage created for a capability that isn't injected (no
      // avatar cache / no transcription engine) is skipped up-front, so the
      // overall summary can still reach 100%.
      if (task.exportAvatar && !avatarCache) {
        const s = this.stage(task, 'avatar');
        if (s) { s.status = 'skipped'; s.note = '头像服务不可用'; }
      }
      if (task.media?.transcribeVoice && !transcribe) {
        const s = this.stage(task, 'transcribe');
        if (s) { s.status = 'skipped'; s.note = '转录引擎不可用'; }
      }

      // ---- stage: message (sequential, first) ----
      this.touchStage(task, 'message', { status: 'running', note: '开始导出' }, { persist: true });
      const result = await this.exportMessages(task, outPath, senders, wantMedia, (current, note) => {
        if (aborted()) return;
        this.touchStage(task, 'message', { current, note });
      });
      task.filePath = result.filePath;
      task.current = result.messageCount;
      this.touchStage(task, 'message', { status: 'completed', current: result.messageCount, total: result.messageCount, note: `${result.messageCount} 条` }, { persist: true });
      if (aborted()) { task.status = 'cancelled'; return; }
      if (isBundle) task.bundleDir = outDir;

      // ---- scan once (shared by 搬运媒体 / 补全 / 转写) ----
      let scan: MediaScanResult | null = null;
      if (needsScan) {
        if (!accountDir) {
          // Can't locate on-disk media — skip every media-dependent stage.
          for (const key of ['media', 'record', 'image', 'video', 'file', 'transcribe'] as StageKey[]) {
            const s = this.stage(task, key);
            if (s) { s.status = 'skipped'; s.note = '无法定位媒体目录'; }
          }
        } else {
          const dirs: MediaDirs = mediaDirsFromAccountDir(accountDir);
          const scanStage: StageKey = wantMedia ? 'media' : 'transcribe';
          this.touchStage(task, scanStage, { status: 'running', note: '扫描媒体…' }, { persist: true });
          scan = await scanConvMedia(this.msgs, task.kind, task.conv, dirs, { pageSize: 2000, range: task.range });
          if (aborted()) { task.status = 'cancelled'; return; }
        }
      }

      // ---- sequential: 搬运媒体 (copy locally-found pic / video / file) ----
      if (wantMedia && scan) {
        const found = scan.found.filter((r) => r.kind !== 'ptt');
        this.touchStage(task, 'media', { status: 'running', total: found.length, current: 0, note: `搬运 0/${found.length}` }, { persist: true });
        const r = await copyFoundMedia(scan, mediaRoot, (done, total) => {
          if (aborted()) return;
          this.touchStage(task, 'media', { current: done, total, note: `搬运 ${done}/${total}` });
        });
        this.touchStage(task, 'media', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已搬运 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`, ...(r.failures ? { failures: r.failures } : {}) }, { persist: true });
      }
      if (aborted()) { task.status = 'cancelled'; return; }

      // ---- concurrent batch: 头像 / 解码语音 / 补全图片·视频·文件 / 语音转写 ----
      const jobs: Array<() => Promise<void>> = [];

      if (wantAvatars && senders && avatarCache) {
        jobs.push(async () => {
          this.touchStage(task, 'avatar', { status: 'running', total: senders.size, current: 0, note: `下载 0/${senders.size}` }, { persist: true });
          const r = await exportAvatars(avatarCache, senders, outDir, {
            onProgress: (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'avatar', { current: done, total, note: `下载 ${done}/${total}` });
            },
          });
          task.avatarCount = r.ok;
          this.touchStage(task, 'avatar', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}` }, { persist: true });
        });
      }

      if (wantMedia && scan) {
        const found = scan;
        // 解码语音 — SILK-decode locally-found voices.
        jobs.push(async () => {
          const voices = found.found.filter((r) => r.kind === 'ptt');
          const recStage = this.stage(task, 'record');
          if (!decodeSilk) { if (recStage) { recStage.status = 'skipped'; recStage.note = '解码不可用'; } return; }
          this.touchStage(task, 'record', { status: 'running', total: voices.length, current: 0, note: `解码 0/${voices.length}` }, { persist: true });
          const r = await decodeFoundVoices(found, mediaRoot, decodeSilk, (done, total) => {
            if (aborted()) return;
            this.touchStage(task, 'record', { current: done, total, note: `解码 ${done}/${total}` });
          });
          this.touchStage(task, 'record', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已解码 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`, ...(r.failures ? { failures: r.failures } : {}) }, { persist: true });
        });

        if (task.media?.completeMedia) {
          // 补全图片 — CDN-complete missing images.
          jobs.push(async () => {
            const imgStage = this.stage(task, 'image');
            if (!mediaDownload) { if (imgStage) { imgStage.status = 'skipped'; imgStage.note = '下载不可用'; } return; }
            const missing = found.downloadList.filter((r) => r.kind === 'pic' || r.kind === 'emoji');
            this.touchStage(task, 'image', { status: 'running', total: missing.length, current: 0, note: `下载 0/${missing.length}` }, { persist: true });
            const r = await downloadMissingImages(found, mediaRoot, mediaDownload, (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'image', { current: done, total, note: `下载 ${done}/${total}` });
            });
            this.touchStage(task, 'image', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已补全 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`, ...(r.failures ? { failures: r.failures } : {}) }, { persist: true });
          });
          // 补全视频 / 文件 — OIDB-resolve + download (each gated by its toggle).
          jobs.push(() => this.runUrlDownloadStage(task, 'video', found, mediaRoot, Boolean(task.media?.downloadVideo), aborted));
          jobs.push(() => this.runUrlDownloadStage(task, 'file', found, mediaRoot, Boolean(task.media?.downloadFile), aborted));
        }
      }

      if (wantTranscribe && transcribe && scan) {
        const found = scan;
        jobs.push(async () => {
          const voices = found.found.filter((r) => r.kind === 'ptt' && r.path);
          this.touchStage(task, 'transcribe', { status: 'running', total: voices.length, current: 0, note: `转写 0/${voices.length}` }, { persist: true });
          const r = await transcribeFoundVoices(found, outDir, transcribe, (done, total) => {
            if (aborted()) return;
            this.touchStage(task, 'transcribe', { current: done, total, note: `转写 ${done}/${total}` });
          });
          this.touchStage(task, 'transcribe', { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已转写 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`, ...(r.failures ? { failures: r.failures } : {}) }, { persist: true });
        });
      }

      // Run the batch concurrently; one stage's failure shouldn't sink the rest.
      const settled = await Promise.allSettled(jobs.map((j) => j()));
      const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (firstError) throw firstError.reason;

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

  /** Run a video/file download stage: gated by its toggle and a usable mediaUrl. */
  private async runUrlDownloadStage(
    task: ExportTask,
    key: 'video' | 'file',
    scan: import('./media_scan').MediaScanResult,
    mediaRoot: string,
    enabled: boolean,
    aborted: () => boolean,
  ): Promise<void> {
    const s = this.stage(task, key);
    if (!s) return;
    if (!enabled) { s.status = 'skipped'; s.note = '未勾选下载'; this.saveTasks(); return; }
    if (!this.deps.mediaUrl) { s.status = 'skipped'; s.note = '无法获取下载地址'; this.saveTasks(); return; }

    const label = key === 'video' ? '视频' : '文件';
    const ctx = { mediaUrl: this.deps.mediaUrl, msgs: this.msgs, kind: task.kind, conv: task.conv };
    this.touchStage(task, key, { status: 'running', note: `下载${label} 0` }, { persist: true });
    const onP = (done: number, total: number): void => {
      if (aborted()) return;
      this.touchStage(task, key, { current: done, total, note: `下载${label} ${done}/${total}` });
    };
    const r =
      key === 'video'
        ? await downloadMissingVideos(scan, mediaRoot, ctx, onP)
        : await downloadMissingFiles(scan, mediaRoot, ctx, onP);
    this.touchStage(task, key, { status: 'completed', current: r.total, total: r.total, failed: r.failed, note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`, ...(r.failures ? { failures: r.failures } : {}) }, { persist: true });
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
    // ChatLab reuses json/jsonl but emits its own structure (header + members +
    // normalized messages), and resolves names/roles itself — its own exporter.
    if (task.chatlab && (task.format === 'json' || task.format === 'jsonl')) {
      return exportToChatlab(
        this.msgs,
        {
          kind: task.kind,
          conv: task.conv,
          name: task.name,
          format: task.format,
          outputPath,
          range: task.range,
          progressEvery,
          onProgress: tick,
          collectSenders: senders,
        },
        this.deps.chatlab ?? {},
      );
    }
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
