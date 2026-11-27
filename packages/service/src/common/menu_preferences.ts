import { EXPORT_EXTRA_LABELS, type ExportExtraOptions } from './export_content';

export interface ForwardOptions {
  mode: 'fixed' | 'text' | 'original';
  intervalMs: number;
  msPerCharacter: number;
  nonTextMs: number;
  /** -1 表示不限，其他值以毫秒计。 */
  maxIntervalMs: number;
  jitterMs: number;
  maxAttempts: number;
  failure: 'skip' | 'abort';
}
export const DEFAULT_FORWARD_OPTIONS: ForwardOptions = {
  mode: 'fixed',
  intervalMs: 0,
  msPerCharacter: 1000,
  nonTextMs: 5000,
  maxIntervalMs: -1,
  jitterMs: 0,
  maxAttempts: 1,
  failure: 'skip',
};
type MenuExportFormat = 'json' | 'jsonl' | 'jsonl.gz' | 'txt' | 'csv' | 'xlsx';
export interface MenuExportDetails {
  extra?: ExportExtraOptions;
  profile?: 'basic' | 'full';
  incrementalSupport?: boolean;
}
export interface MenuResourceArchive extends MenuExportDetails {
  metadataFormat?: 'json' | 'jsonl' | 'jsonl.gz' | 'none';
}
/** 菜单中的使用偏好沿用宿主共享设置；不存本次消息、接收者或文件选择。 */
export const menuPreferenceDefaults = {
  forwardOptions: DEFAULT_FORWARD_OPTIONS,
  forwardReplyExcerpt: false,
  voicePanelTab: 'record' as 'record' | 'tts' | 'ai',
  ttsProviderId: '',
  ttsVoices: {} as Record<string, string>,
  aiVoiceId: '',
  emojiPanelTab: 'face' as
    | 'face'
    | 'super'
    | 'unicode'
    | 'market'
    | 'fav'
    | 'kaomoji'
    | 'poke'
    | 'custom',
  groupAlbumSort: 'source' as 'source' | 'name' | 'count',
  exportIntegrityReport: false,
  collectionExportFormat: 'json' as MenuExportFormat,
  collectionExportDetails: {} as MenuExportDetails,
  mailExportFormat: 'json' as 'json' | 'jsonl' | 'jsonl.gz',
  mailExportDetails: {} as MenuExportDetails,
  generatedExportFormats: ['json'] as MenuExportFormat[],
  generatedExportDetails: {} as MenuExportDetails,
  groupFileExportArchive: {
    metadataFormat: 'json',
    profile: 'full',
    incrementalSupport: true,
  } as MenuResourceArchive,
  emojiPackExportFormat: 'directory' as 'directory' | 'zip' | 'favorite-zip',
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const oneOf =
  (...values: string[]) =>
  (value: unknown) =>
    typeof value === 'string' && values.includes(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024;
const boolean = (value: unknown) => typeof value === 'boolean';
const jsonFormat = oneOf('json', 'jsonl', 'jsonl.gz');
const exportFormat = oneOf('json', 'jsonl', 'jsonl.gz', 'txt', 'csv', 'xlsx');
const boundedNumber = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function validForwardOptions(value: unknown): value is ForwardOptions {
  return (
    record(value) &&
    Object.keys(value).every((key) => Object.hasOwn(DEFAULT_FORWARD_OPTIONS, key)) &&
    oneOf('fixed', 'text', 'original')(value.mode) &&
    oneOf('skip', 'abort')(value.failure) &&
    boundedNumber(value.maxAttempts, 1, 20) &&
    Number.isInteger(value.maxAttempts) &&
    boundedNumber(value.maxIntervalMs, -1, 3_600_000) &&
    Number.isInteger(value.maxIntervalMs) &&
    [value.intervalMs, value.msPerCharacter, value.nonTextMs, value.jitterMs].every((delay) =>
      boundedNumber(delay, 0, 3_600_000),
    )
  );
}
function exportDetails(value: unknown, archive = false): boolean {
  if (!record(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    switch (key) {
      case 'extra':
        return (
          entry === undefined ||
          (record(entry) &&
            Object.entries(entry).every(
              ([name, flag]) => Object.hasOwn(EXPORT_EXTRA_LABELS, name) && boolean(flag),
            ))
        );
      case 'profile':
        return entry === undefined || oneOf('basic', 'full')(entry);
      case 'incrementalSupport':
        return entry === undefined || boolean(entry);
      case 'metadataFormat':
        return (
          archive && (entry === undefined || oneOf('json', 'jsonl', 'jsonl.gz', 'none')(entry))
        );
      default:
        return false;
    }
  });
}
export const menuPreferenceValidators: Record<
  keyof typeof menuPreferenceDefaults,
  (value: unknown) => boolean
> = {
  forwardOptions: validForwardOptions,
  forwardReplyExcerpt: boolean,
  voicePanelTab: oneOf('record', 'tts', 'ai'),
  ttsProviderId: text,
  ttsVoices: (value) =>
    record(value) &&
    Object.entries(value).every(([key, voice]) => key.length > 0 && text(key) && text(voice)),
  aiVoiceId: text,
  emojiPanelTab: oneOf('face', 'super', 'unicode', 'market', 'fav', 'kaomoji', 'poke', 'custom'),
  groupAlbumSort: oneOf('source', 'name', 'count'),
  exportIntegrityReport: boolean,
  collectionExportFormat: exportFormat,
  collectionExportDetails: exportDetails,
  mailExportFormat: jsonFormat,
  mailExportDetails: exportDetails,
  generatedExportFormats: (value) =>
    Array.isArray(value) && value.length <= 6 && value.every(exportFormat),
  generatedExportDetails: exportDetails,
  groupFileExportArchive: (value) => exportDetails(value, true),
  emojiPackExportFormat: oneOf('directory', 'zip', 'favorite-zip'),
};
