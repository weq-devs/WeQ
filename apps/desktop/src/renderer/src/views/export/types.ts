/**
 * Shared types & constants for the 导出 (export) hub.
 *
 * The page is a single screen with export *modes* in the left rail; each mode
 * drives the right pane (a picker) and an action that opens an export lightbox.
 * Backend wiring is partial — see ExportView for which flows run against real
 * tRPC procedures and which are recorded for a not-yet-built backend.
 */

/** Left-rail modes. */
export type ExportMode =
  | 'full'
  | 'guild'
  | 'decrypt'
  | 'qzone'
  | 'contacts'
  | 'collection'
  | 'scheduled'
  | 'album'
  | 'groupfile'
  | 'marketpack';

/** Every output format the 完整消息 / 定时 flows can request. HTML is one of the
 *  完整消息 chips; `vcard` is contacts-only (导出联系人). */
export type ExportFormat = 'json' | 'jsonl' | 'xlsx' | 'csv' | 'txt' | 'html' | 'vcard';

/** Formats the backend (`account.startExport`) can produce. */
export const BACKEND_FORMATS = ['json', 'jsonl', 'txt', 'csv', 'xlsx'] as const;
export type BackendFormat = (typeof BACKEND_FORMATS)[number];

export function isBackendFormat(f: ExportFormat): f is BackendFormat {
  return (BACKEND_FORMATS as readonly string[]).includes(f);
}

/** Format chips shown for the full-message / scheduled flows. HTML is a chip
 *  here now (merged from its old standalone mode). */
export const FULL_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'csv', label: 'CSV' },
  { value: 'txt', label: 'TXT' },
  { value: 'html', label: 'HTML' },
];

/** ChatLab only emits structured JSON variants. */
export const CHATLAB_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
];

/** QQ 空间导出：JSON / TXT / HTML（HTML 会强制下载配图到 media/ 并本地引用）。 */
export const QZONE_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
  { value: 'html', label: 'HTML' },
];

/** 导出好友：表格类 + vCard 电子名片。 */
export const FRIEND_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'txt', label: 'TXT' },
  { value: 'vcard', label: 'vCard' },
];

/** 导出群成员：表格类（无 vCard）。 */
export const MEMBER_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'txt', label: 'TXT' },
];

/** 导出收藏：表格类四种（图片仅写 CDN URL，不下载）。 */
export const COLLECTION_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'txt', label: 'TXT' },
];

/** A row in any of the right-pane pickers. */
export interface PickItem {
  /** Stable id — conversation uid / group code / db file path. */
  id: string;
  /** Display name. */
  name: string;
  /** Avatar URL, or null to render an initial-letter fallback. */
  avatarUrl: string | null;
  /** Secondary line (message count, member count, file size…). */
  meta?: string;
  /** Conversation kind, when relevant (drives the backend export `kind`). */
  kind?: 'group' | 'c2c';
  /** 好友 QQ 号（c2c 专用）—— 好友空间导出以此为目标 uin。 */
  uin?: string;
  /** Raw message-count estimate, used as the export task `total`. */
  total?: number;
}

/** Time-range presets for the picker. */
export type RangePreset = 'all' | 'today' | '7d' | '30d' | '1y' | 'custom';

/** A selected time window. `start`/`end` are unix *seconds*; null = open-ended. */
export interface TimeRange {
  preset: RangePreset;
  start: number | null;
  end: number | null;
}

export const DEFAULT_RANGE: TimeRange = { preset: 'all', start: null, end: null };

/** 导出装扮的类别勾选（全部默认关 = 不导出）。 */
export interface DressKinds {
  bubble: boolean;
  font: boolean;
  widget: boolean;
}

export const DEFAULT_DRESS: DressKinds = { bubble: false, font: false, widget: false };

/** 媒体资源按类别勾选（导出内容 → 媒体资源 的子选项）。 */
export interface MediaKinds {
  /** 图片 / 表情图片。 */
  image: boolean;
  /** 语音（含本地解码为 WAV）。 */
  voice: boolean;
  /** 视频。 */
  video: boolean;
  /** 文件 / 群文件。 */
  file: boolean;
  /** QQ 系统表情（小黄脸，参考 HTML 导出的 media/face/ 收集方式）。 */
  sysface: boolean;
}

export const DEFAULT_MEDIA_KINDS: MediaKinds = {
  image: true,
  voice: true,
  video: true,
  file: true,
  sysface: true,
};

/** 媒体子选项的展示文案（与后端 stage 一一对应）。 */
export const MEDIA_KIND_LABELS: Record<keyof MediaKinds, string> = {
  image: '图片',
  voice: '语音',
  video: '视频',
  file: '文件',
  sysface: 'QQ系统表情',
};

/** Media / content options collected in the export lightbox. */
export interface ExportOptions {
  range: TimeRange;
  /** Export media files alongside the messages. */
  exportMedia: boolean;
  /** 导出媒体时按类别筛选（图片 / 语音 / 视频 / 文件 / QQ 系统表情）。 */
  mediaKinds: MediaKinds;
  /** 好友 QQ 空间导出：按 tid 补全评论 + 点赞（空间动态页 HTML 解析，best-effort）。 */
  qzoneInteractions: boolean;
  /** 消息补全：扫描 seq 空窗，从 QQ 服务端拉取本机缺失的消息（需在线 QQ）。 */
  completeMessages: boolean;
  /** Export sender avatars. */
  exportAvatar: boolean;
  /** Re-download media missing from the local cache (needs rkey). */
  completeMedia: boolean;
  /** Include videos when downloading media. */
  downloadVideo: boolean;
  /** Include files when downloading media. */
  downloadFile: boolean;
  /** Include missing voice clips when downloading media (OIDB + SILK-decode). */
  downloadPtt: boolean;
  /** 下载本地未缓存的装扮资源（关闭时只导出已缓存的部分）。 */
  completeDress: boolean;
  /** Auto-transcribe voice messages to text. */
  transcribeVoice: boolean;
  /** 导出装扮资源（气泡 / 字体 / 挂件，只导出会话实际用到的款）。 */
  dress: DressKinds;
  /** 导出完成后自动弹保存路径（不再记忆上次目录）。 */
  autoSave: boolean;
  /** ChatLab 交换格式（仅 JSON / JSONL 可选）。 */
  chatlab: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  range: DEFAULT_RANGE,
  exportMedia: true,
  qzoneInteractions: false,
  mediaKinds: { ...DEFAULT_MEDIA_KINDS },
  completeMessages: false,
  exportAvatar: true,
  completeMedia: false,
  downloadVideo: false,
  downloadFile: false,
  downloadPtt: false,
  completeDress: true,
  transcribeVoice: false,
  dress: { ...DEFAULT_DRESS },
  autoSave: false,
  chatlab: false,
};

/** Schedule config for the 定时导出 flow. */
export interface Schedule {
  mode: 'daily' | 'interval';
  /** HH:MM for daily mode. */
  time: string;
  /** Hours between runs for interval mode. */
  intervalHours: number;
}

export const DEFAULT_SCHEDULE: Schedule = { mode: 'daily', time: '03:00', intervalHours: 6 };

/** Preset window labels for scheduled templates. `custom` carries absolute
 *  bounds; the other presets are re-resolved at fire-time (so "最近 7 天"
 *  actually rolls forward every run). */
export type ScheduleRangePreset = 'all' | 'today' | '7d' | '30d' | '1y' | 'custom';

export interface ScheduleRange {
  preset: ScheduleRangePreset;
  /** Only meaningful for `custom`; otherwise null and re-computed at fire-time. */
  start: number | null;
  end: number | null;
}

/** Media / content switches baked into a scheduled template. */
export interface ScheduleOptions {
  range: ScheduleRange;
  exportMedia: boolean;
  mediaKinds?: MediaKinds;
  /** 消息补全：扫描 seq 空窗，从 QQ 服务端拉取本机缺失的消息（需在线 QQ）。 */
  completeMessages: boolean;
  exportAvatar: boolean;
  completeMedia: boolean;
  downloadVideo: boolean;
  downloadFile: boolean;
  downloadPtt: boolean;
  completeDress?: boolean;
  transcribeVoice: boolean;
  /** 导出装扮资源（气泡 / 字体 / 挂件）。 */
  dress?: DressKinds;
  /** 导出完成后自动弹保存路径。 */
  autoSave?: boolean;
}

/** One conversation target inside a scheduled template. */
export interface ScheduleConversation {
  id: string;
  name: string;
  kind: 'group' | 'c2c';
  total: number;
}

export type ScheduleOutcome = 'completed' | 'partial' | 'failed' | 'skipped' | 'cancelled';

/** One past fire of a schedule. The renderer shows these in the history line. */
export interface ScheduleTrigger {
  at: number;
  taskIds: string[];
  outcome: ScheduleOutcome;
  skipReason?: string;
  note?: string;
}

/** Wire shape matching the tRPC `listSchedules` payload. */
export interface ScheduledTask {
  id: string;
  name: string;
  /** 灯箱多选的导出格式（向后兼容：无此字段时读 `format`）。 */
  formats?: ExportFormat[];
  format: ExportFormat;
  conversations: ScheduleConversation[];
  chatlab?: boolean;
  schedule: Schedule;
  options: ScheduleOptions;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  history: ScheduleTrigger[];
}

/** Public-CDN avatar URL for a conversation row. */
export function convAvatarUrl(kind: 'group' | 'c2c', uid: string, uin?: string): string | null {
  if (kind === 'group') return uid ? `https://p.qlogo.cn/gh/${uid}/${uid}/0` : null;
  if (uin && uin !== '0') return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
  return null;
}

/** Group avatar by group code. */
export function groupAvatarUrl(code: string): string | null {
  return code ? `https://p.qlogo.cn/gh/${code}/${code}/0` : null;
}

/** chatType string → conversation kind. */
export function chatKind(chatType: string | number): 'group' | 'c2c' {
  return String(chatType).includes('GROUP') ? 'group' : 'c2c';
}

/** Compact thousands formatting (1234 → 1,234). */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Human-readable byte size. */
export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
