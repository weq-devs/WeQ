/**
 * EmojiService — handles QQ "Market Face" (store emoji) decryption and fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AccountSession, algoFor } from '@weq/account';
import type { Platform } from '@weq/platform';
import {
  BaseSysEmojiDb,
  EmojiComUsedDb,
  FavEmojiDb,
  MarketEmoticonDb,
  MarketEmoticonPackageDb,
  RelatedEmojiDb,
} from '@weq/db';
import type { MarketEmoticonPackage, RecentEmojiEntry, RecentEmojiInput, SysEmoji } from '@weq/db';

/** 系统表情清单项：faceId + 外显文字（如 "[微笑]"），供前端把 faceText 渲染成表情图。 */
export interface SystemFaceEntry {
  id: number;
  desc: string;
  /** 1 系统表情(小黄脸) / 2 emoji 字符表情 / 3 动态可变表情(骰子等)——用于分组。 */
  emojiType: number;
  /** Unicode 字符表情的 code point；0 表示非此类（走本地图片资源）。 */
  unicodeId: number;
}

/**
 * 商城表情包收费类型（来自 CDN `android.json` 的 `feetype` 字段，非数据库、非
 * `type` 字段）。经实测校验：祝福鸟(11340) feetype=4=VIP、天使小泪(247623)
 * feetype=2=付费——`type` 字段含义不同（静态/APNG 之类），不能拿来判来源。
 */
export type MarketPackFeeType = 'free' | 'paid' | 'svip' | 'vip' | 'unknown';

/** 商城表情包里的一张表情（来自 `android.json` 的 `imgs[]`）。 */
export interface MarketPackItem {
  /** 表情图片 hash（= `imgs[i].id`，也是 CDN 资源路径的 hash）。 */
  hash: string;
  /** 表情名（如 "滑稽"）。 */
  name: string;
  /** 关联关键词（可空）。 */
  keywords: string[];
}

/** 一个商城表情包的在线详情（拉取 `android.json` 解析）。 */
export interface MarketPackDetail {
  /** 表情包 ID（packId / emojiPackId）。 */
  packId: string;
  /** 表情包名称。 */
  name: string;
  /** 介绍文案（`android.json` 的 `mark`）。 */
  summary: string;
  /** 收费类型（免费 / 付费 / SVIP / VIP）。 */
  feeType: MarketPackFeeType;
  /** 原始 feetype 数字（1免费/2付费/4VIP/5SVIP；缺失或未知为 0/其它）。 */
  feeTypeRaw: number;
  /** 上架时间（Unix 秒；0 表示缺失）——爆破密钥的时间窗提示。 */
  updateTime: number;
  /** 表情张数。 */
  count: number;
  /** 表情列表（hash + 名称）。 */
  items: MarketPackItem[];
  /** 明细来源：在线 android.json 还是本地 market_emoticon_table。 */
  source?: 'online' | 'local';
}

/** 面板里的一枚系统 / 字符表情。 */
export interface PanelFaceItem {
  /** 稳定 key（图片表情 = faceId，字符表情 = 字形）。 */
  id: string;
  /** 外显文字（`[微笑]` / `/微笑` / 字形）。 */
  desc: string;
  /** 是否 unicode 字符表情（无本地图片，按字符渲染）。 */
  unicode: boolean;
  /** 字符表情的字形（非字符表情为 ''）。 */
  glyph: string;
}

/** 按 81266 分类的一组表情。 */
export interface PanelFaceGroup {
  /** 分组 key（分类名的稳定 slug）。 */
  key: string;
  /** 分组显示名。 */
  label: string;
  /** 81226 类型（1 系统 / 2 动态大表情 / 3 互动）。 */
  emojiType: number;
  /** 该组是否全部是 unicode 字符表情。 */
  unicode: boolean;
  items: PanelFaceItem[];
}

/** 最近使用的一条（已解析成可渲染的形状）。 */
export interface PanelRecentItem extends PanelFaceItem {
  /** 使用时间（Unix 毫秒；0 未知）。 */
  usedAt: number;
}

/** 收藏的一张自定义表情（已拆好磁盘寻址字段）。 */
export interface PanelFavItem {
  id: string;
  hash: string;
  /** `personal` / `recv`（对应 weq-media://cemoji 的 scope）。 */
  scope: string;
  /** recv 的月份桶，personal 为空串。 */
  bucket: string;
  /** 原图磁盘文件名（可能为空）。 */
  oriFile: string | null;
  /** 缩略图磁盘文件名（可能为空）。 */
  thumbFile: string | null;
  /** 在线 CDN 兜底（可空）。 */
  remoteUrl: string;
}

/** GIF 表情的一个关键词标签。 */
export interface PanelRelatedTag {
  keyword: string;
  /** 磁盘目录名 = md5(关键词)（对应 weq-media://relemoji 的 hash）。 */
  dirHash: string;
  count: number;
  /** 封面 gif 文件名（可能为空）。 */
  cover: string | null;
}

/** GIF 表情的一条（已拆好寻址字段）。 */
export interface PanelRelatedGif {
  hash: string;
  /** 磁盘文件名（`<gifHash>.gif`）。 */
  file: string;
}

/** 商城表情包解密密钥的恢复结果。 */
export interface MarketPackKey {
  /** 16 字符 ASCII 密钥（喂给 QQTEA）。 */
  key: string;
  /** 派生该密钥的 Unix 秒级时间戳（手动输入时即用户给的值）。 */
  timestamp: number;
  /**
   * 密钥来源：
   *   - `xydata`      包元数据直接带了种子时间戳（免费/VIP 包）
   *   - `brute-force` 在 updateTime 附近时间窗爆破出来（付费包）
   *   - `manual`      用户手动输入时间戳后本地派生
   */
  source: string;
}

export class EmojiService {
  /** emoji.db 是只读静态表，一个账号会话内缓存一次。 */
  private sysFaces: SystemFaceEntry[] | null = null;
  /** base_sys_emoji_table 原始行（带分类 81266），面板用。 */
  private sysFaceRaw: SysEmoji[] | null = null;
  /** 本地商城表情包清单，一个账号会话内缓存一次。 */
  private marketPackages: MarketEmoticonPackage[] | null = null;
  /** 收藏（我喜欢的自定义表情）缓存。 */
  private favorites: PanelFavItem[] | null = null;
  /** 关联 GIF 分组缓存。 */
  private relatedTags: PanelRelatedTag[] | null = null;
  /** packId → 在线详情（android.json），会话内缓存（含 in-flight 去重）。 */
  private packDetailCache = new Map<string, Promise<MarketPackDetail | null>>();
  /** packId → 解密密钥，会话内缓存（native 恢复较快但结果稳定，缓存省重复爆破）。 */
  private packKeyCache = new Map<string, Promise<MarketPackKey | null>>();

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /**
   * 列出内置系统表情（id + 外显文字），用于前端把克隆体回复里的 `/捂脸` 这类
   * faceText 渲染成表情图。读 emoji.db 的 base_sys_emoji_table，失败/缺库返回空表。
   */
  /** emoji.db 的绝对路径，不存在返回 null。 */
  private emojiDbPath(): string | null {
    const dir = this.platform.ntDbDir(this.session.context.uin);
    if (!dir) return null;
    const dbPath = join(dir, 'emoji.db');
    return existsSync(dbPath) ? dbPath : null;
  }

  /** emoji.db 的连接参数（key + algo），配合 `new XxxDb(nt, opts)` 使用。 */
  private emojiDbOptions(dbPath: string): {
    dbPath: string;
    key: string;
    algo: ReturnType<typeof algoFor>;
  } {
    return {
      dbPath,
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, dbPath),
    };
  }

  /** base_sys_emoji_table 原始行（缓存一次）。 */
  private async loadSysFaceRows(): Promise<SysEmoji[]> {
    if (this.sysFaceRaw) return this.sysFaceRaw;
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      const db = new BaseSysEmojiDb(this.platform.native.ntHelper, this.emojiDbOptions(dbPath));
      this.sysFaceRaw = await db.listAll();
      return this.sysFaceRaw;
    } catch {
      return [];
    }
  }

  /**
   * 列出内置系统表情（id + 外显文字），用于前端把克隆体回复里的 `/捂脸` 这类
   * faceText 渲染成表情图。只保留数字 id 的图片表情（字符表情 id 是字形，跳过）。
   */
  async listSystemFaces(): Promise<SystemFaceEntry[]> {
    if (this.sysFaces) return this.sysFaces;
    const rows = await this.loadSysFaceRows();
    this.sysFaces = rows
      .map((r) => ({
        id: Number(r.id),
        desc: r.desc,
        emojiType: r.emojiType,
        unicodeId: r.unicodeId,
      }))
      .filter((r) => Number.isFinite(r.id) && r.desc);
    return this.sysFaces;
  }

  /**
   * 面板用：按 `81266` 分类列出内置表情。字符表情（`81214` 非 0，id 是字形）
   * 单独成组（`unicode: true`），不与小黄脸等图片表情混排。失败/缺库返回空表。
   */
  async listPanelFaces(): Promise<PanelFaceGroup[]> {
    const rows = await this.loadSysFaceRows();
    const groups = new Map<string, PanelFaceGroup>();
    for (const r of rows) {
      if (!r.id) continue;
      const unicode = r.unicodeId !== 0 || isGlyphId(r.id);
      const label = r.category || (r.emojiType === 3 ? '互动表情' : '其他表情');
      const key = `${r.emojiType}:${label}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, label, emojiType: r.emojiType, unicode, items: [] };
        groups.set(key, group);
      }
      group.items.push({
        id: r.id,
        desc: r.desc || r.id,
        unicode,
        glyph: unicode ? r.id : '',
      });
    }
    return [...groups.values()].sort(compareFaceGroups);
  }

  /**
   * 面板「最近使用」：读 emoji_com_used_table 解码后，配上 base_sys_emoji 的
   * 外显文字 / 字形，得到可渲染列表（最新在前）。
   */
  async listRecentEmojis(): Promise<PanelRecentItem[]> {
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    let state: Awaited<ReturnType<EmojiComUsedDb['list']>>;
    try {
      state = await new EmojiComUsedDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).list();
    } catch {
      return [];
    }
    const { byId, byUnicode } = await this.faceLookups();
    const out: PanelRecentItem[] = [];
    for (const entry of state.entries) {
      const resolved = resolveRecent(entry, byId, byUnicode);
      if (resolved) out.push({ ...resolved, usedAt: entry.usedAt });
    }
    return out;
  }

  /**
   * 前端「发送 / 使用」一个系统表情时，把它写回 emoji_com_used_table（与 QQ 共用）。
   * 失败不影响发送，返回是否写入成功。
   */
  async recordRecentEmoji(input: RecentEmojiInput): Promise<boolean> {
    const dbPath = this.emojiDbPath();
    if (!dbPath) return false;
    try {
      await new EmojiComUsedDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).record(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 面板「收藏」：读 fav_emoji_info_storage_table，拆好 weq-media://cemoji 的寻址字段。
   *
   * 只保留「本地真的有文件」的条目 —— 收藏表里相当一部分条目对应的缓存早被清掉了
   * （实测 259 条里磁盘只剩 136 张），显示出来也发不出去。ori / thumb 各自独立判
   * 存在，页面用存在的那一个；`scope`/`bucket` 跟着实际选中的变体走，避免串位。
   */
  async listFavoriteEmojis(): Promise<PanelFavItem[]> {
    if (this.favorites) return this.favorites;
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      const rows = await new FavEmojiDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).listAll();
      this.favorites = rows
        .map((row): PanelFavItem | null => {
          const oriInfo = parseEmojiDiskPath(row.oriPath);
          const thumbInfo = parseEmojiDiskPath(row.thumbPath);
          const ori = this.usableFavVariant(oriInfo, 'ori');
          const thumb = this.usableFavVariant(thumbInfo, 'thumb');
          const chosen = thumb ?? ori;
          if (!chosen) return null;
          return {
            id: row.id,
            hash: row.hash,
            scope: chosen.scope,
            bucket: chosen.bucket,
            oriFile: ori?.file ?? null,
            thumbFile: thumb?.file ?? null,
            remoteUrl: row.remoteUrl,
          };
        })
        .filter((x): x is PanelFavItem => x !== null);
      return this.favorites;
    } catch {
      return [];
    }
  }

  /** 收藏的一个变体：仅当文件确实在磁盘上时才返回（否则 null，条目会被过滤掉）。 */
  private usableFavVariant(
    info: { scope: 'personal' | 'recv'; bucket: string; file: string } | null,
    variant: 'ori' | 'thumb',
  ): { scope: 'personal' | 'recv'; bucket: string; file: string } | null {
    if (!info) return null;
    return this.customEmojiLocalPath(info.scope, info.bucket, variant, info.file) ? info : null;
  }

  /**
   * 收藏（自定义表情）文件的磁盘绝对路径 —— 与 `weq-media://cemoji` 的解析规则
   * 一致（personal 平铺 / recv 按月分桶）。文件不在就返回 null，这样「面板能显示」
   * 就等于「协议取得到、发得出去」。
   */
  private customEmojiLocalPath(
    scope: 'personal' | 'recv',
    bucket: string,
    variant: 'ori' | 'thumb',
    file: string,
  ): string | null {
    if (!file) return null;
    const dir = variant === 'ori' ? 'Ori' : 'Thumb';
    const uin = this.session.context.uin;
    if (scope === 'recv') {
      if (!/^\d{4}-\d{2}$/.test(bucket)) return null;
      const root = this.platform.emojiRecvDir(uin);
      return root ? existingFile(join(root, bucket, dir, file)) : null;
    }
    if (scope === 'personal') {
      const root = this.platform.personalEmojiDir(uin);
      return root ? existingFile(join(root, dir, file)) : null;
    }
    return null;
  }

  /**
   * 面板「GIF 表情」标签：按关键词聚合 related_emoji_emoji_table，给出每组的
   * 磁盘目录 hash（= md5(关键词)）与封面。按组的权重 / 数量排序。
   */
  async listRelatedTags(): Promise<PanelRelatedTag[]> {
    if (this.relatedTags) return this.relatedTags;
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      const rows = await new RelatedEmojiDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).listAll();
      const byKeyword = new Map<string, { dirHash: string; files: string[]; weight: number }>();
      for (const row of rows) {
        if (!row.keyword) continue;
        const file = relatedFileName(row.localPath, row.gifHash);
        const dirHash = relatedDirHash(row.localPath, row.keyword);
        // 只统计本地真的有这个 gif 的行：没资源的标签 / 表情显示出来也发不出去。
        if (!file || !this.relatedGifLocalPath(dirHash, file)) continue;
        const bucket = byKeyword.get(row.keyword) ?? { dirHash, files: [], weight: row.weight };
        if (!bucket.files.includes(file)) bucket.files.push(file);
        bucket.weight = Math.max(bucket.weight, row.weight);
        byKeyword.set(row.keyword, bucket);
      }
      this.relatedTags = [...byKeyword.entries()]
        .map(([keyword, v]) => ({
          keyword,
          dirHash: v.dirHash,
          count: v.files.length,
          cover: v.files[0] ?? null,
        }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
      return this.relatedTags;
    } catch {
      return [];
    }
  }

  /** 某个关键词标签下的全部 gif（供灯箱展示 / 发送）。 */
  async listRelatedGifs(keyword: string): Promise<PanelRelatedGif[]> {
    const tags = await this.listRelatedTags();
    const tag = tags.find((t) => t.keyword === keyword);
    if (!tag) return [];
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      const rows = await new RelatedEmojiDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).listAll();
      const out: PanelRelatedGif[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.keyword !== keyword) continue;
        const file = relatedFileName(row.localPath, row.gifHash);
        if (!file || seen.has(file)) continue;
        if (!this.relatedGifLocalPath(tag.dirHash, file)) continue;
        seen.add(file);
        out.push({ hash: tag.dirHash, file });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 关联 GIF 的磁盘绝对路径 —— 与 `weq-media://relemoji` 的解析规则一致
   * （`emoji-related/emoji/<md5(关键词)>/<file>`）。不存在返回 null。
   */
  private relatedGifLocalPath(dirHash: string, file: string): string | null {
    if (!dirHash || !file) return null;
    const root = this.platform.emojiRelatedDir(this.session.context.uin);
    return root ? existingFile(join(root, dirHash, file)) : null;
  }

  /**
   * 列出「我添加到本地的商城表情包」——读 emoji.db 的
   * market_emoticon_package_table，按添加时间倒序。失败/缺库返回空表。
   */
  async listMarketPackages(): Promise<MarketEmoticonPackage[]> {
    if (this.marketPackages) return this.marketPackages;
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      this.marketPackages = await new MarketEmoticonPackageDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).listAll();
      return this.marketPackages;
    } catch {
      return [];
    }
  }

  /**
   * 商城表情包明细：在线 android.json 优先（列表最全），缺网 / 拉不到时回退
   * 本地 market_emoticon_table（hash + 名称），保证离线也能看已添加的表情。
   */
  async getMarketPackItems(packId: string): Promise<MarketPackDetail | null> {
    const online = await this.getMarketPackDetail(packId);
    if (online && online.items.length > 0) return { ...online, source: 'online' };

    const local = await this.listLocalMarketItems(packId);
    if (local.length === 0) return online ? { ...online, source: 'online' } : null;

    return {
      packId,
      name: online?.name ?? '',
      summary: online?.summary ?? '',
      feeType: online?.feeType ?? 'unknown',
      feeTypeRaw: online?.feeTypeRaw ?? 0,
      updateTime: online?.updateTime ?? 0,
      count: local.length,
      items: local,
      source: 'local',
    };
  }

  /** 本地 market_emoticon_table 里某个包的全部表情。 */
  private async listLocalMarketItems(packId: string): Promise<MarketPackItem[]> {
    const dbPath = this.emojiDbPath();
    if (!dbPath) return [];
    try {
      const rows = await new MarketEmoticonDb(
        this.platform.native.ntHelper,
        this.emojiDbOptions(dbPath),
      ).listByPack(packId);
      return rows.map((row) => ({ hash: row.hash, name: row.name, keywords: row.keywords }));
    } catch {
      return [];
    }
  }

  /** faceId / unicodeId → 原始系统表情行的两份索引。 */
  private async faceLookups(): Promise<{
    byId: Map<string, SysEmoji>;
    byUnicode: Map<number, SysEmoji>;
  }> {
    const rows = await this.loadSysFaceRows();
    const byId = new Map<string, SysEmoji>();
    const byUnicode = new Map<number, SysEmoji>();
    for (const row of rows) {
      byId.set(row.id, row);
      if (row.unicodeId) byUnicode.set(row.unicodeId, row);
    }
    return { byId, byUnicode };
  }

  /**
   * 拉取并解析一个商城表情包的在线详情（`android.json`）——名称 / 介绍 /
   * **收费类型(feetype)** / 上架时间 / 表情列表(hash+名)。会话内按 packId 缓存
   * （含 in-flight 去重）。网络失败或包不存在返回 null。
   *
   * feetype 才是 README 那张来源表的枚举来源（1免费/2付费/4VIP/5SVIP）；CDN
   * json 里的 `type` 字段含义不同，不能拿来判来源。
   */
  async getMarketPackDetail(packId: string): Promise<MarketPackDetail | null> {
    const id = String(packId).trim();
    if (!/^\d+$/.test(id)) return null;
    const cached = this.packDetailCache.get(id);
    if (cached) return cached;
    const p = this.fetchMarketPackDetail(id).catch(() => null);
    this.packDetailCache.set(id, p);
    return p;
  }

  private async fetchMarketPackDetail(id: string): Promise<MarketPackDetail | null> {
    const url = `https://i.gtimg.cn/club/item/parcel/${Number(id) % 10}/${id}_android.json`;
    const res = await fetch(url, { headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      name?: string;
      mark?: string;
      feetype?: string | number;
      updateTime?: number;
      imgs?: Array<{ id?: string; name?: string; keywords?: unknown }>;
    };
    const feeTypeRaw = Number(j.feetype ?? 0) || 0;
    const items: MarketPackItem[] = Array.isArray(j.imgs)
      ? j.imgs
          .map((e) => ({
            hash: String(e?.id ?? ''),
            name: String(e?.name ?? ''),
            keywords: Array.isArray(e?.keywords)
              ? (e.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
              : [],
          }))
          .filter((it) => it.hash)
      : [];
    return {
      packId: id,
      name: String(j.name ?? ''),
      summary: String(j.mark ?? ''),
      feeType: feeTypeLabel(feeTypeRaw),
      feeTypeRaw,
      updateTime: Number(j.updateTime ?? 0) || 0,
      count: items.length,
      items,
    };
  }

  /**
   * 恢复一个商城表情包的图片解密密钥。默认走 native `getMarketFaceKey`（自动
   * 读种子 / 在 updateTime 附近爆破，付费包也可得）。若显式给了 `timestamp`
   * （用户手动输入体验），直接在本地按 `md5(str(ts))[:16]` 派生，不查网络。
   * 会话内按 packId 缓存（手动派生不缓存，因用户会试不同值）。
   */
  async getMarketPackKey(packId: string, timestamp?: number): Promise<MarketPackKey | null> {
    const id = String(packId).trim();
    if (!/^\d+$/.test(id)) return null;

    if (timestamp && Number.isFinite(timestamp) && timestamp > 0) {
      const ts = Math.floor(timestamp);
      return { key: keyFromTimestamp(ts), timestamp: ts, source: 'manual' };
    }

    const cached = this.packKeyCache.get(id);
    if (cached) return cached;
    const p = this.recoverMarketPackKey(id).catch(() => null);
    this.packKeyCache.set(id, p);
    return p;
  }

  private async recoverMarketPackKey(id: string): Promise<MarketPackKey | null> {
    const result = await this.platform.native.ntHelper.getMarketFaceKey(id);
    if (!result) return null;
    return { key: result.key, timestamp: result.timestamp, source: result.source };
  }

  /**
   * 取一张商城表情的**解密后 GIF** 的本地路径：下载 CDN 加密流（`300_300` →
   * `200_200`）→ 用 packId 恢复的 QQTEA 密钥链式解密 → 落盘缓存。这条链路对应
   * rust 参考实现，与聊天里走明文 CDN 的 {@link getMarketFace} 不同（那条不解密）。
   *
   * `keyOverride` 由上层（手动输入时间戳的体验）透传，跳过自动恢复。任何环节
   * 失败返回 null，前端 `<img onError>` 兜底。
   */
  async getMarketPackImage(
    packId: string,
    hash: string,
    keyOverride?: string,
  ): Promise<string | null> {
    const id = String(packId).trim();
    if (!/^\d+$/.test(id) || !/^[0-9a-f]{6,64}$/i.test(hash)) return null;

    const cacheDir = join(this.platform.appDataRoot(), 'cache', 'marketpack', id);
    const cachePath = join(cacheDir, `${hash}.gif`);
    if (existsSync(cachePath)) return cachePath;

    let key = keyOverride?.trim();
    if (!key) {
      const recovered = await this.getMarketPackKey(id);
      key = recovered?.key;
    }
    if (key?.length !== 16) return null;

    const prefix = hash.slice(0, 2);
    for (const res of ['300_300', '200_200']) {
      const url = `https://i.gtimg.cn/club/item/parcel/item/${prefix}/${hash}/${res}`;
      let ct: Uint8Array;
      try {
        const r = await fetch(url, { headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        ct = new Uint8Array(await r.arrayBuffer());
      } catch {
        continue;
      }
      if (ct.length < 16 || ct.length % 8 !== 0 || ct[0] === 0x3c) continue; // 0x3c='<' → 错误页
      const dec = qqteaDecrypt(ct, new TextEncoder().encode(key));
      if (!dec) continue;
      const magic = Buffer.from(dec.subarray(0, 6)).toString('latin1');
      if (magic !== 'GIF89a' && magic !== 'GIF87a') continue; // 密钥不对 → 换分辨率/放弃
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, dec);
        return cachePath;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Get the path to a decrypted market face GIF.
   *
   * Logic:
   * 1. Check weq's own decrypted cache.
   * 2. Check QQ's encrypted local cache, decrypt and save if found.
   * 3. Download from QQ's CDN (GIF 300/200 -> PNG 300/200) as plaintext and save.
   * 4. Return the path to the cached file, or null if all attempts fail.
   */
  async getMarketFace(itemId: string, emojiHash: string): Promise<string | null> {
    const weqCacheDir = join(this.platform.appDataRoot(), 'cache', 'marketface');
    const gifCachePath = join(weqCacheDir, `${emojiHash}.gif`);
    const pngCachePath = join(weqCacheDir, `${emojiHash}.png`);

    // 1. Hit weq's own cache first (animated GIF preferred, then static PNG).
    if (existsSync(gifCachePath)) return gifCachePath;
    if (existsSync(pngCachePath)) return pngCachePath;

    // 2. Check QQ's local cache. A sticker is stored as the raw encrypted GIF
    //    (`<hash>` with no extension, XOR-obfuscated) and/or a plaintext PNG
    //    whose name is the hash plus a suffix (`<hash>_aio.png`, `<hash>_thu.png`
    //    or a bare `<hash>.png`). Prefer the animated GIF; fall back to the PNG.
    //    Crucially the PNG is copied as-is — it must NOT be XOR-"decrypted".
    const uin = this.session.context.uin;
    const qqMarketFaceDir = this.platform.marketFaceDir(uin);
    if (qqMarketFaceDir) {
      const itemDir = join(qqMarketFaceDir, itemId);

      // (a) encrypted GIF: exactly `<hash>`, no extension → XOR-decrypt.
      const rawPath = join(itemDir, emojiHash);
      if (isFile(rawPath)) {
        try {
          const decrypted = this.decrypt(readFileSync(rawPath));
          mkdirSync(weqCacheDir, { recursive: true });
          writeFileSync(gifCachePath, decrypted);
          return gifCachePath;
        } catch {
          // Fall through to PNG / CDN if decryption/save fails.
        }
      }

      // (b) plaintext PNG: `<hash>` + suffix + `.png` → copy verbatim.
      const localPng = findLocalPng(itemDir, emojiHash);
      if (localPng) {
        try {
          mkdirSync(weqCacheDir, { recursive: true });
          writeFileSync(pngCachePath, readFileSync(localPng));
          return pngCachePath;
        } catch {
          // Fall through to CDN if copy fails.
        }
      }
    }

    // 3. Fallback to CDN. CDN bytes are PLAINTEXT — unlike QQ's local encrypted
    // GIF (step 2a) they are NOT XOR-encrypted, so they're saved as-is.
    const hashPrefix = emojiHash.slice(0, 2);
    const baseUrl = `https://i.gtimg.cn/club/item/parcel/item/${hashPrefix}/${emojiHash}`;

    // Try GIF sizes 300, 200.
    for (const size of [300, 200]) {
      const gifUrl = `${baseUrl}/raw${size}.gif`;
      const result = await this.download(gifUrl, gifCachePath);
      if (result) return result;
    }

    // Try PNG fallback sizes 300, 200.
    for (const size of [300, 200]) {
      const pngUrl = `${baseUrl}/${size}x${size}.png`;
      const result = await this.download(pngUrl, pngCachePath);
      if (result) return result;
    }

    return null;
  }

  /**
   * XOR-decrypt the first 20 bytes of every 50-byte chunk with 0xFF.
   */
  private decrypt(input: Buffer): Buffer {
    const output = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 50) {
      const chunkSize = Math.min(50, input.length - i);
      const encryptedPartSize = Math.min(20, chunkSize);

      // XOR first 20 bytes
      for (let j = 0; j < encryptedPartSize; j++) {
        output[i + j] = (input[i + j] as number) ^ 0xff;
      }

      // Copy remaining bytes (up to 30)
      if (chunkSize > 20) {
        input.copy(output, i + 20, i + 20, i + chunkSize);
      }
    }
    return output;
  }

  /** Download CDN bytes and save as-is (CDN content is plaintext). */
  private async download(url: string, targetPath: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return null;

      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0) return null;

      mkdirSync(join(targetPath, '..'), { recursive: true });
      writeFileSync(targetPath, data);
      return targetPath;
    } catch {
      return null;
    }
  }
}

/** True when `path` exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate a sticker's plaintext PNG inside its item directory. QQ names them
 * `<hash>_aio.png` (full size) / `<hash>_thu.png` (thumbnail), and occasionally
 * a bare `<hash>.png`; prefer the full-size one, then the thumbnail, then any
 * `<hash>…png` as a robust fallback for suffixes we haven't seen.
 */
function findLocalPng(itemDir: string, hash: string): string | null {
  for (const name of [`${hash}_aio.png`, `${hash}_thu.png`, `${hash}.png`]) {
    const p = join(itemDir, name);
    if (isFile(p)) return p;
  }
  try {
    const lowerHash = hash.toLowerCase();
    for (const name of readdirSync(itemDir)) {
      const lower = name.toLowerCase();
      if (lower.startsWith(lowerHash) && lower.endsWith('.png')) {
        const p = join(itemDir, name);
        if (isFile(p)) return p;
      }
    }
  } catch {
    // Item directory missing / unreadable — nothing to serve.
  }
  return null;
}

// ── 表情面板 helpers ──────────────────────────────────────────────────────────

/** 分类展示顺序；未命中排在后面。字符表情统一置最后。 */
const GROUP_ORDER = [
  '小黄脸表情',
  '超级表情',
  'QQ黄脸',
  '企鹅',
  '喜花妮',
  '噗噗星人',
  '汪汪',
  '开学季',
  '隐藏表情',
  '互动表情',
];

/** id 不是纯数字 = 字符表情的字形（如 `😊`）。 */
function isGlyphId(id: string): boolean {
  return id.length > 0 && !/^\d+$/.test(id);
}

function groupRank(group: PanelFaceGroup): number {
  if (group.unicode) return 900;
  const idx = GROUP_ORDER.findIndex(
    (k) => group.label.includes(k) || k.includes(group.label),
  );
  return idx >= 0 ? idx : 500;
}

function compareFaceGroups(a: PanelFaceGroup, b: PanelFaceGroup): number {
  const ra = groupRank(a);
  const rb = groupRank(b);
  if (ra !== rb) return ra - rb;
  return a.label.localeCompare(b.label);
}

/**
 * 把一条最近使用记录解析成可渲染项：字符表情给出字形，图片表情给出 faceId。
 * 兼容 QQ 的两种存法（码点 / 0 + 字形）与 `base_sys_emoji` 的两套 key。
 */
function resolveRecent(
  entry: RecentEmojiEntry,
  byId: Map<string, SysEmoji>,
  byUnicode: Map<number, SysEmoji>,
): PanelFaceItem | null {
  const extra = entry.extra.trim();
  const glyphFromExtra = entry.unicode && extra && !/^\d+$/.test(extra) ? extra : '';

  if (entry.unicode) {
    const row = byUnicode.get(entry.faceId) ?? (glyphFromExtra ? byId.get(glyphFromExtra) : undefined);
    const glyph = glyphFromExtra || row?.id || '';
    if (!glyph) return null;
    return { id: glyph, desc: row?.desc || glyph, unicode: true, glyph };
  }

  const row = byId.get(String(entry.faceId)) ?? byUnicode.get(entry.faceId);
  if (row && (row.unicodeId !== 0 || isGlyphId(row.id))) {
    return { id: row.id, desc: row.desc || row.id, unicode: true, glyph: row.id };
  }
  return {
    id: String(entry.faceId),
    desc: row?.desc || `[表情${entry.faceId}]`,
    unicode: false,
    glyph: '',
  };
}

/** 自定义表情磁盘绝对路径 → weq-media://cemoji 的 scope/bucket/file；解析不了返回 null。 */
function parseEmojiDiskPath(
  abs: string,
): { scope: 'personal' | 'recv'; bucket: string; file: string } | null {
  if (!abs) return null;
  const parts = abs.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? '';
  if (!file) return null;
  if (parts.lastIndexOf('personal_emoji') >= 0) {
    return { scope: 'personal', bucket: '', file };
  }
  const recvIdx = parts.lastIndexOf('emoji-recv');
  if (recvIdx >= 0) {
    const bucket = parts[recvIdx + 1] ?? '';
    if (/^\d{4}-\d{2}$/.test(bucket)) return { scope: 'recv', bucket, file };
  }
  return null;
}

/** 关联 GIF 的磁盘文件名：优先取路径 basename（必须 .gif），否则用 gifHash 拼。 */
function relatedFileName(localPath: string, gifHash: string): string | null {
  const base = basename(localPath);
  if (base?.toLowerCase().endsWith('.gif')) return base;
  return gifHash ? `${gifHash}.gif` : null;
}

/** 关联 GIF 的磁盘目录 hash：路径上一级是 32 位 hex 就用它，否则用 md5(关键词)。 */
function relatedDirHash(localPath: string, keyword: string): string {
  const parts = localPath.split(/[\\/]/);
  const dir = parts[parts.length - 2] ?? '';
  if (/^[0-9a-f]{32}$/i.test(dir)) return dir.toLowerCase();
  return createHash('md5').update(keyword, 'utf8').digest('hex');
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** 文件在磁盘上就返回其路径，否则 null（用于过滤「无本地资源」的收藏 / GIF）。 */
function existingFile(path: string): string | null {
  return existsSync(path) ? path : null;
}

// ── 商城表情包（在线拉取 + QQTEA 解密）helpers ─────────────────────────────────

/**
 * feetype 数字 → 来源标签。实测枚举：只有 2付费 / 4VIP / 5SVIP 是真正的付费门禁；
 * 1免费、6活动、27节日、49(含义未知) 以及 0/其它一切取值都当免费解析。
 * 注意 `3` 并不存在（此前误映射为 SVIP，且把真正的 SVIP=5 漏进 unknown）。
 */
export function feeTypeLabel(feetype: number): MarketPackFeeType {
  switch (feetype) {
    case 2:
      return 'paid';
    case 4:
      return 'vip';
    case 5:
      return 'svip';
    default:
      // 1免费 / 6活动 / 27节日 / 49未知 / 0 / 其它 —— 均非付费门禁，按免费展示。
      return 'free';
  }
}

/** 时间戳 → 16 字符 ASCII 密钥：`md5(str(ts)).hexdigest()[:16]`。 */
function keyFromTimestamp(ts: number): string {
  return createHash('md5').update(String(ts)).digest('hex').slice(0, 16);
}

const TEA_DELTA = 0x9e3779b9;

/** QQTEA 16 轮单块解密（大端序）。对齐 rust 的 tea_dec。 */
function teaDec(v0: number, v1: number, k: Uint32Array, r: number): [number, number] {
  let s = Math.imul(TEA_DELTA, r) >>> 0;
  let a = v0;
  let b = v1;
  for (let i = 0; i < r; i++) {
    b = (b - ((((a << 4) + k[2]!) ^ (a + s) ^ ((a >>> 5) + k[3]!)) >>> 0)) >>> 0;
    a = (a - ((((b << 4) + k[0]!) ^ (b + s) ^ ((b >>> 5) + k[1]!)) >>> 0)) >>> 0;
    s = (s - TEA_DELTA) >>> 0;
  }
  return [a >>> 0, b >>> 0];
}

function beU32(bytes: Uint8Array, o: number): number {
  return ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
}

function putBeU32(bytes: Uint8Array, o: number, v: number): void {
  bytes[o] = (v >>> 24) & 0xff;
  bytes[o + 1] = (v >>> 16) & 0xff;
  bytes[o + 2] = (v >>> 8) & 0xff;
  bytes[o + 3] = v & 0xff;
}

/**
 * 全量 QQTEA 解密（腾讯交织链式 CBC + 头尾处理）。对齐 rust 的 qqtea_decrypt：
 * 逐块 `明文_i = Dec(密文_i XOR 上块中间值) XOR 上块密文`，再跳过头部
 * `1控制位 + (控制位&7)填充 + 2 salt`，尾部截到最后一个 GIF trailer `0x3b`。
 */
function qqteaDecrypt(ct: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (ct.length === 0 || ct.length % 8 !== 0 || key.length !== 16) return null;

  const k = new Uint32Array(4);
  for (let i = 0; i < 4; i++) k[i] = beU32(key, i * 4);

  const out = new Uint8Array(ct.length);
  let pm0 = 0;
  let pm1 = 0;
  let pc0 = 0;
  let pc1 = 0;
  for (let off = 0; off < ct.length; off += 8) {
    const c0 = beU32(ct, off);
    const c1 = beU32(ct, off + 4);
    const [d0, d1] = teaDec((c0 ^ pm0) >>> 0, (c1 ^ pm1) >>> 0, k, 16);
    putBeU32(out, off, (d0 ^ pc0) >>> 0);
    putBeU32(out, off + 4, (d1 ^ pc1) >>> 0);
    pm0 = d0;
    pm1 = d1;
    pc0 = c0;
    pc1 = c1;
  }

  const pad = out[0]! & 7;
  const start = 1 + pad + 2;
  if (start > out.length) return null;
  const body = out.subarray(start);

  let pos = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i] === 0x3b) {
      pos = i;
      break;
    }
  }
  return pos >= 0 ? body.subarray(0, pos + 1) : body;
}
