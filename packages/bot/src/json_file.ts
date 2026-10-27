import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Bot 不依赖 service；权威数据采用相同的 fsync + 同目录原子发布契约。 */
export class BotJsonFile<T> {
  private current: T;

  constructor(
    private readonly path: string,
    initial: () => T,
    private readonly valid: (raw: unknown) => raw is T,
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.current = initial();
        return;
      }
      throw new Error(`读取 Bot 存储失败，原件已保留：${path}`, { cause: error });
    }
    if (!valid(raw)) throw new Error(`Bot 存储结构无效，原件已保留：${path}`);
    this.current = raw;
  }

  get data(): T {
    return this.current;
  }

  replace(next: T): void {
    if (!this.valid(next)) throw new Error('Bot 存储结构无效，未保存变更');
    const committed = structuredClone(next);
    const data = JSON.stringify(committed);
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
    } catch (error) {
      throw new Error(`保存 Bot 存储失败，未提交变更：${this.path}`, { cause: error });
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        try {
          unlinkSync(tmp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            console.error('Bot 存储临时文件清理失败');
        }
      }
    }
    this.current = committed;
    // 部分平台不支持目录 fsync；原子替换已完成，不能再报告为未提交。
    try {
      const dirFd = openSync(parent, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* 目录项持久化尽力而为，与 service 原子写契约一致。 */
    }
  }
}

export function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

export function isDictionary<T>(
  raw: unknown,
  valid: (item: unknown) => item is T,
): raw is Record<string, T> {
  return isRecord(raw) && Object.values(raw).every(valid);
}

export function own<T>(data: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

export function isStrings(raw: unknown): raw is string[] {
  return Array.isArray(raw) && raw.every((item) => typeof item === 'string');
}

export function isNumber(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw);
}
