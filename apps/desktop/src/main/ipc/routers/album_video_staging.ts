import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Upload {
  owner: object;
  directory: string;
  path: string;
  size: number;
  offset: number;
  expires: number;
  busy: boolean;
  readers: number;
  onDiscard?: () => void;
}
interface StagingOptions {
  label: string;
  minBytes: number;
  maxBytes: number;
  prefix: string;
  fileName: string;
  maxUploads?: number;
  maxTotalBytes?: number;
}
/** Web 本地文件分段暂存；保留调用方大小限制并逐段核实磁盘空间。 */
export class FileUploadStaging {
  private uploads = new Map<string, Upload>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly ttlMs = 30 * 60000,
    private readonly options: StagingOptions = {
      label: '视频',
      minBytes: 16,
      maxBytes: Number.MAX_SAFE_INTEGER,
      prefix: 'weq-album-video-',
      fileName: 'video.mp4',
    },
  ) {}
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const idle = [...this.uploads.values()].filter((entry) => !entry.busy && !entry.readers);
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
  async start(owner: object, size: number, fileName = this.options.fileName) {
    if (!Number.isSafeInteger(size) || size < this.options.minBytes || size > this.options.maxBytes)
      throw new Error(`${this.options.label}文件大小无效`);
    if (
      !fileName ||
      basename(fileName) !== fileName ||
      /[\\/:]/.test(fileName) ||
      Array.from(fileName).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      fileName === '.' ||
      fileName === '..'
    )
      throw new Error('暂存文件名无效');
    // 创建阶段串行预留容量，避免并发请求同时越过暂存上限。
    const previous = this.startTail;
    let unlock!: () => void;
    this.startTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      await this.cleanup();
      if (this.uploads.size >= (this.options.maxUploads ?? 16))
        throw new Error(`请先完成或取消现有的${this.options.label}上传`);
      if (
        [...this.uploads.values()].reduce((sum, entry) => sum + entry.size, size) >
        (this.options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER)
      )
        throw new Error('暂存附件总量已达上限，请先完成或取消现有附件');
      const space = await statfs(tmpdir(), { bigint: true });
      if (BigInt(size) + 64n * 1024n * 1024n >= space.bavail * space.bsize)
        throw new Error(`宿主临时卷可用空间不足，无法暂存${this.options.label}`);
      const directory = await mkdtemp(join(tmpdir(), this.options.prefix));
      const path = join(directory, fileName);
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
        readers: 0,
      });
      this.schedule();
      return { id, offset: 0 };
    } finally {
      unlock();
    }
  }
  private entry(owner: object, id: string) {
    const entry = this.uploads.get(id);
    if (!entry || entry.owner !== owner || entry.expires < Date.now())
      throw new Error(`${this.options.label}暂存会话已失效，请重新选择`);
    if (entry.busy) throw new Error(`${this.options.label}暂存正在处理，请勿重复提交`);
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
      throw new Error(`${this.options.label}分段偏移或长度不匹配`);
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
          if (!result.bytesWritten) throw new Error(`${this.options.label}暂存写入中断`);
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
    if (entry.offset !== entry.size) throw new Error(`${this.options.label}文件尚未传输完整`);
    entry.busy = true;
    this.schedule();
    return entry.path;
  }
  /** 供编辑草稿保留的文件；真实操作通过 withPaths 延长租期。 */
  complete(owner: object, id: string) {
    const entry = this.entry(owner, id);
    if (entry.offset !== entry.size) throw new Error(`${this.options.label}文件尚未传输完整`);
    entry.expires = Date.now() + this.ttlMs;
    return entry.path;
  }
  requirePath(owner: object, path: string): string {
    const found = [...this.uploads.entries()].find(([, entry]) => entry.path === path);
    if (!found) throw new Error('请选择本次上传的附件');
    return this.complete(owner, found[0]);
  }
  whenDiscarded(owner: object, id: string, callback: () => void): void {
    this.entry(owner, id).onDiscard = callback;
  }
  async withPaths<T>(input: unknown, run: () => Promise<T>): Promise<T> {
    if (!this.uploads.size) return run();
    const paths = new Set<string>();
    const seen = new Set<object>();
    const walk = (value: unknown, depth: number) => {
      if (typeof value === 'string') paths.add(value);
      else if (
        value &&
        typeof value === 'object' &&
        !ArrayBuffer.isView(value) &&
        depth < 32 &&
        !seen.has(value)
      ) {
        seen.add(value);
        for (const child of Object.values(value)) walk(child, depth + 1);
      }
    };
    walk(input, 0);
    const entries = [...this.uploads.values()].filter((entry) => paths.has(entry.path));
    for (const entry of entries) {
      if (entry.expires < Date.now() || entry.offset !== entry.size)
        throw new Error('附件已过期或未上传完整，请重新选择');
    }
    for (const entry of entries) entry.readers++;
    try {
      return await run();
    } finally {
      for (const entry of entries) {
        entry.readers--;
        entry.expires = Date.now() + this.ttlMs;
      }
      this.schedule();
    }
  }
  async discard(owner: object, id: string, acquired = false) {
    const entry = this.uploads.get(id);
    if (!entry || entry.owner !== owner) return;
    if (entry.readers || (entry.busy && !acquired))
      throw new Error(`${this.options.label}正在处理，暂不能删除`);
    entry.busy = true;
    try {
      await rm(entry.directory, { recursive: true, force: true });
      this.uploads.delete(id);
      entry.onDiscard?.();
    } finally {
      entry.busy = false;
      this.schedule();
    }
  }
  async cleanup() {
    for (const [id, entry] of this.uploads)
      if (!entry.busy && !entry.readers && entry.expires < Date.now())
        await this.discard(entry.owner, id);
    this.schedule();
  }
}

export { FileUploadStaging as AlbumVideoStaging };
