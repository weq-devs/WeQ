import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Upload {
  owner: object;
  directory: string;
  path: string;
  size: number;
  offset: number;
  expires: number;
  busy: boolean;
}
/** Web 本地文件分段暂存；大小只受实际磁盘空间约束，不把整个视频放进内存。 */
export class AlbumVideoStaging {
  private uploads = new Map<string, Upload>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly ttlMs = 30 * 60000) {}
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const idle = [...this.uploads.values()].filter((entry) => !entry.busy);
    if (!idle.length) return;
    const next = Math.min(...idle.map((entry) => entry.expires));
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.cleanup().catch(() => {
          this.schedule();
        });
      },
      Math.max(1000, next - Date.now() + 1),
    );
    this.timer.unref?.();
  }
  async start(owner: object, size: number) {
    if (!Number.isSafeInteger(size) || size < 16) throw new Error('视频文件大小无效');
    await this.cleanup();
    if (this.uploads.size >= 16) throw new Error('请先完成或取消现有的视频上传');
    const space = await statfs(tmpdir(), { bigint: true });
    if (BigInt(size) + 64n * 1024n * 1024n >= space.bavail * space.bsize)
      throw new Error('宿主临时卷可用空间不足，无法暂存此视频');
    const directory = await mkdtemp(join(tmpdir(), 'weq-album-video-'));
    const path = join(directory, 'video.mp4');
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const id = randomUUID();
    this.uploads.set(id, {
      owner,
      directory,
      path,
      size,
      offset: 0,
      expires: Date.now() + this.ttlMs,
      busy: false,
    });
    this.schedule();
    return { id, offset: 0 };
  }
  private entry(owner: object, id: string) {
    const entry = this.uploads.get(id);
    if (!entry || entry.owner !== owner || entry.expires < Date.now())
      throw new Error('视频暂存会话已失效，请重新选择');
    if (entry.busy) throw new Error('视频暂存正在处理，请勿重复提交');
    return entry;
  }
  async append(owner: object, id: string, offset: number, bytes: Uint8Array) {
    const entry = this.entry(owner, id);
    if (
      offset !== entry.offset ||
      !bytes.length ||
      bytes.length > 1024 * 1024 ||
      offset + bytes.length > entry.size
    )
      throw new Error('视频分段偏移或长度不匹配');
    entry.busy = true;
    try {
      const space = await statfs(entry.directory, { bigint: true });
      if (BigInt(bytes.length) + 64n * 1024n * 1024n >= space.bavail * space.bsize)
        throw new Error('宿主临时卷可用空间不足');
      const handle = await open(entry.path, 'r+');
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw new Error('视频暂存写入中断');
          written += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      entry.offset += bytes.length;
      entry.expires = Date.now() + this.ttlMs;
      return { offset: entry.offset };
    } finally {
      entry.busy = false;
      this.schedule();
    }
  }
  acquire(owner: object, id: string) {
    const entry = this.entry(owner, id);
    if (entry.offset !== entry.size) throw new Error('视频文件尚未传输完整');
    entry.busy = true;
    this.schedule();
    return entry.path;
  }
  async discard(owner: object, id: string, acquired = false) {
    const entry = this.uploads.get(id);
    if (!entry || entry.owner !== owner) return;
    if (entry.busy && !acquired) throw new Error('视频正在上传，暂不能删除');
    entry.busy = true;
    try {
      await rm(entry.directory, { recursive: true, force: true });
      this.uploads.delete(id);
    } finally {
      entry.busy = false;
      this.schedule();
    }
  }
  async cleanup() {
    for (const [id, entry] of this.uploads)
      if (!entry.busy && entry.expires < Date.now()) await this.discard(entry.owner, id);
    this.schedule();
  }
}
