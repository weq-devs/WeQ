/**
 * Local resource cleanup for the current QQ account (本地资源整理 → 清理释放).
 *
 * Unlike WeQ's own preview cache (see `UserConfigService.clearCache`, which wipes
 * `%APPDATA%/weq/cache/*`), this service deletes the account's REAL QQ `nt_data`
 * resource trees — the same files the 本地资源整理 page browses (头像 / 各类表情 /
 * 图片墙 / QQ空间 / 图片 / 视频 / 语音 / File 目录). Every target is a well-known
 * sub-directory of `nt_data`; the cleanup is whitelist-gated and each resolved
 * path is re-checked to sit inside `nt_data` so it can never rm outside the tree
 * (never `nt_db`, never the `nt_data` root itself, never WeQ's own data).
 *
 * Two shapes of deletion:
 *   - `variant: 'all'`   — remove the whole target dir, then recreate it empty
 *     (so QQ's next write / our next mkdir is a no-op), mirroring `clearCache`.
 *   - `variant: 'ori' | 'thumb'` — walk the tree and unlink only files whose path
 *     runs through an `Ori`/`OriTemp` (原图) or `Thumb` (缩略) segment. Lets the
 *     user reclaim originals while keeping previews, or vice-versa.
 *
 * The 「下载文件」listing (`file_assistant.db` records → arbitrary user download
 * paths) is deliberately NOT a target, so no cleanup mode can ever touch it.
 */

import { rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { getLogger, logErrorContext } from '../common/logger';

/** How much of a target to delete. */
export type CleanupVariant = 'all' | 'ori' | 'thumb';

/** Regenerability tier — drives the UI's safe/caution styling. */
export type CleanupTier = 'safe' | 'caution';

/** One deletable resource, with a directory resolver bound to the platform. */
interface CleanupTargetDef {
  id: string;
  label: string;
  desc: string;
  tier: CleanupTier;
  /** True when the tree has an `Ori`/`Thumb` split (offers 仅原图 / 仅缩略). */
  hasVariants: boolean;
  /** Absolute dir for this account, or null when the tree is absent / unresolved. */
  resolveDir: (platform: Platform, uin: string) => string | null;
}

/** A count + byte total. */
export interface CleanupBucket {
  files: number;
  bytes: number;
}

/** One target enriched with its on-disk size (from {@link ResourceCleanupService.listTargets}). */
export interface CleanupTargetStat {
  id: string;
  label: string;
  desc: string;
  tier: CleanupTier;
  hasVariants: boolean;
  /** False when the tree's directory doesn't exist for this account. */
  present: boolean;
  files: number;
  bytes: number;
  /** Original files (path under an `Ori`/`OriTemp` dir). */
  ori: CleanupBucket;
  /** Thumbnail/preview files (path under a `Thumb` dir). */
  thumb: CleanupBucket;
}

/** One instruction: which target, and how much of it to delete. */
export interface CleanupInstruction {
  id: string;
  variant: CleanupVariant;
}

/** Per-target outcome of a cleanup run. */
export interface CleanupTargetResult {
  id: string;
  variant: CleanupVariant;
  freedBytes: number;
  /** Files successfully removed. */
  removed: number;
  /** Files that couldn't be removed (e.g. locked by a running QQ). */
  failed: number;
}

/** Aggregate outcome of a cleanup run. */
export interface CleanupResult {
  freedBytes: number;
  perTarget: CleanupTargetResult[];
}

/** `nt_data/avatar` — no dedicated platform helper, derived from `ntDataDir`. */
function ntDataChild(platform: Platform, uin: string, child: string): string | null {
  const data = platform.ntDataDir(uin);
  return data ? join(data, child) : null;
}

/**
 * The cleanup registry. Order here is the display order in the 自定义 panel.
 * `safe` = QQ re-downloads on demand; `caution` = chat content that may be gone
 * from the server after expiry. 「下载文件」/「系统表情资源」are intentionally absent.
 */
const TARGETS: readonly CleanupTargetDef[] = [
  {
    id: 'avatar',
    label: '头像缓存',
    desc: '好友 / 群 / 陌生人头像，删除后会自动重新下载',
    tier: 'safe',
    hasVariants: false,
    resolveDir: (p, uin) => ntDataChild(p, uin, 'avatar'),
  },
  {
    id: 'marketface',
    label: '商城表情',
    desc: '商城下载的贴纸，删除后使用时会自动重新下载',
    tier: 'safe',
    hasVariants: false,
    resolveDir: (p, uin) => p.marketFaceDir(uin),
  },
  {
    id: 'photoWall',
    label: '图片墙缓存',
    desc: '群相册 / 图片墙浏览缓存，可随时重新生成',
    tier: 'safe',
    hasVariants: false,
    resolveDir: (p, uin) => ntDataChild(p, uin, 'PhotoWall'),
  },
  {
    id: 'qzone',
    label: 'QQ空间缓存',
    desc: 'QQ空间浏览缓存，可随时重新生成',
    tier: 'safe',
    hasVariants: false,
    resolveDir: (p, uin) => ntDataChild(p, uin, 'Qzone'),
  },
  {
    id: 'emojiRelated',
    label: '关联表情',
    desc: '关键词联想表情，删除后会自动重新下载',
    tier: 'safe',
    hasVariants: false,
    resolveDir: (p, uin) => p.emojiRelatedDir(uin),
  },
  {
    id: 'pic',
    label: '聊天图片',
    desc: '聊天中的图片缓存，服务器过期后可能无法恢复',
    tier: 'caution',
    hasVariants: true,
    resolveDir: (p, uin) => p.picDir(uin),
  },
  {
    id: 'video',
    label: '聊天视频',
    desc: '聊天中的视频缓存，服务器过期后可能无法恢复',
    tier: 'caution',
    hasVariants: true,
    resolveDir: (p, uin) => p.videoDir(uin),
  },
  {
    id: 'emojiRecv',
    label: '收到的表情',
    desc: '聊天中收到的动态表情缓存',
    tier: 'caution',
    hasVariants: true,
    resolveDir: (p, uin) => p.emojiRecvDir(uin),
  },
  {
    id: 'personalEmoji',
    label: '我的表情',
    desc: '你添加 / 收藏的自定义表情',
    tier: 'caution',
    hasVariants: true,
    resolveDir: (p, uin) => p.personalEmojiDir(uin),
  },
  {
    id: 'ptt',
    label: '聊天语音',
    desc: '聊天中的语音缓存，服务器过期后可能无法恢复',
    tier: 'caution',
    hasVariants: false,
    resolveDir: (p, uin) => p.pttDir(uin),
  },
  {
    id: 'file',
    label: 'File 目录',
    desc: 'nt_data/File 聊天文件缓存（不含你主动下载的文件）',
    tier: 'caution',
    hasVariants: false,
    resolveDir: (p, uin) => p.fileDir(uin),
  },
];

/** Hard cap on nodes visited per scan/delete so a pathological tree can't wedge us. */
const NODE_CAP = 2_000_000;

export class ResourceCleanupService {
  private readonly logger = getLogger().child({ scope: 'resource-cleanup' });

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  private get uin(): string {
    return this.session.context.uin;
  }

  /** Absolute `nt_data` root for the account (the containment boundary), or null. */
  private ntDataRoot(): string | null {
    return this.platform.ntDataDir(this.uin);
  }

  /**
   * Resolve a target's directory AND verify it sits inside `nt_data`. Returns the
   * absolute path only when it's a real, contained sub-directory — the single
   * gate every read/delete goes through, so nothing outside `nt_data` is touched.
   */
  private safeDir(def: CleanupTargetDef): string | null {
    const root = this.ntDataRoot();
    if (!root) return null;
    const dir = def.resolveDir(this.platform, this.uin);
    if (!dir) return null;
    const base = resolve(root);
    const abs = resolve(dir);
    // Must be strictly *inside* nt_data (never the root itself).
    if (abs === base || !abs.startsWith(base + sep)) {
      this.logger.warn('cleanup target resolved outside nt_data — skipped', {
        event: 'cleanup-target-out-of-bounds',
        targetId: def.id,
        dir: abs,
        root: base,
      });
      return null;
    }
    return abs;
  }

  // ── listing (size scan) ──────────────────────────────────────────────────────

  /**
   * Per-target on-disk size (files/bytes + ori/thumb split). Slow — every file is
   * `stat`-ed — so the UI shows a loading state while this runs. Targets whose
   * directory is absent come back `present: false` with zero counts.
   */
  async listTargets(): Promise<CleanupTargetStat[]> {
    return Promise.all(
      TARGETS.map(async (def): Promise<CleanupTargetStat> => {
        const dir = this.safeDir(def);
        const empty: CleanupTargetStat = {
          id: def.id,
          label: def.label,
          desc: def.desc,
          tier: def.tier,
          hasVariants: def.hasVariants,
          present: false,
          files: 0,
          bytes: 0,
          ori: { files: 0, bytes: 0 },
          thumb: { files: 0, bytes: 0 },
        };
        if (!dir || !existsSync(dir)) return empty;
        const scan = await this.scan(dir);
        return { ...empty, present: scan.sawDir, files: scan.files, bytes: scan.bytes, ori: scan.ori, thumb: scan.thumb };
      }),
    );
  }

  /** Iterative DFS size scan with an ori/thumb split (mirrors `analyzeTree`). */
  private async scan(base: string): Promise<{
    sawDir: boolean;
    files: number;
    bytes: number;
    ori: CleanupBucket;
    thumb: CleanupBucket;
  }> {
    const out = {
      sawDir: false,
      files: 0,
      bytes: 0,
      ori: { files: 0, bytes: 0 } as CleanupBucket,
      thumb: { files: 0, bytes: 0 } as CleanupBucket,
    };
    const rootLen = base.length;
    const stack: string[] = [base];
    let visited = 0;
    while (stack.length > 0 && visited < NODE_CAP) {
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
        out.sawDir = true;
      } catch {
        continue;
      }
      const files: string[] = [];
      for (const ent of dirents) {
        visited += 1;
        if (ent.isDirectory()) stack.push(join(dir, ent.name));
        else if (ent.isFile()) files.push(join(dir, ent.name));
      }
      await Promise.all(
        files.map(async (abs) => {
          let st;
          try {
            st = await stat(abs);
          } catch {
            return;
          }
          out.files += 1;
          out.bytes += st.size;
          const bucket = variantBucket(abs.slice(rootLen));
          if (bucket === 'ori') {
            out.ori.files += 1;
            out.ori.bytes += st.size;
          } else if (bucket === 'thumb') {
            out.thumb.files += 1;
            out.thumb.bytes += st.size;
          }
        }),
      );
    }
    return out;
  }

  // ── cleanup (delete) ─────────────────────────────────────────────────────────

  /**
   * Execute a batch of cleanup instructions. Unknown / out-of-bounds ids are
   * silently ignored (whitelist gate). Each target is isolated in try/catch so a
   * locked file (running QQ) or vanished tree can't abort the rest; failures are
   * counted and returned. Returns total bytes freed + per-target results.
   */
  async cleanup(instructions: CleanupInstruction[]): Promise<CleanupResult> {
    const perTarget: CleanupTargetResult[] = [];
    let freedBytes = 0;

    for (const ins of instructions) {
      const def = TARGETS.find((t) => t.id === ins.id);
      if (!def) continue; // not on the whitelist — ignore
      const dir = this.safeDir(def);
      if (!dir || !existsSync(dir)) continue;

      // A variant delete only makes sense for split trees; for non-variant
      // targets any variant means "the whole thing".
      const variant: CleanupVariant = def.hasVariants ? ins.variant : 'all';

      try {
        const res =
          variant === 'all'
            ? this.removeDirWhole(dir)
            : await this.removeByVariant(dir, variant);
        freedBytes += res.freedBytes;
        perTarget.push({ id: def.id, variant, ...res });
      } catch (error) {
        this.logger.error('cleanup target failed', {
          event: 'cleanup-target-failed',
          targetId: def.id,
          variant,
          dir,
          ...logErrorContext(error),
        });
        perTarget.push({ id: def.id, variant, freedBytes: 0, removed: 0, failed: 1 });
      }
    }

    this.logger.info('cleaned nt_data resources', {
      event: 'clear-nt-data',
      uin: this.uin,
      freedBytes,
      targets: perTarget.map((t) => `${t.id}:${t.variant}`),
    });
    return { freedBytes, perTarget };
  }

  /** Remove a whole target dir, then recreate it empty (mirrors `clearCache`). */
  private removeDirWhole(dir: string): { freedBytes: number; removed: number; failed: number } {
    const freedBytes = dirSizeBytesSync(dir);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // Whole-dir remove doesn't track per-file counts; report a coarse success.
    return { freedBytes, removed: 1, failed: 0 };
  }

  /** Walk the tree and unlink only files under the requested variant segment. */
  private async removeByVariant(
    base: string,
    variant: 'ori' | 'thumb',
  ): Promise<{ freedBytes: number; removed: number; failed: number }> {
    const rootLen = base.length;
    const stack: string[] = [base];
    let freedBytes = 0;
    let removed = 0;
    let failed = 0;
    let visited = 0;

    while (stack.length > 0 && visited < NODE_CAP) {
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files: string[] = [];
      for (const ent of dirents) {
        visited += 1;
        if (ent.isDirectory()) stack.push(join(dir, ent.name));
        else if (ent.isFile()) files.push(join(dir, ent.name));
      }
      await Promise.all(
        files.map(async (abs) => {
          if (variantBucket(abs.slice(rootLen)) !== variant) return;
          let size = 0;
          try {
            size = (await stat(abs)).size;
          } catch {
            return; // vanished
          }
          try {
            await unlink(abs);
            freedBytes += size;
            removed += 1;
          } catch {
            failed += 1; // locked by a running QQ, etc.
          }
        }),
      );
    }
    return { freedBytes, removed, failed };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Classify a file by its path into the ori / thumb / other bucket (same rule as media_resource). */
function variantBucket(relPath: string): 'ori' | 'thumb' | 'other' {
  const segs = relPath.split(/[/\\]/);
  if (segs.includes('Thumb')) return 'thumb';
  if (segs.includes('Ori') || segs.includes('OriTemp')) return 'ori';
  return 'other';
}

/** Synchronous recursive byte size with a node-visit cap. Missing dirs → 0. */
function dirSizeBytesSync(root: string, cap = NODE_CAP): number {
  let total = 0;
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && visited < cap) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirents) {
      visited += 1;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        try {
          total += statSync(abs).size;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return total;
}
