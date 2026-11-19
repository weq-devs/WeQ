import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { detectImageFormat } from '@weqbot/protocol';
import { writeFileAtomic } from '../common/atomic_write';

const FILE = /^[0-9a-f]{32}\.(?:jpg|png|webp|bmp|gif)$/;

/** 仅保存已成功提交的收藏原图；目录由宿主按账号数据源隔离。 */
export class FavoriteEmojiCache {
  constructor(private readonly dir?: string) {}

  resolve(file: string): string | null {
    if (!this.dir || !FILE.test(file)) return null;
    const path = join(this.dir, file);
    try {
      const st = statSync(path);
      return st.isFile() && st.size > 0 ? path : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    if (!this.dir) return [];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && FILE.test(entry.name) && this.resolve(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async store(bytes: Uint8Array): Promise<string | null> {
    if (!this.dir) return null;
    const image = detectImageFormat(bytes);
    const ext = new Map([
      [1000, 'jpg'],
      [1001, 'png'],
      [1002, 'webp'],
      [1005, 'bmp'],
      [2000, 'gif'],
    ]).get(image.format);
    if (!image.width || !image.height || !ext) throw new Error('收藏表情原图格式无效');
    const hash = createHash('md5').update(bytes).digest('hex');
    const file = `${hash}.${ext}`;
    if (!this.resolve(file)) await writeFileAtomic(join(this.dir, file), bytes);
    return file;
  }

  async remove(hash: string): Promise<void> {
    if (!this.dir || !/^[0-9a-f]{32}$/i.test(hash)) return;
    const prefix = `${hash.toLowerCase()}.`;
    for (const file of await this.list()) {
      if (file.startsWith(prefix)) await unlink(join(this.dir, file));
    }
  }
}
