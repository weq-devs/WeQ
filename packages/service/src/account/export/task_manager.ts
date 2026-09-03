/**
 * Export task manager: schedule, track, pause/cancel conversation exports.
 * Tasks persist to JSON and survive restarts.
 *
 * A task runs as a sequence of *phases*, each with its own progress:
 *
 *   1. backfill（可选，最先）—— 消息补全，把 seq 空窗拉回漫游缓存；
 *   2. 并行扫描 —— 装扮用量 / 媒体清单 / 消息计数同时进行；
 *   3. 主并行阶段 —— 消息导出、装扮资源导出、媒体搬运、图片/视频/文件/语音
 *      四路补全下载、语音解码 / 转写、头像 / 表情导出全部并发执行。
 *
 * The renderer shows one progress bar per stage, plus a per-stage scrolling log
 * (Docker TUI style). A plain export (no avatars / no media) is just the single
 * `message` stage writing one file into the cache.
 */

import { EventEmitter } from 'node:events';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSegment, uniqueName } from '../../common/path_sanitize';
import type { MsgService } from '../msg';
import type { SenderResolveDeps } from './sender_resolve';
import type { GapFetchedMessage, GapHistoryService } from '../gap_history';
import type { AvatarCacheService } from '../../bootstrap/media_cache';
import type { MediaDownloadService } from '../media_download';
import { exportGroupToJson } from './json_exporter';
import { exportGroupToTxt } from './txt_exporter';
import { exportGroupToJsonl } from './jsonl_exporter';
import { exportJsonConversation } from './json_meta_exporter';
import { exportGroupToCsv, csvFraming, renderCsvRow } from './csv_exporter';
import { exportToXlsx } from './xlsx_exporter';
import { exportToChatlab, type ChatlabDeps } from './chatlab_exporter';
import { exportToHtml } from './html_exporter';
import { exportQzone, type QzoneExportDeps } from './qzone_export';
import { createExportWriter } from './stream_utils';
import {
  exportFriends,
  exportGroupMembers,
  type ContactsExportDeps,
  type ContactsFormat,
} from './contacts_export';
import {
  exportCollections,
  type CollectionExportDeps,
  type CollectionFormat,
} from './collection_export';
import { exportAvatars, exportGuildAvatars } from './avatar_export';
import {
  copyFoundMedia,
  decodeFoundVoices,
  transcribeFoundVoices,
  downloadMissingImages,
  downloadMissingVideos,
  downloadMissingFiles,
  downloadMissingVoices,
  type DecodeSilk,
  type TranscribeVoiceFn,
  type MediaFailure,
} from './media_export';
import {
  scanConvMedia,
  mediaDirsFromAccountDir,
  mediaDirsFromNtDataDir,
  type MediaDirs,
  type MediaScanResult,
} from './media_scan';
import { exportSysFaces, exportMarketFaces } from './sysface_export';
import type { MediaUrlService } from '../media_url';
import { iterateC2cMessages, toExportedMessage, type RoamMessageSource } from './message_source';
import { expandForwards } from './forward_expand';
import type { Framing } from './run_export';
import { bigintReplacer } from './serialize';
import { messageToText, annotateLocalPaths, collectFaceIds } from './element_text';
import { backfillConversationMessages, type MessageBackfillDeps } from './msg_backfill';
import type { DressService } from '../dress_service';
import type { MsgDecoration } from '@weq/codec';
import {
  collectDressUsage,
  exportDressAssets,
  type DressExportKinds,
  type DressExportManifest,
  type DressExportResult,
} from './dress_export';
import type {
  ConvKind,
  ExportedMessage,
  ExportFormat,
  ExportResult,
  ExportTimeRange,
  GroupExportOptions,
} from './types';
import { GuildMsgSource, type GuildExportTaskMeta } from './guild_source';
import type { GuildDirectService } from '../guild_direct';

/** 每个任务保留的任务日志行数上限（内存环形缓冲，防列表 IPC 膨胀）。 */
const MAX_TASK_LOGS = 400;

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type { ConvKind };

/** A single stage of a task's pipeline. */
export type StageKey =
  | 'backfill'
  | 'dress'
  | 'message'
  | 'media'
  | 'avatar'
  | 'record'
  | 'image'
  | 'video'
  | 'file'
  | 'ptt'
  | 'transcribe'
  | 'sysface'
  | 'sticker';

/** 任务日志级别。 */
export type TaskLogLevel = 'info' | 'warn' | 'error';

/** 一行任务日志（前端按 stage 滚动展示，Docker TUI 风格）。 */
export interface TaskLogLine {
  /** Unix 毫秒时间戳。 */
  ts: number;
  /** 任务内单调递增序号（前端 React key / 排序用）。 */
  seq: number;
  /** 所属子任务；`task` = 任务级日志（扫描摘要 / 起止等）。 */
  stage: StageKey | 'task';
  level: TaskLogLevel;
  text: string;
}

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

/** 一套待下载的商城表情包（前端勾选后传入）。 */
export interface MarketPackDownloadItem {
  /** 表情包 ID（packId）。 */
  id: string;
  /** 表情包名称（用作输出子文件夹名）。 */
  name: string;
}

/**
 * 商城表情解密下载能力（由 app 注入，桥接 EmojiService）。所有方法纯离线：
 * 密钥由资源时间戳派生 / 爆破，图片走公开 CDN 加密流 + QQTEA 解密。
 */
export interface MarketPackDeps {
  /** 拉 android.json 取该包的表情列表（hash + 名）。失败/不存在返回 null。 */
  getPackDetail(packId: string): Promise<{ items: Array<{ hash: string; name: string }> } | null>;
  /** 恢复该包的图片解密密钥（每包一次）。失败返回 null。 */
  getPackKey(packId: string): Promise<{ key: string } | null>;
  /** 下载并解密一张表情，返回落盘的 GIF 缓存路径。失败返回 null。 */
  getPackImagePath(packId: string, hash: string, key?: string): Promise<string | null>;
}

/** Media-export options threaded from the lightbox. */
export interface MediaExportOptions {
  /** Export media files alongside the messages (turns the output into a bundle). */
  exportMedia: boolean;
  /** 导出媒体时按类别筛选（图片 / 语音 / 视频 / 文件 / QQ 系统表情）。 */
  mediaKinds?: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
    sysface: boolean;
  };
  /** 消息补全：扫描 seq 空窗，从 QQ 服务端拉取本机缺失的消息（需在线 QQ）。 */
  completeMessages: boolean;
  /** CDN-complete images missing from the local cache (needs a live rkey). */
  completeMedia: boolean;
  /** Reserved: include videos when downloading (download deferred). */
  downloadVideo: boolean;
  /** Reserved: include files when downloading (download deferred). */
  downloadFile: boolean;
  /** Include missing voices when downloading (OIDB-resolve + SILK-decode). */
  downloadPtt: boolean;
  /** 下载本地未缓存的装扮资源（关闭时只导出已缓存的部分）。 */
  completeDress?: boolean;
  /** Transcribe locally-found voice clips into a `transcripts.json` (needs a model). */
  transcribeVoice: boolean;
}

export interface ExportTask {
  id: string;
  kind: ConvKind;
  conv: string; // groupCode or peerUid
  name: string;
  format: ExportFormat;
  /** 多格式导出（同一次任务写多个文件进同一 bundle；缺省 = [format]）。 */
  formats?: ExportFormat[];
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
  /** 好友 QQ 空间说说导出（`conv` = 好友 uin；走独立的 Web 拉取流水线）。 */
  qzone?: boolean;
  /** 好友空间导出：按 tid 补全评论 / 点赞（空间动态页 HTML 解析，best-effort）。 */
  qzoneInteractions?: boolean;
  /** 联系人导出（好友列表 / 群成员列表；走独立的资料库拉取流水线）。
   *  `group` 时 `conv` = 群号；`friends` 时 `conv` 为空。 */
  contacts?: { scope: 'friends' | 'group'; categoryIds?: number[] };
  /** 收藏导出（QQ 收藏；走独立的收藏库拉取流水线）。`kinds` 为空 = 全部类型。 */
  collection?: { kinds?: string[] };
  /** 导出装扮资源（气泡 / 字体 / 挂件，只导出会话实际用到的款）。 */
  dress?: DressExportKinds;
  /** 商城表情批量下载（`conv` 占位为 'marketpack'；走独立的解密下载流水线）。
   *  每套包一个以包名命名的子文件夹，内含解密后的 GIF。 */
  marketpack?: { packs: MarketPackDownloadItem[] };
  /** Media export options, when 导出媒体 is on. */
  media?: MediaExportOptions;
  /** Inclusive send-time window for this export, if narrowed from 全部时间. */
  range?: ExportTimeRange;
  /** 频道私聊导出任务（kind 仍为 'c2c'，conv = peerTinyId，消息源走 guild_msg.db）。 */
  guild?: GuildExportTaskMeta;
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
  /** 一次性提示（如「可能被限流」），前端收到后 toast。 */
  notice?: string;
}

/** 任务列表 wire 视图：ExportTask + 内存日志（不持久化，重启后清空）。 */
export interface ExportTaskView extends ExportTask {
  logs: TaskLogLine[];
}

/** Main-process dependencies injected for media export (silk-wasm lives in the app). */
export interface MediaDeps {
  avatarCache?: AvatarCacheService;
  mediaDownload?: MediaDownloadService;
  /** OIDB-backed video / file download URL resolver (needs online QQ). */
  mediaUrl?: MediaUrlService;
  /** Absolute media base dirs for the open account (`…/<uin>/nt_qq/nt_data/*`). */
  accountDir?: string;
  /** Account built-in system-emoji resource dir (platform.emojiResourceDir), for HTML face images. */
  emojiDir?: string | null;
  /**
   * Pre-resolved `nt_data` directory for the open account. Preferred over
   * `accountDir` because the platform already knows the per-OS account layout
   * (linux's hashed `nt_qq_<hash>/nt_data` has no `nt_qq` middle segment).
   * When set, media scanning uses this directly; `accountDir` is the fallback.
   */
  ntDataDir?: string;
  /** SILK → WAV decode (writes to a given path). Injected from the app. */
  decodeSilk?: DecodeSilk;
  /** SILK voice → text transcription (native engine; injected from the app). */
  transcribe?: TranscribeVoiceFn;
  /** ChatLab name / role / profile resolvers (account-side; injected from the app). */
  chatlab?: ChatlabDeps;
  /** 频道私聊（guild direct）导出源——guild_msg.db / guild1.db，由 app 注入。 */
  guildDirect?: GuildDirectService;
  /** QQ 空间说说拉取能力（Web CGI；需在线 QQ，由 app 注入）。 */
  qzone?: QzoneExportDeps;
  /** 联系人（好友 / 群成员）资料库拉取能力（由 app 注入）。 */
  contacts?: ContactsExportDeps;
  /** 收藏（QQ 收藏）拉取能力（由 app 注入；返回已拍平的行）。 */
  collection?: CollectionExportDeps;
  /** 装扮安装/解析服务（本地 bundle → nt_helper → protocol），导出装扮阶段用。 */
  dressInstall?: DressService;
  /** 商城表情解密下载能力（由 app 注入，桥接 EmojiService）。 */
  marketpack?: MarketPackDeps;
  /**
   * 商城表情「单张贴图」解析（桥接 EmojiService.getMarketFace）：返回该贴图的
   * 本地解密路径（weq 缓存 → QQ 本地缓存 → CDN 明文 GIF/PNG）。HTML 导出把
   * 会话里用到的商城表情也归类进「QQ系统表情」资源、复制进 bundle 时用它解析。
   */
  marketFace?: (pack: string, hash: string) => Promise<string | null>;
  /** 消息补全能力（由 app 注入，桥接聊天页 GapHistoryService：缓存+拉取共用）。 */
  messageBackfill?: MessageBackfillDeps;
  /** 漫游缓存元素回退（缺失消息补全的消息不在本地 msg 表，导出下载用它定位媒体元素）。 */
  gapHistory?: Pick<GapHistoryService, 'findMediaElement'>;
}

export class ExportTaskManager extends EventEmitter {
  private tasks = new Map<string, ExportTask>();
  private abortControllers = new Map<string, AbortController>();
  /** 任务日志（内存环形缓冲，不随 export_tasks.json 持久化）。 */
  private taskLogs = new Map<string, TaskLogLine[]>();
  /** 频道私聊导出任务的消息源缓存（taskId → guild_msg.db 适配源）。 */
  private guildSources = new Map<string, GuildMsgSource>();
  /**
   * 全局任务执行队列（并发 1）：同一时刻只跑一个任务。多会话同时导出时，
   * 后面的任务排队，避免 A 任务的补全还没拉完、B 任务的装扮/消息/媒体已经
   * 开工（既让「补全永远第一步」在全局成立，也避免并发轰炸 QQ 服务端）。
   */
  private queue: Promise<void> = Promise.resolve();
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

  /** 排队执行一个任务运行器（并发 1；异常吞掉，由 runXTask 内部 catch 处理）。 */
  private enqueue(run: () => Promise<void>): void {
    this.queue = this.queue.then(run).catch(() => undefined);
  }

  override emit(event: 'progress', data: TaskProgress): boolean {
    return super.emit(event, data);
  }

  listTasks(): ExportTaskView[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ ...t, logs: this.taskLogs.get(t.id) ?? [] }));
  }

  getTask(id: string): ExportTask | null {
    return this.tasks.get(id) ?? null;
  }

  async startTask(opts: {
    kind: ConvKind;
    conv: string;
    name: string;
    format: ExportFormat;
    /** 多格式导出：一次任务产出多个格式文件（媒体 / 头像只带一份）。 */
    formats?: ExportFormat[];
    total: number;
    exportAvatar?: boolean;
    /** ChatLab format (json/jsonl carry ChatLab structure). */
    chatlab?: boolean;
    /** 好友 QQ 空间说说导出（走独立流水线）。 */
    qzone?: boolean;
    /** 好友空间导出：按 tid 补全评论 / 点赞（需在线 QQ；deps.qzone.fetchInteractions）。 */
    qzoneInteractions?: boolean;
    /** 联系人导出（好友 / 群成员；走独立流水线）。 */
    contacts?: { scope: 'friends' | 'group'; categoryIds?: number[] };
    /** 收藏导出（QQ 收藏；走独立流水线）。 */
    collection?: { kinds?: string[] };
    /** 导出装扮资源（气泡 / 字体 / 挂件，只导出会话实际用到的款）。 */
    dress?: DressExportKinds;
    media?: MediaExportOptions;
    range?: ExportTimeRange;
    /** 频道私聊导出：会话身份快照（消息源走 guild_msg.db，无漫游补全）。 */
    guild?: GuildExportTaskMeta;
  }): Promise<string> {
    // 清洗 conv (uid/uin/groupCode) 以避免 Windows 文件名非法字符（陌生人 uid 含 *）
    const safeConv = opts.conv.replace(/\*/g, 'x');
    const id = opts.guild
      ? `guild-${safeConv}-${Date.now()}`
      : `${opts.kind}-${safeConv}-${Date.now()}`;
    const wantMedia = Boolean(opts.media?.exportMedia);
    const wantAvatars = Boolean(opts.exportAvatar);
    const wantTranscribe = Boolean(opts.media?.transcribeVoice);
    const wantDress = Boolean(
      opts.dress && (opts.dress.bubble || opts.dress.font || opts.dress.widget),
    );

    // 收藏导出是独立流水线（单文件表格产物，无媒体 / 头像），不复用消息流水线。
    if (opts.collection) {
      const colTask: ExportTask = {
        id,
        kind: opts.kind,
        conv: opts.conv,
        name: opts.name,
        format: opts.format,
        ...(opts.formats?.length ? { formats: opts.formats } : {}),
        status: 'pending',
        progress: 0,
        current: 0,
        total: opts.total,
        collection: opts.collection,
        stages: [
          { key: 'message', label: '导出收藏', status: 'pending', current: 0, total: opts.total },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.tasks.set(id, colTask);
      this.log(id, 'task', `任务已创建：导出收藏「${opts.name}」（${opts.format}）`);
      this.saveTasks();
      this.enqueue(() => this.runCollectionTask(id));
      return id;
    }

    // 联系人导出（好友 / 群成员）是独立流水线（写表 + 可选头像），不复用消息流水线。
    if (opts.contacts) {
      const cStages: TaskStage[] = [
        { key: 'message', label: '导出联系人', status: 'pending', current: 0, total: opts.total },
      ];
      if (wantAvatars)
        cStages.push({ key: 'avatar', label: '下载头像', status: 'pending', current: 0, total: 0 });
      const cTask: ExportTask = {
        id,
        kind: opts.kind,
        conv: opts.conv,
        name: opts.name,
        format: opts.format,
        ...(opts.formats?.length ? { formats: opts.formats } : {}),
        status: 'pending',
        progress: 0,
        current: 0,
        total: opts.total,
        contacts: opts.contacts,
        exportAvatar: wantAvatars,
        stages: cStages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.tasks.set(id, cTask);
      this.log(id, 'task', `任务已创建：导出联系人「${opts.name}」（${opts.format}）`);
      this.saveTasks();
      this.enqueue(() => this.runContactsTask(id));
      return id;
    }

    // 好友空间导出是独立的两段式流水线（说说 + 可选配图），不复用消息流水线。
    if (opts.qzone) {
      const qStages: TaskStage[] = [
        { key: 'message', label: '导出说说', status: 'pending', current: 0, total: opts.total },
      ];
      if (wantMedia)
        qStages.push({ key: 'media', label: '下载媒体', status: 'pending', current: 0, total: 0 });
      const qTask: ExportTask = {
        id,
        kind: opts.kind,
        conv: opts.conv,
        name: opts.name,
        format: opts.format,
        ...(opts.formats?.length ? { formats: opts.formats } : {}),
        status: 'pending',
        progress: 0,
        current: 0,
        total: opts.total,
        qzone: true,
        ...(opts.qzoneInteractions ? { qzoneInteractions: true } : {}),
        ...(opts.media ? { media: opts.media } : {}),
        ...(opts.range ? { range: opts.range } : {}),
        stages: qStages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.tasks.set(id, qTask);
      this.log(id, 'task', `任务已创建：导出 QQ 空间「${opts.name}」（${opts.format}）`);
      this.saveTasks();
      this.enqueue(() => this.runQzoneTask(id));
      return id;
    }

    // Stage order is the display order. message + 搬运媒体 run first (sequential);
    // the rest (avatar / record / image / video / file / transcribe) run together.
    const stages: TaskStage[] = [
      { key: 'message', label: '导出消息', status: 'pending', current: 0, total: opts.total },
    ];
    // 消息补全必须在所有步骤之前：先把 seq 空窗从服务端拉回漫游缓存，后面导出
    // 的消息 / 媒体扫描才能带上这些补全消息。
    if (opts.media?.completeMessages) {
      stages.unshift({
        key: 'backfill',
        label: '补全缺失消息',
        status: 'pending',
        current: 0,
        total: 0,
      });
    }
    // 装扮导出跑在消息流之前：先扫描「实际用到的款」并把原始资源导出到
    // dress/ 目录，HTML 消息流写入时才能引用清单生成 CSS。
    if (wantDress) {
      // message 永远是最后一个元素，插到它前面。
      stages.splice(stages.length - 1, 0, {
        key: 'dress',
        label: '导出装扮',
        status: 'pending',
        current: 0,
        total: 0,
      });
    }
    if (wantMedia) {
      stages.push({ key: 'media', label: '搬运媒体', status: 'pending', current: 0, total: 0 });
    }
    if (wantAvatars) {
      stages.push({ key: 'avatar', label: '下载头像', status: 'pending', current: 0, total: 0 });
    }
    if (wantMedia) {
      stages.push({ key: 'record', label: '解码语音', status: 'pending', current: 0, total: 0 });
      if (
        opts.media?.completeMedia ||
        opts.media?.downloadVideo ||
        opts.media?.downloadFile ||
        opts.media?.downloadPtt
      ) {
        stages.push({ key: 'image', label: '补全图片', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'video', label: '补全视频', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'file', label: '补全文件', status: 'pending', current: 0, total: 0 });
        stages.push({ key: 'ptt', label: '补全语音', status: 'pending', current: 0, total: 0 });
      }
    }
    if (wantTranscribe) {
      stages.push({
        key: 'transcribe',
        label: '语音转写',
        status: 'pending',
        current: 0,
        total: 0,
      });
    }
    // QQ 系统表情（小黄脸）：导出消息时收集用到的 faceId，导出后把这些表情图片
    // 复制进 bundle 的 media/face/。由媒体子选项「QQ系统表情」控制（HTML 默认开）。
    if (opts.media?.mediaKinds?.sysface) {
      stages.push({ key: 'sysface', label: '导出表情', status: 'pending', current: 0, total: 0 });
    }
    const task: ExportTask = {
      id,
      kind: opts.kind,
      conv: opts.conv,
      name: opts.name,
      format: opts.format,
      ...(opts.formats?.length ? { formats: opts.formats } : {}),
      status: 'pending',
      progress: 0,
      current: 0,
      total: opts.total,
      exportAvatar: opts.exportAvatar ?? false,
      ...(opts.chatlab ? { chatlab: true } : {}),
      ...(opts.media ? { media: opts.media } : {}),
      ...(wantDress && opts.dress ? { dress: opts.dress } : {}),
      ...(opts.range ? { range: opts.range } : {}),
      ...(opts.guild ? { guild: opts.guild } : {}),
      stages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.log(id, 'task', `任务已创建：导出「${opts.name}」（${opts.format}）`);
    this.saveTasks();
    this.enqueue(() => this.runTask(id));
    return id;
  }

  /**
   * 商城表情批量下载：为选中的表情包建一个独立任务（单 `sticker` 阶段），交给
   * {@link runMarketPackTask} 并发解密下载。产物为 bundle 目录，每套一个以包名
   * 命名的子文件夹。返回 taskId。
   */
  async startMarketPackDownload(packs: MarketPackDownloadItem[]): Promise<string> {
    const id = `marketpack-${Date.now()}`;
    const task: ExportTask = {
      id,
      kind: 'c2c',
      conv: 'marketpack',
      name: packs.length === 1 ? packs[0]!.name : `商城表情 ${packs.length} 套`,
      format: 'json', // 占位（产物是 GIF 文件夹，非消息文件）；TaskList 只读 bundleDir。
      status: 'pending',
      progress: 0,
      current: 0,
      total: packs.length,
      marketpack: { packs },
      stages: [{ key: 'sticker', label: '下载表情', status: 'pending', current: 0, total: 0 }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.log(id, 'task', `任务已创建：商城表情下载 ${packs.length} 套`);
    this.saveTasks();
    this.enqueue(() => this.runMarketPackTask(id));
    return id;
  }

  // ---- stage helpers ----

  private stage(task: ExportTask, key: StageKey): TaskStage | undefined {
    return task.stages.find((s) => s.key === key);
  }

  /** 该任务的导出消息源：guild 任务用 guild_msg.db 适配源，其余用主库 MsgService。 */
  private msgsFor(task: ExportTask): MsgService {
    if (!task.guild) return this.msgs;
    let src = this.guildSources.get(task.id);
    if (!src) {
      const svc = this.deps.guildDirect;
      if (!svc) throw new Error('频道私聊导出需要注入 guildDirect 服务');
      src = new GuildMsgSource(svc, task.guild);
      this.guildSources.set(task.id, src);
    }
    // 适配源只实现 c2c 分支用到的成员子集；按 kind='c2c' 的调用契约使用。
    return src as unknown as MsgService;
  }

  /** 结构化导出（json / chatlab / html）的昵称解析：guild 任务覆盖 self / peer 身份。 */
  private senderDeps(task: ExportTask): SenderResolveDeps | undefined {
    const base = this.deps.chatlab;
    const g = task.guild;
    if (!g || !base) return base;
    return {
      ...base,
      self: async () => {
        if (g.selfTinyId) {
          return {
            uid: g.selfTinyId,
            uin: '',
            nick: g.selfNick || '',
            avatar: g.selfAvatarUrl ?? undefined,
          };
        }
        return base.self ? base.self() : null;
      },
      resolveProfile: async (uid: string) => {
        if (uid === g.peerTinyId) {
          return {
            uin: '',
            nick: g.peerNick || g.peerTinyId,
            avatar: g.peerAvatarUrl ?? undefined,
          };
        }
        return base.resolveProfile ? base.resolveProfile(uid) : null;
      },
    };
  }

  /**
   * 惰性、记忆化的漫游补全消息来源：消息导出与媒体扫描各自会读一遍，这里只
   * 真正查一次缓存（读整个会话的 [1, uint32 max] 区间，一次索引区间扫描）。
   */
  private roamSource(task: ExportTask): RoamMessageSource {
    const deps = this.deps.messageBackfill;
    let promise: Promise<GapFetchedMessage[]> | null = null;
    return () => {
      if (!deps || task.guild || (task.kind !== 'group' && task.kind !== 'c2c')) return [];
      promise ??= deps.cached(task.kind, task.conv, 1, 0xffffffff);
      return promise;
    };
  }

  /** A single stage's completion percent (0–100). */
  private stagePercent(s: TaskStage): number {
    if (s.status === 'completed' || s.status === 'skipped') return 100;
    if (s.status === 'pending' || s.total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.floor((s.current / s.total) * 100)));
  }

  /**
   * 追加一行任务日志（环形缓冲，上限 {@link MAX_TASK_LOGS}）。日志不单独推
   * 事件：随下一次 touchStage / 终态 `progress` 事件触发的 listExportTasks
   * 重新拉取一并下发，避免每行日志都触发一次 IPC 往返。
   */
  private log(
    id: string,
    stage: StageKey | 'task',
    text: string,
    level: TaskLogLevel = 'info',
  ): void {
    const arr = this.taskLogs.get(id) ?? [];
    const seq = arr.length > 0 ? arr[arr.length - 1]!.seq + 1 : 1;
    const line: TaskLogLine = { ts: Date.now(), seq, stage, level, text };
    arr.push(line);
    if (arr.length > MAX_TASK_LOGS) arr.splice(0, arr.length - MAX_TASK_LOGS);
    this.taskLogs.set(id, arr);
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
    const prevStatus = s.status;
    Object.assign(s, patch);
    // 阶段状态翻转时补一条生命周期日志，保证每个阶段都有可看的日志。
    if (patch.status && patch.status !== prevStatus) {
      if (patch.status === 'running') {
        this.log(task.id, key, `开始：${s.label}`);
      } else if (patch.status === 'completed') {
        this.log(task.id, key, `${s.label} 完成${s.note ? `：${s.note}` : ''}`);
      } else if (patch.status === 'failed') {
        this.log(task.id, key, `${s.label} 失败${s.note ? `：${s.note}` : ''}`, 'error');
      } else if (patch.status === 'skipped') {
        this.log(task.id, key, `${s.label} 已跳过${s.note ? `：${s.note}` : ''}`, 'warn');
      }
    }
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
      // 先让出事件循环：任务创建 / 列表刷新的 IPC 响应要先回到渲染进程，
      // 否则下面可能长时间阻塞的 seq 空窗扫描会让任务卡片迟迟不出现。
      await new Promise<void>((resolve) => setImmediate(resolve));

      const { avatarCache, mediaDownload, accountDir, ntDataDir, decodeSilk, transcribe } =
        this.deps;
      const wantAvatars = Boolean(task.exportAvatar && avatarCache);
      const wantMedia = Boolean(task.media?.exportMedia);
      const wantTranscribe = Boolean(task.media?.transcribeVoice && transcribe);
      const wantDress = Boolean(
        task.dress &&
          (task.dress.bubble || task.dress.font || task.dress.widget) &&
          this.deps.dressInstall,
      );
      // 收集消息里用到的系统表情 faceId，sysface 阶段据此复制图片到 media/face/。
      const wantSysFaces = Boolean(task.media?.mediaKinds?.sysface);
      const needsScan = wantMedia || wantTranscribe;
      const formats = task.formats?.length ? task.formats : [task.format];
      // Avatars / media / transcription → output is a bundle folder; else a lone
      // file. 系统表情也产出 media/face/，需要 bundle。HTML 始终是 bundle。
      // 多格式同任务：多个文件必须放同一个 bundle 目录。
      const isBundle =
        wantAvatars ||
        wantMedia ||
        wantTranscribe ||
        wantDress ||
        wantSysFaces ||
        task.format === 'html' ||
        formats.length > 1;
      const outDir = isBundle ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (isBundle) mkdirSync(outDir, { recursive: true });
      const mediaRoot = join(outDir, 'media');
      const senders = wantAvatars ? new Set<string>() : undefined;
      const faces = wantSysFaces ? new Set<string>() : undefined;

      // Defensive: a stage created for a capability that isn't injected (no
      // avatar cache / no transcription engine) is skipped up-front, so the
      // overall summary can still reach 100%.
      if (task.exportAvatar && !avatarCache) {
        const s = this.stage(task, 'avatar');
        if (s) {
          s.status = 'skipped';
          s.note = '头像服务不可用';
        }
      }
      if (task.media?.transcribeVoice && !transcribe) {
        const s = this.stage(task, 'transcribe');
        if (s) {
          s.status = 'skipped';
          s.note = '转录引擎不可用';
        }
      }
      if (task.dress && !this.deps.dressInstall) {
        const s = this.stage(task, 'dress');
        if (s) {
          s.status = 'skipped';
          s.note = '装扮服务不可用';
        }
      }

      // ---- stage: 消息补全 (runs FIRST — fills the roam cache so the message
      // stage + media scan below can include the backfilled messages) ----
      const wantBackfill = Boolean(task.media?.completeMessages && !task.guild);
      let rateLimitedNotified = false;
      if (wantBackfill) {
        const backfillDeps = this.deps.messageBackfill;
        const s = this.stage(task, 'backfill');
        if (!backfillDeps) {
          if (s) {
            s.status = 'skipped';
            s.note = '消息补全能力不可用';
          }
        } else {
          this.touchStage(
            task,
            'backfill',
            { status: 'running', note: '扫描 seq 空窗…' },
            { persist: true },
          );
          try {
            let backfilled = 0;
            let backfillDone = 0;
            let backfillTotal = 0;
            const summary = await backfillConversationMessages({
              kind: task.kind === 'group' ? 'group' : 'c2c',
              conv: task.conv,
              // 按导出时间范围收窄 seq 扫描：补全只拉时间窗内的缺失消息。
              listSeqWindow: () => {
                const startTime = task.range?.start ?? undefined;
                const endTime = task.range?.end ?? undefined;
                return task.kind === 'group'
                  ? this.msgsFor(task).getGroupSeqDesc(task.conv, { startTime, endTime })
                  : this.msgsFor(task).getC2cSeqDesc(task.conv, { startTime, endTime });
              },
              fetch: (k, c, start, end) => backfillDeps.fetch(k, c, start, end),
              concurrency: 8,
              signal: abort.signal,
              onPlan: (total) => {
                backfillTotal = total;
                this.log(id, 'backfill', `扫描到 ${total} 个空窗 seq，开始从服务端拉取…`);
                this.touchStage(task, 'backfill', {
                  total,
                  current: 0,
                  note: `共 ${total} 个空窗 seq`,
                });
              },
              onWindow: (fetched, windowSeqs) => {
                if (aborted()) return;
                backfilled += fetched;
                backfillDone += windowSeqs;
                this.log(
                  id,
                  'backfill',
                  fetched > 0
                    ? `窗口（${windowSeqs} seq）拉取 ${fetched} 条，累计 ${backfilled} 条`
                    : `窗口（${windowSeqs} seq）命中缓存 / 无新消息`,
                );
                this.touchStage(task, 'backfill', {
                  current: backfillDone,
                  total: backfillTotal,
                  note: `已拉取 ${backfilled} 条…`,
                });
              },
              onWindowError: (windowSeqs, message) => {
                if (aborted()) return;
                this.log(
                  id,
                  'backfill',
                  `窗口（${windowSeqs} seq）拉取异常（不阻断补全）：${message}`,
                  'warn',
                );
              },
              onRateLimited: () => {
                if (rateLimitedNotified) return;
                rateLimitedNotified = true;
                this.log(id, 'backfill', '请求响应较慢，可能被限流，已放慢节奏等待', 'warn');
                this.emit('progress', {
                  taskId: task.id,
                  status: 'running',
                  progress: task.progress,
                  current: task.current,
                  message: '消息补全可能被限流，请耐心等待',
                  notice: `「${task.name}」消息补全请求响应较慢，可能被限流，请耐心等待拉取完成`,
                });
              },
            });
            if (aborted()) {
              task.status = 'cancelled';
              return;
            }
            const tail = summary.stoppedByEmpty
              ? '，更早的消息已过期'
              : summary.stoppedByError
                ? '，在线状态中断'
                : '';
            const errTail = summary.windowErrors > 0 ? `，失败 ${summary.windowErrors} 窗` : '';
            this.log(
              id,
              'backfill',
              `补全完成：新拉取 ${summary.fetched} 条，请求 ${summary.requests} 次，空窗 ${summary.emptyWindows} 次${tail}${errTail}`,
            );
            this.touchStage(
              task,
              'backfill',
              {
                status: 'completed',
                current: backfillTotal || summary.fetched,
                total: backfillTotal || summary.fetched,
                note: `已补全 ${summary.fetched} 条${tail}${errTail}`,
              },
              { persist: true },
            );
          } catch (e) {
            // 补全失败不阻断导出：以本地已有消息继续，阶段标记失败供 UI 查看。
            if (s) {
              s.status = 'failed';
              s.note = e instanceof Error ? e.message : String(e);
              this.saveTasks();
            }
            this.log(
              id,
              'backfill',
              `消息补全失败（不阻断导出）：${s?.note ?? (e instanceof Error ? e.message : String(e))}`,
              'error',
            );
          }
        }
      }

      // 漫游补全消息的来源：装扮扫描 / 媒体扫描 / 消息导出 / 计数共用（惰性只查一次）。
      const roam = wantBackfill ? this.roamSource(task) : undefined;
      if (wantBackfill) {
        this.log(id, 'task', '补全完成，进入并行阶段：装扮 / 媒体 / 消息同时进行');
      }

      // ================= 并行扫描阶段 =================
      // 装扮用量 / 媒体清单 / 消息计数互不依赖，并行推进；媒体目录解析失败时
      // 直接把所有媒体相关阶段跳过（保持原有兜底语义）。
      let dressUsage: Awaited<ReturnType<typeof collectDressUsage>> | null = null;
      let dressManifest: DressExportManifest | null = null;
      let scan: MediaScanResult | null = null;

      const dirs: MediaDirs | null = needsScan
        ? ntDataDir
          ? mediaDirsFromNtDataDir(ntDataDir)
          : accountDir
            ? mediaDirsFromAccountDir(accountDir)
            : null
        : null;
      if (needsScan && !dirs) {
        // Can't locate on-disk media — skip every media-dependent stage.
        for (const key of [
          'media',
          'record',
          'image',
          'video',
          'file',
          'transcribe',
        ] as StageKey[]) {
          const s = this.stage(task, key);
          if (s) {
            s.status = 'skipped';
            s.note = '无法定位媒体目录';
          }
        }
      }

      if (wantDress && task.dress && this.deps.dressInstall) {
        this.touchStage(
          task,
          'dress',
          { status: 'running', total: 0, note: '扫描会话装扮…' },
          { persist: true },
        );
      }
      const scanStage: StageKey | null =
        needsScan && dirs ? (wantMedia ? 'media' : 'transcribe') : null;
      if (scanStage) {
        this.touchStage(
          task,
          scanStage,
          { status: 'running', note: '扫描媒体…' },
          { persist: true },
        );
      }

      const dressScanPromise =
        wantDress && task.dress && this.deps.dressInstall
          ? collectDressUsage(
              this.msgsFor(task),
              task.kind,
              task.conv,
              task.dress,
              task.range,
              roam,
            )
          : Promise.resolve(null);
      const mediaScanPromise = scanStage
        ? scanConvMedia(this.msgsFor(task), task.kind, task.conv, dirs!, {
            pageSize: 2000,
            range: task.range,
            roam,
          })
        : Promise.resolve(null);
      // 预计算导出总量（本地消息按时间窗计数 + 漫游补全消息），让 message 阶段
      // 从一开始就有分母，且不会出现“已导出条数超过总量”的倒挂。
      const countPromise = (async (): Promise<number> => {
        if (task.kind !== 'group' && task.kind !== 'c2c') return 0;
        try {
          let total = await this.msgsFor(task).countConv(task.kind, task.conv, {
            startTime: task.range?.start ?? undefined,
            endTime: task.range?.end ?? undefined,
          });
          if (roam) {
            total += (await roam()).filter(
              (m) =>
                m.conv === task.conv &&
                (task.range == null ||
                  ((task.range.start == null || Number(m.sendTime) >= task.range.start) &&
                    (task.range.end == null || Number(m.sendTime) <= task.range.end))),
            ).length;
          }
          return total;
        } catch {
          return 0; // 计数失败不阻塞导出，仅退回无分母进度
        }
      })();

      const [dressUsageResult, scanResult, messageTotal] = await Promise.all([
        dressScanPromise,
        mediaScanPromise,
        countPromise,
      ]);
      if (aborted()) {
        task.status = 'cancelled';
        return;
      }
      dressUsage = dressUsageResult;
      scan = scanResult;
      if (scan) {
        this.log(
          id,
          scanStage ?? 'media',
          `媒体扫描：引用 ${scan.totalRefs} → 去重 ${scan.uniqueFiles}，本地命中 ${scan.foundFiles}，缺失 ${scan.missingFiles}（过期 ${scan.expiredFiles} · 可下载 ${scan.downloadableFiles}），耗时 ${scan.durationMs}ms`,
        );
        this.log(
          id,
          scanStage ?? 'media',
          `媒体索引：${scan.indexedDirs} 个目录 / ${scan.indexedFiles} 个文件（收集 ${scan.collectMs}ms · 建索引 ${scan.indexBuildMs}ms · 匹配 ${scan.matchMs}ms）`,
        );
      }
      const dressUsed = dressUsage
        ? dressUsage.bubbles.size + dressUsage.fonts.size + dressUsage.widgets.size
        : 0;
      if (dressUsage) {
        this.log(
          id,
          'dress',
          `装扮扫描：气泡 ${dressUsage.bubbles.size} · 字体 ${dressUsage.fonts.size} · 挂件 ${dressUsage.widgets.size}`,
        );
        if (dressUsed === 0) {
          this.touchStage(
            task,
            'dress',
            { status: 'completed', current: 0, total: 0, note: '会话未使用装扮' },
            { persist: true },
          );
        }
      }

      // ================= 主并行阶段 =================
      // 消息导出 / 装扮资产 / 媒体搬运 / 四路补全下载 / 语音解码·转写全部并发；
      // sysface / avatar 依赖消息导出收集的 faceId / 发言者，完成后接续执行。
      const jobs: Array<() => Promise<void>> = [];
      let dressExportPromise: Promise<DressExportResult | null> | null = null;

      // ---- 装扮资产导出（与消息导出、媒体补全并发，不再单独串行） ----
      if (dressUsage && dressUsed > 0 && task.dress && this.deps.dressInstall) {
        const kinds = task.dress;
        this.touchStage(
          task,
          'dress',
          { status: 'running', total: dressUsed, current: 0, note: '准备 0 项装扮资源' },
          { persist: true },
        );
        dressExportPromise = (async (): Promise<DressExportResult | null> => {
          try {
            const r = await exportDressAssets(
              this.deps.dressInstall!,
              outDir,
              dressUsage!,
              kinds,
              (done, total, note) => {
                if (aborted()) return;
                this.touchStage(task, 'dress', {
                  current: done,
                  total,
                  note: `${note} · ${done}/${total}`,
                });
                this.log(id, 'dress', `${note}（${done}/${total}）`);
              },
              task.media?.completeDress !== false,
            );
            dressManifest = r.manifest;
            this.touchStage(
              task,
              'dress',
              {
                status: 'completed',
                current: r.ok,
                total: dressUsed,
                failed: r.failed,
                note: `已导出 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
              },
              { persist: true },
            );
            if (r.failed > 0) this.log(id, 'dress', `${r.failed} 项装扮资源导出失败`, 'warn');
            return r;
          } catch (e) {
            // 装扮失败不阻断导出：阶段标记失败供 UI 查看。
            const s = this.stage(task, 'dress');
            if (s) {
              s.status = 'failed';
              s.note = e instanceof Error ? e.message : String(e);
              this.saveTasks();
            }
            this.log(
              id,
              'dress',
              `装扮导出失败（不阻断导出）：${e instanceof Error ? e.message : String(e)}`,
              'error',
            );
            return null;
          }
        })();
        jobs.push(async () => {
          await dressExportPromise;
        });
      }

      // ---- 消息导出（HTML + 装扮需等 manifest；其余格式仅等装扮用量扫描） ----
      const messageJob = (async (): Promise<ExportResult | null> => {
        if (task.format === 'html' && dressExportPromise) await dressExportPromise;
        this.touchStage(
          task,
          'message',
          {
            status: 'running',
            total: messageTotal * formats.length,
            note: formats.length > 1 ? `开始导出 ${formats.length} 种格式` : '开始导出',
          },
          { persist: true },
        );
        const result = await this.exportMessages(
          task,
          outDir,
          senders,
          wantMedia,
          (current, note) => {
            if (aborted()) return;
            this.touchStage(task, 'message', { current, note });
          },
          faces,
          roam,
          dressUsage?.byMsg,
          dressManifest,
          task.dress,
        );
        task.filePath = result.filePath;
        task.current = result.messageCount;
        if (aborted()) {
          task.status = 'cancelled';
          return null;
        }
        this.touchStage(
          task,
          'message',
          {
            status: 'completed',
            current: result.messageCount,
            total: result.messageCount,
            note:
              formats.length > 1
                ? `${result.messageCount} 条 × ${formats.length} 种格式`
                : `${result.messageCount} 条`,
          },
          { persist: true },
        );
        this.log(
          id,
          'message',
          `消息导出完成：${result.messageCount} 条，耗时 ${Math.round(result.durationMs / 1000)}s`,
        );
        if (isBundle) task.bundleDir = outDir;
        return result;
      })();

      // ---- 搬运媒体（并发）：本地已找到的图片/视频/文件复制进 bundle ----
      if (wantMedia && scan) {
        const scanRes = scan;
        const kinds = task.media?.mediaKinds;
        const found = scanRes.found.filter((r) => {
          if (r.kind === 'ptt') return false;
          if ((r.kind === 'pic' || r.kind === 'emoji') && kinds?.image === false) return false;
          if (r.kind === 'video' && kinds?.video === false) return false;
          if (r.kind === 'file' && kinds?.file === false) return false;
          return true;
        });
        jobs.push(async () => {
          if (found.length === 0) {
            this.log(id, 'media', '搬运媒体：本地没有已找到的媒体文件（跳过）');
            this.touchStage(
              task,
              'media',
              {
                status: 'completed',
                current: 0,
                total: 0,
                note: '本地无媒体文件',
              },
              { persist: true },
            );
            return;
          }
          this.log(id, 'media', `搬运媒体：共 ${found.length} 项本地媒体，开始复制…`);
          this.touchStage(
            task,
            'media',
            {
              status: 'running',
              total: found.length,
              current: 0,
              note: `搬运 0/${found.length}`,
            },
            { persist: true },
          );
          const r = await copyFoundMedia(
            scanRes,
            mediaRoot,
            (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'media', {
                current: done,
                total,
                note: `搬运 ${done}/${total}`,
              });
            },
            8,
            kinds,
            (text, level) => this.log(id, 'media', text, level ?? 'info'),
          );
          this.touchStage(
            task,
            'media',
            {
              status: 'completed',
              current: r.total,
              total: r.total,
              failed: r.failed,
              note: `已搬运 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
              ...(r.failures ? { failures: r.failures } : {}),
            },
            { persist: true },
          );
          this.log(id, 'media', `搬运完成：成功 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`);
        });
      }

      if (wantSysFaces && faces) {
        jobs.push(async () => {
          // 表情集合由消息导出收集，等 message 阶段完成后接续执行。
          // 纯数字 = 系统表情(小黄脸)；`pack:hash` = 商城表情贴图，都归类在「QQ系统表情」。
          await messageJob.catch(() => null);
          if (aborted()) return;
          if (faces.size === 0) {
            const s0 = this.stage(task, 'sysface');
            if (s0) {
              s0.status = 'completed';
              s0.current = 0;
              s0.total = 0;
              s0.note = '会话未使用表情';
              this.saveTasks();
            }
            this.log(id, 'sysface', '会话未使用系统表情 / 商城表情，跳过导出');
            return;
          }
          const sysIds: string[] = [];
          const mfaceRefs: string[] = [];
          for (const ref of faces) {
            if (/^\d+$/.test(ref)) sysIds.push(ref);
            else if (ref.includes(':')) mfaceRefs.push(ref);
          }
          this.touchStage(
            task,
            'sysface',
            { status: 'running', total: faces.size, current: 0, note: `导出 0/${faces.size}` },
            { persist: true },
          );
          this.log(
            id,
            'sysface',
            `导出表情：系统 ${sysIds.length} 个 · 商城 ${mfaceRefs.length} 张`,
          );
          let ok = 0;
          let failed = 0;
          if (sysIds.length > 0) {
            const emojiDir = this.deps.emojiDir;
            if (!emojiDir) {
              failed += sysIds.length;
              this.log(id, 'sysface', '未找到系统表情资源目录，跳过系统表情', 'warn');
            } else {
              const r = await exportSysFaces(sysIds, emojiDir, mediaRoot, (done, total) => {
                if (aborted()) return;
                this.touchStage(task, 'sysface', {
                  current: done,
                  total,
                  note: `导出 ${done}/${total}`,
                });
              });
              ok += r.ok;
              failed += r.failed;
            }
          }
          if (mfaceRefs.length > 0) {
            const resolve = this.deps.marketFace;
            if (!resolve) {
              failed += mfaceRefs.length;
              this.log(id, 'sysface', '商城表情服务不可用，跳过商城表情', 'warn');
            } else {
              const r = await exportMarketFaces(mfaceRefs, resolve, mediaRoot, (done, total) => {
                if (aborted()) return;
                this.touchStage(task, 'sysface', {
                  current: done,
                  total,
                  note: `导出 ${done}/${total}`,
                });
              });
              ok += r.ok;
              failed += r.failed;
            }
          }
          this.touchStage(
            task,
            'sysface',
            {
              status: 'completed',
              current: faces.size,
              total: faces.size,
              failed,
              note: `已导出 ${ok}${failed ? ` · 失败 ${failed}` : ''}`,
            },
            { persist: true },
          );
        });
      }

      // 频道私聊导出头像：会话只有双方（对方 + 自己），且没有 uin 可拼 qlogo，
      // 头像依据身份快照里的公开 URL（avatar_meta / 主帐号 qlogo）写进 avatars/ 目录。
      if (wantAvatars && task.guild && avatarCache) {
        jobs.push(async () => {
          // 与 c2c 一样等 message 阶段结束后执行（为了序列与步骤视图一致）。
          await messageJob.catch(() => null);
          if (aborted()) return;
          const g = task.guild!;
          const targets: Array<{ id: string; url: string | null }> = [
            { id: g.peerTinyId, url: g.peerAvatarUrl },
            ...(g.selfTinyId ? [{ id: g.selfTinyId, url: g.selfAvatarUrl ?? null }] : []),
          ];
          const usable = targets.filter((t) => t.url);
          if (usable.length === 0) {
            const s0 = this.stage(task, 'avatar');
            if (s0) {
              s0.status = 'completed';
              s0.current = 0;
              s0.total = 0;
              s0.note = '无可用头像来源';
              this.saveTasks();
            }
            this.log(id, 'avatar', '频道私聊会话无可用头像来源，跳过头像下载');
            return;
          }
          this.log(id, 'avatar', `下载头像：共 ${usable.length} 位成员（频道私聊）`);
          this.touchStage(
            task,
            'avatar',
            {
              status: 'running',
              total: usable.length,
              current: 0,
              note: `下载 0/${usable.length}`,
            },
            { persist: true },
          );
          const r = await exportGuildAvatars(avatarCache, usable, outDir, {
            onProgress: (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'avatar', {
                current: done,
                total,
                note: `下载 ${done}/${total}`,
              });
              if (done % 50 === 0 || done === total) {
                this.log(id, 'avatar', `下载头像 ${done}/${total}`);
              }
            },
          });
          task.avatarCount = r.ok;
          this.touchStage(
            task,
            'avatar',
            {
              status: 'completed',
              current: r.total,
              total: r.total,
              failed: r.failed,
              note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
            },
            { persist: true },
          );
        });
      } else if (wantAvatars && senders && avatarCache) {
        jobs.push(async () => {
          // 发言者集合由消息导出收集，等 message 阶段完成后接续执行。
          await messageJob.catch(() => null);
          if (aborted()) return;
          if (senders.size === 0) {
            const s0 = this.stage(task, 'avatar');
            if (s0) {
              s0.status = 'completed';
              s0.current = 0;
              s0.total = 0;
              s0.note = '会话无发言者';
              this.saveTasks();
            }
            this.log(id, 'avatar', '会话无发言者，跳过头像下载');
            return;
          }
          this.log(id, 'avatar', `下载头像：共 ${senders.size} 个发言者`);
          this.touchStage(
            task,
            'avatar',
            { status: 'running', total: senders.size, current: 0, note: `下载 0/${senders.size}` },
            { persist: true },
          );
          const r = await exportAvatars(avatarCache, senders, outDir, {
            onProgress: (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'avatar', {
                current: done,
                total,
                note: `下载 ${done}/${total}`,
              });
              if (done % 50 === 0 || done === total) {
                this.log(id, 'avatar', `下载头像 ${done}/${total}`);
              }
            },
          });
          task.avatarCount = r.ok;
          this.touchStage(
            task,
            'avatar',
            {
              status: 'completed',
              current: r.total,
              total: r.total,
              failed: r.failed,
              note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
            },
            { persist: true },
          );
        });
      }

      // 语音类别被取消勾选时，record 阶段不会启动——提前标 skipped，避免整体
      // 进度永远到不了 100%。
      if (wantMedia && scan && task.media?.mediaKinds?.voice === false) {
        const recS = this.stage(task, 'record');
        if (recS) {
          recS.status = 'skipped';
          recS.note = '未勾选语音';
        }
      }

      if (wantMedia && scan && task.media?.mediaKinds?.voice !== false) {
        const found = scan;
        // 解码语音 — SILK-decode locally-found voices.
        jobs.push(async () => {
          const voices = found.found.filter((r) => r.kind === 'ptt');
          const recStage = this.stage(task, 'record');
          if (!decodeSilk) {
            if (recStage) {
              recStage.status = 'skipped';
              recStage.note = '解码不可用';
            }
            return;
          }
          this.log(id, 'record', `解码语音：共 ${voices.length} 条本地语音`);
          this.touchStage(
            task,
            'record',
            {
              status: 'running',
              total: voices.length,
              current: 0,
              note: `解码 0/${voices.length}`,
            },
            { persist: true },
          );
          const r = await decodeFoundVoices(
            found,
            mediaRoot,
            decodeSilk,
            (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'record', {
                current: done,
                total,
                note: `解码 ${done}/${total}`,
              });
            },
            4,
            (text, level) => this.log(id, 'record', text, level ?? 'info'),
          );
          this.touchStage(
            task,
            'record',
            {
              status: 'completed',
              current: r.total,
              total: r.total,
              failed: r.failed,
              note: `已解码 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
              ...(r.failures ? { failures: r.failures } : {}),
            },
            { persist: true },
          );
        });

        if (
          task.media?.completeMedia ||
          task.media?.downloadVideo ||
          task.media?.downloadFile ||
          task.media?.downloadPtt
        ) {
          if (task.media?.completeMedia) {
            // 补全图片 — CDN-complete missing images.
            jobs.push(async () => {
              const imgStage = this.stage(task, 'image');
              if (!mediaDownload) {
                if (imgStage) {
                  imgStage.status = 'skipped';
                  imgStage.note = '下载不可用';
                }
                return;
              }
              const missing = found.downloadList.filter(
                (r) => r.kind === 'pic' || r.kind === 'emoji',
              );
              this.log(
                id,
                'image',
                missing.length > 0
                  ? `补全图片：共 ${missing.length} 张缺失`
                  : '补全图片：无缺失图片',
              );
              this.touchStage(
                task,
                'image',
                {
                  status: 'running',
                  total: missing.length,
                  current: 0,
                  note: `下载 0/${missing.length}`,
                },
                { persist: true },
              );
              const r = await downloadMissingImages(
                found,
                mediaRoot,
                mediaDownload,
                (done, total) => {
                  if (aborted()) return;
                  this.touchStage(task, 'image', {
                    current: done,
                    total,
                    note: `下载 ${done}/${total}`,
                  });
                },
                8,
                (text, level) => this.log(id, 'image', text, level ?? 'info'),
              );
              this.touchStage(
                task,
                'image',
                {
                  status: 'completed',
                  current: r.total,
                  total: r.total,
                  failed: r.failed,
                  note: `已补全 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
                  ...(r.failures ? { failures: r.failures } : {}),
                },
                { persist: true },
              );
            });
          }
          // 补全视频 / 文件 — OIDB-resolve + download (each gated by its toggle).
          jobs.push(() =>
            this.runUrlDownloadStage(
              task,
              'video',
              found,
              mediaRoot,
              Boolean(task.media?.downloadVideo),
              aborted,
              (text, level) => this.log(id, 'video', text, level ?? 'info'),
            ),
          );
          jobs.push(() =>
            this.runUrlDownloadStage(
              task,
              'file',
              found,
              mediaRoot,
              Boolean(task.media?.downloadFile),
              aborted,
              (text, level) => this.log(id, 'file', text, level ?? 'info'),
            ),
          );
          // 补全语音 — OIDB-resolve + SILK-decode into media/record/*.wav.
          jobs.push(() =>
            this.runUrlDownloadStage(
              task,
              'ptt',
              found,
              mediaRoot,
              Boolean(task.media?.downloadPtt),
              aborted,
              (text, level) => this.log(id, 'ptt', text, level ?? 'info'),
            ),
          );
        }
      }

      if (wantTranscribe && transcribe && scan) {
        const found = scan;
        jobs.push(async () => {
          const voices = found.found.filter((r) => r.kind === 'ptt');
          this.log(id, 'transcribe', `语音转写：共 ${voices.length} 条语音`);
          this.touchStage(
            task,
            'transcribe',
            {
              status: 'running',
              total: voices.length,
              current: 0,
              note: `转写 0/${voices.length}`,
            },
            { persist: true },
          );
          const r = await transcribeFoundVoices(
            found,
            outDir,
            transcribe,
            (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'transcribe', {
                current: done,
                total,
                note: `转写 ${done}/${total}`,
              });
            },
            2,
            async (ref, text) => {
              // Cache the result on the element (wire tag 45923) so this clip is
              // skipped on any later export — and shows up in chat right away.
              await this.msgsFor(task).setPttTranscript(BigInt(ref.msgId), ref.fileName, text);
            },
            (text, level) => this.log(id, 'transcribe', text, level ?? 'info'),
          );
          this.touchStage(
            task,
            'transcribe',
            {
              status: 'completed',
              current: r.total,
              total: r.total,
              failed: r.failed,
              note: `已转写 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
              ...(r.failures ? { failures: r.failures } : {}),
            },
            { persist: true },
          );
        });
      }

      // Run the batch concurrently; one stage's failure shouldn't sink the rest.
      const settled = await Promise.allSettled([...jobs.map((j) => j()), messageJob]);
      const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (firstError) throw firstError.reason;

      // 防御：所有子任务都已 settle，不应再有阶段处于 running / pending。
      // 若仍有（例如某阶段因条件未启动），记录警告便于排查，而不是静默完成。
      const dangling = task.stages.filter((s) => s.status === 'running' || s.status === 'pending');
      if (dangling.length > 0) {
        this.log(
          id,
          'task',
          `警告：阶段 ${dangling.map((s) => s.label).join('、')} 仍处于未完成状态`,
          'warn',
        );
      }

      if (aborted()) {
        task.status = 'cancelled';
        return;
      }
      this.log(
        id,
        'task',
        `导出完成：${task.current} 条${task.bundleDir ? '（含资源 bundle）' : ''}`,
      );
      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'failed';
      task.error = String((e as Error)?.message ?? e);
      // Mark the running stage failed so the UI shows where it broke.
      const running = task.stages.find((s) => s.status === 'running');
      if (running) {
        running.status = 'failed';
        running.note = task.error;
      }
      this.log(id, 'task', `导出失败：${task.error}`, 'error');
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '导出完成' : (task.error ?? '已取消'),
      });
    }
  }

  /**
   * QQ 空间说说导出：翻页拉说说 → 写 json/txt/html →（可选）下载配图。
   * 独立于消息流水线；`conv` 是目标空间 uin（好友或自己），拉取能力走注入的
   * `deps.qzone`。含 html 格式时强制下载配图。
   */
  private async runQzoneTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();

    const abort = new AbortController();
    this.abortControllers.set(id, abort);
    const aborted = (): boolean => abort.signal.aborted;

    try {
      const qzone = this.deps.qzone;
      if (!qzone) throw new Error('QQ 空间拉取能力不可用（需在线 QQ）。');
      // HTML 导出靠本地配图渲染，含 html 格式时强制下载配图（不管用户是否勾选）。
      const formats = task.formats?.length ? task.formats : [task.format];
      const wantMedia = Boolean(task.media?.exportMedia) || formats.includes('html');
      // HTML 需要完整渲染：含 html 格式时同样强制拉取评论 / 点赞（能力不可用时跳过）。
      const wantInteraction = Boolean(
        (task.qzoneInteractions || formats.includes('html')) && qzone.fetchInteractions,
      );
      // 多格式或下载配图 → 产物为 bundle 目录（多个文件 + media/），否则单文件。
      const isBundle = wantMedia || formats.length > 1;
      const outDir = isBundle ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (isBundle) mkdirSync(outDir, { recursive: true });
      const mediaRoot = wantMedia ? join(outDir, 'media') : undefined;

      this.touchStage(
        task,
        'message',
        {
          status: 'running',
          note: formats.length > 1 ? `拉取说说 × ${formats.length} 种格式…` : '拉取说说…',
        },
        { persist: true },
      );
      let totalCount = 0;
      let mediaOk = 0;
      let mediaFailed = 0;
      let interactionSummary: string | undefined;
      let firstFilePath = '';
      for (let i = 0; i < formats.length; i += 1) {
        const format = formats[i]!;
        const outPath = join(
          outDir,
          `${sanitizeSegment(task.name, task.conv || task.id)}.${format}`,
        );
        if (i === 0) firstFilePath = outPath;
        const base = totalCount;
        const qzoneFormat = format === 'txt' ? 'txt' : format === 'html' ? 'html' : 'json';
        const result = await exportQzone(
          {
            targetUin: task.conv,
            name: task.name,
            format: qzoneFormat,
            outputPath: outPath,
            // 配图 / 互动都只取一次（第一份格式携带），多格式产物共用。
            mediaRoot: i === 0 ? mediaRoot : undefined,
            includeInteraction: i === 0 ? wantInteraction : false,
            range: task.range,
            onProgress: (current, total, note) => {
              if (aborted()) return;
              const prefix =
                formats.length > 1 ? `[${i + 1}/${formats.length} ${format.toUpperCase()}] ` : '';
              this.touchStage(task, 'message', {
                current: base + current,
                total: base + (total || current),
                note: `${prefix}${note}`,
              });
              this.log(id, 'message', `${prefix}${note}`);
            },
            onMedia: (done, total) => {
              if (aborted()) return;
              this.touchStage(task, 'media', {
                status: 'running',
                current: done,
                total,
                note: `下载 ${done}/${total}`,
              });
              this.log(id, 'media', `下载媒体 ${done}/${total}`);
            },
            onInteraction: (done, total, note) => {
              if (aborted()) return;
              this.touchStage(task, 'message', {
                status: 'running',
                current: base + done,
                total: base + (total || done),
                note,
              });
              this.log(id, 'message', note);
            },
            signal: abort.signal,
          },
          qzone,
        );
        if (aborted()) {
          task.status = 'cancelled';
          return;
        }
        totalCount += result.count;
        mediaOk += result.mediaOk;
        mediaFailed += result.mediaFailed;
        if (i === 0 && result.interaction) {
          const it = result.interaction;
          interactionSummary = it.failed
            ? '互动拉取失败（正文已导出）'
            : it.posts > 0
              ? `互动 ${it.posts} 条 · 评论 ${it.comments} / 赞 ${it.likes}`
              : '未发现评论 / 点赞';
          this.log(id, 'message', interactionSummary);
        }
        if (formats.length > 1) {
          this.log(id, 'message', `格式 ${format.toUpperCase()} 完成：${result.count} 条说说`);
        }
      }

      task.filePath = firstFilePath;
      task.current = totalCount;
      if (isBundle) task.bundleDir = outDir;
      this.touchStage(
        task,
        'message',
        {
          status: 'completed',
          current: totalCount,
          total: totalCount,
          note: [
            formats.length > 1
              ? `${totalCount} 条 × ${formats.length} 种格式`
              : `${totalCount} 条说说`,
            ...(interactionSummary ? [interactionSummary] : []),
          ].join(' · '),
        },
        { persist: true },
      );
      if (wantMedia) {
        this.touchStage(
          task,
          'media',
          {
            status: 'completed',
            current: mediaOk + mediaFailed,
            total: mediaOk + mediaFailed,
            failed: mediaFailed,
            note: `已下载 ${mediaOk}${mediaFailed ? ` · 失败 ${mediaFailed}` : ''}`,
          },
          { persist: true },
        );
      }
      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'failed';
      task.error = String((e as Error)?.message ?? e);
      const running = task.stages.find((s) => s.status === 'running');
      if (running) {
        running.status = 'failed';
        running.note = task.error;
      }
      this.log(id, 'task', `导出失败：${task.error}`, 'error');
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '导出完成' : (task.error ?? '已取消'),
      });
    }
  }

  /**
   * 联系人导出：拉好友/群成员写表 →（可选）下载头像。独立于消息流水线；
   * `contacts.scope==='group'` 时 `conv` 为群号，拉取能力走注入的 `deps.contacts`。
   */
  private async runContactsTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();

    const abort = new AbortController();
    this.abortControllers.set(id, abort);
    const aborted = (): boolean => abort.signal.aborted;

    try {
      const deps = this.deps.contacts;
      if (!deps) throw new Error('联系人数据拉取能力不可用。');
      const avatarCache = this.deps.avatarCache;
      const wantAvatars = Boolean(task.exportAvatar && avatarCache);

      const formats = task.formats?.length ? task.formats : [task.format];
      // 有头像或多格式 → 产物为 bundle 目录（表文件 + avatars/），否则单文件。
      const isBundle = wantAvatars || formats.length > 1;
      const outDir = isBundle ? join(this.cacheDir, `bundle-${id}`) : this.cacheDir;
      if (isBundle) mkdirSync(outDir, { recursive: true });
      const uins = wantAvatars ? new Set<string>() : undefined;

      if (task.exportAvatar && !avatarCache) {
        const s = this.stage(task, 'avatar');
        if (s) {
          s.status = 'skipped';
          s.note = '头像服务不可用';
        }
      }

      // ---- stage: 导出联系人（多格式时逐格式写表，头像只下一份） ----
      this.touchStage(
        task,
        'message',
        { status: 'running', note: formats.length > 1 ? '开始导出多格式…' : '开始导出' },
        { persist: true },
      );
      let totalCount = 0;
      let firstFilePath = '';
      for (let i = 0; i < formats.length; i += 1) {
        const format = formats[i]!;
        const ext = format === 'vcard' ? 'vcf' : format;
        const outPath = join(outDir, `${sanitizeSegment(task.name, task.conv || task.id)}.${ext}`);
        if (i === 0) firstFilePath = outPath;
        const base = totalCount;
        const onProgress = (current: number, total: number, note: string): void => {
          if (aborted()) return;
          const prefix =
            formats.length > 1 ? `[${i + 1}/${formats.length} ${format.toUpperCase()}] ` : '';
          this.touchStage(task, 'message', {
            current: base + current,
            total: base + (total || current),
            note: `${prefix}${note}`,
          });
          this.log(id, 'message', `${prefix}${note}`);
        };
        const result =
          task.contacts?.scope === 'group'
            ? await exportGroupMembers(
                {
                  groupCode: task.conv,
                  format: (format === 'vcard' ? 'txt' : format) as Exclude<ContactsFormat, 'vcard'>,
                  outputPath: outPath,
                  collectUins: uins,
                  onProgress,
                  signal: abort.signal,
                },
                deps,
              )
            : await exportFriends(
                {
                  format: format as ContactsFormat,
                  outputPath: outPath,
                  categoryIds: task.contacts?.categoryIds,
                  collectUins: uins,
                  onProgress,
                  signal: abort.signal,
                },
                deps,
              );
        if (aborted()) {
          task.status = 'cancelled';
          return;
        }
        totalCount += result.count;
        if (formats.length > 1) {
          this.log(id, 'message', `格式 ${format.toUpperCase()} 完成：${result.count} 位`);
        }
      }

      task.filePath = firstFilePath;
      task.current = totalCount;
      if (isBundle) task.bundleDir = outDir;
      this.touchStage(
        task,
        'message',
        {
          status: 'completed',
          current: totalCount,
          total: totalCount,
          note:
            formats.length > 1
              ? `${totalCount} 位 × ${formats.length} 种格式`
              : `${totalCount} 位联系人`,
        },
        { persist: true },
      );

      // ---- stage: 下载头像（可选） ----
      if (wantAvatars && uins && avatarCache) {
        this.touchStage(
          task,
          'avatar',
          { status: 'running', total: uins.size, current: 0, note: `下载 0/${uins.size}` },
          { persist: true },
        );
        const r = await exportAvatars(avatarCache, uins, outDir, {
          onProgress: (done, total) => {
            if (aborted()) return;
            this.touchStage(task, 'avatar', {
              current: done,
              total,
              note: `下载 ${done}/${total}`,
            });
            // 头像量可能上千，按 50 个一批打日志，避免刷屏。
            if (done % 50 === 0 || done === total) {
              this.log(id, 'avatar', `下载头像 ${done}/${total}`);
            }
          },
        });
        task.avatarCount = r.ok;
        this.touchStage(
          task,
          'avatar',
          {
            status: 'completed',
            current: r.total,
            total: r.total,
            failed: r.failed,
            note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
          },
          { persist: true },
        );
      }
      if (aborted()) {
        task.status = 'cancelled';
        return;
      }

      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'failed';
      task.error = String((e as Error)?.message ?? e);
      const running = task.stages.find((s) => s.status === 'running');
      if (running) {
        running.status = 'failed';
        running.note = task.error;
      }
      this.log(id, 'task', `导出失败：${task.error}`, 'error');
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '导出完成' : (task.error ?? '已取消'),
      });
    }
  }

  /**
   * 收藏导出：翻页拉全收藏 → 写表格文件。独立于消息流水线；拉取能力走注入的
   * `deps.collection`（返回已拍平的行）。无媒体 / 头像阶段，单文件产物。
   */
  private async runCollectionTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();

    const abort = new AbortController();
    this.abortControllers.set(id, abort);
    const aborted = (): boolean => abort.signal.aborted;

    try {
      const deps = this.deps.collection;
      if (!deps) throw new Error('收藏数据拉取能力不可用。');

      const outPath = join(
        this.cacheDir,
        `${sanitizeSegment(task.name, task.conv || task.id)}.${task.format}`,
      );

      this.touchStage(task, 'message', { status: 'running', note: '开始导出' }, { persist: true });
      const result = await exportCollections(
        {
          format: task.format as CollectionFormat,
          outputPath: outPath,
          kinds: task.collection?.kinds,
          onProgress: (current, total, note) => {
            if (aborted()) return;
            this.touchStage(task, 'message', { current, total, note });
            this.log(id, 'message', note);
          },
          signal: abort.signal,
        },
        deps,
      );
      if (aborted()) {
        task.status = 'cancelled';
        return;
      }

      task.filePath = result.filePath;
      task.current = result.count;
      this.touchStage(
        task,
        'message',
        {
          status: 'completed',
          current: result.count,
          total: result.count,
          note: `${result.count} 条收藏`,
        },
        { persist: true },
      );

      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'failed';
      task.error = String((e as Error)?.message ?? e);
      const running = task.stages.find((s) => s.status === 'running');
      if (running) {
        running.status = 'failed';
        running.note = task.error;
      }
      this.log(id, 'task', `导出失败：${task.error}`, 'error');
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '导出完成' : (task.error ?? '已取消'),
      });
    }
  }

  /**
   * 商城表情批量下载：对每套包 → 拉表情列表 + 恢复一次密钥 → 并发解密下载每张 GIF
   * 到 `bundle/<包名>/<表情名>.gif`。独立于消息流水线；解密能力走注入的
   * `deps.marketpack`（桥接 EmojiService）。单 `sticker` 阶段跨所有包累计进度。
   */
  private async runMarketPackTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status === 'cancelled') return;

    task.status = 'running';
    task.updatedAt = Date.now();
    this.saveTasks();

    const abort = new AbortController();
    this.abortControllers.set(id, abort);
    const aborted = (): boolean => abort.signal.aborted;

    try {
      const deps = this.deps.marketpack;
      if (!deps) throw new Error('商城表情解密下载能力不可用。');
      const packs = task.marketpack?.packs ?? [];

      const { mkdir, copyFile } = await import('node:fs/promises');
      const outDir = join(this.cacheDir, `bundle-${id}`);
      await mkdir(outDir, { recursive: true });
      task.bundleDir = outDir;

      // 先把每套包的表情列表拉齐，算出总张数（进度分母）。密钥每包恢复一次并缓存。
      this.touchStage(
        task,
        'sticker',
        { status: 'running', note: '获取表情列表…' },
        { persist: true },
      );
      const usedDirs = new Set<string>();
      const jobs: Array<{
        packId: string;
        packDir: string;
        hash: string;
        name: string;
        key?: string;
        used: Set<string>;
      }> = [];
      for (const pack of packs) {
        if (aborted()) {
          task.status = 'cancelled';
          return;
        }
        const detail = await deps.getPackDetail(pack.id);
        if (!detail || detail.items.length === 0) {
          this.log(id, 'sticker', `表情包「${pack.name}」无可用表情列表，已跳过`, 'warn');
          continue;
        }
        this.log(id, 'sticker', `表情包「${pack.name}」：共 ${detail.items.length} 张`);
        const key = (await deps.getPackKey(pack.id))?.key;
        const packDirName = uniqueName(sanitizeSegment(pack.name, pack.id), usedDirs);
        const packDir = join(outDir, packDirName);
        await mkdir(packDir, { recursive: true });
        const usedFiles = new Set<string>();
        for (const it of detail.items) {
          jobs.push({
            packId: pack.id,
            packDir,
            hash: it.hash,
            name: it.name,
            key,
            used: usedFiles,
          });
        }
      }

      const total = jobs.length;
      let done = 0;
      let ok = 0;
      const failures: MediaFailure[] = [];
      // task.total 起初是包套数（packs.length），下载开始后改成总张数，与 task.current 单位一致。
      task.total = total;
      this.touchStage(
        task,
        'sticker',
        { total, current: 0, note: `下载 0/${total}` },
        { persist: true },
      );

      // 并发解密下载（每张：CDN 加密流 → QQTEA 解密 → 缓存路径 → 复制进 bundle）。
      const CONCURRENCY = 6;
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (aborted()) return;
          const idx = next++;
          if (idx >= jobs.length) return;
          const job = jobs[idx]!;
          try {
            const src = await deps.getPackImagePath(job.packId, job.hash, job.key);
            if (!src) throw new Error('解密或下载失败');
            const fileName = `${uniqueName(sanitizeSegment(job.name, job.hash), job.used)}.gif`;
            await copyFile(src, join(job.packDir, fileName));
            ok += 1;
          } catch (e) {
            if (failures.length < 100) {
              failures.push({
                stage: 'sticker',
                fileName: job.name || job.hash,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          } finally {
            done += 1;
            if (!aborted()) {
              task.current = done;
              this.touchStage(task, 'sticker', {
                current: done,
                total,
                note: `下载 ${done}/${total}`,
              });
              if (done % 50 === 0 || done === total) {
                this.log(id, 'sticker', `下载表情 ${done}/${total}`);
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
      if (aborted()) {
        task.status = 'cancelled';
        return;
      }

      const failed = total - ok;
      task.current = ok;
      task.total = total;
      this.touchStage(
        task,
        'sticker',
        {
          status: 'completed',
          current: total,
          total,
          failed,
          note: `已下载 ${ok}${failed ? ` · 失败 ${failed}` : ''}`,
          ...(failures.length ? { failures } : {}),
        },
        { persist: true },
      );

      task.status = 'completed';
      task.progress = 100;
    } catch (e) {
      task.status = 'failed';
      task.error = String((e as Error)?.message ?? e);
      const running = task.stages.find((s) => s.status === 'running');
      if (running) {
        running.status = 'failed';
        running.note = task.error;
      }
      this.log(id, 'task', `导出失败：${task.error}`, 'error');
    } finally {
      task.updatedAt = Date.now();
      this.abortControllers.delete(id);
      this.saveTasks();
      this.emit('progress', {
        taskId: id,
        status: task.status,
        progress: task.progress,
        current: task.current,
        message: task.status === 'completed' ? '下载完成' : (task.error ?? '已取消'),
      });
    }
  }

  /** Run a video/file/ptt download stage: gated by its toggle and a usable mediaUrl. */
  private async runUrlDownloadStage(
    task: ExportTask,
    key: 'video' | 'file' | 'ptt',
    scan: import('./media_scan').MediaScanResult,
    mediaRoot: string,
    enabled: boolean,
    aborted: () => boolean,
    onLog: (text: string, level?: TaskLogLevel) => void,
  ): Promise<void> {
    const s = this.stage(task, key);
    if (!s) return;
    if (!enabled) {
      s.status = 'skipped';
      s.note = '未勾选下载';
      this.saveTasks();
      return;
    }
    if (!this.deps.mediaUrl) {
      s.status = 'skipped';
      s.note = '无法获取下载地址';
      this.saveTasks();
      return;
    }
    if (key === 'ptt' && !this.deps.decodeSilk) {
      s.status = 'skipped';
      s.note = '解码不可用';
      this.saveTasks();
      return;
    }

    const label = key === 'video' ? '视频' : key === 'ptt' ? '语音' : '文件';
    onLog(`开始补全${label}…`);
    const ctx = {
      mediaUrl: this.deps.mediaUrl,
      msgs: this.msgsFor(task),
      kind: task.kind,
      conv: task.conv,
      gapHistory: this.deps.gapHistory,
    };
    this.touchStage(task, key, { status: 'running', note: `下载${label} 0` }, { persist: true });
    const onP = (done: number, total: number): void => {
      if (aborted()) return;
      this.touchStage(task, key, { current: done, total, note: `下载${label} ${done}/${total}` });
    };
    const r =
      key === 'video'
        ? await downloadMissingVideos(scan, mediaRoot, ctx, onP, 4, onLog)
        : key === 'ptt'
          ? await downloadMissingVoices(scan, mediaRoot, ctx, this.deps.decodeSilk!, onP, 4, onLog)
          : await downloadMissingFiles(scan, mediaRoot, ctx, onP, 4, onLog);
    onLog(`补全${label}完成：成功 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`);
    this.touchStage(
      task,
      key,
      {
        status: 'completed',
        current: r.total,
        total: r.total,
        failed: r.failed,
        note: `已下载 ${r.ok}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
        ...(r.failures ? { failures: r.failures } : {}),
      },
      { persist: true },
    );
  }

  /**
   * 消息阶段：多格式同任务时逐格式各写一个文件（进度跨格式累计）；单格式保持
   * 原行为。所有格式复用同一套 senders / faces 收集，媒体只由任务级 media 阶段
   * 导出一份。返回主格式路径 + 跨格式汇总条数。
   */
  private async exportMessages(
    task: ExportTask,
    outDir: string,
    senders: Set<string> | undefined,
    withMediaPaths: boolean,
    onProgress: (current: number, note: string) => void,
    faces?: Set<string>,
    roam?: RoamMessageSource,
    dressByMsg?: Map<string, MsgDecoration>,
    dressManifest?: DressExportManifest | null,
    dressKinds?: DressExportKinds,
  ): Promise<ExportResult> {
    const formats = task.formats?.length ? task.formats : [task.format];
    const filePathFor = (format: ExportFormat): string =>
      format === 'html'
        ? join(outDir, 'index.html')
        : join(outDir, `${sanitizeSegment(task.name, task.conv || task.id)}.${format}`);
    const startedAt = Date.now();
    let count = 0;
    let fileSize = 0;
    for (let i = 0; i < formats.length; i += 1) {
      const format = formats[i]!;
      const base = count;
      const tick = (p: { current: number; message: string }): void => {
        const prefix =
          formats.length > 1 ? `[${i + 1}/${formats.length} ${format.toUpperCase()}] ` : '';
        onProgress(base + p.current, `${prefix}${p.message}`);
        this.log(task.id, 'message', `${prefix}${p.message}`);
      };
      const result = await this.exportMessagesOne(
        task,
        format,
        filePathFor(format),
        senders,
        withMediaPaths,
        tick,
        faces,
        roam,
        dressByMsg,
        dressManifest,
        dressKinds,
      );
      count += result.messageCount;
      fileSize += result.fileSize;
      if (formats.length > 1) {
        this.log(
          task.id,
          'message',
          `格式 ${format.toUpperCase()} 完成：${result.messageCount} 条`,
        );
      }
    }
    return {
      filePath: filePathFor(formats[0]!),
      format: task.format,
      messageCount: count,
      fileSize,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Dispatch one format pass to the right exporter by format / conversation kind. */
  private async exportMessagesOne(
    task: ExportTask,
    format: ExportFormat,
    outputPath: string,
    senders: Set<string> | undefined,
    withMediaPaths: boolean,
    onProgress: (p: { current: number; message: string }) => void,
    faces?: Set<string>,
    roam?: RoamMessageSource,
    dressByMsg?: Map<string, MsgDecoration>,
    dressManifest?: DressExportManifest | null,
    dressKinds?: DressExportKinds,
  ): Promise<ExportResult> {
    const progressEvery = 1000;
    const tick = (p: { current: number; message: string }): void => onProgress(p);
    const dressLookup = dressByMsg
      ? (msgId: string): MsgDecoration | undefined => dressByMsg.get(msgId)
      : undefined;
    // ChatLab reuses json/jsonl but emits its own structure (header + members +
    // normalized messages), and resolves names/roles itself — its own exporter.
    if (task.chatlab && (format === 'json' || format === 'jsonl')) {
      return exportToChatlab(
        this.msgsFor(task),
        {
          kind: task.kind,
          conv: task.conv,
          name: task.name,
          format,
          outputPath,
          range: task.range,
          roam,
          progressEvery,
          onProgress: tick,
          collectSenders: senders,
          collectFaces: faces,
        },
        this.senderDeps(task) ?? {},
      );
    }
    // HTML resolves names / roles / self-alignment itself (like ChatLab) and
    // wraps the records in a document — its own exporter, both kinds.
    if (format === 'html') {
      return exportToHtml(
        this.msgsFor(task),
        {
          kind: task.kind,
          conv: task.conv,
          name: task.name,
          outputPath,
          range: task.range,
          roam,
          progressEvery,
          onProgress: tick,
          collectSenders: senders,
          collectFaces: faces,
          withMediaPaths,
          dress: dressKinds,
          dressLookup,
          dressManifest: dressManifest ?? undefined,
        },
        this.senderDeps(task) ?? {},
      );
    }
    // XLSX is a binary workbook, not a character stream — its own loop, both kinds.
    if (format === 'xlsx') {
      return exportToXlsx(this.msgsFor(task), {
        kind: task.kind,
        conv: task.conv,
        outputPath,
        progressEvery,
        onProgress: tick,
        collectSenders: senders,
        collectFaces: faces,
        range: task.range,
        withMediaPaths,
        roam,
      });
    }
    if (task.kind === 'group') {
      const opts: GroupExportOptions = {
        groupCode: task.conv,
        name: task.name,
        outputPath,
        progressEvery,
        onProgress: tick,
        collectSenders: senders,
        collectFaces: faces,
        range: task.range,
        withMediaPaths,
        roam,
        dressLookup,
      };
      switch (format) {
        case 'json':
          return exportGroupToJson(this.msgsFor(task), opts, this.senderDeps(task));
        case 'jsonl':
          return exportGroupToJsonl(this.msgsFor(task), opts, this.senderDeps(task));
        case 'csv':
          return exportGroupToCsv(this.msgsFor(task), opts);
        default:
          return exportGroupToTxt(this.msgsFor(task), opts);
      }
    }
    return this.exportC2c(
      this.msgsFor(task),
      task.kind,
      task.name,
      task.conv,
      outputPath,
      format,
      progressEvery,
      tick,
      senders,
      faces,
      task.range,
      withMediaPaths,
      roam,
      dressLookup,
      this.senderDeps(task),
    );
  }

  private async exportC2c(
    msgs: MsgService,
    kind: ConvKind,
    convName: string,
    peerUid: string,
    outPath: string,
    format: ExportFormat,
    progressEvery: number,
    onProgress: (p: { current: number; message: string }) => void,
    senders?: Set<string>,
    faces?: Set<string>,
    range?: ExportTimeRange,
    withMediaPaths?: boolean,
    roam?: RoamMessageSource,
    dressLookup?: (msgId: string) => MsgDecoration | undefined,
    deps?: SenderResolveDeps,
  ): Promise<ExportResult> {
    // 私聊/官方号/服务号的 JSON 同样带上成员昵称（meta + members + senderName）。
    if ((format === 'json' || format === 'jsonl') && deps) {
      return exportJsonConversation(
        msgs,
        {
          kind,
          conv: peerUid,
          name: convName,
          outputPath: outPath,
          format,
          range,
          roam,
          progressEvery,
          onProgress,
          collectSenders: senders,
          collectFaces: faces,
          withMediaPaths,
          dressLookup,
        },
        deps,
      );
    }
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
    const { statSync } = await import('node:fs');
    const writer = createExportWriter(outPath);

    let count = 0;
    try {
      if (framing.head) await writer.write(framing.head);
      for await (const m of iterateC2cMessages(msgs, peerUid, {
        pageSize: 2000,
        range,
        roam,
      })) {
        const exported = toExportedMessage(m);
        const dec = dressLookup?.(exported.msgId);
        if (dec) exported.decoration = dec;
        senders?.add(exported.senderUin);
        if (faces) collectFaceIds(exported.elements, faces);
        await expandForwards(msgs, 'c2c', exported);
        if (withMediaPaths) annotateLocalPaths(exported.elements);
        const record = renderRecord(exported);
        await writer.write(count === 0 ? record : framing.between + record);
        count += 1;
        if (count % progressEvery === 0)
          onProgress({ current: count, message: `已导出 ${count} 条` });
      }
      if (framing.tail) await writer.write(framing.tail);
    } finally {
      await writer.end();
    }

    return {
      filePath: outPath,
      format,
      messageCount: count,
      fileSize: statSync(outPath).size,
      durationMs: Date.now() - start,
    };
  }

  pauseTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (task?.status !== 'running') return false;
    this.abortControllers.get(id)?.abort();
    task.status = 'paused';
    task.updatedAt = Date.now();
    this.log(id, 'task', '任务已暂停', 'warn');
    this.saveTasks();
    this.emit('progress', {
      taskId: id,
      status: 'paused',
      progress: task.progress,
      current: task.current,
      message: '已暂停',
    });
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
    this.log(id, 'task', '任务已取消', 'warn');
    this.cleanupOutput(task);
    this.saveTasks();
    this.emit('progress', {
      taskId: id,
      status: 'cancelled',
      progress: task.progress,
      current: task.current,
      message: '已取消',
    });
    return true;
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'running') return false;
    this.cleanupOutput(task);
    this.tasks.delete(id);
    this.taskLogs.delete(id);
    this.saveTasks();
    return true;
  }

  /** 供外部（定时调度器等）向任务追加一行日志。 */
  appendLog(
    id: string,
    stage: StageKey | 'task',
    text: string,
    level: TaskLogLevel = 'info',
  ): void {
    this.log(id, stage, text, level);
  }
}

// 路径清洗 / 文件名去重统一走 packages/service/src/common/path_sanitize.ts（以前这里
// 与 flashtransfer/manager.ts 各有一份，行为逐步漂移）。商城表情下载用它生成安全
// 文件夹 / 文件名；导出主任务的文件名截断默认 80 字符。
