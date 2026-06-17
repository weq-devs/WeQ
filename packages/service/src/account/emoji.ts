/**
 * EmojiService — handles QQ "Market Face" (store emoji) decryption and fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

export class EmojiService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /**
   * Get the path to a decrypted market face GIF.
   *
   * Logic:
   * 1. Check weq's own decrypted cache.
   * 2. Check QQ's encrypted local cache, decrypt and save if found.
   * 3. Download from QQ's CDN (GIF 300/200 -> PNG 300/200), decrypt and save.
   * 4. Return the path to the decrypted file, or null if all attempts fail.
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

    // 3. Fallback to CDN.
    const hashPrefix = emojiHash.slice(0, 2);
    const baseUrl = `https://i.gtimg.cn/club/item/parcel/item/${hashPrefix}/${emojiHash}`;

    // Try GIF sizes 300, 200.
    for (const size of [300, 200]) {
      const gifUrl = `${baseUrl}/raw${size}.gif`;
      const result = await this.downloadAndDecrypt(gifUrl, weqCachePath);
      if (result) return result;
    }

    // Try PNG fallback sizes 300, 200.
    const weqPngCachePath = join(weqCacheDir, `${emojiHash}.png`);
    for (const size of [300, 200]) {
      const pngUrl = `${baseUrl}/${size}x${size}.png`;
      const result = await this.downloadAndDecrypt(pngUrl, weqPngCachePath);
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

  private async downloadAndDecrypt(url: string, targetPath: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return null;

      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0) return null;

      const decrypted = this.decrypt(data);
      mkdirSync(join(targetPath, '..'), { recursive: true });
      writeFileSync(targetPath, decrypted);
      return targetPath;
    } catch {
      return null;
    }
  }
}
