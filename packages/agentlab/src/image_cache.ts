import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 描述缓存只存文字；内容与模型由调用方共同组成 key。 */
export function imageDescriptionCache(root: string) {
  let writes = 0;
  const file = (key: string) => join(root, `${createHash('sha256').update(key).digest('hex')}.txt`);
  return {
    async cached(key: string): Promise<string | null> {
      try {
        const path = file(key);
        if (Date.now() - (await stat(path)).mtimeMs > 7 * 86400_000) return null;
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async cache(key: string, text: string) {
      await mkdir(root, { recursive: true });
      await writeFile(file(key), text);
      if (writes++ % 32 !== 0) return;
      const entries = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.txt$/.test(name));
      if (entries.length <= 512) return;
      const dated = await Promise.all(
        entries.map(async (name) => ({
          name,
          time: (await stat(join(root, name)).catch(() => null))?.mtimeMs ?? 0,
        })),
      );
      dated.sort((a, b) => b.time - a.time);
      await Promise.all(
        dated.slice(512).map(({ name }) => unlink(join(root, name)).catch(() => {})),
      );
    },
  };
}
