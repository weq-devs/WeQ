/**
 * EmojiService — handles QQ "Market Face" (store emoji) decryption and fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { BaseSysEmojiDb, MarketEmoticonPackageDb } from '@weq/db';
import type { MarketEmoticonPackage } from '@weq/db';

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
  /** 原始 feetype 数字（1/2/3/4；缺失为 0）。 */
  feeTypeRaw: number;
  /** 上架时间（Unix 秒；0 表示缺失）——爆破密钥的时间窗提示。 */
  updateTime: number;
  /** 表情张数。 */
  count: number;
  /** 表情列表（hash + 名称）。 */
  items: MarketPackItem[];
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
  /** 本地商城表情包清单，一个账号会话内缓存一次。 */
  private marketPackages: MarketEmoticonPackage[] | null = null;
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
  async listSystemFaces(): Promise<SystemFaceEntry[]> {
    if (this.sysFaces) return this.sysFaces;
    const dir = this.platform.ntDbDir(this.session.context.uin);
    if (!dir) return [];
    const dbPath = join(dir, 'emoji.db');
    if (!existsSync(dbPath)) return [];
    try {
      const db = new BaseSysEmojiDb(this.platform.native.ntHelper, {
        dbPath,
        key: this.session.context.dbKey,
        algo: this.session.context.algo,
      });
      const rows = await db.listAll();
      this.sysFaces = rows
        .map((r) => ({
          id: Number(r.id),
          desc: r.desc,
          emojiType: r.emojiType,
          unicodeId: r.unicodeId,
        }))
        .filter((r) => Number.isFinite(r.id) && r.desc);
      return this.sysFaces;
    } catch {
      return [];
    }
  }

  /**
   * 列出「我添加到本地的商城表情包」——读 emoji.db 的
   * market_emoticon_package_table，按添加时间倒序。失败/缺库返回空表。
   */
  async listMarketPackages(): Promise<MarketEmoticonPackage[]> {
    if (this.marketPackages) return this.marketPackages;
    const dir = this.platform.ntDbDir(this.session.context.uin);
    if (!dir) return [];
    const dbPath = join(dir, 'emoji.db');
    if (!existsSync(dbPath)) return [];
    try {
      const db = new MarketEmoticonPackageDb(this.platform.native.ntHelper, {
        dbPath,
        key: this.session.context.dbKey,
        algo: this.session.context.algo,
      });
      this.marketPackages = await db.listAll();
      return this.marketPackages;
    } catch {
      return [];
    }
  }

  /**
   * 拉取并解析一个商城表情包的在线详情（`android.json`）——名称 / 介绍 /
   * **收费类型(feetype)** / 上架时间 / 表情列表(hash+名)。会话内按 packId 缓存
   * （含 in-flight 去重）。网络失败或包不存在返回 null。
   *
   * feetype 才是 README 那张来源表的枚举来源（1免费/2付费/3SVIP/4VIP）；CDN
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
    if (!key || key.length !== 16) return null;

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

// ── 商城表情包（在线拉取 + QQTEA 解密）helpers ─────────────────────────────────

/** feetype 数字 → 来源标签（README：1免费 / 2付费 / 3SVIP / 4VIP）。 */
function feeTypeLabel(feetype: number): MarketPackFeeType {
  switch (feetype) {
    case 1:
      return 'free';
    case 2:
      return 'paid';
    case 3:
      return 'svip';
    case 4:
      return 'vip';
    default:
      return 'unknown';
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
