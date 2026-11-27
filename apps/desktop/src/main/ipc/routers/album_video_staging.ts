import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '@weq/service/atomic-write';

interface Upload {
  owner: object;
  directory: string;
  path: string;
  size: number;
  offset: number;
  expires: number;
  busy: boolean;
  readers: number;
  discardRequested?: boolean;
  onDiscard?: () => void;
  ownerKey?: string;
}
interface StagingOptions {
  label: string;
  minBytes: number;
  maxBytes: number;
  prefix: string;
  fileName: string;
  maxUploads?: number;
  maxTotalBytes?: number;
  persistence?: {
    root(): string | undefined | Promise<string | undefined>;
    ownerKey(owner: object): string | undefined;
  };
}
const uploadIdPattern = /^[a-f0-9-]{36}$/i;
export class StagedUploadUnavailable extends Error {}

interface SavedUpload {
  ownerKey: string;
  size: number;
  offset: number;
  expires: number;
  fileName: string;
}
function validUploadFileName(fileName: string) {
  return Boolean(
    fileName &&
      basename(fileName) === fileName &&
      !/[\\/:]/.test(fileName) &&
      !Array.from(fileName).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      fileName !== '.' &&
      fileName !== '..',
  );
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
  private persist(entry: Upload, offset = entry.offset, expires = entry.expires) {
    if (!entry.ownerKey) return Promise.resolve();
    const saved: SavedUpload = {
      ownerKey: entry.ownerKey,
      size: entry.size,
      offset,
      expires,
      fileName: basename(entry.path),
    };
    return writeFileAtomic(join(entry.directory, 'upload.json'), JSON.stringify(saved));
  }

  private async restore(owner: object, id: string) {
    const persistence = this.options.persistence;
    const ownerKey = persistence?.ownerKey(owner);
    if (!persistence || !ownerKey || !uploadIdPattern.test(id)) return;
    const root = await persistence.root();
    if (!root) return;
    const directory = join(root, id);
    let saved: SavedUpload;
    try {
      saved = JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8')) as SavedUpload;
    } catch {
      return;
    }
    if (
      !saved ||
      saved.ownerKey !== ownerKey ||
      saved.expires < Date.now() ||
      !Number.isSafeInteger(saved.size) ||
      saved.size < this.options.minBytes ||
      saved.size > this.options.maxBytes ||
      !Number.isSafeInteger(saved.offset) ||
      saved.offset < 0 ||
      saved.offset > saved.size ||
      !validUploadFileName(saved.fileName)
    )
      return;
    const path = join(directory, 'files', saved.fileName);
    const file = await stat(path).catch(() => undefined);
    if (!file?.isFile() || file.size < saved.offset || file.size > saved.size) return;
    if (!this.uploads.has(id))
      this.uploads.set(id, {
        owner,
        directory,
        path,
        size: saved.size,
        offset: saved.offset,
        expires: saved.expires,
        busy: false,
        readers: 0,
        ownerKey,
      });
    this.schedule();
  }

  async resume(owner: object, id: string) {
    if (!this.uploads.has(id)) await this.restore(owner, id);
    const entry = this.entry(owner, id);
    const offset = entry.offset;
    const hash = createHash('sha256');
    if (offset > 0)
      for await (const chunk of createReadStream(entry.path, { end: offset - 1 }))
        hash.update(chunk);
    return { id, offset, size: entry.size, prefixHash: hash.digest('hex') };
  }

  async restoreComplete(owner: object, id: string) {
    if (!this.uploads.has(id)) await this.restore(owner, id);
    return this.complete(owner, id);
  }

  private async cleanPersisted(root: string) {
    let count = 0;
    let bytes = 0;
    for (const id of await readdir(root).catch(() => [] as string[])) {
      if (!uploadIdPattern.test(id) || this.uploads.has(id)) continue;
      const directory = join(root, id);
      const saved = await readFile(join(directory, 'upload.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as SavedUpload)
        .catch(() => undefined);
      if (saved && saved.expires < Date.now())
        await rm(directory, { recursive: true, force: true });
      else if (saved) {
        count++;
        bytes += saved.size;
      }
    }
    return { count, bytes };
  }
  async start(owner: object, size: number, fileName = this.options.fileName) {
    if (!Number.isSafeInteger(size) || size < this.options.minBytes || size > this.options.maxBytes)
      throw new Error(`${this.options.label}文件大小无效`);
    if (!validUploadFileName(fileName)) throw new Error('暂存文件名无效');
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
      const ownerKey = this.options.persistence?.ownerKey(owner);
      const root = ownerKey ? await this.options.persistence?.root() : undefined;
      if (root) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const persisted = await this.cleanPersisted(root);
        if (
          this.uploads.size + persisted.count >= (this.options.maxUploads ?? 16) ||
          [...this.uploads.values()].reduce(
            (sum, entry) => sum + entry.size,
            size + persisted.bytes,
          ) > (this.options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER)
        )
          throw new Error('暂存上传空间已满，请先完成或移除先前的上传。');
      }
      const space = await statfs(root ?? tmpdir(), { bigint: true });
      if (BigInt(size) + 64n * 1024n * 1024n >= space.bavail * space.bsize)
        throw new Error(`宿主临时卷可用空间不足，无法暂存${this.options.label}`);
      const id = randomUUID();
      const directory = root ? join(root, id) : await mkdtemp(join(tmpdir(), this.options.prefix));
      if (root) await mkdir(join(directory, 'files'), { recursive: true, mode: 0o700 });
      const path = root ? join(directory, 'files', fileName) : join(directory, fileName);
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      const entry: Upload = {
        owner,
        directory,
        path,
        size,
        offset: 0,
        expires: Date.now() + this.ttlMs,
        busy: false,
        readers: 0,
        ownerKey: root ? ownerKey : undefined,
      };
      try {
        await this.persist(entry);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      this.uploads.set(id, entry);
      this.schedule();
      return { id, offset: 0 };
    } finally {
      unlock();
    }
  }
  private entry(owner: object, id: string) {
    const entry = this.uploads.get(id);
    if (!entry || !this.owns(entry, owner) || entry.expires < Date.now() || entry.discardRequested)
      throw new StagedUploadUnavailable(`${this.options.label}暂存会话已失效，请重新选择`);
    if (entry.busy) throw new Error(`${this.options.label}暂存正在处理，请勿重复提交`);
    return entry;
  }
  private owns(entry: Upload, owner: object) {
    return (
      entry.owner === owner ||
      Boolean(entry.ownerKey && this.options.persistence?.ownerKey(owner) === entry.ownerKey)
    );
  }
  checkAppend(owner: object, id: string, offset: number) {
    const entry = this.entry(owner, id);
    if (offset !== entry.offset || offset >= entry.size)
      throw new Error(`${this.options.label}分段偏移或长度不匹配`);
  }
  async append(
    owner: object,
    id: string,
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
    beforeCommit?: () => void,
  ) {
    signal?.throwIfAborted();
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
          signal?.throwIfAborted();
          const result = await handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw new Error(`${this.options.label}暂存写入中断`);
          written += result.bytesWritten;
        }
        if (entry.ownerKey) await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      beforeCommit?.();
      const next = entry.offset + bytes.length;
      const expires = entry.discardRequested ? 0 : Date.now() + this.ttlMs;
      await this.persist(entry, next, expires);
      entry.offset = next;
      entry.expires = entry.discardRequested ? 0 : expires;
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
  /** 交给不可重复的写操作前，先让暂存句柄在宿主重启后失效。 */
  async consume(owner: object, id: string) {
    const path = this.acquire(owner, id);
    const entry = this.uploads.get(id)!;
    try {
      await this.persist(entry, entry.offset, 0);
    } catch (error) {
      entry.busy = false;
      this.schedule();
      throw error;
    }
    return path;
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
  hasPath(path: string): boolean {
    return [...this.uploads.values()].some((entry) => entry.path === path);
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
      if (entry.expires < Date.now() || entry.discardRequested || entry.offset !== entry.size)
        throw new Error('附件已过期或未上传完整，请重新选择');
    }
    for (const entry of entries) entry.readers++;
    try {
      return await run();
    } finally {
      for (const entry of entries) {
        entry.readers--;
        if (!entry.discardRequested) entry.expires = Date.now() + this.ttlMs;
      }
      this.schedule();
    }
  }
  async discardWhenIdle(owner: object, id: string) {
    const entry = this.uploads.get(id);
    if (!entry || !this.owns(entry, owner)) return;
    if (!entry.busy && !entry.readers) return this.discard(owner, id);
    entry.discardRequested = true;
    entry.expires = 0;
    this.schedule();
  }
  async discard(owner: object, id: string, acquired = false) {
    if (!this.uploads.has(id)) await this.restore(owner, id);
    const entry = this.uploads.get(id);
    if (!entry || !this.owns(entry, owner)) return;
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
