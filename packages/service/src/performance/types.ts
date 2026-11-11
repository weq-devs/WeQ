export type MonitorMode = 'off' | 'light' | 'full';
export interface MonitorSettings {
  version: 1;
  mode: MonitorMode;
  retentionDays: number;
  capacityMiB: 64 | 128 | 256 | 512;
  fullUntil: number | null;
}
export const DEFAULT_MONITOR_SETTINGS: MonitorSettings = {
  version: 1,
  mode: 'light',
  retentionDays: 7,
  capacityMiB: 128,
  fullUntil: null,
};
export const MONITOR_METRICS = [
  'cpuPercent',
  'residentBytes',
  'heapBytes',
  'externalBytes',
  'eventLoopP95Ms',
] as const;
export type MonitorMetric = (typeof MONITOR_METRICS)[number];
export interface MonitorProcess {
  key: string;
  label: string;
  pid: number;
  createdAt: number;
  metrics: Record<MonitorMetric, number | null>;
  details?: Record<string, unknown>;
}
export interface MonitorCollection {
  processes: MonitorProcess[];
  syncMs: number;
  waitMs: number;
  detailSyncMs?: number;
  unavailable?: string[];
}
export interface MonitorRecord {
  version: 1;
  session: string;
  segment: string;
  at: number;
  kind: 'sample' | 'event';
  intervalMs: number;
  processes?: MonitorProcess[];
  event?: string;
  reason?: string;
  syncMs?: number;
  waitMs?: number;
  unavailable?: string[];
}
export interface MonitorRange {
  from: number;
  to: number;
  buckets: number;
  process?: string;
}
export interface MonitorPoint {
  process: string;
  label: string;
  segment: string;
  start: number;
  end: number;
  firstAt: number;
  lastAt: number;
  id: number;
  count: number;
  intervalMs: number;
  metrics: Record<MonitorMetric, { min: number | null; max: number | null; mean: number | null }>;
}
export interface MonitorEvent {
  id: number;
  at: number;
  event: string;
  session: string;
  reason?: string | null;
}
export interface MonitorHistory {
  points: MonitorPoint[];
  events: MonitorEvent[];
  eventLimitReached: boolean;
  pointLimitReached: boolean;
}
export interface MonitorStorageStatus {
  bytes: number;
  oldest: number | null;
  newest: number | null;
  records: number;
}
export interface MonitorStatus extends MonitorStorageStatus {
  host: 'desktop' | 'web';
  capabilities: string[];
  settings: MonitorSettings;
  session: string;
  queued: number;
  dropped: number;
  deferred: number;
  collecting: boolean;
  writing: boolean;
  lastSampleAt: number | null;
  lastSyncMs: number | null;
  lastWaitMs: number | null;
  error: string | null;
  detailIntervalMs: number;
  detailBackoffUntil: number | null;
}
