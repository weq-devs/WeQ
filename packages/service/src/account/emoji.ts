/**
 * EmojiService — handles QQ "Market Face" (store emoji) decryption and fallback.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { BaseSysEmojiDb } from '@weq/db';

/** 系统表情清单项：faceId + 外显文字（如 "[微笑]"），供前端把 faceText 渲染成表情图。 */
export interface SystemFaceEntry {
  id: number;
  desc: string;
  /** 1 系统表情(小黄脸) / 2 emoji 字符表情 / 3 动态可变表情(骰子等)——用于分组。 */
  emojiType: number;
  /** Unicode 字符表情的 code point；0 表示非此类（走本地图片资源）。 */
  unicodeId: number;
}

export class EmojiService {
  /** emoji.db 是只读静态表，一个账号会话内缓存一次。 */
  private sysFaces: SystemFaceEntry[] | null = null;

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
