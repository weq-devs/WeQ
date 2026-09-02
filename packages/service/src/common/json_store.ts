/**
 * 通用 JSON 文件读写 —— 消除各 account/ 服务里手写的「load-on-construct + 变更即写」
 * 样板（deleted_msgs / anti_recall / agentlab_* / assistant … 每份都复制了一份
 * `existsSync → readFileSync → JSON.parse → try/catch 回落`）。
 *
 * 统一约定（与既有各 store 的行为逐一对齐）：
 *  - 缺失 / 损坏 / 结构不符 → 回落到 `makeInitial()` 或 `normalize` 后的形状；读失败
 *    永远不抛。
 *  - 写用原子写（.tmp + rename，见 {@link writeFileAtomicSync}），写完永远是一个完整
 *    文件；写失败静默 —— 持久化失败不应影响业务主流程。
 *
 * 用法：
 *   - 整文件「记住一个东西」的 store：new JsonStore(filePath, makeInitial, opts)，
 *     之后读写 `store.data`，变更完调 `store.save()`。
 *   - 只想复用「读不抛错 / 原子写」的函数式模块（如 desktop 的缓存快照）：
 *     {@link readJsonFile} + {@link writeJsonFileAtomic}。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic_write';

/** {@link JsonStore} 的构造选项。 */
export interface JsonStoreOptions<T> {
  /** 读入的原始值 → 期望形状。缺省 = 原样透传（依赖调用方会校验的类型）。 */
  normalize?: (raw: unknown) => T;
  /** 落盘时 pretty-print（`JSON.stringify(data, null, 2)`）。缺省紧凑。 */
  pretty?: boolean;
}

/** 读一个 UTF-8 JSON 文件；缺失 / 损坏 / 不是 JSON 一律返回 null（不抛）。 */
export function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/** 原子写一个 JSON 文件（UTF-8，懒建父目录）；失败静默。 */
export function writeJsonFileAtomic(path: string, data: unknown, pretty = false): void {
  try {
    writeFileAtomicSync(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  } catch {
    /* 持久化失败不应影响业务主流程 */
  }
}

/**
 * 整文件 JSON 存储：构造时同步读盘一次，之后所有读写走内存，`save()` 原子落盘。
 * `data` 公开可变 —— 调用方按自己的业务方法改它，改完调用 {@link save}。
 */
export class JsonStore<T> {
  /** 当前内存态（构造时由 {@link load} 填充）。 */
  data: T;

  constructor(
    private readonly filePath: string,
    private readonly makeInitial: () => T,
    private readonly opts: JsonStoreOptions<T> = {},
  ) {
    this.data = this.load();
  }

  /** 原子写盘；失败静默（调用方无需 try/catch）。 */
  save(): void {
    writeJsonFileAtomic(this.filePath, this.data, this.opts.pretty);
  }

  private load(): T {
    const fallback = (): T => this.makeInitial();
    const raw = readJsonFile(this.filePath);
    if (raw === null) return fallback();
    try {
      return this.opts.normalize ? this.opts.normalize(raw) : (raw as T);
    } catch {
      return fallback();
    }
  }
}
