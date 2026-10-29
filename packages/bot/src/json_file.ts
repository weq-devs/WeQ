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

/**
 * 迭代深冻结。只在 JSON.stringify 成功之后调用：环状引用会先在序列化处抛错，
 * 因此这里不需要 visited 集合，遍历深度与结构都由已验证的 JSON 数据保证。
 *
 * 已冻结的子树直接跳过——依赖「本类冻结过的树必然整树冻结」这一不变量，
 * 增量 replace 时只需要冻结本次新放入的对象，未变更的大头子树零成本。
 * 调用方不应传入自己半冻结（顶层冻结、子级未冻结）的结构。
 */
export function deepFreeze<V>(value: V): V {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== 'object' || Object.isFrozen(cur)) continue;
    Object.freeze(cur);
    for (const child of Object.values(cur as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return value;
}

/**
 * Bot 不依赖 service；权威数据采用相同的 fsync + 同目录原子发布契约。
 *
 * 内存契约（消息热路径优化）：
 * - `replace(next)` 对 `next` 做**所有权转移**：校验通过后直接序列化落盘，
 *   成功后整树深冻结并发布，不再做防御性 structuredClone。大库（多会话对话、
 *   带向量的记忆）下整库深拷贝曾是每条消息最大的内存 / CPU 开销。
 * - 发布后的 `data` 整树不可变：读取端返回「新数组 + 逐条浅拷贝」即可（嵌套数组共享
 *   冻结引用），任何原地改写已发布数据的尝试会在严格模式下抛 TypeError，而不是静默污染存储。
 * - 写盘失败时抛错：`data` 保持旧值，`next` 不被冻结，调用方可安全重试。
 */
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
        this.current = deepFreeze(initial());
        return;
      }
      throw new Error(`读取 Bot 存储失败，原件已保留：${path}`, { cause: error });
    }
    if (!valid(raw)) throw new Error(`Bot 存储结构无效，原件已保留：${path}`);
    this.current = deepFreeze(raw);
  }

  /** 已发布的整树冻结数据。只读；需要修改时构造新值走 replace。 */
  get data(): T {
    return this.current;
  }

  /**
   * 原子发布新数据。`next` 的所有权移交给本对象：成功后它被深冻结并成为新的
   * `data`，调用方不得保留引用再修改（会抛 TypeError）。失败时不发布、不冻结。
   */
  replace(next: T): void {
    if (!this.valid(next)) throw new Error('Bot 存储结构无效，未保存变更');
    // 先序列化再冻结：环状引用会在这里抛错，current 与 next 均不受影响。
    const data = JSON.stringify(next);
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
    // 原子替换成功后才发布：冻结 next 并作为新的不可变当前值。
    this.current = deepFreeze(next);
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
