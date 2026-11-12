/**
 * 「支持的 QQ 版本」页面的数据源。
 *
 * 构建时直接读仓库根的 `versions/supported.json`（已验证清单）和
 * `versions/latest.json`（官网最新版本），单一数据源，不另存副本。
 * 两个文件由 `.github/workflows/qq-version-watch.yml` 每晚更新。
 *
 * 这里只挑展示需要的字段：`sign` 里的 RVA / sampleSign 属于内部实现细节，
 * 不对外暴露。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPPORTED_FILE = fileURLToPath(new URL('../../../versions/supported.json', import.meta.url));
const LATEST_FILE = fileURLToPath(new URL('../../../versions/latest.json', import.meta.url));

interface SupportedEntry {
  version: string;
  verifiedAt: string;
}

interface SupportedFile {
  platforms?: Record<string, SupportedEntry[]>;
  pending?: Array<{
    platform: string;
    version: string;
    url: string | null;
    discoveredAt: string;
  }>;
}

interface LatestEntry {
  version: string;
  url: string | null;
  updateDate: string | null;
  stale?: string;
}

interface LatestFile {
  fetchedAt: string;
  source: string;
  versions?: Record<string, LatestEntry>;
}

/** 展示顺序和平台中文名。键与 versions/*.json 一一对应。 */
const PLATFORMS: Array<{ key: string; label: string }> = [
  { key: 'windows-x64', label: 'Windows x64' },
  { key: 'macos-arm64', label: 'macOS（Apple 芯片）' },
  { key: 'macos-x64', label: 'macOS（Intel）' },
  { key: 'linux-x64', label: 'Linux x64' },
  { key: 'linux-arm64', label: 'Linux arm64' },
];

const LABELS = new Map(PLATFORMS.map((p) => [p.key, p.label]));

export type VersionStatus = 'current' | 'outdated' | 'verified' | 'none';

export interface VersionRow {
  key: string;
  label: string;
  /** 官网当前最新版本；没抓到就是 null。 */
  latest: string | null;
  /** 官网版本的发布日期。 */
  latestDate: string | null;
  /** 官网返回旧版本时的说明（CDN 灰度）。 */
  stale: string | null;
  /** 已验证的最新版本；没有验证记录就是 null。 */
  verified: string | null;
  verifiedAt: string | null;
  status: VersionStatus;
  /** 全部验证记录，按版本从新到旧。 */
  history: Array<{ version: string; verifiedAt: string }>;
}

export interface PendingRow {
  platform: string;
  label: string;
  version: string;
  /** 官网当前版本，方便对比 pending 是不是已经落后。 */
  latest: string | null;
  discoveredAt: string | null;
}

export interface SupportedVersionsData {
  /** 最近一次抓取官网版本的时间。 */
  fetchedAt: string | null;
  /** 官网版本清单的来源地址。 */
  source: string | null;
  rows: VersionRow[];
  pending: PendingRow[];
}

/**
 * 按数字段比较版本号。QQ 的版本是纯数字点分，字符串比较会把 `3.2.9`
 * 排到 `3.2.35` 前面。
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 按北京时间取日期/时间字段，构建机和用户时区不同也不会漂。 */
function dateParts(iso: string): Record<string, string> {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return {};
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** ISO 时间 → `YYYY-MM-DD`。 */
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const p = dateParts(iso);
  if (!p.year) return iso;
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO 时间 → `YYYY-MM-DD HH:mm`。 */
function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const p = dateParts(iso);
  if (!p.year) return iso;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export default {
  watch: [SUPPORTED_FILE, LATEST_FILE],

  load(): SupportedVersionsData {
    const supported = JSON.parse(readFileSync(SUPPORTED_FILE, 'utf8')) as SupportedFile;
    const latest = JSON.parse(readFileSync(LATEST_FILE, 'utf8')) as LatestFile;

    const verifiedByPlatform = supported.platforms ?? {};
    const latestByPlatform = latest.versions ?? {};

    // 以固定顺序为主，数据里出现的新平台追加在后面，升级平台时不用改页面。
    const keys = [
      ...PLATFORMS.map((p) => p.key),
      ...Object.keys(latestByPlatform),
      ...Object.keys(verifiedByPlatform),
      ...(supported.pending ?? []).map((p) => p.platform),
    ].filter((key, i, all) => all.indexOf(key) === i);

    const rows: VersionRow[] = keys.map((key) => {
      const latestEntry = latestByPlatform[key] ?? null;
      const entries = [...(verifiedByPlatform[key] ?? [])].sort((a, b) =>
        compareVersions(b.version, a.version),
      );
      const newest = entries[0] ?? null;

      let status: VersionStatus = 'none';
      if (newest) {
        if (!latestEntry) status = 'verified';
        else
          status =
            compareVersions(newest.version, latestEntry.version) >= 0 ? 'current' : 'outdated';
      }

      return {
        key,
        label: LABELS.get(key) ?? key,
        latest: latestEntry?.version ?? null,
        latestDate: formatDate(latestEntry?.updateDate),
        stale: latestEntry?.stale ?? null,
        verified: newest?.version ?? null,
        verifiedAt: formatDate(newest?.verifiedAt),
        status,
        history: entries.map((entry) => ({
          version: entry.version,
          verifiedAt: formatDate(entry.verifiedAt) ?? '',
        })),
      };
    });

    const pending: PendingRow[] = (supported.pending ?? []).map((entry) => ({
      platform: entry.platform,
      label: LABELS.get(entry.platform) ?? entry.platform,
      version: entry.version,
      latest: latestByPlatform[entry.platform]?.version ?? null,
      discoveredAt: formatDate(entry.discoveredAt),
    }));

    return {
      fetchedAt: formatDateTime(latest.fetchedAt),
      source: latest.source ?? null,
      rows,
      pending,
    };
  },
};
