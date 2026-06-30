/**
 * EmojiService — handles QQ "Market Face" (store emoji) decryption and fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { BaseSysEmojiDb } from '@weq/db';

/** 系统表情清单项：faceId + 外显文字（如 "[微笑]"），供前端把 faceText 渲染成表情图。 */
export interface SystemFaceEntry {
  id: number;
  desc: string;
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
        .map((r) => ({ id: Number(r.id), desc: r.desc }))
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
    const weqCachePath = join(weqCacheDir, `${emojiHash}.gif`);

    // 1. Hit weq's own cache first.
    if (existsSync(weqCachePath)) {
      return weqCachePath;
    }

    // 2. Check QQ's local cache.
    const uin = this.session.context.uin;
    const qqMarketFaceDir = this.platform.marketFaceDir(uin);
    if (qqMarketFaceDir) {
      const qqCachePath = join(qqMarketFaceDir, itemId, emojiHash);
      if (existsSync(qqCachePath)) {
        try {
          const encrypted = readFileSync(qqCachePath);
          const decrypted = this.decrypt(encrypted);
          mkdirSync(weqCacheDir, { recursive: true });
          writeFileSync(weqCachePath, decrypted);
          return weqCachePath;
        } catch {
          // Fall through to download if decryption/save fails.
        }
      }
    }

    // 3. Fallback to CDN. CDN bytes are PLAINTEXT — unlike QQ's local cache
    // (step 2) they are NOT XOR-encrypted, so they're saved as-is.
    const hashPrefix = emojiHash.slice(0, 2);
    const baseUrl = `https://i.gtimg.cn/club/item/parcel/item/${hashPrefix}/${emojiHash}`;

    // Try GIF sizes 300, 200.
    for (const size of [300, 200]) {
      const gifUrl = `${baseUrl}/raw${size}.gif`;
      const result = await this.download(gifUrl, weqCachePath);
      if (result) return result;
    }

    // Try PNG fallback sizes 300, 200.
    const weqPngCachePath = join(weqCacheDir, `${emojiHash}.png`);
    for (const size of [300, 200]) {
      const pngUrl = `${baseUrl}/${size}x${size}.png`;
      const result = await this.download(pngUrl, weqPngCachePath);
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
