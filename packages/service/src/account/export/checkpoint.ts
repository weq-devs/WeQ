import { createHash } from 'node:crypto';
import { readFile, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { writeFileAtomic } from '../../common/atomic_write';
import { fileSha256 } from './resume';

interface SavedOperation<T> {
  version: 1;
  value: T;
  files: Array<[string, string]>;
}

/** 每项成功并落盘后才提交；快照与任务同寿命，不依赖进程内的运行器或过期凭据。 */
export class ExportCheckpoint {
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    readonly directory: string,
    private readonly signal?: AbortSignal,
  ) {}

  async run<T>(
    key: unknown,
    produce: () => Promise<T>,
    files: (value: T) => string[] = () => [],
    accept: (value: T) => boolean = () => true,
  ): Promise<T> {
    this.signal?.throwIfAborted();
    const hash = createHash('sha256').update(serialize(key)).digest('hex');
    let pending = this.pending.get(hash) as Promise<T> | undefined;
    if (!pending) {
      pending = this.perform(join(this.directory, `${hash}.bin`), produce, files, accept);
      this.pending.set(hash, pending);
    }
    try {
      const result = await pending;
      this.signal?.throwIfAborted();
      return deserialize(serialize(result)) as T;
    } finally {
      this.pending.delete(hash);
    }
  }

  file<T>(
    key: unknown,
    path: string,
    produce: () => Promise<T>,
    accept?: (value: T) => boolean,
  ): Promise<T> {
    return this.run(
      key,
      async () => {
        await rm(path, { recursive: true, force: true });
        return produce();
      },
      () => [path],
      accept,
    );
  }

  private async inventory(paths: readonly string[]): Promise<Array<[string, string]>> {
    const inventory: Array<[string, string]> = [];
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isFile()) inventory.push([path, await fileSha256(path)]);
      else if (info.isDirectory()) {
        inventory.push([path, 'directory']);
        for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      } else throw new Error('续作文件不是普通文件或目录。');
    };
    for (const path of paths) await visit(path);
    return inventory;
  }

  private async perform<T>(
    path: string,
    produce: () => Promise<T>,
    files: (value: T) => string[],
    accept: (value: T) => boolean,
  ): Promise<T> {
    let saved: Buffer | undefined;
    try {
      saved = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved) {
      const operation = deserialize(saved) as SavedOperation<T>;
      if (operation.version !== 1) throw new Error('导出续作记录版本不可用。');
      const current = await this.inventory(files(operation.value)).catch(() => null);
      if (
        !current ||
        current.length !== operation.files.length ||
        current.some(
          ([file, hash], index) =>
            operation.files[index]?.[0] !== file || operation.files[index]?.[1] !== hash,
        )
      )
        throw new Error('续作文件已丢失或发生变化，请恢复原文件后继续。');
      return operation.value;
    }
    const value = await produce();
    if (accept(value)) {
      const operation: SavedOperation<T> = {
        version: 1,
        value,
        files: await this.inventory(files(value)),
      };
      await writeFileAtomic(path, serialize(operation));
    }
    return value;
  }
}
