/**
 * QQ 版本清单的**纯逻辑**：版本比较、差异判定、单调合并、pending 登记。
 *
 * 抽成独立模块的原因：
 *  - `scripts/refresh-qq-versions.mjs` 只负责抓官网、读写文件，逻辑全调这里；
 *  - 这些规则容易错（CDN 边缘灰度会让官网返回旧版本），必须有单测覆盖，
 *    而仓库的单测入口是各包的 vitest，`.mjs` 脚本不在门禁里。
 *
 * 数据形状见 `versions/latest.json` / `versions/supported.json`。
 */

/** 一个平台的版本条目。 */
export interface LatestVersionEntry {
  version: string;
  /** 官网给的下载地址；可能暂时 403（CDN 灰度），仍原样记录。 */
  url: string | null;
  updateDate: string | null;
  /** 官网这次返回了更旧的版本时留一句说明（见 {@link mergeLatest}）。 */
  stale?: string;
}

export interface LatestFile {
  /** 抓取时间（ISO，UTC）。 */
  fetchedAt: string;
  /** pcConfig.json 的来源地址。 */
  source: string;
  versions: Record<string, LatestVersionEntry>;
}

export interface SupportedEntry {
  version: string;
  verifiedAt: string;
  sign: {
    ok: boolean;
    signCoreRva?: number;
    vmRva?: number | null;
    vmKind?: string | null;
    pathUsed?: string | null;
    signLength?: number | null;
    sampleSign?: string | null;
  };
}

export interface PendingEntry {
  platform: string;
  version: string;
  url: string | null;
  discoveredAt: string;
}

export interface SupportedFile {
  platforms: Record<string, SupportedEntry[]>;
  pending: PendingEntry[];
}

export type VersionChange =
  | { key: string; from: string | null; to: string; kind: 'upgrade' }
  | { key: string; from: string; to: string; kind: 'regression' }
  | { key: string; from: string; to: string; kind: 'url' };

/**
 * 按数字段比较版本号；`> 0` 表示 `a` 更新。
 *
 * QQ 的版本号是纯数字点分（`9.9.37` / `3.2.35` / `7.0.3`），不要做字符串比较：
 * `3.2.9` > `3.2.35` 是错的。
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const parse = (v: string | null | undefined): number[] =>
    String(v ?? '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 比对两份 `latest.json`，按平台给出变化。 */
export function diffLatest(previous: LatestFile | null, next: LatestFile): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const [key, value] of Object.entries(next.versions)) {
    const old = previous?.versions?.[key];
    if (!old) {
      changes.push({ key, from: null, to: value.version, kind: 'upgrade' });
      continue;
    }
    const cmp = compareVersions(value.version, old.version);
    if (cmp > 0) changes.push({ key, from: old.version, to: value.version, kind: 'upgrade' });
    else if (cmp < 0)
      changes.push({ key, from: old.version, to: value.version, kind: 'regression' });
    else if (old.url && value.url && old.url !== value.url)
      changes.push({ key, from: old.version, to: value.version, kind: 'url' });
  }
  return changes;
}

/**
 * 合成最终要落盘的版本：**只允许前进**。
 *
 * 官网配置在多个 CDN 边缘节点上不是一起更新的：同一个 URL 可能这次返回
 * `9.9.37`、下次返回 `9.9.36`。直接覆盖会让 `latest.json` 每晚抖动，兼容性
 * 验证也被反复触发。所以某平台这次拿到更旧的版本时保留已有记录，只加一句说明。
 */
export function mergeLatest(previous: LatestFile | null, next: LatestFile): LatestFile {
  const versions: Record<string, LatestVersionEntry> = {};
  for (const [key, value] of Object.entries(next.versions)) {
    const old = previous?.versions?.[key];
    if (old && compareVersions(value.version, old.version) < 0) {
      versions[key] = {
        ...old,
        stale: `官网本次返回 ${value.version}，低于已记录的 ${old.version}，按其为准`,
      };
    } else {
      versions[key] = value;
    }
  }
  return { ...next, versions };
}

/**
 * 把新发现的版本登记进 `supported.json` 的 `pending` 列表。
 *
 * `supported.json` 的 `platforms` 是**已验证**清单（由 CI 写），这里只登记
 * 「官网说有、但还没验」的版本；已经验证过的版本和已登记过的 pending 都跳过。
 * 同一个平台的旧 pending（版本更低且已有更新版本待验）不删 —— 留着能看出
 * 哪些版本一直没验成。
 */
export function registerPending(supported: SupportedFile, latest: LatestFile): SupportedFile {
  const pending = [...(supported.pending ?? [])];
  const known = new Set(pending.map((p) => `${p.platform}:${p.version}`));
  for (const [platform, info] of Object.entries(latest.versions)) {
    const key = `${platform}:${info.version}`;
    if (known.has(key)) continue;
    const verified = (supported.platforms?.[platform] ?? []).some(
      (entry) => entry.version === info.version,
    );
    if (verified) continue;
    pending.push({
      platform,
      version: info.version,
      url: info.url,
      discoveredAt: latest.fetchedAt,
    });
    known.add(key);
  }
  return { ...supported, pending };
}
