/**
 * SysEmojiDownloadService —— QQ 资源目录缺失时，自己下内置表情。
 *
 * QQ NT 把小黄脸铺在 `nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<id>/`
 * 下（png / apng / lottie 三个子目录）。但这个目录并不总是在：换机、清缓存、
 * 只拿到一份解密库的静态账号，都可能没有它。此时 `weq-asset://emoji/...` 全部
 * 404，聊天里的表情只能退化成兜底笑脸。
 *
 * 好在 `emoji.db` 的 `base_sys_emoji_table` 存着官方 CDN 的资源包地址：
 *
 *   81229  <id>_base_<ts>.zip   →  <id>/png/<id>.png
 *   81230  <id>_adv_<ts>.zip    →  <id>/apng/<id>.png + <id>/lottie/<id>[_n].json
 *
 * **zip 内的目录结构与 QQ 本地目录完全一致**，所以只要把它解到一个镜像根目录，
 * 渲染侧的 URL 形状（`emoji/<id>/apng/<id>.png`）一个字都不用改 —— 见
 * `resource_protocol.ts` 的 emoji 根回退。
 *
 * 只下 `_adv` 包：渲染只用 apng + lottie，`_base` 里的 png 没人读。81230 为空的
 * 68 行全是 Unicode 字符表情（😊 那批），它们本来就按字符渲染、不需要图片资源。
 *
 * URL 里的时间戳每个表情不同（多数 1712825561，但 148/55 是 1719222678，443 更
 * 走 `test/sysemoji/v2/` 另一条路径），**必须从库里读，不能拼**。
 *
 * 库读不到时退到 `sys_emoji_fallback.ts` 的硬编码表。这不是可选的锦上添花：实测
 * 存在 `base_sys_emoji_table` **表在但 0 行**的环境（QQ 从没在该机器上同步过内置
 * 表情），此时 QQ 的资源目录同样是空的 —— 两头皆空，没有兜底就一个表情都渲染不出。
 */

import { existsSync } from 'node:fs';
import { type AccountSession, algoFor } from '@weq/account';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { Platform } from '@weq/platform';
import { BaseSysEmojiDb } from '@weq/db';
import { readZipEntries } from '../common/zip';
import { fallbackSysEmojiUrls } from './sys_emoji_fallback';

/** 一个内置表情的 CDN 资源包地址（来自 base_sys_emoji_table）。 */
export interface SysEmojiSource {
  /** 目录名 —— 数字 id（`358`）或 unicode 字形（`😊`）。 */
  id: string;
  /** 静态包 `<id>_base_<ts>.zip`（只含 png，当前不下载）。 */
  staticUrl: string;
  /** 动画包 `<id>_adv_<ts>.zip`（apng + lottie）；Unicode 表情没有，为空。 */
  apngUrl: string;
}

/** 一次批量补全的结果统计。 */
export interface SysEmojiDownloadResult {
  /** 本次真正下载并解开的表情数。 */
  downloaded: number;
  /** 已在本地（QQ 目录或缓存镜像）而跳过的表情数。 */
  skipped: number;
  /** 下载或解压失败的表情数。 */
  failed: number;
  /** 库里没有 apngUrl（Unicode 字符表情）而不需要资源的表情数。 */
  unavailable: number;
}

/** 单个表情的补全结果。 */
export type SysEmojiFetchOutcome = 'downloaded' | 'cached' | 'unavailable' | 'failed';

/** 补全能力的当前状态，供设置页决定显不显示「一键补全」。 */
export interface SysEmojiDownloadStatus {
  /** QQ 自己的资源目录（缺失为 null）——这正是要不要补全的判据。 */
  qqRoot: string | null;
  /** 我们的镜像目录。 */
  cacheRoot: string;
  /** emoji.db 里有动画包地址的表情数；0 表示库缺失/不可读，补全不可用。 */
  available: number;
  /** 其中已在本地（QQ 目录或镜像）的表情数。 */
  present: number;
  /** 地址来自硬编码兜底表而非 emoji.db（库缺失或 base_sys_emoji_table 为空）。 */
  usingFallback: boolean;
}

/** 资源包最大字节数——最大的动画包约 1MB，留足余量后拒绝异常响应。 */
const MAX_ZIP_BYTES = 32 * 1024 * 1024;

/** 官方 CDN 域名白名单：库里的地址不可信到能写盘，先校验来源。 */
const ALLOWED_HOSTS = new Set(['wa.qq.com']);

/**
 * 失败后多久才允许再试。补全是由渲染 404 触发的，聊天记录里同一个表情可能出现
 * 几百次；没有冷却的话一次断网就会变成几百次重试。
 */
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/** 批量补全的并发度——够快，又不至于把 CDN 打成限流。 */
const BULK_CONCURRENCY = 6;

export class SysEmojiDownloadService {
  /** emoji.db 是只读静态表，一个账号会话内解析一次。 */
  private sources: Promise<Map<string, SysEmojiSource>> | null = null;
  /** 同一个 id 的并发补全合流到一次下载。 */
  private readonly inFlight = new Map<string, Promise<SysEmojiFetchOutcome>>();
  /** id → 上次失败时刻，用于冷却期内直接返回失败而不打网络。 */
  private readonly failedAt = new Map<string, number>();
  /** 本次解析是否退到了硬编码兜底表（emoji.db 缺失或表为空）。 */
  private fellBack = false;

  /**
   * @param cacheRoot 镜像根目录（`userConfig.cacheDir('sysemoji')` 之类）——
   *   解出来的目录结构与 QQ 的 EmojiSystermResource 同构。
   */
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly cacheRoot: string,
  ) {}

  /** 镜像根目录（协议层缺资源时按这个根再找一次）。 */
  root(): string {
    return this.cacheRoot;
  }

  /**
   * id → 资源包地址。优先 `base_sys_emoji_table`（腾讯会更新它），库缺失 / 读失败
   * / **表为空** 时退到硬编码兜底表。
   */
  async listSources(): Promise<Map<string, SysEmojiSource>> {
    if (!this.sources) {
      this.sources = this.loadSources()
        .catch(() => new Map<string, SysEmojiSource>())
        .then((fromDb) => {
          // 空表和读失败一样要兜底——实测存在表在但 0 行的环境。
          if (fromDb.size > 0) return fromDb;
          this.fellBack = true;
          return fallbackSources();
        });
    }
    return this.sources;
  }

  private async loadSources(): Promise<Map<string, SysEmojiSource>> {
    const dir = this.platform.ntDbDir(this.session.context.uin);
    if (!dir) return new Map();
    const dbPath = join(dir, 'emoji.db');
    if (!existsSync(dbPath)) return new Map();

    const db = new BaseSysEmojiDb(this.platform.native.ntHelper, {
      dbPath,
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, dbPath),
    });
    const rows = await db.listAll();
    const out = new Map<string, SysEmojiSource>();
    for (const row of rows) {
      const id = row.id.trim();
      if (!id) continue;
      out.set(id, { id, staticUrl: row.staticUrl.trim(), apngUrl: row.apngUrl.trim() });
    }
    return out;
  }

  /**
   * 确保 `id` 的动画资源在本地可用。QQ 自己的目录里有就什么都不做；否则下动画包
   * 解到镜像目录。并发调用同一个 id 只会真下一次，失败的 id 在冷却期内直接拒绝。
   */
  async ensure(id: string): Promise<SysEmojiFetchOutcome> {
    if (!isSafeFaceId(id)) return 'failed';
    if (this.hasLocal(id)) return 'cached';

    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const failed = this.failedAt.get(id);
    if (failed !== undefined && Date.now() - failed < RETRY_COOLDOWN_MS) return 'failed';

    const p = this.fetchOne(id)
      .then((outcome) => {
        // 只有真正打过网络的失败才需要冷却；'unavailable'（库里就没这个包）本来
        // 就走不到网络，重复问的代价只是一次 Map 查找。
        if (outcome === 'failed') this.failedAt.set(id, Date.now());
        else this.failedAt.delete(id);
        return outcome;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  /**
   * 批量补全所有库里有动画包的表情。`onProgress` 每完成一个回调一次，供设置页
   * 展示进度条。
   */
  async ensureAll(
    onProgress?: (done: number, total: number) => void,
  ): Promise<SysEmojiDownloadResult> {
    const sources = await this.listSources();
    const ids = [...sources.keys()];
    const result: SysEmojiDownloadResult = {
      downloaded: 0,
      skipped: 0,
      failed: 0,
      unavailable: 0,
    };

    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!;
        const outcome = await this.ensure(id);
        if (outcome === 'downloaded') result.downloaded += 1;
        else if (outcome === 'cached') result.skipped += 1;
        else if (outcome === 'unavailable') result.unavailable += 1;
        else result.failed += 1;
        done += 1;
        onProgress?.(done, ids.length);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, () => worker()),
    );
    return result;
  }

  /** 补全能力的当前状态（QQ 目录在不在、有多少表情已就位）。 */
  async status(): Promise<SysEmojiDownloadStatus> {
    const sources = await this.listSources();
    let available = 0;
    let present = 0;
    for (const source of sources.values()) {
      if (!source.apngUrl) continue;
      available += 1;
      if (this.hasLocal(source.id)) present += 1;
    }
    return {
      qqRoot: this.platform.emojiResourceDir(this.session.context.uin),
      cacheRoot: this.cacheRoot,
      available,
      present,
      usingFallback: this.fellBack,
    };
  }

  /** 该表情的动画资源是否已在本地（QQ 自己的目录，或我们下过的镜像）。 */
  private hasLocal(id: string): boolean {
    const qqRoot = this.platform.emojiResourceDir(this.session.context.uin);
    const rel = join(id, 'apng', `${id}.png`);
    if (qqRoot && existsSync(join(qqRoot, rel))) return true;
    return existsSync(join(this.cacheRoot, rel));
  }

  private async fetchOne(id: string): Promise<SysEmojiFetchOutcome> {
    const sources = await this.listSources();
    const url = sources.get(id)?.apngUrl;
    // 库里没有动画包 = Unicode 字符表情，前端按字符渲染，不是错误。
    if (!url) return 'unavailable';
    if (!isAllowedUrl(url)) return 'failed';

    try {
      const zip = await downloadBuffer(url);
      const entries = readZipEntries(zip);
      if (entries.length === 0) return 'failed';

      // 先解到 `<id>.part`，成品目录整体改名换上——半个目录会让协议层拿到
      // 404 之后再也不重试（hasLocal 只看 apng 是否存在）。
      const finalDir = join(this.cacheRoot, id);
      const stageDir = `${finalDir}.part`;
      await rm(stageDir, { recursive: true, force: true });

      let wrote = 0;
      for (const entry of entries) {
        // zip 内路径形如 `<id>/apng/<id>.png`，剥掉与目录同名的首段后落到 stage。
        const rel = stripLeadingSegment(entry.name, id);
        if (!rel) continue;
        const target = normalize(join(stageDir, rel));
        if (target !== stageDir && !target.startsWith(stageDir + sep)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data);
        wrote += 1;
      }
      if (wrote === 0) {
        await rm(stageDir, { recursive: true, force: true });
        return 'failed';
      }

      await rm(finalDir, { recursive: true, force: true });
      await mkdir(dirname(finalDir), { recursive: true });
      await rename(stageDir, finalDir);
      return 'downloaded';
    } catch {
      return 'failed';
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * 表情目录名可以是数字 id 也可以是 unicode 字形，但绝不能含路径分隔符或 `..`
 * ——它会直接进 `join`。
 */
function isSafeFaceId(id: string): boolean {
  return id.length > 0 && id.length <= 32 && !/[\\/]/.test(id) && !id.includes('..');
}

/** 只允许官方表情 CDN，且必须是 https。 */
function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** 硬编码兜底表展开成与数据库同形的 id → 地址。 */
function fallbackSources(): Map<string, SysEmojiSource> {
  const out = new Map<string, SysEmojiSource>();
  for (const [id, urls] of fallbackSysEmojiUrls()) {
    out.set(id, { id, staticUrl: urls.staticUrl, apngUrl: urls.apngUrl });
  }
  return out;
}

/**
 * 剥掉 zip 条目路径里与表情同名的首段（`358/apng/358.png` → `apng/358.png`）。
 * 首段不匹配时原样返回；目录条目（以 `/` 结尾）返回 null。
 */
function stripLeadingSegment(name: string, id: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.endsWith('/')) return null;
  const prefix = `${id}/`;
  const rel = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return rel.length > 0 ? rel : null;
}

/** 下载整个响应体，拒绝超大响应。 */
async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ZIP_BYTES) throw new Error('resource too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_ZIP_BYTES) throw new Error('bad resource size');
  return buf;
}
