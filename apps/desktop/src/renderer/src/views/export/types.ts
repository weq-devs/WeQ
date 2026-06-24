/**
 * Shared types & constants for the 导出 (export) hub.
 *
 * The page is a single screen with export *modes* in the left rail; each mode
 * drives the right pane (a picker) and an action that opens an export lightbox.
 * Backend wiring is partial — see ExportView for which flows run against real
 * tRPC procedures and which are recorded for a not-yet-built backend.
 */

/** Left-rail modes. */
export type ExportMode = 'full' | 'decrypt' | 'chatlab' | 'html' | 'scheduled' | 'album';

/** Every output format the 完整消息 / 定时 flows can request. */
export type ExportFormat = 'json' | 'jsonl' | 'xlsx' | 'csv' | 'txt';

/** Formats the backend (`account.startExport`) can produce. */
export const BACKEND_FORMATS = ['json', 'jsonl', 'txt', 'csv', 'xlsx'] as const;
export type BackendFormat = (typeof BACKEND_FORMATS)[number];

export function isBackendFormat(f: ExportFormat): f is BackendFormat {
  return (BACKEND_FORMATS as readonly string[]).includes(f);
}

/** Format chips shown for the full-message / scheduled flows. */
export const FULL_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'csv', label: 'CSV' },
  { value: 'txt', label: 'TXT' },
];

/** ChatLab only emits structured JSON variants. */
export const CHATLAB_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
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

/** Media / content options collected in the export lightbox. */
export interface ExportOptions {
  range: TimeRange;
  /** Export media files alongside the messages. */
  exportMedia: boolean;
  /** Export sender avatars. */
  exportAvatar: boolean;
  /** Re-download media missing from the local cache (needs rkey). */
  completeMedia: boolean;
  /** Include videos when downloading media. */
  downloadVideo: boolean;
  /** Include files when downloading media. */
  downloadFile: boolean;
  /** Per-file download size cap, in MB (0 = no cap). */
  sizeCapMb: number;
  /** Auto-transcribe voice messages to text. */
  transcribeVoice: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  range: DEFAULT_RANGE,
  exportMedia: true,
  exportAvatar: true,
  completeMedia: false,
  downloadVideo: false,
  downloadFile: false,
  sizeCapMb: 50,
  transcribeVoice: false,
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
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
